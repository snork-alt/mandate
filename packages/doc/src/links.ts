import type { LinkRel, Section } from './schema.js';

/**
 * Allowed link directions and rels, keyed `<from kind>-><to kind>`. Anything not listed
 * (e.g. standards -> specs) is forbidden.
 */
export const LINK_RULES: Record<string, { rels: LinkRel[]; hint?: string; noteRequired?: LinkRel[] }> = {
  'specs->specs': { rels: ['depends_on', 'extends', 'relates_to', 'conflicts_with', 'supersedes'] },
  'specs->standards': {
    rels: ['follows', 'deviates_from', 'relates_to'],
    hint: 'spec sections link to standard sections with follows, deviates_from or relates_to',
    noteRequired: ['deviates_from'],
  },
  'standards->standards': {
    rels: ['extends', 'relates_to', 'conflicts_with', 'supersedes'],
    hint: 'standards cannot depend on each other; use extends or relates_to',
  },
  'specs->components': { rels: ['affects'], hint: 'spec sections link to components with affects' },
  'components->components': { rels: ['depends_on'], hint: 'components link to other components with depends_on' },
  'components->standards': {
    rels: ['follows', 'deviates_from'],
    hint: 'components link to standards with follows or deviates_from',
    noteRequired: ['deviates_from'],
  },
};

const FORBIDDEN_HINTS: Record<string, string> = {
  'standards->specs': 'standards never link to specs; link the spec section to the standard instead (follows / deviates_from)',
  'components->specs': 'components never link to specs; link the spec section to the component instead (affects)',
  'standards->components': 'standards apply to components through appliesTo (component:<id>, componentKind:<kind>)',
};

const SECTION_URI = /^mandate:\/\/([a-z]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/sections\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function parseSectionUri(uri: string): { kind: string; id: string; sectionId: string } | null {
  const m = SECTION_URI.exec(uri);
  return m ? { kind: m[1]!, id: m[2]!, sectionId: m[3]! } : null;
}

const DOC_URI = /^mandate:\/\/([a-z]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Link target: a section, or (spec -> standard only) a whole standard (`sectionId` undefined). */
export function parseLinkTarget(uri: string): { kind: string; id: string; sectionId?: string } | null {
  const s = parseSectionUri(uri);
  if (s) return s;
  const m = DOC_URI.exec(uri);
  return m ? { kind: m[1]!, id: m[2]! } : null;
}

/** Rels that may target a whole standard from a spec section. */
export const WHOLE_STANDARD_RELS: LinkRel[] = ['follows', 'deviates_from', 'relates_to'];

/** Directions and rels that may target a whole document (`mandate://<kind>/<id>`) instead of a section. */
const WHOLE_DOC: Record<string, LinkRel[]> = {
  'specs->standards': WHOLE_STANDARD_RELS,
  'specs->components': ['affects'],
  'components->components': ['depends_on'],
  'components->standards': ['follows', 'deviates_from'],
};

/**
 * Structural link checks that need only the document itself: allowed direction and rel,
 * another document as target, and a note where required. (Existence and cycles need the other
 * documents and are checked by the app's service layer.)
 */
export function checkLinks(kind: string, docId: string, sections: Pick<Section, 'id' | 'links'>[]): string[] {
  const problems: string[] = [];
  for (const s of sections) {
    const seen = new Set<string>();
    for (const l of s.links ?? []) {
      const t = parseLinkTarget(l.to);
      if (!t) {
        problems.push(`section "${s.id}": ${l.to} is not a section URI`);
        continue;
      }
      // One relation per (source section, target): contradictory pairs (follows + deviates_from,
      // depends_on + conflicts_with) and redundant relates_to are rejected.
      if (seen.has(l.to)) problems.push(`section "${s.id}": only one link per target (${l.to} is linked twice)`);
      seen.add(l.to);
      const dir = `${kind}->${t.kind}`;
      const rules = LINK_RULES[dir];
      if (!rules) {
        problems.push(`section "${s.id}": ${FORBIDDEN_HINTS[dir] ?? `${kind} sections cannot link to ${t.kind}`}`);
        continue;
      }
      if (!t.sectionId && !WHOLE_DOC[dir]?.includes(l.rel)) {
        problems.push(`section "${s.id}": ${l.to} is a whole document; only follows / deviates_from / relates_to a standard, affects / depends_on a component may target a whole document`);
        continue;
      }
      if (t.kind === kind && t.id === docId) problems.push(`section "${s.id}": links must point to another document`);
      if (!rules.rels.includes(l.rel)) problems.push(`section "${s.id}": rel "${l.rel}" is not allowed from ${kind} to ${t.kind}${rules.hint ? ` (${rules.hint})` : ''}`);
      if (rules.noteRequired?.includes(l.rel) && !l.note?.trim()) problems.push(`section "${s.id}": a ${l.rel} link needs a note with the justification`);
    }
  }
  return problems;
}

/** Find a cycle in a `depends_on` graph (adjacency by node key); returns the cycle path or null. */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}
