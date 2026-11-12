import { createDocFormat, createRegistry, diffDocs, diffPlainMarkdown, type DocDiff } from '@mandate/doc';
import { componentFrontmatterSchema, specFrontmatterSchema, standardFrontmatterSchema, type SectionTypeInfo } from '@mandate/shared';

export type DiffableKind = 'specs' | 'standards' | 'components';

const SCHEMAS = { specs: specFrontmatterSchema, standards: standardFrontmatterSchema, components: componentFrontmatterSchema };

/** Doc format for a kind, built from the server's section types so every registered type parses. */
function formatFor(kind: DiffableKind, types: SectionTypeInfo[]) {
  return createDocFormat(SCHEMAS[kind], {
    registry: createRegistry(types.map((t) => ({ id: t.id, label: t.label, fence: t.fence }))),
  });
}

/**
 * Structured diff for a document kind. Older standards were plain markdown, so standards fall back
 * to a one-section diff when a version is not in the sectioned format. Throws for unparsable specs.
 */
export function diffForKind(kind: DiffableKind, before: string | null, after: string | null, types: SectionTypeInfo[]): DocDiff<unknown> {
  try {
    return diffDocs(formatFor(kind, types), before, after) as DocDiff<unknown>;
  } catch (err) {
    if (kind === 'standards') return diffPlainMarkdown(before, after) as DocDiff<unknown>;
    throw err;
  }
}
