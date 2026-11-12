/**
 * PostgreSQL driver (`pg`, pooled). Every statement names its tables schema-qualified (no search_path, no session
 * SET outside a transaction), locks are transaction-scoped advisory locks and named prepared statements can be turned
 * off, so the driver works behind transaction-mode poolers (Supabase :6543, PgBouncer) as well as on direct
 * connections. PGlite (embedded Postgres, tests) plugs in through its node-postgres shim as `poolConfig`.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { makeDialect } from './dialect.js';
import { KeyedMutex } from './sqlite.js';
import { normalizeParams, toDollarParams } from './sql.js';
import type { Capabilities, Db, Dialect, Queryable, RunResult, SqlValue, TxOptions } from './types.js';

export type SslMode = 'disable' | 'require' | 'verify-full';

export interface PostgresOptions {
  /** The resolved connection URL (from the env var `database.urlEnv` names; never logged). */
  connectionString?: string;
  /** Raw pool config instead of a URL (PGlite: `createPgConfig(pglite)`). */
  poolConfig?: pg.PoolConfig;
  /** Embedded single-session engine (PGlite): pool of one, no cross-connection concurrency. */
  embedded?: boolean;
  /** Schema of this scope (server state: `mandate_server`). */
  schema: string;
  /** TLS: `require` encrypts without verifying the certificate (libpq semantics); `verify-full` checks it (`sslRootCert`). */
  ssl?: SslMode;
  /** PEM text of the CA for `verify-full`. */
  sslRootCert?: string;
  pool?: { max?: number; idleTimeoutMs?: number; connectionTimeoutMs?: number };
  /** Named prepared statements (off behind transaction-mode poolers). Default true. */
  prepare?: boolean;
  /** Schema where `CREATE EXTENSION` puts missing extensions (default: `extensions` when it exists, else `public`). */
  extensionsSchema?: string;
  applicationName?: string;
}

/** int8 (COUNT, BIGINT epoch ms) as a JS number; everything else as pg parses it. */
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => (oid === 20 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as 'text'))) as pg.CustomTypesConfig['getTypeParser'],
};

/** Split `sslmode` (and libpq-only params) out of a URL: node-postgres would otherwise reinterpret them. */
export function parseSslFromUrl(url: string): { url: string; ssl?: SslMode } {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    u.searchParams.delete('sslmode');
    u.searchParams.delete('uselibpqcompat');
    const ssl: SslMode | undefined = mode === 'disable' ? 'disable' : mode === 'require' || mode === 'prefer' || mode === 'allow' ? 'require' : mode === 'verify-ca' || mode === 'verify-full' ? 'verify-full' : undefined;
    return { url: u.toString(), ...(ssl ? { ssl } : {}) };
  } catch {
    return { url };
  }
}

export function sslConfig(mode: SslMode | undefined, ca?: string): pg.PoolConfig['ssl'] {
  if (!mode || mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

class Core {
  readonly pool: pg.Pool;
  readonly locks = new KeyedMutex();
  readonly prepare: boolean;
  extSchemas: Record<string, string> = {};
  refs = 1;
  constructor(readonly opts: PostgresOptions) {
    let cfg: pg.PoolConfig;
    if (opts.poolConfig) cfg = { ...opts.poolConfig };
    else {
      if (!opts.connectionString) throw new Error('postgres: no connection URL');
      const { url, ssl } = parseSslFromUrl(opts.connectionString);
      const mode = opts.ssl ?? ssl;
      cfg = { connectionString: url, ssl: sslConfig(mode, opts.sslRootCert) };
    }
    this.pool = new pg.Pool({
      ...cfg,
      types,
      max: opts.embedded ? 1 : (opts.pool?.max ?? 10),
      idleTimeoutMillis: opts.pool?.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: opts.pool?.connectionTimeoutMs ?? 10_000,
      application_name: opts.applicationName ?? 'mandate',
    });
    // An idle client dropped by the server (restart, pooler) must not crash the process.
    this.pool.on('error', () => undefined);
    // PGlite: several pools share one session, so per-client statement names would collide.
    this.prepare = opts.embedded ? false : (opts.prepare ?? true);
  }
}

type Runner = pg.Pool | pg.PoolClient;

class Conn implements Queryable {
  constructor(
    private readonly core: Core,
    private readonly runner: Runner,
    readonly dialect: Dialect,
  ) {}
  private async q(sql: string, params?: readonly SqlValue[]): Promise<pg.QueryResult> {
    const text = toDollarParams(sql);
    const values = normalizeParams(params);
    if (this.core.prepare && values.length) return this.runner.query({ name: `m${createHash('sha1').update(text).digest('hex').slice(0, 20)}`, text, values });
    return this.runner.query(text, values);
  }
  async all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return (await this.q(sql, params)).rows as T[];
  }
  async get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
    return (await this.q(sql, params)).rows[0] as T | undefined;
  }
  async run(sql: string, params?: readonly SqlValue[]): Promise<RunResult> {
    return { changes: (await this.q(sql, params)).rowCount ?? 0 };
  }
  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }
}

export class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  readonly dialect: Dialect;
  private readonly conn: Conn;

  private constructor(
    private readonly core: Core,
    readonly schema: string,
    private readonly prefix = '',
  ) {
    this.dialect = makeDialect('postgres', { schema, prefix, extSchemas: core.extSchemas });
    this.conn = new Conn(core, core.pool, this.dialect);
  }

  get caps(): Capabilities {
    const embedded = !!this.core.opts.embedded;
    return { skipLocked: true, sharedLocks: !embedded, multiInstance: !embedded, singleSession: embedded, vector: 'vector' in this.core.extSchemas, trigram: 'pg_trgm' in this.core.extSchemas };
  }

  /** Connect (one round trip: detects installed extensions). */
  static async connect(opts: PostgresOptions): Promise<PostgresDb> {
    const core = new Core(opts);
    try {
      core.extSchemas = await detectExtensions(core.pool);
    } catch (e) {
      await core.pool.end().catch(() => undefined);
      throw e;
    }
    return new PostgresDb(core, opts.schema);
  }

  get pool(): pg.Pool {
    return this.core.pool;
  }
  /** Installed extensions and their schemas (`{ vector: 'extensions' }`). */
  get extensions(): Readonly<Record<string, string>> {
    return this.core.extSchemas;
  }

  all<T>(sql: string, params?: readonly SqlValue[]) {
    return this.conn.all<T>(sql, params);
  }
  get<T>(sql: string, params?: readonly SqlValue[]) {
    return this.conn.get<T>(sql, params);
  }
  run(sql: string, params?: readonly SqlValue[]) {
    return this.conn.run(sql, params);
  }
  exec(sql: string) {
    return this.conn.exec(sql);
  }

  private async onClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.core.pool.connect();
    let broken: Error | undefined;
    try {
      return await fn(c);
    } catch (e) {
      broken = e as Error;
      throw e;
    } finally {
      // A failed ROLLBACK means the connection is unusable: drop it from the pool.
      c.release(broken && (broken as { rollbackFailed?: boolean }).rollbackFailed ? broken : undefined);
    }
  }

  private async inTx<T>(c: pg.PoolClient, opts: TxOptions, body: (q: Queryable) => Promise<T>): Promise<T> {
    await c.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
      if (opts.statementTimeoutMs) await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.statementTimeoutMs))}`);
      const v = await body(new Conn(this.core, c, this.dialect));
      await c.query('COMMIT');
      return v;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        Object.assign(e as object, { rollbackFailed: true });
      }
      throw e;
    }
  }

  tx<T>(fn: (q: Queryable) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.onClient((c) => this.inTx(c, opts, fn));
  }

  /** In-process mutex first (one connection per key and process), then the transaction-scoped advisory lock. */
  withLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.core.locks.run(key, () =>
      this.onClient((c) =>
        this.inTx(c, {}, async (q) => {
          await q.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`mandate:${key}`]);
          return fn(q);
        }),
      ),
    );
  }

  async tryWithLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.core.locks.held(key)) return { acquired: false };
    return this.core.locks.run(key, () =>
      this.onClient(async (c) => {
        const NOT = Symbol('not acquired');
        try {
          const value = await this.inTx(c, {}, async (q) => {
            const r = await q.get<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS ok', [`mandate:${key}`]);
            if (!r?.ok) throw NOT;
            return fn(q);
          });
          return { acquired: true as const, value };
        } catch (e) {
          if (e === NOT) return { acquired: false as const };
          throw e;
        }
      }),
    );
  }

  scoped(scope: string): Db {
    this.core.refs++;
    return new PostgresDb(this.core, scope, this.prefix);
  }

  /** Same schema, table prefix (`schemaPerProject: 'prefix'`). */
  prefixed(prefix: string): PostgresDb {
    this.core.refs++;
    return new PostgresDb(this.core, this.schema, prefix);
  }

  /**
   * Create missing extensions (needs the CREATE privilege; on Supabase enable them in the dashboard or let this create
   * them `WITH SCHEMA extensions`). Returns what is still missing.
   */
  async ensureExtensions(names: string[]): Promise<string[]> {
    for (const name of names) {
      if (this.core.extSchemas[name]) continue;
      const target = this.core.opts.extensionsSchema ?? ((await this.get<{ ok: number }>("SELECT 1 AS ok FROM pg_namespace WHERE nspname = 'extensions'")) ? 'extensions' : 'public');
      try {
        await this.exec(`CREATE EXTENSION IF NOT EXISTS ${this.dialect.q(name)} WITH SCHEMA ${this.dialect.q(target)}`);
      } catch {
        // No privilege / not available on this server: reported below.
      }
    }
    Object.assign(this.core.extSchemas, await detectExtensions(this.core.pool));
    return names.filter((n) => !this.core.extSchemas[n]);
  }

  async close(): Promise<void> {
    if (--this.core.refs <= 0) await this.core.pool.end();
  }
}

export async function detectExtensions(pool: pg.Pool | pg.PoolClient): Promise<Record<string, string>> {
  const r = await pool.query<{ extname: string; nspname: string }>('SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace');
  return Object.fromEntries(r.rows.map((x) => [x.extname, x.nspname]));
}
