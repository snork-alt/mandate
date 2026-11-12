/**
 * Leaf module of shared constants and small schemas: it imports nothing from this package, so every module
 * (index.ts and the schema modules it re-exports) can use them at load time without an import cycle.
 */
import { z } from 'zod';

/** Re-exported by index.ts. */
export const idSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be a lowercase slug (a-z, 0-9, dashes)');

/** Re-exported by index.ts. */
export const STORED_SPEC_STATUSES = ['draft', 'ready', 'done', 'archived'] as const;

/** Re-exported by index.ts. */
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;

/** Re-exported by index.ts. */
export const WORK_ORDER_KINDS = ['implement', 'update', 'review', 'verify', 'fix'] as const;

/** Re-exported by index.ts. */
export const FEEDBACK_KINDS = ['ambiguity', 'conflict', 'bug', 'improvement', 'question'] as const;

/** Re-exported by index.ts. */
export const FEEDBACK_RESOLUTIONS = ['applied', 'rejected', 'duplicate'] as const;

/** Re-exported by index.ts. */
export const VERIFICATION_RESULTS = ['pass', 'fail', 'skipped'] as const;

/** Re-exported by index.ts. */
export const VERIFICATION_METHODS = ['test', 'manual', 'review', 'metric'] as const;

/** Re-exported by index.ts. */
export const appliesToSchema = z
  .string()
  .regex(
    /^(repo|tag|category|path|lang|component|componentKind):[\w./*?{},@-]+$/,
    'appliesTo entries look like "repo:app", "tag:api", "category:x", "path:src/**/*.ts", "lang:typescript", "component:<id>" or "componentKind:<kind>"',
  );

/** Re-exported by index.ts. */
export const exemptionSchema = z.object({
  standard: idSchema,
  reason: z.string().min(1),
  /** Accepted feedback item approving the exemption (its author must differ from `by`). */
  feedback: idSchema,
  /** Who added the exemption (server-set from the commit's agent / author). */
  by: z.string().min(1).optional(),
});

/** Re-exported by index.ts. */
export const SPEC_STATUSES = ['draft', 'ready', 'in_progress', 'done', 'archived'] as const;

/** Re-exported by index.ts. */
export const WORK_ORDER_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'cancelled'] as const;

/** Re-exported by index.ts. */
export const FEEDBACK_STATUSES = ['open', 'accepted', 'closed'] as const;

/** Re-exported by index.ts. */
export const CRITERION_STATES = ['verified', 'failing', 'stale', 'unverified', 'waived', 'unknown'] as const;

/** Re-exported by index.ts (standard lifecycle). */
/** Component lifecycle (transitions: COMPONENT_TRANSITIONS in lifecycle.ts). */
export const COMPONENT_STATUSES = ['active', 'deprecated', 'archived'] as const;
export const STANDARD_STATUSES = ['draft', 'active', 'deprecated'] as const;
