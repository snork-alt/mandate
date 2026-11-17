/**
 * Audits: an independent, repeatable check, done by a coding agent and tracked by Mandate (Mandate never reads the
 * code), that the code today conforms to a spec (its acceptance criteria plus every applicable rule) or to a
 * standard (its rules across the code they apply to).
 *
 * An audit is a written REPORT stored as a markdown document `audits/<id>.md` (same doc format as specs): frontmatter
 * (target, commit, code, auditor, status, times, summary counts) plus an `overview` section (the narrative: scope, what
 * was inspected, assessment, risks, recommendations) and one `audit-item` section per checklist item (meta: ref, kind,
 * level, result, hash, findings[]; body: how the code was checked and why it passes or fails). Git history is the
 * audit trail. Ids: `<yyyy-mm-dd>-<target id>` (`-2`, `-3`, ... on collision). Findings: `mandate://audits/<id>/findings/<fid>`.
 */
import { z } from 'zod';
import { sectionSchema } from '@mandate/doc';
import { idSchema } from './base.js';
import { parseNodeUri, parseRef } from './refs.js';

/** requested = asked from the web UI (or after a work order), queued for the assigned agent; it becomes in_progress when the agent starts. */
export const AUDIT_STATUSES = ['requested', 'in_progress', 'completed', 'abandoned'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const AUDIT_ITEM_RESULTS = ['pass', 'fail', 'partial', 'n_a'] as const;
export type AuditItemResult = (typeof AUDIT_ITEM_RESULTS)[number];
export const AUDIT_LEVELS = ['must', 'should', 'may'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];
export const FINDING_SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_CLASSIFICATIONS = ['code_deviates', 'spec_wrong', 'ambiguous'] as const;
export type FindingClassification = (typeof FINDING_CLASSIFICATIONS)[number];
export const FINDING_STATUSES = ['open', 'resolved', 'wont_fix'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const RECHECK_RESULTS = ['pass', 'fail', 'wont_fix'] as const;

/** Default severity of a finding per level of its item. */
export const DEFAULT_SEVERITY: Record<AuditLevel, FindingSeverity> = { must: 'major', should: 'minor', may: 'info' };
/** Highest severity allowed per level: `may` findings never exceed info, `should` never exceeds major. */
export const MAX_SEVERITY: Record<AuditLevel, FindingSeverity> = { must: 'critical', should: 'major', may: 'info' };
const rank = (s: FindingSeverity) => FINDING_SEVERITIES.length - FINDING_SEVERITIES.indexOf(s);
/** The severity of a finding: the requested one capped by its level, else the level's default. */
export function findingSeverity(level: AuditLevel, requested?: FindingSeverity): FindingSeverity {
  const cap = MAX_SEVERITY[level];
  const want = requested ?? DEFAULT_SEVERITY[level];
  return rank(want) > rank(cap) ? cap : want;
}

/** Audit ids are document ids (`2026-11-12-login-sso`); finding ids are `f1`, `f2`, ... within an audit. */
export const auditIdSchema = idSchema;
export const findingIdSchema = z.string().regex(/^f\d+$/, 'finding ids look like f1, f2, ...');
const fullSha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character sha');
const text = (max: number) => z.string().max(max);
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'single line');

/** A code location as `repo:path#Lx-Ly` (lines optional), e.g. `app:src/auth/session.ts#L10-L40`. */
export const CODE_REF_RE = /^([A-Za-z0-9_.-]+):([^#\s:][^#\s]*)(?:#L(\d+)(?:-L?(\d+))?)?$/;
export const auditCodeRefSchema = z
  .string()
  .max(600)
  .refine((v) => {
    const m = CODE_REF_RE.exec(v);
    if (!m) return false;
    if (m[2]!.split('/').some((p) => p === '..' || p === '.')) return false;
    return !m[3] || !m[4] || Number(m[4]) >= Number(m[3]);
  }, 'code refs look like repo:path#Lx-Ly (e.g. app:src/auth/session.ts#L10-L40)');
/** `repo:path#Lx-Ly` -> its parts. */
export function parseAuditCodeRef(v: string): { repo: string; path: string; lines?: { start: number; end: number } } | null {
  const m = CODE_REF_RE.exec(v);
  if (!m) return null;
  const start = m[3] ? Number(m[3]) : undefined;
  return { repo: m[1]!, path: m[2]!.replace(/^\/+/, ''), ...(start ? { lines: { start, end: m[4] ? Number(m[4]) : start } } : {}) };
}

/** The code that was audited (the agent's checkout). */
export const auditCodeSchema = z.object({ repo: line(200), commit: z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit sha'), branch: line(200).optional() }).strict();
export type AuditCode = z.infer<typeof auditCodeSchema>;

/** A finding as an agent reports it (severity defaults from the item's level and is capped by it). */
export const findingInputSchema = z
  .object({
    title: line(300),
    /** What is wrong and why (markdown): the descriptive explanation. */
    description: text(10_000).trim().min(1),
    /** How to fix it (markdown). */
    suggestedFix: text(10_000).optional(),
    /** Quoted code or command output (markdown). */
    evidence: text(20_000).optional(),
    codeRefs: z.array(auditCodeRefSchema).max(30).default([]),
    classification: z.enum(FINDING_CLASSIFICATIONS),
    severity: z.enum(FINDING_SEVERITIES).optional(),
  })
  .strict();
export type FindingInput = z.input<typeof findingInputSchema>;
export interface StoredFinding {
  id: string;
  title: string;
  severity: FindingSeverity;
  classification: FindingClassification;
  description: string;
  suggestedFix?: string;
  evidence?: string;
  codeRefs: string[];
}

/** A criterion / rule section of the checklist (`mandate://specs|standards/<id>/sections/<sid>`). */
const targetUriSchema = z.string().refine((u) => /^mandate:\/\/(specs|standards)\/[^/@#]+$/.test(u), 'a spec or standard URI');

/** Audit frontmatter (server-maintained; agents write through the audit_* tools). */
export const auditFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  /** One line: what was audited and the outcome. */
  summary: z.string().optional(),
  /** The spec or standard audited (`mandate://specs/<id>` / `mandate://standards/<id>`). */
  target: targetUriSchema,
  /** Mandate commit the checklist was taken at (full sha). */
  commit: fullSha,
  /** The code that was audited. */
  code: z.object({ repo: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{7,40}$/), branch: z.string().min(1).optional() }).optional(),
  auditor: z.object({ agent: z.string().min(1), user: z.string().min(1).optional() }),
  status: z.enum(AUDIT_STATUSES),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  abandonedAt: z.string().min(1).optional(),
  abandonReason: z.string().optional(),
  /** Requested audits: the agent client id it is assigned to (exclusive: only it may start it), who asked, when, why. */
  assignee: z.string().min(1).optional(),
  requestedBy: z.string().min(1).optional(),
  requestedAt: z.string().min(1).optional(),
  /** `work-order:<id>` when queued by the auditAfterWorkOrder setting. */
  trigger: z.string().min(1).optional(),
  /** Counts (server-computed on every write): items per level and result, findings per status. */
  counts: z
    .object({
      must: z.record(z.string(), z.number().int()),
      should: z.record(z.string(), z.number().int()),
      may: z.record(z.string(), z.number().int()),
      findings: z.record(z.string(), z.number().int()),
    })
    .optional(),
});
export type AuditFrontmatter = z.infer<typeof auditFrontmatterSchema>;
export const auditSchema = auditFrontmatterSchema.extend({ id: idSchema, sections: z.array(sectionSchema) });
export type StoredAudit = z.infer<typeof auditSchema>;
/** Next free finding id of an audit: f1, f2, ... (never reused). */
export function nextFindingId(used: Iterable<string>): string {
  let max = 0;
  for (const id of used) {
    const m = /^f(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `f${max + 1}`;
}

/* ---------------------------------------------------------------- derived state */

export interface FindingResolution {
  status: FindingStatus;
  /** The fix work order created from this finding (`audit_findings_to_work_orders`). */
  workOrder?: string;
  workOrderStatus?: string;
  /** Feedback filed from this finding (`feedback_create` with `fromFinding`). */
  feedback?: string;
  feedbackStatus?: string;
  /** Code commit of the passing re-check. */
  commit?: string;
  at?: string;
  by?: string;
  notes?: string;
}

export interface AuditFinding extends StoredFinding {
  uri: string;
  audit: string;
  /** The checklist item (criterion / rule section). */
  ref: string;
  /** The audit-item section holding the finding. */
  section: string;
  itemTitle: string;
  kind: 'criterion' | 'rule';
  level: AuditLevel;
  status: FindingStatus;
  resolution: FindingResolution;
  rechecks: { at: string; by: string; result: (typeof RECHECK_RESULTS)[number]; notes?: string; commit?: string }[];
  /** `audit_findings`: the audit's target. */
  target?: string;
}

export interface AuditItem {
  /** The audit-item section id. */
  sectionId: string;
  /** `mandate://audits/<id>/sections/<sid>`. */
  uri: string;
  ref: string;
  kind: 'criterion' | 'rule';
  level: AuditLevel;
  title: string;
  /** Unset until recorded (stored as `pending`). */
  result?: AuditItemResult;
  /** The item body: how it was checked and why it passes or fails (markdown). */
  notes?: string;
  findings: AuditFinding[];
  /** Spec audits, rules: the spec sections following the rule ([] = spec-wide). */
  sections?: string[];
}

export type LevelCounts = Record<AuditItemResult | 'pending', number>;

/** Outcome tone: pass (nothing open), warn (open should findings / failing should items), fail (must). */
export type AuditOutcome = 'pass' | 'warn' | 'fail' | 'in_progress' | 'abandoned';

export interface AuditStaleness {
  stale: boolean;
  reasons: string[];
  /** Mandate commits since the audit's commit that touched the target or its standards. */
  commitsSince: number;
}

export interface Audit {
  id: string;
  uri: string;
  target: string;
  targetKind: 'spec' | 'standard';
  targetTitle?: string;
  /** Mandate repo commit the checklist was taken at (full sha). */
  commit: string;
  /** The code that was audited. */
  code?: AuditCode;
  auditor: { agent: string; user?: string };
  startedAt: string;
  completedAt?: string;
  abandonedAt?: string;
  status: AuditStatus;
  summary?: string;
  reason?: string;
  /** Requested audits: the agent client id it is assigned to, the user who asked. */
  assignee?: string;
  requestedBy?: string;
  requestedAt?: string;
  trigger?: string;
  /** Live progress: checklist items recorded / total and (spec audits) sections checked / total. */
  progress: AuditProgress;
  items: AuditItem[];
  counts: Record<AuditLevel, LevelCounts>;
  findings: Record<FindingStatus, number> & { total: number; openMust: number; openShould: number; openMay: number };
  outcome: AuditOutcome;
  staleness?: AuditStaleness;
}

/** Items recorded / total and the sections of the scope whose items are all recorded. */
export interface AuditProgress {
  items: { done: number; total: number };
  sections: { done: number; total: number };
}

/** Compact audit summary (lists, spec rows, `lastAudit`). */
export interface AuditSummary {
  id: string;
  uri: string;
  target: string;
  targetKind: 'spec' | 'standard';
  targetTitle?: string;
  status: AuditStatus;
  /** completedAt, else startedAt. */
  at: string;
  startedAt: string;
  completedAt?: string;
  auditor: { agent: string; user?: string };
  commit: string;
  code?: AuditCode;
  summary?: string;
  outcome: AuditOutcome;
  counts: Record<AuditLevel, LevelCounts>;
  findings: Audit['findings'];
  assignee?: string;
  progress: AuditProgress;
  stale: boolean;
  staleReasons: string[];
  commitsSince: number;
}

/** `lastAudit` on spec_list / doc_list rows: when it was last audited (completed audits only) and how it went. */
export interface LastAudit {
  id: string;
  uri: string;
  at: string;
  auditor: { agent: string; user?: string };
  result: AuditOutcome;
  openFindings: number;
  openMust: number;
  openShould: number;
  stale: boolean;
  commitsSince: number;
}

/** One checklist item of `audit_plan`. */
export interface AuditPlanItem {
  ref: string;
  kind: 'criterion' | 'rule';
  level: AuditLevel;
  title: string;
  body?: string;
  /** The standard a rule comes from. */
  standard?: string;
  method?: string;
  check?: { kind: string; command?: string; ruleId?: string };
  rationale?: string;
  /** Spec audits, rules: the spec sections following the rule ([] = spec-wide) and how it applies. */
  sections?: string[];
  path?: string[];
  /** Current verification state (spec audits). */
  verification?: string;
  /** Rules not in force yet (never required). */
  upcoming?: boolean;
  /** Required to complete the audit (must and in force). */
  required: boolean;
}

export interface AuditPlan {
  target: string;
  targetKind: 'spec' | 'standard';
  title: string;
  /** Mandate HEAD the plan was computed at. */
  commit: string | null;
  items: AuditPlanItem[];
  /** Code to inspect. */
  code: {
    /** The spec's section code refs (spec audits) or those of specs using the standard. */
    refs: { repo: string; path: string; lines?: string; uri: string; section?: string; spec?: string }[];
    /** `owns` globs of the components the spec affects (or the standard applies to). */
    components: { id: string; title: string; repo: string; paths: string[]; via: string[] }[];
    /** Path globs / languages a standard's appliesTo and rule scopes cover. */
    globs: { repo?: string; glob: string; source: string }[];
    languages: string[];
  };
  /** Standard audits: the specs using the standard. */
  specs?: { id: string; title: string; status: string }[];
  priorOpenFindings: AuditFinding[];
  lastAudit: AuditSummary | null;
  /** An audit of this target still in progress (continue it instead of starting another). */
  inProgress: AuditSummary | null;
}

/* ---------------------------------------------------------------- tool inputs */

/** An audit id or reference (`mandate://audits/<id>`, prefixed mentions accepted; @sha ignored). */
export const auditRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((v) => {
    const r = parseRef(v);
    return r?.kind === 'audits' && !r.sectionId ? r.id : v;
  })
  .pipe(auditIdSchema);
/** A finding id (`f3`) or its `mandate://audits/<id>/findings/<fid>` reference. */
export const findingRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((v) => {
    const n = parseNodeUri(v);
    return n?.kind === 'findings' ? n.id : v;
  })
  .pipe(findingIdSchema);
/** Spec or standard to audit: id-free reference `mandate://specs/<id>` / `mandate://standards/<id>` (prefix, @sha ignored). */
export const auditTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((v) => {
    const r = parseRef(v);
    return !!r && (r.kind === 'specs' || r.kind === 'standards') && !r.sectionId && !r.lines;
  }, 'target must be a spec or standard reference: mandate://specs/<id> or mandate://standards/<id>');

export const auditPlanInputSchema = z.object({ target: auditTargetSchema }).strict();
export const auditStartInputSchema = z
  .object({
    target: auditTargetSchema,
    /** Mandate commit to take the checklist at (default HEAD; stored as a full sha). */
    commit: z.string().regex(/^[0-9a-f]{4,40}$/).optional(),
    /** The code you audit (repo, commit, branch): strongly recommended. */
    code: auditCodeSchema.optional(),
    /** The overview so far (scope, what you will inspect); completed by audit_complete. */
    overview: text(50_000).optional(),
    /** The audit this agent was asked to do (event audit_requested): starts THAT audit instead of creating one. */
    request: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
/** audit_request (web UI / agents): queue an audit for an agent. */
export const auditRequestInputSchema = z
  .object({
    target: auditTargetSchema,
    /** An agent handle (agents_presence). */
    assignee: z.string().trim().min(1).max(120),
    /** Why (shown to the agent), e.g. "Outdated: changed since implemented". */
    note: z.string().trim().max(1000).optional(),
    /** Section audits: what a clean result clears (outdated | upstream), for the agent's information. */
    trigger: z.string().trim().max(200).optional(),
  })
  .strict();
export const auditRecordItemInputSchema = z
  .object({
    auditId: auditRefSchema,
    /** A criterion / rule section of the plan. */
    ref: z.string().trim().min(1).max(400),
    result: z.enum(AUDIT_ITEM_RESULTS),
    notes: text(20_000).optional(),
    findings: z.array(findingInputSchema).max(50).optional(),
  })
  .strict();
export const auditCompleteInputSchema = z
  .object({
    auditId: auditRefSchema,
    /** One line: the outcome (frontmatter summary). */
    summary: line(500),
    /** The overview narrative (markdown): scope, what was inspected, the overall assessment, notable risks, recommendations. Required unless already written. */
    overview: text(50_000).optional(),
  })
  .strict();
export const auditAbandonInputSchema = z.object({ auditId: auditRefSchema, reason: text(5000).optional() }).strict();
export const auditFindingsToWorkOrdersInputSchema = z
  .object({
    auditId: auditRefSchema,
    /** Only these findings (default: every open code_deviates finding at must / should level). */
    findingIds: z.array(findingRefSchema).min(1).max(200).optional(),
    /** One fix work order per spec (the only grouping). */
    group: z.enum(['per_spec']).default('per_spec'),
    /** false: leave should-level findings out (may findings are never included). */
    includeShould: z.boolean().default(true),
  })
  .strict();
export const auditRecheckInputSchema = z
  .object({
    auditId: auditRefSchema,
    /** The finding to re-check (or `item`). */
    findingId: findingRefSchema.optional(),
    /** DF-9: an audit item to re-check as a whole (its criterion / rule URI, audit section URI or item id); result pass | fail | partial | n_a, notes required. */
    item: z.string().trim().min(1).max(400).optional(),
    /** Findings: pass resolves, fail stays open, wont_fix accepts (notes required). Items: pass | fail | partial | n_a. */
    result: z.enum([...RECHECK_RESULTS, 'partial', 'n_a']),
    notes: text(20_000).optional(),
    /** The code commit you re-checked. */
    commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  })
  .strict()
  .refine((v) => !!v.findingId !== !!v.item, { message: 'give findingId (a finding) or item (an audit item), not both', path: ['findingId'] })
  .refine((v) => !v.findingId || v.result === 'pass' || v.result === 'fail' || v.result === 'wont_fix', { message: 'finding re-checks are pass, fail or wont_fix', path: ['result'] })
  .refine((v) => !v.item || v.result !== 'wont_fix', { message: 'item re-checks are pass, fail, partial or n_a', path: ['result'] })
  .refine((v) => (v.result !== 'wont_fix' && !v.item) || !!v.notes?.trim(), { message: 'notes are required (wont_fix: why it is accepted; item re-checks: how it was checked)', path: ['notes'] });
/** Relink a finding to a replacement fix work order (after the linked one was cancelled or failed); frozen audits too. */
export const auditFindingRelinkInputSchema = z
  .object({
    auditId: auditRefSchema,
    findingId: findingRefSchema,
    /** The replacement work order (id or mandate://work-orders/<id>). */
    workOrder: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .transform((v) => {
        const r = parseRef(v);
        return r?.kind === 'work-orders' && !r.sectionId ? r.id : v;
      })
      .pipe(idSchema),
  })
  .strict();
export type AuditFindingRelinkInput = z.input<typeof auditFindingRelinkInputSchema>;
export const auditGetInputSchema = z.object({ auditId: auditRefSchema }).strict();
export const auditListInputSchema = z
  .object({
    target: auditTargetSchema.optional(),
    status: z.array(z.enum(AUDIT_STATUSES)).min(1).max(3).optional(),
    stale: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export const auditFindingsInputSchema = z
  .object({
    target: auditTargetSchema.optional(),
    status: z.array(z.enum(FINDING_STATUSES)).min(1).max(3).optional(),
    classification: z.array(z.enum(FINDING_CLASSIFICATIONS)).min(1).max(3).optional(),
    severity: z.array(z.enum(FINDING_SEVERITIES)).min(1).max(4).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type AuditPlanInput = z.input<typeof auditPlanInputSchema>;
export type AuditStartInput = z.input<typeof auditStartInputSchema>;
export type AuditRecordItemInput = z.input<typeof auditRecordItemInputSchema>;
export type AuditCompleteInput = z.input<typeof auditCompleteInputSchema>;
export type AuditAbandonInput = z.input<typeof auditAbandonInputSchema>;
export type AuditFindingsToWorkOrdersInput = z.input<typeof auditFindingsToWorkOrdersInputSchema>;
export type AuditRecheckInput = z.input<typeof auditRecheckInputSchema>;
export type AuditListInput = z.input<typeof auditListInputSchema>;
export type AuditFindingsInput = z.input<typeof auditFindingsInputSchema>;

/** A finding reference as stored on work orders / feedback. */
export const findingUriSchema = z.string().refine((v) => {
  const n = parseNodeUri(v);
  return n?.kind === 'findings';
}, 'a finding reference: mandate://audits/<id>/findings/<fid>');

export const auditOverviewInputSchema = z.object({}).strict();

/* ---------------------------------------------------------------- read payloads (UI + agents) */

/** `doc_get` (specs) `audits`: latest audit, history (newest first) and every finding of the spec's audits. */
export interface SpecAudits {
  latest: AuditSummary | null;
  history: AuditSummary[];
  findings: AuditFinding[];
}

/** `doc_get` (standards) `audits.compliance`: latest result per rule, per spec audited against it (or a whole-standard audit). */
export interface StandardCompliance {
  rules: { ref: string; title: string; level: AuditLevel }[];
  rows: {
    /** The spec (spec audits) or the standard itself (standard audits). */
    subject: string;
    kind: 'spec' | 'standard';
    title: string;
    audit: AuditSummary;
    /** Rule ref -> latest recorded result in that audit. */
    results: Record<string, AuditItemResult>;
    /** Rule ref -> open findings in that audit. */
    openFindings: Record<string, number>;
  }[];
}
export interface StandardAudits {
  latest: AuditSummary | null;
  history: AuditSummary[];
  /** Every finding of the audits that targeted this standard. */
  findings: AuditFinding[];
  compliance: StandardCompliance;
}

/** `audit_overview`: per spec its last audit; per component the worst open finding of the specs affecting it. */
export interface ComponentAuditStatus {
  status: 'fail' | 'warn' | 'pass' | 'stale' | 'none';
  openMust: number;
  openShould: number;
  /** Specs affecting / owning code of the component that were audited. */
  specs: string[];
}
export interface AuditOverview {
  specs: Record<string, LastAudit | null>;
  components: Record<string, ComponentAuditStatus>;
}
