/**
 * News about the calling agent client's own work (news/index.ts): `news_list` (history, filters, paging, optional wait
 * for unread news) and `news_ack`. Read tools: they work with the flow off. Agent clients only.
 */
import { z } from 'zod';
import { clientIdentity } from '../../projects/settings.js';
import { NEWS_WAIT_MAX } from '../../news/index.js';
import { defineTool, newsOf, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const feed = (ctx: ToolContext) => {
  const news = newsOf(ctx);
  if (!news) throw new ToolError('not_available', 'news is kept for agent clients on a project endpoint', 'call it as a coding agent (agent key or personal token)');
  return { news, client: clientIdentity(ctx).id, session: ctx.session?.id ?? null };
};

const NEWS_LIST_DESC = `Your news history (newest first): what changed in YOUR work (questions answered / closed, your work orders changed, your feedback closed, comments, drift of sections you work on, audit findings, flow changed). Read AND unread; default: this session's + client-wide, all: every session of this client. Filters: unread, kind, ref, since / until; paging: cursor (next) + limit. An item stays unread until you read its ref or news_ack it.
wait (seconds, max ${NEWS_WAIT_MAX}, with unread: true): hold until news arrives. Use it ONLY when everything is blocked (e.g. waiting for answers); repeat up to 6 times (30 min), then tell the user you are blocked and stop.
Example: {"unread":true}  {"unread":true,"wait":300}  {"kind":"question_answered","limit":10,"cursor":"42"}`;

export const newsTools = [
  defineTool({
    name: 'news_list',
    title: 'List your news',
    kind: 'read',
    agentOnly: true,
    description: NEWS_LIST_DESC,
    input: z
      .object({
        unread: z.boolean().default(false),
        all: z.boolean().default(false),
        kind: z.union([z.string().min(1), z.array(z.string().min(1)).max(20)]).optional(),
        ref: z.string().trim().min(1).max(400).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        until: z.string().datetime({ offset: true }).optional(),
        cursor: z.string().regex(/^\d+$/, 'a next value from an earlier page').optional(),
        limit: z.number().int().min(1).max(100).default(20),
        wait: z.number().int().min(0).max(NEWS_WAIT_MAX).default(0),
      })
      .strict(),
    run: async (a, ctx) => {
      const { news, client, session } = feed(ctx);
      let waited: boolean | undefined;
      if (a.wait > 0) {
        if (!a.unread) throw new ToolError('validation', 'wait needs unread: true', 'e.g. {"unread":true,"wait":300}', 'wait');
        if (ctx.session?.waiting) throw new ToolError('wait_in_progress', 'this session is already waiting for news', 'wait for that call to return', 'wait');
        if (ctx.session) ctx.session.waiting = true;
        try {
          let tick = 0;
          waited = await news.waitFor(client, session, a.wait * 1000, ctx.signal, () => void ctx.progress?.(++tick, 'waiting for news').catch(() => undefined));
        } finally {
          if (ctx.session) ctx.session.waiting = false;
        }
      }
      const kinds = a.kind === undefined ? null : Array.isArray(a.kind) ? a.kind : [a.kind];
      const ref = a.ref?.replace(/^@mandate:/, '');
      const all = (await news.forSession(client, session, { unread: a.unread, all: a.all })).filter(
        (i) =>
          (!kinds || kinds.includes(i.kind)) &&
          (!ref || i.ref === ref || i.ref.startsWith(`${ref}/`)) &&
          (!a.since || i.at >= a.since) &&
          (!a.until || i.at <= a.until) &&
          (!a.cursor || i.seq < Number(a.cursor)),
      );
      const page = all.slice(0, a.limit);
      const items = page.map((i) => ({ id: i.seq, kind: i.kind, ref: i.ref, summary: i.summary, at: i.at, read: !!i.readAt, session: i.session === null ? 'client' : i.session === session ? 'this' : 'other' }));
      return {
        items,
        next: all.length > page.length ? String(page.at(-1)!.seq) : null,
        ...(waited !== undefined ? { waited: waited ? 'news arrived' : 'nothing yet' } : {}),
      };
    },
  }),
  defineTool({
    name: 'news_ack',
    title: 'Acknowledge news',
    kind: 'read',
    agentOnly: true,
    description: `Mark your news read (it then leaves the replies' news notice): ids from the notice / news_list, or all: true (this session's + client-wide). Reading the referenced item also marks it read.
Example: {"ids":[41,42]}  {"all":true}`,
    input: z.object({ ids: z.array(z.number().int().min(1)).min(1).max(200).optional(), all: z.boolean().default(false) }).strict(),
    run: async (a, ctx) => {
      if (!a.ids && !a.all) throw new ToolError('validation', 'pass ids or all: true', 'e.g. {"all":true}', 'ids');
      const { news, client, session } = feed(ctx);
      return { acknowledged: await news.ack(client, session, { ...(a.ids ? { ids: a.ids } : {}), all: a.all }) };
    },
  }),
];
