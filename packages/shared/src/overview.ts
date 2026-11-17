/**
 * Project overview (`project_overview`): one aggregate for the web UI's landing page, computed in a single pass over
 * the cached model: maturity distribution, what needs attention, work in progress, what is blocked and by what, what
 * awaits a decision, and coverage. Recent changes come from `activity_list`.
 */
import { z } from 'zod';
import type { MaturityStep, SpecMaturity } from './maturity.js';
import type { GitContext } from './work-orders.js';
import { stepsProgress, type PlanStep } from './plan-steps.js';

export const projectOverviewInputSchema = z
  .object({
    /** Cap of each list (in progress, blocked, decisions); counts are always complete. */
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ProjectOverviewInput = z.input<typeof projectOverviewInputSchema>;

export type OverviewOverlay = 'failing' | 'outdated' | 'blocked';

export interface OverviewSpec {
  id: string;
  title: string;
  step: MaturityStep;
  /** "In progress · 2/5". */
  label: string;
  /** The worst overlay (failing, outdated, blocked). */
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
  /** Plan progress: its steps (top-level list items of the `plan` section); `done` / `current` when they are checkboxes. */
  plan?: PlanProgress;
  updatedAt: string;
}

/** Steps of a work-order plan: top-level list items (`1.` / `-` / `- [ ]`); checked boxes count as done. */
export interface PlanProgress {
  total: number;
  /** Checked items (only when the plan uses checkboxes). */
  done?: number;
  /** The current step (1-based index and text): the in-progress one, else the first unfinished; when the plan has steps. */
  current?: { index: number; text: string; id?: string };
  /** Structured steps (id, text, status, note) when the work order has them. */
  steps?: { id: string; text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped'; note?: string }[];
}

/** Progress from structured steps (finished = done or skipped; current = the in-progress step, else the first pending). */
export function stepsPlanProgress(steps: PlanStep[]): PlanProgress | null {
  if (!steps.length) return null;
  const p = stepsProgress(steps);
  return { total: p.total, done: p.done, ...(p.current ? { current: p.current } : {}), steps: steps.map((s) => ({ id: s.id, text: s.text, status: s.status, ...(s.note ? { note: s.note } : {}) })) };
}

/** Parse a plan's steps (pure). Null when the plan has no list. */
export function planProgress(md: string): PlanProgress | null {
  // A structured plan (work_order_create plan): only its **Steps** are steps (files, tests and risks are lists too).
  const steps = /^\*\*(?:Tasks|Steps)\*\*[^\n]*\n([\s\S]*?)(?=^\*\*[^*\n]+\*\*\s*$|(?![\s\S]))/m.exec(md);
  if (steps) md = steps[1]!;
  const items: { text: string; box: boolean; checked: boolean }[] = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX~-])\]\s+)?(.*\S)\s*$/.exec(line);
    if (!m) continue;
    items.push({ text: m[2]!.replace(/[*_`]/g, ''), box: m[1] !== undefined, checked: m[1] === 'x' || m[1] === 'X' || m[1] === '-' });
  }
  if (!items.length) return null;
  if (!items.some((i) => i.box)) return { total: items.length };
  const done = items.filter((i) => i.checked).length;
  const idx = items.findIndex((i) => !i.checked);
  return { total: items.length, done, ...(idx >= 0 ? { current: { index: idx + 1, text: items[idx]!.text } } : {}) };
}

/** One claim session of an agent on a work order (current or ended), for the "Agents today" timeline. */
export interface OverviewSession {
  workOrder: string;
  kind: string;
  title: string;
  agent: string;
  startedAt: string;
  /** Ended claims: when and how. */
  endedAt?: string;
  ended?: string;
  /** Current claim: the last heartbeat and whether it is stale. */
  heartbeatAt?: string;
  stale?: boolean;
}

/** A work order completed recently (duration = its last claim's start to completion). */
export interface OverviewCompleted {
  id: string;
  title: string;
  kind: string;
  spec: string;
  specTitle: string | null;
  agent?: string;
  startedAt?: string;
  completedAt: string;
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

/** One open must finding of a spec's latest audit (Actions › Must findings). */
export interface OverviewMustFinding {
  /** The finding (`.../findings/<id>` reference). */
  uri: string;
  title: string;
  description: string;
  /** The checklist item it is about (a spec criterion section, or a standard rule). */
  ref: string;
  /** Rules: the spec sections following the rule. */
  sections?: string[];
  codeRefs: string[];
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
    outdated: number;
    blocked: number;
    /** Open must findings across the latest audits. */
    mustFindings: number;
    staleClaims: number;
    failedWorkOrders: number;
    integrityErrors: number;
    /** Warnings not snoozed. */
    integrityWarnings: number;
    integritySnoozed: number;
    /** Worst specs first (failing, outdated, blocked), capped. */
    specs: OverviewSpec[];
  };
  /** Open work orders that are claimed or in progress (fresh heartbeat first), capped. */
  inProgress: OverviewWorkOrder[];
  inProgressTotal: number;
  /** Specs of the work in progress (all of them, not capped): maturity and section progress. */
  progressSpecs?: { id: string; title: string; maturity: SpecMaturity }[];
  /** Claim sessions (current and ended) overlapping the last 24 hours, oldest first. */
  sessions?: OverviewSession[];
  /** Work orders completed in the last 7 days, newest first (capped). */
  recentlyCompleted?: OverviewCompleted[];
  /** Open work orders waiting for an agent (pending, unclaimed). */
  queued: number;
  blocked: OverviewBlocked[];
  blockedTotal: number;
  /** Specs whose latest audit has open must findings (capped). */
  mustFindingSpecs: {
    id: string;
    title: string;
    audit: string;
    openMust: number;
    /** The latest audit (title, auditor, completion time) and its open must findings. */
    auditTitle?: string;
    auditor?: { agent: string; user?: string };
    auditAt?: string;
    findings?: OverviewMustFinding[];
  }[];
  /** Health: maturity steps per category (non-archived specs). */
  byCategory: { category: string; total: number; steps: Record<MaturityStep, number>; specs: { id: string; title: string; step: MaturityStep }[] }[];
  /** Health: specified specs never audited, and specs with unverified / stale must criteria (capped). */
  neverAudited: { id: string; title: string }[];
  unverified: { id: string; title: string; unverified: number; stale: number; total: number }[];
  /** Health: verification gaps per specified spec, worst first (failing, stale, unverified must criteria; never / stale audit). Not capped. */
  gaps: { id: string; title: string; criteria: { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number }; audit: { at: string; stale: boolean } | null }[];
  /** Health: integrity warnings (not snoozed) grouped by rule, largest first; items capped at 50 per rule. */
  warningGroups: { rule: string; count: number; items: { uri: string; message: string }[] }[];
  /** Integrity warnings not snoozed (capped), to fix or acknowledge. */
  warnings: { rule: string; uri: string; message: string; hint?: string }[];
  coverage: {
    /** Gating (must, in force) criteria of non-archived specs. */
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
  'waiver_pending',
  'standard_proposal',
  'agent_stopped',
  'stale_claim',
  'audit_contradicted',
  'spec_drifted',
  'section_outdated',
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
  /** Feedback (kinds `feedback_open` / `feedback_accepted`): its kind (bug, improvement, question, ...). */
  feedbackKind?: string;
  /** Who filed it (feedback: the coding agent or person that created it). */
  by?: string;
  /** Why `suggested` is suggested (one line), when derivable. */
  suggestedWhy?: string;
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
