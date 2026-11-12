/**
 * Vertical layered layout of the architecture: ELK `layered` (direction DOWN, orthogonal edges, hierarchy included)
 * with one partition per row of top-level nodes, so every layer is a contiguous horizontal band (top = closest to the
 * user). Containing components are compound nodes with their children inside; collapsed ones are plain cards and
 * their children's edges are lifted to them (`liftEdges`).
 */
import { liftEdges, type ArchitectureEdge, type ArchitectureGraph, type ArchitectureNode, type LiftedEdge } from '@mandate/shared';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';

export const NODE_W = 236;
export const NODE_H = 86;
/** Left gutter for the layer labels. */
export const GUTTER = 136;
/** Group header height (title row above the children). */
export const GROUP_HEAD = 46;
const PAD = 26;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Band {
  id: string;
  label: string;
  derived: boolean;
  top: number;
  height: number;
  count: number;
}
export interface PlacedNode {
  n: ArchitectureNode;
  /** Absolute box (flow coordinates). */
  abs: Box;
  /** Position relative to the visible parent group (React Flow `parentId`), or absolute for top-level nodes. */
  rel: { x: number; y: number };
  parent?: string;
  /** Expanded group (children drawn inside) or collapsed group (children hidden). */
  group: 'open' | 'collapsed' | null;
  /** Descendants hidden in a collapsed group. */
  hidden: number;
}
export interface PlacedEdge {
  id: string;
  lifted: LiftedEdge;
  /** The original edges it stands for. */
  edges: ArchitectureEdge[];
  route: { x: number; y: number }[];
}
export interface Layout {
  width: number;
  height: number;
  /** Parents before children (React Flow order). */
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  bands: Band[];
}

/** Groups collapsed by default: containing components nested inside another one (deep trees start folded). */
export function defaultCollapsed(g: Pick<ArchitectureGraph, 'nodes'>): Set<string> {
  const ids = new Set(g.nodes.map((n) => n.id));
  return new Set(g.nodes.filter((n) => n.children.length && n.parent && ids.has(n.parent)).map((n) => n.id));
}

/**
 * Row of each top-level node: its layer's band offset plus a sub-row for dependencies inside the same layer
 * (longest path over intra-layer edges, bounded so a cycle cannot loop).
 */
export function rowsOf(layers: { id: string }[], nodes: { id: string; layer: string }[], edges: { from: string; to: string }[]): Map<string, number> {
  const layerIdx = new Map(layers.map((l, i) => [l.id, i]));
  const band = new Map(nodes.map((n) => [n.id, layerIdx.get(n.layer) ?? layers.length]));
  const sub = new Map(nodes.map((n) => [n.id, 0]));
  const intra = edges.filter((e) => e.from !== e.to && band.has(e.from) && band.get(e.from) === band.get(e.to));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of intra) {
      // The dependency sits below its dependent.
      if (sub.get(e.to)! < sub.get(e.from)! + 1 && sub.get(e.from)! + 1 < nodes.length) {
        sub.set(e.to, sub.get(e.from)! + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const depth = new Map<number, number>();
  for (const n of nodes) depth.set(band.get(n.id)!, Math.max(depth.get(band.get(n.id)!) ?? 0, sub.get(n.id)! + 1));
  const offset = new Map<number, number>();
  let acc = 0;
  for (const b of [...depth.keys()].sort((a, c) => a - c)) {
    offset.set(b, acc);
    acc += depth.get(b)!;
  }
  return new Map(nodes.map((n) => [n.id, offset.get(band.get(n.id)!)! + sub.get(n.id)!]));
}

/** Rounded orthogonal path through points (corner radius r). */
export function roundedPath(pts: { x: number; y: number }[], r = 10): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    const k = Math.min(r, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const a = { x: c.x + (Math.sign(p.x - c.x) * k || 0), y: c.y + (Math.sign(p.y - c.y) * k || 0) };
    const b = { x: c.x + (Math.sign(n.x - c.x) * k || 0), y: c.y + (Math.sign(n.y - c.y) * k || 0) };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last.x},${last.y}`;
}

/** Midpoint of the longest segment of a polyline (edge count pills). */
export function midOf(pts: { x: number; y: number }[]): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let len = -1;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (l > len) {
      len = l;
      best = { x: (pts[i]!.x + pts[i - 1]!.x) / 2, y: (pts[i]!.y + pts[i - 1]!.y) / 2 };
    }
  }
  return best;
}

export async function layoutArchitecture(g: ArchitectureGraph, collapsed: ReadonlySet<string>): Promise<Layout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const lifted = liftEdges(g.nodes, g.edges, collapsed);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const shown = g.nodes.filter((n) => lifted.visible.has(n.id));
  const parentOf = (n: ArchitectureNode) => (n.parent && lifted.visible.has(n.parent) ? n.parent : undefined);
  const kids = new Map<string, ArchitectureNode[]>();
  for (const n of shown) {
    const p = parentOf(n);
    if (p) kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const top = shown.filter((n) => !parentOf(n));
  const topOf = (id: string): string => {
    let cur = byId.get(id)!;
    while (parentOf(cur)) cur = byId.get(parentOf(cur)!)!;
    return cur.id;
  };
  const rows = rowsOf(
    g.layers,
    top,
    lifted.edges.map((e) => ({ from: topOf(e.from), to: topOf(e.to) })).filter((e) => e.from !== e.to),
  );
  const hiddenCount = (id: string) => g.nodes.filter((n) => n.id !== id && lifted.repOf.get(n.id) === id).length;
  const elkNode = (n: ArchitectureNode): ElkNode => {
    const children = kids.get(n.id);
    const partition: Record<string, string> = rows.has(n.id) ? { 'elk.partitioning.partition': String(rows.get(n.id)) } : {};
    if (!children?.length) return { id: n.id, width: NODE_W, height: NODE_H, layoutOptions: partition };
    return {
      id: n.id,
      layoutOptions: { ...partition, 'elk.padding': `[top=${GROUP_HEAD + 10},left=16,bottom=16,right=16]`, 'elk.layered.spacing.nodeNodeBetweenLayers': '44', 'elk.spacing.nodeNode': '24' },
      children: children.map(elkNode),
    };
  };
  const isAncestor = (a: string, b: string) => {
    for (let c = parentOf(byId.get(b)!); c; c = parentOf(byId.get(c)!)) if (c === a) return true;
    return false;
  };
  // Edges between a group and its own descendant are not routed by ELK (drawn as a smooth step instead).
  const edges: ElkExtendedEdge[] = lifted.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !isAncestor(e.from, e.to) && !isAncestor(e.to, e.from))
    .map(({ e, i }) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.json.edgeCoords': 'ROOT',
      'elk.partitioning.activate': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.layered.spacing.edgeNodeBetweenLayers': '22',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '12',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': `[top=${PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
    },
    children: top.map(elkNode),
    edges,
  };
  const res = await elk.layout(graph);
  const placed: PlacedNode[] = [];
  const walk = (e: ElkNode, ox: number, oy: number, parent?: string) => {
    const n = byId.get(e.id)!;
    const abs = { x: ox + (e.x ?? 0), y: oy + (e.y ?? 0), w: e.width ?? NODE_W, h: e.height ?? NODE_H };
    const open = !!e.children?.length;
    const hidden = open ? 0 : hiddenCount(n.id);
    placed.push({ n, abs, rel: parent ? { x: e.x ?? 0, y: e.y ?? 0 } : { x: abs.x, y: abs.y }, ...(parent ? { parent } : {}), group: open ? 'open' : hidden ? 'collapsed' : null, hidden });
    for (const c of e.children ?? []) walk(c, abs.x, abs.y, n.id);
  };
  for (const c of res.children ?? []) walk(c, GUTTER, 0);
  const routes = new Map<string, { x: number; y: number }[]>();
  const collect = (e: ElkNode) => {
    for (const x of e.edges ?? []) {
      const s = x.sections?.[0];
      if (s) routes.set(x.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: GUTTER + p.x, y: p.y })));
    }
    for (const c of e.children ?? []) collect(c);
  };
  collect(res);
  const placedEdges: PlacedEdge[] = lifted.edges.map((l, i) => ({ id: `e${i}`, lifted: l, edges: l.edges.map((k) => g.edges[k]!), route: routes.get(`e${i}`) ?? [] }));
  const height = res.height ?? 0;
  const boxOf = new Map(placed.map((p) => [p.n.id, p.abs]));
  // Bands: the vertical extent of each layer's top-level nodes, split halfway between neighbouring layers.
  const extents = g.layers
    .map((l) => {
      const ys = top.filter((n) => n.layer === l.id).map((n) => boxOf.get(n.id)).filter((b): b is Box => !!b);
      return ys.length ? { l, top: Math.min(...ys.map((b) => b.y)), bottom: Math.max(...ys.map((b) => b.y + b.h)), count: shown.filter((n) => n.layer === l.id).length } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const bands: Band[] = extents.map((x, i) => {
    const t = i === 0 ? 0 : (extents[i - 1]!.bottom + x.top) / 2;
    const b = i === extents.length - 1 ? height : (x.bottom + extents[i + 1]!.top) / 2;
    return { id: x.l.id, label: x.l.label, derived: x.l.derived, top: t, height: b - t, count: x.count };
  });
  return { width: GUTTER + (res.width ?? 0), height, nodes: placed, edges: placedEdges, bands };
}
