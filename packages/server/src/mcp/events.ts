/**
 * Push event stream for coding agents that do not surface MCP notifications to the model (Claude Code): the per-client
 * news feed (news/index.ts: answered questions, work order / spec changes, review outcomes, ...) over plain HTTP.
 *
 * - `GET  /p/<project>/events`          Server-Sent Events. Bearer = the same agent token / OAuth token / service key the
 *   MCP endpoint takes (never the UI cookie). `id:` = the item's seq (monotonic per project); resume with
 *   `Last-Event-ID` (or `?since=`). `: hb` comment every heartbeat. `?client=claude-code` picks the client identity
 *   (default claude-code: items of `<login>/claude-code`), `?consumer=<id>` names the receiver (a channel process).
 * - `GET  /p/<project>/events/pending?since=<seq>&consumer=<id>`  JSON catch-up: the same items, claimed like a stream
 *   would (`&peek=1`: no claiming).
 * - `POST /p/<project>/events/ack {ids:[seq]}`  marks items read (news_items.read_at), like news_ack.
 *
 * Delivery vs read: an item is CLAIMED (pushed_to / pushed_at) when it is sent, so two receivers of one client (two
 * Claude Code windows, the channel and the rewake hook, a catch-up and the stream) never both get it; reconnecting
 * with the same consumer id re-sends what was claimed but never confirmed by a newer Last-Event-ID. An item stays
 * unread (and keeps showing as `news` on tool replies) until the agent reads its ref or acks it; a pushed item that
 * is still unread after PUSH_REDELIVER_MS is pushed again.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../auth/http.js';
import { newsFallback, type NewsItem, type NewsService } from '../news/index.js';
import { clientIdentity } from '../projects/settings.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { ToolContext } from './define.js';

export type EventGate = (req: FastifyRequest, reply: FastifyReply, project: string | null) => Promise<{ principal: Principal } | null>;

/** What a receiver gets per item (identifiers and the summary only). */
export interface PushedEvent {
  seq: number;
  kind: string;
  ref: string;
  summary: string;
  at: string;
}
export const toPushed = (i: NewsItem): PushedEvent => ({ seq: i.seq, kind: i.kind, ref: i.ref, summary: i.summary, at: i.at });

const q = (req: FastifyRequest, k: string): string | undefined => {
  const v = (req.query as Record<string, unknown> | undefined)?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length <= 100 ? s : undefined;
};
const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export function registerEventRoutes(app: FastifyInstance, o: { projects: ProjectRegistry; gate: EventGate; heartbeatMs?: number }) {
  const streams = new Set<() => void>();

  /** Gate + the client's news service. Null after replying. */
  const open = async (req: FastifyRequest, reply: FastifyReply) => {
    const project = (req.params as { projectId: string }).projectId;
    const g = await o.gate(req, reply, project);
    if (!g) return null;
    const p = g.principal;
    if (p.kind === 'ui') {
      reply.code(403).send({ error: { code: 'forbidden', message: 'events are for agents (token or sign-in), not the web UI' } });
      return null;
    }
    const rt = await o.projects.open(project).catch(() => null);
    const news: NewsService | null = rt ? ((rt.ctx as ToolContext).news ?? (rt.activity ? newsFallback(project, rt.activity) : null)) : null;
    if (!news) {
      reply.code(503).send({ error: { code: 'unavailable', message: `project '${project}' has no event feed` } });
      return null;
    }
    const ident = clientIdentity({ principal: p, clientName: q(req, 'client') ?? 'claude-code' });
    const client = ident.id;
    const settings = (rt?.ctx as ToolContext | undefined)?.settings;
    const seen = () => void settings?.clients.seen(project, ident).catch(() => undefined);
    seen();
    return { news, client, ident, seen, consumer: q(req, 'consumer') ?? `anon-${Math.random().toString(36).slice(2, 10)}` };
  };

  app.get('/p/:projectId/events', async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return reply;
    const lastId = req.headers['last-event-id'];
    let cursor = Math.max(num(typeof lastId === 'string' ? lastId : undefined), num(q(req, 'since')));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': mandate events\nretry: 3000\n\n');

    let closed = false;
    let busy = false;
    let again = false;
    const flush = async () => {
      if (busy) return void (again = true);
      busy = true;
      try {
        do {
          again = false;
          for (const i of await c.news.pushable(c.client, c.consumer, { since: cursor })) {
            if (closed) return;
            res.write(`id: ${i.seq}\nevent: news\ndata: ${JSON.stringify(toPushed(i))}\n\n`);
            cursor = Math.max(cursor, i.seq);
          }
        } while (again && !closed);
      } catch {
        // the next wake-up retries
      } finally {
        busy = false;
      }
    };
    const off = c.news.onItems(c.client, () => void flush());
    const offline = c.news.presence.open(c.ident);
    const hb = setInterval(() => {
      if (!res.write(': hb\n\n')) return;
      c.news.presence.note(c.ident);
      c.seen();
      void flush(); // also picks up items whose wake-up was missed (a restart between ingest and listen)
    }, o.heartbeatMs ?? 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      off();
      offline();
      streams.delete(close);
      res.end();
    };
    streams.add(close);
    res.on('close', close);
    res.on('error', close);
    await flush();
    return reply;
  });

  app.get('/p/:projectId/events/pending', async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return reply;
    const items = await c.news.pushable(c.client, c.consumer, { since: num(q(req, 'since')), peek: q(req, 'peek') === '1' });
    reply.header('Cache-Control', 'no-store');
    return { items: items.map(toPushed), next: items.reduce((m, i) => Math.max(m, i.seq), num(q(req, 'since'))) };
  });

  app.post('/p/:projectId/events/ack', async (req, reply) => {
    const c = await open(req, reply);
    if (!c) return reply;
    const ids = ((req.body as { ids?: unknown } | undefined)?.ids ?? []) as unknown;
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n) && n > 0) || ids.length > 200) return reply.code(400).send({ error: { code: 'invalid_input', message: 'ids: up to 200 item seqs', path: 'ids' } });
    return { acked: await c.news.store.markRead(c.news.project, c.client, ids as number[]) };
  });

  app.addHook('onClose', async () => {
    for (const close of [...streams]) close();
  });
}
