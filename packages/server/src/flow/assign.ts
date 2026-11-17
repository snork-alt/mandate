/**
 * Requests created from the web UI (or assigned to an agent): the assignee, exclusive start and delivery.
 *
 * `assignee` is a client id (agents/presence.ts) or `any`. Delivery is a news item of kind `request_assigned` (event
 * stream / channel push; the same item is what an offline agent catches up on when it connects). `any` goes to every
 * online agent now and to each agent that connects while the request is still unstarted. Assignment is EXCLUSIVE: the
 * first agent that starts the request (flow_next { request }) takes it (`startedBy`); the others are told it is taken.
 */
import type { Feedback } from '@mandate/shared';
import type { NewsService } from '../news/index.js';

export const ASSIGNED_KIND = 'request_assigned';
export const ANY = 'any';

const reqRef = (id: string) => `mandate://requests/${id}`;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Not started and not closed: still waiting for an agent. */
export const isQueued = (f: Pick<Feedback, 'status' | 'assignee' | 'startedBy'>) => f.status !== 'closed' && !!f.assignee && !f.startedBy;

/** May the client `me` start / drive this request? (unassigned requests: anybody) */
export function mayStart(f: Pick<Feedback, 'assignee' | 'startedBy'>, me: string, resolve: (handle: string) => string[] = () => []): { ok: true } | { ok: false; why: string } {
  if (f.startedBy && f.startedBy !== me) return { ok: false, why: `${f.startedBy} started this request` };
  if (f.assignee && f.assignee !== ANY && f.assignee !== me && !f.startedBy && !resolve(f.assignee).includes(me)) return { ok: false, why: `assigned to ${f.assignee}` };
  return { ok: true };
}

export function assignedSummary(f: Feedback, how: 'new' | 'reassigned' | 'plan_approved'): string {
  const from = f.source === 'ui' ? ` from the web UI${f.createdByUser ? ` by ${f.createdByUser}` : ''}` : '';
  const flags = [f.priority && f.priority !== 'normal' ? `${f.priority} priority` : '', f.planOnly ? 'plan only: stop after the spec update and the work-order plan' : ''].filter(Boolean).join(', ');
  const head = how === 'plan_approved' ? `Plan approved for request ${f.id}: continue (claim the work order and implement)` : `Request ${f.id} ${how === 'reassigned' ? 'reassigned to you' : 'assigned to you'}${from}${flags ? ` (${flags})` : ''}`;
  return `${head}: "${clip(f.body, 240)}". Run /mandate resume ${f.id} (flow_next { request: "${f.id}" } loop until done or waiting).`;
}

/** Tell the assignee (or every known agent client for `any`). Never throws. Returns the client ids told. */
export async function deliverAssigned(news: NewsService, f: Feedback, how: 'new' | 'reassigned' | 'plan_approved' = 'new'): Promise<string[]> {
  try {
    const target = how === 'plan_approved' ? (f.startedBy ?? f.assignee) : f.assignee;
    if (!target) return [];
    const p = news.presence;
    // any: every known agent client (online or not): the first to start the request takes it.
    const clients = target === ANY ? p.all().map((a) => a.id) : [target];
    const summary = assignedSummary(f, how);
    for (const c of clients) await news.addClientWide(c, ASSIGNED_KIND, reqRef(f.id), summary);
    return clients;
  } catch {
    return [];
  }
}

/** An agent connected: deliver the queued requests assigned to it, or to any agent, it was not told about yet. */
export async function catchUpAssigned(news: NewsService, client: string, list: () => Promise<Feedback[]>): Promise<number> {
  const queued = (await list()).filter((f) => isQueued(f) && (f.assignee === ANY || f.assignee === client));
  if (!queued.length) return 0;
  const seen = await news.store.items(news.project, client);
  let n = 0;
  for (const f of queued) {
    // A specific assignee already has its item stored (delivered on connect by the stream); `any` once per client.
    if (f.assignee !== ANY) continue;
    if (seen.some((i) => i.kind === ASSIGNED_KIND && i.ref === reqRef(f.id) && i.at >= (f.assignedAt ?? ''))) continue;
    await news.addClientWide(client, ASSIGNED_KIND, reqRef(f.id), assignedSummary(f, 'new'));
    n++;
  }
  return n;
}

/** Will an idle agent be woken by the assignment (an event stream is connected for it / one of the told agents)? Otherwise it sees the request on its next tool reply (flow_next {}). */
export function wakeableAny(news: NewsService | null | undefined, assignee: string, delivered: string[]): boolean {
  const p = news?.presence;
  if (!p) return false;
  return (assignee === ANY ? delivered : [assignee]).some((c) => p.isWakeable(c));
}
