/**
 * Ask is answered by the user's coding agents (agent-ask/service.ts): the web UI posts (`ask_post`) and polls
 * (`ask_get`); the agent catches up with `ask_pending` and answers with `ask_answer` (chunks appended, `done`
 * ends it). The question arrives as an event of kind `ask_question`; the guide tells the agent to hand it to the
 * read-only `mandate-ask` Claude Code subagent in the background.
 */
import { z } from 'zod';
import { AskService, MemoryAskStore, askRef, type AskThread } from '../../agent-ask/service.js';
import { newsOfProject } from '../../comments/route.js';
import { clientIdentity } from '../../projects/settings.js';
import { defineTool, principalUser, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const fallback = new WeakMap<object, AskService>();
/** The project's ask service (a memory one per news service when the context has none: tests, in-process). */
export function asksOf(ctx: ToolContext): AskService {
  if (ctx.asks) return ctx.asks;
  const news = newsOfProject(ctx);
  if (!news) throw new ToolError('not_available', 'Ask needs a project endpoint', 'call it on /p/<project>/mcp');
  let s = fallback.get(news);
  if (!s) fallback.set(news, (s = new AskService(news.project, new MemoryAskStore(), news)));
  return s;
}

const askId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((v) => v.replace(/^mandate:\/\/ask\//, ''));

/** A thread as tools return it: the agent's label instead of its client id, a short state line. */
function view(ctx: ToolContext, t: AskThread) {
  const news = newsOfProject(ctx);
  const label = (id: string | null) => (id && news?.presence.get(id)?.label) || id;
  const agent = t.answeredBy ?? (t.to && t.to !== 'any' ? t.to : null);
  return {
    id: t.id,
    ref: askRef(t.id),
    conversationId: t.conversationId,
    question: t.question,
    context: t.context,
    status: t.status,
    answer: t.answer,
    agent: label(agent),
    to: t.to === 'any' ? 'any' : label(t.to),
    asker: t.asker,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export const askTools = [
  defineTool({
    name: 'ask_post',
    title: 'Ask a question (answered by an agent)',
    kind: 'ops',
    description: `Post a question about the project (web UI: the Ask panel). A coding agent answers it: to = an agent handle (agents_presence), "any" (every online agent; the first answer wins) or omitted (the only agent online; none online: it waits and the first agent that connects gets it). Poll ask_get { id } for the answer.
Example: {"question":"What blocks login-sso?","context":["mandate://specs/login-sso"]}`,
    input: z.object({ question: z.string().trim().min(1).max(8000), context: z.array(z.string().trim().min(1).max(400)).max(20).default([]), to: z.string().trim().min(1).max(120).optional(), conversationId: z.string().trim().min(1).max(100).optional() }).strict(),
    run: async (a, ctx) => {
      const agentAsker = ctx.principal && ctx.principal.kind !== 'ui' ? clientIdentity(ctx).id : undefined;
      // An agent that asks is already connected: it must not be handed its own waiting question as a "new agent".
      if (agentAsker) newsOfProject(ctx)?.presence.note(clientIdentity(ctx), ctx.clientName);
      const t = await asksOf(ctx).post({ ...a, ...(principalUser(ctx) ? { asker: principalUser(ctx)! } : {}), ...(agentAsker ? { exclude: agentAsker } : {}) });
      return { ...view(ctx, t), delivered: t.delivered.length, waiting: t.delivered.length === 0 };
    },
  }),
  defineTool({
    name: 'ask_get',
    title: 'Read an Ask thread',
    kind: 'read',
    description: `One Ask question with its answer so far: status waiting | answering | done | cancelled, answer (markdown), agent (who answers). With conversationId: every question of that conversation, oldest first.
Example: {"id":"ask-01jc..."}`,
    input: z.object({ id: askId.optional(), conversationId: z.string().trim().min(1).max(100).optional() }).strict().refine((v) => !!v.id !== !!v.conversationId, 'give id or conversationId'),
    run: async (a, ctx) => {
      const s = asksOf(ctx);
      if (a.conversationId) return { items: (await s.conversation(a.conversationId)).map((t) => view(ctx, t)) };
      const t = await s.get(a.id!);
      if (!t) throw new ToolError('not_found', `ask '${a.id}' not found`, 'ask_pending lists the questions waiting for you', 'id', { kind: 'document' });
      return view(ctx, t);
    },
  }),
  defineTool({
    name: 'ask_cancel',
    title: 'Cancel an Ask question',
    kind: 'ops',
    description: `Withdraw an Ask question that is not answered yet (the agent is told it no longer matters).
Example: {"id":"ask-01jc..."}`,
    input: z.object({ id: askId }).strict(),
    run: async (a, ctx) => view(ctx, await asksOf(ctx).cancel(a.id).catch(askError)),
  }),
  defineTool({
    name: 'ask_pending',
    title: 'Ask questions waiting for you',
    kind: 'read',
    agentOnly: true,
    description: `Ask questions (from the web UI) waiting for you: addressed to you, to any agent, or unassigned. Catch-up for a session that missed the event. Each: { id, question, context }. Hand each to the mandate-ask subagent (background) and answer with ask_answer.
Example: {}`,
    input: z.object({}).strict(),
    run: async (_a, ctx) => ({ items: (await asksOf(ctx).pending(clientIdentity(ctx).id)).map((t) => view(ctx, t)) }),
  }),
  defineTool({
    name: 'ask_answer',
    title: 'Answer an Ask question',
    kind: 'ops',
    agentOnly: true,
    description: `Answer an Ask question (markdown; cite mandate:// refs): text is appended to the answer so far, done (default true) ends it. For a long answer send parts with done: false and the last with done: true; the user sees the progress. Only the first agent to answer owns the question.
Example: {"id":"ask-01jc...","text":"login-sso is blocked by ...","done":true}`,
    input: z.object({ id: askId, text: z.string().min(1).max(60_000), done: z.boolean().default(true) }).strict(),
    run: async (a, ctx) => {
      const me = clientIdentity(ctx);
      const t = await asksOf(ctx).answer(a.id, { text: a.text, done: a.done, client: me.id, label: me.label }).catch(askError);
      return { ...view(ctx, t), agent: me.label };
    },
  }),
];

function askError(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'not_found') throw new ToolError('not_found', err.message ?? 'not found', 'ask_pending lists the questions waiting for you', 'id', { kind: 'document' });
  if (err.code === 'ask_closed' || err.code === 'ask_taken') throw new ToolError(err.code, err.message ?? 'closed', 'nothing more to do for this question', 'id');
  throw e;
}
