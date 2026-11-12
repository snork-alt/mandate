/**
 * Background push of a project's commits: debounced after every commit (bursts become one push) plus a periodic
 * sweep that pushes whenever the branch is ahead (catches failures and restarts). Never force-pushes.
 * - The network push runs outside the project's write lock (MCP writes are never blocked by it; a commit made
 *   meanwhile stays "ahead" and is pushed next). Integration after a rejected push (`pull`: fetch, then fast-forward
 *   or a merge commit, exactly what `git_pull` does) runs inside the write lock; the index and activity feed follow
 *   through the pull hooks. A merge conflict aborts (local commits kept), sets the error state and stops retrying
 *   until the next commit or a manual retry.
 * - Refused when the project's data dir is not the root of its own git repository (Mandate never runs git on an
 *   enclosing repo, e.g. the Mandate source checkout).
 * - Credentials come from the store's remote auth (token getter); they never appear in URLs, argv or messages.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ActivityEvent, AutoPushStatus } from '@mandate/shared';
import type { AutoPushConfig } from '../config.js';
import type { GitStore } from './GitStore.js';
import { SubdirGitStore } from './SubdirGitStore.js';

export interface PushGate {
  /** null = allowed; otherwise why pushing is skipped (shown as the status). */
  (): { state: 'no_remote' | 'reconnect' | 'refused' | 'disabled'; message: string } | null;
}

export interface AutoPusherOptions {
  git: GitStore;
  /** The project's write lock (integration runs inside it). */
  lock: { run<T>(fn: () => Promise<T>): Promise<T> };
  config: AutoPushConfig;
  /** Extra conditions (GitHub token revoked → reconnect). */
  gate?: PushGate;
  emit?: (e: ActivityEvent) => void;
  /** The remote rejected our credentials (GitHub: mark the token revoked → "Reconnect GitHub"). */
  onAuthError?: () => void;
  log?: { info(m: string): void; warn(m: string): void };
  /** Test overrides (ms). */
  debounceMs?: number;
  intervalMs?: number;
  maxBackoffMs?: number;
}

const NON_FF = /non-?fast-?forward|fetch first|\[rejected\]|rejected|stale info|cannot push non-fastforwardable|not present locally/i;
const AUTH = /\b401\b|\b403\b|authentication|could not read username|credential|bad credentials|permission denied|access denied/i;
const CONFLICT = /conflict/i;

/** Strip anything credential-like from a git error before it is stored, logged or emitted. */
export function cleanError(msg: string): string {
  return msg
    .replace(/\/\/[^/@\s]*@/g, '//***@')
    .replace(/\b(gh[opusr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '***')
    .replace(/\b(password|token|authorization)(\s*[=:]\s*)\S+/gi, '$1$2***')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .slice(0, 300);
}

/** The data dir must be its repo's root with its own `.git` (for a shared-repo folder: the clone's root). */
export function ownRepoProblem(git: GitStore): string | null {
  const root = git instanceof SubdirGitStore ? git.inner.dir : git.dir;
  if (!existsSync(path.join(root, '.git'))) return `${root} is not the root of its own git repository; Mandate never pushes an enclosing repository`;
  try {
    realpathSync(root);
  } catch {
    return `${root} does not exist`;
  }
  return null;
}

export class AutoPusher {
  private timer?: NodeJS.Timeout;
  private sweep?: NodeJS.Timeout;
  private running: Promise<AutoPushStatus> | null = null;
  private again = false;
  private stopped = false;
  private st: Omit<AutoPushStatus, 'ahead' | 'behind' | 'enabled' | 'message'> & { message: string | null } = {
    state: 'idle',
    lastPushAt: null,
    lastResult: null,
    lastError: null,
    nextPushAt: null,
    failures: 0,
    message: null,
  };
  /** Conflict / non-retryable: wait for a new commit or a manual retry. */
  private halted = false;

  constructor(private readonly o: AutoPusherOptions) {}

  private get debounceMs() {
    return this.o.debounceMs ?? this.o.config.debounceSeconds * 1000;
  }
  private get intervalMs() {
    return this.o.intervalMs ?? this.o.config.intervalSeconds * 1000;
  }

  /** Why pushing is skipped right now (null = allowed). */
  private blocked(): ReturnType<PushGate> {
    if (!this.o.git.hasRemote()) return { state: 'no_remote', message: 'No remote: commits stay local' };
    const own = ownRepoProblem(this.o.git);
    if (own) return { state: 'refused', message: own };
    const g = this.o.gate?.() ?? null;
    if (g) return g;
    if (!this.o.config.enabled) return { state: 'disabled', message: 'Auto-push is off (git.autoPush.enabled)' };
    return null;
  }

  /** Hook the commit point and start the periodic sweep. */
  start(): void {
    const git = this.o.git;
    const commit = git.commit.bind(git);
    git.commit = async (...args) => {
      const id = await commit(...args);
      if (id) {
        this.halted = false;
        this.schedule();
      }
      return id;
    };
    this.sweep = setInterval(() => {
      if (!this.halted) void this.pushNow('sweep').catch(() => undefined);
    }, this.intervalMs);
    this.sweep.unref?.();
    // Catch up after a restart (commits made while the server was down or a failed push).
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.sweep);
  }

  /** (Re)arm the debounce timer. */
  schedule(delay = this.debounceMs): void {
    if (this.stopped || !this.o.config.enabled) return;
    clearTimeout(this.timer);
    this.st.nextPushAt = new Date(Date.now() + delay).toISOString();
    if (this.st.state !== 'pushing' && this.st.state !== 'error') this.st.state = 'scheduled';
    this.timer = setTimeout(() => void this.pushNow('debounce').catch(() => undefined), delay);
    this.timer.unref?.();
  }

  /** Push now (debounce, sweep or a manual retry). Runs one at a time; a request during a run reruns once. */
  pushNow(reason: 'debounce' | 'sweep' | 'manual' = 'manual'): Promise<AutoPushStatus> {
    if (reason === 'manual') this.halted = false;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run(reason).finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule();
      }
    });
    return this.running;
  }

  private async counts(): Promise<{ ahead: number | null; behind: number | null; remoteHead: string | null; head: string | null }> {
    const git = this.o.git;
    const head = await git.head();
    const branch = (await git.status().catch(() => null))?.branch;
    const remoteHead = branch ? await git.resolveCommit(`refs/remotes/origin/${branch}`) : null;
    if (!head) return { ahead: 0, behind: remoteHead ? null : 0, remoteHead, head };
    const ahead = (await git.reachable(head, remoteHead).catch(() => null))?.length ?? null;
    const behind = remoteHead ? ((await git.reachable(remoteHead, head).catch(() => null))?.length ?? null) : 0;
    return { ahead, behind, remoteHead, head };
  }

  private async run(reason: string): Promise<AutoPushStatus> {
    clearTimeout(this.timer);
    this.st.nextPushAt = null;
    const b = this.blocked();
    if (b) {
      this.st.state = b.state;
      this.st.message = b.message;
      return this.status();
    }
    const git = this.o.git;
    try {
      let c = await this.counts();
      if (!c.ahead) {
        if (this.st.state !== 'error' || reason === 'manual') this.st.state = this.st.lastResult === 'ok' ? 'ok' : 'idle';
        return this.status();
      }
      this.st.state = 'pushing';
      const before = c.remoteHead;
      try {
        await git.push();
      } catch (e) {
        const msg = (e as Error).message;
        if (AUTH.test(msg) && !NON_FF.test(msg)) throw e;
        if (!NON_FF.test(msg)) throw e;
        // Rejected (remote moved): integrate like git_pull (inside the write lock), then push again.
        this.o.log?.info(`auto-push: remote moved; integrating (${reason})`);
        await this.o.lock.run(() => git.pull());
        await git.push();
      }
      await git.fetch().catch(() => undefined); // refresh the remote-tracking ref (ahead/behind)
      c = await this.counts();
      const pushed = c.head ? await git.reachable(c.head, before).catch(() => []) : [];
      this.st = { ...this.st, state: 'ok', lastPushAt: new Date().toISOString(), lastResult: 'ok', lastError: null, failures: 0, message: null };
      if (c.head) {
        this.o.emit?.({
          id: `push:${c.head}:${Date.now()}`,
          commit: c.head,
          type: 'git.pushed',
          at: new Date().toISOString(),
          refs: [`mandate://commits/${c.head}`],
          summary: `Pushed ${pushed.length} commit${pushed.length === 1 ? '' : 's'} (${(before ?? 'new branch').slice(0, 7)}..${c.head.slice(0, 7)})`,
          details: { commits: pushed, range: { from: before, to: c.head } },
        });
      }
      return this.status();
    } catch (e) {
      return this.fail(cleanError((e as Error).message));
    }
  }

  private async fail(error: string): Promise<AutoPushStatus> {
    const conflict = CONFLICT.test(error);
    const auth = AUTH.test(error);
    if (auth) this.o.onAuthError?.();
    this.st.failures++;
    this.st.lastResult = 'error';
    this.st.lastError = error;
    this.st.state = auth && this.o.gate?.()?.state === 'reconnect' ? 'reconnect' : 'error';
    this.st.message = conflict ? 'Merge conflict with the remote: resolve it in the data repo; local commits are kept' : auth ? 'The remote rejected the credentials' : `Push failed: ${error}`;
    this.o.log?.warn(`auto-push failed (${this.st.failures}): ${error}`);
    const head = await this.o.git.head().catch(() => null);
    if (this.st.failures === 1 || conflict) {
      this.o.emit?.({ id: `push-failed:${Date.now()}`, commit: head ?? '', type: 'git.push_failed', at: new Date().toISOString(), refs: head ? [`mandate://commits/${head}`] : [], summary: `Push failed: ${this.st.message}`, details: { error } });
    }
    if (conflict || auth || this.st.failures >= 6) {
      this.halted = true; // until the next commit or a manual retry
    } else {
      this.schedule(Math.min(this.debounceMs * 2 ** this.st.failures, this.o.maxBackoffMs ?? 30 * 60_000));
    }
    return this.status();
  }

  async status(): Promise<AutoPushStatus> {
    const b = this.blocked();
    const c = b?.state === 'no_remote' || b?.state === 'refused' ? { ahead: null, behind: null } : await this.counts().catch(() => ({ ahead: null, behind: null }));
    const state = b ? b.state : this.st.state;
    const message =
      b?.message ??
      this.st.message ??
      (state === 'pushing' ? 'Pushing…' : c.ahead ? `${c.ahead} commit${c.ahead === 1 ? '' : 's'} pending push` : this.st.lastPushAt ? 'Up to date with the remote' : 'Nothing to push');
    return {
      enabled: this.o.config.enabled,
      state,
      ahead: c.ahead,
      behind: c.behind,
      lastPushAt: this.st.lastPushAt,
      lastResult: this.st.lastResult,
      lastError: this.st.lastError,
      nextPushAt: this.halted ? null : this.st.nextPushAt,
      failures: this.st.failures,
      message,
    };
  }
}
