/**
 * `flow_next`: the Mandate flow as a state machine over stored state (pure: no I/O, no clock besides `now`). For one
 * request it answers "what is the next step?" (tool + args + why), what it is waiting on (unanswered questions that
 * block it, a work order another request holds), and which other requests are actionable meanwhile. Stages per request:
 *   spec_match -> spec / standard changes -> acceptance criteria -> work_order_create (full plan) -> claim -> tasks
 *   -> verification_record per criterion -> work_order_complete -> request closed (automatic).
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
import { coveredCriteria, type InheritedCriterion } from '../storage/work-order-plan.js';
import { matchGaps } from './gates.js';

export type FlowState =
  | 'matching'
  | 'specs'
  | 'criteria'
  | 'standard_match'
  | 'follows'
  | 'component_match'
  | 'component_update'
  | 'work_order'
  | 'claim'
  | 'tasks'
  | 'sections'
  | 'verify'
  | 'complete'
  | 'commit'
  | 'components'
  | 'close'
  | 'comments'
  | 'outdated'
  | 'plan_ready'
  | 'decision'
  | 'waiting'
  | 'done';

/** What the agent reports it is about to do that needs the user (flow_next { decision }). */
export interface FlowDecision {
  kind: 'restore_files' | 'destructive_git' | 'irreversible' | 'tradeoff';
  /** What exactly (files, command, the choice). */
  detail: string;
}

const DECISION_DEFAULTS: Record<FlowDecision['kind'], { header: string; ask: (d: string) => string; options: { label: string; description: string }[] }> = {
  restore_files: { header: 'Restore', ask: (d) => `Files were deleted in the working tree (${d}). Restore them?`, options: [{ label: 'Restore them', description: 'Bring the deleted files back' }, { label: 'Leave them deleted', description: 'The deletion is intended' }] },
  destructive_git: { header: 'Git change', ask: (d) => `This needs a destructive git operation: ${d}. May I run it?`, options: [{ label: 'Go ahead', description: 'Run it as described' }, { label: 'Do not', description: 'Find another way' }] },
  irreversible: { header: 'Irreversible', ask: (d) => `This step cannot be undone: ${d}. May I do it?`, options: [{ label: 'Go ahead', description: 'Do it as described' }, { label: 'Do not', description: 'Skip it' }] },
  tradeoff: { header: 'Decision', ask: (d) => d, options: [] },
};

/**
 * A step that needs the user's decision: the question to ask through Mandate (purpose decision, blocks the work order or
 * the request), pre-written. The agent ends its turn; the answer wakes it. Asking in chat does not count.
 */
function decisionStep(f: Feedback, target: string, d: FlowDecision, snap: FlowSnapshot): { step?: FlowStep; answer?: string } {
  const def = DECISION_DEFAULTS[d.kind];
  // tradeoff: "question | option | option"; the other kinds carry the options Go ahead / Do not (or Restore / Leave).
  const parts = d.detail.split('|').map((x) => x.trim()).filter(Boolean);
  const question = def.ask(d.kind === 'tradeoff' ? parts[0] ?? d.detail.trim() : d.detail.trim());
  const existing = snap.questions.find((q) => q.purpose === 'decision' && (q.blocks ?? []).includes(target) && q.questions[0]?.question === question && q.status !== 'cancelled' && q.status !== 'superseded' && q.status !== 'expired');
  if (existing?.status === 'answered') return { answer: answerText(existing.answer?.answers[existing.questions[0]!.id]) };
  if (existing) return {};
  const options = d.kind === 'tradeoff' ? parts.slice(1, 5).map((o) => ({ label: o.slice(0, 60), description: o })) : def.options;
  return {
    step: {
      tool: 'question_ask',
      args: { purpose: 'decision', request: f.id, blocks: [target], blocking: true, questions: [{ header: def.header, question, options, ...(options[0] ? { recommended: options[0].label } : {}) }] },
      why: 'This needs the user\'s decision. Ask it with this question_ask (it shows in Waiting for you and blocks the work), then END YOUR TURN: the answer wakes you (flow_next again). A question asked in chat does not count; never wait in chat and never decide it yourself.',
    },
  };
}

export interface FlowStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface FlowItem {
  request: { id: string; ref: string; kind: string; status: string; summary: string; createdBy?: string; source?: string; assignee?: string; startedBy?: string; priority?: string; planOnly?: boolean };
  /** Assigned to an agent that has not started it yet. */
  queued?: boolean;
  /** The request's (latest) work order: tasks, sections and proved criteria (the request page's flow bar). */
  progress?: FlowProgress;
  state: FlowState;
  next: FlowStep | null;
  /** Unanswered question ids that block this request (or its work orders / steps / sections). */
  waitingOn?: string[];
  /** Work orders (of other requests) this one waits for, with the request that holds each. */
  waitingOnWorkOrders?: { workOrder: string; request?: string; claimedBy?: string; why: string }[];
  /** The user's answer to the decision the agent reported (act on it). */
  decisionAnswer?: string;
  /** Git rules for this work (commit mode, branch, push, the commit message to use). */
  git?: { commit: string; branch: string; push: string; message?: string };
  done: boolean;
}

export interface FlowProgress {
  workOrder: string;
  kind: string;
  status: string;
  tasks: { id: string; text: string; status: string }[];
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
  /** Project setting components: required (completion is refused while touched files are unowned). */
  componentsRequired?: boolean;
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
  /** Gating inherited criteria (followed standards, not waived) per spec id. */
  inherited?: Map<string, InheritedCriterion[]>;
  /** Implemented sections that changed since (Outdated), per spec id: who changed them and the work order that implemented them. */
  outdated?: Map<string, Record<string, { implementedBy?: string; changedBy?: string; changedAt?: string; changedCommit?: string }>>;
  /** Sections whose upstream item changed ("Upstream changed"), keyed by the upstream section URI: the dependent sections and the change summaries. */
  dependents?: Map<string, { spec: string; section: string; summaries: (string | null)[] }[]>;
  /** A decision the agent says it needs from the user (flow_next `decision`): answered through a Mandate question, never in chat. */
  decision?: FlowDecision;
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

/** The inherited criteria that apply to the live sections of a work order. */
const inheritedFor = (w: WorkOrder, snap: FlowSnapshot): InheritedCriterion[] => {
  const live = new Set(w.sections.filter((x) => x.status !== 'obsolete').map((x) => x.id));
  return (snap.inherited?.get(w.spec) ?? []).filter((c) => !c.sections.length || c.sections.some((x) => live.has(x)));
};

/** Tasks and proved criteria of the request's newest work order that is not cancelled. */
export function progressOf(f: Feedback, snap: FlowSnapshot): FlowProgress | undefined {
  const w = snap.workOrders.filter((x) => x.reason.includes(f.id) && x.status !== 'cancelled').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!w) return undefined;
  const live = w.sections.filter((x) => x.status !== 'obsolete');
  const criteria = [...coveredCriteria(snap.specs.get(w.spec) ?? null, live.map((x) => x.id)).map((c) => ({ ...c, uri: secRef(w.spec, c.id) })), ...inheritedFor(w, snap).map((c) => ({ id: c.id, title: c.title, uri: c.uri }))];
  const specUri = specRef(w.spec);
  const recs = snap.verifications.filter((r) => r.appliedTo === specUri && r.at >= w.createdAt && r.result === 'pass');
  const proved = criteria.filter((c) => recs.some((r) => r.criterion === c.uri && (r.evidence?.test?.trim() || r.codeRefs?.length))).length;
  return {
    workOrder: w.id,
    kind: w.kind,
    status: w.status,
    tasks: ((w.planSteps ?? []) as PlanStep[]).map((s) => ({ id: s.id, text: s.text, status: s.status })),
    criteria: { total: criteria.length, proved },
  };
}

export function flowFor(f: Feedback, snap: FlowSnapshot): FlowItem {
  const now = snap.now ?? Date.now();
  const progress = progressOf(f, snap);
  let decisionAnswer: string | undefined;
  const item = (state: FlowState, next: FlowStep | null, extra: Partial<FlowItem> = {}): FlowItem => ({
    ...(decisionAnswer !== undefined ? { decisionAnswer } : {}),
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
  if (snap.decision) {
    const r = decisionStep(f, live[0] ? woRef(live[0].id) : reqRef(f.id), snap.decision, snap);
    if (r.step) return item('decision', r.step);
    if (r.answer !== undefined) decisionAnswer = r.answer;
  }
  const waiting = new Set<string>();
  const waitWos: NonNullable<FlowItem['waitingOnWorkOrders']> = [];

  // Plan only: once the work order with the plan exists the agent stops; the user approves in the web UI.
  if (f.planOnly && mine.some((w) => w.status !== 'cancelled')) {
    return item('plan_ready', null);
  }

  // A section the request changed was implemented before and now shows Outdated, yet no task of the request's work orders covers it.
  const gap = uncoveredOutdated(f, snap, mine);
  if (gap) return item('outdated', gap);
  // The request changed an upstream item: every dependent section is reviewed (no impact: section_link_ack; impact: a task).
  const review = dependentReview(f, snap, mine);
  if (review) return item('outdated', review);

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

  // The standards / components the request fits (after the specs): matched, then acted on, before a work order.
  if (!mine.length && changed.size) {
    const gap = matchGaps(f, snap.specs as never)[0];
    const files = 'files: [the files you plan to change, repo:path]';
    if (gap?.stage === 'new_spec_decision') return item('specs', { tool: 'request_decision_add', args: { ref: f.id, text: 'no existing spec covers ...', reason: '<why>' }, why: `A new spec needs a recorded decision: ${gap.need}.` });
    if (gap?.stage === 'standard_match') return item('standard_match', { tool: 'standard_match', args: { request: f.body.slice(0, 1500), for: f.id }, why: `Which standards must this change follow? Ranks them by appliesTo for the planned files and by meaning; records the match on ${f.id}. Pass ${files}. Then link the changed spec sections to the matching standards (follows). A rule you cannot meet: waiver (question_ask purpose approval).` });
    if (gap?.stage === 'follows') {
      const [spec, ids] = [...changed.entries()][0]!;
      const sid = [...ids][0]!;
      return item('follows', { tool: 'section_link_add', args: { ref: secRef(spec, sid), to: f.standardMatch?.refs[0], rel: 'follows', addresses: [reqRef(f.id)] }, why: `Link the changed sections to the matched standards: ${gap.need}. Changed sections inherit the standard's criteria. Does none apply: request_decision_add "no matched standard applies: <why>".` });
    }
    if (gap?.stage === 'component_match') return item('component_match', { tool: 'component_match', args: { request: f.body.slice(0, 1500), for: f.id }, why: `Which component does this change belong to? Ranks components by meaning and by the code they own; records the match on ${f.id}. Pass ${files}.` });
    if (gap?.stage === 'component_update') {
      if (f.componentMatch?.decision === 'new_component') {
        return item('component_update', { tool: 'request_decision_add', args: { ref: f.id, text: 'no existing component covers ...', reason: '<why>' }, why: `No component fits: record the decision (request_decision_add), then component_create (owns, tldr, Responsibility + Interfaces sections; addresses: [${reqRef(f.id)}]; affects links from the changed spec sections). Otherwise extend the closest component.` });
      }
      return item('component_update', { tool: 'component_update', args: { ref: f.componentMatch?.refs[0], addresses: [reqRef(f.id)] }, why: `Update the matched component: ${gap.need}. Extend owns for the code you will add and its Interfaces section; link the changed spec sections with affects.` });
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
        why: `Create the work order with the FULL plan now: plan { tasks (ordered, concrete: files / functions; each with sections it implements and criteria it proves; every targeted section covered), files, tests: one per criterion (${criteria.map((c) => c.id).join(', ') || 'none'}) as { name, ref, proves }, risks }. First read the code to change, rules_for_code for those paths and the owning components; the plan names the components it creates / updates (the matched one) and the standards it follows (the matched ones).`,
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

/**
 * An implemented section this request changed (it is Outdated) that no task of its work orders covers: either the edit was
 * wording only (mark it editorial) or it is behaviour that a task must deliver.
 */
function uncoveredOutdated(f: Feedback, snap: FlowSnapshot, mine: WorkOrder[]): FlowStep | null {
  const wos = mine.filter((w) => w.status !== 'cancelled');
  if (!snap.outdated || !wos.length) return null;
  for (const [spec, sids] of changedSections(f)) {
    for (const sid of sids) {
      const o = snap.outdated.get(spec)?.[sid];
      if (!o) continue;
      const covered = wos.some((w) => w.spec === spec && w.sections.some((x) => x.id === sid && x.status !== 'obsolete') && (w.status === 'done' || ((w.planSteps ?? []) as PlanStep[]).some((t) => t.sections?.includes(sid))));
      if (covered) continue;
      const ref = secRef(spec, sid);
      return {
        tool: 'section_update',
        args: { ref, editorial: { reason: '<what was reworded>' } },
        why: `${spec}/${sid} was implemented${o.implementedBy ? ` (${o.implementedBy})` : ''} and this request changed it since${o.changedBy ? ` (${o.changedBy})` : ''}, but no task covers it, so it shows Outdated. Decide now: (a) wording only, no behaviour change: section_update { ref: "${ref}", editorial: { reason } } (any wording edit left: re-send it with editorial; the section stays implemented); (b) behaviour changed: add a task covering ${sid} to the request's work order (work_order_plan_set) or create an update work order (work_order_create kind update); (c) nothing to build, the code already matches: section_reverify { ref: "${ref}", codeRefs, verifications }.`,
      };
    }
  }
  return null;
}

/**
 * A section this request changed has dependent sections (depends_on / extends / follows / deviates_from; not affects: a component is downstream of its spec) that now
 * show "Upstream changed": review each one. No impact -> section_link_ack; impact -> a task of the request's work order.
 */
function dependentReview(f: Feedback, snap: FlowSnapshot, mine: WorkOrder[]): FlowStep | null {
  if (!snap.dependents) return null;
  const wos = mine.filter((w) => w.status !== 'cancelled');
  for (const [spec, sids] of changedSections(f)) {
    for (const sid of sids) {
      const up = secRef(spec, sid);
      for (const d of snap.dependents.get(up) ?? []) {
        const covered = wos.some((w) => w.spec === d.spec && (w.sections.some((x) => x.id === d.section && x.status !== 'obsolete') || ((w.planSteps ?? []) as PlanStep[]).some((t) => t.sections?.includes(d.section))));
        if (covered) continue;
        const said = d.summaries.filter(Boolean).join(' ');
        return {
          tool: 'section_link_ack',
          args: { ref: secRef(d.spec, d.section), to: up },
          why: `${d.spec}/${d.section} depends on ${spec}/${sid}, which this request changed${said ? ` ("${said}")` : ''}. Review it: no impact -> section_link_ack (this call); it does need work -> cover ${d.spec}/${d.section} with a task of the work order (work_order_plan_set), then acknowledge after implementing.`,
        };
      }
    }
  }
  return null;
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
  // Tasks first, while sections are open; when every section is done only unfinished steps remain (complete refuses them).
  const steps = (w.planSteps ?? []) as PlanStep[];
  // Inherited criteria (followed standards, also a `follows` link added mid-work) must be proved by a task of the plan.
  const unplanned = inheritedFor(w, snap).filter((c) => !steps.some((t) => t.proves?.includes(c.id)));
  if (!allDone && steps.length && unplanned.length) {
    return { state: 'tasks', next: { tool: 'work_order_plan_set', args: { ref, tasks: [{ text: `Verify the inherited rules: ${unplanned.map((c) => c.title).join('; ').slice(0, 120)}`, proves: unplanned.map((c) => c.id) }] }, why: `The sections follow standards whose must rules are criteria of this work order: ${unplanned.map((c) => `${c.id} (${c.standardTitle ?? c.standard})`).join(', ')}. Add a task proving them (work_order_plan_set: keep the existing tasks, append this one; proves = those ids) and implement what they require; then verification_record each against the standard rule.` } };
  }
  const stepBlocked = (s: PlanStep) => blockingQuestions(snap.questions, `${ref}/tasks/${s.id}`).map((q) => q.id);
  const inProgress = steps.find((s) => s.status === 'in_progress');
  if (inProgress) {
    const b = stepBlocked(inProgress);
    if (b.length) b.forEach((id) => waiting.add(id));
    else return { state: 'tasks', next: { tool: 'work_order_task_set', args: { ref, task: inProgress.id, status: 'done' }, why: `Finish ${inProgress.id} (${inProgress.text}), then record it done with codeRefs (files / lines you changed).` } };
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
    return { state: 'tasks', next: { tool: 'work_order_task_set', args: { ref, task: s.id, status: 'in_progress' }, why: `Start ${s.id}: ${s.text}. Implement it (rules_for_code before editing), then work_order_task_set done with codeRefs.` } };
  }
  if (!allDone) {
    const secBlocked = (sid: string) => blockingQuestions(snap.questions, `${ref}/sections/${sid}`).concat(blockingQuestions(snap.questions, secRef(w.spec, sid))).map((q) => q.id);
    // Sections follow their tasks: one whose covering tasks are unfinished is not offered (finish the tasks; the section is recorded then).
    const taskWaits = (sid: string) => steps.some((t) => (t.sections?.includes(sid) || t.proves?.includes(sid)) && (t.status === 'pending' || t.status === 'in_progress'));
    const ready = sections.filter((s) => s.status === 'pending' && !secBlocked(s.id).length && !taskWaits(s.id));
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
  const criteria = [...coveredCriteria(spec ?? null, sections.filter((s) => s.status !== 'obsolete').map((s) => s.id)).map((c) => ({ ...c, uri: secRef(w.spec, c.id), inherited: undefined as InheritedCriterion | undefined })), ...inheritedFor(w, snap).map((c) => ({ id: c.id, title: c.title, method: c.method, uri: c.uri, inherited: c }))];
  const specUri = specRef(w.spec);
  const recs = snap.verifications.filter((r) => r.appliedTo === specUri && r.at >= w.createdAt && r.result !== 'skipped');
  const needsRecord = criteria.some((c) => {
    const mineRecs = recs.filter((r) => r.criterion === c.uri);
    const last = mineRecs.at(-1);
    return !last || last.result === 'fail' || ((c.method ?? 'test') === 'test' && !mineRecs.some((r) => r.result === 'pass' && (r.evidence?.test?.trim() || r.codeRefs?.length)));
  });
  const commit = commitStep(w, f, snap);
  if (commit && (needsRecord || (w.kind !== 'review' && w.kind !== 'verify'))) return commit;
  for (const c of criteria) {
    const uri = c.uri;
    const mineRecs = recs.filter((r) => r.criterion === uri);
    const last = mineRecs.at(-1);
    const tested = mineRecs.some((r) => r.result === 'pass' && (r.evidence?.test?.trim() || r.codeRefs?.length));
    if (!last || last.result === 'fail' || ((c.method ?? 'test') === 'test' && !tested)) {
      const planned = (w.planTests ?? []).filter((t) => t.proves.includes(c.id)).map((t) => t.ref ?? t.name);
      const via = c.inherited ? ` inherited from standard ${c.inherited.standardTitle ?? c.inherited.standard} (a must rule: verify it or get a user-approved waiver; work_order_complete is refused otherwise)` : '';
      return { state: 'verify', next: { tool: 'verification_record', args: { criterion: uri, appliedTo: specUri, result: 'pass' }, why: `Run the test for criterion ${c.id} (${c.title})${via}${planned.length ? ` [planned: ${planned.join(', ')}]` : ''} and record the result with evidence.test or codeRefs naming it.` } };
    }
  }
  const unowned = snap.git?.unowned?.[w.id] ?? [];
  if (unowned.length) {
    const none = !(snap.git?.components ?? 0);
    return { state: 'components', next: { tool: none ? 'component_create' : 'component_update', args: { owns: unowned.slice(0, 10) }, why: `These touched files are owned by no component: ${unowned.slice(0, 10).join(', ')}${unowned.length > 10 ? ` (+${unowned.length - 10})` : ''}. ${none ? 'The project has no components yet: create the initial component(s) for the code this work added (component_create)' : 'Create or update the component(s) owning these paths (component_update: add owns globs to the one that holds them, or component_create; reuse before creating)'} (one per code boundary with a single responsibility and interface; code that fits an existing component extends its owns; an external system is kind external) with owns globs, tldr, Responsibility and Interfaces sections, depends_on, and affects links from the spec sections. Then work_order_complete${snap.git?.componentsRequired === false ? '' : ' (it is refused with components_missing while files stay unowned)'}.` } };
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
