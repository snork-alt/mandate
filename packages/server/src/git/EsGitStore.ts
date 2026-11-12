import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  cloneRepository,
  initRepository,
  openRepository,
  type Credential,
  type Repository,
  type SignaturePayload,
  type Status,
} from 'es-git';
import type { GitCommitInfo, GitFileStatus, GitStatus } from '@mandate/shared';
import type { RemoteAuth, RemoteConfig } from '../config.js';
import type { CommitDiff, CommitOptions, FileCommit, GitStore } from './GitStore.js';

export interface EsGitStoreOptions {
  dir: string;
  /** Local branch name used for new repositories. */
  branch?: string;
  remote?: RemoteConfig;
  author: { name: string; email: string };
}

const REMOTE_NAME = 'origin';

/** Map our config auth to an es-git (libgit2) credential. */
export function toCredential(auth: RemoteAuth | undefined): Credential | undefined {
  if (!auth) return undefined;
  switch (auth.type) {
    case 'ssh':
      return {
        type: 'SSHKeyFromPath',
        username: auth.username,
        privateKeyPath: auth.privateKeyPath,
        publicKeyPath: auth.publicKeyPath,
        passphrase: auth.passphrase,
      };
    case 'ssh-agent':
      return { type: 'SSHKeyFromAgent', username: auth.username };
    case 'https':
      return { type: 'Plain', username: auth.username, password: auth.token };
  }
}

/** GitStore backed by `es-git` (napi bindings to libgit2 / git2-rs). */
export class EsGitStore implements GitStore {
  readonly dir: string;
  private readonly branch: string;
  private readonly remote?: RemoteConfig;
  private readonly author: { name: string; email: string };
  private repo?: Repository;

  constructor(opts: EsGitStoreOptions) {
    this.dir = path.resolve(opts.dir);
    this.branch = opts.remote?.branch ?? opts.branch ?? 'main';
    this.remote = opts.remote;
    this.author = opts.author;
  }

  private get r(): Repository {
    if (!this.repo) throw new Error('Git repository is not open');
    return this.repo;
  }

  private get credential(): Credential | undefined {
    return toCredential(this.remote?.auth);
  }

  private signature(date?: Date, who = this.author): SignaturePayload {
    return {
      name: who.name,
      email: who.email,
      ...(date ? { timeOptions: { timestamp: Math.floor(date.getTime() / 1000), offset: 0 } } : {}),
    };
  }

  private historyCache?: { key: string; map: Map<string, FileCommit[]> };

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.repo = await initRepository(this.dir, { initialHead: this.branch });
    if (this.remote) this.repo.createRemote(REMOTE_NAME, this.remote.url);
  }

  async open(): Promise<void> {
    this.repo = await openRepository(this.dir);
    if (this.remote && !this.repo.findRemote(REMOTE_NAME)) {
      this.repo.createRemote(REMOTE_NAME, this.remote.url);
    }
  }

  async clone(): Promise<void> {
    if (!this.remote) throw new Error('No remote configured');
    await mkdir(path.dirname(this.dir), { recursive: true });
    this.repo = await cloneRepository(this.remote.url, this.dir, {
      fetch: { credential: this.credential },
    });
    // Cloning an empty remote leaves HEAD on libgit2's default (`master`);
    // point it at the configured branch instead.
    if (!this.headOid()) this.repo.setHead(`refs/heads/${this.branch}`);
  }

  async openOrCreate(): Promise<void> {
    if (existsSync(path.join(this.dir, '.git'))) return this.open();
    if (this.remote) return this.clone();
    return this.init();
  }

  hasRemote(): boolean {
    return !!this.remote;
  }

  /** Current HEAD commit id, or null when the branch is unborn. */
  private headOid(): string | null {
    try {
      return this.r.head().target();
    } catch {
      return null;
    }
  }

  private currentBranch(): string | null {
    const head = this.r.findReference('HEAD');
    const target = head?.symbolicTarget();
    return target ? target.replace(/^refs\/heads\//, '') : null;
  }

  async status(): Promise<GitStatus> {
    const files: GitFileStatus[] = [];
    const statuses = this.r.statuses();
    const count = Number(statuses.len());
    for (let i = 0; i < count; i++) {
      const entry = statuses.get(i);
      if (!entry) continue;
      const s = entry.status();
      if (s.ignored) continue;
      files.push({ path: entry.path(), status: describeStatus(s) });
    }
    return {
      branch: this.currentBranch(),
      head: this.headOid(),
      clean: files.length === 0,
      files,
      remote: this.remote?.url ?? null,
    };
  }

  async commit(paths: string[], message: string, options: CommitOptions = {}): Promise<string | null> {
    const repo = this.r;
    const index = repo.index();
    // libgit2 caches the index in memory: reload it so external changes (reset --hard, outside commits,
    // `git add`) are seen and a stale index is never re-committed. HEAD is resolved fresh below.
    index.read(true);
    for (const p of paths) {
      if (existsSync(path.join(this.dir, p))) index.addPath(p);
      else if (index.getByPath(p)) index.removePath(p);
    }
    index.write();
    const treeId = index.writeTree();
    const parent = this.headOid();
    if (parent && repo.getCommit(parent).treeId() === treeId) return null;
    return repo.commit(repo.getTree(treeId), message, {
      updateRef: 'HEAD',
      author: this.signature(options.date, options.author),
      committer: this.signature(options.date, options.author),
      parents: parent ? [parent] : [],
    });
  }

  async fetch(): Promise<void> {
    if (!this.remote) return;
    const remote = this.r.getRemote(REMOTE_NAME);
    await remote.fetch([], { fetch: { credential: this.credential } });
  }

  async pull(): Promise<boolean> {
    if (!this.remote) return false;
    await this.fetch();
    const repo = this.r;
    const branch = this.currentBranch() ?? this.branch;
    const remoteRef = repo.findReference(`refs/remotes/${REMOTE_NAME}/${branch}`);
    const theirOid = remoteRef?.target();
    if (!theirOid) return false; // remote branch does not exist yet
    const theirCommit = repo.getCommit(theirOid);
    const ourOid = this.headOid();

    if (!ourOid) {
      // Unborn local branch: point it at the remote commit and check out.
      repo.createBranch(branch, theirCommit, { force: true });
      repo.setHead(`refs/heads/${branch}`);
      repo.checkoutHead({ force: true });
      return true;
    }
    if (ourOid === theirOid) return false;

    const annotated = repo.getAnnotatedCommit(theirCommit);
    const { analysis } = repo.analyzeMerge([annotated]);
    if (analysis.upToDate) return false;

    if (analysis.fastForward) {
      // libgit2 refuses to force-update the checked-out branch, so detach first.
      repo.checkoutTree(theirCommit.asObject(), { safe: true });
      repo.setHeadDetached(theirCommit);
      repo.createBranch(branch, theirCommit, { force: true });
      repo.setHead(`refs/heads/${branch}`);
      return true;
    }

    // True merge.
    repo.merge([annotated], undefined, { safe: true });
    const index = repo.index();
    if (index.hasConflicts()) {
      repo.cleanupState();
      repo.checkoutHead({ force: true });
      throw new Error('Merge conflict while pulling; resolve manually in ' + this.dir);
    }
    const tree = repo.getTree(index.writeTree());
    repo.commit(tree, `Merge ${REMOTE_NAME}/${branch}`, {
      updateRef: 'HEAD',
      author: this.signature(),
      committer: this.signature(),
      parents: [ourOid, theirOid],
    });
    repo.cleanupState();
    return true;
  }

  async push(): Promise<void> {
    if (!this.remote) return;
    if (!this.headOid()) return; // nothing to push yet
    const branch = this.currentBranch() ?? this.branch;
    const rejections: string[] = [];
    const remote = this.r.getRemote(REMOTE_NAME);
    await remote.push([`refs/heads/${branch}:refs/heads/${branch}`], {
      credential: this.credential,
      callbacks: {
        pushUpdateReference: (ref, status) => {
          if (status) rejections.push(`${ref}: ${status}`);
        },
      },
    });
    if (rejections.length) throw new Error(`Push rejected: ${rejections.join(', ')}`);
  }

  async log(limit = 50): Promise<GitCommitInfo[]> {
    if (!this.headOid()) return [];
    const walk = this.r.revwalk().pushHead();
    const out: GitCommitInfo[] = [];
    for (let oid = walk.next(); oid && out.length < limit; oid = walk.next()) {
      const c = this.r.getCommit(oid);
      const a = c.author();
      out.push({
        id: c.id(),
        message: c.message().trim(),
        author: `${a.name} <${a.email}>`,
        date: c.time().toISOString(),
      });
    }
    return out;
  }

  async commitDiff(ref: string, dirs: string[]): Promise<CommitDiff> {
    const commit = await this.resolveCommit(ref);
    if (!commit) throw new Error(`unknown commit '${ref}'`);
    // First parent = the next commit of a first-parent walk starting at the commit.
    const walk = this.r.revwalk().push(commit).simplifyFirstParent();
    walk.next();
    const parent = walk.next() ?? null;
    const after = snapshot(this.r, this.r.getCommit(commit).treeId(), dirs);
    const before = parent ? snapshot(this.r, this.r.getCommit(parent).treeId(), dirs) : new Map<string, string>();
    const files: CommitDiff['files'] = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(p);
      const a = after.get(p);
      if (b === a) continue;
      files.push({ path: p, status: !b ? 'added' : !a ? 'deleted' : 'modified', ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) });
    }
    return { commit, parent, files: files.sort((x, y) => x.path.localeCompare(y.path)) };
  }

  async resolveCommit(ref: string): Promise<string | null> {
    if (!/^[\w./~^-]+$/.test(ref)) return null;
    try {
      const oid = this.r.revparseSingle(ref);
      return this.r.findCommit(oid)?.id() ?? null;
    } catch {
      return null;
    }
  }

  async readFileAt(commit: string, file: string): Promise<string | null> {
    const id = await this.resolveCommit(commit);
    if (!id) throw new Error(`unknown commit '${commit}'`);
    const entry = this.r.getCommit(id).tree().getPath(file);
    if (!entry) return null;
    try {
      return Buffer.from(entry.toObject(this.r).peelToBlob().content()).toString('utf8');
    } catch {
      return null; // a directory, not a file
    }
  }

  async head(): Promise<string | null> {
    return this.headOid();
  }

  async firstParentChain(stopAt?: string | null): Promise<{ commits: string[]; reachedStop: boolean }> {
    const commits: string[] = [];
    if (!this.headOid()) return { commits, reachedStop: !stopAt };
    const walk = this.r.revwalk().pushHead().simplifyFirstParent();
    for (let oid = walk.next(); oid; oid = walk.next()) {
      if (oid === stopAt) return { commits, reachedStop: true };
      commits.push(oid);
    }
    return { commits, reachedStop: !stopAt };
  }

  async reachable(commit: string, hide: string | null): Promise<string[]> {
    const walk = this.r.revwalk().push(commit);
    if (hide) walk.hide(hide);
    const out: string[] = [];
    for (let oid = walk.next(); oid; oid = walk.next()) out.push(oid);
    return out;
  }

  async commitInfo(commit: string): Promise<FileCommit> {
    const c = this.r.getCommit(commit);
    const a = c.author();
    return { id: c.id(), message: c.message(), authorName: a.name, authorEmail: a.email, date: c.time().toISOString() };
  }

  async blobsAt(commit: string, dirs: string[], files: string[] = []): Promise<Map<string, string>> {
    const c = this.r.getCommit(commit);
    const out = snapshot(this.r, c.treeId(), dirs);
    const root = c.tree();
    for (const f of files) {
      const e = root.getPath(f);
      if (e) out.set(f, e.id());
    }
    return out;
  }

  async fileHistory(dirs: string[]): Promise<Map<string, FileCommit[]>> {
    const head = this.headOid();
    const key = `${head}|${dirs.join(',')}`;
    if (this.historyCache?.key === key) return this.historyCache.map;
    const map = new Map<string, FileCommit[]>();
    if (head) {
      const walk = this.r.revwalk().pushHead().simplifyFirstParent();
      let prev: { info: FileCommit; snap: Map<string, string> } | null = null;
      const attribute = (info: FileCommit, now: Map<string, string>, parent: Map<string, string>) => {
        for (const p of new Set([...now.keys(), ...parent.keys()])) {
          if (now.get(p) !== parent.get(p)) {
            const list = map.get(p) ?? [];
            list.push(info);
            map.set(p, list);
          }
        }
      };
      for (let oid = walk.next(); oid; oid = walk.next()) {
        const c = this.r.getCommit(oid);
        const a = c.author();
        const info: FileCommit = { id: c.id(), message: c.message(), authorName: a.name, authorEmail: a.email, date: c.time().toISOString() };
        const snap = snapshot(this.r, c.treeId(), dirs);
        // Walk is child -> first parent, so the previous commit is this one's child.
        if (prev) attribute(prev.info, prev.snap, snap);
        prev = { info, snap };
      }
      if (prev) attribute(prev.info, prev.snap, new Map());
    }
    this.historyCache = { key, map };
    return map;
  }
}

/** Blob id of every file directly inside `dirs` at the given tree. */
function snapshot(repo: Repository, treeId: string, dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const root = repo.getTree(treeId);
  for (const dir of dirs) {
    const entry = root.getPath(dir);
    if (!entry) continue;
    let sub;
    try {
      sub = repo.getTree(entry.id());
    } catch {
      continue; // not a directory
    }
    const it = sub.iter();
    for (let r = it.next(); !r.done; r = it.next()) out.set(`${dir}/${r.value.name()}`, r.value.id());
  }
  return out;
}

function describeStatus(s: Status): string {
  if (s.conflicted) return 'conflicted';
  if (s.wtNew || s.indexNew) return 'new';
  if (s.wtDeleted || s.indexDeleted) return 'deleted';
  if (s.wtRenamed || s.indexRenamed) return 'renamed';
  if (s.wtModified || s.indexModified || s.wtTypechange || s.indexTypechange) return 'modified';
  return 'unknown';
}
