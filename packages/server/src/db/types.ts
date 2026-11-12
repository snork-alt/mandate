/**
 * The database adapter: one async interface over SQLite (better-sqlite3, the default: local mode and small servers)
 * and PostgreSQL (`pg`, pooled: shared server state for several server instances).
 *
 * Portable SQL: `?` placeholders (rewritten to `$n` on Postgres), table names through `dialect.table()` (schema-qualified
 * on Postgres, never via search_path, so transaction-mode poolers work), times as epoch-millisecond integers, booleans
 * as 0/1 integers, JSON as text. Dialect differences (upsert, SKIP LOCKED, greatest, types, extensions) live in Dialect.
 */
export type Driver = 'sqlite' | 'postgres';

export type SqlValue = string | number | bigint | boolean | null | Buffer | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  /** Rows inserted / updated / deleted. */
  changes: number;
}

export interface Capabilities {
  /** `SELECT … FOR UPDATE SKIP LOCKED` (several workers claim disjoint batches). */
  skipLocked: boolean;
  /** Locks shared by every server instance using this database (Postgres advisory locks). */
  sharedLocks: boolean;
  /** Several server instances (hosts) may share this database. */
  multiInstance: boolean;
  /** Embedded engine with a single session (PGlite): no real concurrency between connections. */
  singleSession: boolean;
  /** Extension availability (Postgres: detected at open; SQLite: sqlite-vec / FTS5 trigram are built in). */
  vector: boolean;
  trigram: boolean;
}

export interface Dialect {
  readonly driver: Driver;
  /** Quote an identifier. */
  q(ident: string): string;
  /** A table name in this database's scope: `"mandate_server"."sessions"` (Postgres schema) or a prefixed name. */
  table(name: string): string;
  /** An index name in this scope (prefixed like tables; Postgres index names are schema-local). */
  index(name: string): string;
  /** The schema this scope lives in (Postgres), null on SQLite. */
  readonly schema: string | null;
  readonly types: {
    /** Auto-increment integer primary key column type. */
    serialPk: string;
    bigint: string;
    text: string;
    blob: string;
    real: string;
    /** Booleans are stored as 0/1 integers on both backends (portable params and reads). */
    bool: string;
  };
  /**
   * `INSERT INTO <t> AS cur … ON CONFLICT (…) DO UPDATE SET …` (both backends): `cur.` is the existing row,
   * `excluded.` the proposed one (unqualified column names are ambiguous on Postgres).
   */
  upsert(table: string, cols: string[], conflict: string[], update: string[] | Record<string, string>): string;
  /** `INSERT … ON CONFLICT DO NOTHING`. */
  insertIgnore(table: string, cols: string[]): string;
  /** Row-lock suffix for a claim subquery: ` FOR UPDATE SKIP LOCKED` on Postgres, empty on SQLite (single writer). */
  readonly skipLocked: string;
  /** max of two scalars (`max(a, b)` / `GREATEST(a, b)`). */
  greatest(a: string, b: string): string;
  /** Text value of a top-level JSON key stored in a text column. */
  jsonText(col: string, key: string): string;
  /** Current time in epoch ms as a SQL expression. */
  readonly nowMs: string;
  /** Schema-qualified name of an extension object (Postgres: `"extensions".vector`), the bare name on SQLite. */
  ext(name: string): string;
  /** Schema-qualified operator (Postgres: `OPERATOR("extensions".<=>)`). */
  extOp(op: string): string;
}

export interface Queryable {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** One or more statements without parameters (DDL). */
  exec(sql: string): Promise<void>;
}

export interface TxOptions {
  /** Read-only transaction (Postgres `READ ONLY`, SQLite `query_only`). */
  readOnly?: boolean;
  /** Postgres `SET LOCAL statement_timeout` (ms) for this transaction only. */
  statementTimeoutMs?: number;
}

export interface Db extends Queryable {
  readonly driver: Driver;
  readonly caps: Capabilities;
  /** Run `fn` in one transaction (committed when it resolves, rolled back when it throws). Not reentrant. */
  tx<T>(fn: (q: Queryable) => Promise<T>, opts?: TxOptions): Promise<T>;
  /**
   * Exclusive lock on `key` for the duration of `fn`, across every server instance sharing the database.
   * Postgres: `pg_advisory_xact_lock` inside a transaction on a dedicated connection (transaction-scoped, so it works
   * behind transaction-mode poolers and is released if the connection drops); SQLite: an in-process keyed mutex.
   * Inside `fn`, use the given Queryable (on Postgres it is the lock's transaction).
   */
  withLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Like withLock but gives up immediately when another holder has the key. */
  tryWithLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** The same connection(s) scoped to another schema / table prefix (per-project index on Postgres). */
  scoped(scope: string): Db;
  close(): Promise<void>;
}
