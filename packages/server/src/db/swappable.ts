/**
 * The server-state database behind a switch, so Settings → Database (SQLite ↔ Postgres, or a new URL) applies without
 * a restart. `swap` blocks new operations, waits for the in-flight ones (queries, transactions, held locks) to finish,
 * then points every caller at the new adapter. Work started inside an operation (a query inside `withLock` / `tx`)
 * stays on the adapter its operation started on and never waits for the swap, so a held lock cannot deadlock it.
 *
 * `scoped()` hands out a view of the CURRENT adapter (it does not follow later swaps): per-project index scopes are
 * rebuilt by reopening the projects after a swap.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Capabilities, Db, Dialect, Driver, Queryable, Row, RunResult, SqlValue, TxOptions } from './types.js';

export class DatabaseSwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseSwapError';
  }
}

export class SwappableDb implements Db {
  private cur: Db;
  private gate: Promise<void> | null = null;
  private active = 0;
  private idle: (() => void)[] = [];
  /** The adapter the current async context's operation runs on (nested calls stay there, ungated). */
  private readonly pinned = new AsyncLocalStorage<Db>();

  constructor(initial: Db) {
    this.cur = initial;
  }

  /** The adapter new operations use. */
  get current(): Db {
    return this.cur;
  }
  get driver(): Driver {
    return this.cur.driver;
  }
  get caps(): Capabilities {
    return this.cur.caps;
  }
  get dialect(): Dialect {
    return (this.pinned.getStore() ?? this.cur).dialect;
  }

  private async op<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const inner = this.pinned.getStore();
    if (inner) return fn(inner);
    const driver = this.cur.driver;
    let waited = false;
    while (this.gate) {
      waited = true;
      await this.gate;
    }
    // The caller built its SQL for the old dialect (table names, upserts): it cannot run on the other backend.
    if (waited && this.cur.driver !== driver) throw new DatabaseSwapError(`the database was switched from ${driver} to ${this.cur.driver} while this request waited; try again`);
    const db = this.cur;
    this.active++;
    try {
      return await this.pinned.run(db, () => fn(db));
    } finally {
      if (--this.active === 0) for (const f of this.idle.splice(0)) f();
    }
  }

  all<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.op((d) => d.all<T>(sql, params));
  }
  get<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
    return this.op((d) => d.get<T>(sql, params));
  }
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult> {
    return this.op((d) => d.run(sql, params));
  }
  exec(sql: string): Promise<void> {
    return this.op((d) => d.exec(sql));
  }
  tx<T>(fn: (q: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    return this.op((d) => d.tx(fn, opts));
  }
  withLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.op((d) => d.withLock(key, fn));
  }
  tryWithLock<T>(key: string, fn: (q: Queryable) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    return this.op((d) => d.tryWithLock(key, fn));
  }
  scoped(scope: string): Db {
    return this.cur.scoped(scope);
  }

  /** Operations running now (tests). */
  get inFlight(): number {
    return this.active;
  }

  /**
   * Switch to `next`: new operations wait while the in-flight ones drain (at most `drainTimeoutMs`; then nothing
   * changes and DatabaseSwapError is thrown). Returns the old adapter, still open: the caller closes it.
   */
  async swap(next: Db, drainTimeoutMs = 15_000): Promise<Db> {
    if (this.pinned.getStore()) throw new DatabaseSwapError('cannot switch the database from inside a database operation');
    while (this.gate) await this.gate;
    let release!: () => void;
    this.gate = new Promise((r) => (release = r));
    try {
      if (this.active > 0) {
        const drained = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), drainTimeoutMs);
          this.idle.push(() => (clearTimeout(t), resolve(true)));
        });
        if (!drained) throw new DatabaseSwapError(`the database stayed busy for ${Math.round(drainTimeoutMs / 1000)} s (a long write or lock); try again`);
      }
      const old = this.cur;
      this.cur = next;
      return old;
    } finally {
      this.gate = null;
      release();
    }
  }

  close(): Promise<void> {
    return this.cur.close();
  }
}

/** The concrete adapter behind a (possibly) swappable one. */
export const unwrapDb = <T extends Db>(db: T | SwappableDb): T => (db instanceof SwappableDb ? (db.current as T) : db);
