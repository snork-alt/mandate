import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitCommitInfo, GitFileStatus, GitStatus } from '@mandate/shared';
import type { RemoteConfig } from '../config.js';
import { CatFile } from './cli/CatFile.js';
import { checkGitCli, GitCliError, redact, runGit, type RunResult } from './cli/exec.js';
import type { EsGitStoreOptions } from './EsGitStore.js';
import type { CommitDiff, CommitOptions, FileCommit, GitStore } from './GitStore.js';
import { commitAuthor, type Identity } from './author.js';
import { onAuthFailure, resolveRemoteAuth, scrubbed } from './remote-auth.js';

export interface CliGitStoreOptions extends EsGitStoreOptions {
  /** git binary (default `git` on PATH). */
  gitPath?: string;
  /** Extra environment for every git process (config `git.cliEnv`). */
  env?: Record<string, string>;
  /** Timeout of local git commands (default 60 s). */
  timeoutMs?: number;
  /** Timeout of clone / fetch / pull / push (default 10 min). */
  networkTimeoutMs?: number;
}

const REMOTE_NAME = 'origin';
const MB = 1024 * 1024;

/**
 * Environment variables inherited from the server process that would redirect git to another repository,
 * index or identity, or change how paths and history are interpreted. They are removed before running git.
 */
const STRIPPED_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|AUTHOR_\w+|COMMITTER_\w+|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|GRAFT_FILE|REPLACE_REF_BASE|SHALLOW_FILE|QUARANTINE_PATH|\w*PATHSPECS|REFLOG_ACTION|EDITOR|SEQUENCE_EDITOR|PAGER|EXTERNAL_DIFF|DIFF_OPTS|NO_REPLACE_OBJECTS|OPTIONAL_LOCKS|TERMINAL_PROMPT|FLUSH)$/;

/**
 * `-c` overrides for every command: no hooks, no fsmonitor daemon, no ext:: transport, no signing
 * prompts, no pagers/colors, and no rerere auto-resolution (merges must behave like the embedded backend).
 */
const BASE_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.quotePath=false',
  'protocol.ext.allow=never',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'rerere.enabled=false',
  'color.ui=false',
  'advice.detachedHead=false',
  'i18n.commitEncoding=UTF-8',
].flatMap((kv) => ['-c', kv]);

/** Inline credential helper: answers `get` from env vars, so the token never appears in argv, URLs or config. */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; printf "username=%s\\npassword=%s\\n" "$MANDATE_GIT_CRED_USERNAME" "$MANDATE_GIT_CRED_TOKEN"; }; f';

/** POSIX shell single-quoting (GIT_SSH_COMMAND is run through a shell by git). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

interface CommitObject {
  id: string;
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  /** Committer time (what libgit2's `commit.time()` returns). */
  date: string;
}

/** Simple async mutex: serializes commit / pull / push inside this store. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * GitStore backed by the system `git` binary (>= 2.30). Same semantics as EsGitStore; reads go through a
 * persistent `git cat-file --batch` process and plumbing commands with machine-readable output.
 * Every command runs with an argument array (no shell), `cwd` = the repository, a timeout and bounded output.
 */
export class CliGitStore implements GitStore {
  readonly dir: string;
  private readonly branch: string;
  private readonly remote?: RemoteConfig;
  private readonly author: { name: string; email: string };
  private readonly bin: string;
  private readonly extraEnv: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly networkTimeoutMs: number;
  private readonly lock = new Lock();
  private opened = false;
  private hashBytes = 20;
  private catFile?: CatFile;
  private readonly trees = new Map<string, TreeEntry[]>();
  private readonly commits = new Map<string, CommitObject>();
  private historyCache?: { key: string; map: Map<string, FileCommit[]> };
  private warnedPassphrase = false;

  constructor(opts: CliGitStoreOptions) {
    this.dir = path.resolve(opts.dir);
    this.branch = opts.remote?.branch ?? opts.branch ?? 'main';
    this.remote = opts.remote;
    this.author = opts.author;
    this.bin = opts.gitPath ?? 'git';
    this.extraEnv = opts.env ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.networkTimeoutMs = opts.networkTimeoutMs ?? 600_000;
  }

  /* ------------------------------------------------------------------ process plumbing */

  private env(read: boolean, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!STRIPPED_ENV.test(k)) env[k] = v;
    Object.assign(env, this.extraEnv, extra, {
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      GIT_PAGER: 'cat',
      // Never discover a repository above `dir` (e.g. when the data dir is not a repo yet).
      GIT_CEILING_DIRECTORIES: ceiling(this.dir),
      GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    });
    if (read) env.GIT_OPTIONAL_LOCKS = '0';
    return env;
  }

  private async git(
    args: string[],
    o: {
      read?: boolean;
      input?: string;
      okCodes?: number[];
      cwd?: string;
      config?: string[];
      env?: Record<string, string>;
      network?: boolean;
      secrets?: (string | undefined)[];
      maxBuffer?: number;
      onRecord?: (r: string) => boolean | void;
      separator?: string;
    } = {},
  ): Promise<RunResult> {
    await checkGitCli(this.bin, this.env(true));
    return runGit(this.bin, [...BASE_CONFIG, ...(o.config ?? []), ...args], {
      cwd: o.cwd ?? this.dir,
      env: this.env(!!o.read, o.env),
      input: o.input,
      okCodes: o.okCodes,
      timeoutMs: o.network ? this.networkTimeoutMs : this.timeoutMs,
      maxBuffer: o.maxBuffer ?? 64 * MB,
      secrets: o.secrets,
      onRecord: o.onRecord,
      separator: o.separator,
    });
  }

  private async out(args: string[], o: Parameters<CliGitStore['git']>[1] = {}): Promise<string> {
    return (await this.git(args, { read: true, ...o })).stdout.toString('utf8');
  }

  /**
   * `-c`/env for network commands: SSH key, HTTPS token or GitHub App installation token (minted / cached just before),
   * else the user's own git setup. Tokens reach git only through the credential helper below, which reads them from
   * the child's environment: never argv, the remote URL, config files or logs.
   */
  private async networkOpts(): Promise<{ config: string[]; env: Record<string, string>; secrets: (string | undefined)[]; network: true }> {
    const auth = await resolveRemoteAuth(this.remote?.auth);
    const config: string[] = [];
    const env: Record<string, string> = {};
    const secrets: (string | undefined)[] = [];
    if (auth?.type === 'ssh') {
      if (auth.passphrase && !this.warnedPassphrase) {
        this.warnedPassphrase = true;
        console.warn('mandate: git backend "cli" cannot pass an SSH key passphrase; add the key to ssh-agent (ssh-add) instead.');
      }
      const ssh = ['ssh', '-i', shellQuote(auth.privateKeyPath), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
      if (auth.username) ssh.push('-o', shellQuote(`User=${auth.username}`));
      env.GIT_SSH_COMMAND = ssh.join(' ');
      secrets.push(auth.passphrase);
    } else if (auth?.type === 'https') {
      if (/[\r\n\0]/.test(auth.username) || /[\r\n\0]/.test(auth.token)) throw new Error('git credentials must not contain newlines');
      config.push('-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`);
      env.MANDATE_GIT_CRED_USERNAME = auth.username;
      env.MANDATE_GIT_CRED_TOKEN = auth.token;
      secrets.push(auth.token);
    }
    // ssh-agent / no auth: defer to the user's ssh config, agent and credential helpers.
    return { config, env, secrets, network: true };
  }

  /** A network command: a rejected App token is dropped from the cache; secrets never survive in the error. */
  private async net<T>(secrets: (string | undefined)[], fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      onAuthFailure(this.remote?.auth, e);
      throw scrubbed(e, secrets);
    }
  }

  private objects(): CatFile {
    if (!this.catFile) {
      this.catFile = new CatFile(this.bin, BASE_CONFIG, this.dir, () => this.env(true), this.timeoutMs);
    }
    return this.catFile;
  }

  private async afterOpen(): Promise<void> {
    const fmt = (await this.out(['rev-parse', '--show-object-format'])).trim();
    this.hashBytes = fmt === 'sha256' ? 32 : 20;
    this.opened = true;
  }

  private ensureOpen(): void {
    if (!this.opened) throw new Error('Git repository is not open');
  }

  /* ------------------------------------------------------------------ object access */

  private async readObject(oid: string) {
    this.ensureOpen();
    return this.objects().read(oid);
  }

  private async commitObject(oid: string): Promise<CommitObject> {
    const cached = this.commits.get(oid);
    if (cached) return cached;
    const obj = await this.readObject(oid);
    if (!obj || obj.type !== 'commit') throw new Error(`object not found - no match for id (${oid})`);
    const c = parseCommit(oid, obj.content);
    if (this.commits.size > 20_000) this.commits.clear();
    this.commits.set(oid, c);
    return c;
  }

  private async tree(oid: string): Promise<TreeEntry[] | null> {
    const cached = this.trees.get(oid);
    if (cached) return cached;
    const obj = await this.readObject(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.content, this.hashBytes);
    if (this.trees.size > 20_000) this.trees.clear();
    this.trees.set(oid, entries);
    return entries;
  }

  /** Tree entry at a slash-separated path (libgit2 `tree.getPath`). */
  private async entryAt(treeOid: string, file: string): Promise<TreeEntry | null> {
    const parts = file.split('/');
    if (parts.some((p) => p === '')) return null;
    let tree = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const entries = await this.tree(tree);
      const e = entries?.find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (!isTree(e.mode)) return null;
      tree = e.oid;
    }
    return null;
  }

  /** Blob id of every entry directly inside `dirs` (same as EsGitStore's `snapshot`). */
  private async snapshot(treeOid: string, dirs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const dir of dirs) {
      const entry = await this.entryAt(treeOid, dir);
      if (!entry || !isTree(entry.mode)) continue;
      const sub = await this.tree(entry.oid);
      if (!sub) continue;
      for (const e of sub) out.set(`${dir}/${e.name}`, e.oid);
    }
    return out;
  }

  private toFileCommit(c: CommitObject): FileCommit {
    return { id: c.id, message: c.message, authorName: c.authorName, authorEmail: c.authorEmail, date: c.date };
  }

  /** Commit ids printed by `git rev-list` (streamed; `stop` ends the walk early). */
  private async revList(args: string[], stop?: (oid: string) => boolean): Promise<string[]> {
    const out: string[] = [];
    await this.git(['rev-list', ...args], {
      read: true,
      onRecord: (line) => {
        if (!line) return;
        if (stop?.(line)) return false;
        out.push(line);
      },
    });
    return out;
  }

  /* ------------------------------------------------------------------ lifecycle */

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.git(['init', '--quiet', `--initial-branch=${this.branch}`]);
    if (this.remote) await this.git(['remote', 'add', '--', REMOTE_NAME, this.remote.url]);
    await this.afterOpen();
  }

  async open(): Promise<void> {
    let top: string;
    try {
      top = (await this.out(['rev-parse', '--show-toplevel'])).trim();
    } catch (e) {
      throw new Error(`Not a git repository: ${this.dir} (${(e as Error).message})`);
    }
    if (realpath(top) !== realpath(this.dir)) throw new Error(`Not a git repository: ${this.dir} (inside ${top})`);
    if (this.remote) {
      const { code } = await this.git(['config', '--get', `remote.${REMOTE_NAME}.url`], { read: true, okCodes: [1] });
      if (code === 1) await this.git(['remote', 'add', '--', REMOTE_NAME, this.remote.url]);
      // GitHub App remotes: keep `origin` on the plain HTTPS URL (an older clone may point at git@github.com:...).
      else if (this.remote.auth?.type === 'github-app') {
        const cur = (await this.out(['config', '--get', `remote.${REMOTE_NAME}.url`])).trim();
        if (cur !== this.remote.url) await this.git(['remote', 'set-url', '--', REMOTE_NAME, this.remote.url]);
      }
    }
    await this.afterOpen();
  }

  async clone(): Promise<void> {
    if (!this.remote) throw new Error('No remote configured');
    const parent = path.dirname(this.dir);
    await mkdir(parent, { recursive: true });
    const net = await this.networkOpts();
    await this.net(net.secrets, () => this.git(['clone', '--quiet', '--no-recurse-submodules', '--', this.remote!.url, this.dir], { ...net, cwd: parent }));
    await this.afterOpen();
    // Cloning an empty remote: point HEAD at the configured branch (as EsGitStore does).
    if (!(await this.head())) await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`]);
  }

  async openOrCreate(): Promise<void> {
    if (existsSync(path.join(this.dir, '.git'))) return this.open();
    if (this.remote) return this.clone();
    return this.init();
  }

  hasRemote(): boolean {
    return !!this.remote;
  }

  /** Stop the background `git cat-file` process (optional; it also exits when idle). */
  close(): void {
    this.catFile?.close();
  }

  /* ------------------------------------------------------------------ reads */

  async head(): Promise<string | null> {
    this.ensureOpen();
    const { code, stdout } = await this.git(['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], { read: true, okCodes: [1, 128] });
    return code === 0 ? stdout.toString().trim() : null;
  }

  private async currentBranch(): Promise<string | null> {
    const { code, stdout } = await this.git(['symbolic-ref', '--quiet', 'HEAD'], { read: true, okCodes: [1] });
    return code === 0 ? stdout.toString().trim().replace(/^refs\/heads\//, '') : null;
  }

  async status(): Promise<GitStatus> {
    this.ensureOpen();
    const raw = await this.out(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=no', '--no-renames']);
    const files: GitFileStatus[] = [];
    let head: string | null = null;
    let branch: string | null = null;
    for (const rec of raw.split('\0')) {
      if (!rec) continue;
      if (rec.startsWith('# branch.oid ')) head = rec.slice(13) === '(initial)' ? null : rec.slice(13);
      else if (rec.startsWith('# branch.head ')) branch = rec.slice(14) === '(detached)' ? null : rec.slice(14);
      else if (rec.startsWith('? ')) files.push({ path: rec.slice(2), status: 'new' });
      else if (rec.startsWith('1 ')) files.push({ path: fieldsAfter(rec, 8), status: describeXY(rec.slice(2, 4)) });
      else if (rec.startsWith('u ')) files.push({ path: fieldsAfter(rec, 10), status: 'conflicted' });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { branch, head, clean: files.length === 0, files, remote: this.remote?.url ?? null };
  }

  async log(limit = 50): Promise<GitCommitInfo[]> {
    if (!(await this.head()) || limit <= 0) return [];
    const ids = await this.revList([`--max-count=${Math.floor(limit)}`, 'HEAD']);
    const commits = await Promise.all(ids.map((id) => this.commitObject(id)));
    return commits.map((c) => ({ id: c.id, message: c.message.trim(), author: `${c.authorName} <${c.authorEmail}>`, date: c.date }));
  }

  async resolveCommit(ref: string): Promise<string | null> {
    this.ensureOpen();
    // Same accepted syntax as EsGitStore; a leading '-' is never a valid ref or hash (and would be an option).
    if (!/^[\w./~^-]+$/.test(ref) || ref.startsWith('-')) return null;
    // Full object ids (the common case: replaying history) are checked in-process, no `rev-parse`.
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref) && ref.length === this.hashBytes * 2) {
      if (this.commits.has(ref)) return ref;
      const obj = await this.readObject(ref).catch(() => null);
      if (obj?.type === 'commit') return ref;
      if (!obj) return null;
      // Not a commit: a branch/tag could still be named like a hash; let rev-parse decide.
    }
    const { code, stdout } = await this.git(['rev-parse', '--quiet', '--verify', ref], { read: true, okCodes: [1, 128] });
    if (code !== 0) return null;
    const oid = stdout.toString().trim();
    const obj = await this.readObject(oid).catch(() => null);
    return obj?.type === 'commit' ? oid : null; // like libgit2 findCommit: annotated tags are not peeled
  }

  async readFileAt(commit: string, file: string): Promise<string | null> {
    const id = await this.resolveCommit(commit);
    if (!id) throw new Error(`unknown commit '${commit}'`);
    const c = await this.commitObject(id);
    const entry = await this.entryAt(c.tree, file);
    if (!entry || isTree(entry.mode) || entry.mode === '160000') return null;
    const blob = await this.readObject(entry.oid);
    return blob?.type === 'blob' ? blob.content.toString('utf8') : null;
  }

  async commitInfo(commit: string): Promise<FileCommit> {
    return this.toFileCommit(await this.commitObject(commit));
  }

  async firstParentChain(stopAt?: string | null): Promise<{ commits: string[]; reachedStop: boolean }> {
    if (!(await this.head())) return { commits: [], reachedStop: !stopAt };
    let reached = false;
    const commits = await this.revList(['--first-parent', 'HEAD'], (oid) => (reached = oid === stopAt));
    return { commits, reachedStop: reached || !stopAt };
  }

  async reachable(commit: string, hide: string | null): Promise<string[]> {
    for (const id of [commit, hide]) if (id !== null && !/^[0-9a-f]{40,64}$/.test(id)) throw new Error(`invalid commit id '${id}'`);
    // Linear history (the common case when replaying): a commit whose only parent is `hide`.
    if (hide) {
      const c = await this.commitObject(commit);
      if (c.parents.length === 1 && c.parents[0] === hide) return [commit];
    }
    return this.revList([commit, ...(hide ? [`^${hide}`] : [])]);
  }

  async commitDiff(ref: string, dirs: string[]): Promise<CommitDiff> {
    const commit = await this.resolveCommit(ref);
    if (!commit) throw new Error(`unknown commit '${ref}'`);
    const c = await this.commitObject(commit);
    const parent = c.parents[0] ?? null;
    const after = await this.snapshot(c.tree, dirs);
    const before = parent ? await this.snapshot((await this.commitObject(parent)).tree, dirs) : new Map<string, string>();
    const files: CommitDiff['files'] = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(p);
      const a = after.get(p);
      if (b === a) continue;
      files.push({ path: p, status: !b ? 'added' : !a ? 'deleted' : 'modified', ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) });
    }
    return { commit, parent, files: files.sort((x, y) => x.path.localeCompare(y.path)) };
  }

  async blobsAt(commit: string, dirs: string[], files: string[] = []): Promise<Map<string, string>> {
    const c = await this.commitObject(commit);
    const out = await this.snapshot(c.tree, dirs);
    for (const f of files) {
      const e = await this.entryAt(c.tree, f);
      if (e) out.set(f, e.oid);
    }
    return out;
  }

  async fileHistory(dirs: string[]): Promise<Map<string, FileCommit[]>> {
    const head = await this.head();
    const key = `${head}|${dirs.join(',')}`;
    if (this.historyCache?.key === key) return this.historyCache.map;
    const map = new Map<string, FileCommit[]>();
    if (head) {
      const attribute = (info: FileCommit, now: Map<string, string>, parent: Map<string, string>) => {
        for (const p of new Set([...now.keys(), ...parent.keys()])) {
          if (now.get(p) !== parent.get(p)) {
            const list = map.get(p) ?? [];
            list.push(info);
            map.set(p, list);
          }
        }
      };
      let prev: { info: FileCommit; snap: Map<string, string> } | null = null;
      // Issue all object reads at once: they are pipelined through the cat-file process.
      const commits = await Promise.all((await this.revList(['--first-parent', head])).map((oid) => this.commitObject(oid)));
      const snaps = await Promise.all(commits.map((c) => this.snapshot(c.tree, dirs)));
      for (const [i, c] of commits.entries()) {
        const snap = snaps[i]!;
        // Walk is child -> first parent, so the previous commit is this one's child.
        if (prev) attribute(prev.info, prev.snap, snap);
        prev = { info: this.toFileCommit(c), snap };
      }
      if (prev) attribute(prev.info, prev.snap, new Map());
    }
    this.historyCache = { key, map };
    return map;
  }

  /* ------------------------------------------------------------------ writes */

  /** Committer = Mandate (`git.author`); author = `author` when given (the triggering user), else Mandate too. */
  private identity(author: Identity = this.author): string[] {
    const who = this.author;
    return [
      ...['user', 'committer'].flatMap((k) => ['-c', `${k}.name=${who.name}`, '-c', `${k}.email=${who.email}`]),
      ...['-c', `author.name=${author.name}`, '-c', `author.email=${author.email}`],
    ];
  }

  /** `git commit` of the current index with the message stored byte-for-byte (trailers included). */
  private async commitIndex(message: string, options: CommitOptions = {}): Promise<string> {
    const env: Record<string, string> = {};
    if (options.date) {
      const stamp = `@${Math.floor(options.date.getTime() / 1000)} +0000`;
      env.GIT_AUTHOR_DATE = stamp;
      env.GIT_COMMITTER_DATE = stamp;
    }
    await this.git(['commit', '--quiet', '--no-verify', '--allow-empty', '--allow-empty-message', '--cleanup=verbatim', '--no-edit', '--file=-'], {
      config: this.identity(commitAuthor(message, options.author) ?? this.author),
      env,
      input: message,
    });
    this.historyCache = undefined;
    return (await this.head())!;
  }

  async commit(paths: string[], message: string, options: CommitOptions = {}): Promise<string | null> {
    this.ensureOpen();
    return this.lock.run(async () => {
      const present = paths.filter((p) => existsSync(path.join(this.dir, p)));
      const missing = paths.filter((p) => !present.includes(p));
      for (const batch of chunks(present, 200)) await this.git(['add', '--force', '--', ...batch]);
      for (const batch of chunks(missing, 200)) await this.git(['rm', '--quiet', '--cached', '--ignore-unmatch', '--', ...batch]);
      const tree = (await this.out(['write-tree'], { read: false })).trim();
      const parent = await this.head();
      // Same rule as EsGitStore: only an unchanged tree on top of an existing commit is a no-op
      // (the first commit of an empty repository is always created).
      if (parent && (await this.commitObject(parent)).tree === tree) return null;
      return this.commitIndex(message, options);
    });
  }

  async fetch(): Promise<void> {
    if (!this.remote) return;
    this.ensureOpen();
    const net = await this.networkOpts();
    await this.net(net.secrets, () => this.git(['fetch', '--quiet', '--no-recurse-submodules', '--', REMOTE_NAME], net));
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', a, b], { read: true, okCodes: [1] })).code === 0;
  }

  async pull(): Promise<boolean> {
    if (!this.remote) return false;
    this.ensureOpen();
    return this.lock.run(async () => {
      await this.fetch();
      const branch = (await this.currentBranch()) ?? this.branch;
      const { code, stdout } = await this.git(['rev-parse', '--quiet', '--verify', `refs/remotes/${REMOTE_NAME}/${branch}`], {
        read: true,
        okCodes: [1, 128],
      });
      if (code !== 0) return false; // remote branch does not exist yet
      const theirs = stdout.toString().trim();
      const ours = await this.head();
      this.historyCache = undefined;

      if (!ours) {
        // Unborn local branch: point it at the remote commit and check out.
        await this.git(['update-ref', `refs/heads/${branch}`, theirs]);
        await this.git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
        await this.git(['reset', '--quiet', '--hard', 'HEAD']);
        return true;
      }
      if (ours === theirs || (await this.isAncestor(theirs, ours))) return false;

      const mergeFlags = ['--quiet', '--no-stat', '--no-edit', '--no-verify-signatures', '--no-autostash'];
      if (await this.isAncestor(ours, theirs)) {
        // Fast-forward; refuses (like a safe checkout) when local changes would be overwritten.
        await this.git(['merge', ...mergeFlags, '--ff-only', theirs], { config: this.identity() });
        return true;
      }

      // True merge: merge without committing, abort on conflicts, else commit with our own message.
      const merge = await this.git(['merge', ...mergeFlags, '--no-ff', '--no-commit', theirs], { config: this.identity(), okCodes: [1] });
      const merging = (await this.git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], { read: true, okCodes: [1, 128] })).code === 0;
      const conflicts = merging && (await this.out(['ls-files', '--unmerged', '-z'])).length > 0;
      if (merge.code !== 0 || conflicts) {
        if (merging) await this.git(['merge', '--abort']);
        if (conflicts || merging) throw new Error('Merge conflict while pulling; resolve manually in ' + this.dir);
        throw new GitCliError(`git merge failed: ${merge.stderr.trim()}`, 'git merge', merge.code, merge.stderr);
      }
      await this.commitIndex(`Merge ${REMOTE_NAME}/${branch}`);
      return true;
    });
  }

  async push(): Promise<void> {
    if (!this.remote) return;
    this.ensureOpen();
    return this.lock.run(async () => {
      if (!(await this.head())) return; // nothing to push yet
      const branch = (await this.currentBranch()) ?? this.branch;
      // Explicit non-forcing refspec: the data repo is append-only, rejected pushes are errors.
      const net = await this.networkOpts();
      const res = await this.net(net.secrets, () =>
        this.git(['push', '--porcelain', '--no-verify', '--', REMOTE_NAME, `refs/heads/${branch}:refs/heads/${branch}`], {
          ...net,
          okCodes: [1],
        }),
      );
      const rejections = res.stdout
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('!\t'))
        .map((l) => {
          const [, refs = '', summary = ''] = l.split('\t');
          return `${refs.split(':')[1] ?? refs}: ${summary}`;
        });
      if (rejections.length) throw new Error(`Push rejected: ${rejections.join(', ')}`);
      if (res.code !== 0) {
        const stderr = redact(res.stderr.toString().trim(), net.secrets);
        const err = new GitCliError(`git push failed: ${stderr}`, 'git push', res.code, stderr);
        onAuthFailure(this.remote?.auth, err);
        throw err;
      }
    });
  }
}

/* ------------------------------------------------------------------ parsing helpers */

function isTree(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

function ceiling(dir: string): string {
  const parent = path.dirname(dir);
  return realpath(parent);
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/** The rest of a porcelain-v2 record after `n` space-separated fields (paths may contain spaces). */
function fieldsAfter(rec: string, n: number): string {
  let i = -1;
  for (let k = 0; k < n; k++) i = rec.indexOf(' ', i + 1);
  return rec.slice(i + 1);
}

/** Map porcelain XY to the EsGitStore status names (same precedence as `describeStatus`). */
function describeXY(xy: string): string {
  if (xy.includes('U')) return 'conflicted';
  if (xy.includes('A')) return 'new';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('M') || xy.includes('T')) return 'modified';
  return 'unknown';
}

/** Binary tree object: `<mode> <name>\0<raw oid>` entries. */
export function parseTree(buf: Buffer, hashBytes: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(32, i);
    const nul = buf.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) throw new Error('corrupt tree object');
    out.push({ mode: buf.toString('latin1', i, sp), name: buf.toString('utf8', sp + 1, nul), oid: buf.toString('hex', nul + 1, nul + 1 + hashBytes) });
    i = nul + 1 + hashBytes;
  }
  return out;
}

/** Signature `Name <email> 1700000000 +0100` the way libgit2 splits it (last `<` / `>`). */
function parseSignature(s: string): { name: string; email: string; time: number } {
  const lt = s.lastIndexOf('<');
  const gt = s.lastIndexOf('>');
  if (lt < 0 || gt < lt) return { name: s.trim(), email: '', time: 0 };
  const time = Number(/^\s*(\d+)/.exec(s.slice(gt + 1))?.[1] ?? 0);
  return { name: s.slice(0, lt).trim(), email: s.slice(lt + 1, gt).trim(), time };
}

/** Raw commit object: headers, blank line, message. */
export function parseCommit(id: string, buf: Buffer): CommitObject {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n');
  const message = split < 0 ? '' : text.slice(split + 2); // verbatim, like es-git's `message()`
  let tree = '';
  const parents: string[] = [];
  let author = parseSignature('');
  let committer = author;
  for (const h of headers) {
    if (h.startsWith(' ')) continue; // continuation (gpgsig, mergetag)
    const sp = h.indexOf(' ');
    const key = h.slice(0, sp);
    const value = h.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = parseSignature(value);
    else if (key === 'committer') committer = parseSignature(value);
  }
  return {
    id,
    tree,
    parents,
    message,
    authorName: author.name,
    authorEmail: author.email,
    date: new Date(committer.time * 1000).toISOString(),
  };
}
