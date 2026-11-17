/**
 * Strict input schemas of the MCP write tools (one per tool; `agent`, `branch` and `idempotencyKey` are added by
 * the MCP layer). Domain rules (transitions, links, gate, claims) are checked by the storage services.
 */
import { LINK_RELS, sectionMetaSchema, slugSchema } from '@mandate/doc';
import { z } from 'zod';
import { TLDR_MAX_CHARS, appliesToSchema, exemptionSchema, FEEDBACK_KINDS, FEEDBACK_RESOLUTIONS, PRIORITIES, STORED_SPEC_STATUSES, VERIFICATION_METHODS, VERIFICATION_RESULTS, WORK_ORDER_KINDS, STANDARD_STATUSES } from './base.js';
import { docRefSchema, sectionRefSchema } from './read-schemas.js';
import { parseNodeUri, parseRef, type RefKind } from './refs.js';
import { planStepInputSchema } from './plan-steps.js';
import { planTestSchema, woDeliveryExtras } from './work-orders.js';
import { auditCodeRefSchema } from './audits.js';
import { codeClaimSchema } from './code-context.js';

const text = (max: number) => z.string().max(max);
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'single line');
/** Plain-language TL;DR: markdown, may span lines. */
const tldrField = z.string().trim().min(1).max(TLDR_MAX_CHARS);
const docKinds = ['specs', 'standards', 'components'] as const;
/** The change summary of an edit: 1-2 plain sentences, no code; stored with the edit (commit trailer `Change-Summary`). */
const changeSummaryField = z.string().trim().min(3).max(400).regex(/^[^\r\n]*$/, 'single line, 1-2 plain sentences').optional();

export type WritableDocKind = (typeof docKinds)[number];

/** A section reference to write to: no `#L` lines; `@sha` (optional) must be the section's current version. */
const writeSectionRef = (kind: RefKind) =>
  sectionRefSchema([kind]).refine((v) => !parseRef(v)?.lines, 'line ranges (#L..) select text to read, not a section to write; drop them');
/** A document to write to: id or reference (no section, no lines). */
const writeDocRef = (kind: RefKind) => docRefSchema([kind], { sections: false }).refine((v) => !parseRef(v)?.lines, 'drop the line range');

/** Section content an agent writes (server-managed fields excluded: archived, implementedCommit, links -> link tools). */
const sectionFields = {
  title: sectionMetaSchema.shape.title,
  type: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(60).optional(),
  summary: line(400).optional(),
  body: text(200_000).optional(),
  refs: sectionMetaSchema.shape.refs.unwrap().max(200).optional(),
  symbols: z.array(z.string().min(1).max(200)).max(200).optional(),
  verifiedBy: z.array(slugSchema).max(200).optional(),
  method: z.string().min(1).max(40).optional(),
  threshold: sectionMetaSchema.shape.threshold,
  /** Rule sections (standards): level must | should | may, rationale, scope, check, examples. */
  level: sectionMetaSchema.shape.level,
  rationale: z.string().trim().min(1).max(5000).optional(),
  scope: sectionMetaSchema.shape.scope,
  check: sectionMetaSchema.shape.check,
  examples: z.array(z.string().min(1).max(400)).max(50).optional(),
  /** inferred (reverse-engineered, e.g. by /mandate-bootstrap) | confirmed (by a person), with a confidence 0..1. */
  provenance: sectionMetaSchema.shape.provenance,
  confidence: sectionMetaSchema.shape.confidence,
};
/** A new section (Mandate assigns its id from the title; `verifiedBy` in a create may name a sibling by its title's slug). */
export const sectionCreateSchema = z.object({ ...sectionFields }).strict();
export type SectionCreate = z.input<typeof sectionCreateSchema>;
/** Per document kind: rule fields only on standards, acceptance fields (method, threshold) only on specs; components neither. */
const RULE_ONLY = { level: true, rationale: true, scope: true, check: true, examples: true } as const;
const ACCEPTANCE_ONLY = { method: true, threshold: true } as const;
export const specSectionCreateSchema = sectionCreateSchema.omit(RULE_ONLY);
export const standardSectionCreateSchema = sectionCreateSchema.omit(ACCEPTANCE_ONLY);
export const componentSectionCreateSchema = sectionCreateSchema.omit({ ...RULE_ONLY, ...ACCEPTANCE_ONLY });
const sectionCreateFor = (kind: WritableDocKind) => (kind === 'specs' ? specSectionCreateSchema : kind === 'standards' ? standardSectionCreateSchema : componentSectionCreateSchema);
/** Link rels each document kind's sections may use (the server's direction rules, as an enum). */
export const LINK_RELS_BY_KIND = {
  specs: LINK_RELS,
  standards: ['extends', 'relates_to', 'conflicts_with', 'supersedes'],
  components: ['depends_on', 'follows', 'deviates_from'],
} as const satisfies Record<WritableDocKind, readonly (typeof LINK_RELS)[number][]>;

const placement = {
  /** Insert / move after this section id. */
  after: slugSchema.optional(),
  /** Insert / move before this section id. */
  before: slugSchema.optional(),
  position: z.enum(['first', 'last']).optional(),
};
const atMostOnePlacement = (v: { after?: string; before?: string; position?: string }) => [v.after, v.before, v.position].filter(Boolean).length <= 1;

/* ------------------------------------------------------------------ specs and standards */

const specMeta = {
  title: line(300).optional(),
  summary: line(1000).nullable().optional(),
  /** Human-readable overview (2-5 short sentences or bullets, markdown, no jargon, no ids); refresh when the doc changes. */
  tldr: tldrField.nullable().optional(),
  category: line(80).nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  tags: z.array(line(80)).max(50).optional(),
  owner: line(200).nullable().optional(),
  repo: line(200).nullable().optional(),
  exemptFrom: z.array(exemptionSchema.omit({ by: true }).strict()).max(50).optional(),
};
const standardMeta = {
  title: line(300).optional(),
  /** In force from this ISO date or commit sha (before that its rules are announced, not required). */
  effectiveFrom: z.string().trim().min(4).max(40).nullable().optional(),
  summary: line(1000).nullable().optional(),
  /** Human-readable overview (2-5 short sentences or bullets, markdown, no jargon, no ids); refresh when the doc changes. */
  tldr: tldrField.nullable().optional(),
  tags: z.array(line(80)).max(50).optional(),
  owner: line(200).nullable().optional(),
  appliesTo: z.array(appliesToSchema).max(50).optional(),
};

export const specCreateInputSchema = z
  .object({ ...specMeta, title: line(300), sections: z.array(specSectionCreateSchema).max(200).default([]) })
  .strict();
export const standardCreateInputSchema = z
  .object({ ...standardMeta, title: line(300), status: z.enum(['draft', 'active']).optional(), sections: z.array(standardSectionCreateSchema).max(200).default([]) })
  .strict();
export const specUpdateMetaInputSchema = z
  .object({ ref: writeDocRef('specs'), ...specMeta })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'ref'), 'nothing to change: pass at least one field');
export const standardUpdateMetaInputSchema = z
  .object({ ref: writeDocRef('standards'), ...standardMeta })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'ref'), 'nothing to change: pass at least one field');
/** Standard lifecycle: draft -> active, active -> deprecated (supersededBy required), ... (see STANDARD_TRANSITIONS). */
export const standardStatusSetInputSchema = z
  .object({ ref: writeDocRef('standards'), status: z.enum(['active', 'deprecated']), supersededBy: docRefSchema(['standards'], { sections: false }).optional() })
  .strict();
export const specArchiveInputSchema = z.object({ ref: writeDocRef('specs'), reason: line(500).optional() }).strict();
export const specStatusSetInputSchema = z.object({ ref: writeDocRef('specs'), status: z.enum(STORED_SPEC_STATUSES) }).strict();

const sectionTools = (kind: WritableDocKind) => ({
  insert: z
    .object({ doc: writeDocRef(kind), section: sectionCreateFor(kind), ...placement })
    .strict()
    .refine(atMostOnePlacement, 'give at most one of after, before, position'),
  update: z
    .object({
      ref: writeSectionRef(kind),
      title: sectionFields.title.optional(),
      type: sectionFields.type,
      summary: line(400).nullable().optional(),
      body: sectionFields.body,
      refs: sectionFields.refs,
      symbols: sectionFields.symbols,
      verifiedBy: sectionFields.verifiedBy,
      method: z.string().min(1).max(40).nullable().optional(),
      threshold: sectionMetaSchema.shape.threshold.unwrap().nullable().optional(),
      level: sectionMetaSchema.shape.level.unwrap().nullable().optional(),
      rationale: z.string().trim().min(1).max(5000).nullable().optional(),
      scope: sectionMetaSchema.shape.scope.unwrap().nullable().optional(),
      check: sectionMetaSchema.shape.check.unwrap().nullable().optional(),
      examples: z.array(z.string().min(1).max(400)).max(50).nullable().optional(),
      provenance: sectionMetaSchema.shape.provenance.unwrap().nullable().optional(),
      confidence: sectionMetaSchema.shape.confidence.unwrap().nullable().optional(),
      /** Wording only, no behaviour change: an implemented section stays implemented (not Outdated). Only title / summary / body may change. */
      /** 1-2 plain sentences (no code) saying what changed and why; required when the section is implemented or others depend on it. */
      changeSummary: changeSummaryField,
      editorial: z.object({ reason: z.string().trim().min(3).max(500) }).strict().optional(),
    })
    .omit(kind === 'specs' ? RULE_ONLY : kind === 'standards' ? ACCEPTANCE_ONLY : { ...RULE_ONLY, ...ACCEPTANCE_ONLY })
    .strict()
    .refine((v) => Object.keys(v).some((k) => k !== 'ref'), 'nothing to change: pass at least one field'),
  move: z
    .object({ ref: writeSectionRef(kind), ...placement })
    .strict()
    .refine((v) => [v.after, v.before, v.position].filter(Boolean).length === 1, 'give exactly one of after, before, position'),
  archive: z.object({ ref: writeSectionRef(kind), reason: line(500).optional(), changeSummary: changeSummaryField }).strict(),
  linkAdd: z
    .object({
      ref: writeSectionRef(kind),
      /** Target: a section reference (or a whole standard for follows / deviates_from / relates_to); copied forms accepted. */
      to: z.string().trim().min(1).max(400).refine((v) => !!parseRef(v), 'expected a mandate:// section reference'),
      rel: z.enum(LINK_RELS_BY_KIND[kind]),
      note: line(2000).optional(),
    })
    .strict(),
  linkRemove: z
    .object({
      ref: writeSectionRef(kind),
      to: z.string().trim().min(1).max(400).refine((v) => !!parseRef(v), 'expected a mandate:// reference'),
      rel: z.enum(LINK_RELS_BY_KIND[kind]).optional(),
    })
    .strict(),
});
export const specSectionInputSchemas = sectionTools('specs');
export const standardSectionInputSchemas = sectionTools('standards');
export const componentSectionInputSchemas = sectionTools('components');
/** A component to write to (id or reference). */
export const componentDocRefSchema = writeDocRef('components');

/* ------------------------------------------------------------------ work orders */

const woRef = docRefSchema(['work-orders']);
const fbRef = docRefSchema(['feedback']);
/** relatedTo entries (DF-7): a request id / reference or any element reference (resolved by the server). */
const relatedRef = z.string().trim().min(1).max(400).refine((v) => /^[a-z0-9][a-z0-9-]*$/.test(v) || !!parseNodeUri(v), 'a request id or an element reference (mandate://...)');
/** The structured plan of a work order (rendered to the plan section; `tests` are checked at work_order_complete). */
export const workOrderPlanInputSchema = z
  .object({
    /** The tasks, in order: a line, or { text, sections: [targeted spec section ids it implements], proves: [criterion ids it proves] }. Every targeted section needs a task covering it and every criterion a task proving it. Each gets a stable id (t1, t2, ...). */
    tasks: z.array(planStepInputSchema).min(1).max(50).optional(),
    /** Old name of tasks. */
    steps: z.array(planStepInputSchema).min(1).max(50).optional(),
    /** Files to change or add (`path`, or `repo:path` / `path: why`). */
    files: z.array(line(500)).max(200).default([]),
    /** Tests to write: name, where (optional), and the acceptance criteria (section ids of the spec) each proves. */
    tests: z.array(planTestSchema).max(200).default([]),
    /** What could go wrong. */
    risks: z.array(line(2000)).max(30).default([]),
  })
  .strict()
  .refine((v) => !!(v.tasks ?? v.steps)?.length, 'give tasks');
export type WorkOrderPlanInput = z.input<typeof workOrderPlanInputSchema>;
/** The tasks of a plan input (`tasks`, or the old name `steps`). */
export const planTasksOf = (p: Pick<WorkOrderPlanInput, 'tasks' | 'steps'>) => (p.tasks ?? p.steps ?? []);

export const workOrderCreateInputSchema = z
  .object({
    spec: writeDocRef('specs'),
    /** Section ids (or section references of that spec). */
    sections: z.array(z.string().trim().min(1).max(400)).min(1).max(200),
    kind: z.enum(WORK_ORDER_KINDS),
    priority: z.enum(PRIORITIES).optional(),
    note: text(5000).optional(),
    /** Requests this work order acts on (ids or references). */
    reason: z.array(fbRef).max(50).optional(),
    /** Pin another version of the spec (default: its current version). */
    specCommit: z.string().regex(/^[0-9a-f]{4,40}$/).optional(),
    /** Title (default: derived from kind, spec and sections). */
    title: line(300).optional(),
    /**
     * The FULL plan, required for implement / update / fix (fastPath fix excepted): steps, files to change, tests (each mapped
     * to the acceptance criteria it proves) and risks. A markdown string is accepted for review / verify work orders.
     */
    plan: z.union([workOrderPlanInputSchema, text(100_000)]).optional(),
    /** Fast-path fix: kind fix with exactly one section; can be claimed without a plan. */
    fastPath: z.boolean().optional(),
    /** Work orders that must be done first (ids or references). */
    dependencies: z.array(woRef).max(50).optional(),
  })
  .strict();
/** Re-verify an implemented (Outdated) spec section: evidence that the code / tests match its current text. */
export const sectionReverifyInputSchema = z
  .object({
    ref: writeSectionRef('specs'),
    codeRefs: z.array(woDeliveryExtras.touched.unwrap().element).max(100).optional(),
    verifications: z.array(z.string().trim().min(1).max(400)).max(50).optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => !!v.codeRefs?.length || !!v.verifications?.length, 'give the evidence: codeRefs and / or verifications');
export const workOrderRefInputSchema = z.object({ ref: woRef }).strict();
export const workOrderClaimInputSchema = z.object({ ref: woRef, worktree: line(500).optional(), git: woDeliveryExtras.git }).strict();
export const workOrderHeartbeatInputSchema = z.object({ ref: woRef, git: woDeliveryExtras.git }).strict();
export const workOrderSectionDoneInputSchema = z
  .object({
    ref: woRef,
    sections: z.array(z.string().trim().min(1).max(400)).min(1).max(200),
    status: z.enum(['done', 'obsolete']).default('done'),
    /** Implementation notes (markdown), appended to each section's notes. */
    notes: text(50_000).optional(),
    /** Code of these sections (`repo:path#Lx-Ly` or objects): merged into the sections' codeRefs and the work order's touched. */
    codeRefs: z.array(woDeliveryExtras.touched.unwrap().element).max(500).optional(),
    /** Deviations from the spec section (markdown, one per item). */
    deviations: z.array(text(5000).min(1)).max(50).optional(),
    /** Verification results / criteria proving the sections (references). */
    verifications: z.array(z.string().trim().min(1).max(400)).max(50).optional(),
    git: woDeliveryExtras.git,
    touched: woDeliveryExtras.touched,
    /** Repo + commit (or dirty base) of codeRefs / touched entries without their own commits. */
    code: codeClaimSchema.optional(),
  })
  .strict();
export const workOrderCompleteInputSchema = z
  .object({
    ref: woRef,
    /** Summary of what was delivered (required unless the outcome section is already written). */
    outcome: text(50_000).optional(),
    /** Which spec sections, components and code refs were updated to match the code. */
    reconciliation: text(50_000).optional(),
    git: woDeliveryExtras.git,
    touched: woDeliveryExtras.touched,
  })
  .strict();
export const workOrderFailInputSchema = z.object({ ref: woRef, note: text(5000).min(1) }).strict();
export const workOrderCancelInputSchema = z.object({ ref: woRef, note: text(5000).optional() }).strict();
export const workOrderNextInputSchema = z
  .object({
    kinds: z.array(z.enum(WORK_ORDER_KINDS)).min(1).max(4).optional(),
    spec: writeDocRef('specs').optional(),
    priority: z.array(z.enum(PRIORITIES)).min(1).max(4).optional(),
    repo: line(200).optional(),
    category: line(80).optional(),
    tags: z.array(line(80)).min(1).max(20).optional(),
    worktree: line(500).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ requests (stored as feedback) */

const feedbackTarget = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((t) => !!parseRef(t)?.sectionId || ['verifications', 'findings'].includes(parseNodeUri(t)?.kind ?? ''), 'targets are section references (#L ranges allowed; audit items too), mandate://verifications/<id> or audit findings');
export const requestCreateInputSchema = z
  .object({
    /** Sections it concerns. Optional for improvement / bug at intake (before spec_match): link them later (request_update) or let the writes that address it link it. */
    targets: z.array(feedbackTarget).max(20).default([]),
    kind: z.enum(FEEDBACK_KINDS),
    body: text(20_000).min(1),
    quote: text(5000).optional(),
    relatedTo: z.array(relatedRef).max(20).optional(),
    /** `comment`: the request comes from a comment (relatedTo: the commented object and the comment, mandate://comments/<id>). */
    source: z.enum(['comment', 'ui', 'audit']).optional(),
    /** Who handles it: a client id / handle of an agent (presence), or `any` (the next free agent). Queued while it is offline. */
    assignee: line(200).optional(),
    /** Objects the request refers to (@-references: mandate:// refs, `repo:path` code refs); also extracted from the body. */
    context: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    /** Stop after the spec update and the work-order plan: the user reviews before any code is written. */
    planOnly: z.boolean().optional(),
    /** The audit finding this request comes from (spec_wrong / ambiguous): mandate://audits/<id>/findings/<fid>. */
    fromFinding: z
      .string()
      .trim()
      .max(300)
      .refine((v) => {
        const n = parseNodeUri(v);
        return n?.kind === 'findings';
      }, 'a finding reference: mandate://audits/<id>/findings/<fid>')
      .optional(),
  })
  .strict()
  .refine((v) => v.targets.length > 0 || v.kind === 'improvement' || v.kind === 'bug', { path: ['targets'], message: 'targets are required for this kind (only improvement / bug requests may be filed without a target at intake)' });
export const requestUpdateInputSchema = z
  .object({ ref: fbRef, body: text(20_000).min(1).optional(), targets: z.array(feedbackTarget).min(1).max(20).optional(), relatedTo: z.array(relatedRef).max(20).optional() })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'ref'), 'nothing to change: pass body, targets or relatedTo');
export const requestAssignInputSchema = z.object({ ref: fbRef, assignee: line(200) }).strict();
export const requestPlanApproveInputSchema = z.object({ ref: fbRef }).strict();
export const requestCloseInputSchema = z
  .object({ ref: fbRef, resolution: z.enum(FEEDBACK_RESOLUTIONS), resolutionNote: text(5000).optional(), duplicateOf: fbRef.optional() })
  .strict();

/* ------------------------------------------------------------------ verification and diffs */

export const verificationRecordInputSchema = z
  .object({
    /** Acceptance section (copied reference accepted). */
    criterion: sectionRefSchema(['specs', 'standards']),
    /** The spec the result is for (required for standard criteria). */
    appliedTo: writeDocRef('specs').optional(),
    /** Mandate commit verified against (default HEAD). */
    specCommit: z.string().regex(/^[0-9a-f]{4,40}$/).optional(),
    /** The code verified: repo (registered short name), commit; dirty: uncommitted changes on top of commit. */
    code: codeClaimSchema,
    result: z.enum(VERIFICATION_RESULTS),
    method: z.enum(VERIFICATION_METHODS),
    evidence: z.object({ test: line(1000).optional(), ci: line(2000).optional(), note: text(5000).optional() }).strict().optional(),
    /** Where in the code the criterion / rule was checked (`repo:path#Lx-Ly`): feeds "where standards are used". For a spec criterion: the test (file / lines). */
    codeRefs: z.array(auditCodeRefSchema).max(30).optional(),
    /** The work order that delivered the test (default: your open work order on the spec that covers this criterion). */
    workOrder: woRef.optional(),
  })
  .strict();

export const specDiffSinceImplementedInputSchema = z
  .object({
    /** Diff the sections of this work order between its pinned specCommit and HEAD. */
    workOrder: woRef.optional(),
    /** Or: these spec sections, each since its implementedCommit. */
    sections: z.array(sectionRefSchema(['specs'])).min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => (v.workOrder ? 1 : 0) + (v.sections ? 1 : 0) === 1, 'give exactly one of workOrder or sections');

export { docKinds as WRITABLE_DOC_KINDS };

/** Old (feedback) names of the request schemas. */
export const feedbackCreateInputSchema = requestCreateInputSchema;
export const feedbackUpdateInputSchema = requestUpdateInputSchema;
export const feedbackCloseInputSchema = requestCloseInputSchema;
