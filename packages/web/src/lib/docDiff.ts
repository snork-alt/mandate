import { createDefaultRegistry, createDocFormat, createRegistry, DocError, diffParsedDocs, diffPlainMarkdown, type DocDiff, type DocIssue } from '@mandate/doc';
import { workOrderFrontmatterSchema, auditFrontmatterSchema, componentFrontmatterSchema, specFrontmatterSchema, standardFrontmatterSchema, type SectionTypeInfo } from '@mandate/shared';

export type DiffableKind = 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';

const SCHEMAS = { specs: specFrontmatterSchema, standards: standardFrontmatterSchema, components: componentFrontmatterSchema, audits: auditFrontmatterSchema, 'work-orders': workOrderFrontmatterSchema };

/**
 * Doc format for a kind, built from the server's section types so every registered type parses.
 * `verifies` is not part of the wire info: take it from the built-in type of the same id, otherwise
 * every `verifiedBy` pointing at an acceptance criterion reads as "not a criterion".
 */
function formatFor(kind: DiffableKind, types: SectionTypeInfo[]) {
  const builtin = createDefaultRegistry();
  return createDocFormat(SCHEMAS[kind], {
    registry: createRegistry(types.map((t) => ({ id: t.id, label: t.label, fence: t.fence, verifies: builtin.get(t.id)?.verifies }))),
  });
}

/** A structured diff plus the validation problems of the versions (old versions predate today's rules). */
export interface LenientDiff {
  diff: DocDiff<unknown>;
  /** Validation notes (non-blocking), deduplicated, `after` side first. */
  notes: DocIssue[];
}

/**
 * Structured diff for a document kind. Versions are parsed leniently: a version written under an
 * earlier schema still renders, and its problems come back as `notes`. Older standards were plain
 * markdown, so standards fall back to a one-section diff. Throws a DocError only when a version has
 * no readable structure at all.
 */
export function diffForKind(kind: DiffableKind, before: string | null, after: string | null, types: SectionTypeInfo[]): LenientDiff {
  const format = formatFor(kind, types);
  const notes: DocIssue[] = [];
  const read = (md: string | null) => {
    if (md === null) return null;
    const r = format.inspect(md);
    for (const i of r.issues) if (!notes.some((n) => n.message === i.message)) notes.push(i);
    if (!r.doc) throw new DocError(r.issues);
    return r.doc;
  };
  try {
    const a = read(after);
    const b = read(before);
    return { diff: diffParsedDocs(b, a, format.registry) as DocDiff<unknown>, notes };
  } catch (err) {
    if (kind === 'standards') return { diff: diffPlainMarkdown(before, after) as DocDiff<unknown>, notes: [] };
    throw err;
  }
}
