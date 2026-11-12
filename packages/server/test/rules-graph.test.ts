/**
 * Rules in the graph: Rule nodes, governs / example_of / inherits_rule / supersedes edges, lifecycle as temporal node
 * state, Cypher labels and types, and equivalence of the graph's "rules for this code range" with `rulesForCode`.
 */
import { globMatch, NODE_LABELS, relTypeOf } from '@mandate/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rulesForCode } from '../src/storage/index.js';
import { knownFiles } from '../src/index/rules.js';
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

describe('rule nodes and edges', () => {
  it('every rule section is a Rule node with level, rationale, scope and check', async () => {
    const m = await storage.model();
    const rules = m.standards.flatMap((s) => s.sections.filter((x) => x.type === 'rule').map((x) => ({ std: s.id, s: x })));
    expect(rules.length).toBeGreaterThan(5);
    const got = await cy('MATCH (r:Rule) RETURN r.ref, r.level, r.rationale, r.scope, labels(r)');
    expect(new Set(got.map((r) => r[0]))).toEqual(new Set(rules.map((r) => `mandate://standards/${r.std}/sections/${r.s.id}`)));
    for (const [ref, level, rationale, scope, labels] of got) {
      const r = rules.find((x) => `mandate://standards/${x.std}/sections/${x.s.id}` === ref)!;
      expect(level).toBe(r.s.level);
      expect(rationale).toBe(r.s.rationale);
      expect(scope ?? null).toEqual(r.s.scope ?? null);
      expect(labels).toEqual(expect.arrayContaining(['Section', 'Rule']));
    }
  });

  it('examples are example_of edges from code to the rule', async () => {
    const m = await storage.model();
    const withEx = m.standards.flatMap((s) => s.sections.filter((x) => x.examples?.length).map((x) => ({ uri: `mandate://standards/${s.id}/sections/${x.id}`, examples: x.examples! })));
    expect(withEx.length).toBeGreaterThan(0);
    for (const r of withEx) {
      const got = await cy('MATCH (c)-[:EXAMPLE_OF]->(r {ref: $r}) RETURN c.ref', { r: r.uri });
      expect(new Set(got.map((x) => x[0]))).toEqual(new Set(r.examples.map((e) => e.replace(/@[0-9a-f]+\//, '/'))));
    }
  });

  it('governs edges match the rules scope over every known code file', async () => {
    const files = rows<{ uri: string; repo: string; path: string }>(
      "SELECT DISTINCT uri, json_extract(props, '$.repo') AS repo, json_extract(props, '$.path') AS path FROM nodes WHERE kind = 'code_file' AND valid_to IS NULL",
    );
    expect(files.length).toBeGreaterThan(5);
    // Known files are the ones specs, standards and components reference (audit findings pointing at other code add no governs edges).
    const known = new Set(knownFiles(await storage.model()).map((k) => `${k.repo}\u0000${k.path}`));
    let governed = 0;
    for (const f of files.filter((x) => known.has(`${x.repo}\u0000${x.path}`))) {
      const scope = rulesForCode({ repo: f.repo, path: f.path }, await storage.model()).filter((h) => h.why.includes('scope')).map((h) => h.uri);
      const edges = (await cy('MATCH (r:Rule)-[:GOVERNS]->(f:CodeFile {ref: $f}) RETURN r.ref', { f: f.uri })).map((x) => x[0]);
      expect(new Set(edges), f.uri).toEqual(new Set(scope));
      governed += edges.length;
    }
    expect(governed).toBeGreaterThan(0);
  });

  it('lifecycle: status is temporal node state; a deprecated standard is superseded_by its successor (supersedes)', async () => {
    const dep = rows<{ uri: string; props: string }>("SELECT uri, props FROM nodes WHERE kind = 'standard' AND valid_to IS NULL AND json_extract(props, '$.status') = 'deprecated'");
    expect(dep.length).toBeGreaterThan(0);
    for (const d of dep) {
      const succ = JSON.parse(d.props).supersededBy as string;
      const n = await fx.index.graphNode({ uri: d.uri });
      expect(n.neighbors.find((g) => g.name === 'superseded_by')?.nodes.map((x) => x.uri)).toEqual([`mandate://standards/${succ}`]);
      // Status changes are node versions: the history has the status as it was.
      const versions = rows<{ status: string; vf: number }>("SELECT json_extract(props, '$.status') AS status, valid_from AS vf FROM nodes WHERE uri = ? AND valid_from > 0 ORDER BY valid_from", d.uri);
      const old = versions.find((v) => v.status !== 'deprecated');
      if (old) {
        const sha = rows<{ sha: string }>('SELECT sha FROM commits WHERE seq = ?', old.vf)[0]!.sha;
        const then = await fx.index.graphNode({ uri: d.uri, at: sha });
        expect(then.node.props.status).toBe(old.status);
        expect(then.neighbors.find((g) => g.name === 'superseded_by')).toBeUndefined();
      }
    }
    // Cypher sees the lifecycle too.
    const c = await cy('MATCH (t:Standard)-[:SUPERSEDES]->(s:Standard) RETURN s.ref, s.status, t.ref');
    expect(c.every((r) => r[1] === 'deprecated')).toBe(true);
  });

  it('labels and types are registered (Rule, GOVERNS, EXAMPLE_OF, INHERITS_RULE, SUPERSEDES)', async () => {
    const s = await fx.index.graphSchema();
    expect(s.labels.map((l) => l.label)).toEqual(expect.arrayContaining(['Rule', ...Object.values(NODE_LABELS)]));
    expect(s.relationships.map((r) => r.type)).toEqual(expect.arrayContaining(['governs', 'example_of', 'inherits_rule', 'supersedes'].map((k) => relTypeOf(k as never))));
    expect(s.labels.find((l) => l.label === 'Rule')!.properties).toEqual(expect.arrayContaining(['level', 'rationale']));
  });
});

describe('rules for a code range: graph == rulesForCode', () => {
  const norm = (hits: { uri: string; level: string; why: string[]; sections: string[] }[]) =>
    hits.map((h) => ({ uri: h.uri, level: h.level, why: [...h.why].sort(), sections: [...h.sections].sort() })).sort((a, b) => a.uri.localeCompare(b.uri));

  it('equal for every code reference, every known file, with and without repo, with and without lines, and for unknown paths', async () => {
    const m = await storage.model();
    const inputs: { repo?: string; path: string; lines?: string }[] = [];
    for (const d of [...m.specs, ...m.standards]) {
      for (const s of d.sections) {
        for (const r of s.refs) {
          inputs.push({ repo: r.repo, path: r.path }, { path: r.path }, ...(r.lines ? [{ repo: r.repo, path: r.path, lines: r.lines }, { repo: r.repo, path: r.path, lines: r.lines.split('-')[0]! }] : []));
        }
      }
    }
    // Unknown files under the rules' globs and languages, and outside them.
    const globs = m.standards.flatMap((s) => [...s.sections.flatMap((x) => x.scope?.paths ?? []), ...s.appliesTo.filter((a) => a.startsWith('path:')).map((a) => a.slice(5))]);
    const samples = ['src/new/thing.ts', 'src/http/routes/new.ts', 'web/src/App.tsx', 'lib/x.py', 'README.md', 'src/auth/new-session.ts', 'docs/a.md', 'app/main.go'];
    for (const p of samples) for (const repo of [undefined, 'app', 'api', 'web']) inputs.push({ ...(repo ? { repo } : {}), path: p });
    expect(samples.some((p) => globs.some((g) => globMatch(g, p)))).toBe(true);
    let checked = 0;
    for (const input of inputs) {
      const graph = await fx.index.graphRulesForCode(input);
      const store = rulesForCode(input, m);
      expect(norm(graph), JSON.stringify(input)).toEqual(norm(store));
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  }, 60_000);

  it('equal for random line ranges (property)', async () => {
    const m = await storage.model();
    const refs = m.specs.flatMap((d) => d.sections.flatMap((s) => s.refs));
    await fc.assert(
      fc.asyncProperty(fc.nat(refs.length - 1), fc.integer({ min: 1, max: 200 }), fc.integer({ min: 0, max: 50 }), async (i, a, len) => {
        const r = refs[i]!;
        const input = { repo: r.repo, path: r.path, lines: `${a}-${a + len}` };
        expect(norm(await fx.index.graphRulesForCode(input))).toEqual(norm(rulesForCode(input, m)));
      }),
      { seed: 7, numRuns: 150 },
    );
  });

  it('rules arrive through the sections that reference the code (inherits_rule)', async () => {
    const m = await storage.model();
    const hit = m.specs.flatMap((d) => d.sections.flatMap((s) => s.refs.map((r) => ({ r })))).map(({ r }) => rulesForCode({ repo: r.repo, path: r.path, lines: r.lines }, m)).flat().find((h) => h.why.includes('section'));
    expect(hit).toBeDefined();
    const q = await cy('MATCH (s:Section)-[:INHERITS_RULE]->(r:Rule {ref: $r}) RETURN count(s)', { r: hit!.uri });
    expect(Number(q[0]![0])).toBeGreaterThan(0);
  });
});
