import { buildRef, type DependencyEdge, type DependencyNode, type DependencyTree } from '@mandate/shared';

/** A document node of the dependency graph: carries the section nodes folded into it. */
export type DocDependencyNode = DependencyNode & { sectionCount?: number; sectionKeys?: string[] };
/** An edge of the document-level graph: `count` section links merged into it. */
export type DocDependencyEdge = DependencyEdge & { count?: number };
export type DocDependencyTree = Omit<DependencyTree, 'nodes' | 'edges'> & { nodes: DocDependencyNode[]; edges: DocDependencyEdge[] };

const docKey = (n: Pick<DependencyNode, 'docKind' | 'docId'>) => buildRef({ kind: n.docKind, id: n.docId });
const uniq = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

/** Roll-up of section states: unfinished beats missing-less implemented; all archived / all standard stay as they are. */
function rollState(states: DependencyNode['state'][]): DependencyNode['state'] {
  if (states.includes('missing')) return 'missing';
  if (states.includes('not_implemented')) return 'not_implemented';
  if (states.every((s) => s === 'archived')) return 'archived';
  if (states.every((s) => s === 'standard' || s === 'archived')) return 'standard';
  return 'implemented';
}

/** "depends on (3)": the label of a merged edge. */
export const dependencyEdgeLabel = (e: Pick<DocDependencyEdge, 'rel' | 'count'>) => `${e.rel.replace(/_/g, ' ')}${e.count && e.count > 1 ? ` (${e.count})` : ''}`;

/**
 * Document level of a work order's dependency graph: the section nodes of one document become one node (state, blocked
 * and changed flags rolled up, work orders and components merged) and the section links between two documents one edge
 * per relation with a count. Documents in `expanded` keep their section nodes. The work order itself is untouched.
 */
export function documentTree(tree: DependencyTree, expanded: ReadonlySet<string> = new Set()): DocDependencyTree {
  const foldedDocs = new Set(tree.nodes.filter((n) => n.type === 'section' && !expanded.has(docKey(n))).map(docKey));
  const groups = new Map<string, DependencyNode[]>();
  for (const n of tree.nodes) if (n.type !== 'work_order' && foldedDocs.has(docKey(n))) groups.set(docKey(n), [...(groups.get(docKey(n)) ?? []), n]);
  const into = new Map<string, string>();
  const nodes: DocDependencyNode[] = tree.nodes.filter((n) => n.type === 'work_order' || !foldedDocs.has(docKey(n)));
  for (const [k, members] of groups) {
    const secs = members.filter((m) => m.type === 'section');
    for (const m of members) into.set(m.key, k);
    const first = members.slice().sort((a, b) => a.depth - b.depth)[0]!;
    nodes.push({
      key: k,
      type: 'spec',
      side: first.side,
      depth: first.depth,
      docKind: first.docKind,
      docId: first.docId,
      docTitle: first.docTitle,
      state: rollState(members.map((m) => m.state)),
      ...(members.find((m) => m.specStatus)?.specStatus ? { specStatus: members.find((m) => m.specStatus)!.specStatus } : {}),
      blocked: members.some((m) => m.blocked),
      ...(members.some((m) => m.broken) ? { broken: true } : {}),
      upstreamChanged: members.some((m) => m.upstreamChanged),
      ...(members.find((m) => m.claim)?.claim ? { claim: members.find((m) => m.claim)!.claim } : {}),
      workOrders: uniq(members.flatMap((m) => m.workOrders), (w) => w.id),
      ...(members.some((m) => m.truncated) ? { truncated: true } : {}),
      ...(members.some((m) => m.blocker) ? { blocker: true } : {}),
      ...(members.some((m) => m.components?.length) ? { components: [...new Set(members.flatMap((m) => m.components ?? []))] } : {}),
      sectionCount: secs.length,
      sectionKeys: secs.map((m) => m.key),
    });
  }
  const merged = new Map<string, DocDependencyEdge>();
  for (const e of tree.edges) {
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (from === to) continue;
    const id = `${from}|${to}|${e.rel}`;
    const have = merged.get(id);
    if (have) {
      have.count = (have.count ?? 1) + 1;
      have.soft = have.soft && e.soft;
    } else merged.set(id, { ...e, from, to, count: 1 });
  }
  return { ...tree, nodes, edges: [...merged.values()] };
}
