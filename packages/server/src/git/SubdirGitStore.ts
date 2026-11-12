/**
 * A project stored in a folder of a larger repository (several projects may share one GitHub repo): every path
 * the storage layer passes is relative to the folder; this wrapper prefixes it for the underlying repo-level store
 * and strips the prefix from results. Commits are repo-wide (history and activity of the folder's files are
 * folder-scoped through the path filters; other projects' commits show up only as plain `commit` events).
 */
import type { GitCommitInfo, GitStatus } from '@mandate/shared';
import path from 'node:path';
import type { CommitDiff, CommitOptions, FileCommit, GitStore } from './GitStore.js';

export class SubdirGitStore implements GitStore {
  readonly dir: string;
  private readonly prefix: string;

  constructor(
    readonly inner: GitStore,
    subdir: string,
  ) {
    this.prefix = subdir.replace(/^\/+|\/+$/g, '');
    this.dir = path.join(inner.dir, this.prefix);
  }

  private in = (p: string) => (p ? `${this.prefix}/${p}` : this.prefix);
  private out = (p: string) => (p.startsWith(`${this.prefix}/`) ? p.slice(this.prefix.length + 1) : p);
  private outMap<V>(m: Map<string, V>): Map<string, V> {
    const r = new Map<string, V>();
    for (const [k, v] of m) if (k.startsWith(`${this.prefix}/`)) r.set(this.out(k), v);
    return r;
  }

  init() {
    return this.inner.init();
  }
  open() {
    return this.inner.open();
  }
  clone() {
    return this.inner.clone();
  }
  openOrCreate() {
    return this.inner.openOrCreate();
  }
  hasRemote() {
    return this.inner.hasRemote();
  }
  status(): Promise<GitStatus> {
    return this.inner.status();
  }
  commit(paths: string[], message: string, options?: CommitOptions) {
    return this.inner.commit(paths.map(this.in), message, options);
  }
  fetch() {
    return this.inner.fetch();
  }
  pull() {
    return this.inner.pull();
  }
  push() {
    return this.inner.push();
  }
  log(limit?: number): Promise<GitCommitInfo[]> {
    return this.inner.log(limit);
  }
  async fileHistory(dirs: string[]): Promise<Map<string, FileCommit[]>> {
    return this.outMap(await this.inner.fileHistory(dirs.map(this.in)));
  }
  async commitDiff(commit: string, dirs: string[]): Promise<CommitDiff> {
    const d = await this.inner.commitDiff(commit, dirs.map(this.in));
    return { ...d, files: d.files.map((f) => ({ ...f, path: this.out(f.path) })) };
  }
  resolveCommit(ref: string) {
    return this.inner.resolveCommit(ref);
  }
  readFileAt(commit: string, p: string) {
    return this.inner.readFileAt(commit, this.in(p));
  }
  head() {
    return this.inner.head();
  }
  firstParentChain(stopAt?: string | null) {
    return this.inner.firstParentChain(stopAt);
  }
  reachable(commit: string, hide: string | null) {
    return this.inner.reachable(commit, hide);
  }
  commitInfo(commit: string) {
    return this.inner.commitInfo(commit);
  }
  async blobsAt(commit: string, dirs: string[], files: string[] = []): Promise<Map<string, string>> {
    return this.outMap(await this.inner.blobsAt(commit, dirs.map(this.in), files.map(this.in)));
  }
}
