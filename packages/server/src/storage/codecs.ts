import { createDefaultRegistry, tldrWarnings, createDocFormat, type DocFormat } from '@mandate/doc';
import type { z } from 'zod';
import {
  specFrontmatterSchema,
  specSchema,
  standardFrontmatterSchema,
  standardSchema,
  componentFrontmatterSchema,
  componentSchema,
  auditFrontmatterSchema,
  auditSchema,
  workOrderFrontmatterSchema,
  workOrderDocSchema,
  type StoredWorkOrderDoc,
  type StoredAudit,
  type StoredComponent,
  type StoredSpec,
  type StoredStandard,
} from '@mandate/shared';
import type { FileCodec } from './MarkdownDirRepository.js';

/**
 * Section types the server accepts. Register additional types here
 * (see README, "Adding a section type").
 */
export const sectionTypes = createDefaultRegistry();

/** Structured documents (frontmatter + `<!-- @section -->` blocks) for specs and standards. */
export const specFormat = createDocFormat(specFrontmatterSchema, { registry: sectionTypes, docWarnings: tldrWarnings });
export const standardFormat = createDocFormat(standardFrontmatterSchema, { registry: sectionTypes, docWarnings: tldrWarnings });
export const componentFormat = createDocFormat(componentFrontmatterSchema, { registry: sectionTypes, docWarnings: tldrWarnings });
/** Audit reports (`audits/<id>.md`): an overview plus one `audit-item` section per checklist item. */
export const auditFormat = createDocFormat(auditFrontmatterSchema, { registry: sectionTypes });
/** Work orders (`work-orders/<id>.md`): plan, one `wo-section` per targeted spec section, reconciliation, outcome. */
export const workOrderFormat = createDocFormat(workOrderFrontmatterSchema, { registry: sectionTypes });

/** File codec for any sectioned document kind: frontmatter + sections, id from the file name. */
function docCodec<T extends { id: string; sections: unknown[] }, F, FIn>(
  format: DocFormat<F, FIn>,
  schema: z.ZodType<T>,
): FileCodec<T> {
  return {
    decode(raw, id) {
      const doc = format.parse(raw);
      return schema.parse({ ...doc.frontmatter, id, sections: doc.sections });
    },
    encode(entity) {
      const { id: _id, sections, ...frontmatter } = entity;
      return format.serialize({ frontmatter: frontmatter as unknown as FIn, sections: sections as never });
    },
  };
}

export const specCodec: FileCodec<StoredSpec> = docCodec(specFormat, specSchema);
export const standardCodec: FileCodec<StoredStandard> = docCodec(standardFormat, standardSchema);
export const componentCodec: FileCodec<StoredComponent> = docCodec(componentFormat, componentSchema);
export const auditCodec: FileCodec<StoredAudit> = docCodec(auditFormat, auditSchema);
export const workOrderCodec: FileCodec<StoredWorkOrderDoc> = docCodec(workOrderFormat, workOrderDocSchema as never);
