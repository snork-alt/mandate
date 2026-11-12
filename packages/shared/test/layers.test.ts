/** Architecture layering: longest-path derivation, explicit + derived mixes, cycle guard, upward-edge violations, validation. */
import { describe, expect, it } from 'vitest';
import { componentAncestors, componentFrontmatterSchema, computeLayering, layerLabel, layerSchema, liftEdges, sortLayers, updateComponentSchema } from '../src/index.js';

const e = (from: string, to: string) => ({ from, to });
const layersOf = (r: ReturnType<typeof computeLayering>) => Object.fromEntries([...r.layerOf].map(([k, v]) => [k, v.layer]));

describe('computeLayering', () => {
  it('derives longest-path levels when no component names a layer (dependents above dependencies)', () => {
    // web -> api -> auth -> db, web -> db (the long path wins), billing -> db
    const nodes = ['web', 'api', 'auth', 'db', 'billing'].map((id) => ({ id }));
    const r = computeLayering(nodes, [e('web', 'api'), e('api', 'auth'), e('auth', 'db'), e('web', 'db'), e('billing', 'db')]);
    expect(r.layers.map((l) => l.id)).toEqual(['level-1', 'level-2', 'level-3', 'level-4']);
    expect(r.layers.every((l) => l.derived)).toBe(true);
    expect(layersOf(r)).toEqual({ web: 'level-1', api: 'level-2', auth: 'level-3', billing: 'level-3', db: 'level-4' });
    expect([...r.layerOf.values()].every((v) => v.source === 'derived')).toBe(true);
    expect(r.violations.size).toBe(0);
  });

  it('guards cycles: a cycle collapses into one level and layering terminates', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const r = computeLayering(nodes, [e('a', 'b'), e('b', 'c'), e('c', 'b'), e('c', 'd'), e('d', 'd')]);
    expect(layersOf(r)).toEqual({ a: 'level-1', b: 'level-2', c: 'level-2', d: 'level-3' });
    expect(r.violations.size).toBe(0);
  });

  it('orders explicit layers by the default order (unknown names after, alphabetically)', () => {
    const r = computeLayering(
      [
        { id: 'pg', layer: 'data' },
        { id: 'web', layer: 'ui' },
        { id: 'jobs', layer: 'workers' },
        { id: 'gw', layer: 'api' },
        { id: 'aws', layer: 'infra' },
        { id: 'etl', layer: 'batch' },
      ],
      [],
    );
    expect(r.layers.map((l) => l.id)).toEqual(['ui', 'api', 'data', 'infra', 'batch', 'workers']);
    expect(r.layers.map((l) => l.label)).toEqual(['UI', 'API', 'Data', 'Infra', 'Batch', 'Workers']);
    expect(sortLayers(['data', 'ui'], ['data', 'ui'])).toEqual(['data', 'ui']);
  });

  it('mixes explicit and derived: one layer above the highest dependency, cycles join their named member, sinks at the bottom', () => {
    const r = computeLayering(
      [
        { id: 'web', layer: 'ui' },
        { id: 'gw' }, // depends on svc (service): one layer above it among the used layers = ui
        { id: 'svc', layer: 'service' },
        { id: 'repo' }, // depends on pg (data) -> service
        { id: 'pg', layer: 'data' },
        { id: 'cache' }, // depends on nothing -> bottom
        { id: 'x', layer: 'service' },
        { id: 'y' }, // cycle with x (named service) -> service
        { id: 'top' }, // depends on web (top layer) -> clamped to the top
      ],
      [e('web', 'gw'), e('gw', 'svc'), e('svc', 'repo'), e('repo', 'pg'), e('x', 'y'), e('y', 'x'), e('top', 'web')],
    );
    expect(r.layers.map((l) => l.id)).toEqual(['ui', 'service', 'data']);
    expect(layersOf(r)).toEqual({ web: 'ui', gw: 'ui', svc: 'service', repo: 'service', pg: 'data', cache: 'data', x: 'service', y: 'service', top: 'ui' });
    expect(r.layerOf.get('gw')!.source).toBe('derived');
    expect(r.layerOf.get('svc')!.source).toBe('explicit');
    expect(r.violations.size).toBe(0);
  });

  it('flags upward edges (a lower layer depending on a higher one) as violations', () => {
    const edges = [e('web', 'gw'), e('pg', 'gw'), e('gw', 'pg'), e('gw', 'gw2')];
    const r = computeLayering(
      [
        { id: 'web', layer: 'ui' },
        { id: 'gw', layer: 'api' },
        { id: 'gw2', layer: 'api' },
        { id: 'pg', layer: 'data' },
      ],
      edges,
    );
    expect([...r.violations]).toEqual([1]);
  });

  it('ignores edges to unknown components and handles an empty graph', () => {
    expect(computeLayering([], []).layers).toEqual([]);
    const r = computeLayering([{ id: 'a' }], [e('a', 'gone')]);
    expect(layersOf(r)).toEqual({ a: 'level-1' });
  });
});

describe('containment', () => {
  it('children inherit the parent layer unless they set their own (explicit and derived parents)', () => {
    const r = computeLayering(
      [
        { id: 'billing', layer: 'domain' },
        { id: 'invoices', parent: 'billing' },
        { id: 'pdf', parent: 'invoices' },
        { id: 'ledger', parent: 'billing', layer: 'data' },
        { id: 'web', layer: 'ui' },
      ],
      [e('web', 'billing')],
    );
    expect(layersOf(r)).toEqual({ billing: 'domain', invoices: 'domain', pdf: 'domain', ledger: 'data', web: 'ui' });
    expect(Object.fromEntries([...r.layerOf].map(([k, v]) => [k, v.source]))).toEqual({ billing: 'explicit', invoices: 'inherited', pdf: 'inherited', ledger: 'explicit', web: 'explicit' });
    // Pure derivation: the child takes its parent's derived level, even when its own deps would put it elsewhere.
    const d = computeLayering([{ id: 'app' }, { id: 'db' }, { id: 'part', parent: 'app' }], [e('app', 'db')]);
    expect(layersOf(d)).toEqual({ app: 'level-1', db: 'level-2', part: 'level-1' });
    expect(d.layerOf.get('part')!.source).toBe('inherited');
    // A parent cycle in hand-edited data cannot loop.
    expect(computeLayering([{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }], []).layers).toHaveLength(1);
    expect(componentAncestors('pdf', [{ id: 'billing' }, { id: 'invoices', parent: 'billing' }, { id: 'pdf', parent: 'invoices' }]).map((x) => x.id)).toEqual(['invoices', 'billing']);
    expect(componentAncestors('a', [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }]).map((x) => x.id)).toEqual(['b']);
  });

  it('lifts edges of collapsed groups to the outermost collapsed ancestor, deduplicated with counts', () => {
    const nodes = [{ id: 'billing' }, { id: 'invoices', parent: 'billing' }, { id: 'pdf', parent: 'invoices' }, { id: 'ledger', parent: 'billing' }, { id: 'web' }, { id: 'db' }];
    const edges = [
      e('web', 'invoices'), // 0
      { ...e('pdf', 'db'), violation: true }, // 1
      e('ledger', 'db'), // 2
      e('invoices', 'ledger'), // 3: inside billing
      e('web', 'pdf'), // 4
      e('web', 'billing'), // 5
    ];
    // Nothing collapsed: every edge as is.
    const open = liftEdges(nodes, edges, new Set());
    expect(open.visible.size).toBe(6);
    expect(open.edges.every((x) => !x.lifted && x.edges.length === 1)).toBe(true);
    // invoices collapsed: pdf hidden, its edges lifted to invoices (web -> pdf merges into web -> invoices).
    const inner = liftEdges(nodes, edges, new Set(['invoices']));
    expect([...inner.visible].sort()).toEqual(['billing', 'db', 'invoices', 'ledger', 'web']);
    expect(inner.edges.find((x) => x.from === 'web' && x.to === 'invoices')).toMatchObject({ edges: [0, 4], lifted: true });
    expect(inner.edges.find((x) => x.from === 'invoices' && x.to === 'db')).toMatchObject({ edges: [1], lifted: true, violation: true });
    // billing collapsed (and invoices): everything inside lifts to billing; the internal edge disappears.
    const outer = liftEdges(nodes, edges, new Set(['billing', 'invoices']));
    expect([...outer.visible].sort()).toEqual(['billing', 'db', 'web']);
    expect(outer.repOf.get('pdf')).toBe('billing');
    expect(outer.edges.map((x) => `${x.from}->${x.to}:${x.edges.length}`).sort()).toEqual(['billing->db:2', 'web->billing:3']);
    expect(outer.edges.find((x) => x.to === 'db')!.violation).toBe(true);
  });
});

describe('layer validation', () => {
  it('accepts slugs and rejects anything else', () => {
    for (const ok of ['ui', 'api', 'data-pipeline', 'tier2']) expect(layerSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'UI', 'my layer', '-api', 'api-', 'a--b', '2tier', 'x'.repeat(41), 'api;drop']) expect(layerSchema.safeParse(bad).success, bad).toBe(false);
    expect(layerLabel('data-pipeline')).toBe('Data pipeline');
  });

  it('is an optional component frontmatter field (null removes it on update)', () => {
    expect(componentFrontmatterSchema.parse({ title: 'A', kind: 'service' }).layer).toBeUndefined();
    expect(componentFrontmatterSchema.parse({ title: 'A', kind: 'service', layer: 'api' }).layer).toBe('api');
    expect(componentFrontmatterSchema.safeParse({ title: 'A', kind: 'service', layer: 'Not A Slug' }).success).toBe(false);
    expect(componentFrontmatterSchema.safeParse({ title: 'A', kind: 'service', layer: 3 }).success).toBe(false);
    expect(updateComponentSchema.parse({ layer: null }).layer).toBeNull();
  });
});
