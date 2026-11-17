/**
 * The driven flow: `flow_next` (what is the next step of a request, or of every request in flight), `request_decision_add`
 * (a decision the agent took without asking the user) and `flow_edit_allowed` (strict mode: may this agent edit code now).
 * The state machine is flow/next.ts (pure); this file reads the stored state and shapes the result.
 */
import { isClaimStale, type StoredSpec } from '@mandate/shared';
import { z } from 'zod';
import { flowAll, flowFor, type FlowItem, type FlowSnapshot } from '../../flow/next.js';
import { clientIdentity } from '../../projects/settings.js';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const reqId = (v: string) => v.trim().replace(/^@mandate:/, '').replace(/^mandate:\/\/(?:requests|feedback)\//, '');

async function snapshot(ctx: ToolContext, agent?: string): Promise<FlowSnapshot> {
  const st = ctx.storage;
  const [requests, workOrders, questions, specList, verifications] = await Promise.all([
    st.feedbackService.list(),
    st.workOrderService.list(),
    st.questionService.list(),
    st.specs.list() as Promise<StoredSpec[]>,
    st.verifications.list(),
  ]);
  return { requests, workOrders, questions, specs: new Map(specList.map((s) => [s.id, s])), verifications, ...(agent ? { agent } : {}) };
}

const compact = (i: FlowItem) => ({ request: i.request.ref, summary: i.request.summary, state: i.state, next: i.next, ...(i.waitingOn ? { waitingOn: i.waitingOn } : {}), ...(i.waitingOnWorkOrders ? { waitingOnWorkOrders: i.waitingOnWorkOrders } : {}) });

export const flowTools = [
  defineTool({
    name: 'flow_next',
    title: 'Next step of the flow',
    kind: 'read',
    description: `What to do next, from the stored state (never guess the order): { request, state, next: { tool, args, why } | null, waitingOn?: [question ids], waitingOnWorkOrders?, parallel?: [other actionable requests], done }. With request: that request's next step; do it, then call flow_next again until done or waiting (then continue with parallel items, or report what the user must answer). Without request: every in-flight (not closed) request of this project with its next step (mine: only the ones you created).
Example: {"request":"fb-0007"}`,
    input: z.object({ request: z.string().trim().min(1).optional(), mine: z.boolean().default(false), agent: z.string().trim().min(1).max(120).optional() }).strict(),
    run: async (a, ctx) => {
      const me = a.agent ?? ctx.clientName;
      const snap = await snapshot(ctx, a.agent);
      if (a.request) {
        const id = reqId(a.request);
        const f = snap.requests.find((x) => x.id === id);
        if (!f) throw new ToolError('not_found', `request '${id}' not found`, 'flow_next {} lists the requests in flight', 'request', { kind: 'document' });
        const item = flowFor(f, snap);
        const parallel = flowAll(snap).filter((x) => x.request.id !== id && x.next).slice(0, 5).map(compact);
        return { ...item, ...(parallel.length ? { parallel } : {}) };
      }
      const all = flowAll(snap).filter((i) => !a.mine || (!!me && (i.request.createdBy === me || i.request.createdBy === a.agent)));
      const waitingOn = [...new Set(all.flatMap((i) => i.waitingOn ?? []))];
      const next = all.find((i) => i.next);
      return {
        requests: all.map(compact),
        ...(next ? { actionable: next.request.ref } : {}),
        ...(waitingOn.length ? { waitingOn } : {}),
        done: all.length === 0,
        note: all.length ? (next ? `Work on ${next.request.ref} first: flow_next { request } and do its next step.` : 'Nothing is actionable: the requests wait for the user (waitingOn) or for work orders of other requests.') : 'No request is in flight.',
      };
    },
  }),
  defineTool({
    name: 'request_decision_add',
    title: 'Record a decision on a request',
    kind: 'write',
    description: `Ask the user ONLY when necessary (ambiguity that changes behaviour, conflict with a spec / standard, an irreversible or destructive step, a standard confirmation). Otherwise decide and record it here without pausing: text (what you decided) and reason (why). Append-only, shown on the request.
Example: {"ref":"fb-0007","text":"Remember-me lasts 30 days","reason":"the existing session spec uses 30 days"}`,
    input: z.object({ ref: z.string().trim().min(1), text: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(500) }).strict(),
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = ctx.commit!;
      const meta: CommitMeta = { agent: c.agent, ...(c.branch ? { branch: c.branch } : {}), trailers: { ...c.trailers }, onCommit: (sha) => commits.push(sha) };
      const id = reqId(a.ref);
      const f = await ctx.storage.lock.run(() => ctx.storage.feedbackService.addDecision(id, { text: a.text, reason: a.reason, by: c.agent }, meta));
      return { ref: `mandate://requests/${id}`, commit: commits.at(-1) ?? null, commits, warnings: [], decisions: f.decisions ?? [] };
    },
  }),
  defineTool({
    name: 'flow_edit_allowed',
    title: 'May I edit code now?',
    kind: 'read',
    description: `Strict flow (project setting strictFlow): { allowed, reason, activeWorkOrder?, step? }. Code edits are allowed while you hold a claimed work order with a step in progress (flow_next says how to get there). Always allowed when strict flow is off, the flow is off for your client, or repo is not a code repo of this project. Used by the \`mandate guard\` hook.
Example: {"repo":"app","path":"src/login.ts"}`,
    input: z.object({ repo: z.string().trim().min(1).max(200).optional(), path: z.string().trim().min(1).max(1000).optional(), agent: z.string().trim().min(1).max(120).optional() }).strict(),
    run: async (a, ctx) => {
      const s = ctx.settings;
      const policy = s?.policy();
      if (!policy?.strictFlow) return { allowed: true, reason: 'strict flow is off for this project' };
      if (policy.flowPolicy === 'off') return { allowed: true, reason: 'the Mandate flow is off for this project' };
      if (policy.flowPolicy === 'optional') {
        const pref = await s!.clients.get(s!.project, clientIdentity(ctx).id).catch(() => undefined);
        if (pref?.flow === 'off') return { allowed: true, reason: 'the Mandate flow is off for this client' };
      }
      const repos = s!.codeRepos?.() ?? [];
      if (a.repo && repos.length && !repos.some((r) => r.name === a.repo || r.github?.toLowerCase() === a.repo!.toLowerCase())) return { allowed: true, reason: `${a.repo} is not a code repo of this project` };
      const wos = (await ctx.storage.workOrderService.list()).filter((w) => w.claim && !isClaimStale(w.claim) && (!a.agent || w.claim.agent === a.agent));
      for (const w of wos) {
        const step = (w.planSteps ?? []).find((x) => x.status === 'in_progress');
        if (step) return { allowed: true, reason: `work order ${w.id} is claimed with step ${step.id} in progress`, activeWorkOrder: `mandate://work-orders/${w.id}`, step: step.id };
      }
      const claimed = wos[0];
      return {
        allowed: false,
        reason: claimed
          ? `work order ${claimed.id} is claimed but no step is in progress: work_order_step_set { ref, step, status: "in_progress" } for the step you are about to implement, then edit`
          : 'no claimed work order: run flow_next (or /mandate <request>) and follow it: request, specs, work order, claim, a step in progress; then edit',
        ...(claimed ? { activeWorkOrder: `mandate://work-orders/${claimed.id}` } : {}),
      };
    },
  }),
];
