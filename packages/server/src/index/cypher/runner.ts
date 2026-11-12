/**
 * Executes compiled Cypher SQL on a separate read-only connection in a worker thread, so a
 * runaway query can be stopped (better-sqlite3 is synchronous: the worker is terminated on timeout).
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DERIVED_LABELS, NODE_LABELS } from '@mandate/shared';
import { CypherError } from './parser.js';

const require = createRequire(import.meta.url);

/** SQL functions the compiled queries use (registered in the worker). */
export const SQL_FUNCTIONS_SRC = `
let deadline = Infinity;
function registerCypherFunctions(db, labels, derived) {
  // Called per row by every compiled join / recursion step: aborts the statement past the deadline.
  db.function('cy_guard', { deterministic: false, varargs: true }, () => {
    if (Date.now() > deadline) throw new Error('CYPHER_TIMEOUT');
    return 1;
  });
  const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
  const cache = new Map();
  db.function('cy_regexp', { deterministic: true }, (pattern, value) => {
    if (pattern === null || value === null || value === undefined) return null;
    let re = cache.get(pattern);
    if (!re) {
      // Java-style leading inline flags, as in Cypher: (?i), (?s), (?m), (?is) ...
      const m = /^\\(\\?([imsu]+)\\)/.exec(pattern);
      const flags = 'u' + (m ? [...new Set(m[1].replace('u', ''))].join('') : '');
      const body = m ? pattern.slice(m[0].length) : pattern;
      try { re = new RegExp('^(?:' + body + ')$', flags); } catch (e) { throw new Error('invalid regular expression: ' + e.message); }
      if (cache.size > 100) cache.clear();
      cache.set(pattern, re);
    }
    return re.test(String(value)) ? 1 : 0;
  });
  db.function('cy_add', { deterministic: true }, (a, b) => {
    if (a === null || b === null) return null;
    const la = typeof a === 'string' && a.startsWith('[') ? parse(a) : a;
    const lb = typeof b === 'string' && b.startsWith('[') ? parse(b) : b;
    if (Array.isArray(la) || Array.isArray(lb)) return JSON.stringify([...(Array.isArray(la) ? la : [la]), ...(Array.isArray(lb) ? lb : [lb])]);
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    return String(a) + String(b);
  });
  db.function('cy_size', { deterministic: true }, (v) => {
    if (v === null || v === undefined) return null;
    const p = typeof v === 'string' && (v.startsWith('[') || v.startsWith('{')) ? parse(v) : v;
    if (Array.isArray(p)) return p.length;
    return String(v).length;
  });
  db.function('cy_reverse', { deterministic: true }, (v) => (v === null ? null : JSON.stringify([...parse(v)].reverse())));
  db.function('cy_labels', { deterministic: true }, (kind, props) => {
    if (kind === null) return null;
    const out = [labels[kind] || kind];
    const p = parse(props) || {};
    for (const [label, d] of Object.entries(derived)) if (d.kind === kind && p[d.prop] === d.value) out.push(label);
    return JSON.stringify(out);
  });
  db.function('cy_path', { varargs: true, deterministic: true }, (...parts) => {
    const nodes = [parts[0]];
    const rels = [];
    for (let i = 1; i < parts.length; i += 2) {
      const seg = parse(parts[i]);
      if (seg.r) { rels.push(parse(seg.r)); nodes.push(parts[i + 1]); }
      else { const vn = parse(seg.vn); const vr = parse(seg.vr); nodes.push(...vn.slice(1)); rels.push(...vr.map(parse)); }
    }
    return JSON.stringify({ nodes, rels });
  });
}
`;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.betterSqlite3);
const vec = require(workerData.sqliteVec);
${SQL_FUNCTIONS_SRC}
const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
db.pragma('busy_timeout = 2000');
vec.load(db);
registerCypherFunctions(db, workerData.labels, workerData.derived);
parentPort.on('message', ({ id, sql, binds, explain, timeoutMs }) => {
  deadline = Date.now() + timeoutMs;
  try {
    const stmt = db.prepare(explain ? 'EXPLAIN QUERY PLAN ' + sql : sql);
    if (!stmt.reader) throw new Error('only read statements are allowed');
    const rows = explain ? stmt.all(binds) : stmt.raw(true).all(binds);
    parentPort.postMessage({ id, rows });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
`;

const timeoutError = (ms: number) =>
  new CypherError(`query timed out after ${ms} ms`, null, 'add labels, a $ref anchor or a smaller hop range', 'cypher_timeout');

interface Pending {
  resolve: (rows: unknown[]) => void;
  reject: (e: Error) => void;
}

export class CypherRunner {
  private worker?: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly dbPath: string,
    private readonly timeoutMs: number,
  ) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        path: this.dbPath,
        betterSqlite3: require.resolve('better-sqlite3'),
        sqliteVec: require.resolve('sqlite-vec'),
        labels: NODE_LABELS,
        derived: DERIVED_LABELS,
      },
    });
    w.unref();
    w.on('message', (m: { id: number; rows?: unknown[]; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error?.includes('CYPHER_TIMEOUT')) p.reject(timeoutError(this.timeoutMs));
      else if (m.error) p.reject(new CypherError(`query failed: ${m.error}`, null, undefined, 'cypher_runtime'));
      else p.resolve(m.rows ?? []);
    });
    w.on('error', (e) => this.failAll(e));
    w.on('exit', () => {
      if (this.worker === w) this.worker = undefined;
      this.failAll(new Error('query worker exited'));
    });
    this.worker = w;
    return w;
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** Run a read query; rejects with code `cypher_timeout` after the timeout (the worker is restarted). */
  run(sql: string, binds: Record<string, unknown>, explain = false, timeoutMs = this.timeoutMs): Promise<unknown[]> {
    const w = this.start();
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      // Backstop: the in-query guard normally fires first; if not, drop the worker.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(timeoutMs));
        this.worker = undefined;
        void w.terminate();
      }, timeoutMs + 3000);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ id, sql, binds, explain, timeoutMs });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}
