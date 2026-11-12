/**
 * The search index on Postgres: a per-project schema (`mandate_<id>`) fed from the SQLite build by change-data capture.
 *
 * Design: the indexer stays the single implementation that derives the index from git, writing its local SQLite build
 * synchronously (fast: thousands of small statements, no network round trips). Temporary triggers on that connection
 * (never stored in the file) log every changed row; `publish()` copies the changes to Postgres in one transaction:
 * - regular tables are mirrored generically (introspected from the build, so new tables / columns — e.g. lineage edges,
 *   which are just rows of `nodes` / `edges` — need no code here), keyed by the SQLite rowid (`rid`);
 * - FTS5 tables become tables with a weighted `tsvector` (GIN), re-published per changed source / commit;
 * - `fts_raw.body` and `symbols.name` get `pg_trgm` GIN indexes (literal / fuzzy search);
 * - vectors: `vectors_<dims>` with pgvector, one partial HNSW index per model, fed from `embedding_cache`;
 * - Cypher helper functions (`cy_*`) live in the schema (see cypher/pg/target.ts).
 * The first publish of a process (or after a schema change / failed publish) is a full copy; later ones are incremental.
 * Publishing holds the advisory lock `mandate:index:<project>`, so instances never interleave publishes.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DERIVED_LABELS, NODE_LABELS } from '@mandate/shared';
import { projectScope } from '../config.js';
import type { PostgresDb } from '../postgres.js';
import type { Db, Queryable, SqlValue } from '../types.js';

type Handle = Database.Database;

/** Tables of the build that are NOT mirrored (local work queue, raw file texts). */
const SKIP = new Set(['files', 'embed_jobs', 'embed_queue_state']);
/** FTS5 tables mirrored as tsvector tables: key column (re-published per key) and per-column weights. */
const FTS: Record<string, { key: 'source' | 'sha'; weights: Record<string, 'A' | 'B' | 'C' | 'D'>; config: Record<string, string>; trgm?: string }> = {
  fts_sections: { key: 'source', weights: { title: 'A', summary: 'B', symbols: 'B', body: 'D' }, config: { symbols: 'simple' } },
  fts_raw: { key: 'source', weights: {}, config: {}, trgm: 'body' },
  fts_commits: { key: 'sha', weights: { subject: 'A', body: 'C', trailers: 'D' }, config: {} },
};
/** ts_rank_cd weights {D, C, B, A}: body 0.2, summary / symbols 0.6, title 1.0 (the BM25 weights 1 : 3 : 5). */
export const TS_WEIGHTS = '{0.2,0.4,0.6,1.0}';
const BATCH_PARAMS = 20_000;

interface Col {
  name: string;
  pgType: string;
}
interface Table {
  name: string;
  cols: Col[];
  /** Column logged as the change's source key (`source`, or `sha` for commits). */
  src: string | null;
  indexes: string[][];
}

const pgTypeOf = (decl: string) => {
  const t = decl.toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (/REAL|FLOA|DOUB/.test(t)) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  return 'TEXT';
};
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Regular tables of the build (virtual tables, their shadow tables and views excluded). */
export function introspect(h: Handle): { tables: Table[]; fts: { name: string; cols: string[] }[]; view: string | null; hash: string } {
  const list = h.prepare('PRAGMA table_list').all() as { schema: string; name: string; type: string }[];
  const tables: Table[] = [];
  const fts: { name: string; cols: string[] }[] = [];
  for (const t of list.filter((x) => x.schema === 'main').sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.name.startsWith('sqlite_')) continue;
    const info = h.prepare(`PRAGMA table_info(${qi(t.name)})`).all() as { name: string; type: string; pk: number }[];
    if (t.type === 'virtual' && FTS[t.name]) fts.push({ name: t.name, cols: info.map((c) => c.name) });
    // vec0 keeps its data in shadow tables reported as plain tables: vectors are mirrored from embedding_cache.
    if (t.type !== 'table' || SKIP.has(t.name) || /^vec_/.test(t.name)) continue;
    const cols = info.map((c) => ({ name: c.name, pgType: pgTypeOf(c.type) }));
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const idx = (h.prepare(`PRAGMA index_list(${qi(t.name)})`).all() as { name: string; origin: string }[]).filter((i) => i.origin === 'c');
    const indexes = idx.map((i) => (h.prepare(`PRAGMA index_info(${qi(i.name)})`).all() as { name: string | null }[]).map((c) => c.name)).filter((cs) => cs.every((c): c is string => !!c));
    if (pk.length && !(pk.length === 1 && cols.find((c) => c.name === pk[0])?.pgType === 'BIGINT' && pk[0] === 'id')) indexes.push(pk);
    const names = cols.map((c) => c.name);
    tables.push({ name: t.name, cols, src: names.includes('source') ? 'source' : names.includes('sha') ? 'sha' : null, indexes });
  }
  const view = (h.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'entries'").get() as { sql: string } | undefined)?.sql ?? null;
  const hash = createHash('sha256').update(JSON.stringify({ v: 3, tables, fts, view })).digest('hex').slice(0, 16);
  return { tables, fts, view, hash };
}

/** The Postgres scope of a project's index (schema per project, or prefixed tables). */
export function indexDb(db: PostgresDb, projectId: string, mode: boolean | 'prefix'): PostgresDb {
  const s = projectScope(projectId, mode);
  return s.prefix ? (db.scoped(s.schema) as PostgresDb).prefixed(s.prefix) : (db.scoped(s.schema) as PostgresDb);
}

/** Drop a project's index (project removed). */
export async function dropIndexSchema(db: PostgresDb, projectId: string, mode: boolean | 'prefix'): Promise<void> {
  const s = projectScope(projectId, mode);
  if (!s.prefix) {
    await db.exec(`DROP SCHEMA IF EXISTS ${qi(s.schema)} CASCADE`);
    return;
  }
  const rows = await db.all<{ n: string; k: string }>("SELECT c.relname AS n, c.relkind AS k FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ? AND c.relname LIKE ? AND c.relkind IN ('r', 'v')", [s.schema, `${s.prefix.replace(/_/g, '\\_')}%`]);
  for (const r of rows) await db.exec(`DROP ${r.k === 'v' ? 'VIEW' : 'TABLE'} IF EXISTS ${qi(s.schema)}.${qi(r.n)} CASCADE`);
  const fns = await db.all<{ n: string }>("SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = ? AND p.proname LIKE ?", [s.schema, `${s.prefix.replace(/_/g, '\\_')}%`]);
  for (const f of fns) await db.exec(`DROP FUNCTION IF EXISTS ${qi(s.schema)}.${qi(f.n)} CASCADE`);
}

/* ---------------------------------------------------------------- Cypher helper functions */

/** `cy_*` SQL functions used by the Postgres Cypher emitter (jsonb in, jsonb out). */
export function cypherFunctionsSql(fn: (name: string) => string): string {
  const labels = JSON.stringify(NODE_LABELS).replace(/'/g, "''");
  const derived = JSON.stringify(DERIVED_LABELS).replace(/'/g, "''");
  return `
CREATE OR REPLACE FUNCTION ${fn('cy_add')}(a jsonb, b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL THEN NULL
    WHEN jsonb_typeof(a) = 'array' OR jsonb_typeof(b) = 'array' THEN
      (CASE WHEN jsonb_typeof(a) = 'array' THEN a ELSE jsonb_build_array(a) END) || (CASE WHEN jsonb_typeof(b) = 'array' THEN b ELSE jsonb_build_array(b) END)
    WHEN jsonb_typeof(a) = 'number' AND jsonb_typeof(b) = 'number' THEN to_jsonb((a #>> '{}')::numeric + (b #>> '{}')::numeric)
    ELSE to_jsonb((a #>> '{}') || (b #>> '{}'))
  END
$f$;
CREATE OR REPLACE FUNCTION ${fn('cy_size')}(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN v IS NULL THEN NULL WHEN jsonb_typeof(v) = 'array' THEN to_jsonb(jsonb_array_length(v)) ELSE to_jsonb(length(v #>> '{}')) END
$f$;
CREATE OR REPLACE FUNCTION ${fn('cy_reverse')}(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce((SELECT jsonb_agg(e ORDER BY o DESC) FROM jsonb_array_elements(v) WITH ORDINALITY AS t(e, o)), '[]'::jsonb)
$f$;
CREATE OR REPLACE FUNCTION ${fn('cy_labels')}(kind text, props text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN kind IS NULL THEN NULL ELSE
    jsonb_build_array(coalesce('${labels}'::jsonb ->> kind, kind)) || coalesce((
      SELECT jsonb_agg(d.key ORDER BY d.ord) FROM jsonb_each('${derived}'::jsonb) WITH ORDINALITY AS d(key, value, ord)
       WHERE d.value ->> 'kind' = kind AND (coalesce(props, '{}')::jsonb ->> (d.value ->> 'prop')) = d.value ->> 'value'), '[]'::jsonb)
  END
$f$;
CREATE OR REPLACE FUNCTION ${fn('cy_path')}(parts jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object(
    'nodes', jsonb_build_array(parts -> 0) || coalesce((
      SELECT jsonb_agg(x.n ORDER BY x.i, x.j) FROM (
        SELECT i, 0 AS j, parts -> (i + 1) AS n FROM generate_series(1, jsonb_array_length(parts) - 1, 2) AS i WHERE (parts -> i) ? 'r'
        UNION ALL
        SELECT i, k.o AS j, k.e AS n FROM generate_series(1, jsonb_array_length(parts) - 1, 2) AS i, jsonb_array_elements(parts -> i -> 'vn') WITH ORDINALITY AS k(e, o)
         WHERE NOT ((parts -> i) ? 'r') AND k.o > 1
      ) x), '[]'::jsonb),
    'rels', coalesce((
      SELECT jsonb_agg(x.r ORDER BY x.i, x.j) FROM (
        SELECT i, 0 AS j, parts -> i -> 'r' AS r FROM generate_series(1, jsonb_array_length(parts) - 1, 2) AS i WHERE (parts -> i) ? 'r'
        UNION ALL
        SELECT i, k.o AS j, k.e AS r FROM generate_series(1, jsonb_array_length(parts) - 1, 2) AS i, jsonb_array_elements(parts -> i -> 'vr') WITH ORDINALITY AS k(e, o)
         WHERE NOT ((parts -> i) ? 'r')
      ) x), '[]'::jsonb))
$f$;
CREATE OR REPLACE FUNCTION ${fn('cy_regexp')}(pattern jsonb, value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE p text := pattern #>> '{}'; v text := value #>> '{}'; flags text := ''; m text[];
BEGIN
  IF p IS NULL OR v IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(p, '^\\(\\?([imsu]+)\\)');
  IF m IS NOT NULL THEN
    p := substr(p, length(m[1]) + 4);
    IF position('i' in m[1]) > 0 THEN flags := flags || 'i'; END IF;
  END IF;
  RETURN v ~ ((CASE WHEN flags <> '' THEN '(?' || flags || ')' ELSE '' END) || '^(?:' || p || ')$');
END
$f$;
`;
}

/* ---------------------------------------------------------------- publisher */

export interface PublishResult {
  mode: 'full' | 'incremental' | 'none';
  rows: number;
  ms: number;
}

export class IndexMirror {
  private schema: ReturnType<typeof introspect> | null = null;
  private needFull = true;
  private installed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  lastError: string | null = null;
  lastPublish: PublishResult | null = null;

  constructor(
    private readonly build: Handle,
    readonly db: PostgresDb,
    readonly projectId: string,
  ) {}

  private get d() {
    return this.db.dialect;
  }
  private t(name: string) {
    return this.d.table(name);
  }
  /** Schema-qualified function name in this scope (`cy_add` …). */
  fn(name: string): string {
    return this.d.table(name);
  }

  /** Install the change-capture triggers (temporary: this connection only, never written to the index file). */
  private install(): void {
    const s = (this.schema ??= introspect(this.build));
    const h = this.build;
    h.pragma('recursive_triggers = ON'); // INSERT OR REPLACE deletes fire the delete trigger
    h.exec('CREATE TEMP TABLE IF NOT EXISTS pub_log (t TEXT NOT NULL, rid INTEGER NOT NULL, src TEXT)');
    for (const t of s.tables) {
      const src = (row: 'NEW' | 'OLD') => (t.src ? `${row}.${qi(t.src)}` : 'NULL');
      const name = (k: string) => qi(`pub_${t.name}_${k}`);
      h.exec(`DROP TRIGGER IF EXISTS temp.${name('i')}; DROP TRIGGER IF EXISTS temp.${name('u')}; DROP TRIGGER IF EXISTS temp.${name('d')};`);
      h.exec(`CREATE TEMP TRIGGER ${name('i')} AFTER INSERT ON main.${qi(t.name)} BEGIN INSERT INTO pub_log VALUES ('${t.name}', NEW.rowid, ${src('NEW')}); END`);
      h.exec(`CREATE TEMP TRIGGER ${name('u')} AFTER UPDATE ON main.${qi(t.name)} BEGIN INSERT INTO pub_log VALUES ('${t.name}', OLD.rowid, ${src('OLD')}); INSERT INTO pub_log VALUES ('${t.name}', NEW.rowid, ${src('NEW')}); END`);
      h.exec(`CREATE TEMP TRIGGER ${name('d')} AFTER DELETE ON main.${qi(t.name)} BEGIN INSERT INTO pub_log VALUES ('${t.name}', OLD.rowid, ${src('OLD')}); END`);
    }
    this.installed = true;
  }

  /** Re-check the build schema (the index file is recreated on a schema version bump: triggers are gone). */
  private checkSchema(): void {
    const now = introspect(this.build);
    const triggers = (this.build.prepare("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'pub\\_%' ESCAPE '\\'").get() as { n: number }).n;
    if (!this.schema || now.hash !== this.schema.hash || triggers < now.tables.length * 3) {
      this.schema = now;
      this.needFull = true;
      this.install();
    }
  }

  /** Create / replace the mirror tables when the build's schema changed (hash in mirror_meta). */
  private async ensureMirror(q: Queryable, full: boolean): Promise<void> {
    const s = this.schema!;
    const d = this.d;
    if (d.schema) await q.exec(`CREATE SCHEMA IF NOT EXISTS ${qi(d.schema)}`);
    await q.exec(`CREATE TABLE IF NOT EXISTS ${this.t('mirror_meta')} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const cur = (await q.get<{ value: string }>(`SELECT value FROM ${this.t('mirror_meta')} WHERE key = 'schema_hash'`))?.value;
    if (cur === s.hash && !full) return;
    if (cur !== s.hash) {
      // Drop what the old schema had (tables named in the old schema are unknown: drop by the current names + known extras).
      for (const t of [...s.tables.map((x) => x.name), ...Object.keys(FTS)]) await q.exec(`DROP TABLE IF EXISTS ${this.t(t)} CASCADE`);
      await q.exec(`DROP VIEW IF EXISTS ${this.t('entries')}`);
    }
    for (const t of s.tables) {
      await q.exec(`CREATE TABLE IF NOT EXISTS ${this.t(t.name)} (rid BIGINT PRIMARY KEY, ${t.cols.map((c) => `${qi(c.name)} ${c.pgType}`).join(', ')})`);
      for (const cols of t.indexes) await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index(`${t.name}_${cols.join('_')}`.slice(0, 55))} ON ${this.t(t.name)} (${cols.map(qi).join(', ')})`);
    }
    const trgm = this.db.caps.trigram ? d.ext('gin_trgm_ops') : null;
    for (const f of s.fts) {
      const spec = FTS[f.name]!;
      const parts = f.cols
        .filter((c) => spec.weights[c])
        .map((c) => `setweight(to_tsvector('${spec.config[c] ?? 'english'}', coalesce(${qi(c)}, '')), '${spec.weights[c]}')`);
      const tsv = parts.length ? `, tsv tsvector GENERATED ALWAYS AS (${parts.join(' || ')}) STORED` : '';
      await q.exec(`CREATE TABLE IF NOT EXISTS ${this.t(f.name)} (${f.cols.map((c) => `${qi(c)} TEXT`).join(', ')}${tsv})`);
      await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index(`${f.name}_key`)} ON ${this.t(f.name)} (${qi(spec.key)})`);
      if (tsv) await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index(`${f.name}_tsv`)} ON ${this.t(f.name)} USING gin (tsv)`);
      if (spec.trgm && trgm) await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index(`${f.name}_trgm`)} ON ${this.t(f.name)} USING gin (${qi(spec.trgm)} ${trgm})`);
    }
    if (trgm && s.tables.some((t) => t.name === 'symbols')) await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index('symbols_name_trgm')} ON ${this.t('symbols')} USING gin (name ${trgm})`);
    if (s.view) {
      // The view text is portable; table names are qualified in this scope.
      let sql = s.view.replace(/^CREATE VIEW (IF NOT EXISTS )?entries AS/i, `CREATE OR REPLACE VIEW ${this.t('entries')} AS`);
      for (const t of s.tables) sql = sql.replace(new RegExp(`\\b(FROM|JOIN) ${t.name}\\b`, 'g'), `$1 ${this.t(t.name)}`);
      await q.exec(sql);
    }
    await q.exec(cypherFunctionsSql((n) => this.fn(n)));
    await q.run(`INSERT INTO ${this.t('mirror_meta')} (key, value) VALUES ('schema_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [s.hash]);
  }

  /** Publish soon (debounced); returns at once. */
  schedule(ms = 500): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.publish().catch(() => undefined), ms);
    this.timer.unref?.();
  }

  /** Copy the build's changes to Postgres (serialized; full on the first call or after a failure). */
  publish(): Promise<PublishResult> {
    const run = this.chain.then(() => this.publishOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async publishOnce(): Promise<PublishResult> {
    const t0 = Date.now();
    this.checkSchema();
    if (!this.installed) this.install();
    const full = this.needFull;
    // Take the change log in one synchronous step: a consistent snapshot, nothing interleaves.
    const log = this.build.transaction(() => {
      const rows = this.build.prepare('SELECT t, rid, src FROM temp.pub_log').all() as { t: string; rid: number; src: string | null }[];
      this.build.exec('DELETE FROM temp.pub_log');
      return rows;
    })();
    if (!full && !log.length) return (this.lastPublish = { mode: 'none', rows: 0, ms: Date.now() - t0 });
    let rows = 0;
    try {
      await this.db.withLock(`index:${this.projectId}`, async (q) => {
        await this.ensureMirror(q, full);
        if (full) rows = await this.copyAll(q);
        else rows = await this.copyChanges(q, log);
        const head = this.build.prepare('SELECT head_commit FROM index_state WHERE id = 1').get() as { head_commit: string | null } | undefined;
        await q.run(`INSERT INTO ${this.t('mirror_meta')} (key, value) VALUES ('head_commit', ?), ('published_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [head?.head_commit ?? '', new Date().toISOString()]);
      });
      this.needFull = false;
      this.lastError = null;
    } catch (e) {
      // The log is consumed: the next publish copies everything again.
      this.needFull = true;
      this.lastError = (e as Error).message;
      throw e;
    }
    return (this.lastPublish = { mode: full ? 'full' : 'incremental', rows, ms: Date.now() - t0 });
  }

  private async insertRows(q: Queryable, table: string, cols: string[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const per = Math.max(1, Math.floor(BATCH_PARAMS / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
      await q.run(`INSERT INTO ${this.t(table)} (${cols.map(qi).join(', ')}) VALUES ${values}`, chunk.flat() as SqlValue[]);
    }
  }

  private selectRows(t: Table, where = '', params: unknown[] = []): unknown[][] {
    return this.build
      .prepare(`SELECT rowid, ${t.cols.map((c) => qi(c.name)).join(', ')} FROM main.${qi(t.name)}${where}`)
      .raw(true)
      .all(...params) as unknown[][];
  }

  private ftsRows(name: string, cols: string[], key: string, keys: string[] | null): unknown[][] {
    const sel = `SELECT ${cols.map(qi).join(', ')} FROM main.${qi(name)}`;
    if (!keys) return this.build.prepare(sel).raw(true).all() as unknown[][];
    const out: unknown[][] = [];
    const st = this.build.prepare(`${sel} WHERE ${qi(key)} = ?`).raw(true);
    for (const k of keys) out.push(...(st.all(k) as unknown[][]));
    return out;
  }

  private async copyAll(q: Queryable): Promise<number> {
    const s = this.schema!;
    let n = 0;
    for (const t of s.tables) {
      await q.exec(`TRUNCATE ${this.t(t.name)}`);
      const rows = this.selectRows(t);
      await this.insertRows(q, t.name, ['rid', ...t.cols.map((c) => c.name)], rows);
      n += rows.length;
    }
    for (const f of s.fts) {
      await q.exec(`TRUNCATE ${this.t(f.name)}`);
      const rows = this.ftsRows(f.name, f.cols, FTS[f.name]!.key, null);
      await this.insertRows(q, f.name, f.cols, rows);
      n += rows.length;
    }
    await this.publishVectors(q, null);
    return n;
  }

  private async copyChanges(q: Queryable, log: { t: string; rid: number; src: string | null }[]): Promise<number> {
    const s = this.schema!;
    let n = 0;
    const byTable = new Map<string, Set<number>>();
    const srcs = { source: new Set<string>(), sha: new Set<string>() };
    for (const r of log) {
      (byTable.get(r.t) ?? byTable.set(r.t, new Set()).get(r.t)!).add(r.rid);
      const t = s.tables.find((x) => x.name === r.t);
      if (t?.src && r.src !== null) srcs[t.src as 'source' | 'sha'].add(r.src);
    }
    for (const t of s.tables) {
      const rids = [...(byTable.get(t.name) ?? [])];
      if (!rids.length) continue;
      await q.run(`DELETE FROM ${this.t(t.name)} WHERE rid = ANY(?)`, [rids as unknown as SqlValue]);
      const rows: unknown[][] = [];
      for (let i = 0; i < rids.length; i += 500) {
        const part = rids.slice(i, i + 500);
        rows.push(...this.selectRows(t, ` WHERE rowid IN (${part.map(() => '?').join(', ')})`, part));
      }
      await this.insertRows(q, t.name, ['rid', ...t.cols.map((c) => c.name)], rows);
      n += rids.length;
    }
    for (const f of s.fts) {
      const key = FTS[f.name]!.key;
      const keys = [...srcs[key]];
      if (!keys.length) continue;
      await q.run(`DELETE FROM ${this.t(f.name)} WHERE ${qi(key)} = ANY(?)`, [keys as unknown as SqlValue]);
      const rows = this.ftsRows(f.name, f.cols, key, keys);
      await this.insertRows(q, f.name, f.cols, rows);
      n += rows.length;
    }
    const cache = byTable.get('embedding_cache');
    if (cache?.size) await this.publishVectors(q, [...cache]);
    return n;
  }

  /** pgvector: `vectors_<dims>` per dimension, one partial HNSW index per model, from the embedding cache rows. */
  private async publishVectors(q: Queryable, rids: number[] | null): Promise<void> {
    if (!this.db.caps.vector || !this.schema!.tables.some((t) => t.name === 'embedding_cache')) return;
    const d = this.d;
    const sel = 'SELECT rowid, content_hash, model_id, dims, vector FROM main.embedding_cache';
    const rows: { rowid: number; content_hash: string; model_id: string; dims: number; vector: Buffer }[] = [];
    if (rids === null) rows.push(...(this.build.prepare(sel).all() as typeof rows));
    else for (let i = 0; i < rids.length; i += 500) rows.push(...(this.build.prepare(`${sel} WHERE rowid IN (${rids.slice(i, i + 500).map(() => '?').join(', ')})`).all(...rids.slice(i, i + 500)) as typeof rows));
    const byDims = new Map<number, typeof rows>();
    for (const r of rows) (byDims.get(r.dims) ?? byDims.set(r.dims, []).get(r.dims)!).push(r);
    for (const [dims, list] of byDims) {
      const table = await ensureVectorTable(q, d, dims);
      if (rids === null) await q.exec(`TRUNCATE ${table}`);
      for (const model of new Set(list.map((r) => r.model_id))) await ensureModelIndex(q, d, dims, model);
      const per = Math.floor(BATCH_PARAMS / 4);
      for (let i = 0; i < list.length; i += per) {
        const chunk = list.slice(i, i + per);
        await q.run(
          `INSERT INTO ${table} (id, model_id, content_hash, embedding) VALUES ${chunk.map(() => `(?, ?, ?, ?::${d.ext('vector')})`).join(', ')}
           ON CONFLICT (id) DO UPDATE SET embedding = excluded.embedding`,
          chunk.flatMap((r) => [`${r.model_id}:${r.content_hash}`, r.model_id, r.content_hash, vectorText(r.vector)]),
        );
      }
    }
  }
}

/** float32 little-endian blob → pgvector text `[a,b,…]`. */
export function vectorText(b: Buffer): string {
  const f = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  return `[${Array.from(f).join(',')}]`;
}

export const vectorTableName = (dims: number) => `vectors_${dims}`;

export async function ensureVectorTable(q: Queryable, d: Db['dialect'], dims: number): Promise<string> {
  if (!Number.isInteger(dims) || dims < 1 || dims > 16000) throw new Error(`vector dimensions: ${dims}`);
  const name = d.table(vectorTableName(dims));
  await q.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, model_id TEXT NOT NULL, content_hash TEXT NOT NULL, embedding ${d.ext('vector')}(${dims}) NOT NULL)`);
  return name;
}

/** One partial HNSW index per model: exact model filtering, cosine distance. */
export async function ensureModelIndex(q: Queryable, d: Db['dialect'], dims: number, modelId: string): Promise<void> {
  const slug = createHash('sha1').update(modelId).digest('hex').slice(0, 10);
  await q.exec(`CREATE INDEX IF NOT EXISTS ${d.index(`vectors_${dims}_${slug}_hnsw`)} ON ${d.table(vectorTableName(dims))} USING hnsw (embedding ${d.ext('vector_cosine_ops')}) WHERE model_id = '${modelId.replace(/'/g, "''")}'`);
}
