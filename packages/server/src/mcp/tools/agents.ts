/**
 * `agents_presence`: who is connected (event stream), who is busy with what, and who is responsible for an object.
 * The web UI reads it for the comment / Ask agent picker; agents may use it to find a colleague to address.
 */
import { parseCommentTarget } from '@mandate/shared';
import { z } from 'zod';
import { suggestAgent } from '../../agents/presence.js';
import { newsOfProject, responsibleFor, routeState } from '../../comments/route.js';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

/** Code repos an object relates to (work order: touched / git repos; component: the repos it owns). */
export async function reposOf(ctx: ToolContext, ref?: string): Promise<string[]> {
  const t = ref ? parseCommentTarget(ref) : null;
  if (!t) return [];
  if (t.kind === 'work-orders') {
    const w = (await ctx.storage.workOrderService.get(t.id).catch(() => null)) as { touched?: { repo: string }[]; git?: { repo: string }[] } | null;
    return [...new Set([...(w?.touched ?? []).map((x) => x.repo), ...(w?.git ?? []).map((x) => x.repo)])];
  }
  if (t.kind === 'components') {
    const c = (await ctx.storage.components.get(t.id).catch(() => null)) as { owns?: { repo?: string }[] } | null;
    return [...new Set((c?.owns ?? []).map((o) => o.repo).filter((r): r is string => !!r))];
  }
  return [];
}

export const agentTools = [
  defineTool({
    name: 'agents_presence',
    title: 'Agents online / busy',
    kind: 'read',
    description: `Agents of this project: { id, handle (use in @mention / to), state online | busy | offline, busyWith, repos }. online = an event stream (channel) is connected or it called a tool lately; busy = it holds a claim. With ref (an object a comment targets): responsible (who is woken by a comment without an addressee: the claim holder of its work order, else the request's agent) and suggested (an idle agent on the object's code repo, else the least busy). needsPicker: nobody is responsible.
Example: {"ref":"mandate://specs/login/sections/auth-flow"}`,
    input: z.object({ ref: z.string().trim().min(1).max(400).optional() }).strict(),
    run: async (a, ctx) => {
      const news = newsOfProject(ctx);
      if (!news) throw new ToolError('not_available', 'presence is kept per project endpoint', 'call it on a project endpoint');
      const st = await routeState(ctx, news.presence);
      const agents = news.presence.list(st.workOrders);
      if (!a.ref) return { agents };
      const resp = responsibleFor(a.ref, st);
      const responsible = [...new Set(resp.flatMap((r) => news.presence.clientsOfAgent(r.agent, r.user)))];
      const suggested = suggestAgent(agents, await reposOf(ctx, a.ref));
      return { agents, responsible, responsibleAgents: resp.map((r) => r.agent), suggested, needsPicker: !responsible.length };
    },
  }),
];
