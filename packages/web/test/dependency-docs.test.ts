import { describe, expect, it } from 'vitest';
import type { DependencyNode, DependencyTree } from '@mandate/shared';
import { dependencyEdgeLabel, documentTree } from '../src/lib/dependency-docs';

const WO = 'mandate://work-orders/wo-1';
const n = (doc: string, section: string | null, o: Partial<DependencyNode> = {}): DependencyNode => ({
  key: `mandate://specs/${doc}${section ? `/sections/${section}` : ''}`,
  type: section ? 'section' : 'spec',
  side: 'upstream',
  depth: 1,
  docKind: 'specs',
  docId: doc,
  docTitle: doc,
  ...(section ? { sectionId: section } : {}),
  state: 'implemented',
  blocked: false,
  upstreamChanged: false,
  workOrders: [],
  ...o,
});
const tree: DependencyTree = {
  root: WO,
  commit: null,
  depth: 2,
  nodes: [
    { ...n('wo', null), key: WO, type: 'work_order', side: 'center', depth: 0, workOrders: [{ id: 'wo-1', kind: 'implement', status: 'in_progress' }] } as DependencyNode,
    n('auth', 'a1'),
    n('auth', 'a2', { state: 'not_implemented', blocked: true }),
    n('auth', 'a3', { upstreamChanged: true }),
    n('billing', 'b1'),
  ],
  edges: [
    { from: n('auth', 'a1').key, to: WO, rel: 'depends_on', soft: false },
    { from: n('auth', 'a2').key, to: WO, rel: 'depends_on', soft: false },
    { from: n('auth', 'a3').key, to: WO, rel: 'extends', soft: true },
    { from: n('billing', 'b1').key, to: n('auth', 'a1').key, rel: 'depends_on', soft: false },
    { from: n('auth', 'a2').key, to: n('auth', 'a1').key, rel: 'depends_on', soft: false },
  ],
  summary: { blockedBySections: 1, blockedBySpecs: 1, dependentWorkOrders: 0, upstream: 4, downstream: 0 },
};

describe('document-level dependency graph', () => {
  it('one node per document with rolled-up state and flags', () => {
    const t = documentTree(tree);
    expect(t.nodes.map((x) => x.key).sort()).toEqual([WO, 'mandate://specs/auth', 'mandate://specs/billing'].sort());
    const auth = t.nodes.find((x) => x.key === 'mandate://specs/auth')!;
    expect(auth).toMatchObject({ type: 'spec', state: 'not_implemented', blocked: true, upstreamChanged: true, sectionCount: 3 });
    expect(t.nodes.find((x) => x.key === 'mandate://specs/billing')!.state).toBe('implemented');
  });

  it('merges section links per relation with counts and drops links inside a document', () => {
    const t = documentTree(tree);
    const dep = t.edges.find((e) => e.to === WO && e.rel === 'depends_on')!;
    expect(dep.count).toBe(2);
    expect(dependencyEdgeLabel(dep)).toBe('depends on (2)');
    expect(t.edges.find((e) => e.rel === 'extends')).toMatchObject({ count: 1, soft: true });
    expect(dependencyEdgeLabel(t.edges.find((e) => e.rel === 'extends')!)).toBe('extends');
    expect(t.edges).toHaveLength(3);
  });

  it('expanding one document keeps its sections', () => {
    const t = documentTree(tree, new Set(['mandate://specs/auth']));
    expect(t.nodes.filter((x) => x.type === 'section')).toHaveLength(3);
    expect(t.nodes.some((x) => x.key === 'mandate://specs/billing')).toBe(true);
    expect(t.edges.find((e) => e.from === 'mandate://specs/billing')!.to).toBe(n('auth', 'a1').key);
  });
});
