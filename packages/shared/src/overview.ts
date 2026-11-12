/**
 * Project overview (`project_overview`): one aggregate for the web UI's landing page, computed in a single pass over
 * the cached model: maturity distribution, what needs attention, work in progress, what is blocked and by what, what
 * awaits a decision, and coverage. Recent changes come from `activity_list`.
 */
import { z } from 'zod';
import type { MaturityStep } from './maturity.js';
import type { GitContext } from './work-orders.js';

export const projectOverviewInputSchema = z
  .object({
    /** Cap of each list (in progress, blocked, decisions); counts are always complete. */
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ProjectOverviewInput = z.input<typeof projectOverviewInputSchema>;

export type OverviewOverlay = 'failing' | 'drifted' | 'blocked' | 'stale';

export interface OverviewSpec {
  id: string;
  title: string;
  step: MaturityStep;
  /** "In progress · 2/5". */
  label: string;
  /** The worst overlay (failing, drifted, blocked, stale). */
  overlay: OverviewOverlay;
  /** Its reason. */
  reason?: string;
}

export interface OverviewWorkOrder {
  id: string;
  title: string;
  spec: string;
  specTitle: string | null;
  kind: string;
  status: string;
  priority?: string;
  sections: { done: number; total: number };
  claim?: { agent: string; branch?: string; startedAt: string; heartbeatAt: string; stale: boolean };
  git: GitContext[];
  hasPlan: boolean;
  updatedAt: string;
}

/** What blocks an item: a depends_on target section that is not implemented (or broken), or an unfinished work order. */
export interface OverviewBlocker {
  uri: string;
  state: 'not_implemented' | 'broken' | 'work_order';
  title: string;
  /** Spec of a section target / of a work order. */
  docId?: string;
  docTitle?: string | null;
  /** The open work order implementing the target (if any): the next link of the chain. */
  workOrder?: { id: string; status: string; agent?: string };
}

export interface OverviewBlocked {
  kind: 'section' | 'work_order';
  uri: string;
  /** Spec id (sections) or work-order id. */
  id: string;
  title: string;
  /** Sections: the spec; work orders: the targeted spec. */
  specId: string;
  specTitle: string | null;
  blockedBy: OverviewBlocker[];
}

export interface ProjectOverview {
  head: string | null;
  at: string;
  maturity: {
    /** Non-archived specs. */
    total: number;
    archived: number;
    steps: Record<MaturityStep, number>;
    overlays: Record<OverviewOverlay, number>;
  };
  attention: {
    failing: number;
    drifted: number;
    blocked: number;
    stale: number;
    /** Open must findings across the latest audits. */
    mustFindings: number;
    staleClaims: number;
    failedWorkOrders: number;
    integrityErrors: number;
    /** Warnings not snoozed. */
    integrityWarnings: number;
    integritySnoozed: number;
    /** Worst specs first (failing, drifted, blocked, stale), capped. */
    specs: OverviewSpec[];
  };
  /** Open work orders that are claimed or in progress (fresh heartbeat first), capped. */
  inProgress: OverviewWorkOrder[];
  inProgressTotal: number;
  /** Open work orders waiting for an agent (pending, unclaimed). */
  queued: number;
  blocked: OverviewBlocked[];
  blockedTotal: number;
  /** Specs whose latest audit has open must findings (capped). */
  mustFindingSpecs: { id: string; title: string; audit: string; openMust: number }[];
  /** Health: maturity steps per category (non-archived specs). */
  byCategory: { category: string; total: number; steps: Record<MaturityStep, number>; specs: { id: string; title: string; step: MaturityStep }[] }[];
  /** Health: specified (non-draft) specs never audited, and specs with unverified / stale must criteria (capped). */
  neverAudited: { id: string; title: string }[];
  unverified: { id: string; title: string; unverified: number; stale: number; total: number }[];
  /** Health: verification gaps per specified spec, worst first (failing, stale, unverified must criteria; never / stale audit). Not capped. */
  gaps: { id: string; title: string; criteria: { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number }; audit: { at: string; stale: boolean } | null }[];
  /** Health: integrity warnings (not snoozed) grouped by rule, largest first; items capped at 50 per rule. */
  warningGroups: { rule: string; count: number; items: { uri: string; message: string }[] }[];
  /** Integrity warnings not snoozed (capped), to fix or acknowledge. */
  warnings: { rule: string; uri: string; message: string; hint?: string }[];
  coverage: {
    /** Gating (must, in force) criteria of non-archived, non-draft specs. */
    criteria: { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number };
    sections: { implemented: number; total: number };
    /** Latest audit per non-archived, non-draft spec. */
    audits: { total: number; never: number; stale: number; recent: number };
    /** Content edits (spec / standard / component text changes) with a recorded cause; null without the index. */
    lineage: { contentEdits: number; withCause: number; ratio: number | null } | null;
  };
}

/* ---------------------------------------------------------------- decisions (`decisions_list`) */

export const DECISION_KINDS = [
  'question',
  'integrity_error',
  'feedback_open',
  'feedback_accepted',
  'waiver_pending',
  'approval_override',
  'standard_draft',
  'stale_claim',
  'audit_contradicted',
  'spec_drifted',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const decisionsListInputSchema = z
  .object({
    kinds: z.array(z.enum(DECISION_KINDS)).min(1).max(DECISION_KINDS.length).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type DecisionsListInput = z.input<typeof decisionsListInputSchema>;

export interface DecisionOption {
  id: string;
  label: string;
  /** The Mandate tool that applies it, when there is one. */
  tool?: string;
}

/** One item needing a human decision: what, the question to ask, the options and a suggested default. */
export interface Decision {
  /** The element to decide on (mandate:// reference). */
  ref: string;
  kind: DecisionKind;
  /** Short label of the element. */
  title: string;
  /** One-line question for the user. */
  question: string;
  options: DecisionOption[];
  /** Suggested default (an option id), when derivable. */
  suggested?: string;
  /** One line of context (why it is pending). */
  context?: string;
  /** Related element (spec of a waiver, feedback of an override, ...). */
  subject?: string;
  /** When it became pending (ISO), when known. */
  since?: string;
  /** Waivers: the feedback item whose acceptance approves it. */
  feedback?: string;
  /** Waivers: approving needs an approval override (the approver wrote the change). */
  selfApproval?: boolean;
  /** Questions (kind `question`): the open question an agent asked through Mandate (answer with question_answer). */
  ask?: import('./questions.js').Question;
}

export interface DecisionsList {
  items: Decision[];
  /** All pending items (before kinds / limit). */
  total: number;
  counts: Record<DecisionKind, number>;
}

/* ---------------------------------------------------------------- integrity snoozes (`integrity_snooze`) */

/** Acknowledged integrity WARNINGS (`integrity-snoozes.jsonl`, append-only): hidden from attention counts until `until`. Errors cannot be snoozed. */
export const INTEGRITY_SNOOZES_FILE = 'integrity-snoozes.jsonl';
export const integritySnoozeSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1).max(80),
  uri: z.string().min(3).max(400),
  /** ISO time the snooze ends. */
  until: z.string(),
  note: z.string().trim().min(1).max(500),
  /** The user or the agent that recorded it. */
  by: z.string().min(1),
  at: z.string(),
});
export type IntegritySnooze = z.infer<typeof integritySnoozeSchema>;
export const integritySnoozeInputSchema = z
  .object({
    rule: z.string().trim().min(1).max(80),
    uri: z.string().trim().min(3).max(400),
    /** Days until the warning counts again (1-90). */
    days: z.number().int().min(1).max(90),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
/** Active snooze of an issue (latest record wins), or undefined. */
export function activeSnooze(snoozes: IntegritySnooze[], rule: string, uri: string, now = Date.now()): IntegritySnooze | undefined {
  let hit: IntegritySnooze | undefined;
  for (const s of snoozes) if (s.rule === rule && s.uri === uri && (!hit || s.at >= hit.at)) hit = s;
  return hit && Date.parse(hit.until) > now ? hit : undefined;
}
