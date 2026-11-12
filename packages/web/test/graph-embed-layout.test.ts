import { describe, expect, it } from 'vitest';
import { bestLayout, collapseLeaves, layoutGraph, mergeEdges, mergeNeighbors, partitions, type Graph, type GraphLayout, type Neighbors } from '../src/components/refs/graphLayout';

const spec = (id: string) => `mandate://specs/${id}`;
const std = (id: string) => `mandate://standards/${id}`;
const node = (uri: string, kind = 'spec') => ({ uri, ref: uri, kind, label: uri.split('/').pop()! });

function overlaps(l: GraphLayout): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < l.nodes.length; i++)
    for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i]!;
      const b = l.nodes[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([a.id, b.id]);
    }
  return out;
}

/** A seed spec with n neighbouring specs and a few standards. */
function star(n: number): Graph {
  const seed = spec('login-sso');
  const nb: Neighbors = {
    root: seed,
    nodes: [node(seed), ...Array.from({ length: n }, (_, i) => node(spec(`neighbour-with-a-rather-long-name-${i}`))), node(std('security-baseline'), 'standard'), node(std('api-style'), 'standard')],
    edges: [
      ...Array.from({ length: n }, (_, i) => ({ from: spec(`neighbour-with-a-rather-long-name-${i}`), to: seed, kind: 'links_to' })),
      { from: seed, to: std('security-baseline'), kind: 'uses_standard' },
      { from: seed, to: std('security-baseline'), kind: 'inherits_rule' },
      { from: std('security-baseline'), to: seed, kind: 'applies_to' },
      { from: seed, to: std('api-style'), kind: 'uses_standard' },
      { from: seed, to: `${seed}#intro`, kind: 'has_section' },
    ],
  };
  const m = mergeNeighbors([seed], [nb]);
  return { nodes: m.nodes, edges: mergeEdges(m.edges) };
}

describe('graph embed model', () => {
  it('merges neighbourhoods, drops structure edges and marks seeds', () => {
    const g = star(3);
    expect(g.nodes.filter((n) => n.seed).map((n) => n.id)).toEqual([spec('login-sso')]);
    expect(g.nodes).toHaveLength(6);
    expect(g.edges.some((e) => e.kinds.some((k) => k.kind === 'has_section'))).toBe(false);
  });

  it('merges parallel edges of a pair (both directions) into one with a count', () => {
    const g = star(2);
    const toStd = g.edges.filter((e) => [e.from, e.to].includes(std('security-baseline')));
    expect(toStd).toHaveLength(1);
    expect(toStd[0]!.count).toBe(3);
    expect(toStd[0]!.both).toBe(true);
    expect(toStd[0]!.kinds.map((k) => k.kind)).toEqual(['uses_standard', 'inherits_rule', 'applies_to']);
    const api = g.edges.find((e) => e.to === std('api-style'))!;
    expect(api.count).toBe(1);
    expect(api.both).toBe(false);
  });

  it('accepts @mandate: mentions as seeds', () => {
    const m = mergeNeighbors([`@mandate:${spec('a')}`], [{ nodes: [node(spec('a')), node(spec('b'))], edges: [{ from: spec('a'), to: spec('b'), kind: 'depends_on' }] }]);
    expect(m.nodes.find((n) => n.seed)?.id).toBe(spec('a'));
    expect(m.edges).toEqual([{ from: spec('a'), to: spec('b'), kind: 'depends_on' }]);
  });

  it('puts seeds in the middle layer', () => {
    const p = partitions(star(3));
    expect(p.get(spec('neighbour-with-a-rather-long-name-0'))).toBe(0);
    expect(p.get(spec('login-sso'))).toBe(1);
    expect(p.get(std('api-style'))).toBe(2);
  });

  it('does not collapse small graphs', () => {
    const g = star(10);
    expect(collapseLeaves(g, new Set())).toBe(g);
  });

  it('collapses leaf fans of big graphs into "+N" groups that expand', () => {
    const g = star(30);
    const c = collapseLeaves(g, new Set());
    const group = c.nodes.find((n) => n.group)!;
    expect(group.short).toBe('+30 specs');
    expect(group.group!.members).toHaveLength(30);
    expect(c.nodes.length).toBeLessThan(10);
    const e = c.edges.find((x) => x.from === group.id)!;
    expect(e.to).toBe(spec('login-sso'));
    expect(e.count).toBe(30);
    // The standards (2 leaves of a different kind) collapse as their own group.
    expect(c.nodes.find((n) => n.group && n.kind === 'standard')?.short).toBe('+2 standards');
    // Expanded groups stay open.
    const open = collapseLeaves(g, new Set([group.id]));
    expect(open.nodes.some((n) => n.id === group.id)).toBe(false);
    expect(open.nodes.filter((n) => n.kind === 'spec' && !n.seed)).toHaveLength(30);
  });
});

describe('graph embed layout', () => {
  it('lays nodes out without overlaps, in both directions', async () => {
    const g = star(12);
    for (const direction of ['RIGHT', 'DOWN'] as const) {
      const l = await layoutGraph(g, { direction, maxLabel: 120 });
      expect(overlaps(l)).toEqual([]);
      for (const n of l.nodes) {
        expect(n.x + n.w).toBeLessThanOrEqual(l.width);
        expect(n.y + n.h).toBeLessThanOrEqual(l.height);
      }
      for (const e of l.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('routes edges from their source to their target', async () => {
    const l = await layoutGraph(star(2), { direction: 'RIGHT', maxLabel: 120 });
    const e = l.edges.find((x) => x.to === std('api-style'))!;
    const from = l.nodes.find((n) => n.id === e.from)!;
    const to = l.nodes.find((n) => n.id === e.to)!;
    const [a, b] = [e.points[0]!, e.points[e.points.length - 1]!];
    expect(Math.abs(a.x - (from.x + from.w))).toBeLessThan(2);
    expect(Math.abs(b.x - to.x)).toBeLessThan(2);
  });

  it('caps node width and fits a narrow rail better than a wide fan', async () => {
    const l = await bestLayout(star(8), 360);
    expect(overlaps(l)).toEqual([]);
    expect(Math.max(...l.nodes.map((n) => n.w))).toBeLessThanOrEqual(112 + 40);
    expect(l.width).toBeLessThan(560);
  });
});
