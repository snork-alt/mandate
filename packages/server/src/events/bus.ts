/**
 * Activity event bus. One hook at the commit point (the GitStore instance's `commit` / `pull`, like `watchCommits`),
 * plus a cheap HEAD poll for commits made outside Mandate. Events are derived from git (`deriveCommitEvents`), so the
 * feed survives restarts: `list()` replays history; a bounded ring buffer keeps recent events (and `git.pulled`, which
 * is not in history) for fast access.
 */
import {
  activityListInputSchema,
  activityTouches,
  activityTypeMatches,
  type ActivityEvent,
  type ActivityListInput,
  type ActivityListResponse,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { ReadError } from '../storage/read.js';
import { deriveCommitEvents } from './derive.js';

export interface ActivityFilter {
  types?: string[];
  agent?: string;
  ref?: string;
  includeHeartbeats?: boolean;
}

export function matchesFilter(e: ActivityEvent, f: ActivityFilter): boolean {
  if (f.types && !f.types.some((p) => activityTypeMatches(e.type, p))) return false;
  if (f.agent && e.agent !== f.agent) return false;
  if (f.ref && !activityTouches(e, f.ref)) return false;
  if (f.includeHeartbeats === false && e.heartbeat) return false;
  return true;
}

export interface ActivityBusOptions {
  ringSize?: number;
  /** HEAD poll interval for outside commits (0 disables). */
  pollMs?: number;
  /** Commits scanned by `list()` (newest first). */
  historyLimit?: number;
  log?: { warn(msg: string): void };
}

export class ActivityBus {
  private readonly ring: ActivityEvent[] = [];
  private readonly listeners = new Set<(e: ActivityEvent) => void>();
  private readonly cache = new Map<string, ActivityEvent[]>();
  private lastHead: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private readonly git: GitStore,
    private readonly opts: ActivityBusOptions = {},
  ) {}

  /** Hook the commit point and start polling. Events start at the current HEAD (earlier ones come from `list`). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.lastHead = await this.git.head();
    const commit = this.git.commit.bind(this.git);
    this.git.commit = async (...args) => {
      const id = await commit(...args);
      if (id) await this.catchUp();
      return id;
    };
    const pull = this.git.pull.bind(this.git);
    this.git.pull = async () => {
      const before = await this.git.head();
      const moved = await pull();
      if (moved) {
        const head = await this.git.head();
        const chain = head ? await this.git.firstParentChain(before).catch(() => ({ commits: [head], reachedStop: false })) : { commits: [] };
        await this.catchUp();
        if (head) this.publish(await this.pulledEvent(head, chain.commits));
      }
      return moved;
    };
    const ms = this.opts.pollMs ?? 3000;
    if (ms > 0) {
      this.timer = setInterval(() => void this.catchUp().catch((e: Error) => this.opts.log?.warn(`activity: ${e.message}`)), ms);
      this.timer.unref?.();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }

  subscribe(fn: (e: ActivityEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Recent events, newest first (ring buffer). */
  recent(): ActivityEvent[] {
    return [...this.ring].reverse();
  }

  /** Emit events for commits between the last seen HEAD and HEAD (serialized; oldest first). */
  catchUp(): Promise<ActivityEvent[]> {
    const run = this.chain.then(async () => {
      const head = await this.git.head();
      if (!head || head === this.lastHead) return [];
      const { commits, reachedStop } = await this.git.firstParentChain(this.lastHead);
      // History rewritten (reset / force pull): only report the new HEAD.
      const todo = (reachedStop || !this.lastHead ? commits : commits.slice(0, 1)).slice(0, 200).reverse();
      const out: ActivityEvent[] = [];
      for (const sha of todo) {
        const events = await this.derive(sha);
        for (const e of events) this.publish(e);
        out.push(...events);
      }
      this.lastHead = head;
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Publish an event that is not derived from a commit (git.pushed / git.push_failed); ring buffer only. */
  emit(e: ActivityEvent): void {
    this.publish(e);
  }

  private publish(e: ActivityEvent): void {
    this.ring.push(e);
    const max = this.opts.ringSize ?? 500;
    if (this.ring.length > max) this.ring.splice(0, this.ring.length - max);
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.opts.log?.warn(`activity listener: ${(err as Error).message}`);
      }
    }
  }

  private async derive(sha: string): Promise<ActivityEvent[]> {
    const hit = this.cache.get(sha);
    if (hit) return hit;
    const events = await deriveCommitEvents(this.git, sha).catch((e: Error) => {
      this.opts.log?.warn(`activity: ${sha.slice(0, 7)}: ${e.message}`);
      return [] as ActivityEvent[];
    });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(sha, events);
    return events;
  }

  private async pulledEvent(head: string, commits: string[]): Promise<ActivityEvent> {
    const info = await this.git.commitInfo(head);
    return {
      id: `${head}:pull:${Date.now()}`,
      commit: head,
      type: 'git.pulled',
      at: new Date().toISOString(),
      refs: [`mandate://commits/${head}`],
      summary: `Pulled ${commits.length} commit${commits.length === 1 ? '' : 's'} (HEAD ${head.slice(0, 7)}: ${info.message.split('\n')[0]})`,
      details: { commits },
    };
  }

  /** Git-backed listing (works after restarts), newest first, plus `git.pulled` / `git.pushed` / `git.push_failed` events from the ring. */
  async list(input: ActivityListInput): Promise<ActivityListResponse> {
    const inp = activityListInputSchema.parse(input);
    const resolve = async (v: string | undefined) => (v && /^[0-9a-f]{4,40}$/.test(v) ? ((await this.git.resolveCommit(v)) ?? v) : v);
    const since = await resolve(inp.since);
    const until = await resolve(inp.until);
    const isSha = (v?: string) => !!v && /^[0-9a-f]{40}$/.test(v);
    if (inp.since && /^[0-9a-f]{4,39}$/.test(inp.since) && !isSha(since)) {
      throw new ReadError(`unknown commit '${inp.since}'`, 'unknown_commit', 'pass the head from a previous activity_list, or an ISO date', 'since', 404);
    }
    const log = await this.git.log(this.opts.historyLimit ?? 2000);
    const events: ActivityEvent[] = [];
    let inRange = !isSha(until);
    for (const c of log) {
      if (isSha(until) && c.id === until) inRange = true;
      if (isSha(since) && c.id === since) break;
      if (!inRange) continue;
      if (since && !isSha(since) && c.date <= normDate(since)) break;
      if (until && !isSha(until) && c.date > normDate(until, true)) continue;
      // Newest first: reverse each commit's own (chronological) event order.
      events.push(...[...(await this.derive(c.id))].reverse());
    }
    const pulls = this.ring.filter((e) => (e.type === 'git.pulled' || e.type === 'git.pushed' || e.type === 'git.push_failed') && (!since || isSha(since) || e.at > normDate(since)) && (!until || isSha(until) || e.at <= normDate(until, true)));
    const all = [...events, ...pulls].filter((e) => matchesFilter(e, inp)).sort((a, b) => b.at.localeCompare(a.at));
    const start = inp.cursor ? Number(inp.cursor) : 0;
    return {
      events: all.slice(start, start + inp.limit),
      total: all.length,
      nextCursor: start + inp.limit < all.length ? String(start + inp.limit) : null,
      head: await this.git.head(),
    };
  }
}

/** ISO date / datetime -> comparable ISO string (date-only `until` covers the whole day). */
function normDate(v: string, endOfDay = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return endOfDay ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`;
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}
