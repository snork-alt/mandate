import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The lock holds of the current async context. A hold is a token that is deactivated when its `run` settles, so work
 * detached inside a locked block (fire-and-forget promises) does not count as holding the lock afterwards.
 */
type Hold = { mutex: Mutex; active: boolean };
const held = new AsyncLocalStorage<readonly Hold[]>();

/** Run `fn` outside every lock hold of the current context (background work scheduled from inside a locked block). */
export const detached = <T>(fn: () => T): T => held.exit(fn);

/**
 * Serializes async operations (file writes + git commits share one working tree). Re-entrant: `run` called from inside
 * another `run` of the same lock (same async context, while that run is still in progress) runs immediately, so a
 * multi-document write (e.g. a work order plus the audit backlink) can hold the lock across all of its repository writes.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** True when the current async context holds this lock (inside a run that has not settled yet). */
  holds(): boolean {
    return held.getStore()?.some((h) => h.mutex === this && h.active) ?? false;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.holds()) return fn();
    return this.acquire(() => this.inside(fn));
  }

  /** Run `fn` marked as holding this lock (subclasses call it from their own acquire). */
  protected async inside<T>(fn: () => Promise<T>): Promise<T> {
    const hold: Hold = { mutex: this, active: true };
    try {
      return await held.run([...(held.getStore() ?? []), hold], fn);
    } finally {
      hold.active = false;
    }
  }

  /** Queue `fn` behind the current holder (in-process). */
  protected acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
