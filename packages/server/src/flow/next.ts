/**
 * `flow_next`: the Mandate flow as a state machine over stored state (pure: no I/O, no clock besides `now`). For one
 * request it answers "what is the next step?" (tool + args + why), what it is waiting on (unanswered questions that
 * block it, a work order another request holds), and which other requests are actionable meanwhile. Stages per request:
 *   spec_match -> spec / standard changes -> acceptance criteria -> work_order_create (full plan) -> claim -> plan steps
 *   -> work_order_section_done -> verification_record per criterion -> work_order_complete -> request closed (automatic).
 * The server enforces the order (`flow_out_of_order`, claims); this module only says what comes next.
 */
import {
  blockingQuestions,
  isClaimStale,
  targetsDoc,
  type CommentThread,
  type Feedback,
  type PlanStep,
  answerText,
  type Question,
  type StoredSpec,
  type VerificationRecord,
  type WorkOrder,
} from '@mandate/shared';
import { coveredCriteria } from '../storage/work-order-plan.js';

export type FlowState =
  | 'matching'
  | 'specs'
  | 'criteria'
  | 'work_order'
  | 'claim'
  | 'steps'
  | 'sections'
  | 'verify'
  | 'complete'
  | 'commit'
  | 'components'
  | 'close'
  | 'comments'
  | 'plan_ready'
  | 'waiting'
  | 'done';

export interface FlowStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface FlowItem {
  request: { id: string; ref: string; kind: string; status: string; summary: string; createdBy?: string; source?: string; assignee?: string; startedBy?: string; priority?: string; planOnly?: boolean };
  /** Assigned to an agent that has not started it yet. */
  queued?: boolean;
  /** The request's (latest) work order: plan steps, sections and proved criteria (the request page's flow bar). */
  progress?: FlowProgress;
  state: FlowState;
  next: FlowStep | null;
  /** Unanswered question ids that block this request (or its work orders / steps / sections). */
  waitingOn?: string[];
  /** Work orders (of other requests) this one waits for, with the request that holds each. */
  waitingOnWorkOrders?: { workOrder: string; request?: string; claimedBy?: string; why: string }[];
  /** Git rules for this work (commit mode, branch, push, the commit message to use). */
  git?: { commit: string; branch: string; push: string; message?: string };
  done: boolean;
}

export interface FlowProgress {
  workOrder: string;
  kind: string;
  status: string;
  steps: { id: string; text: string; status: string }[];
  sections: { total: number; done: number };
  criteria: { total: number; proved: number };
}

export interface FlowGit {
  commit: 'auto' | 'ask';
  branch: 'current' | 'per-request';
  push: 'off' | 'auto';
  /** What the agent reported about its working tree (flow_next code arg or code_context_set): uncommitted changes / no commit yet. */
  tree?: { dirty?: boolean; noHead?: boolean };
  /** Number of live components of the project. */
  components?: number;
  /** Touched files (`repo:path`) of each work order that no component owns. */
  unowned?: Record<string, string[]>;
}

export interface FlowSnapshot {
  requests: Feedback[];
  workOrders: WorkOrder[];
  questions: Question[];
  /** Specs by id (sections with type / verifiedBy / archived are read). */
  specs: Map<string, Pick<StoredSpec, 'id' | 'status' | 'sections'>>;
  verifications: VerificationRecord[];
  /** Comment threads (any state): a blocking open one on a request stops its flow until resolved. */
  comments?: CommentThread[];
  /** Git / components context (project settings and what the agent reported); absent: no git guidance. */
  git?: FlowGit;
  /** The calling agent (claims by other agents are not yours); unknown: every claim is assumed to be yours. */
  agent?: string;
  now?: number;
}

const reqRef = (id: string) => `mandate://requests/${id}`;
const woRef = (id: string) => `mandate://work-orders/${id}`;
const specRef = (id: string) => `mandate://specs/${id}`;
const secRef = (spec: string, sid: string) => `mandate://specs/${spec}/sections/${sid}`;
const summaryOf = (f: Feedback) => f.body.replace(/\s+/g, ' ').trim().slice(0, 140);
const OPEN = new Set(['pending', 'in_progress']);
const isOpenWo = (w: WorkOrder) => OPEN.has(w.status);
const CHANGING = new Set(['implement', 'update']);

/** Sections of a spec a request changed (added / modified, live, from the commits that address it). */
function changedSections(f: Feedback): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of f.changes) {
    if (c.kind !== 'specs' || c.action === 'deleted') continue;
    const set = out.get(c.id) ?? new Set<string>();
    for (const s of c.sections) if (s.action !== 'removed') set.add(s.id);
    out.set(c.id, set);
  }
  return out;
}

const hasCriterion = (spec: Pick<StoredSpec, 'sections'>, sid: string): boolean => {
  const live = spec.sections.filter((s) => !s.archived);
  const s = live.find((x) => x.id === sid);
  if (!s) return true; // gone: nothing to cover
  if (s.type === 'acceptance') return true;
  return (s.verifiedBy ?? []).some((v) => live.some((x) => x.id === v && x.type === 'acceptance'));
};

/** Steps, sections and proved criteria of the request's newest work order that is not cancelled. */
export function progressOf(f: Feedback, snap: FlowSnapshot): FlowProgress | undefined {
  const w = snap.workOrders.filter((x) => x.reason.includes(f.id) && x.status !== 'cancelled').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!w) return undefined;
  const live = w.sections.filter((x) => x.status !== 'obsolete');
  const criteria = coveredCriteria(snap.specs.get(w.spec) ?? null, live.map((x) => x.id));
  const specUri = specRef(w.spec);
  const recs = snap.verifications.filter((r) => r.appliedTo === specUri && r.at >= w.createdAt && r.result === 'pass');
  const proved = criteria.filter((c) => recs.some((r) => r.criterion === secRef(w.spec, c.id) && (r.evidence?.test?.trim() || r.codeRefs?.length))).length;
  return {
    workOrder: w.id,
    kind: w.kind,
    status: w.status,
    steps: ((w.planSteps ?? []) as PlanStep[]).map((s) => ({ id: s.id, text: s.text, status: s.status })),
    sections: { total: live.length, done: live.filter((x) => x.status === 'done').length },
    criteria: { total: criteria.length, proved },
  };
}

export function flowFor(f: Feedback, snap: FlowSnapshot): FlowItem {
  const now = snap.now ?? Date.now();
  const progress = progressOf(f, snap);
  const item = (state: FlowState, next: FlowStep | null, extra: Partial<FlowItem> = {}): FlowItem => ({
    ...(progress ? { progress } : {}),
    request: { id: f.id, ref: reqRef(f.id), kind: f.kind, status: f.status, summary: summaryOf(f), ...(f.createdBy ? { createdBy: f.createdBy } : {}), ...(f.source ? { source: f.source } : {}), ...(f.assignee ? { assignee: f.assignee } : {}), ...(f.startedBy ? { startedBy: f.startedBy } : {}), ...(f.priority ? { priority: f.priority } : {}), ...(f.planOnly ? { planOnly: true } : {}) },
    ...(f.assignee && !f.startedBy && f.status !== 'closed' ? { queued: true } : {}),
    state,
    next,
    // plan_ready: the agent is done (the user reviews the plan; approval re-notifies it).
    done: state === 'done' || state === 'plan_ready',
    ...extra,
  });
  if (f.status === 'closed') return item('done', null);

  const blockingComments = (snap.comments ?? []).filter((t) => t.status === 'open' && t.blocking && targetsDoc(t.target, reqRef(f.id)));
  if (blockingComments.length) {
    return item('comments', { tool: 'comments_list', args: { target: reqRef(f.id) }, why: `${blockingComments.length} blocking comment thread(s) on this request (${blockingComments.map((t) => t.id).join(', ')}): address each (reply in the thread; a change = a request; do the work), then comment_resolve. The request does not move on until they are resolved.` });
  }

  const open = (ref: string) => blockingQuestions(snap.questions, ref).map((q) => q.id);
  const blockedRequest = open(reqRef(f.id));
  if (blockedRequest.length) return item('waiting', null, { waitingOn: blockedRequest });

  const mine = snap.workOrders.filter((w) => w.reason.includes(f.id));
  const live = mine.filter(isOpenWo);
  const waiting = new Set<string>();
  const waitWos: NonNullable<FlowItem['waitingOnWorkOrders']> = [];

  // Plan only: once the work order with the plan exists the agent stops; the user approves in the web UI.
  if (f.planOnly && mine.some((w) => w.status !== 'cancelled')) {
    return item('plan_ready', null);
  }

  // Drive open work orders first (their sections / steps / verification / completion).
  for (const w of live) {
    const r = driveWorkOrder(w, f, snap, now, waiting, waitWos);
    if (r) return item(r.state, r.next, { ...(snap.git ? { git: gitInfo(w, f, snap.git) } : {}), ...(waiting.size ? { waitingOn: [...waiting] } : {}), ...(waitWos.length ? { waitingOnWorkOrders: waitWos } : {}) });
  }
  if (live.length) {
    return item('waiting', null, { ...(waiting.size ? { waitingOn: [...waiting] } : {}), ...(waitWos.length ? { waitingOnWorkOrders: waitWos } : {}) });
  }

  // No open work order: the intake stages.
  const changed = changedSections(f);
  const coveredSpecs = new Set(mine.filter((w) => w.status === 'done').map((w) => w.spec));
  const todo = [...changed.entries()].filter(([spec]) => !coveredSpecs.has(spec));

  if (!mine.length && !f.specMatch) {
    return item('matching', { tool: 'spec_match', args: { request: f.body.slice(0, 1500), for: f.id }, why: `Place the request in the specs (records the match on ${f.id}); then decide: covered, extend a section, new section, new spec or a standard.` });
  }
  if (!mine.length && !changed.size) {
    const how =
      f.specMatch?.decision === 'extend_section' ? 'section_update on the matched section' : f.specMatch?.decision === 'new_section' ? 'section_insert in the matched spec' : f.specMatch?.decision === 'new_spec' ? 'create a new spec' : 'section_update / section_insert / create';
    const blockedSpec = (f.specMatch?.refs ?? []).flatMap((r) => open(r));
    if (blockedSpec.length) return item('waiting', null, { waitingOn: [...new Set(blockedSpec)] });
    return item('specs', { tool: 'section_update', args: { addresses: [reqRef(f.id)] }, why: `Change the specs / standards for the request (${how}; addresses: [${reqRef(f.id)}]), each changed section with an acceptance criterion. Already covered? request_close rejected / duplicate with a note. Bug fix without behaviour change: work_order_create kind fix fastPath. Unsure whether the user wants X or Y: decide and request_decision_add; ask (question_ask { request: "${f.id}" }) only if it changes behaviour.` });
  }

  // Changed sections need acceptance criteria before a work order.
  for (const [spec, sections] of todo) {
    const s = snap.specs.get(spec);
    if (!s) continue;
    const bare = [...sections].filter((sid) => !hasCriterion(s, sid));
    if (bare.length) {
      return item('criteria', { tool: 'section_insert', args: { doc: specRef(spec), addresses: [reqRef(f.id)] }, why: `Add an acceptance criterion (type acceptance, method test) for ${bare.join(', ')} in ${spec} and link it (verifiedBy), addresses: [${reqRef(f.id)}].` });
    }
  }

  if (todo.length) {
    const [spec, sections] = todo[0]!;
    const s = snap.specs.get(spec);
    const ids = [...sections].filter((sid) => s?.sections.some((x) => x.id === sid && !x.archived));
    if (ids.length) {
      const clash = snap.workOrders.filter((w) => isOpenWo(w) && CHANGING.has(w.kind) && w.spec === spec && !w.reason.includes(f.id) && w.sections.some((x) => x.status === 'pending' && ids.includes(x.id)));
      if (clash.length) {
        return item('waiting', null, {
          waitingOnWorkOrders: clash.map((c) => ({
            workOrder: c.id,
            ...(c.reason[0] ? { request: c.reason[0] } : {}),
            ...(c.claim ? { claimedBy: c.claim.agent } : {}),
            why: `section ${spec}/${c.sections.filter((x) => x.status === 'pending' && ids.includes(x.id)).map((x) => x.id).join(', ')} already has an open ${c.kind} work order (one per section): wait until it completes${c.claim && isClaimStale(c.claim, now) ? ' (its claim is stale: work_order_claim it to take it over)' : ''}, then create this one`,
          })),
        });
      }
      const criteria = coveredCriteria(s, ids);
      const kind = s?.status === 'done' ? 'update' : 'implement';
      return item('work_order', {
        tool: 'work_order_create',
        args: { spec: specRef(spec), kind, sections: ids.map((sid) => secRef(spec, sid)), reason: [reqRef(f.id)] },
        why: `Create the work order with the FULL plan now: plan { steps (ordered, each linked to sections), files, tests: one per criterion (${criteria.map((c) => c.id).join(', ') || 'none'}) as { name, ref, proves }, risks }.`,
      });
    }
  }

  // Every work order finished (or failed / cancelled with nothing changed): close.
  if (mine.length && mine.every((w) => w.status === 'done')) {
    return item('close', { tool: 'request_close', args: { ref: reqRef(f.id), resolution: 'applied' }, why: 'Its work orders are complete; the request closes automatically, close it as applied if it is still open.' });
  }
  if (mine.length) {
    const failed = mine.find((w) => w.status === 'failed');
    if (failed) return item('claim', { tool: 'work_order_claim', args: { ref: woRef(failed.id) }, why: `Work order ${failed.id} failed: claim it again to retry (or cancel it and create a new one).` });
  }
  return item('specs', { tool: 'section_update', args: { addresses: [reqRef(f.id)] }, why: 'Nothing left to do for this request: close it (request_close applied | rejected | duplicate) with the reason.' });
}

function claimGit(w: WorkOrder, f: Feedback, snap: FlowSnapshot): string {
  const g = snap.git;
  if (!g) return '';
  return g.branch === 'per-request' ? ` Git: switch to branch ${branchOf(f)} (git switch ${branchOf(f)} || git switch -c ${branchOf(f)}; from the current branch, reuse it if it exists), then code_context_set.` : ' Git: stay on the current branch.';
}
const branchOf = (f: Feedback) => `mandate/${f.id}`;
const lastDoneStep = (w: WorkOrder) => [...((w.planSteps ?? []) as PlanStep[])].reverse().find((s) => s.status === 'done');

/** The commit message of the work so far: "<request id> <step id>: <step text>" + Request / Work-Order trailers. */
export function commitMessage(w: WorkOrder, f: Feedback): string {
  const s = lastDoneStep(w);
  const head = s ? `${f.id} ${s.id}: ${s.text}` : `${f.id} ${w.id}: ${summaryOf(f)}`;
  return `${head.replace(/\s+/g, ' ').slice(0, 200)}\n\nRequest: ${f.id}\nWork-Order: ${w.id}`;
}

function gitInfo(w: WorkOrder, f: Feedback, g: FlowGit): NonNullable<FlowItem['git']> {
  return { commit: g.commit, branch: g.branch === 'per-request' ? branchOf(f) : 'current', push: g.push, message: commitMessage(w, f) };
}

/** The question (ask mode) that asks once whether the agent may commit, with the user's answer when there is one. */
function commitQuestion(w: WorkOrder, snap: FlowSnapshot) {
  const ref = woRef(w.id);
  return snap.questions.find((q) => q.purpose === 'decision' && (q.blocks ?? []).includes(ref) && q.questions[0]?.header === COMMIT_HEADER && q.status !== 'cancelled' && q.status !== 'superseded' && q.status !== 'expired');
}
const COMMIT_HEADER = 'Commits';
const COMMIT_MINE = 'I commit myself';

/** A commit step when the work needs a commit (code refs, verifications) and the tree has uncommitted changes or no HEAD. */
function commitStep(w: WorkOrder, f: Feedback, snap: FlowSnapshot): Driven | null {
  const g = snap.git;
  if (!g?.tree?.dirty && !g?.tree?.noHead) return null;
  const message = commitMessage(w, f);
  const what = g!.tree!.noHead ? 'The repo has no commit yet: make the initial commit of the work' : 'The working tree has uncommitted changes';
  const files = 'git add only the files of this work (never unrelated files; see git status), never amend or force';
  if (g!.commit === 'auto') {
    return { state: 'commit', next: { tool: 'code_context_set', args: { commit: '<sha of your new commit>', dirty: false }, why: `${what}. Commit policy auto (the user authorised local commits): ${files}; git commit -m with this message:\n${message}\nThen code_context_set { repo, commit: <new HEAD sha>, branch } and pass that commit in code { repo, commit } on the next section_done / verification_record / work_order_complete.` } };
  }
  const q = commitQuestion(w, snap);
  if (q?.status === 'answered') {
    const ans = answerText(q.answer?.answers[q.questions[0]!.id]);
    if (ans.startsWith(COMMIT_MINE)) return { state: 'commit', next: { tool: 'news_list', args: { unread: true, wait: 300 }, why: `${what}. The user chose to commit themselves: wait for it (news_list wait), then code_context_set { repo, commit: <HEAD>, dirty: false } once the tree is committed. Do not commit.` } };
    return { state: 'commit', next: { tool: 'code_context_set', args: { commit: '<sha of your new commit>', dirty: false }, why: `${what}. The user agreed to commits: ${files}; git commit -m with this message:\n${message}\nThen code_context_set { repo, commit: <new HEAD sha> }.` } };
  }
  return {
    state: 'commit',
    next: {
      tool: 'question_ask',
      args: {
        purpose: 'decision',
        request: f.id,
        blocks: [woRef(w.id)],
        blocking: true,
        questions: [{ header: COMMIT_HEADER, question: `${what}, and Mandate needs a commit sha for the code refs. May I commit the work of ${f.id} (${message.split('\n')[0]})?`, options: [{ label: 'Commit for me', description: 'Create a local commit with only the files of this work' }, { label: COMMIT_MINE, description: 'You commit; the flow continues when you have' }], recommended: 'Commit for me' }],
      },
      why: `${what}. Commit policy ask: do not commit and do not ask in chat; ask once with this question_ask (it shows in Waiting for you and blocks the work order), then flow_next again.`,
    },
  };
}

interface Driven {
  state: FlowState;
  next: FlowStep;
}

function driveWorkOrder(w: WorkOrder, f: Feedback, snap: FlowSnapshot, now: number, waiting: Set<string>, waitWos: NonNullable<FlowItem['waitingOnWorkOrders']>): Driven | null {
  const ref = woRef(w.id);
  const blockedWo = blockingQuestions(snap.questions, ref).map((q) => q.id);
  if (blockedWo.length) {
    blockedWo.forEach((id) => waiting.add(id));
    return null;
  }
  const done = (s: { status: string }) => s.status === 'done' || s.status === 'obsolete';
  const sections = w.sections;
  const allDone = sections.every(done);
  const claim = w.claim;
  const fresh = !!claim && !isClaimStale(claim, now);
  const ours = !snap.agent || !claim || claim.agent === snap.agent;
  if (!allDone) {
    if (fresh && !ours) {
      waitWos.push({ workOrder: w.id, claimedBy: claim!.agent, why: `${w.id} is claimed by ${claim!.agent}: wait for it (or coordinate with comment_add)` });
      return null;
    }
    if (!claim || !fresh) {
      return { state: 'claim', next: { tool: 'work_order_claim', args: { ref }, why: `Claim ${w.id}${claim ? ' (its claim is stale: this takes it over)' : ''} (plan: ${w.hasPlan ? 'given' : 'MISSING: work_order_plan_set first'}). Then read its comments and rules_for_code before editing.${claimGit(w, f, snap)}` } };
    }
  }
  // Steps first, while sections are open; when every section is done only unfinished steps remain (complete refuses them).
  const steps = (w.planSteps ?? []) as PlanStep[];
  const stepBlocked = (s: PlanStep) => blockingQuestions(snap.questions, `${ref}/steps/${s.id}`).map((q) => q.id);
  const inProgress = steps.find((s) => s.status === 'in_progress');
  if (inProgress) {
    const b = stepBlocked(inProgress);
    if (b.length) b.forEach((id) => waiting.add(id));
    else return { state: 'steps', next: { tool: 'work_order_step_set', args: { ref, step: inProgress.id, status: 'done' }, why: `Finish ${inProgress.id} (${inProgress.text}), then record it done with codeRefs (files / lines you changed).` } };
  }
  const pending = steps.filter((s) => s.status === 'pending');
  // A finished step is committed before the next one starts.
  if (pending.length && lastDoneStep(w)) {
    const c = commitStep(w, f, snap);
    if (c) return c;
  }
  for (const s of pending) {
    const b = stepBlocked(s);
    if (b.length) {
      b.forEach((id) => waiting.add(id));
      continue;
    }
    return { state: 'steps', next: { tool: 'work_order_step_set', args: { ref, step: s.id, status: 'in_progress' }, why: `Start ${s.id}: ${s.text}. Implement it (rules_for_code before editing), then work_order_step_set done with codeRefs.` } };
  }
  if (!allDone) {
    const secBlocked = (sid: string) => blockingQuestions(snap.questions, `${ref}/sections/${sid}`).concat(blockingQuestions(snap.questions, secRef(w.spec, sid))).map((q) => q.id);
    const ready = sections.filter((s) => s.status === 'pending' && !secBlocked(s.id).length);
    sections.filter((s) => s.status === 'pending').forEach((s) => secBlocked(s.id).forEach((id) => waiting.add(id)));
    if (ready.length) {
      const c = commitStep(w, f, snap);
      if (c) return c;
      return { state: 'sections', next: { tool: 'work_order_section_done', args: { ref, sections: [ready[0]!.id] }, why: `Mark section ${ready[0]!.id} done with notes and codeRefs (the code that implements it); ${ready.length - 1} more section(s) after it.` } };
    }
    return null;
  }
  // Every section done: prove the criteria, then complete.
  const spec = snap.specs.get(w.spec);
  const criteria = coveredCriteria(spec ?? null, sections.filter((s) => s.status !== 'obsolete').map((s) => s.id));
  const specUri = specRef(w.spec);
  const recs = snap.verifications.filter((r) => r.appliedTo === specUri && r.at >= w.createdAt && r.result !== 'skipped');
  const needsRecord = criteria.some((c) => {
    const mineRecs = recs.filter((r) => r.criterion === secRef(w.spec, c.id));
    const last = mineRecs.at(-1);
    return !last || last.result === 'fail' || ((c.method ?? 'test') === 'test' && !mineRecs.some((r) => r.result === 'pass' && (r.evidence?.test?.trim() || r.codeRefs?.length)));
  });
  const commit = commitStep(w, f, snap);
  if (commit && (needsRecord || (w.kind !== 'review' && w.kind !== 'verify'))) return commit;
  for (const c of criteria) {
    const uri = secRef(w.spec, c.id);
    const mineRecs = recs.filter((r) => r.criterion === uri);
    const last = mineRecs.at(-1);
    const tested = mineRecs.some((r) => r.result === 'pass' && (r.evidence?.test?.trim() || r.codeRefs?.length));
    if (!last || last.result === 'fail' || ((c.method ?? 'test') === 'test' && !tested)) {
      const planned = (w.planTests ?? []).filter((t) => t.proves.includes(c.id)).map((t) => t.ref ?? t.name);
      return { state: 'verify', next: { tool: 'verification_record', args: { criterion: uri, appliedTo: specUri, result: 'pass' }, why: `Run the test for criterion ${c.id} (${c.title})${planned.length ? ` [planned: ${planned.join(', ')}]` : ''} and record the result with evidence.test or codeRefs naming it.` } };
    }
  }
  const unowned = snap.git?.unowned?.[w.id] ?? [];
  if (unowned.length && (snap.git?.components ?? 0) > 0) {
    return { state: 'components', next: { tool: 'component_update', args: { owns: unowned.slice(0, 10) }, why: `These touched files are owned by no component: ${unowned.slice(0, 10).join(', ')}${unowned.length > 10 ? ` (+${unowned.length - 10})` : ''}. Create or update a component owning these paths (component_create, or add owns globs to the component that holds them with component_update; reuse before creating), then work_order_complete. Generated or vendored files that need no owner: go straight to work_order_complete.` } };
  }
  const push = snap.git?.push === 'auto' ? ` Then push the branch${snap.git.branch === 'per-request' ? ` ${branchOf(f)}` : ''} and, if gh is available and a remote exists, open a PR (best effort, never fail the flow on it; record it with work_order_git_update pr).` : '';
  return { state: 'complete', next: { tool: 'work_order_complete', args: { ref }, why: `Complete ${w.id} with outcome and reconciliation (spec / component text and code refs updated to what was built; pass git [{ repo, headCommit }]); resolve blocking comments first.${push}` } };
}

/** Flow items for every in-flight (not closed) request, oldest first. */
export function flowAll(snap: FlowSnapshot): FlowItem[] {
  const rank = (f: Feedback) => (f.priority === 'high' ? 0 : f.priority === 'low' ? 2 : 1);
  return snap.requests
    .filter((f) => f.status !== 'closed')
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))
    .map((f) => flowFor(f, snap));
}
