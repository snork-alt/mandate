/**
 * The driven flow: `flow_next` (what is the next step of a request, or of every request in flight), `request_decision_add`
 * (a decision the agent took without asking the user) and `flow_edit_allowed` (strict mode: may this agent edit code now).
 * The state machine is flow/next.ts (pure); this file reads the stored state and shapes the result.
 */
import { isClaimStale, replayComments, type CommentThread, type StoredSpec } from '@mandate/shared';
import { z } from 'zod';
import { ANY, assignedSummary, deliverAssigned, mayStart, wakeableAny } from '../../flow/assign.js';
import { requestAssignInputSchema, requestPlanApproveInputSchema } from '@mandate/shared';
import { inheritedOf } from '../../storage/work-order-plan.js';
import { flowAll, flowFor, type FlowDecision, type FlowGit, type FlowItem, type FlowSnapshot } from '../../flow/next.js';
import { clientIdentity, effective } from '../../projects/settings.js';
import type { CommitMeta } from '../../storage/index.js';
import { newsOfProject, routeState, seedKnownClients, shortTarget, unansweredFor } from '../../comments/route.js';
import { ownerOf, type StoredComponent } from '@mandate/shared';
import { unfollowedStandards } from '../../storage/components.js';
import { componentsRequired, liveComponents, unownedOf } from '../component-gate.js';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const reqId = (v: string) => v.trim().replace(/^@mandate:/, '').replace(/^mandate:\/\/(?:requests|feedback)\//, '');

interface TreeInput {
  dirty?: boolean | undefined;
  noHead?: boolean | undefined;
}

async function snapshot(ctx: ToolContext, agent?: string, tree?: TreeInput, decision?: FlowDecision): Promise<FlowSnapshot> {
  const st = ctx.storage;
  const [requests, workOrders, questions, specList, verifications, comments] = await Promise.all([
    st.feedbackService.list(),
    st.workOrderService.list(),
    st.questionService.list(),
    st.specs.list() as Promise<StoredSpec[]>,
    st.verifications.list(),
    st.commentService.lines().then((l) => replayComments(l)),
  ]);
  const eff = ctx.settings ? effective(ctx.settings.policy(), undefined) : null;
  const git = eff ? await gitOf(ctx, eff, workOrders, tree) : undefined;
  const outdated: NonNullable<FlowSnapshot['outdated']> = new Map();
  for (const sp of specList) {
    if (sp.status === 'archived' || !sp.sections.some((x) => x.implementedCommit && !x.archived)) continue;
    const impl = await st.workOrderService.implementation(sp.id).catch(() => ({}));
    const bad = Object.fromEntries(Object.entries(impl).filter(([, v]) => v.outdated).map(([k, v]) => [k, { ...(v.implementedBy ? { implementedBy: v.implementedBy } : {}), ...(v.changedBy ? { changedBy: v.changedBy } : {}), ...(v.changedAt ? { changedAt: v.changedAt } : {}), ...(v.changedCommit ? { changedCommit: v.changedCommit } : {}) }]));
    if (Object.keys(bad).length) outdated.set(sp.id, bad);
  }
  const dependents: NonNullable<FlowSnapshot['dependents']> = new Map();
  for (const sp of specList) {
    if (sp.status === 'archived' || !sp.sections.some((x) => x.links.length)) continue;
    const links = await st.linkService.forDoc('specs', sp).catch(() => null);
    for (const [sid, info] of Object.entries(links?.sections ?? {})) {
      for (const l of info.outgoing) if (l.upstreamChanged && l.kind === 'specs' && l.sectionId) {
        const key = `mandate://specs/${l.docId}/sections/${l.sectionId}`;
        dependents.set(key, [...(dependents.get(key) ?? []), { spec: sp.id, section: sid, summaries: (l.changes ?? []).map((c) => c.summary) }]);
      }
    }
  }
  const inherited: NonNullable<FlowSnapshot['inherited']> = new Map();
  for (const w of workOrders) {
    if (!['pending', 'in_progress'].includes(w.status) || inherited.has(w.spec)) continue;
    const sp = specList.find((x) => x.id === w.spec);
    if (!sp) continue;
    const list = inheritedOf(await st.verificationService.forSpec(sp).catch(() => null), sp.sections.map((x) => x.id));
    if (list.length) inherited.set(w.spec, list);
  }
  return { ...(decision ? { decision } : {}), requests, comments, workOrders, questions, specs: new Map(specList.map((s) => [s.id, s])), verifications, ...(inherited.size ? { inherited } : {}), ...(outdated.size ? { outdated } : {}), ...(dependents.size ? { dependents } : {}), ...(git ? { git } : {}), ...(agent ? { agent } : {}) };
}

/** Outdated sections as re-verify items (flow_next without a request). */
function reverifyItems(snap: FlowSnapshot) {
  const m: NonNullable<FlowSnapshot['outdated']> = snap.outdated ?? new Map();
  return [...m.entries()].flatMap(([spec, secs]) =>
    Object.entries(secs).map(([sid, o]) => {
      const ref = `mandate://specs/${spec}/sections/${sid}`;
      return {
        section: ref,
        ...(o.implementedBy ? { implementedBy: o.implementedBy } : {}),
        ...(o.changedBy ? { changedBy: o.changedBy } : {}),
        ...(o.changedAt ? { changedAt: o.changedAt } : {}),
        next: { tool: 'section_reverify', args: { ref, codeRefs: ['<repo:path#Lx-Ly that implements it>'], verifications: ['<test / verification proving it>'] }, why: 'Implemented, but its text changed since. Re-check the code and tests against the CURRENT text. Wording only: section_update { ref, editorial: { reason } }. Same behaviour: section_reverify with the evidence. New behaviour: a work order (update) covering it.' },
      };
    }),
  );
}

/** Git settings, the tree state the agent reported (flow_next code arg, else its code_context_set) and unowned touched files. */
async function gitOf(ctx: ToolContext, eff: { commit: 'auto' | 'ask'; branch: 'current' | 'per-request'; push: 'off' | 'auto' }, workOrders: FlowSnapshot['workOrders'], tree?: TreeInput): Promise<FlowGit> {
  const cc = ctx.session?.codeContext;
  const dirty = tree?.dirty ?? (tree?.noHead ? undefined : cc?.dirty);
  const live = await liveComponents(ctx);
  const unowned: Record<string, string[]> = {};
  const unfollowed: Record<string, { component: string; standards: string[] }[]> = {};
  const model = live.length ? await ctx.storage.model().catch(() => null) : null;
  for (const w of workOrders) {
    if (!['pending', 'in_progress'].includes(w.status)) continue;
    const miss = unownedOf(live, w.touched ?? []);
    if (miss.length) unowned[w.id] = miss;
    if (model) {
      const owners = new Map<string, StoredComponent>();
      for (const t of w.touched ?? []) {
        if (t.change === 'deleted') continue;
        const o = ownerOf(t.repo, t.path, live);
        if (o) owners.set(o.component.id, o.component);
      }
      const list = [...owners.values()].map((c) => ({ component: c.id, standards: unfollowedStandards(c, model) })).filter((x) => x.standards.length);
      if (list.length) unfollowed[w.id] = list;
    }
  }
  return { ...(Object.keys(unfollowed).length ? { unfollowed } : {}), commit: eff.commit, branch: eff.branch, push: eff.push, ...(dirty || tree?.noHead ? { tree: { ...(dirty ? { dirty: true } : {}), ...(tree?.noHead ? { noHead: true } : {}) } } : {}), components: live.length, componentsRequired: componentsRequired(ctx), unowned };
}

const compact = (i: FlowItem) => ({ request: i.request.ref, summary: i.request.summary, state: i.state, ...(i.queued ? { queued: true } : {}), ...(i.request.assignee ? { assignee: i.request.assignee } : {}), ...(i.request.priority ? { priority: i.request.priority } : {}), ...(i.request.planOnly ? { planOnly: true } : {}), next: i.next, ...(i.waitingOn ? { waitingOn: i.waitingOn } : {}), ...(i.waitingOnWorkOrders ? { waitingOnWorkOrders: i.waitingOnWorkOrders } : {}) });

const COMMENT_NOTE = `Reply to every comment routed to you, in its thread (comment_add { target, parent }): a question / remark: answer. A change: request_create { source: "comment", relatedTo: [object, comment] } (or attach to the in-flight request on that object), reply "Treating this as a request: <link>", then do the flow; when its work order completes ONE final reply (what changed, commit) and comment_resolve; no progress replies. asRequest: always a request. Can't / won't: reply why, leave open. Comments of other agents: only if addressed to you.`;

/** Unanswered comments routed to the caller, and its converted threads whose request is done. */
async function commentInbox(ctx: ToolContext, snap: FlowSnapshot) {
  const news = newsOfProject(ctx);
  if (!news || !snap.comments || ctx.principal?.kind === 'ui') return null;
  const me = clientIdentity(ctx).id;
  const st = await routeState(ctx, news.presence);
  const view = (t: CommentThread, extra: Record<string, unknown> = {}) => {
    const msgs = [t, ...t.replies];
    const last = msgs[msgs.length - 1]!;
    return { thread: t.id, target: shortTarget(t.target), ...(t.blocking ? { blocking: true } : {}), ...(t.asRequest || msgs.some((m) => m.asRequest) ? { asRequest: true } : {}), ...(msgs.some((m) => m.view) ? { view: [...msgs].reverse().find((m) => m.view)!.view } : {}), messages: msgs.slice(-4).map((m) => ({ id: m.id, by: m.author.user ?? m.author.agent, body: m.body.slice(0, 600) })), last: last.id, ...extra };
  };
  const unanswered = unansweredFor(me, snap.comments, st).slice(0, 10).map((t) => view(t));
  const done = new Set(snap.requests.filter((r) => r.status === 'closed').map((r) => r.id));
  const converted = snap.comments
    .filter((t) => t.status === 'open')
    .flatMap((t) => snap.requests.filter((r) => r.source === 'comment' && done.has(r.id) && (r.relatedTo ?? []).some((x) => [t, ...t.replies].some((m) => x === m.uri))).map((r) => view(t, { request: `mandate://requests/${r.id}`, todo: 'its request is done: reply once with what changed and the commit, then comment_resolve' })))
    .slice(0, 10);
  return unanswered.length || converted.length ? { unanswered, converted } : null;
}

export const flowTools = [
  defineTool({
    name: 'flow_next',
    title: 'Next step of the flow',
    kind: 'read',
    description: `What to do next, from the stored state (never guess the order): { request, state, next: { tool, args, why } | null, waitingOn?: [question ids], waitingOnWorkOrders?, parallel?: [other actionable requests], done }. Also comments: unanswered comment threads routed to you (reply to each; see commentsNote). With request: that request's next step; do it, then call flow_next again until done or waiting (then continue with parallel items, or report what the user must answer). Decision { kind: restore_files | destructive_git | irreversible | tradeoff ("question | option | option"), detail }: before acting on something needing the user: next = question_ask; ask, END YOUR TURN. Code { dirty: true } (uncommitted changes) or { noHead: true } (repo without a commit) makes the next step a commit (project commit policy: auto = commit now with the given message, ask = a question_ask); report it whenever you changed files since your last commit. Without request: every in-flight (not closed) request of this project with its next step (mine: only the ones you created).
Example: {"request":"fb-0007"}`,
    input: z.object({ request: z.string().trim().min(1).optional(), mine: z.boolean().default(false), agent: z.string().trim().min(1).max(120).optional(), code: z.object({ repo: z.string().trim().min(1).max(200).optional(), commit: z.string().trim().min(7).max(40).optional(), dirty: z.boolean().optional(), noHead: z.boolean().optional() }).strict().optional(), decision: z.object({ kind: z.enum(['restore_files', 'destructive_git', 'irreversible', 'tradeoff']), detail: z.string().trim() }).strict().optional() }).strict(),
    run: async (a, ctx) => {
      if (a.decision?.kind === 'tradeoff' && a.decision.detail.split('|').length < 3) throw new ToolError('validation', 'a tradeoff decision is "<question> | <option> | <option>"', 'give the question and 2-4 options separated by |', 'decision.detail');
      const me = a.agent ?? ctx.clientName;
      const snap = await snapshot(ctx, a.agent, a.code, a.decision);
      const agentCall = ctx.principal?.kind !== 'ui';
      const myId = clientIdentity(ctx).id;
      const presence = newsOfProject(ctx)?.presence;
      // Requests assigned to another agent (or taken by one) are not yours: they leave your list.
      const takeable = (f: (typeof snap.requests)[number]) => !agentCall || mayStart(f, myId, (h) => presence?.resolve(h) ?? []).ok;
      if (a.request) {
        const id = reqId(a.request);
        let f = snap.requests.find((x) => x.id === id);
        if (!f) throw new ToolError('not_found', `request '${id}' not found`, 'flow_next {} lists the requests in flight', 'request', { kind: 'document' });
        if (agentCall && f.status !== 'closed') {
          // Starting an assigned request takes it (exclusive): the first agent wins, the others are told.
          const m = mayStart(f, myId, (h) => presence?.resolve(h) ?? []);
          if (!m.ok) throw new ToolError('already_taken', `already_taken: ${m.why}`, 'flow_next {} lists the requests you can work on', 'request', { kind: 'document' });
          if (f.assignee && !f.startedBy) {
            const rid = f.id;
            f = await ctx.storage.lock.run(async () => {
              const cur = await ctx.storage.feedbackService.get(rid);
              if (cur.startedBy && cur.startedBy !== myId) throw new ToolError('already_taken', `already_taken: ${cur.startedBy} started this request`, 'flow_next {} lists the requests you can work on', 'request', { kind: 'document' });
              if (cur.startedBy) return cur;
              return ctx.storage.feedbackService.markStarted(rid, myId, { agent: ctx.clientName ?? 'agent' });
            });
            snap.requests = snap.requests.map((x) => (x.id === rid ? f! : x));
          }
        }
        const item = flowFor(f, snap);
        const parallel = flowAll(snap).filter((x) => x.request.id !== id && x.next && takeable(snap.requests.find((r) => r.id === x.request.id)!)).slice(0, 5).map(compact);
        const inbox = await commentInbox(ctx, snap);
        return { ...item, ...(parallel.length ? { parallel } : {}), ...(inbox ? { comments: inbox, commentsNote: COMMENT_NOTE } : {}) };
      }
      const all = flowAll(snap).filter((i) => takeable(snap.requests.find((x) => x.id === i.request.id)!)).filter((i) => !a.mine || (!!me && (i.request.createdBy === me || i.request.createdBy === a.agent)));
      const waitingOn = [...new Set(all.flatMap((i) => i.waitingOn ?? []))];
      const next = all.find((i) => i.next);
      const inbox = await commentInbox(ctx, snap);
      const pending = inbox ? inbox.unanswered.length + inbox.converted.length : 0;
      const stale = reverifyItems(snap);
      return {
        requests: all.map(compact),
        ...(stale.length ? { outdatedSections: stale.slice(0, 10), outdatedNote: `${stale.length} implemented section(s) are Outdated (changed since implemented): re-verify each (section_reverify), mark it editorial (section_update editorial) or cover it with a work order.` } : {}),
        ...(inbox ? { comments: inbox, commentsNote: COMMENT_NOTE } : {}),
        ...(next ? { actionable: next.request.ref } : {}),
        ...(waitingOn.length ? { waitingOn } : {}),
        done: all.length === 0 && !pending && !stale.length,
        note: pending ? `${pending} comment(s) wait for you (comments): reply in their threads first.` : all.length ? (next ? `Work on ${next.request.ref} first: flow_next { request } and do its next step.` : 'Nothing is actionable: the requests wait for the user (waitingOn) or for work orders of other requests.') : 'No request is in flight.',
      };
    },
  }),
  defineTool({
    name: 'request_assign',
    title: 'Assign a request to an agent',
    kind: 'write',
    uiAllowed: true,
    description: `Assign (or reassign) a request that has not been started: assignee = an agent handle (agents_presence) or "any" (the next free agent; the first to start it takes it). The assignee is told (event request_assigned; an offline agent is caught up when it connects, the request stays Queued). Refused once an agent started it (already_started).
Example: {"ref":"fb-0007","assignee":"any"}`,
    input: requestAssignInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = ctx.commit!;
      const id = reqId(a.ref);
      const news = newsOfProject(ctx);
      const h = a.assignee.trim();
      const assignee = h.toLowerCase() === ANY ? ANY : (news?.presence.resolve(h)[0] ?? h);
      const f = await ctx.storage.lock.run(async () => {
        const cur = await ctx.storage.feedbackService.get(id);
        if (cur.startedBy) throw new ToolError('already_started', `already_started: ${cur.startedBy} started ${id}; it cannot be reassigned`, 'ask the agent to release it (a comment on the request)', 'ref', { kind: 'document' });
        return ctx.storage.feedbackService.assign(id, assignee, { agent: c.agent, trailers: { ...c.trailers }, onCommit: (sha: string) => commits.push(sha) });
      });
      const delivered = news ? (await seedKnownClients(ctx, news.presence), await deliverAssigned(news, f, 'reassigned')) : [];
      return { ref: `mandate://requests/${id}`, commit: commits.at(-1) ?? null, commits, warnings: [], assignee, queued: assignee !== ANY && !news?.presence.isOnline(assignee), wakeable: wakeableAny(news, assignee, delivered), delivered };
    },
  }),
  defineTool({
    name: 'request_plan_approve',
    title: 'Approve the plan of a plan-only request',
    kind: 'write',
    uiAllowed: true,
    description: `The user approved the work-order plan of a request filed with planOnly: clears planOnly and tells the agent that has it (or the assignee) to continue: claim the work order and implement. A user decision of the web UI (agents cannot call it).
Example: {"ref":"fb-0007"}`,
    input: requestPlanApproveInputSchema,
    run: async (a, ctx) => {
      if (ctx.principal?.kind !== 'ui') throw new ToolError('forbidden', 'forbidden: the plan is approved by the user in the web UI', 'ask the user to click "Approve plan & implement" on the request page', 'ref');
      const commits: string[] = [];
      const c = ctx.commit!;
      const id = reqId(a.ref);
      const cur = await ctx.storage.feedbackService.get(id);
      if (!cur.planOnly) throw new ToolError('not_plan_only', `not_plan_only: request ${id} is not waiting for a plan approval`, 'only requests filed with planOnly need it', 'ref', { kind: 'document' });
      const f = await ctx.storage.feedbackService.approvePlan(id, (ctx.principal.kind === 'ui' ? ctx.principal.user.login : c.agent), { agent: c.agent, trailers: { ...c.trailers }, onCommit: (sha: string) => commits.push(sha) });
      const news = newsOfProject(ctx);
      const delivered = news ? (await seedKnownClients(ctx, news.presence), await deliverAssigned(news, f, 'plan_approved')) : [];
      return { ref: `mandate://requests/${id}`, commit: commits.at(-1) ?? null, commits, warnings: [], delivered, summary: assignedSummary(f, 'plan_approved') };
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
    description: `Strict flow (project setting strictFlow): { allowed, reason, activeWorkOrder?, step? }. Code edits are allowed while you hold a claimed work order with a task in progress (flow_next says how to get there). Always allowed when strict flow is off, the flow is off for your client, or repo is not a code repo of this project. Used by the \`mandate guard\` hook.
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
        if (step) return { allowed: true, reason: `work order ${w.id} is claimed with task ${step.id} in progress`, activeWorkOrder: `mandate://work-orders/${w.id}`, task: step.id, step: step.id };
      }
      const claimed = wos[0];
      return {
        allowed: false,
        reason: claimed
          ? `work order ${claimed.id} is claimed but no task is in progress: work_order_task_set { ref, task, status: "in_progress" } for the task you are about to implement, then edit`
          : 'no claimed work order: run flow_next (or /mandate <request>) and follow it: request, specs, work order, claim, a task in progress; then edit',
        ...(claimed ? { activeWorkOrder: `mandate://work-orders/${claimed.id}` } : {}),
      };
    },
  }),
];
