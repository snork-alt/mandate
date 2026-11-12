import { z } from 'zod';

/** Section type id; which ids are valid is decided by the SectionTypeRegistry, not by the schema. */
export type SectionType = string;

/** Lowercase slug used for section ids and references to other documents. */
export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug (a-z, 0-9, dashes)');

/** YAML reads unquoted `1234567` or `42` as numbers; accept them as strings. */
const looseString = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1));

/** Pointer into a code repository: `repo · path:lines @commit`. */
export const codeRefSchema = z.object({
  repo: looseString,
  path: z.string().min(1),
  lines: z
    .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().regex(/^\d+(?:-\d+)?$/, 'lines must be N or N-M'))
    .optional(),
  commit: looseString.optional(),
});
export type CodeRef = z.output<typeof codeRefSchema>;

export const LINK_RELS = ['depends_on', 'extends', 'relates_to', 'conflicts_with', 'supersedes', 'follows', 'deviates_from', 'affects'] as const;
export type LinkRel = (typeof LINK_RELS)[number];

/** Full 40-character git commit id (what every stored pin must be). */
export const fullShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit sha');

/**
 * A typed link from a section to a section of another document. The one exception: spec sections may
 * point `follows` / `deviates_from` / `relates_to` at a WHOLE standard (`mandate://standards/<id>`).
 */
export const sectionLinkSchema = z.object({
  to: z
    .string()
    .regex(
      /^mandate:\/\/[a-z]+\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/sections\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/,
      'link target must be a section URI (mandate://<kind>/<id>/sections/<sid>) or a whole standard (mandate://standards/<id>)',
    ),
  rel: z.enum(LINK_RELS),
  note: z.string().optional(),
  /** Waiver (`deviates_from`): the accepted feedback item that approves the deviation. */
  feedback: slugSchema.optional(),
  /** Waiver: content hash of the waived criteria when approved (server-set; the waiver lapses when they change). */
  pin: z.string().min(1).optional(),
  /** Who wrote the link (server-set from the commit's agent / author; used for the waiver approval rule). */
  by: z.string().min(1).optional(),
  /** "Upstream changed" acknowledged at this commit of the target (full sha). */
  seenAt: z.string().min(4).optional(),
});
export type SectionLink = z.output<typeof sectionLinkSchema>;

/* ---------- audit-item sections (audit documents) ---------- */

export const AUDIT_ITEM_RESULTS = ['pending', 'pass', 'fail', 'partial', 'n_a'] as const;
export const AUDIT_FINDING_SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export const AUDIT_FINDING_CLASSIFICATIONS = ['code_deviates', 'spec_wrong', 'ambiguous'] as const;
export const AUDIT_FINDING_STATUSES = ['open', 'resolved', 'wont_fix'] as const;
export const AUDIT_RECHECK_RESULTS = ['pass', 'fail', 'wont_fix'] as const;
/** `repo:path#Lx-Ly` (lines optional). */
export const AUDIT_CODE_REF_RE = /^([A-Za-z0-9_.-]+):([^#\s:][^#\s]*)(?:#L(\d+)(?:-L?(\d+))?)?$/;

/** Resolution of a finding: open (optionally linked to a fix work order / feedback), resolved by a passing re-check, or won't fix. */
export const auditResolutionSchema = z.object({
  status: z.enum(AUDIT_FINDING_STATUSES),
  workOrder: slugSchema.optional(),
  feedback: slugSchema.optional(),
  /** Code commit of the passing re-check. */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  at: z.string().min(1).optional(),
  by: z.string().min(1).optional(),
  notes: z.string().optional(),
});
/** A re-check of a finding (appended; the original result stays visible). */
export const auditRecheckSchema = z.object({
  at: z.string().min(1),
  by: z.string().min(1),
  result: z.enum(AUDIT_RECHECK_RESULTS),
  notes: z.string().optional(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
});
/** A re-check of a whole audit item on a frozen audit (appended; the original result stays visible). */
export const AUDIT_ITEM_RECHECK_RESULTS = ['pass', 'fail', 'partial', 'n_a'] as const;
export const auditItemRecheckSchema = z.object({
  at: z.string().min(1),
  by: z.string().min(1),
  result: z.enum(AUDIT_ITEM_RECHECK_RESULTS),
  notes: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
});
/** One finding of an audit item (frontmatter of an `audit-item` section). */
export const auditFindingSchema = z.object({
  id: slugSchema,
  title: z.string().trim().min(1),
  severity: z.enum(AUDIT_FINDING_SEVERITIES),
  classification: z.enum(AUDIT_FINDING_CLASSIFICATIONS),
  /** What is wrong and why (markdown). */
  description: z.string().min(1),
  /** How to fix it (markdown). */
  suggestedFix: z.string().optional(),
  /** Quoted code / output (markdown). */
  evidence: z.string().optional(),
  codeRefs: z.array(z.string().regex(AUDIT_CODE_REF_RE, 'code refs look like repo:path#Lx-Ly')).default([]),
  resolution: auditResolutionSchema.optional(),
  rechecks: z.array(auditRecheckSchema).optional(),
  /** The same problem already reported by a finding of an earlier audit (`mandate://audits/<id>/findings/<fid>`). */
  duplicateOf: z.string().regex(/^mandate:\/\/audits\/[a-z0-9]+(?:-[a-z0-9]+)*\/findings\/[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a finding reference: mandate://audits/<id>/findings/<fid>').optional(),
});
export type AuditFindingMeta = z.output<typeof auditFindingSchema>;

/* ---------- wo-section sections (work-order documents) ---------- */

export const WO_SECTION_STATUSES = ['pending', 'done', 'obsolete'] as const;
export const TOUCH_CHANGES = ['added', 'modified', 'deleted', 'renamed'] as const;
/** Line range `N` or `N-M` (1-based, inclusive). */
export const LINE_RANGE_RE = /^\d+(?:-\d+)?$/;
/**
 * Code a work order touched: one entry per file (repo + normalized path), merged line ranges, symbols, the kind of
 * change, the previous path of a rename and the code commits that changed it.
 */
export const touchedFileSchema = z.object({
  repo: looseString,
  path: z.string().min(1),
  lines: z.array(z.string().regex(LINE_RANGE_RE, 'lines must be N or N-M')).optional(),
  symbols: z.array(z.string().min(1)).optional(),
  change: z.enum(TOUCH_CHANGES),
  /** Renames: the previous path. */
  from: z.string().min(1).optional(),
  commits: z.array(z.string().regex(/^[0-9a-f]{4,64}$/, 'commit sha')).optional(),
});
export type TouchedFile = z.output<typeof touchedFileSchema>;

/** Per-section metadata, stored in the frontmatter `sections:` list. */
export const sectionMetaSchema = z.object({
  id: slugSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .refine((t) => !/[\r\n]/.test(t), 'title must be a single line'),
  type: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'type must be a lowercase id')
    .default('markdown'),
  /** One-sentence summary of the section (used by search and agents); `validate` warns when it is missing. */
  summary: z
    .string()
    .trim()
    .min(1)
    .refine((t) => !/[\r\n]/.test(t), 'summary must be a single line')
    .optional(),
  /** Archived sections stay in the document (ids are never reused) but are no longer in force. */
  archived: z.boolean().optional(),
  /** Where the content came from: `inferred` (reverse-engineered from code, e.g. /mandate-bootstrap) or `confirmed` by a person. */
  provenance: z.enum(['inferred', 'confirmed']).optional(),
  /** Confidence of inferred content, 0..1. */
  confidence: z.number().min(0).max(1).optional(),
  refs: z.array(codeRefSchema).default([]),
  symbols: z.array(z.string().min(1)).default([]),
  /**
   * Links to sections of ANOTHER document of the SAME kind (`mandate://<kind>/<id>/sections/<sid>`).
   * Kind-specific rules (allowed rels, existence, cycles) are applied by the app's link validation.
   */
  links: z.array(sectionLinkSchema).default([]),
  /** Acceptance sections (same document) that verify this section. */
  verifiedBy: z.array(slugSchema).default([]),
  /** How an acceptance criterion is verified (validated by the `acceptance` type's metaSchema). */
  method: z.string().optional(),
  /** Metric threshold for `method: metric` criteria. */
  threshold: z
    .object({ metric: z.string().min(1), max: z.number().optional(), min: z.number().optional() })
    .optional(),
  /** Rule level (`rule` sections; validated by the rule type's metaSchema). */
  level: z.enum(['must', 'should', 'may']).optional(),
  /** Why the rule exists (`rule` sections, required there). */
  rationale: z.string().optional(),
  /** Where a rule applies: path globs and languages (narrows its standard's scope). */
  scope: z.object({ paths: z.array(z.string().min(1)).optional(), languages: z.array(z.string().min(1)).optional() }).optional(),
  /** How a rule is checked (lint / test / script / review, optional command). */
  check: z
    .object({ kind: z.enum(['lint', 'test', 'script', 'review']), command: z.string().optional(), ruleId: z.string().optional(), note: z.string().optional() })
    .optional(),
  /** Code examples (code reference URIs). */
  examples: z.array(z.string().min(1)).optional(),
  /** Audit items: the criterion / rule section checked (`mandate://specs|standards/<id>/sections/<sid>`). */
  ref: z.string().min(1).optional(),
  /** Audit items: criterion (acceptance) or rule. */
  kind: z.enum(['criterion', 'rule']).optional(),
  /** Audit items: the result (pending until recorded). */
  result: z.enum(AUDIT_ITEM_RESULTS).optional(),
  /** Audit items: content hash of the criterion / rule at the audit's commit (staleness). */
  hash: z.string().min(1).optional(),
  /** Audit items: findings. */
  findings: z.array(auditFindingSchema).optional(),
  /** Audit items: re-checks of the item after the audit was completed (the original result stays). */
  itemRechecks: z.array(auditItemRecheckSchema).optional(),
  /** Work-order sections: the spec section implemented (`mandate://specs/<id>/sections/<sid>`). */
  target: z.string().min(1).optional(),
  /** Work-order sections: pending | done | obsolete. */
  status: z.enum(WO_SECTION_STATUSES).optional(),
  /** Work-order sections: verification results / criteria that prove the section (references). */
  verifications: z.array(z.string().min(1)).optional(),
  /** Work-order sections: the code touched for this section (same shape as the work order's `touched`). */
  codeRefs: z.array(touchedFileSchema).optional(),
  /** Work-order sections: deviations from the spec section (markdown, one per item). */
  deviations: z.array(z.string().min(1)).optional(),
  /** Commit of the document version in which this section was last implemented (optional, app-defined). */
  implementedCommit: looseString.optional(),
});
export type SectionMeta = z.output<typeof sectionMetaSchema>;

export const sectionSchema = sectionMetaSchema.extend({ body: z.string().default('') });
/** A fully-resolved section (defaults applied). */
export type Section = z.output<typeof sectionSchema>;
/** Section as accepted by ops/serialize (optional fields may be omitted). */
export type SectionInput = z.input<typeof sectionSchema>;

/** A parsed document: typed frontmatter plus ordered, flat sections. */
export interface Doc<F> {
  frontmatter: F;
  sections: Section[];
}
