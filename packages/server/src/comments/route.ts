/**
 * Comment routing: who is woken by a comment. Delivery is a news item (kind `comment_added`) for the addressee's client,
 * which the event stream / channel pushes (mcp/events.ts).
 *
 * Addressees, first match wins per layer: explicit `to` (a handle; `any` = every online agent, first reply takes it),
 * then `@mentions` that name a known agent / user, then the agents already in the thread (a conversation continues
 * without mentions), then the RESPONSIBLE agent: the holder of the claim on the related work order, else the agent
 * running the related request. Nobody: no wake (the comment is visible on the object; the UI offers a picker).
 * The writer itself is never woken.
 */
import { isClaimStale, parseCommentTarget, type CommentRecord, type CommentThread, type CommentView, type Feedback, type WorkOrder } from '@mandate/shared';
import type { AgentPresence } from '../agents/presence.js';
import { clientIdentity } from '../projects/settings.js';
import { newsFallback, type NewsService } from '../news/index.js';
import { UI_AGENT, type ToolContext } from '../mcp/define.js';

export const COMMENT_KIND = 'comment_added';
export const ANY = 'any';

export type RouteVia = 'to' | 'mention' | 'thread' | 'responsible' | 'any' | 'none';
export interface Routing {
  via: RouteVia;
  /** Client ids to wake. */
  clients: string[];
}

export interface RouteState {
  presence: AgentPresence;
  workOrders: WorkOrder[];
  requests: Pick<Feedback, 'id' | 'createdBy' | 'createdByUser' | 'status' | 'relatedTo'>[];
}

const isHuman = (a: { agent: string }) => a.agent === UI_AGENT;

/** The agents responsible for an object: [{ agent, user? }] (claim holder of its work order, else the request's agent). */
export function responsibleFor(target: string, st: RouteState): { agent: string; user?: string }[] {
  const t = parseCommentTarget(target);
  if (!t) return [];
  const claimOf = (w: WorkOrder) => (w.claim && !isClaimStale(w.claim) ? [{ agent: w.claim.agent, ...((w.claim as { user?: string }).user ? { user: (w.claim as { user?: string }).user } : {}) }] : []);
  const openWos = st.workOrders.filter((w) => w.status === 'pending' || w.status === 'in_progress');
  const requestAgent = (id: string) => {
    const r = st.requests.find((x) => x.id === id && x.status !== 'closed');
    return r?.createdBy ? [{ agent: r.createdBy, ...(r.createdByUser ? { user: r.createdByUser } : {}) }] : [];
  };
  if (t.kind === 'work-orders') {
    const w = st.workOrders.find((x) => x.id === t.id);
    if (!w) return [];
    const c = claimOf(w);
    return c.length ? c : w.reason.flatMap((id) => requestAgent(id)).slice(0, 1);
  }
  if (t.kind === 'requests') {
    const c = openWos.filter((w) => w.reason.includes(t.id)).flatMap(claimOf);
    return c.length ? c.slice(0, 1) : requestAgent(t.id);
  }
  if (t.kind === 'specs') {
    return openWos
      .filter((w) => w.spec === t.id && (!t.sectionId || w.sections.some((s) => s.id === t.sectionId)))
      .flatMap(claimOf)
      .slice(0, 1);
  }
  return [];
}

/** Who the comment `c` (the last of `thread`) addresses. */
export function routeOf(c: CommentView | CommentRecord, thread: CommentThread, st: RouteState): Routing {
  const p = st.presence;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const author = clientsOfAuthor(c.author, p);
  const wake = (ids: string[]) => uniq(ids).filter((id) => !author.includes(id));
  const to = (c as CommentRecord).to ?? thread.to;
  const agentInThread = [thread, ...thread.replies].some((m) => m.id !== c.id && !isHuman(m.author));
  if (to === ANY && !agentInThread) {
    const online = p.all().filter((a) => p.isOnline(a.id)).map((a) => a.id);
    return { via: 'any', clients: wake(online) };
  }
  if (to && to !== ANY) {
    const ids = wake(p.resolve(to));
    if (ids.length) return { via: 'to', clients: ids };
  }
  const named = wake((c.mentions ?? []).flatMap((m) => p.resolve(m)));
  if (named.length) return { via: 'mention', clients: named };
  const all = [thread, ...thread.replies];
  const inThread = wake(all.filter((m) => m.id !== c.id && !isHuman(m.author)).flatMap((m) => clientsOfAuthor(m.author, p)));
  if (inThread.length) return { via: 'thread', clients: inThread };
  const resp = wake(responsibleFor(thread.target, st).flatMap((r) => p.clientsOfAgent(r.agent, r.user)));
  if (resp.length) return { via: 'responsible', clients: resp };
  return { via: 'none', clients: [] };
}

function clientsOfAuthor(a: { agent: string; user?: string }, p: AgentPresence): string[] {
  return isHuman(a) ? [] : p.clientsOfAgent(a.agent, a.user);
}

/** Open threads waiting for `client`: the last message is not its own and routes to it (or is `any` and no agent replied yet). */
export function unansweredFor(client: string, threads: CommentThread[], st: RouteState): CommentThread[] {
  const out: CommentThread[] = [];
  for (const t of threads) {
    if (t.status !== 'open') continue;
    const msgs = [t, ...t.replies];
    const last = msgs[msgs.length - 1]!;
    if (clientsOfAuthor(last.author, st.presence).includes(client)) continue;
    const r = routeOf(last, t, st);
    const anyOpen = (t.to === ANY || r.via === 'any') && !msgs.some((m) => !isHuman(m.author));
    if (r.clients.includes(client) || anyOpen) out.push(t);
  }
  return out;
}

const clip = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? `${s.replace(/\s+/g, ' ').trim().slice(0, n - 1)}…` : s.replace(/\s+/g, ' ').trim());
export const shortTarget = (t: string) => t.replace('mandate://', '');

/** The news summary: the thread so far (root first, the last messages), so the receiver can answer without a read. */
export function summaryOf(thread: CommentThread, c: CommentRecord | CommentView, asRequest: boolean): string {
  const msgs = [thread, ...thread.replies];
  const shown = msgs.slice(-3);
  const who = (m: CommentView) => (isHuman(m.author) ? m.author.user ?? 'user' : m.author.agent);
  const lines = shown.map((m) => `${who(m)}: ${clip(m.body, shown.length === 1 ? 240 : 110)}`).join(' | ');
  return `comment on ${shortTarget(thread.target)} (thread ${thread.id}${thread.replies.length ? `, ${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}` : ''}${thread.blocking ? ', blocking' : ''}${asRequest ? ', make it a request' : ''}): ${lines}`.slice(0, 480) + (c ? '' : '');
}

export function newsOfProject(ctx: ToolContext): NewsService | null {
  return ctx.news ?? (ctx.settings && ctx.activity ? newsFallback(ctx.settings.project, ctx.activity) : ctx.activity ? newsFallback(ctx.project?.id ?? 'project', ctx.activity) : null);
}

export async function routeState(ctx: ToolContext, presence: AgentPresence): Promise<RouteState> {
  const [workOrders, requests] = await Promise.all([ctx.storage.workOrderService.list(), ctx.storage.feedbackService.list()]);
  return { presence, workOrders, requests };
}

/** After a comment was stored: wake its addressees. Never fails the write. */
export async function deliverComment(ctx: ToolContext, c: CommentRecord, thread: CommentThread): Promise<Routing> {
  const news = newsOfProject(ctx);
  if (!news) return { via: 'none', clients: [] };
  try {
    // The writer is known to the directory (an agent client's call); a UI author is a person, never an addressee.
    if (ctx.principal && ctx.principal.kind !== 'ui') news.presence.note(clientIdentity(ctx), ctx.commit?.agent);
    const r = routeOf(c, thread, await routeState(ctx, news.presence));
    const asRequest = !!c.asRequest || !!thread.asRequest;
    const summary = summaryOf(thread, c, asRequest);
    for (const client of r.clients) await news.addClientWide(client, COMMENT_KIND, `mandate://comments/${c.id}`, summary);
    return r;
  } catch {
    return { via: 'none', clients: [] };
  }
}
