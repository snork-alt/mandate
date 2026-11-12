/**
 * Components in the graph: Component nodes, affects / depends_on / owns / owned_by / follows / applies_to edges, the
 * virtual architecture node, and equivalence with storage (`ownerOf`, `architecture.get` in graph format).
 */
import { buildRef, ownerOf } from '@mandate/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from '../src/storage/index.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
let storage: Storage;
beforeAll(async () => {
  fx = await graphFixture();
  storage = createStorage(fx.git);
}, 120_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
const cy = async (query: string, params: Record<string, unknown> = {}) => (await fx.index.graphQuery({ query, params, limit: 5000 })).rows;
const comp = (id: string) => buildRef({ kind: 'components', id });

describe('component nodes and edges', () => {
  it('every component is a Component node with componentKind, status and owns', async () => {
    const comps = await storage.components.list();
    expect(comps.length).toBeGreaterThan(3);
    const got = await cy('MATCH (c:Component) RETURN c.ref, c.componentKind, c.status, c.owns');
    expect(new Set(got.map((r) => r[0]))).toEqual(new Set(comps.map((c) => comp(c.id))));
    for (const [ref, kind, status, owns] of got) {
      const c = comps.find((x) => comp(x.id) === ref)!;
      expect(kind).toBe(c.kind);
      expect(status).toBe(c.status);
      expect(owns).toEqual(c.owns);
    }
  });

  it('spec sections affect components; component sections depend on components and follow standards', async () => {
    const comps = await storage.components.list();
    const affects = await cy("MATCH (s:Section)-[:AFFECTS]->(c) WHERE s.ref STARTS WITH 'mandate://specs/' RETURN s.ref, c.ref");
    expect(affects.length).toBeGreaterThan(0);
    for (const [, c] of affects) expect(String(c)).toMatch(/^mandate:\/\/components\//);
    const deps = comps.flatMap((c) => c.sections.flatMap((s) => s.links.filter((l) => l.rel === 'depends_on').map((l) => `${comp(c.id)}/sections/${s.id}`)));
    const gotDeps = await cy("MATCH (s:Section)-[l:LINKS_TO]->(t) WHERE l.rel = 'depends_on' AND s.ref STARTS WITH 'mandate://components/' RETURN DISTINCT s.ref");
    expect(new Set(gotDeps.map((r) => r[0]))).toEqual(new Set(deps));
    const follows = comps.flatMap((c) => c.sections.flatMap((s) => s.links.filter((l) => l.rel === 'follows' || l.rel === 'deviates_from').map(() => `${comp(c.id)}/sections/${s.id}`)));
    if (follows.length) {
      const gotF = await cy("MATCH (s:Section)-[l:LINKS_TO]->(t) WHERE l.rel IN ['follows', 'deviates_from'] AND s.ref STARTS WITH 'mandate://components/' RETURN DISTINCT s.ref");
      expect(new Set(gotF.map((r) => r[0]))).toEqual(new Set(follows));
    }
  });

  it('owns edges: component -> known code files inside its globs', async () => {
    const comps = await storage.components.list();
    const owns = rows<{ from_uri: string; to_uri: string }>("SELECT from_uri, to_uri FROM edges WHERE kind = 'owns' AND valid_to IS NULL");
    for (const e of owns) {
      const c = comps.find((x) => comp(x.id) === e.from_uri)!;
      const [, repo, path] = /^mandate:\/\/code\/([^/]+)\/(.+)$/.exec(e.to_uri)!;
      expect(c.owns.some((o) => o.repo === repo && o.paths.some(() => ownerOf(repo, path!, [c]) !== null))).toBe(true);
    }
  });
});

describe('equivalence with storage', () => {
  it('graph ownership equals ownerOf for every code ref and random paths', async () => {
    const comps = await storage.components.list();
    const refs = rows<{ repo: string; path: string }>('SELECT DISTINCT repo, path FROM code_refs');
    expect(refs.length).toBeGreaterThan(5);
    const expectSame = async (repo: string | undefined, path: string) => {
      const want = ownerOf(repo, path, comps);
      const got = await fx.index.graphOwnerOf({ repo, path });
      expect(got ? { c: got.component, g: got.glob } : null, `${repo}:${path}`).toEqual(want ? { c: comp(want.component.id), g: want.glob } : null);
    };
    let owned = 0;
    for (const r of refs) {
      await expectSame(r.repo, r.path);
      if (ownerOf(r.repo, r.path, comps)) owned++;
    }
    expect(owned).toBeGreaterThan(0);
    // owned_by edges on code ranges agree with the file's owner.
    for (const e of rows<{ from_uri: string; to_uri: string }>("SELECT from_uri, to_uri FROM edges WHERE kind = 'owned_by' AND valid_to IS NULL AND from_uri LIKE '%#L%'")) {
      const [, repo, path] = /^mandate:\/\/code\/([^/]+)\/(.+?)#L/.exec(e.from_uri)!;
      expect(comp(ownerOf(repo, path!, comps)!.component.id)).toBe(e.to_uri);
    }
    const repos = [...new Set([...comps.flatMap((c) => c.owns.map((o) => o.repo)), 'nope'])];
    const segs = ['src', 'api', 'auth', 'billing', 'web', 'lib', 'db', 'migrations', 'index.ts', 'x.go', 'README.md'];
    await fc.assert(
      fc.asyncProperty(fc.option(fc.constantFrom(...repos), { nil: undefined }), fc.array(fc.constantFrom(...segs), { minLength: 1, maxLength: 4 }), async (repo, parts) => {
        await expectSame(repo, parts.join('/'));
      }),
      { numRuns: 300 },
    );
  });

  const norm = (edges: { from: string; to: string; section?: string }[], ids = false) =>
    edges.map((e) => `${ids ? comp(e.from) : e.from}|${ids ? comp(e.to) : e.to}|${e.section ?? ''}`).sort();

  it('architecture edges equal architectureGet (graph format) at HEAD and at old commits', async () => {
    const head = await storage.architecture.get({ format: 'graph' });
    const g = await fx.index.graphArchitecture({});
    expect(g.edges.length).toBeGreaterThan(0);
    expect(norm(g.edges)).toEqual(norm(head.edges, true));
    expect([...g.components].sort()).toEqual(head.nodes.map((n) => n.uri).sort());
    // Every mainline commit that touched components/ (the first one included).
    const commits = rows<{ sha: string }>(
      "SELECT DISTINCT c.sha FROM commits c JOIN edges e ON e.kind = 'changed' AND e.from_uri = 'mandate://commits/' || c.sha WHERE c.mainline = 1 AND e.to_uri LIKE 'mandate://components/%' ORDER BY c.seq",
    );
    expect(commits.length).toBeGreaterThan(1);
    for (const { sha } of commits.slice(0, -1)) {
      const old = await storage.architecture.get({ at: sha, format: 'graph' });
      const og = await fx.index.graphArchitecture({ at: sha });
      expect(norm(og.edges), sha).toEqual(norm(old.edges, true));
      expect([...og.components].sort(), sha).toEqual(old.nodes.map((n) => n.uri).sort());
      expect(og.at?.sha).toBe(sha);
    }
  }, 120_000);

  it('focus: the architecture node includes the focused component and its upstream / downstream', async () => {
    const head = await storage.architecture.get({ format: 'graph' });
    for (const n of head.nodes) {
      const want = (await storage.architecture.get({ focus: n.id, format: 'graph' })).nodes.filter((x) => x.focus !== 'other').map((x) => x.uri);
      const got = await fx.index.graphArchitecture({ focus: n.id });
      expect([...got.components].sort(), n.id).toEqual(want.sort());
      const inc = await fx.index.graphNeighbors({ uri: got.ref, direction: 'out', kinds: ['includes'] });
      expect(inc.edges.map((e) => e.to).sort(), n.id).toEqual([...got.components].sort());
    }
  });
});
