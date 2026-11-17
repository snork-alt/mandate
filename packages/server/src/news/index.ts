/**
 * Per-client news feed: what changed in a coding agent client's OWN work since it last looked (its questions answered,
 * its claimed work orders cancelled / taken over, its feedback closed, comments on its work, drift of the sections it
 * works on, audit findings there, its flow settings changed). Every MCP reply to an agent client carries the unread
 * items as a top-level `news` field (define.ts `callTool`); `news_list` is the history, `news_ack` acknowledges.
 *
 * Sources: the activity events (ActivityBus, derived from git) — no new data in the repo. What a client "owns" is
 * recorded when it writes (`WATCH_TOOLS`: question_ask, feedback_create, work_order_claim / next, comment_add, waivers,
 * draft standards, self-approval overrides), as
 * watched refs; an event whose subject is a watched ref, made by someone else, becomes an item (`NEWS_RULES`; a new kind
 * is one rule). Flow settings changes are detected per call (the effective setting differs from the last one seen).
 * Claims that went stale (no heartbeat, `isClaimStale`) have no event: `sweepStaleClaims` finds them (agent calls, at
 * most once a minute) and tells the claiming session once per claim (`claim_expired`). Completing an implement /
 * update / fix work order leaves an `implemented` watch on its sections, so a later review / verify work order there
 * reports its outcome to the implementer (`review_outcome`: approved / changes requested / findings).
 *
 * Storage: the server-state database (scope `news`), per project and client id (`clientIdentity`).
 * Sessions: the MCP session id (Streamable HTTP `mcp-session-id`) identifies a session. Items go to the session that
 * asked / claimed (the watch's session); client-wide items (flow changes) have no session and reach every session.
 * When the owning session is gone (closed, or unknown after a restart), its unread items and watches move to the next
 * session of the same client that calls Mandate.
 * Read rule: an item stays unread until the client reads the referenced item (a read tool whose `ref` / `uri` / id
 * names it or a parent, e.g. question_get, work_order_get, spec_get; questions_list returning the answered question) or
 * acknowledges it (news_ack). Being shown in a reply does not mark it read.
 */
import { AgentPresence } from '../agents/presence.js';
import { isClaimStale, OPEN_WORK_ORDER_STATUSES, type ActivityEvent, type WorkOrder } from '@mandate/shared';
import { buildQuestionRef, buildRef, type RefKind } from '@mandate/shared/refs';
import type { Db, Dialect } from '../db/types.js';
import { migrate, type Migration } from '../db/migrate.js';

export interface NewsWatch {
  client: string;
  ref: string;
  /** MCP session that asked / claimed (null: client-wide). */
  session: string | null;
  /** Agent name and user of the watcher's writes (its own events are not news). */
  agent: string;
  user: string | null;
  role: string;
}

export interface NewsItem {
  seq: number;
  client: string;
  session: string | null;
  eventId: string;
  kind: string;
  ref: string;
  summary: string;
  at: string;
  readAt: string | null;
  /** Push delivery (events stream / pending): the consumer that claimed it and when (null: not pushed yet). */
  pushedTo?: string | null;
  pushedAt?: string | null;
}

export interface NewsQuery {
  unread?: boolean;
}

export interface NewsStore {
  watch(project: string, w: NewsWatch): Promise<void>;
  unwatch(project: string, client: string, refs: string[]): Promise<void>;
  watchers(project: string, refs: string[]): Promise<NewsWatch[]>;
  /** Insert an item (deduplicated by client + event id); null when it already existed. */
  add(project: string, item: Omit<NewsItem, 'seq' | 'readAt'>): Promise<NewsItem | null>;
  /** A client's items, newest first (filters applied by the caller). */
  items(project: string, client: string, q?: NewsQuery): Promise<NewsItem[]>;
  markRead(project: string, client: string, seqs: number[], at?: Date): Promise<number>;
  /**
   * Claim items for push delivery to `consumer` (the events stream or a catch-up): only unread items that are not
   * claimed by another consumer, or whose claim is older than `staleBefore` (ISO), are taken. Atomic per item, so two
   * streams of one client never both deliver an item. Returns the seqs claimed.
   */
  claim(project: string, client: string, seqs: number[], consumer: string, staleBefore: string, at?: Date): Promise<number[]>;
  /** Move a gone session's unread items and watches to another session. */
  adopt(project: string, client: string, from: string, to: string): Promise<void>;
  flowSig(project: string, client: string): Promise<string | undefined>;
  setFlowSig(project: string, client: string, sig: string): Promise<void>;
}

/* ------------------------------------------------------------------ rules */

/** Watched refs recorded when an agent client writes (from the tool's result). `unwatch`: the work is over. */
export const WATCH_TOOLS: Record<
  string,
  {
    role: string;
    refs: (r: Record<string, any>, args: Record<string, any>) => string[];
    unwatch?: boolean;
    /** After the unwatch: refs watched with another role (completed implementation -> its review outcomes). */
    then?: { role: string; refs: (r: Record<string, any>) => string[] };
  }
> = {
  question_ask: { role: 'asked', refs: (r) => [r.ref] },
  // Decisions the user takes on things the agent caused (the Actions list): its draft standard.
  standard_create: { role: 'drafted', refs: (r) => [r.ref] },
  request_create: { role: 'created', refs: (r) => [r.ref] },
  feedback_create: { role: 'created', refs: (r) => [r.ref] },
  work_order_claim: { role: 'claimed', refs: (r) => workOrderRefs(r) },
  work_order_next: { role: 'claimed', refs: (r) => workOrderRefs(r) },
  comment_add: { role: 'commented', refs: (r) => [r.comment?.target ?? r.target].filter(Boolean) },
  work_order_complete: { role: 'claimed', refs: (r) => workOrderRefs(r), unwatch: true, then: { role: 'implemented', refs: (r) => (IMPLEMENTING.has(workOrderOf(r)?.kind ?? '') ? workOrderRefs(r).filter((x) => x.includes('/sections/')) : []) } },
  work_order_release: { role: 'claimed', refs: (r) => workOrderRefs(r), unwatch: true },
  work_order_cancel: { role: 'claimed', refs: (r) => workOrderRefs(r), unwatch: true },
  work_order_fail: { role: 'claimed', refs: (r) => workOrderRefs(r), unwatch: true },
};

/** Work-order kinds whose sections a later review / verify work order judges. */
const IMPLEMENTING = new Set(['implement', 'update', 'fix']);

/** The work order of a tool result: flat (`{ spec, sections, kind }`) or as work_order_get resolves it (`{ item, spec: {...}, sections }`). */
function workOrderOf(r: Record<string, any>): { spec?: string; kind?: string; sections: { id: string }[] } | null {
  const w = r.workOrder as Record<string, any> | null | undefined;
  if (!w) return null;
  const item = (w.item ?? w) as Record<string, any>;
  const spec = typeof item.spec === 'string' ? item.spec : typeof w.spec?.id === 'string' ? (w.spec.id as string) : undefined;
  return { spec, kind: item.kind, sections: (item.sections ?? w.sections ?? []) as { id: string }[] };
}

function workOrderRefs(r: Record<string, any>): string[] {
  const w = workOrderOf(r);
  const out = typeof r.ref === 'string' ? [r.ref] : [];
  if (w?.spec) for (const s of w.sections) out.push(buildRef({ kind: 'specs', id: w.spec, sectionId: s.id }));
  return out;
}

export interface NewsRule {
  kind: string;
  /** Activity event types (exact, or a prefix ending in '.'). */
  types: string[];
  /** The refs of the event a watch must match (default: its main subject, refs[0]). */
  subjects?: (e: ActivityEvent) => string[];
  /** Only watches of these roles. */
  roles?: string[];
  /** Only events this accepts. */
  when?: (e: ActivityEvent) => boolean;
  /** The item's ref (default: the matching watched ref) and summary (default: the event's). */
  ref?: (e: ActivityEvent) => string;
  summary?: (e: ActivityEvent) => string;
}

/** A completed / failed review or verify work order: its verdict (set by derive.ts on the event). */
export interface ReviewOutcome {
  verdict: 'approved' | 'changes_requested' | 'findings';
  workOrder: string;
  kind: string;
  note?: string;
  comments?: number;
  blocking?: number;
}
const reviewOf = (e: ActivityEvent) => (e.details?.review ?? null) as ReviewOutcome | null;
const VERDICT: Record<ReviewOutcome['verdict'], string> = { approved: 'approved', changes_requested: 'changes requested on', findings: 'findings on' };
function reviewSummary(e: ActivityEvent): string {
  const r = reviewOf(e)!;
  const counts = r.comments ? ` (${r.comments} comment${r.comments === 1 ? '' : 's'}${r.blocking ? `, ${r.blocking} blocking` : ''})` : '';
  const head = r.verdict === 'approved' ? `${r.kind} ${r.workOrder} approved your work` : `${VERDICT[r.verdict]} your work (${r.kind} ${r.workOrder})`;
  return `${head[0]!.toUpperCase()}${head.slice(1)}${counts}${r.note ? `: ${r.note.slice(0, 200)}` : ''}`;
}

const subject = (e: ActivityEvent) => e.refs.slice(0, 1);
const related = (e: ActivityEvent) => e.refs.slice(1);
const SECTION_TYPES = ['spec', 'standard', 'component'].flatMap((k) => [`${k}.section.updated`, `${k}.section.deleted`, `${k}.section.moved`]);

/** Event → news item rules. A new kind of news is one entry. */
export const NEWS_RULES: NewsRule[] = [
  { kind: 'question_answered', types: ['question.answered'], roles: ['asked'] },
  { kind: 'question_closed', types: ['question.cancelled'], roles: ['asked'] },
  { kind: 'standard_draft_decided', types: ['standard.status_changed', 'standard.deleted'], roles: ['drafted'] },
  { kind: 'claim_released', types: ['work_order.released'], roles: ['claimed'] },
  { kind: 'work_order_changed', types: ['work_order.status_changed', 'work_order.released', 'work_order.claimed', 'work_order.updated', 'work_order.deleted', 'work_order.completed'], roles: ['claimed'] },
  { kind: 'request_changed', types: ['request.closed', 'request.updated', 'request.deleted'], roles: ['created'] },
  { kind: 'comment', types: ['comment.resolved', 'comment.reopened'], subjects: related },
  { kind: 'drift', types: SECTION_TYPES, roles: ['claimed'] },
  { kind: 'audit_finding', types: ['audit.item_recorded'], subjects: related, roles: ['claimed'] },
  {
    kind: 'review_outcome',
    types: ['work_order.completed', 'work_order.status_changed'],
    subjects: (e) => e.refs.filter((r) => r.includes('/sections/')),
    roles: ['implemented'],
    when: (e) => !!reviewOf(e),
    ref: (e) => e.refs[0]!,
    summary: reviewSummary,
  },
];
/** Items without an event (eventId prefix): a claim that went stale. */
export const CLAIM_EXPIRED = 'claim_expired';
/** Min ms between two stale-claim sweeps of a project. */
export const CLAIM_SWEEP_EVERY_MS = 60_000;

const typeMatches = (t: string, p: string) => (p.endsWith('.') ? t.startsWith(p) : t === p);

/** Refs a read tool call names (reading them marks matching news read). */
const ID_KINDS: Record<string, RefKind | 'questions'> = { question_get: 'questions', work_order_get: 'work-orders', request_get: 'feedback', feedback_get: 'feedback', audit_get: 'audits' };
export function readRefs(tool: string, args: Record<string, unknown>, result: Record<string, any> | undefined): string[] {
  const out: string[] = [];
  const norm = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/^@mandate:/, '').replace(/#.*$/, '') : '');
  for (const k of ['ref', 'uri']) if (norm(args[k])) out.push(norm(args[k]));
  const kind = ID_KINDS[tool];
  if (kind && typeof args.id === 'string') out.push(kind === 'questions' ? buildQuestionRef(args.id) : buildRef({ kind, id: args.id }));
  // Starting / resuming a request reads its request_assigned items.
  if (tool === 'flow_next' && typeof args.request === 'string') out.push(`mandate://requests/${args.request.trim().replace(/^@mandate:/, '').replace(/^mandate:\/\/(?:requests|feedback)\//, '')}`);
  // Reading (or replying in) a comment thread reads its comment_added items.
  const threadsOf = (tool === 'comments_list' || (tool === 'list' && args.of === 'comments') ? result?.threads : tool === 'comment_add' || tool === 'comment_resolve' || tool === 'comment_reopen' ? [result?.thread] : []) ?? [];
  for (const t of threadsOf as ({ uri?: string; replies?: { uri?: string }[] } | null)[]) if (t) for (const m of [t, ...(t.replies ?? [])]) if (m.uri) out.push(m.uri);
  if (tool === 'questions_list') for (const q of (result?.items ?? []) as { uri?: string; status?: string }[]) if (q.uri && q.status !== 'open') out.push(q.uri);
  return out;
}

/* ------------------------------------------------------------------ service */

/** Max items shown in a reply notice. */
export const NEWS_NOTICE_MAX = 10;
/** An item pushed to a consumer but still unread after this long is pushed again (to anyone asking). */
export const PUSH_REDELIVER_MS = 10 * 60_000;
/** Max seconds a news_list call may wait. */
export const NEWS_WAIT_MAX = 300;

export interface ReplyNews {
  message: string;
  items: { id: number; kind: string; ref: string; summary: string; at: string }[];
  more?: number;
}

export class NewsService {
  /** Who is connected / busy (agents/presence.ts). */
  readonly presence = new AgentPresence();
  private chain: Promise<unknown> = Promise.resolve();
  /** Live MCP sessions (registered on their calls; `closed` set by the transport). */
  private readonly live = new Map<string, { closed?: boolean }>();
  private readonly waiters = new Set<{ client: string; session: string | null; wake: () => void }>();
  /** Push consumers (events streams): called whenever an item is added for the client. */
  private readonly listeners = new Set<{ client: string; fn: () => void }>();

  constructor(
    readonly project: string,
    readonly store: NewsStore,
    bus?: { subscribe(fn: (e: ActivityEvent) => void): () => void } | null,
  ) {
    bus?.subscribe((e) => {
      this.chain = this.chain.then(() => this.ingest(e)).catch(() => undefined);
    });
  }

  /** Ingestion finished (tests). */
  idle(): Promise<unknown> {
    return this.chain;
  }

  touch(session: string | null, state?: { closed?: boolean }) {
    if (session && state) this.live.set(session, state);
  }

  private alive(session: string | null): boolean {
    if (!session) return true;
    const s = this.live.get(session);
    return !!s && !s.closed;
  }

  async ingest(e: ActivityEvent): Promise<void> {
    if (e.heartbeat) return;
    for (const rule of NEWS_RULES) {
      if (!rule.types.some((p) => typeMatches(e.type, p))) continue;
      if (rule.when && !rule.when(e)) continue;
      const subjects = (rule.subjects ?? subject)(e);
      if (!subjects.length) continue;
      const ws = await this.store.watchers(this.project, subjects);
      for (const w of ws) {
        if (rule.roles && !rule.roles.includes(w.role)) continue;
        if (e.agent === w.agent && (e.user ?? null) === w.user) continue; // its own write
        const item = await this.store.add(this.project, { client: w.client, session: w.session, eventId: e.id, kind: rule.kind, ref: rule.ref?.(e) ?? w.ref, summary: rule.summary?.(e) ?? e.summary, at: e.at });
        if (item) this.wake(w.client, w.session);
      }
    }
  }

  private lastSweep = 0;
  /**
   * Claims that went stale have no event: tell the claiming session (its `claimed` watch, same agent) once per claim
   * (`claim_expired:<work order>:<claim start>`). At most once per CLAIM_SWEEP_EVERY_MS unless `force`.
   */
  async sweepStaleClaims(list: () => Promise<WorkOrder[]>, opts: { now?: number; force?: boolean } = {}): Promise<number> {
    const now = opts.now ?? Date.now();
    if (!opts.force && now - this.lastSweep < CLAIM_SWEEP_EVERY_MS) return 0;
    this.lastSweep = now;
    const open = new Set<string>(OPEN_WORK_ORDER_STATUSES);
    const stale = (await list()).filter((w) => open.has(w.status) && w.claim && isClaimStale(w.claim, now));
    if (!stale.length) return 0;
    const byRef = new Map(stale.map((w) => [buildRef({ kind: 'work-orders', id: w.id }), w] as const));
    let added = 0;
    for (const watch of await this.store.watchers(this.project, [...byRef.keys()])) {
      const w = byRef.get(watch.ref)!;
      if (watch.role !== 'claimed' || watch.agent !== w.claim!.agent) continue;
      const item = await this.store.add(this.project, {
        client: watch.client,
        session: watch.session,
        eventId: `${CLAIM_EXPIRED}:${w.id}:${w.claim!.startedAt}`,
        kind: CLAIM_EXPIRED,
        ref: watch.ref,
        summary: `Your claim on ${w.id}${w.title ? ` (${w.title})` : ''} expired: no heartbeat since ${w.claim!.heartbeatAt}; another agent may take it over. Claim it again (work_order_claim) to continue, or release it.`,
        at: new Date(now).toISOString(),
      });
      if (item) {
        added++;
        this.wake(watch.client, watch.session);
      }
    }
    return added;
  }

  /** A client-wide item (no event: e.g. the flow settings changed). */
  async addClientWide(client: string, kind: string, ref: string, summary: string): Promise<void> {
    const item = await this.store.add(this.project, { client, session: null, eventId: `${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind, ref, summary, at: new Date().toISOString() });
    if (item) this.wake(client, null);
  }

  /** Call `fn` whenever an item is added for `client` (any session); returns the unsubscribe. */
  onItems(client: string, fn: () => void): () => void {
    const l = { client, fn };
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /**
   * Items to push to `consumer` (events stream, catch-up): unread, after `since`, oldest first, across all of the
   * client's sessions; each is claimed (store.claim) so it goes to one consumer only. `peek`: no claiming.
   */
  async pushable(client: string, consumer: string, o: { since?: number; peek?: boolean; limit?: number } = {}): Promise<NewsItem[]> {
    const since = o.since ?? 0;
    const staleBefore = new Date(Date.now() - PUSH_REDELIVER_MS).toISOString();
    const items = (await this.store.items(this.project, client, { unread: true })).filter((i) => i.seq > since).sort((a, b) => a.seq - b.seq).slice(0, o.limit ?? 100);
    if (o.peek) return items;
    const eligible = items.filter((i) => !i.pushedTo || i.pushedTo === consumer || (i.pushedAt ?? '') < staleBefore);
    if (!eligible.length) return [];
    const won = new Set(await this.store.claim(this.project, client, eligible.map((i) => i.seq), consumer, staleBefore));
    return eligible.filter((i) => won.has(i.seq));
  }

  private wake(client: string, session: string | null) {
    for (const l of [...this.listeners]) if (l.client === client) l.fn();
    for (const w of [...this.waiters]) if (w.client === client && (session === null || w.session === null || w.session === session || !this.alive(session))) w.wake();
  }

  async watch(w: NewsWatch) {
    await this.store.watch(this.project, w);
  }
  async unwatch(client: string, refs: string[]) {
    if (refs.length) await this.store.unwatch(this.project, client, refs);
  }

  /** The items a session sees: its own, client-wide, and (adopted) those of gone sessions of the client. */
  async forSession(client: string, session: string | null, q: { unread?: boolean; all?: boolean } = {}): Promise<NewsItem[]> {
    const items = await this.store.items(this.project, client, { unread: q.unread });
    if (q.all || session === null) return items;
    const gone = new Set<string>();
    for (const i of items) if (i.session && i.session !== session && !i.readAt && !this.alive(i.session)) gone.add(i.session);
    for (const g of gone) await this.store.adopt(this.project, client, g, session);
    return items
      .map((i) => (i.session && gone.has(i.session) ? { ...i, session } : i))
      .filter((i) => i.session === null || i.session === session);
  }

  async markReadRefs(client: string, refs: string[]): Promise<number> {
    if (!refs.length) return 0;
    const unread = await this.store.items(this.project, client, { unread: true });
    const hit = unread.filter((i) => refs.some((r) => i.ref === r || i.ref.startsWith(`${r}/`))).map((i) => i.seq);
    return hit.length ? this.store.markRead(this.project, client, hit) : 0;
  }

  async ack(client: string, session: string | null, a: { ids?: number[]; all?: boolean }): Promise<number> {
    const mine = await this.forSession(client, session, { unread: true });
    const seqs = a.all ? mine.map((i) => i.seq) : mine.filter((i) => a.ids?.includes(i.seq)).map((i) => i.seq);
    return seqs.length ? this.store.markRead(this.project, client, seqs) : 0;
  }

  /** The reply notice for a session (null when nothing is unread). */
  async notice(client: string, session: string | null): Promise<ReplyNews | null> {
    const unread = await this.forSession(client, session, { unread: true });
    if (!unread.length) return null;
    const shown = unread.slice(0, NEWS_NOTICE_MAX);
    const more = unread.length - shown.length;
    const lines = shown.map((i) => `- #${i.seq} ${i.kind}: ${i.summary} (${i.ref})`);
    const message = [
      `Mandate news about your work (${unread.length} unread). Act on it before continuing: answered question → get it and continue the blocked work; work order cancelled / taken over → stop that work; findings / changes → address them; flow changed → follow the new instructions and update your memory. Each item stays until you read its ref or news_ack it.`,
      ...lines,
      ...(more ? [`…and ${more} more: news_list {"unread":true}`] : []),
    ].join('\n');
    return { message, items: shown.map((i) => ({ id: i.seq, kind: i.kind, ref: i.ref, summary: i.summary, at: i.at })), ...(more ? { more } : {}) };
  }

  /** Resolve when unread news reaches this session / client, or after `ms` (false), or on abort (false). */
  async waitFor(client: string, session: string | null, ms: number, signal?: AbortSignal, onTick?: (elapsedMs: number) => void): Promise<boolean> {
    if ((await this.forSession(client, session, { unread: true })).length) return true;
    if (ms <= 0 || signal?.aborted) return false;
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const w = { client, session, wake: () => done(true) };
      const timer = setTimeout(() => done(false), ms);
      const tick = onTick ? setInterval(() => onTick(Date.now() - start), 15_000) : undefined;
      const onAbort = () => done(false);
      function done(v: boolean) {
        clearTimeout(timer);
        if (tick) clearInterval(tick);
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(w);
        resolve(v);
      }
      const waiters = this.waiters;
      waiters.add(w);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Waiting calls (tests). */
  waiting(): number {
    return this.waiters.size;
  }
}

/* ------------------------------------------------------------------ stores */

export class MemoryNewsStore implements NewsStore {
  private readonly watches = new Map<string, NewsWatch & { project: string }>();
  private readonly rows: (NewsItem & { project: string })[] = [];
  private readonly sigs = new Map<string, string>();
  private seq = 0;
  async watch(project: string, w: NewsWatch) {
    this.watches.set(`${project}\u0000${w.client}\u0000${w.ref}`, { ...w, project });
  }
  async unwatch(project: string, client: string, refs: string[]) {
    for (const r of refs) this.watches.delete(`${project}\u0000${client}\u0000${r}`);
  }
  async watchers(project: string, refs: string[]) {
    return [...this.watches.values()].filter((w) => w.project === project && refs.includes(w.ref)).map(({ project: _p, ...w }) => w);
  }
  async add(project: string, item: Omit<NewsItem, 'seq' | 'readAt'>) {
    if (this.rows.some((r) => r.project === project && r.client === item.client && r.eventId === item.eventId)) return null;
    const row = { ...item, project, seq: ++this.seq, readAt: null };
    this.rows.push(row);
    const { project: _p, ...out } = row;
    return out;
  }
  async items(project: string, client: string, q: NewsQuery = {}) {
    return this.rows
      .filter((r) => r.project === project && r.client === client && (!q.unread || !r.readAt))
      .map(({ project: _p, ...r }) => ({ ...r }))
      .sort((a, b) => b.seq - a.seq);
  }
  async markRead(project: string, client: string, seqs: number[], at = new Date()) {
    let n = 0;
    for (const r of this.rows) if (r.project === project && r.client === client && seqs.includes(r.seq) && !r.readAt) (r.readAt = at.toISOString()), n++;
    return n;
  }
  async claim(project: string, client: string, seqs: number[], consumer: string, staleBefore: string, at = new Date()) {
    const out: number[] = [];
    for (const r of this.rows) {
      if (r.project !== project || r.client !== client || !seqs.includes(r.seq) || r.readAt) continue;
      if (r.pushedTo && r.pushedTo !== consumer && (r.pushedAt ?? '') >= staleBefore) continue;
      r.pushedTo = consumer;
      r.pushedAt = at.toISOString();
      out.push(r.seq);
    }
    return out;
  }
  async adopt(project: string, client: string, from: string, to: string) {
    for (const r of this.rows) if (r.project === project && r.client === client && r.session === from && !r.readAt) r.session = to;
    for (const w of this.watches.values()) if (w.project === project && w.client === client && w.session === from) w.session = to;
  }
  async flowSig(project: string, client: string) {
    return this.sigs.get(`${project}\u0000${client}`);
  }
  async setFlowSig(project: string, client: string, sig: string) {
    this.sigs.set(`${project}\u0000${client}`, sig);
  }
}

const newsSchemaV1 = (d: Dialect) => `
CREATE TABLE IF NOT EXISTS ${d.table('news_watch')} (
  project TEXT NOT NULL, client_id TEXT NOT NULL, ref TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL, user_login TEXT, role TEXT NOT NULL,
  created_at ${d.types.bigint} NOT NULL,
  PRIMARY KEY (project, client_id, ref)
);
CREATE INDEX IF NOT EXISTS ${d.index('news_watch_ref')} ON ${d.table('news_watch')} (project, ref);
CREATE TABLE IF NOT EXISTS ${d.table('news_items')} (
  project TEXT NOT NULL, client_id TEXT NOT NULL, seq ${d.types.bigint} NOT NULL, session_id TEXT, event_id TEXT NOT NULL,
  kind TEXT NOT NULL, ref TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL, read_at TEXT,
  PRIMARY KEY (project, client_id, event_id)
);
CREATE INDEX IF NOT EXISTS ${d.index('news_items_client')} ON ${d.table('news_items')} (project, client_id, seq);
CREATE TABLE IF NOT EXISTS ${d.table('news_flow')} (
  project TEXT NOT NULL, client_id TEXT NOT NULL, sig TEXT NOT NULL,
  PRIMARY KEY (project, client_id)
);
`;
const newsSchemaV2 = (d: Dialect) => `
ALTER TABLE ${d.table('news_items')} ADD COLUMN pushed_to TEXT;
ALTER TABLE ${d.table('news_items')} ADD COLUMN pushed_at TEXT;
`;
export const NEWS_MIGRATIONS: Migration[] = [
  { id: 1, name: 'news feed', sqlite: newsSchemaV1, postgres: newsSchemaV1 },
  { id: 2, name: 'news push delivery', sqlite: newsSchemaV2, postgres: newsSchemaV2 },
];

interface ItemRow {
  client_id: string;
  seq: number | string;
  session_id: string | null;
  event_id: string;
  kind: string;
  ref: string;
  summary: string;
  at: string;
  read_at: string | null;
  pushed_to?: string | null;
  pushed_at?: string | null;
}
const fromItem = (r: ItemRow): NewsItem => ({ seq: Number(r.seq), client: r.client_id, session: r.session_id, eventId: r.event_id, kind: r.kind, ref: r.ref, summary: r.summary, at: r.at, readAt: r.read_at, pushedTo: r.pushed_to ?? null, pushedAt: r.pushed_at ?? null });

/** News on the server-state database (migration scope `news`). */
export class DbNewsStore implements NewsStore {
  private readonly ready: Promise<unknown>;
  constructor(readonly db: Db) {
    this.ready = migrate(db, 'news', NEWS_MIGRATIONS);
  }
  private t(n: string) {
    return this.db.dialect.table(n);
  }
  async watch(project: string, w: NewsWatch) {
    await this.ready;
    await this.db.run(this.db.dialect.upsert('news_watch', ['project', 'client_id', 'ref', 'session_id', 'agent', 'user_login', 'role', 'created_at'], ['project', 'client_id', 'ref'], ['session_id', 'agent', 'user_login', 'role']), [
      project,
      w.client,
      w.ref,
      w.session,
      w.agent,
      w.user,
      w.role,
      Date.now(),
    ]);
  }
  async unwatch(project: string, client: string, refs: string[]) {
    await this.ready;
    for (const r of refs) await this.db.run(`DELETE FROM ${this.t('news_watch')} WHERE project = ? AND client_id = ? AND ref = ?`, [project, client, r]);
  }
  async watchers(project: string, refs: string[]) {
    await this.ready;
    if (!refs.length) return [];
    const rows = await this.db.all<{ client_id: string; ref: string; session_id: string | null; agent: string; user_login: string | null; role: string }>(
      `SELECT * FROM ${this.t('news_watch')} WHERE project = ? AND ref IN (${refs.map(() => '?').join(', ')})`,
      [project, ...refs],
    );
    return rows.map((r) => ({ client: r.client_id, ref: r.ref, session: r.session_id, agent: r.agent, user: r.user_login, role: r.role }));
  }
  async add(project: string, item: Omit<NewsItem, 'seq' | 'readAt'>) {
    await this.ready;
    return this.db.withLock(`news:${project}`, async (q) => {
      const dup = await q.get(`SELECT seq FROM ${this.t('news_items')} WHERE project = ? AND client_id = ? AND event_id = ?`, [project, item.client, item.eventId]);
      if (dup) return null;
      const max = await q.get<{ m: number | string | null }>(`SELECT MAX(seq) AS m FROM ${this.t('news_items')} WHERE project = ?`, [project]);
      const seq = Number(max?.m ?? 0) + 1;
      await q.run(`INSERT INTO ${this.t('news_items')} (project, client_id, seq, session_id, event_id, kind, ref, summary, at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
        project,
        item.client,
        seq,
        item.session,
        item.eventId,
        item.kind,
        item.ref,
        item.summary.slice(0, 500),
        item.at,
      ]);
      return { ...item, seq, readAt: null };
    });
  }
  async items(project: string, client: string, q: NewsQuery = {}) {
    await this.ready;
    const rows = await this.db.all<ItemRow>(`SELECT * FROM ${this.t('news_items')} WHERE project = ? AND client_id = ?${q.unread ? ' AND read_at IS NULL' : ''} ORDER BY seq DESC LIMIT 1000`, [project, client]);
    return rows.map(fromItem);
  }
  async markRead(project: string, client: string, seqs: number[], at = new Date()) {
    await this.ready;
    let n = 0;
    for (const s of seqs) n += (await this.db.run(`UPDATE ${this.t('news_items')} SET read_at = ? WHERE project = ? AND client_id = ? AND seq = ? AND read_at IS NULL`, [at.toISOString(), project, client, s])).changes ?? 0;
    return n;
  }
  async claim(project: string, client: string, seqs: number[], consumer: string, staleBefore: string, at = new Date()) {
    await this.ready;
    const out: number[] = [];
    for (const s of seqs) {
      const n = (await this.db.run(`UPDATE ${this.t('news_items')} SET pushed_to = ?, pushed_at = ? WHERE project = ? AND client_id = ? AND seq = ? AND read_at IS NULL AND (pushed_to IS NULL OR pushed_to = ? OR pushed_at < ?)`, [consumer, at.toISOString(), project, client, s, consumer, staleBefore])).changes ?? 0;
      if (n) out.push(s);
    }
    return out;
  }
  async adopt(project: string, client: string, from: string, to: string) {
    await this.ready;
    await this.db.run(`UPDATE ${this.t('news_items')} SET session_id = ? WHERE project = ? AND client_id = ? AND session_id = ? AND read_at IS NULL`, [to, project, client, from]);
    await this.db.run(`UPDATE ${this.t('news_watch')} SET session_id = ? WHERE project = ? AND client_id = ? AND session_id = ?`, [to, project, client, from]);
  }
  async flowSig(project: string, client: string) {
    await this.ready;
    return (await this.db.get<{ sig: string }>(`SELECT sig FROM ${this.t('news_flow')} WHERE project = ? AND client_id = ?`, [project, client]))?.sig;
  }
  async setFlowSig(project: string, client: string, sig: string) {
    await this.ready;
    await this.db.run(this.db.dialect.upsert('news_flow', ['project', 'client_id', 'sig'], ['project', 'client_id'], ['sig']), [project, client, sig]);
  }
}

/** One service per activity bus when the context has none (tests, in-process contexts). */
const fallback = new WeakMap<object, NewsService>();
export function newsFallback(project: string, bus: { subscribe(fn: (e: ActivityEvent) => void): () => void }): NewsService {
  let s = fallback.get(bus);
  if (!s) fallback.set(bus, (s = new NewsService(project, new MemoryNewsStore(), bus)));
  return s;
}
