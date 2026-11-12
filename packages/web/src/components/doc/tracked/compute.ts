/** Lazy-loaded: parses both versions, diffs them structurally and builds tracked markdown trees. */
import type { DocDiff } from '@mandate/doc';
import type { FileVersion, SectionTypeInfo } from '@mandate/shared';
import type { Root } from 'mdast';
import { diffForKind, type DiffableKind } from '../../../lib/docDiff';
import { mergeMarkdown } from './mergeMarkdown';

export interface TrackedData {
  diff: DocDiff<Record<string, unknown>>;
  /** Merged markdown trees for modified markdown sections, by section id. */
  trees: Map<string, Root>;
}

export function computeTracked(kind: DiffableKind, version: FileVersion, types: SectionTypeInfo[]): TrackedData {
  const diff = diffForKind(kind, version.before, version.after, types) as DocDiff<Record<string, unknown>>;
  const fenced = new Set(types.filter((t) => t.fence).map((t) => t.id));
  const trees = new Map<string, Root>();
  for (const s of diff.sections) {
    if (s.status === 'modified' && s.before && s.after && s.body && !fenced.has(s.after.type)) {
      trees.set(s.id, mergeMarkdown(s.before.body, s.after.body));
    }
  }
  return { diff, trees };
}
