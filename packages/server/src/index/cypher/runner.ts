/**
 * Executes compiled Cypher SQL on a separate read-only connection in a worker thread, so a
 * runaway query can be stopped (better-sqlite3 is synchronous: the worker is terminated on timeout).
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DERIVED_LABELS, NODE_LABELS } from '@mandate/shared';
import { VAR_LENGTH_ROW_BUDGET } from './compile.js';
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
  // Raises a marker error the runner maps to a Cypher error (e.g. CYPHER_BUDGET: a variable-length expansion too large).
  db.function('cy_fail', { deterministic: false, varargs: true }, (marker) => {
    throw new Error(String(marker));
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

export const budgetError = (n: number) =>
  new CypherError(`a variable-length relationship expanded to more than ${n} paths`, null, 'add labels, a $ref anchor or a smaller hop range', 'cypher_budget');

interface Job {
  id: number;
  msg: { id: number; sql: string; binds: Record<string, unknown>; explain: boolean; timeoutMs: number };
  resolve: (rows: unknown[]) => void;
  reject: (e: Error) => void;
}

/**
 * One query in flight per worker; the others wait in a queue. The backstop timer is armed when a query is handed to
 * the (idle) worker, so time spent queued never counts, and a backstop kill fails only the query that ran: the queue
 * goes on on a fresh worker.
 */
export class CypherRunner {
  private worker?: Worker;
  private seq = 0;
  private readonly queue: Job[] = [];
  private current?: { job: Job; worker: Worker; timer: NodeJS.Timeout };
  /** Variable-length expansion budget the compiler uses with this runner. */
  varLengthBudget = VAR_LENGTH_ROW_BUDGET;

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
      this.finish(w, m.id, (job) => {
        if (m.error?.includes('CYPHER_TIMEOUT')) job.reject(timeoutError(job.msg.timeoutMs));
        else if (m.error?.includes('CYPHER_BUDGET')) job.reject(budgetError(this.varLengthBudget));
        else if (m.error) job.reject(new CypherError(`query failed: ${m.error}`, null, undefined, 'cypher_runtime'));
        else job.resolve(m.rows ?? []);
      });
    });
    const lost = (e: Error) => {
      if (this.worker === w) this.worker = undefined;
      if (this.current?.worker === w) this.finish(w, this.current.job.id, (job) => job.reject(e));
    };
    w.on('error', (e) => lost(e));
    w.on('exit', () => lost(new Error('query worker exited')));
    this.worker = w;
    return w;
  }

  /** Settles the in-flight query (if it is still `id` on worker `w`) and starts the next one. */
  private finish(w: Worker, id: number, settle: (job: Job) => void) {
    const c = this.current;
    if (!c || c.worker !== w || c.job.id !== id) return;
    clearTimeout(c.timer);
    this.current = undefined;
    settle(c.job);
    this.pump();
  }

  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    let w: Worker;
    try {
      w = this.start();
    } catch (e) {
      job.reject(e as Error);
      return this.pump();
    }
    // Backstop: the in-query guard normally fires first; if not, drop the worker (only this query fails).
    const timer = setTimeout(() => {
      if (this.worker === w) this.worker = undefined;
      void w.terminate();
      this.finish(w, job.id, (j) => j.reject(timeoutError(j.msg.timeoutMs)));
    }, job.msg.timeoutMs + 3000);
    this.current = { job, worker: w, timer };
    w.postMessage(job.msg);
  }

  /** Run a read query; rejects with code `cypher_timeout` after the timeout (the worker is restarted). */
  run(sql: string, binds: Record<string, unknown>, explain = false, timeoutMs = this.timeoutMs): Promise<unknown[]> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, msg: { id, sql, binds, explain, timeoutMs }, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    const closed = new Error('query runner closed');
    for (const j of this.queue.splice(0)) j.reject(closed);
    const c = this.current;
    if (c) this.finish(c.worker, c.job.id, (j) => j.reject(closed));
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}
