/**
 * Strict input schemas for the document READ service functions (`DocReadService` on the server).
 * The MCP read tools wrap these 1:1: the same schema validates the call and produces the tool's JSON Schema.
 */
import { z } from 'zod';
import { parseRef, type RefKind } from './refs.js';
// Enums come from the leaf module (no import cycle with index.ts).
import { CRITERION_STATES, FEEDBACK_KINDS, FEEDBACK_STATUSES, SPEC_STATUSES, VERIFICATION_RESULTS, WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from './base.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z.string().trim().min(1).max(120).regex(SLUG_RE, 'expected a lowercase slug id (a-z, 0-9, dashes)');
const shortText = (max = 120) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodType>(item: T, max = 20) => z.array(item).min(1).max(max);
const cursorSchema = z.string().max(200).regex(/^[0-9]+$/, 'invalid cursor');

/** A commit: 4-40 hex chars (short shas are resolved), or HEAD. */
export const commitRefSchema = z.union([z.literal('HEAD'), z.string().regex(/^[0-9a-f]{4,40}$/, 'expected a commit sha (4-40 hex chars) or HEAD')]);

/**
 * A document of `kind`, as an id (`login-sso`) or a copied reference (`mandate://specs/login-sso`,
 * `@mandate:mandate://specs/login-sso@3f2a9c1/sections/auth-flow#L12-L20`).
 */
export function docRefSchema(kinds: RefKind[], opts: { sections?: boolean } = {}) {
  return z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((v) => {
      if (SLUG_RE.test(v)) return true;
      const r = parseRef(v);
      return !!r && kinds.includes(r.kind) && (opts.sections !== false || !r.sectionId);
    }, `expected an id or a ${kinds.map((k) => `mandate://${k}/<id>`).join(' / ')} reference`);
}

/** A section reference (`mandate://specs/x/sections/y`, optionally `@sha` and `#Lx-Ly`). */
export function sectionRefSchema(kinds: RefKind[]) {
  return z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((v) => {
      const r = parseRef(v);
      return !!r && kinds.includes(r.kind) && !!r.sectionId;
    }, `expected a section reference such as mandate://${kinds[0]}/<id>/sections/<sid>`);
}

export const VERIFICATION_FILTER_STATES = ['verified', 'failing', 'stale', 'unverified', 'none'] as const;

const page = { limit: z.number().int().min(1).max(200).default(50), cursor: cursorSchema.optional() };

export const specListInputSchema = z
  .object({
    status: list(z.enum(SPEC_STATUSES), 10).optional(),
    category: list(shortText(80)).optional(),
    repo: list(shortText(120)).optional(),
    /** Any of these tags. */
    tags: list(shortText(80)).optional(),
    /** Specs using this standard (directly, in a section or via appliesTo). */
    standard: slug.optional(),
    /** Only specs with (true) or without (false) blocked sections. */
    blocked: z.boolean().optional(),
    /** Verification rollup: all criteria verified, any failing, any stale, some unverified, or no criteria. */
    verification: list(z.enum(VERIFICATION_FILTER_STATES), 5).optional(),
    /** Audit state: never (no completed audit), stale, open_findings, or the last outcome (fail | warn | pass). */
    audit: list(z.enum(['never', 'stale', 'open_findings', 'fail', 'warn', 'pass']), 6).optional(),
    /** Maturity step (draft | specified | in_progress | implemented | verified | audited) or overlay (failing | drifted | blocked | stale | archived). */
    maturity: list(z.enum(['draft', 'specified', 'in_progress', 'implemented', 'verified', 'audited', 'failing', 'drifted', 'blocked', 'stale', 'archived']), 11).optional(),
    /** Case-insensitive substring of the id or title. */
    q: shortText(200).optional(),
    ...page,
  })
  .strict();
export type SpecListInput = z.input<typeof specListInputSchema>;

export const standardListInputSchema = z
  .object({ tags: list(shortText(80)).optional(), q: shortText(200).optional(), ...page })
  .strict();
export type StandardListInput = z.input<typeof standardListInputSchema>;

const docGet = (kind: 'specs' | 'standards') =>
  z
    .object({
      /** Id or reference (a versioned reference reads the document at that commit; a section reference selects that section). */
      ref: docRefSchema([kind]),
      /** Read the document as of this commit (same as `@sha` in the reference). */
      at: commitRefSchema.optional(),
      /** Frontmatter and the section outline only (no bodies). */
      metadataOnly: z.boolean().default(false),
      /** Only these sections (ids). */
      sections: list(slug, 100).optional(),
    })
    .strict();
export const specGetInputSchema = docGet('specs');
export type SpecGetInput = z.input<typeof specGetInputSchema>;
export const standardGetInputSchema = docGet('standards');
export type StandardGetInput = z.input<typeof standardGetInputSchema>;

const sectionGet = (kind: 'specs' | 'standards') =>
  z
    .object({
      /** Section reference, e.g. mandate://specs/login-sso/sections/auth-flow (optionally @sha, #Lx-Ly). Or give `doc` + `section`. */
      ref: sectionRefSchema([kind]).optional(),
      doc: docRefSchema([kind], { sections: false }).optional(),
      section: slug.optional(),
      at: commitRefSchema.optional(),
    })
    .strict()
    .refine((v) => !!v.ref !== !!(v.doc && v.section), { message: 'give either ref, or doc and section' });
export const specSectionGetInputSchema = sectionGet('specs');
export type SpecSectionGetInput = z.input<typeof specSectionGetInputSchema>;
export const standardSectionGetInputSchema = sectionGet('standards');
export type StandardSectionGetInput = z.input<typeof standardSectionGetInputSchema>;

export const workOrderListInputSchema = z
  .object({
    status: list(z.enum(WORK_ORDER_STATUSES), 10).optional(),
    kind: list(z.enum(WORK_ORDER_KINDS), 10).optional(),
    spec: docRefSchema(['specs'], { sections: false }).optional(),
    ...page,
  })
  .strict();
export type WorkOrderListInput = z.input<typeof workOrderListInputSchema>;

export const workOrderGetInputSchema = z
  .object({
    ref: docRefSchema(['work-orders']),
    /** Dependency tree as of this commit (default: the work order's specCommit). */
    at: commitRefSchema.optional(),
    depth: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type WorkOrderGetInput = z.input<typeof workOrderGetInputSchema>;

export const feedbackListInputSchema = z
  .object({
    status: list(z.enum(FEEDBACK_STATUSES), 10).optional(),
    kind: list(z.enum(FEEDBACK_KINDS), 10).optional(),
    /** Items targeting this document or section (any reference form). */
    target: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .refine((v) => {
        const r = parseRef(v);
        return !!r && (r.kind === 'specs' || r.kind === 'standards');
      }, 'expected a mandate://specs/... or mandate://standards/... reference')
      .optional(),
    ...page,
  })
  .strict();
export type FeedbackListInput = z.input<typeof feedbackListInputSchema>;

export const feedbackGetInputSchema = z.object({ ref: docRefSchema(['feedback']) }).strict();
export type FeedbackGetInput = z.input<typeof feedbackGetInputSchema>;

export const verificationListInputSchema = z
  .object({
    /** Acceptance section reference. */
    criterion: sectionRefSchema(['specs', 'standards']).optional(),
    /** Spec id or reference: results applied to it, plus its derived criterion states. */
    spec: docRefSchema(['specs'], { sections: false }).optional(),
    /** Derived criterion states to return (per spec). */
    state: list(z.enum(CRITERION_STATES), 10).optional(),
    result: list(z.enum(VERIFICATION_RESULTS), 10).optional(),
    ...page,
  })
  .strict();
export type VerificationListInput = z.input<typeof verificationListInputSchema>;

/** Any document reference: specs, standards (and sections), work orders, feedback. */
const anyDocRef = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((v) => parseRef(v) !== null, 'expected a mandate:// reference to a spec, standard, section, work order or feedback item');

export const historyGetInputSchema = z
  .object({
    ref: anyDocRef,
    limit: z.number().int().min(1).max(500).default(100),
    /** Only commits triggered by this user (the owner, a GitHub login or service:<name>). */
    user: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type HistoryGetInput = z.input<typeof historyGetInputSchema>;

export const diffGetInputSchema = z
  .object({
    /** Spec or standard (or one of its sections) reference. */
    ref: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .refine((v) => {
        const r = parseRef(v);
        return !!r && (r.kind === 'specs' || r.kind === 'standards');
      }, 'expected a mandate://specs/... or mandate://standards/... reference'),
    from: commitRefSchema,
    /** Default HEAD. */
    to: commitRefSchema.optional(),
    /** Include the full parsed documents of both sides (large). */
    full: z.boolean().default(false),
  })
  .strict();
export type DiffGetInput = z.input<typeof diffGetInputSchema>;

export const gitStatusInputSchema = z.object({}).strict();
export const gitPullInputSchema = z.object({}).strict();

/* ------------------------------------------------------------------ UI views (full derived payloads) */

const FILE_KINDS = ['specs', 'standards', 'components', 'audits', 'work-orders'] as const;
const ENTITY_KIND_VALUES = ['specs', 'standards', 'components', 'work-orders', 'feedback', 'audits'] as const;

/** Every entity of a kind with git-derived times and the list rollups the UI shows. */
export const docListInputSchema = z.object({ kind: z.enum(ENTITY_KIND_VALUES) }).strict();
export type DocListInput = z.input<typeof docListInputSchema>;

/** One spec / standard / component with derived detail (verification, links, derived states). */
export const docGetInputSchema = z.object({ kind: z.enum(FILE_KINDS), id: slug }).strict();
export type DocGetInput = z.input<typeof docGetInputSchema>;

export const versionGetInputSchema = z
  .object({
    kind: z.enum(FILE_KINDS),
    id: slug,
    commit: z.string().regex(/^[0-9a-f]{4,40}$/, 'expected a commit sha (4-40 hex chars)'),
    /** parent: what this commit changed; head: from this commit to the current version. */
    against: z.enum(['parent', 'head']).default('parent'),
    /** Explicit comparison base (e.g. a section's implementedCommit). */
    base: z.string().regex(/^[0-9a-f]{4,40}$/, 'expected a commit sha').optional(),
  })
  .strict();
export type VersionGetInput = z.input<typeof versionGetInputSchema>;

export const docRawInputSchema = z.object({ kind: z.enum(FILE_KINDS), id: slug }).strict();
export type DocRawInput = z.input<typeof docRawInputSchema>;

export const standardUsageInputSchema = z.object({ id: slug }).strict();
export type StandardUsageInput = z.input<typeof standardUsageInputSchema>;

export const specImplementationInputSchema = z.object({ id: slug }).strict();
export type SpecImplementationInput = z.input<typeof specImplementationInputSchema>;

export const docFeedbackInputSchema = z.object({ kind: z.enum(FILE_KINDS), id: slug }).strict();
export type DocFeedbackInput = z.input<typeof docFeedbackInputSchema>;

export const sectionTypesInputSchema = z.object({}).strict();

export const gitLogInputSchema = z.object({ limit: z.number().int().min(1).max(500).default(80) }).strict();
export type GitLogInput = z.input<typeof gitLogInputSchema>;
