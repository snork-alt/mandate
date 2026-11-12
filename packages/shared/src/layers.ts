/**
 * Architecture layering: components sit in ordered horizontal layers (top = closest to the user,
 * bottom = infrastructure). A component either names its layer (`layer` frontmatter) or gets one
 * derived from its `depends_on` edges (longest path: dependents sit above their dependencies).
 * Leaf module: no imports from other files of this package.
 */
import { z } from 'zod';

/** The default top-to-bottom order of well-known layer names; other names sort after these (alphabetically). */
export const DEFAULT_LAYER_ORDER = ['interface', 'ui', 'api', 'service', 'domain', 'data', 'infra'] as const;

/** A layer name: lowercase letters, digits and dashes (e.g. ui, api, service, domain, data, infra). */
export const layerSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'layer: lowercase letters, digits and single dashes, starting with a letter (e.g. ui, api, service, domain, data, infra)');

export interface LayerInfo {
  /** Layer name (explicit) or `level-<n>` (derived, 1 = top). */
  id: string;
  label: string;
  /** True for derived `level-<n>` layers (no component names a layer). */
  derived: boolean;
}

export interface Layering {
  /** Layers top to bottom (only layers with at least one component). */
  layers: LayerInfo[];
  /** Per component: its layer id and whether it was named (explicit), inherited from a parent or derived from depends_on. */
  layerOf: Map<string, { layer: string; source: 'explicit' | 'inherited' | 'derived' }>;
  /** Indexes (into the given edges) of edges pointing upward: a component depending on one in a higher layer. */
  violations: Set<number>;
}

const LABELS: Record<string, string> = { ui: 'UI', api: 'API' };
/** Display label of a layer name (`api` -> `API`, `data-pipeline` -> `Data pipeline`). */
export function layerLabel(id: string): string {
  if (LABELS[id]) return LABELS[id]!;
  const s = id.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Sort layer names by an order (known names first, in order; the rest alphabetically). */
export function sortLayers(names: Iterable<string>, order: readonly string[] = DEFAULT_LAYER_ORDER): string[] {
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i < 0 ? order.length : i;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Strongly connected components (Tarjan, iterative): cycles collapse into one unit for layering. */
function sccs(ids: string[], out: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const comp = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0;
  let count = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      const succ = out.get(top.id) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++]!;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.id, Math.min(low.get(top.id)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]!.id;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.id)!));
      }
      if (low.get(top.id) === index.get(top.id)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.set(w, count);
        } while (w !== top.id);
        count++;
      }
    }
  }
  return comp;
}

/** Containment depth and nearest-first ancestors within the given nodes (cycle-safe). */
function ancestorsOf(id: string, parentOf: Map<string, string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  for (let p = parentOf.get(id); p && !seen.has(p) && parentOf.has(p); p = parentOf.get(p)) {
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Layer the components of an architecture graph.
 * - A component's layer is its own `layer`, else the nearest ancestor's (`parent` containment: inherited).
 * - No component has one: pure longest-path layering on depends_on (sinks at the bottom), layers `level-1..n`.
 * - Some do: the named layers, ordered by `order` (known names first). A component without a layer goes one layer
 *   above its highest dependency (clamped to the top layer), joins the topmost named member of its cycle, or sits
 *   in the bottom layer when it depends on nothing.
 * - Children without a layer of their own then take their parent's (also when the parent's layer was derived).
 * Cycles (only possible in hand-edited or old data) are collapsed into one unit, so layering always terminates.
 * An edge is a violation when it points upward: the dependent sits in a lower layer than its dependency.
 */
export function computeLayering(
  nodes: { id: string; layer?: string | null; parent?: string | null }[],
  edges: { from: string; to: string }[],
  order: readonly string[] = DEFAULT_LAYER_ORDER,
): Layering {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent && known.has(n.parent) && n.parent !== n.id ? n.parent : undefined]));
  const ancestors = new Map(ids.map((id) => [id, ancestorsOf(id, parentOf)]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (e.from !== e.to && known.has(e.from) && known.has(e.to) && !out.get(e.from)!.includes(e.to)) out.get(e.from)!.push(e.to);
  const comp = sccs(ids, out);
  const members = new Map<number, string[]>();
  for (const id of ids) members.set(comp.get(id)!, [...(members.get(comp.get(id)!) ?? []), id]);
  // Dependencies of each unit (outside the unit); the condensed graph is acyclic.
  const unitDeps = new Map<number, Set<number>>();
  for (const [u, ms] of members) unitDeps.set(u, new Set(ms.flatMap((m) => out.get(m)!.map((t) => comp.get(t)!)).filter((t) => t !== u)));
  // Longest path to a sink (height): 0 = depends on nothing.
  const height = new Map<number, number>();
  const heightOf = (u: number): number => {
    const h = height.get(u);
    if (h !== undefined) return h;
    const stack: { u: number; done: boolean }[] = [{ u, done: false }];
    while (stack.length) {
      const top = stack.pop()!;
      if (height.has(top.u)) continue;
      const deps = [...unitDeps.get(top.u)!];
      if (top.done) {
        height.set(top.u, deps.length ? Math.max(...deps.map((d) => height.get(d)!)) + 1 : 0);
        continue;
      }
      stack.push({ u: top.u, done: true });
      for (const d of deps) if (!height.has(d)) stack.push({ u: d, done: false });
    }
    return height.get(u)!;
  };
  const own = new Map(nodes.filter((n) => n.layer).map((n) => [n.id, n.layer!]));
  // Named layers: own, else the nearest ancestor's.
  const named = new Map<string, string>();
  const source = new Map<string, 'explicit' | 'inherited' | 'derived'>();
  for (const id of ids) {
    if (own.has(id)) {
      named.set(id, own.get(id)!);
      source.set(id, 'explicit');
      continue;
    }
    const a = ancestors.get(id)!.find((x) => own.has(x));
    if (a) {
      named.set(id, own.get(a)!);
      source.set(id, 'inherited');
    } else source.set(id, 'derived');
  }
  // Children without a named layer take their parent's band (ancestors first).
  const inherit = (bandOf: Map<string, number>) => {
    for (const id of [...ids].sort((a, b) => ancestors.get(a)!.length - ancestors.get(b)!.length)) {
      const p = parentOf.get(id);
      if (p && source.get(id) === 'derived') {
        bandOf.set(id, bandOf.get(p)!);
        source.set(id, 'inherited');
      }
    }
  };

  const layerOf = new Map<string, { layer: string; source: 'explicit' | 'inherited' | 'derived' }>();
  let layers: LayerInfo[];
  if (!named.size) {
    const max = Math.max(-1, ...[...members.keys()].map(heightOf));
    const level = new Map(ids.map((id) => [id, max - heightOf(comp.get(id)!)]));
    inherit(level);
    const levels = [...new Set(level.values())].sort((a, b) => a - b);
    const name = (lvl: number) => `level-${levels.indexOf(lvl) + 1}`;
    for (const id of ids) layerOf.set(id, { layer: name(level.get(id)!), source: source.get(id)! });
    layers = levels.map((l) => ({ id: name(l), label: `Level ${levels.indexOf(l) + 1}`, derived: true }));
  } else {
    const names = sortLayers(named.values(), order);
    const idx = new Map(names.map((n, i) => [n, i]));
    const bandOf = new Map<string, number>();
    for (const [id, l] of named) bandOf.set(id, idx.get(l)!);
    // Dependencies first (increasing height), so a derived unit's dependencies already have a band.
    const units = [...members.keys()].sort((a, b) => heightOf(a) - heightOf(b));
    for (const u of units) {
      const ms = members.get(u)!;
      const derived = ms.filter((m) => !named.has(m));
      if (!derived.length) continue;
      const fixed = ms.filter((m) => named.has(m)).map((m) => bandOf.get(m)!);
      const deps = ms.flatMap((m) => out.get(m)!).filter((t) => comp.get(t) !== u).map((t) => bandOf.get(t)!);
      const band = fixed.length ? Math.min(...fixed) : deps.length ? Math.max(0, Math.min(...deps) - 1) : names.length - 1;
      for (const m of derived) bandOf.set(m, band);
    }
    inherit(bandOf);
    for (const id of ids) layerOf.set(id, { layer: names[bandOf.get(id)!]!, source: source.get(id)! });
    const used = new Set([...layerOf.values()].map((v) => v.layer));
    layers = names.filter((n) => used.has(n)).map((n) => ({ id: n, label: layerLabel(n), derived: false }));
  }

  const pos = new Map(layers.map((l, i) => [l.id, i]));
  const violations = new Set<number>();
  edges.forEach((e, i) => {
    const a = layerOf.get(e.from);
    const b = layerOf.get(e.to);
    if (a && b && pos.get(a.layer)! > pos.get(b.layer)!) violations.add(i);
  });
  return { layers, layerOf, violations };
}

/** An edge of the visible graph: original edges between visible nodes, or lifted to the collapsed groups holding their ends. */
export interface LiftedEdge {
  from: string;
  to: string;
  /** Indexes of the original edges it stands for (distinct). */
  edges: number[];
  /** True when at least one end was lifted to a collapsed ancestor. */
  lifted: boolean;
  violation: boolean;
}

/**
 * Collapse containment groups: nodes inside a collapsed group are hidden, and their edges are lifted to the outermost
 * collapsed ancestor (deduplicated per pair, with the original edges counted; edges inside one group disappear).
 */
export function liftEdges(
  nodes: { id: string; parent?: string | null }[],
  edges: { from: string; to: string; violation?: boolean }[],
  collapsed: ReadonlySet<string>,
): { visible: Set<string>; repOf: Map<string, string>; edges: LiftedEdge[] } {
  const known = new Set(nodes.map((n) => n.id));
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent && known.has(n.parent) && n.parent !== n.id ? n.parent : undefined]));
  const repOf = new Map<string, string>();
  for (const n of nodes) {
    // Outermost collapsed ancestor (not the node itself: a collapsed group is still shown, as a card).
    const chain = ancestorsOf(n.id, parentOf);
    const outer = [...chain].reverse().find((a) => collapsed.has(a));
    repOf.set(n.id, outer ?? n.id);
  }
  const visible = new Set(nodes.filter((n) => repOf.get(n.id) === n.id).map((n) => n.id));
  const byKey = new Map<string, LiftedEdge>();
  edges.forEach((e, i) => {
    const a = repOf.get(e.from);
    const b = repOf.get(e.to);
    if (!a || !b || a === b) return;
    const key = `${a}\u0000${b}`;
    const lifted = a !== e.from || b !== e.to;
    const cur = byKey.get(key);
    if (cur) {
      cur.edges.push(i);
      cur.lifted ||= lifted;
      cur.violation ||= !!e.violation;
    } else byKey.set(key, { from: a, to: b, edges: [i], lifted, violation: !!e.violation });
  });
  return { visible, repOf, edges: [...byKey.values()] };
}
