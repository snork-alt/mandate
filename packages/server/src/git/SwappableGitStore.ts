/**
 * A GitStore whose backend can be replaced while the server runs (Settings → Git backend: embedded ↔ cli, or a new
 * git binary). Every call is pinned to the store that was current when it started, so in-flight reads finish on the
 * old store; `swap` switches new calls to the next store at once and then waits for the old one's calls to drain before
 * closing it. Writes are drained by the caller (the project's write lock is held around `swap`).
 */
import type { GitCommitInfo, GitStatus } from '@mandate/shared';
import type { CommitDiff, CommitOptions, FileCommit, GitStore } from './GitStore.js';

export class SwappableGitStore implements GitStore {
  private cur: GitStore;
  private readonly inflight = new Map<GitStore, number>();
  private readonly waiters = new Map<GitStore, (() => void)[]>();

  constructor(initial: GitStore) {
    this.cur = initial;
  }

  /** The store new calls go to. */
  get current(): GitStore {
    return this.cur;
  }

  get dir(): string {
    return this.cur.dir;
  }

  private async call<T>(fn: (g: GitStore) => Promise<T>): Promise<T> {
    const g = this.cur;
    this.inflight.set(g, (this.inflight.get(g) ?? 0) + 1);
    try {
      return await fn(g);
    } finally {
      const n = (this.inflight.get(g) ?? 1) - 1;
      if (n > 0) this.inflight.set(g, n);
      else {
        this.inflight.delete(g);
        for (const w of this.waiters.get(g)?.splice(0) ?? []) w();
      }
    }
  }

  /** Calls still running on `g`. */
  pending(g: GitStore): number {
    return this.inflight.get(g) ?? 0;
  }

  /** Resolves once no call runs on `g` (or after `timeoutMs`: false). */
  drain(g: GitStore, timeoutMs = 60_000): Promise<boolean> {
    if (!this.pending(g)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      t.unref?.();
      const list = this.waiters.get(g) ?? [];
      list.push(() => (clearTimeout(t), resolve(true)));
      this.waiters.set(g, list);
    });
  }

  /**
   * New calls go to `next` from now on; the old store is returned after its in-flight calls drained and it was closed
   * (a store still busy after `drainTimeoutMs` is closed when it finally drains).
   */
  async swap(next: GitStore, drainTimeoutMs = 60_000): Promise<GitStore> {
    const old = this.cur;
    if (old === next) return old;
    this.cur = next;
    const close = () => (old as { close?: () => void }).close?.();
    if (await this.drain(old, drainTimeoutMs)) close();
    else void this.drain(old, 24 * 3600_000).then(close);
    return old;
  }

  init() {
    return this.call((g) => g.init());
  }
  open() {
    return this.call((g) => g.open());
  }
  clone() {
    return this.call((g) => g.clone());
  }
  openOrCreate() {
    return this.call((g) => g.openOrCreate());
  }
  hasRemote() {
    return this.cur.hasRemote();
  }
  status(): Promise<GitStatus> {
    return this.call((g) => g.status());
  }
  commit(paths: string[], message: string, options?: CommitOptions) {
    return this.call((g) => g.commit(paths, message, options));
  }
  fetch() {
    return this.call((g) => g.fetch());
  }
  pull() {
    return this.call((g) => g.pull());
  }
  push() {
    return this.call((g) => g.push());
  }
  log(limit?: number): Promise<GitCommitInfo[]> {
    return this.call((g) => g.log(limit));
  }
  fileHistory(dirs: string[]): Promise<Map<string, FileCommit[]>> {
    return this.call((g) => g.fileHistory(dirs));
  }
  commitDiff(commit: string, dirs: string[]): Promise<CommitDiff> {
    return this.call((g) => g.commitDiff(commit, dirs));
  }
  resolveCommit(ref: string) {
    return this.call((g) => g.resolveCommit(ref));
  }
  readFileAt(commit: string, p: string) {
    return this.call((g) => g.readFileAt(commit, p));
  }
  readBlobAt(commit: string, p: string) {
    return this.call((g) => g.readBlobAt(commit, p));
  }
  head() {
    return this.call((g) => g.head());
  }
  firstParentChain(stopAt?: string | null) {
    return this.call((g) => g.firstParentChain(stopAt));
  }
  reachable(commit: string, hide: string | null) {
    return this.call((g) => g.reachable(commit, hide));
  }
  commitInfo(commit: string) {
    return this.call((g) => g.commitInfo(commit));
  }
  blobsAt(commit: string, dirs: string[], files?: string[]): Promise<Map<string, string>> {
    return this.call((g) => g.blobsAt(commit, dirs, files));
  }
}
