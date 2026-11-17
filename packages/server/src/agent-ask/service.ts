/**
 * Ask, answered by the user's own coding agents (no server-side model). The Ask panel posts a question; it is stored
 * as an ask thread, delivered as an event (`ask_question`) to the chosen agent (or the only one online; `any` = every
 * online agent, the first answer wins), and answered with `ask_answer` (chunks are appended; `done` ends it). Nobody
 * online: the question waits and is delivered to the first agent that connects. The panel polls `ask_get`.
 */
import { newId } from '../storage/ids.js';
import { migrate, type Migration } from '../db/migrate.js';
import type { Db, Dialect } from '../db/types.js';
import type { NewsService } from '../news/index.js';

export const ASK_KIND = 'ask_question';
export const ASK_REF_PREFIX = 'mandate://ask/';
export const askRef = (id: string) => `${ASK_REF_PREFIX}${id}`;

export type AskStatus = 'waiting' | 'answering' | 'done' | 'cancelled';
export interface AskThread {
  id: string;
  conversationId: string;
  question: string;
  context: string[];
  /** Client id the question was addressed to; `any`; null = unassigned (waits for the first agent that connects). */
  to: string | null;
  /** Who asked (login), when known. */
  asker: string | null;
  status: AskStatus;
  /** The answer so far (markdown). */
  answer: string;
  /** Label of the agent that answers. */
  answeredBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AskStore {
  insert(project: string, t: AskThread): Promise<void>;
  get(project: string, id: string): Promise<AskThread | null>;
  update(project: string, t: AskThread): Promise<void>;
  list(project: string, f?: { conversationId?: string; statuses?: AskStatus[] }): Promise<AskThread[]>;
}

export class MemoryAskStore implements AskStore {
  private readonly rows = new Map<string, AskThread & { project: string }>();
  async insert(project: string, t: AskThread) {
    this.rows.set(`${project}\u0000${t.id}`, { ...t, project });
  }
  async get(project: string, id: string) {
    const r = this.rows.get(`${project}\u0000${id}`);
    return r ? strip(r) : null;
  }
  async update(project: string, t: AskThread) {
    this.rows.set(`${project}\u0000${t.id}`, { ...t, project });
  }
  async list(project: string, f: { conversationId?: string; statuses?: AskStatus[] } = {}) {
    return [...this.rows.values()]
      .filter((r) => r.project === project && (!f.conversationId || r.conversationId === f.conversationId) && (!f.statuses || f.statuses.includes(r.status)))
      .map(strip)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
const strip = ({ project: _p, ...t }: AskThread & { project: string }): AskThread => ({ ...t, context: [...t.context] });

const schema = (d: Dialect) => `
CREATE TABLE IF NOT EXISTS ${d.table('ask_threads')} (
  project TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL, question TEXT NOT NULL, context TEXT NOT NULL,
  to_client TEXT, asker TEXT, status TEXT NOT NULL, answer TEXT NOT NULL, answered_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS ${d.index('ask_threads_conv')} ON ${d.table('ask_threads')} (project, conversation_id);
`;
export const ASK_MIGRATIONS: Migration[] = [{ id: 1, name: 'ask threads', sqlite: schema, postgres: schema }];

interface Row {
  id: string;
  conversation_id: string;
  question: string;
  context: string;
  to_client: string | null;
  asker: string | null;
  status: AskStatus;
  answer: string;
  answered_by: string | null;
  created_at: string;
  updated_at: string;
}
const fromRow = (r: Row): AskThread => ({ id: r.id, conversationId: r.conversation_id, question: r.question, context: JSON.parse(r.context) as string[], to: r.to_client, asker: r.asker, status: r.status, answer: r.answer, answeredBy: r.answered_by, createdAt: r.created_at, updatedAt: r.updated_at });

export class DbAskStore implements AskStore {
  private readonly ready: Promise<unknown>;
  constructor(private readonly db: Db) {
    this.ready = migrate(db, 'ask', ASK_MIGRATIONS);
  }
  private t() {
    return this.db.dialect.table('ask_threads');
  }
  async insert(project: string, t: AskThread) {
    await this.ready;
    await this.db.run(`INSERT INTO ${this.t()} (project, id, conversation_id, question, context, to_client, asker, status, answer, answered_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [project, t.id, t.conversationId, t.question, JSON.stringify(t.context), t.to, t.asker, t.status, t.answer, t.answeredBy, t.createdAt, t.updatedAt]);
  }
  async get(project: string, id: string) {
    await this.ready;
    const r = await this.db.get<Row>(`SELECT * FROM ${this.t()} WHERE project = ? AND id = ?`, [project, id]);
    return r ? fromRow(r) : null;
  }
  async update(project: string, t: AskThread) {
    await this.ready;
    await this.db.run(`UPDATE ${this.t()} SET to_client = ?, status = ?, answer = ?, answered_by = ?, updated_at = ? WHERE project = ? AND id = ?`, [t.to, t.status, t.answer, t.answeredBy, t.updatedAt, project, t.id]);
  }
  async list(project: string, f: { conversationId?: string; statuses?: AskStatus[] } = {}) {
    await this.ready;
    const rows = await this.db.all<Row>(`SELECT * FROM ${this.t()} WHERE project = ?${f.conversationId ? ' AND conversation_id = ?' : ''} ORDER BY created_at ASC LIMIT 500`, f.conversationId ? [project, f.conversationId] : [project]);
    return rows.map(fromRow).filter((t) => !f.statuses || f.statuses.includes(t.status));
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A waiting question older than this is not delivered to a newly connected agent (stale). */
export const ASK_MAX_AGE_MS = 24 * 60 * 60_000;

export class AskService {
  constructor(
    readonly project: string,
    readonly store: AskStore,
    readonly news: NewsService,
  ) {
    // An agent connected: unassigned questions that wait are delivered to it.
    news.presence.onConnect((client) => void this.deliverWaiting(client).catch((e) => console.error("ask: delivering waiting questions failed", e)));
  }

  /** The agent a new question goes to: the one asked for, else the only online one, else nobody yet. */
  private target(to?: string, exclude?: string): { to: string | null; clients: string[] } {
    const p = this.news.presence;
    if (to === 'any') {
      const online = p.all().filter((a) => a.id !== exclude && p.isOnline(a.id)).map((a) => a.id);
      return { to: 'any', clients: online };
    }
    if (to) {
      const ids = p.resolve(to);
      return { to: ids[0] ?? to, clients: ids.length ? ids : [to] };
    }
    const online = p.all().filter((a) => a.id !== exclude && p.isOnline(a.id)).map((a) => a.id);
    return online.length === 1 ? { to: online[0]!, clients: online } : { to: null, clients: [] };
  }

  private async deliver(t: AskThread, clients: string[]) {
    const ctx = t.context.length ? ` Context: ${t.context.slice(0, 6).join(', ')}.` : '';
    const summary = `Ask question ${t.id}${t.asker ? ` from ${t.asker}` : ''}: "${clip(t.question.replace(/\s+/g, ' '), 300)}".${ctx}`;
    for (const c of clients) await this.news.addClientWide(c, ASK_KIND, askRef(t.id), summary);
  }

  async post(a: { question: string; context?: string[]; to?: string; conversationId?: string; asker?: string; exclude?: string }): Promise<AskThread & { delivered: string[] }> {
    const now = new Date().toISOString();
    const tg = this.target(a.to, a.exclude);
    const t: AskThread = {
      id: newId('ask'),
      conversationId: a.conversationId ?? newId('conv'),
      question: a.question,
      context: a.context ?? [],
      to: tg.to,
      asker: a.asker ?? null,
      status: 'waiting',
      answer: '',
      answeredBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(this.project, t);
    await this.deliver(t, tg.clients);
    return { ...t, delivered: tg.clients };
  }

  private async deliverWaiting(client: string) {
    const cutoff = Date.now() - ASK_MAX_AGE_MS;
    for (const t of await this.store.list(this.project, { statuses: ['waiting'] })) {
      if (t.to !== null && t.to !== 'any' && t.to !== client) continue;
      if (Date.parse(t.createdAt) < cutoff) continue;
      if (t.to === null) {
        await this.store.update(this.project, { ...t, to: client, updatedAt: new Date().toISOString() });
        await this.deliver(t, [client]);
      } else if (t.to === client || t.to === 'any') {
        // already delivered when posted (its item may be unread: catch-up / push redelivery handle it)
      }
    }
  }

  get(id: string) {
    return this.store.get(this.project, id);
  }
  conversation(conversationId: string) {
    return this.store.list(this.project, { conversationId });
  }

  /** Questions waiting for `client` (addressed to it, to any, or unassigned), oldest first. */
  async pending(client: string): Promise<AskThread[]> {
    const cutoff = Date.now() - ASK_MAX_AGE_MS;
    return (await this.store.list(this.project, { statuses: ['waiting', 'answering'] })).filter((t) => (t.to === null || t.to === 'any' || t.to === client) && Date.parse(t.createdAt) >= cutoff);
  }

  /** Append (or end) an answer. Only the first agent to answer owns the thread. */
  async answer(id: string, a: { text: string; done: boolean; client: string; label: string }): Promise<AskThread> {
    const t = await this.get(id);
    if (!t) throw Object.assign(new Error(`ask '${id}' not found`), { code: 'not_found' });
    if (t.status === 'cancelled') throw Object.assign(new Error(`ask ${id} was cancelled`), { code: 'ask_closed' });
    if (t.status === 'done') throw Object.assign(new Error(`ask ${id} is already answered`), { code: 'ask_closed' });
    if (t.answeredBy && t.answeredBy !== a.client) throw Object.assign(new Error(`ask ${id} is being answered by another agent`), { code: 'ask_taken' });
    const next: AskThread = { ...t, answer: t.answer ? `${t.answer}${a.text}` : a.text, answeredBy: a.client, status: a.done ? 'done' : 'answering', updatedAt: new Date().toISOString() };
    await this.store.update(this.project, next);
    this.news.presence.note({ id: a.client, label: a.label, client: a.client.split('/')[0]! });
    await this.news.markReadRefs(a.client, [askRef(id)]).catch(() => 0);
    return { ...next, answeredBy: a.label };
  }

  async cancel(id: string): Promise<AskThread> {
    const t = await this.get(id);
    if (!t) throw Object.assign(new Error(`ask '${id}' not found`), { code: 'not_found' });
    if (t.status === 'done' || t.status === 'cancelled') return t;
    const next = { ...t, status: 'cancelled' as const, updatedAt: new Date().toISOString() };
    await this.store.update(this.project, next);
    return next;
  }
}
