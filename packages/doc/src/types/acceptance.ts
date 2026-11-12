import { z } from 'zod';
import type { GraphEdge, GraphNode, SectionTypeDef } from '../registry.js';

export const ACCEPTANCE_METHODS = ['test', 'manual', 'review', 'metric'] as const;

/** Frontmatter entry of an acceptance criterion: how it is verified. */
export const acceptanceMetaSchema = z
  .object({
    method: z.enum(ACCEPTANCE_METHODS, { message: `method must be one of ${ACCEPTANCE_METHODS.join(', ')}` }),
    threshold: z
      .object({ metric: z.string().min(1), max: z.number().optional(), min: z.number().optional() })
      .refine((t) => t.max !== undefined || t.min !== undefined, 'threshold needs max or min')
      .optional(),
  })
  .refine((m) => m.method !== 'metric' || !!m.threshold, { message: 'metric criteria need a threshold', path: ['threshold'] });

/**
 * One acceptance criterion per section: the body is plain markdown (statement, optional steps);
 * `method` / `threshold` live in the frontmatter entry. The criterion's URI is the section URI.
 */
export const acceptanceType: SectionTypeDef = {
  id: 'acceptance',
  label: 'Acceptance criterion',
  description: 'One verifiable acceptance criterion; frontmatter entry has method (test|manual|review|metric) and optional threshold.',
  metaSchema: acceptanceMetaSchema,
  verifies: true,
  extractNodes(section, docUri): GraphNode[] {
    return [{ uri: `${docUri}/sections/${section.id}`, kind: 'criterion', label: section.title, text: section.body }];
  },
  status(section, ctx) {
    const state = ctx.itemStates?.[`${ctx.docUri}/sections/${section.id}`] ?? 'unverified';
    return { total: 1, verified: state === 'verified' ? 1 : 0, state };
  },
};

/** Edges from any section to the criteria that verify it (`verifiedBy`). */
export function verifiedByEdges(section: { id: string; verifiedBy?: string[] }, docUri: string): GraphEdge[] {
  return (section.verifiedBy ?? []).map((c) => ({ from: `${docUri}/sections/${section.id}`, to: `${docUri}/sections/${c}`, kind: 'verified-by' }));
}
