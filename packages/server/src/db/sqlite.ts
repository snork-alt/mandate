/**
 * SQLite driver (better-sqlite3). Synchronous underneath, exposed through the async Db interface: a call outside a
 * transaction runs immediately (no queueing, statements cached per SQL text), so the cost over raw better-sqlite3 is
 * one resolved promise. A transaction holds a gate that queues other callers until it commits, because an async
 * transaction body could otherwise interleave statements of unrelated callers on the one connection.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { makeDialect } from './dialect.js';
import { normalizeParams } from './sql.js';
import type { Capabilities, Db, Dialect, Queryable, RunResult, SqlValue, TxOptions } from './types.js';

type Stmt = Database.Statement<unknown[]>;

export interface SqliteOptions {
  /** Load sqlite-vec (the index needs it; server state does not). */
  vec?: boolean;
}

/** In-process keyed mutex (the SQLite "advisory lock"). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
  held(key: string): boolean {
    return this.tails.has(key);
  }
}

class Core {
  readonly stmts = new Map<string, Stmt>();
  /** Set while a transaction holds the connection; other callers wait on it. */
  gate: Promise<void> | null = null;
  readonly locks = new KeyedMutex();
  constructor(readonly handle: Database.Database) {}

  stmt(sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.handle.prepare(sql);
      if (this.stmts.size > 2000) this.stmts.clear();
      this.stmts.set(sql, s);
    }
    return s;
  }
}

/** Direct (ungated) statement execution: used inside a transaction and by the fast path. */
class Direct implements Queryable {
  constructor(
    readonly core: Core,
    readonly dialect: Dialect,
  ) {}
  allSync<T>(sql: string, params?: readonly SqlValue[]): T[] {
    const s = this.core.stmt(sql);
    const p = normalizeParams(params);
    if (s.reader) return s.all(...p) as T[];
    s.run(...p);
    return [];
  }
  async all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.allSync<T>(sql, params);
  }
  async get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
    const s = this.core.stmt(sql);
    const p = normalizeParams(params);
    if (s.reader) return s.get(...p) as T | undefined;
    s.run(...p);
    return undefined;
  }
  async run(sql: string, params?: readonly SqlValue[]): Promise<RunResult> {
    const s = this.core.stmt(sql);
    const p = normalizeParams(params);
    if (s.reader) return { changes: s.all(...p).length };
    return { changes: s.run(...p).changes };
  }
  async exec(sql: string): Promise<void> {
    this.core.handle.exec(sql);
  }
}

export class SqliteDb implements Db {
  readonly driver = 'sqlite' as const;
  readonly caps: Capabilities = { skipLocked: false, sharedLocks: false, multiInstance: false, singleSession: true, vector: false, trigram: true };
  readonly dialect: Dialect;
  private readonly direct: Direct;

  private constructor(
    private readonly core: Core,
    prefix = '',
    private readonly owned = true,
  ) {
    this.dialect = makeDialect('sqlite', { prefix });
    this.direct = new Direct(core, this.dialect);
  }

  /** Open (creating) a database file; `:memory:` for tests. */
  static open(file: string, opts: SqliteOptions = {}): SqliteDb {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const handle = new Database(file);
    handle.pragma('journal_mode = WAL');
    handle.pragma('busy_timeout = 5000');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('foreign_keys = ON');
    const db = new SqliteDb(new Core(handle));
    if (opts.vec) db.loadVec();
    return db;
  }

  /** Wrap an already open better-sqlite3 handle (the index database); closing the wrapper leaves it open. */
  static wrap(handle: Database.Database): SqliteDb {
    return new SqliteDb(new Core(handle), '', false);
  }

  /** The underlying handle (SQLite-only fast paths such as the synchronous indexer). */
  get handle(): Database.Database {
    return this.core.handle;
  }

  private loadVec() {
    sqliteVec.load(this.core.handle);
    (this.caps as { vector: boolean }).vector = true;
  }

  private async gated<T>(fn: (d: Direct) => Promise<T>): Promise<T> {
    while (this.core.gate) await this.core.gate;
    return fn(this.direct);
  }

  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    if (!this.core.gate) return Promise.resolve(this.direct.allSync<T>(sql, params));
    return this.gated((d) => d.all<T>(sql, params));
  }
  get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
    if (!this.core.gate) return this.direct.get<T>(sql, params);
    return this.gated((d) => d.get<T>(sql, params));
  }
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult> {
    if (!this.core.gate) return this.direct.run(sql, params);
    return this.gated((d) => d.run(sql, params));
  }
  exec(sql: string): Promise<void> {
    if (!this.core.gate) return this.direct.exec(sql);
    return this.gated((d) => d.exec(sql));
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    while (this.core.gate) await this.core.gate;
    let open!: () => void;
    this.core.gate = new Promise<void>((r) => (open = r));
    const h = this.core.handle;
    try {
      if (opts.readOnly) h.pragma('query_only = ON');
      h.exec(opts.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const v = await fn(this.direct);
        h.exec('COMMIT');
        return v;
      } catch (e) {
        if (h.inTransaction) h.exec('ROLLBACK');
        throw e;
      }
    } finally {
      if (opts.readOnly) h.pragma('query_only = OFF');
      this.core.gate = null;
      open();
    }
  }

  withLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.core.locks.run(key, () => fn(this));
  }

  async tryWithLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.core.locks.held(key)) return { acquired: false };
    return { acquired: true, value: await this.withLock(key, fn) };
  }

  scoped(scope: string): Db {
    return new SqliteDb(this.core, `${scope}__`, false);
  }

  async close(): Promise<void> {
    if (this.owned && this.core.handle.open) this.core.handle.close();
  }
}
