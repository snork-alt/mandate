import { z } from 'zod';
import type { GraphEdge, SectionTypeDef } from '../registry.js';
import { touchedFileSchema, WO_SECTION_STATUSES, type Section } from '../schema.js';
import type { IndexLine } from '../split/extract.js';

/** Frontmatter entry of a work-order section: the spec section it implements, its status, proof and code. */
export const woSectionMetaSchema = z.object({
  target: z.string().regex(/^mandate:\/\/specs\/[a-z0-9-]+\/sections\/[a-z0-9-]+$/, 'target must be a spec section URI (mandate://specs/<id>/sections/<sid>)'),
  status: z.enum(WO_SECTION_STATUSES, { message: `status must be one of ${WO_SECTION_STATUSES.join(', ')}` }),
  verifications: z.array(z.string().min(1)).optional(),
  codeRefs: z.array(touchedFileSchema).optional(),
  deviations: z.array(z.string().min(1)).optional(),
});

/**
 * One targeted spec section of a work order: the meta names the spec section (`target`), its `status`
 * (pending | done | obsolete), the verifications that prove it, the code touched for it (`codeRefs`) and the
 * deviations from the spec; the body holds the implementation notes.
 */
export const woSectionType: SectionTypeDef = {
  id: 'wo-section',
  label: 'Work-order section',
  description: 'One targeted spec section of a work order: target (spec section URI), status (pending|done|obsolete), verifications[], codeRefs[] (touched code: repo, path, lines, symbols, change), deviations[]; body: implementation notes.',
  metaSchema: woSectionMetaSchema,
  toIndexText(section: Section): IndexLine[] {
    const lines: IndexLine[] = section.body.split('\n').map((text, i) => ({ text, line: i + 1 }));
    for (const d of section.deviations ?? []) lines.push({ text: d, line: 1 });
    for (const c of section.codeRefs ?? []) lines.push({ text: `${c.repo}:${c.path}`, line: 1 });
    return lines;
  },
  extractEdges(section, docUri): GraphEdge[] {
    const from = `${docUri}/sections/${section.id}`;
    // Code edges (`touches`, with code nodes) are added by the indexer's work-order extraction.
    return section.target ? [{ from, to: section.target, kind: 'covers' }] : [];
  },
};
