/**
 * Per-project write lock (every git write of a project: file changes + commit share one working tree).
 * SQLite / single instance: the in-process Mutex, as before. Postgres: the same in-process queue, then a
 * transaction-scoped advisory lock (`pg_advisory_xact_lock`, key `mandate:project:<id>:write`) held for the whole
 * write, so two server instances sharing one data repository (shared storage) never write it concurrently.
 * Transaction-scoped: works behind transaction-mode poolers and is released if the instance dies mid-write.
 */
import { Mutex } from '../storage/Mutex.js';
import type { Db } from './types.js';

export const projectLockKey = (projectId: string) => `project:${projectId}:write`;

export class ProjectWriteLock extends Mutex {
  constructor(
    private readonly db: Db,
    readonly projectId: string,
  ) {
    super();
  }

  /**
   * Re-entrant like Mutex (a nested `run` in the same async context does not take the database lock again). Queued
   * in-process first, then the database's lock on the project key (SQLite: a keyed in-process mutex; Postgres: the
   * advisory lock). The database is looked up per acquisition, so one switched at runtime (SQLite ↔ Postgres) changes
   * the lock without reopening the project, and writers queued across the switch stay serialized in-process.
   */
  protected override acquire<T>(fn: () => Promise<T>): Promise<T> {
    return super.acquire(() => this.db.withLock(projectLockKey(this.projectId), () => fn()));
  }
}

/** The write lock for a project: in-process plus the database's lock on the project key (advisory on Postgres). */
export function projectWriteLock(db: Db | undefined, projectId: string): Mutex {
  return db ? new ProjectWriteLock(db, projectId) : new Mutex();
}
