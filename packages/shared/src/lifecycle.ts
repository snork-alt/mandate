/**
 * The LIFECYCLE REGISTRY: for every object kind, its states, the transitions the server allows, the tool that performs
 * each one, its gate (what must be true, and the server check that enforces it), the error codes it can return, and
 * WHEN in the Mandate flow an agent should make it. The transition tables below are the ones the storage layer
 * enforces (they are the single source; `lifecycle_get` serves this registry, tool descriptions and error hints are
 * generated from it). Pure data, no runtime imports beyond base.ts / audits.ts / zod.
 */
import { z } from 'zod';
import { COMPONENT_STATUSES, FEEDBACK_STATUSES, STANDARD_STATUSES, STORED_SPEC_STATUSES, WORK_ORDER_STATUSES } from './base.js';
import { AUDIT_STATUSES, FINDING_STATUSES } from './audits.js';

type StoredSpecStatus = (typeof STORED_SPEC_STATUSES)[number];
type StandardStatus = (typeof STANDARD_STATUSES)[number];
type ComponentStatus = (typeof COMPONENT_STATUSES)[number];
type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
type AuditStatus = (typeof AUDIT_STATUSES)[number];
type FindingStatus = (typeof FINDING_STATUSES)[number];

/* ---------------------------------------------------------------- enforced transition tables (the same status is always allowed) */

/** `done` passes the done gate; `done -> ready` reopens a spec; archived specs only go back to draft. `in_progress` is derived. */
export const SPEC_TRANSITIONS: Record<StoredSpecStatus, StoredSpecStatus[]> = {
  draft: ['ready', 'archived'],
  ready: ['draft', 'done', 'archived'],
  done: ['ready', 'archived'],
  archived: ['draft'],
};
/** Drafts never apply; deprecated standards still apply but point at their successor (supersededBy). */
export const STANDARD_TRANSITIONS: Record<StandardStatus, StandardStatus[]> = {
  draft: ['active'],
  active: ['deprecated'],
  deprecated: ['active'],
};
/** archived is final (components are never deleted, ids never reused). */
export const COMPONENT_TRANSITIONS: Record<ComponentStatus, ComponentStatus[]> = {
  active: ['deprecated', 'archived'],
  deprecated: ['active', 'archived'],
  archived: [],
};
/** Explicit status changes (`done` is also reached by completing every section). */
export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  pending: ['in_progress', 'done', 'failed', 'cancelled'],
  in_progress: ['pending', 'done', 'failed', 'cancelled'],
  failed: ['pending', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};
/** `closed` is final (closed items are immutable). */
export const FEEDBACK_TRANSITIONS: Record<FeedbackStatus, FeedbackStatus[]> = {
  open: ['accepted', 'closed'],
  accepted: ['open', 'closed'],
  closed: [],
};
/** Completed and abandoned audits are frozen (only finding resolutions / re-checks change). */
export const AUDIT_TRANSITIONS: Record<AuditStatus, AuditStatus[]> = {
  in_progress: ['completed', 'abandoned'],
  completed: [],
  abandoned: [],
};
/** Findings resolve only by an explicit re-check (pass -> resolved, wont_fix; fail keeps them open). */
export const FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  open: ['resolved', 'wont_fix'],
  resolved: [],
  wont_fix: [],
};
/** Spec / standard / component sections: archive-only (never deleted, ids never reused). */
export const SECTION_TRANSITIONS = { live: ['archived'], archived: [] } as const satisfies Record<string, readonly string[]>;
export const WORK_ORDER_SECTION_TRANSITIONS = { pending: ['done', 'obsolete'], done: [], obsolete: [] } as const satisfies Record<string, readonly string[]>;
export const COMMENT_TRANSITIONS = { open: ['resolved'], resolved: ['open'] } as const satisfies Record<string, readonly string[]>;
/** Questions close once (answered / cancelled / superseded / expired are frozen). */
export const QUESTION_TRANSITIONS = { open: ['answered', 'cancelled', 'superseded', 'expired'], answered: [], cancelled: [], superseded: [], expired: [] } as const satisfies Record<string, readonly string[]>;

/* ---------------------------------------------------------------- registry */

export const LIFECYCLE_KINDS = [
  'spec', 'spec_section', 'standard', 'standard_section', 'component', 'component_section', 'work_order', 'work_order_section',
  'feedback', 'verification', 'comment', 'question', 'audit', 'audit_finding', 'flow_policy', 'maturity',
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

/** One way into a state. `from` is derived from `table` (never listed twice). */
export interface LifecycleStep {
  to: string;
  /** Tool(s) that make the change ('' = derived / automatic). */
  tools: string[];
  /** What must be true (one line). */
  gate?: string;
  /** The server check that enforces it (file / function). */
  enforcedBy?: string;
  /** Error codes this step can return (actions: ERROR_ACTIONS). */
  errors?: string[];
  /** When in the flow to make it. */
  when: string;
  /** Narrower source states than the table gives (e.g. release only leaves in_progress); must be a subset. */
  from?: string[];
}

export interface LifecycleEntry {
  kind: LifecycleKind;
  states: readonly string[];
  initial: string | null;
  /** Tools that create an object (in `initial`). */
  create?: { tools: string[]; when: string; errors?: string[] };
  /** No way out. */
  terminal: string[];
  /** Content can no longer change (beyond what `notes` says). */
  frozen: string[];
  /** States agents never set (computed by the server). */
  derived: string[];
  /** Allowed from -> to (the enforced table when `enforced`). */
  table: Record<string, readonly string[]>;
  /** The server rejects transitions outside `table` (false: the table describes behaviour without a generic check). */
  enforced: boolean;
  steps: LifecycleStep[];
  notes: string[];
}

export interface LifecycleView extends Omit<LifecycleEntry, 'steps'> {
  steps: (LifecycleStep & { from: string[] })[];
}

const step = (to: string, tools: string[], when: string, x: Omit<LifecycleStep, 'to' | 'tools' | 'when'> = {}): LifecycleStep => ({ to, tools, when, ...x });
const STD_CONFIRM = 'the user confirmed (cause: answered standard_confirmation question; questions in chat: confirmedByUser)';
const SHRINK = 'removing criteria from a done or claimed spec needs addresses: [accepted feedback]';

const sectionEntry = (kind: 'spec_section' | 'standard_section' | 'component_section', prefix: 'spec' | 'standard' | 'component', extra: string[]): LifecycleEntry => ({
  kind,
  states: ['live', 'archived'],
  initial: 'live',
  terminal: ['archived'],
  frozen: ['archived'],
  derived: [],
  table: SECTION_TRANSITIONS,
  enforced: true,
  create: { tools: ['section_insert'], when: 'add a requirement / rule / description (Mandate assigns the id from the title; ids are never reused)', errors: ['invalid_section_type'] },
  steps: [
    step('archived', ['archive'], 'the section is dropped or replaced: archive it (then insert a successor); never delete', {
      ...(prefix === 'component' ? {} : { gate: prefix === 'spec' ? SHRINK : STD_CONFIRM }),
      enforcedBy: 'DocRules.beforeWrite: section_referenced, criteria_shrink; DocWrites.sectionArchive',
      errors: prefix === 'spec' ? ['criteria_shrink', 'validation'] : ['validation'],
    }),
  ],
  notes: ['Archived sections cannot be edited (validation); removing a referenced section fails with section_referenced: archive it instead.', ...extra],
});

const ENTRIES: LifecycleEntry[] = [
  {
    kind: 'spec',
    states: ['draft', 'ready', 'in_progress', 'done', 'archived'],
    initial: 'draft',
    create: { tools: ['create'], when: 'INTAKE, a new feature with no fitting spec (starts draft; Mandate assigns the id)' },
    terminal: [],
    frozen: [],
    derived: ['in_progress'],
    table: SPEC_TRANSITIONS,
    enforced: true,
    steps: [
      step('draft', ['status_set'], 'back to discussion; archived -> draft restores an archived spec'),
      step('ready', ['status_set'], 'once every section has acceptance criteria and the user approved them; done -> ready reopens a done spec before an update work order changes it', { gate: 'every live section has an acceptance criterion (own, verifiedBy or a followed rule)', enforcedBy: 'DocRules.beforeWrite (ready_gate)', errors: ['ready_gate', 'transition_not_allowed'] }),
      step('done', ['status_set'], 'when every implement/update work order on its sections is complete AND every must criterion is verified or waived; never force it', {
        gate: 'DONE GATE: every own and inherited criterion verified or waived (approved), no blocked / broken depends_on section, no open implement/update work order',
        enforcedBy: 'VerificationService.gate (storage/verification.ts), run by DocRules.beforeWrite',
        errors: ['done_gate', 'transition_not_allowed'],
      }),
      step('archived', ['archive', 'status_set'], 'the feature is dropped or replaced (user decision); cancels its open work orders'),
    ],
    notes: [
      'in_progress is derived (an open work order on the spec is claimed): never set it.',
      'Drift: a done spec whose criteria were added / changed / unverified since the gate shows as drifted: reopen (done -> ready), deliver an update work order, re-verify, set done again.',
      `Criteria shrink: ${SHRINK} (criteria_shrink).`,
      'Waivers (deviates_from with feedback) and exemptions (exemptFrom) count only with feedback that is accepted (or closed applied) AND filed by someone other than the principal writing the waiver (validation otherwise).',
    ],
  },
  sectionEntry('spec_section', 'spec', ['Pending work-order sections on an archived spec section become obsolete.']),
  {
    kind: 'standard',
    states: ['draft', 'active', 'deprecated'],
    initial: 'active',
    create: { tools: ['create'], when: 'a cross-cutting rule the user confirmed (starts active)' },
    terminal: [],
    frozen: [],
    derived: [],
    table: STANDARD_TRANSITIONS,
    enforced: true,
    steps: [
      step('active', ['status_set'], 'only after the user confirmed the rules (drafts never apply); deprecated -> active revives it', { gate: STD_CONFIRM }),
      step('deprecated', ['status_set'], 'a successor standard replaces it (still applies; specs are told to move)', {
        gate: 'supersededBy = another existing standard',
        enforcedBy: 'DocRules.beforeWrite (storage/doc-rules.ts)',
        errors: ['invalid_standard', 'transition_not_allowed'],
      }),
    ],
    notes: [
      'Every standard_* write needs explicit user confirmation, even with approval off.',
      'effectiveFrom (update_meta: ISO date or commit): before it, rules are announced, not required.',
      'Standards are never archived: deprecate with supersededBy.',
    ],
  },
  sectionEntry('standard_section', 'standard', ['Rule sections need level must | should | may; must rules gate done specs, should rules warn.']),
  {
    kind: 'component',
    states: [...COMPONENT_STATUSES],
    initial: 'active',
    create: { tools: ['create'], when: 'INTAKE step 5, a new part of the architecture (owns globs, layer, parent)', errors: ['archived_parent', 'invalid_parent'] },
    terminal: ['archived'],
    frozen: ['archived'],
    derived: [],
    table: COMPONENT_TRANSITIONS,
    enforced: true,
    steps: [
      step('active', ['status_set'], 'deprecated -> active revives it', { errors: ['archived_parent'] }),
      step('deprecated', ['status_set'], 'being phased out: deprecate BEFORE archiving, so dependants see it'),
      step('archived', ['archive', 'status_set'], 'gone from the code: archive bottom-up (children first)', {
        gate: 'no non-archived children; a live child cannot sit under an archived parent',
        enforcedBy: 'DocRules.beforeWrite (storage/doc-rules.ts)',
        errors: ['has_children', 'archived_parent', 'transition_not_allowed'],
      }),
    ],
    notes: ['Archiving never cascades. New affects / depends_on links to an archived component are rejected.'],
  },
  sectionEntry('component_section', 'component', ['Components hold no criteria or rules (invalid_section_type).']),
  {
    kind: 'work_order',
    states: [...WORK_ORDER_STATUSES],
    initial: 'pending',
    create: { tools: ['work_order_create'], when: 'after the approved spec edit (reason: [feedback], plan); at most one open implement/update work order per section', errors: ['validation'] },
    terminal: ['done', 'cancelled'],
    frozen: ['done', 'failed', 'cancelled'],
    derived: [],
    table: WORK_ORDER_TRANSITIONS,
    enforced: true,
    steps: [
      step('pending', ['work_order_release'], 'give a claimed work order back (not for finished work: with every section done the claim is released automatically)', { from: ['in_progress'] }),
      step('in_progress', ['work_order_claim', 'work_order_next'], 'when you start delivery (also reopens a failed one; claiming an all-sections-done work order keeps its progress)', {
        gate: 'a plan (work_order_plan_set) unless fastPath fix; no fresh claim by another agent',
        enforcedBy: 'WorkOrderService.claim (storage/work-orders.ts)',
        errors: ['plan_required', 'claim_conflict', 'transition_not_allowed'],
      }),
      step('done', ['work_order_complete'], 'after every section is done, verified and reconciled', {
        gate: 'you hold the claim, or nobody does and every section is done (the last work_order_section_done releases the claim: any agent may complete); outcome given; no unresolved blocking comment',
        enforcedBy: 'WorkOrderService.complete (storage/work-orders.ts)',
        errors: ['outcome_required', 'open_comments', 'not_claimed', 'claim_conflict', 'stale_claim', 'transition_not_allowed'],
      }),
      step('failed', ['work_order_fail'], 'you cannot deliver it (note why); claim again to retry', { errors: ['transition_not_allowed'] }),
      step('cancelled', ['work_order_cancel'], 'the work is no longer wanted (automatic when the spec is archived)', { errors: ['transition_not_allowed'] }),
    ],
    notes: ['Closed work orders are frozen: only PR status / merge fields change (work_order_git_update); other writes give work_order_frozen.', 'A claim without heartbeat for 30 min is stale: work_order_claim takes it over.', 'The last section done / obsolete releases the claim automatically (status stays in_progress, no heartbeat or staleness after): then call work_order_complete (outcome, reconciliation); no claim needed.'],
  },
  {
    kind: 'work_order_section',
    states: ['pending', 'done', 'obsolete'],
    initial: 'pending',
    terminal: ['done', 'obsolete'],
    frozen: [],
    derived: [],
    table: WORK_ORDER_SECTION_TRANSITIONS,
    enforced: false,
    steps: [
      step('done', ['work_order_section_done', 'work_order_complete'], 'as each section lands (notes, codeRefs, deviations); complete marks the rest done', { gate: 'you hold the claim (or nobody does and every section is already done)', errors: ['work_order_frozen', 'not_claimed', 'claim_conflict', 'stale_claim'] }),
      step('obsolete', ['work_order_section_done'], 'the spec section was archived or superseded (automatic on archive)'),
    ],
    notes: ['done on implement/update records implementedCommit on the spec section.'],
  },
  {
    kind: 'feedback',
    states: [...FEEDBACK_STATUSES],
    initial: 'open',
    create: { tools: ['feedback_create'], when: 'INTAKE step 1 (the user\'s words; improvement / bug may omit targets until spec_match), a spec unclear mid-delivery, or a spec_wrong / ambiguous finding (fromFinding)' },
    terminal: ['closed'],
    frozen: ['closed'],
    derived: [],
    table: FEEDBACK_TRANSITIONS,
    enforced: true,
    steps: [
      step('open', [], 'accepted -> open: not exposed to agents'),
      step('accepted', ['feedback_accept'], 'at APPROVAL, when the user says "go": it will be acted on; it is the approval for waivers / exemptions / criteria removals', {
        gate: 'approvals need filer and accepter other than the writer; override: true + overrideReason only for the sole active user (distinct Mandate-User writers in 90 days, service accounts excluded), an admin, or local mode',
        enforcedBy: 'LinkService.validate, DocRules (waiver_self_approved); feedback_accept (override_not_allowed)',
        errors: ['waiver_self_approved', 'override_not_allowed'],
      }),
      step('closed', ['feedback_close'], 'after the last spec / standard write that addresses it: applied (changes linked by addresses), rejected (resolutionNote), duplicate (duplicateOf)', {
        gate: 'resolution; rejected needs resolutionNote, duplicate needs duplicateOf, applied needs a linked change (addresses / cause / relatedTo a commit)',
        enforcedBy: 'feedback schema checkResolution + FeedbackService.beforeWrite (storage/feedback.ts)',
        errors: ['validation', 'feedback_closed', 'applied_without_changes'],
      }),
    ],
    notes: ['Closed feedback is immutable and can no longer be addressed by new writes (feedback_closed): file a new item with relatedTo.', 'A waiver / exemption needs accepted feedback filed by someone OTHER than whoever writes the waiver: have the user (or another agent) file it.'],
  },
  {
    kind: 'verification',
    states: ['recorded'],
    initial: 'recorded',
    terminal: ['recorded'],
    frozen: ['recorded'],
    derived: [],
    table: { recorded: [] },
    enforced: true,
    create: { tools: ['verification_record'], when: 'per acceptance criterion after implementing (pass / fail with evidence, codeRefs)', errors: ['append_only', 'validation', 'not_found'] },
    steps: [],
    notes: ['Append-only: a newer result supersedes an older one; never edit. Archived specs reject results.'],
  },
  {
    kind: 'comment',
    states: ['open', 'resolved'],
    initial: 'open',
    create: { tools: ['comment_add'], when: 'review findings on the work-order sections you review (blocking: true for must-fix); replies use parent', errors: ['work_order_frozen', 'invalid_target', 'invalid_parent'] },
    terminal: [],
    frozen: [],
    derived: [],
    table: COMMENT_TRANSITIONS,
    enforced: false,
    steps: [
      step('open', ['comment_reopen'], 'the fix did not hold', { errors: ['work_order_frozen'] }),
      step('resolved', ['comment_resolve'], 'after the fix (implementer or reviewer)'),
    ],
    notes: ['Append-only (corrections are replies). On a closed work order only replies to existing threads are allowed.', 'Unresolved blocking comments fail work_order_complete (open_comments).'],
  },
  {
    kind: 'question',
    states: ['open', 'answered', 'cancelled', 'superseded', 'expired'],
    initial: 'open',
    create: {
      tools: ['question_ask'],
      when: 'you need a user decision, confirmation (standards) or approval: ask through Mandate (options + recommended) instead of your harness question tool, unless project_info.effective.questions is chat; keep working on what does not depend on the answer',
      errors: ['validation', 'question_frozen'],
    },
    terminal: ['answered', 'cancelled', 'superseded', 'expired'],
    frozen: ['answered', 'cancelled', 'superseded', 'expired'],
    derived: ['expired'],
    table: QUESTION_TRANSITIONS,
    enforced: true,
    steps: [
      step('answered', ['question_answer'], 'the user answers in the web UI (agents never answer for the user)', { gate: 'every question answered with its option labels (free text allowed for single choice)', enforcedBy: 'QuestionService.check (storage/questions.ts)', errors: ['question_frozen', 'forbidden', 'validation'] }),
      step('cancelled', ['question_cancel'], 'the question no longer matters (with a reason)', { errors: ['question_frozen'] }),
      step('superseded', ['question_ask'], 'question_ask with supersedes: <id> replaces an open question', { errors: ['question_frozen'] }),
    ],
    notes: [
      'After asking: continue with work that does not depend on the answer. Answers arrive as a notifications/mandate/question_answered notification while your session is connected; else poll list { of: "questions", mine: true, status: "answered", since } at checkpoints (after each section or step). If everything is blocked, tell the user and stop. If the user is chatting with you and the question blocks all progress, you may ask in chat as well.',
      'Proof: cite an answered question as cause. standard_* writes citing a standard_confirmation question record User-Confirmed: <id> (the answering user); feedback_accept citing an approval question records User-Approved: <id> and, with override, checks the answering user\'s eligibility. Unanswered, or answered by someone not allowed to confirm: question_not_answered / question_ineligible.',
    ],
  },
  {
    kind: 'audit',
    states: [...AUDIT_STATUSES],
    initial: 'in_progress',
    create: { tools: ['audit_start'], when: 'the user asks for an audit, after audit_plan' },
    terminal: ['completed', 'abandoned'],
    frozen: ['completed', 'abandoned'],
    derived: [],
    table: AUDIT_TRANSITIONS,
    enforced: true,
    steps: [
      step('completed', ['audit_complete'], 'after recording every item', {
        gate: 'every must item recorded (notes on fail / partial) and an overview',
        enforcedBy: 'AuditService.complete (storage/audits.ts)',
        errors: ['audit_incomplete', 'audit_frozen'],
      }),
      step('abandoned', ['audit_abandon'], 'the audit cannot be finished (reason)', { errors: ['audit_frozen'] }),
    ],
    notes: ['Frozen after completion: only finding resolutions and re-checks change; re-audit with a new audit_start.'],
  },
  {
    kind: 'audit_finding',
    states: [...FINDING_STATUSES],
    initial: 'open',
    terminal: ['resolved', 'wont_fix'],
    frozen: ['resolved', 'wont_fix'],
    derived: [],
    table: FINDING_TRANSITIONS,
    enforced: true,
    steps: [
      step('resolved', ['audit_recheck'], 'after the fix work order completes: re-check on the SAME audit with result pass (fail keeps it open)', { errors: ['finding_closed', 'audit_frozen'], enforcedBy: 'AuditService.recheck (storage/audits.ts)' }),
      step('wont_fix', ['audit_recheck'], 'the user accepts it as is (notes required)', { gate: 'notes', errors: ['finding_closed', 'validation'] }),
      step('open', ['audit_finding_relink'], 'its fix work order was cancelled or failed: link the replacement (frozen audits too)', { errors: ['finding_linked', 'finding_closed'], enforcedBy: 'AuditService.relinkFinding (storage/audits.ts)' }),
    ],
    notes: ['Never resolved automatically. code_deviates -> fix work orders (audit_findings_to_work_orders); spec_wrong / ambiguous -> feedback_create fromFinding.'],
  },
  {
    kind: 'flow_policy',
    states: ['required', 'optional', 'off'],
    initial: 'optional',
    terminal: [],
    frozen: [],
    derived: [],
    table: { required: ['optional', 'off'], optional: ['required', 'off'], off: ['required', 'optional'] },
    enforced: false,
    steps: [
      step('optional', ['flow_policy_set'], 'web UI admins only; each client then chooses with flow_set (on / off, approval on / off)', {
        gate: 'web UI admins only; agents use flow_set, which must not contradict the policy',
        enforcedBy: 'callTool uiOnly (mcp/define.ts); settings.refusal (projects/settings.ts)',
        errors: ['forbidden', 'policy_required', 'policy_off'],
      }),
      step('required', ['flow_policy_set'], 'web UI admins only: every agent follows the flow'),
      step('off', ['flow_policy_set'], 'web UI admins only: Mandate is read-only context'),
    ],
    notes: ['project_info returns the effective { flow, approval } and why. approvalPolicy: required | optional.'],
  },
  {
    kind: 'maturity',
    states: ['draft', 'specified', 'in_progress', 'implemented', 'verified', 'audited'],
    initial: 'draft',
    terminal: [],
    frozen: [],
    derived: ['draft', 'specified', 'in_progress', 'implemented', 'verified', 'audited'],
    table: {},
    enforced: false,
    steps: [],
    notes: ['Derived from spec status, work orders, verifications and audits; agents never set it. Overlays: archived, failing, drifted, blocked, stale. Raise it by doing the work (implement, verify, audit).'],
  },
];

export const LIFECYCLE: Record<LifecycleKind, LifecycleEntry> = Object.fromEntries(ENTRIES.map((e) => [e.kind, e])) as Record<LifecycleKind, LifecycleEntry>;

/** Source states of a target state in a table. */
const sources = (table: Record<string, readonly string[]>, to: string) => Object.entries(table).filter(([s, next]) => s !== to && next.includes(to)).map(([s]) => s);

/** An entry with each step's `from` states derived from its table (or the step's narrower list). */
export function lifecycleView(kind: LifecycleKind): LifecycleView {
  const e = LIFECYCLE[kind];
  return { ...e, steps: e.steps.map((s) => ({ ...s, from: s.from ?? sources(e.table, s.to) })) };
}

/** One line for a status-changing tool's description: the transitions it makes and their gates. */
export function gateSummary(tool: string): string {
  const parts: [string, string][] = [];
  for (const kind of LIFECYCLE_KINDS) {
    const v = lifecycleView(kind);
    for (const s of v.steps) if (s.tools.includes(tool)) parts.push([kind, `${s.from.length ? `${s.from.join('|')} -> ${s.to}` : `stays ${s.to}`}${s.gate ? ` (${s.gate})` : ''}`]);
  }
  if (!parts.length) return '';
  const kinds = [...new Set(parts.map(([k]) => k))];
  const text = parts.map(([k, p]) => (kinds.length > 1 ? `${k} ${p}` : p)).join('; ');
  return `Lifecycle: ${text}. Rules: lifecycle_get { kind${kinds.length > 1 ? '' : `: "${kinds[0]}"`} }.`;
}

/* ---------------------------------------------------------------- error playbook */

/** Recommended action per structured error code (the `hint` when the error carries none). */
export const ERROR_ACTIONS: Record<string, string> = {
  flow_off: 'the Mandate flow is off for this coding agent: stop calling Mandate write tools, work directly in the code and use Mandate as read-only context; save this to your memory. Only the user turns it back on (/mandate-flow on)',
  transition_not_allowed: 'not allowed from the current status: lifecycle_get { kind } lists the allowed moves; go through the intermediate status (e.g. reopen done -> ready)',
  done_gate: 'never force it (no override passes it): verify (verification_record) each detail.failures criterion or ask the user whether to waive it, unblock sections, complete open implement/update work orders, then retry',
  plan_required: 'write the plan (work_order_plan_set), then claim',
  open_comments: 'answer, fix and comment_resolve each blocking comment in detail.threads, then retry',
  outcome_required: 'pass outcome (what was delivered)',
  claim_conflict: 'another agent holds a fresh claim: pick another work order (work_order_next) or coordinate (comment_add)',
  stale_claim: 'the claim is stale: work_order_claim to take it over, then retry',
  not_claimed: 'claim the work order first (work_order_claim), then retry (not needed to complete once every section is done: the claim is released automatically)',
  ready_gate: 'every live section needs an acceptance criterion: insert one per listed section (or verifiedBy an existing one), then set ready',
  waiver_self_approved: 'approval must come from someone else: ask the user (question_ask purpose approval). Only if the user explicitly says to self-approve: feedback_accept with override: true, overrideReason (their words) and cause: the answered question',
  override_not_allowed: 'self-approval is only for the sole active user, or an admin, and only when the user says so: ask another user to accept the feedback',
  all_done: 'every section is done: the agent only has to call work_order_complete (outcome, reconciliation); no claim and no release needed',
  claim_fresh: 'the claim has a recent heartbeat: only a stale claim can be released from the web UI; ask the agent or wait',
  not_snoozable: 'integrity errors cannot be snoozed: fix the error (its hint says how)',
  work_order_frozen: 'the work order is closed: only work_order_git_update (PR / merge) and replies are allowed; open a new work order for more work',
  cycle: 'the link would close a dependency cycle: link the other way or drop a link',
  superseded_target: 'link to the successor the message names',
  feedback_closed: 'closed feedback is immutable and cannot be addressed: file a new item (relatedTo the closed one)',
  applied_without_changes: 'applied needs a linked change: pass addresses: [the feedback] (or cause) on the writes that applied it, or relatedTo the commit (mandate://commits/<sha>); else close it rejected / duplicate',
  append_only: 'records are append-only: record a new result instead',
  archive_only: 'nothing is deleted: archive it (archive: a spec, component or section)',
  section_referenced: 'the section is referenced: archive it instead of removing it',
  id_reused: 'ids are never reused (Mandate assigns new ones)',
  integrity_violation: 'the write would break an integrity rule (detail.issues): fix the cause the hint names, then retry',
  criteria_shrink: 'removing criteria from a done or claimed spec: get the change approved as feedback (feedback_accept), pass addresses: [that item], retry',
  stale_version: 're-read the document and retry with its current reference',
  audit_frozen: 'the audit is completed or abandoned: audit_recheck findings, or audit_start a new audit',
  audit_incomplete: 'record every must item in detail.missing (notes on fail / partial) and the overview, then retry',
  audit_not_completed: 'audit_complete it first',
  not_in_plan: 'record only items of the audit plan (detail.items or get on the audit)',
  notes_required: 'explain in notes how the code was checked and why it fails, then retry',
  finding_closed: 'the finding is already resolved or wont_fix: nothing to re-check',
  finding_linked: 'the finding is linked to a live work order: cancel it (work_order_cancel) before relinking',
  has_children: 'archive or move (update_meta parent) the listed children first (bottom-up)',
  archived_parent: 'pick a live parent, or archive this component too',
  invalid_parent: 'parent must be an existing component other than itself (or a reply on the same document)',
  invalid_section_type: 'specs take acceptance sections, standards rule sections, components neither: use the right type',
  invalid_standard: 'deprecating needs supersededBy = another existing standard',
  invalid_target: 'comment on a work order or document section: mandate://work-orders/<id>/sections/<sid>',
  policy_required: 'the project policy requires it; tell the user an admin can change Settings → Agent flow',
  policy_off: 'the project policy turns the flow off; use Mandate read-only; an admin can change it',
  confirmation_required: 'question_ask purpose standard_confirmation (the exact change and why), wait for the answer, then retry with cause: the answered question (questions in chat: ask in chat, then confirmedByUser: true)',
  question_frozen: 'the question is already answered, cancelled, superseded or expired: get it, or ask a new one',
  question_not_answered: 'wait for the answer (list { of: "questions", mine: true, status: "answered" }) before citing the question',
  question_ineligible: 'the question was answered by someone who may not confirm / approve this: ask again for an eligible user',
  question_purpose: 'cite a question of the right purpose (standard_confirmation for standards, approval for approvals)',
  invalid_cause: 'cause must reference existing items (feedback, finding, work order, section)',
  invalid_annotation: 'lineage_annotate: pass a full commit sha of the data repo and existing cause references (never later than the commit)',
  missing_cause: 'warning: pass cause (the feedback, finding, work order or section the write acts on) on the next writes',
  forbidden: 'not allowed for this principal: ask the user (admin action, web UI, or write access)',
  agent_required: 'pass agent (your agent name)',
  idempotency_conflict: 'this idempotencyKey was used with other input: use a new key',
  not_found: 'list or search to find valid ids and references',
  validation: 'fix the input (see message) and retry',
  invalid_input: 'fix the input; the tool input schema lists every field',
  invalid_document: 'fix the document structure (see message)',
  migration_pending: 'the server is migrating work orders: retry shortly',
  index_unavailable: 'the index is rebuilding: retry shortly',
  unavailable: 'not available on this server: continue without it',
  activity_unavailable: 'activity is not available on this server: use history tools',
  no_session: 'needs an MCP session (Streamable HTTP with a session id)',
  unknown_tool: 'call tools/list for the available tools',
  not_configured: 'Ask has no model configured: ask_status shows what is missing; tell the user',
  code_repo_unavailable: 'the server cannot read that code repo: pass touched files yourself (work_order_touch)',
  alt_required: 'image sections need alt text: pass alt (what the image shows, for agents, search and Ask)',
  type_mismatch: 'the uploaded bytes are not the declared image type: send the right Content-Type (or none) and a PNG, JPEG, GIF, WebP or SVG file',
  image_upload_required: 'image files are uploaded with curl (project_info.upload.image / upload_url_create), not set in section bodies: only alt and caption can be edited',
  no_override: 'this feedback item has no approval override to confirm: check list { of: "decisions" } for open overrides',
  already_confirmed: 'the override is already confirmed: nothing to do',
  unknown_code_repo: 'use a registered code repository short name: project_info.codeRepos lists them (match your git remote); an admin adds repos in project settings',
  code_commit_required: 'pass the code repository and commit (code { repo, commit, dirty? }): run git rev-parse HEAD; uncommitted changes: dirty: true',
  invalid_code_repos: 'fix the code repository list: short names are lowercase letters, digits and dashes, unique, and not the specs repository',
  not_available: 'this tool works only for coding agents on a project endpoint (agent key or personal token), not from the web UI or in-process callers',
  wait_in_progress: 'another news_list wait is already running for this session: wait for it to return, then call again',
  internal: 'unexpected server error: retry once, then report it with the input',
};

/* ---------------------------------------------------------------- integrity rules */

/**
 * The integrity rules (repo lint). ERROR rules are invariants: a write that would introduce one is rejected before its
 * commit (the domain check named in `enforcedBy`, backed by the generic pre-commit gate `IntegrityService.guard`), so
 * only hand edits, pulls and merges can bring one in. WARNING rules are gaps, reported (with a hint), never blocking.
 * `scope`: element = checked per element (incrementally after each write for the written element and its neighbours);
 * global = re-derived for the whole repo after each write (cheap graph-wide rules); full = only on full re-checks
 * (startup, after pulls / merges / outside commits, periodically).
 */
export interface IntegrityRule {
  rule: string;
  severity: 'error' | 'warning';
  scope: 'element' | 'global' | 'full';
  what: string;
  hint: string;
  enforcedBy?: string;
}

const GATE = 'IntegrityService.guard (pre-commit)';
const rule = (r: string, severity: IntegrityRule['severity'], scope: IntegrityRule['scope'], what: string, hint: string, enforcedBy?: string): IntegrityRule => ({ rule: r, severity, scope, what, hint, ...(enforcedBy ? { enforcedBy: `${enforcedBy}; ${GATE}` } : {}) });

export const INTEGRITY_RULES: IntegrityRule[] = [
  rule('dangling_link', 'error', 'element', 'a section link whose target document or section does not exist', 'link an existing target (or remove the link)', 'LinkService.validate'),
  rule('dangling_reference', 'error', 'element', 'a component parent, standard supersededBy or work-order spec that does not exist', 'point it at an existing document', 'DocRules.beforeWrite (invalid_parent, invalid_standard); WorkOrderService.checkPin'),
  rule('invalid_link', 'error', 'element', 'a link in a forbidden direction or with a forbidden rel, a duplicate target or a missing note', 'use an allowed rel / direction (lifecycle_get, tool descriptions)', 'checkLinks (document validation)'),
  rule('archived_parent', 'error', 'element', 'a live component under an archived parent', 'move it to a live parent or archive it too', 'DocRules.beforeWrite (archived_parent, has_children)'),
  rule('short_sha', 'error', 'element', 'a stored commit pin that is not a full sha', 'store the full 40-char sha', 'server-resolved commits'),
  rule('claim_on_closed', 'error', 'element', 'a closed work order that still carries a claim', 'closing ends the claim', 'WorkOrderService.beforeWrite'),
  rule('depends_on_cycle', 'error', 'global', 'a cycle of spec depends_on links (section or spec level)', 'drop or reverse a link of the cycle', 'LinkService.validate (cycle)'),
  rule('component_cycle', 'error', 'global', 'a cycle of component depends_on links', 'drop or reverse a link of the cycle', 'LinkService.validate (cycle)'),
  rule('contains_cycle', 'error', 'global', 'a cycle of component parents', 'pick another parent', 'LinkService.validate (cycle)'),
  rule('extends_cycle', 'error', 'global', 'a cycle of extends links between standards', 'drop a link of the cycle', 'LinkService.validate (cycle)'),
  rule('supersedes_cycle', 'error', 'global', 'a cycle of supersedes links', 'drop a link of the cycle', 'LinkService.validate (cycle)'),
  rule('supersedes_successors', 'error', 'global', 'a section with more than one live successor', 'archive all but one successor', 'LinkService.validate (superseded_target)'),
  rule('standard_successor_loop', 'error', 'element', 'a standard that extends or supersedes its own successor (supersededBy)', 'link the other way: the successor supersedes the old standard', 'generic gate only'),
  rule('duplicate_open_work_order', 'error', 'global', 'more than one open implement / update work order on a section', 'cancel the duplicate (work_order_cancel)', 'WorkOrderService.beforeWrite'),
  rule('feedback_tampered', 'error', 'full', 'a closed feedback item edited after it was closed', 'restore the closed item; file a new one (relatedTo it)', 'FeedbackService.check (closed items are immutable)'),
  rule('component_unreferenced', 'warning', 'global', 'an active component no spec section affects', 'add an affects link from the spec sections that change it'),
  rule('component_no_standards', 'warning', 'global', 'an active, non-external component no standard applies to', 'add follows links to the standards that apply'),
  rule('component_no_code', 'warning', 'global', 'an active, non-external component that owns no code', 'declare owns globs, or set kind external'),
  rule('unowned_code_ref', 'warning', 'global', 'a code ref no component owns', 'add an owns glob to the component that holds the file'),
  rule('owns_matches_nothing', 'warning', 'global', 'an owns glob that matches no referenced code', 'fix the glob, or add refs to the code it owns'),
  rule('spec_ready_without_criteria', 'error', 'element', 'a spec moving to ready while a live section has no acceptance criterion', 'add an acceptance criterion for each listed section (or verifiedBy one), then set ready', 'DocRules.beforeWrite (ready_gate)'),
  rule('spec_section_without_criteria', 'warning', 'element', 'a section of a ready / done spec without an acceptance criterion (own acceptance, verifiedBy or a followed rule)', 'add an acceptance criterion that verifies it (section_insert type acceptance, verifiedBy)'),
  rule('self_approved_override', 'warning', 'global', 'a feedback item accepted with an approval override (it may approve its accepter\'s own waivers / exemptions / criteria removals)', 'have another person review it; the override reason is on the item and its Approval-Override commit'),
  rule('spec_done_without_criteria', 'warning', 'element', 'a done spec without any live acceptance criterion', 'add acceptance criteria (section_insert type acceptance) and verify them'),
  rule('external_follows_internal', 'warning', 'element', 'an external component that follows internal code rules (rules with a code scope or check)', 'move the follows link to the internal component that calls the service'),
  rule('audit_pass_contradicted', 'warning', 'global', 'an audit item recorded pass while an open must / critical finding of the same audit contradicts it (its own, or one on the code it verifies)', 'record a failing verification and re-audit the item'),
  rule('fix_misses_finding_code', 'warning', 'global', 'an open fix work order whose sections miss the spec section owning a finding\'s code', 'create the fix on the section whose code refs contain the finding\'s code'),
  rule('done_spec_drift', 'warning', 'full', 'a done spec whose criteria drifted from its done gate (added, changed or unverified criteria)', 'verify the criteria (verification_record), or reopen the spec'),
];
export const INTEGRITY_RULE: Record<string, IntegrityRule> = Object.fromEntries(INTEGRITY_RULES.map((r) => [r.rule, r]));
/** Severity of a rule (unknown rules are errors). */
export const integritySeverity = (r: string): 'error' | 'warning' => INTEGRITY_RULE[r]?.severity ?? 'error';

/* ---------------------------------------------------------------- lifecycle_get input */

/** `integrity`: the integrity rules (repo lint). Without kind: the kind list and the error actions. */
export const lifecycleGetInputSchema = z.object({ kind: z.enum([...LIFECYCLE_KINDS, 'integrity']).optional() }).strict();
export type LifecycleGetInput = z.infer<typeof lifecycleGetInputSchema>;
