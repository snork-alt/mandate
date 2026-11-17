/**
 * Pure model + ELK layout of the Ask graph embed (`GraphEmbed`): merges the `graph_neighbors` results of the seed
 * refs, merges parallel edges, collapses leaf fans of big graphs into "+N specs" group nodes, and lays the result
 * out with ELK `layered` (seeds in the middle layer, node sizes measured from their labels, no overlaps).
 */
import type { ElkNode } from 'elkjs/lib/elk-api';

export interface RawNode { uri?: string; ref: string; kind: string; label: string }
export interface RawEdge { from: string; to: string; kind: string }
export interface Neighbors { root?: string; nodes: RawNode[]; edges: RawEdge[] }

export interface GNode {
  id: string;
  kind: string;
  /** Full label (tooltip). */
  label: string;
  /** Short label drawn in the node. */
  short: string;
  seed: boolean;
  /** Group node standing for collapsed leaves. */
  group?: { members: string[]; anchor: string };
}
/** One drawn edge: all parallel edges of a node pair merged (either direction). */
export interface GEdge {
  id: string;
  from: string;
  to: string;
  /** Edge kinds with their multiplicity, in first-seen order. */
  kinds: { kind: string; count: number }[];
  count: number;
  /** Edges exist in both directions. */
  both: boolean;
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** Edges left out of a collapsed summary (cross links between non-seed nodes). */
  hiddenEdges?: number;
}

export interface PlacedNode extends GNode { x: number; y: number; w: number; h: number }
export interface PlacedEdge extends GEdge { points: { x: number; y: number }[] }
export interface GraphLayout { width: number; height: number; direction: 'RIGHT' | 'DOWN'; nodes: PlacedNode[]; edges: PlacedEdge[] }

const norm = (u: string) => u.trim().replace(/^@mandate:/, '');
export const shortLabel = (label: string) => label.split('›').pop()!.trim() || label;
export const edgeKindLabel = (k: string) => k.replace(/_/g, ' ');

/** Structure edges (a document's own sections) are noise here; keep the relations between nodes. */
const SKIP = new Set(['has_section']);

/** Union of the neighbourhoods of the seeds (nodes keyed by uri; edges may name a node by uri or ref). */
export function mergeNeighbors(seeds: string[], results: (Neighbors | undefined)[], kindOf: (uri: string) => string | null = () => null, labelOf: (uri: string) => string = (u) => u): { nodes: GNode[]; edges: RawEdge[] } {
  const nodes = new Map<string, GNode>();
  const alias = new Map<string, string>();
  const seedIds = seeds.map(norm);
  for (const s of seedIds) {
    nodes.set(s, { id: s, kind: kindOf(s) ?? 'section', label: labelOf(s), short: shortLabel(labelOf(s)), seed: true });
    alias.set(s, s);
  }
  const edges: RawEdge[] = [];
  const seen = new Set<string>();
  results.forEach((d, i) => {
    if (!d) return;
    const byKey = new Map<string, RawNode>();
    for (const n of d.nodes) {
      byKey.set(n.ref, n);
      if (n.uri) byKey.set(n.uri, n);
      const id = alias.get(n.ref) ?? (n.uri ? alias.get(n.uri) : undefined);
      if (id) {
        // Seed resolved: take its real label and kind.
        const s = nodes.get(id)!;
        if (s.label === labelOf(id)) Object.assign(s, { kind: n.kind || s.kind, label: n.label, short: shortLabel(n.label) });
        alias.set(n.ref, id);
        if (n.uri) alias.set(n.uri, id);
      }
    }
    const seed = seedIds[i]!;
    if (d.root) alias.set(d.root, alias.get(d.root) ?? seed);
    const idOf = (k: string): string | null => {
      const a = alias.get(k);
      if (a) return a;
      const n = byKey.get(k);
      if (!n) return null;
      const id = n.uri ?? n.ref;
      alias.set(n.ref, id);
      if (n.uri) alias.set(n.uri, id);
      if (!nodes.has(id)) nodes.set(id, { id, kind: n.kind, label: n.label, short: shortLabel(n.label), seed: false });
      return id;
    };
    for (const e of d.edges) {
      if (SKIP.has(e.kind)) continue;
      const from = idOf(e.from);
      const to = idOf(e.to);
      if (!from || !to || from === to) continue;
      const key = `${from}\u0000${to}\u0000${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: e.kind });
    }
  });
  return { nodes: [...nodes.values()], edges };
}

/** Parallel edges between the same pair (either direction) become one edge with a count and its kinds. */
export function mergeEdges(edges: RawEdge[]): GEdge[] {
  const out = new Map<string, GEdge>();
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
    let m = out.get(key);
    if (!m) {
      m = { id: `e${out.size}`, from: e.from, to: e.to, kinds: [], count: 0, both: false };
      out.set(key, m);
    }
    if (e.from !== m.from) m.both = true;
    m.count++;
    const k = m.kinds.find((x) => x.kind === e.kind);
    if (k) k.count++;
    else m.kinds.push({ kind: e.kind, count: 1 });
  }
  return [...out.values()];
}

const KIND_PLURAL: Record<string, string> = { feedback: 'requests', work_order: 'work orders', code_range: 'code ranges', code_file: 'files', verification: 'checks' };
export const kindPlural = (k: string, n: number) => (n === 1 ? k.replace(/_/g, ' ') : (KIND_PLURAL[k] ?? `${k.replace(/_/g, ' ')}s`));

export const COLLAPSE_ABOVE = 25;
/** Containers narrower than this (the rail) get the compact candidates and an earlier summary. */
export const NARROW = 520;
/** Node count above which the graph is summarised: about 25 in the main column / fullscreen, 12 in the narrow rail. */
export const collapseThreshold = (avail: number) => (avail < NARROW ? 12 : COLLAPSE_ABOVE);

/**
 * Above `threshold` nodes, the graph is summarised: leaves (non-seed nodes with one neighbour) and nodes two or more
 * hops from the seeds fold, per (anchor, kind), into a group node "+N specs" (anchor: the leaf's neighbour, else the
 * node it was reached from). If that is still too big, the seeds' direct neighbours fold the same way. Groups need
 * `minGroup` members; groups in `expanded` stay open. Edges are re-pointed at the groups and re-merged.
 */
export function collapseLeaves(g: Graph, expanded: ReadonlySet<string>, threshold = COLLAPSE_ABOVE, minGroup = 2): Graph {
  if (g.nodes.length <= threshold) return g;
  const nbrs = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (!nbrs.has(e.from)) nbrs.set(e.from, new Set());
    if (!nbrs.has(e.to)) nbrs.set(e.to, new Set());
    nbrs.get(e.from)!.add(e.to);
    nbrs.get(e.to)!.add(e.from);
  }
  // Undirected BFS from the seeds: hop count and the node each one was first reached from.
  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  const q = g.nodes.filter((n) => n.seed).map((n) => n.id);
  for (const id of q) dist.set(id, 0);
  while (q.length) {
    const id = q.shift()!;
    for (const m of [...(nbrs.get(id) ?? [])].sort()) {
      if (dist.has(m)) continue;
      dist.set(m, dist.get(id)! + 1);
      parent.set(m, id);
      q.push(m);
    }
  }
  // Fold hop by hop, so a node whose anchor was folded joins a group hanging off that anchor's group.
  const fold = (pick: (n: GNode) => boolean) => {
    const repOf = new Map<string, string>();
    const groupNodes: GNode[] = [];
    const levels = [...new Set(g.nodes.map((n) => dist.get(n.id) ?? Infinity))].sort((x, y) => x - y);
    for (const lvl of levels) {
      const groups = new Map<string, { anchor: string; members: GNode[] }>();
      for (const n of g.nodes) {
        if (n.seed || (dist.get(n.id) ?? Infinity) !== lvl || !pick(n)) continue;
        const nb = nbrs.get(n.id);
        const own = nb?.size === 1 ? [...nb][0]! : parent.get(n.id);
        if (!own) continue;
        const anchor = repOf.get(own) ?? own;
        const key = `group:${anchor}:${n.kind}`;
        const grp = groups.get(key) ?? { anchor, members: [] };
        grp.members.push(n);
        groups.set(key, grp);
      }
      for (const [key, { anchor, members }] of groups) {
        if (members.length < minGroup || expanded.has(key)) continue;
        for (const m of members) repOf.set(m.id, key);
        const names = members.slice(0, 8).map((m) => m.short).join(', ') + (members.length > 8 ? `, +${members.length - 8} more` : '');
        groupNodes.push({ id: key, kind: members[0]!.kind, label: names, short: `+${members.length} ${kindPlural(members[0]!.kind, members.length)}`, seed: false, group: { members: members.map((m) => m.id), anchor } });
      }
    }
    return { repOf, groupNodes };
  };
  const isLeaf = (n: GNode) => nbrs.get(n.id)?.size === 1;
  let r = fold((n) => isLeaf(n) || (dist.get(n.id) ?? 2) >= 2);
  if (g.nodes.length - r.repOf.size + r.groupNodes.length > threshold) r = fold(() => true);
  const { repOf, groupNodes } = r;
  if (!groupNodes.length) return g;
  const nodes = [...g.nodes.filter((n) => !repOf.has(n.id)), ...groupNodes];
  // Re-merge: a group's member edges fold onto one edge per neighbour (counts and kinds summed).
  const merged = new Map<string, GEdge>();
  for (const e of g.edges) {
    const from = repOf.get(e.from) ?? e.from;
    const to = repOf.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    let m = merged.get(key);
    if (!m) {
      m = { id: `e${merged.size}`, from, to, kinds: [], count: 0, both: e.both };
      merged.set(key, m);
    } else if (m.from !== from || e.both) m.both = true;
    m.count += e.count;
    for (const k of e.kinds) {
      const x = m.kinds.find((y) => y.kind === k.kind);
      if (x) x.count += k.count;
      else m.kinds.push({ ...k });
    }
  }
  // The summary keeps a tree around the seeds: edges touching a seed and each node's link to where it was reached
  // from; cross links between other nodes are left to "Show all".
  const rep = (id: string) => repOf.get(id) ?? id;
  const seeds = new Set(g.nodes.filter((n) => n.seed).map((n) => n.id));
  const treeOf = (id: string) => {
    const gn = groupNodes.find((x) => x.id === id);
    return gn ? gn.group!.anchor : parent.has(id) ? rep(parent.get(id)!) : undefined;
  };
  const all = [...merged.values()];
  const kept = all.filter((e) => seeds.has(e.from) || seeds.has(e.to) || treeOf(e.from) === e.to || treeOf(e.to) === e.from);
  return { nodes, edges: kept, hiddenEdges: all.length - kept.length };
}

/* ---------- measuring ---------- */

const FONT_PX = 11;
let ctx: CanvasRenderingContext2D | null | undefined;
/** Width of a label in the node font (canvas when available, else an average glyph width). */
export function textWidth(s: string): number {
  if (ctx === undefined) {
    try {
      ctx = typeof document !== 'undefined' && !/jsdom/.test(navigator.userAgent) ? document.createElement('canvas').getContext('2d') : null;
      if (ctx) ctx.font = `500 ${FONT_PX}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    } catch {
      ctx = null;
    }
  }
  return ctx ? ctx.measureText(s).width : s.length * FONT_PX * 0.56;
}

export const NODE_H = 26;
/** Icon + paddings around the label. */
const NODE_CHROME = 8 + 13 + 5 + 10 + 4;

export function nodeWidth(n: GNode, maxLabel: number): number {
  return Math.round(Math.min(Math.max(textWidth(n.short), 24), maxLabel) + NODE_CHROME + (n.seed ? 6 : 0));
}

/**
 * Layer index per node: seeds in the middle; a seed's successors on one side, its predecessors on the other, and
 * nodes further out on the side of the node they were reached from, one layer per hop (edges stay short).
 */
export function partitions(g: Graph): Map<string, number> {
  const d = new Map<string, number>();
  const q: string[] = [];
  for (const n of g.nodes) if (n.seed) { d.set(n.id, 0); q.push(n.id); }
  if (!q.length && g.nodes[0]) { d.set(g.nodes[0].id, 0); q.push(g.nodes[0].id); }
  const adj = new Map<string, { id: string; out: boolean }[]>();
  for (const e of g.edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), { id: e.to, out: true }]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), { id: e.from, out: false }]);
  }
  while (q.length) {
    const id = q.shift()!;
    const di = d.get(id)!;
    // Outgoing first: a node both pointed at and pointing back sits on the successor side.
    for (const { id: m, out } of [...(adj.get(id) ?? [])].sort((a, b) => Number(b.out) - Number(a.out))) {
      if (d.has(m)) continue;
      d.set(m, di === 0 ? (out ? 1 : -1) : di + Math.sign(di));
      q.push(m);
    }
  }
  for (const n of g.nodes) if (!d.has(n.id)) d.set(n.id, 1);
  const min = Math.min(...d.values());
  for (const [k, v] of d) d.set(k, v - min);
  return d;
}

export interface LayoutOpts {
  direction: 'RIGHT' | 'DOWN';
  maxLabel: number;
  compact?: boolean;
  /** Spread wide layers over several rows (narrow containers). */
  stack?: boolean;
}

export async function layoutGraph(g: Graph, o: LayoutOpts): Promise<GraphLayout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const part = partitions(g);
  const sizes = new Map(g.nodes.map((n) => [n.id, { w: nodeWidth(n, o.maxLabel), h: NODE_H }]));
  const right = o.direction === 'RIGHT';
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': o.direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.partitioning.activate': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(right ? (o.compact ? 40 : 56) : 40),
      'elk.layered.spacing.edgeNodeBetweenLayers': '14',
      'elk.spacing.nodeNode': String(right ? 10 : 16),
      'elk.spacing.edgeNode': '10',
      'elk.spacing.edgeEdge': '6',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      ...(o.stack ? { 'elk.layered.layering.strategy': 'MIN_WIDTH', 'elk.layered.layering.minWidth.upperBoundOnWidth': '2', 'elk.layered.layering.minWidth.upperLayerEstimationScalingFactor': '1' } : {}),
    },
    children: g.nodes.map((n) => ({ id: n.id, width: sizes.get(n.id)!.w, height: NODE_H, layoutOptions: { 'elk.partitioning.partition': String(part.get(n.id) ?? 0) } })),
    edges: g.edges.map((e) => {
      // Lay the edge out along the partition order (an edge "against" it would be reversed anyway).
      const fwd = (part.get(e.from) ?? 0) <= (part.get(e.to) ?? 0);
      return { id: e.id, sources: [fwd ? e.from : e.to], targets: [fwd ? e.to : e.from] };
    }),
  };
  const res = await elk.layout(graph);
  const pos = new Map((res.children ?? []).map((c) => [c.id, c]));
  const nodes: PlacedNode[] = g.nodes.map((n) => {
    const c = pos.get(n.id)!;
    return { ...n, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? sizes.get(n.id)!.w, h: c.height ?? NODE_H };
  });
  const edges: PlacedEdge[] = g.edges.map((e) => {
    const r = (res.edges ?? []).find((x) => x.id === e.id) as { sources: string[]; sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[] } | undefined;
    const s = r?.sections?.[0];
    let points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
    // Points run sources -> targets; flip back to the edge's own direction.
    if (r && r.sources[0] !== e.from) points = [...points].reverse();
    return { ...e, points };
  });
  return { width: Math.ceil(res.width ?? 0), height: Math.ceil(res.height ?? 0), direction: o.direction, nodes, edges };
}

/** Lays out a few candidates (direction, label width) and keeps the one that fits `avail` best without shrinking text. */
export async function bestLayout(g: Graph, avail: number): Promise<GraphLayout> {
  const narrow = avail < NARROW;
  const cands: LayoutOpts[] = narrow
    ? [{ direction: 'RIGHT', maxLabel: 112, compact: true }, { direction: 'DOWN', maxLabel: 120 }, { direction: 'DOWN', maxLabel: 110, stack: true }, { direction: 'RIGHT', maxLabel: 84, compact: true }]
    : [{ direction: 'RIGHT', maxLabel: 170 }, { direction: 'DOWN', maxLabel: 150 }, { direction: 'RIGHT', maxLabel: 120, compact: true }];
  let best: GraphLayout | null = null;
  let bestScore = -1;
  for (const [i, c] of cands.entries()) {
    const l = await layoutGraph(g, c);
    const scale = Math.min(1, avail / Math.max(1, l.width));
    // Prefer readable (unscaled) text, then the earlier (roomier) candidate, then a lower box.
    const score = scale * 1000 - i * 30 - l.height / 50;
    if (score > bestScore) {
      best = l;
      bestScore = score;
    }
    if (scale >= 0.98 && i === 0) break;
  }
  return best!;
}
