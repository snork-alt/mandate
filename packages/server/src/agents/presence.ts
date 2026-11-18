/**
 * Agent presence and handles of one project (memory only: it rebuilds from tool calls and event-stream connections).
 *
 * An agent is a CLIENT (news clients: `<login>/claude-code`, `claude-code/<key-name>`). Its state is
 *   online  - an event stream (SSE / channel) is connected, or it called a tool in the last PRESENCE_ACTIVE_MS
 *             (`wakeable`: only with a stream; an MCP-only agent gets news on its next tool reply, it cannot be woken),
 *   busy    - it holds a (fresh) claim on a work order (with what),
 *   offline - otherwise.
 * Handles an `@mention` / `to` can use: the client id, the agent name seen on its calls / claims, its client slug
 * (`claude-code`, when only one client of the project has it) and the login (all that user's clients).
 */
import { isClaimStale, type WorkOrder } from '@mandate/shared';
import { normaliseClient } from '../projects/settings.js';

/** An agent that made an MCP request this recently is online (it may not be wakeable: see AgentView.wakeable). */
export const PRESENCE_ACTIVE_MS = 5 * 60_000;

export interface AgentInfo {
  id: string;
  label: string;
  client: string;
  user?: string;
  /** Agent names seen on its calls (claims record these). */
  names: Set<string>;
  /** Code repos of its sessions (code_context_set). */
  repos: Set<string>;
  streams: number;
  /** When the last stream closed: the rewake watch re-arms on the next hook, so a just-closed stream still counts as wakeable for a short grace. */
  streamClosedAt?: number;
  lastSeen: number;
  /** Known from the persisted directory only (no activity since this process started). */
  seeded?: boolean;
}

/** Grace after a stream closes (rewake re-arm gap between hook events). */
export const STREAM_GRACE_MS = 2 * 60_000;

/** An agent seen this recently before a restart is `reconnecting` (not offline) until it is seen again. */
export const RECONNECT_MS = 30 * 60_000;

export type AgentState = 'online' | 'busy' | 'reconnecting' | 'offline';
export interface AgentView {
  id: string;
  /** The handle to use in `@mention` / `to`. */
  handle: string;
  label: string;
  user?: string;
  state: AgentState;
  /** An event stream (channel / hook) is connected: news wakes it. False: it only sees news on its next tool reply. */
  wakeable: boolean;
  /** Open claims (work orders) while busy. */
  busyWith: { ref: string; summary: string }[];
  repos: string[];
  /** ISO time of its last activity; absent when never seen. */
  lastSeen?: string;
}

export class AgentPresence {
  private readonly agents = new Map<string, AgentInfo>();
  private readonly connectListeners = new Set<(client: string) => void>();

  /** Called when an agent (re)connects: a stream opens, or a tool call after being idle / unknown. */
  onConnect(fn: (client: string) => void): () => void {
    this.connectListeners.add(fn);
    return () => void this.connectListeners.delete(fn);
  }
  private connected(id: string) {
    for (const fn of this.connectListeners) fn(id);
  }

  note(c: { id: string; label: string; client: string; user?: string }, agentName?: string, repo?: string): AgentInfo {
    let a = this.agents.get(c.id);
    const wasOnline = !!a && this.isOnline(c.id);
    if (!a) this.agents.set(c.id, (a = { id: c.id, label: c.label, client: c.client, ...(c.user ? { user: c.user } : {}), names: new Set(), repos: new Set(), streams: 0, lastSeen: 0 }));
    if (agentName) a.names.add(agentName);
    if (repo) a.repos.add(repo);
    a.lastSeen = Date.now();
    delete a.seeded;
    if (!wasOnline) this.connected(c.id);
    return a;
  }

  /** Register a client known from before (the client directory) without marking it online or firing connect listeners. */
  know(c: { id: string; label: string; client: string; user?: string }, lastSeenAt?: number): void {
    const seen = lastSeenAt && Number.isFinite(lastSeenAt) ? lastSeenAt : 0;
    const cur = this.agents.get(c.id);
    if (cur) {
      if (cur.seeded && seen > cur.lastSeen) cur.lastSeen = seen;
      return;
    }
    this.agents.set(c.id, { id: c.id, label: c.label, client: c.client, ...(c.user ? { user: c.user } : {}), names: new Set(), repos: new Set(), streams: 0, lastSeen: seen, seeded: true });
  }

  /** A stream (SSE / channel) is connected; returns the disconnect function. */
  open(c: { id: string; label: string; client: string; user?: string }): () => void {
    const a = this.note(c);
    a.streams++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      a.streams = Math.max(0, a.streams - 1);
      a.lastSeen = Date.now();
      a.streamClosedAt = a.lastSeen;
    };
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }
  all(): AgentInfo[] {
    return [...this.agents.values()];
  }

  /** The client ids an agent name (a claim's `agent`, a request's `createdBy`) and optional user stand for. */
  clientsOfAgent(agent: string, user?: string): string[] {
    const slug = normaliseClient(agent).client;
    const out = new Set<string>();
    if (user) out.add(`${user.toLowerCase()}/${slug}`);
    for (const a of this.agents.values()) if (a.names.has(agent) && (!user || a.user?.toLowerCase() === user.toLowerCase() || !a.user)) out.add(a.id);
    if (!out.size) for (const a of this.agents.values()) if (a.client === slug && !user) out.add(a.id);
    return [...out];
  }

  /** Client ids a handle (`@x`, `to`) stands for. */
  resolve(handle: string): string[] {
    const h = handle.replace(/^@/, '').toLowerCase();
    const out = new Set<string>();
    for (const a of this.agents.values()) {
      if (a.id.toLowerCase() === h || [...a.names].some((n) => n.toLowerCase() === h) || a.user?.toLowerCase() === h || handleOf(a, this.agents.values()) === h) out.add(a.id);
    }
    return [...out];
  }

  /** An event stream is connected for this client (news is pushed and wakes an idle agent). */
  isWakeable(id: string, now = Date.now()): boolean {
    const a = this.agents.get(id);
    return !!a && (a.streams > 0 || (!!a.streamClosedAt && now - a.streamClosedAt < STREAM_GRACE_MS));
  }

  /** Is `handle` a known agent / user of this project? */
  isHandle(handle: string): boolean {
    return this.resolve(handle).length > 0;
  }

  isOnline(id: string, now = Date.now()): boolean {
    const a = this.agents.get(id);
    return !!a && (a.streams > 0 || (!a.seeded && now - a.lastSeen < PRESENCE_ACTIVE_MS));
  }

  /** Presence of every known agent, with what each is busy with (claims of `workOrders`). */
  list(workOrders: WorkOrder[], now = Date.now()): AgentView[] {
    const claims = new Map<string, { ref: string; summary: string }[]>();
    for (const w of workOrders) {
      if (!w.claim || isClaimStale(w.claim, now)) continue;
      for (const id of this.clientsOfAgent(w.claim.agent, (w.claim as { user?: string }).user)) {
        claims.set(id, [...(claims.get(id) ?? []), { ref: `mandate://work-orders/${w.id}`, summary: `${w.id}: ${(w.reason?.[0] ?? w.kind) as string}` }]);
      }
    }
    return this.all()
      .map((a): AgentView => {
        const busyWith = claims.get(a.id) ?? [];
        const online = this.isOnline(a.id, now);
        const reconnecting = !online && !!a.seeded && a.lastSeen > 0 && now - a.lastSeen < RECONNECT_MS;
        return {
          id: a.id,
          handle: handleOf(a, this.agents.values()),
          label: a.user ? `${a.label} (${a.user})` : a.label,
          ...(a.user ? { user: a.user } : {}),
          state: busyWith.length && online ? 'busy' : online ? 'online' : busyWith.length ? 'busy' : reconnecting ? 'reconnecting' : 'offline',
          wakeable: this.isWakeable(a.id, now),
          busyWith,
          repos: [...a.repos],
          ...(a.lastSeen > 0 ? { lastSeen: new Date(a.lastSeen).toISOString() } : {}),
        };
      })
      .sort((x, y) => rank(x.state) - rank(y.state) || (y.lastSeen ?? '').localeCompare(x.lastSeen ?? ''));
  }
}

const rank = (s: AgentState) => (s === 'online' ? 0 : s === 'busy' ? 1 : s === 'reconnecting' ? 2 : 3);

/** The short handle: the client slug when unique in the project, else the client id with `-` for `/` (mentionable). */
function handleOf(a: AgentInfo, all: Iterable<AgentInfo>): string {
  let same = 0;
  for (const b of all) if (b.client === a.client) same++;
  return same === 1 ? a.client : a.id.toLowerCase().replace(/\//g, '-');
}

/** Suggest who should take work: an idle online agent on one of `repos`, else the least busy online agent. */
export function suggestAgent(views: AgentView[], repos: string[] = []): string | null {
  const online = views.filter((v) => v.state !== 'offline' && v.state !== 'reconnecting');
  if (!online.length) return null;
  const idle = online.filter((v) => v.state === 'online');
  const onRepo = idle.find((v) => v.repos.some((r) => repos.includes(r)));
  if (onRepo) return onRepo.id;
  // A wakeable agent (event stream) answers at once; an MCP-only one only at its next tool call.
  if (idle.length) return (idle.find((v) => v.wakeable) ?? idle[0]!).id;
  return [...online].sort((x, y) => x.busyWith.length - y.busyWith.length)[0]!.id;
}
