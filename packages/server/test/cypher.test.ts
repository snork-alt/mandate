import { DERIVED_LABELS, EDGE_KINDS, NODE_LABELS, relTypeOf } from '@mandate/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CypherRunner, explainQuery } from '../src/index/cypher/index.js';
import { CypherError, parseCypher } from '../src/index/cypher/parser.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
beforeAll(async () => {
  fx = await graphFixture();
}, 120_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const SEED = 4242;
const report: string[] = [];
const run = (query: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => fx.index.graphQuery({ query, params, ...extra });
const col = async (query: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => (await run(query, params, extra)).rows.map((r) => r[0]);
const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];

/* ------------------------------------------------------------------ parser */

describe('parser', () => {
  const ok = [
    'MATCH (n) RETURN n',
    'MATCH (n:Spec|Standard {ref: $r}) RETURN n.ref AS ref',
    'MATCH (a)-[r:HAS_SECTION|USES_STANDARD]->(b) RETURN type(r), b',
    'MATCH (a)<-[:TARGETS]-(f) RETURN f',
    'MATCH (a)-[]-(b) RETURN DISTINCT a, b',
    'MATCH (a)-->(b)<--(c) RETURN c',
    'MATCH p = (a)-[*1..3]->(b) RETURN nodes(p), relationships(p), length(p)',
    'MATCH (a)-[*]->(b) RETURN b',
    'MATCH (a)-[*2]->(b) RETURN b',
    'OPTIONAL MATCH (a:Spec) RETURN a',
    "MATCH (a) WHERE a.title =~ '(?i).*login.*' AND NOT a.status IN ['done'] OR a.x IS NULL RETURN a",
    "MATCH (a) WHERE a.ref STARTS WITH 'mandate://specs' AND a.ref ENDS WITH 'sso' AND a.ref CONTAINS 'log' RETURN a",
    'MATCH (a) WHERE EXISTS { (a)-[:USES_STANDARD]->(:Standard) } RETURN a',
    'MATCH (a) WITH a, count(*) AS n WHERE n > 1 RETURN a ORDER BY n DESC SKIP 1 LIMIT 2',
    'UNWIND [1, 2, 3] AS x RETURN x, x * 2 AS y',
    'MATCH (a) RETURN count(DISTINCT a), collect(a.ref), min(a.ref), max(a.ref), sum(1), avg(1)',
    "MATCH (a) RETURN labels(a), id(a), coalesce(a.x, 'none'), toLower(a.label), size(a.label)",
    'MATCH (a) RETURN *',
    '// comment\nMATCH (a) /* block */ RETURN a;',
  ];
  it.each(ok)('parses %s', (q) => expect(() => parseCypher(q)).not.toThrow());

  const bad: [string, RegExp][] = [
    ['CREATE (n) RETURN n', /unsupported: CREATE.*writes are not allowed/],
    ['MATCH (n) MERGE (m) RETURN n', /unsupported: MERGE/],
    ['MATCH (n) DELETE n RETURN n', /unsupported: DELETE/],
    ['MATCH (n) SET n.x = 1 RETURN n', /unsupported: SET/],
    ['CALL db.labels() YIELD label RETURN label', /unsupported: CALL/],
    ['MATCH p = shortestPath((a)-[*]-(b)) RETURN p', /shortestPath/],
    ['MATCH (a)-[*1..7]->(b) RETURN b', /limited to 6 hops/],
    ['MATCH (n) RETURN [x IN [1,2] | x]', /list comprehensions/],
    ['MATCH (n) RETURN CASE WHEN true THEN 1 END', /CASE/],
    ['MATCH (n) RETURN n; MATCH (m) RETURN m', /one statement/],
    ['MATCH (n) RETURN lenght(n)', /unknown function 'lenght'.*did you mean 'length'/],
    ['MATCH (n)', /must end with RETURN/],
    ['MATCH (n:A:B) RETURN n', /multiple labels with ":"/],
    ['MATCH (n) WHERE exists(n.x) RETURN n', /exists\(property\)/],
    ["MATCH (n) RETURN 'unterminated", /unterminated string/],
  ];
  it.each(bad)('rejects %s', (q, re) => {
    let err: unknown;
    try {
      parseCypher(q);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CypherError);
    expect((err as Error).message).toMatch(re);
    expect((err as CypherError).pos ?? (err as CypherError).message).toBeTruthy();
  });

  it('reports the position', () => {
    try {
      parseCypher('MATCH (n)\nRETURN lenght(n)');
    } catch (e) {
      expect((e as CypherError).pos).toMatchObject({ line: 2, column: 8 });
    }
  });
});

/* ------------------------------------------------------------------ constructs */

describe('compiler and runtime: every supported construct', () => {
  it('labels, properties, parameters and refs as keys (copied forms included)', async () => {
    const r = await run('MATCH (s:Spec {ref: $r}) RETURN s, s.ref, s.title, s.status', { r: '@mandate:mandate://specs/login-sso' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]![0]).toMatchObject({ ref: 'mandate://specs/login-sso', kind: 'spec', label: expect.any(String), props: expect.any(Object) });
    expect(r.rows[0]![1]).toBe('mandate://specs/login-sso');
    expect(r.columns).toEqual(['s', 's.ref', 's.title', 's.status']);
    // Literal refs canonicalise too.
    expect(await col("MATCH (s {ref: 'mandate://specs/login-sso'}) RETURN s.ref")).toEqual(['mandate://specs/login-sso']);
    // Multiple labels and derived labels.
    const both = await col('MATCH (n:Spec|Standard) RETURN DISTINCT labels(n)[0] AS l ORDER BY l');
    expect(both).toEqual(['Spec', 'Standard']);
    const acc = await col('MATCH (a:AcceptanceSection) RETURN labels(a)');
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.every((l) => (l as string[]).includes('AcceptanceSection') && (l as string[]).includes('Section'))).toBe(true);
  });

  it('directions, types, relationship properties and functions', async () => {
    const out = await run("MATCH (d {ref: 'mandate://specs/login-sso'})-[r:HAS_SECTION]->(s) RETURN type(r), r.ord, s.ref ORDER BY r.ord");
    expect(out.rows.every((x) => x[0] === 'HAS_SECTION')).toBe(true);
    expect(out.rows.map((x) => x[1])).toEqual([...out.rows.map((x) => x[1])].sort((a, b) => Number(a) - Number(b)));
    const inn = await col("MATCH (s {ref: 'mandate://specs/login-sso/sections/callback'})<-[:HAS_SECTION]-(d) RETURN d.ref");
    expect(inn).toEqual(['mandate://specs/login-sso']);
    const und = await col("MATCH (s {ref: 'mandate://specs/login-sso/sections/callback'})-[:HAS_SECTION]-(d) RETURN d.ref");
    expect(und).toEqual(['mandate://specs/login-sso']);
    const follows = await run("MATCH (s)-[l:FOLLOWS]->(t) RETURN l.rel, type(l) LIMIT 1");
    if (follows.rows.length) expect(follows.rows[0]).toEqual(['follows', 'LINKS_TO']);
    const rel = await run("MATCH (d {ref: 'mandate://specs/login-sso'})-[r:HAS_SECTION]->() RETURN r LIMIT 1");
    expect(rel.rows[0]![0]).toMatchObject({ type: 'HAS_SECTION', from: 'mandate://specs/login-sso', to: expect.stringContaining('/sections/') });
  });

  it('WHERE operators: comparisons, boolean logic, IN, string predicates, regex, IS NULL, EXISTS', async () => {
    const specs = await col("MATCH (s:Spec) WHERE s.status IN ['in_progress', 'done'] AND NOT s.ref ENDS WITH 'x' RETURN s.ref ORDER BY s.ref");
    const viaSql = rows<{ uri: string }>("SELECT uri FROM docs WHERE kind = 'spec' AND status IN ('in_progress', 'done') ORDER BY uri").map((r) => r.uri);
    expect(specs).toEqual(viaSql);
    expect(await col("MATCH (s:Spec) WHERE s.title =~ '(?i).*sso.*' RETURN s.ref")).toEqual(['mandate://specs/login-sso']);
    expect(await col("MATCH (s:Spec) WHERE s.ref STARTS WITH 'mandate://specs/login' AND s.title CONTAINS 'SSO' RETURN s.ref")).toEqual(['mandate://specs/login-sso']);
    const noRepo = await col('MATCH (s:Spec) WHERE s.repo IS NULL RETURN count(s)');
    expect(noRepo[0]).toBe(rows<{ n: number }>("SELECT COUNT(*) AS n FROM docs WHERE kind = 'spec' AND repo IS NULL")[0]!.n);
    const users = await col('MATCH (s:Spec) WHERE EXISTS { (s)-[:USES_STANDARD]->(:Standard) } RETURN s.ref ORDER BY s.ref');
    const usersSql = rows<{ u: string }>("SELECT DISTINCT from_uri AS u FROM edges WHERE kind = 'uses_standard' AND valid_to IS NULL AND from_uri NOT LIKE '%/sections/%' AND from_uri LIKE 'mandate://specs/%' ORDER BY u").map((r) => r.u);
    expect(users).toEqual(usersSql);
    expect(await col('MATCH (s:Spec) WHERE (1 = 1 XOR 1 = 2) AND s.ref = $r RETURN s.ref', { r: 'mandate://specs/login-sso' })).toHaveLength(1);
  });

  it('WITH, aggregation, ORDER BY, SKIP, LIMIT, DISTINCT, UNWIND, OPTIONAL MATCH', async () => {
    const counts = await run('MATCH (d:Spec)-[:HAS_SECTION]->(s) WITH d, count(s) AS n WHERE n >= 2 RETURN d.ref, n ORDER BY n DESC, d.ref SKIP 0 LIMIT 3');
    expect(counts.rows.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < counts.rows.length; i++) expect(Number(counts.rows[i - 1]![1])).toBeGreaterThanOrEqual(Number(counts.rows[i]![1]));
    const agg = await run("MATCH (d {ref: 'mandate://specs/login-sso'})-[:HAS_SECTION]->(s) RETURN count(*), count(DISTINCT s), collect(s.ref), min(s.ref), max(s.ref)");
    const secs = rows<{ uri: string }>("SELECT uri FROM sections WHERE doc_uri = 'mandate://specs/login-sso' ORDER BY uri").map((r) => r.uri);
    expect(agg.rows[0]![0]).toBe(secs.length);
    expect(new Set(agg.rows[0]![2] as string[])).toEqual(new Set(secs));
    expect(agg.rows[0]![3]).toBe(secs[0]);
    expect(agg.rows[0]![4]).toBe(secs.at(-1));
    const collected = await run("MATCH (d {ref: 'mandate://specs/login-sso'})-[:HAS_SECTION]->(s) WITH collect(s) AS ss UNWIND ss AS x RETURN x.ref ORDER BY x.ref");
    expect(collected.rows.map((r) => r[0])).toEqual(secs);
    const nodes = await run("MATCH (d {ref: 'mandate://specs/login-sso'})-[:HAS_SECTION]->(s) RETURN collect(s) AS ss");
    expect((nodes.rows[0]![0] as { ref: string }[]).map((n) => n.ref).sort()).toEqual(secs);
    const unwind = await run('UNWIND [3, 1, 2] AS x RETURN x, x + 1 AS y ORDER BY x');
    expect(unwind.rows).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    const opt = await run("MATCH (s:Spec) OPTIONAL MATCH (s)-[:DEPENDS_ON]->(d:Spec) RETURN s.ref, count(d) AS deps ORDER BY s.ref");
    expect(opt.rows.length).toBe(rows<{ n: number }>("SELECT COUNT(*) AS n FROM docs WHERE kind = 'spec'")[0]!.n);
    expect(await col('MATCH (s:Section) RETURN DISTINCT s.type ORDER BY s.type')).toEqual(rows<{ t: string }>('SELECT DISTINCT type AS t FROM sections ORDER BY t').map((r) => r.t));
  });

  it('variable-length relationships and named paths', async () => {
    const p = await run("MATCH p = (y:Symbol {ref: 'mandate://symbols/SessionStore.create'})-[:MENTIONS_SYMBOL|HAS_SECTION|LINKS_TO|APPLIES_TO|USES_STANDARD*1..4]-(s:Standard {ref: 'mandate://standards/security-baseline'}) RETURN p, length(p) AS n, nodes(p) AS ns, relationships(p) AS rs ORDER BY n LIMIT 1");
    expect(p.rows).toHaveLength(1);
    const [path, n, ns, rs] = p.rows[0]! as [unknown[], number, { ref: string }[], { type: string }[]];
    expect(path.length).toBe(2 * n + 1);
    expect(ns[0]!.ref).toBe('mandate://symbols/SessionStore.create');
    expect(ns.at(-1)!.ref).toBe('mandate://standards/security-baseline');
    expect(rs).toHaveLength(n);
    // Path from the right-anchored side keeps left-to-right order.
    const r = await run("MATCH p = (x)-[:HAS_SECTION*1]->(s {ref: 'mandate://specs/login-sso/sections/callback'}) RETURN nodes(p)");
    expect((r.rows[0]![0] as { ref: string }[]).map((x) => x.ref)).toEqual(['mandate://specs/login-sso', 'mandate://specs/login-sso/sections/callback']);
  });

  it('excerpts are only reachable when bound from a reference', async () => {
    const ex = await run('MATCH (x {ref: $r})-[:EXCERPT_OF]->(s) RETURN x.kind, s.ref', { r: 'mandate://specs/login-sso/sections/callback#L70-L71' });
    expect(ex.rows).toEqual([['excerpt', 'mandate://specs/login-sso/sections/callback']]);
    expect(await col('MATCH (x:Excerpt) RETURN count(x)')).toEqual([0]);
  });

  it('versioned references and `at` read the graph as it was', async () => {
    const first = rows<{ sha: string; seq: number }>(
      "SELECT sha, point AS seq FROM versions WHERE of_uri = 'mandate://specs/legacy-xml-export' ORDER BY abs(point) LIMIT 1",
    )[0]!;
    expect(await col("MATCH (s:Spec {ref: 'mandate://specs/legacy-xml-export'}) RETURN s.ref")).toEqual([]);
    expect(await col("MATCH (s:Spec {ref: 'mandate://specs/legacy-xml-export'}) RETURN s.ref", {}, { at: first.sha })).toEqual(['mandate://specs/legacy-xml-export']);
    const viaRef = await run("MATCH (s:Spec {ref: 'mandate://specs/legacy-xml-export'}) RETURN s.ref", {}, { at: `mandate://specs/legacy-xml-export@${first.sha.slice(0, 7)}` });
    expect(viaRef.at?.sha).toBe(first.sha);
    expect(viaRef.rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ equivalence */

describe('equivalence with the navigation API', () => {
  const ALL = [...EDGE_KINDS];
  /** Endpoints Cypher can bind: nodes that exist (ghosts: earlier mainline state; side commits: their snapshot). */
  const existing = (uris: string[], seq?: number) =>
    uris.filter((u) =>
      seq === undefined
        ? rows("SELECT 1 FROM nodes WHERE uri = ? AND source IS NOT 'snapshot'", u).length
        : seq > 0
          ? rows("SELECT 1 FROM nodes WHERE uri = ? AND valid_from <= ? AND source IS NOT 'snapshot'", u, seq).length
          : rows('SELECT 1 FROM nodes WHERE uri = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)', u, seq, seq).length,
    );
  const roots = () => rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE valid_to IS NULL AND kind NOT IN ('code_file', 'code_range')").map((r) => r.uri);

  it('(a {ref})-[t]->(b) equals neighbors(out) and <- equals neighbors(in)', async () => {
    const all = roots();
    let cases = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(all.length - 1), fc.boolean(), async (i, outward) => {
        const r = all[i]!;
        const nav = await fx.index.graphNeighbors({ uri: r, direction: outward ? 'out' : 'in', kinds: ALL, limit: 500 });
        const cy = await col(outward ? 'MATCH (a {ref: $r})-[t]->(b) RETURN DISTINCT b.ref' : 'MATCH (a {ref: $r})<-[t]-(b) RETURN DISTINCT b.ref', { r }, { limit: 5000 });
        expect(new Set(cy), `${r} ${outward ? 'out' : 'in'}`).toEqual(new Set(existing(nav.nodes.map((n) => n.uri))));
        cases++;
      }),
      { seed: SEED, numRuns: 400 },
    );
    report.push(`neighbors: ${cases} cases`);
  }, 180_000);

  it('*1..3 reachability equals BFS', async () => {
    // Version roots are excluded: navigation applies version views transitively, Cypher only to versions bound from a reference.
    const all = roots().filter((u) => !u.startsWith('mandate://commits/') && !u.startsWith('mandate://agents/') && !u.includes('@'));
    let cases = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(all.length - 1), async (i) => {
        const r = all[i]!;
        const nav = await fx.index.graphNeighbors({ uri: r, direction: 'out', depth: 3, kinds: ALL, limit: 500 });
        const cy = await col('MATCH (a {ref: $r})-[*1..3]->(b) RETURN DISTINCT b.ref', { r }, { limit: 5000 });
        expect(new Set(cy.filter((u) => u !== r)), r).toEqual(new Set(existing(nav.nodes.map((n) => n.uri))));
        cases++;
      }),
      { seed: SEED, numRuns: 150 },
    );
    report.push(`reachability: ${cases} cases`);
  }, 180_000);

  it('at an old commit, results equal neighbors(at)', async () => {
    // Any commit (side-branch ones too), any doc / section that exists there.
    const commits = rows<{ seq: number; sha: string }>('SELECT seq, sha FROM commits');
    let cases = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(commits.length - 1), fc.nat(1_000_000), async (i, x) => {
        const c = commits[i]!;
        const live = rows<{ uri: string }>(
          "SELECT DISTINCT uri FROM nodes WHERE kind IN ('spec', 'standard', 'section') AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY uri",
          c.seq,
          c.seq,
        );
        if (!live.length) return;
        const d = live[x % live.length]!;
        const nav = await fx.index.graphNeighbors({ uri: d.uri, direction: 'out', kinds: ALL, limit: 500, at: c.sha });
        const cy = await col('MATCH (a {ref: $r})-[t]->(b) RETURN DISTINCT b.ref', { r: d.uri }, { at: c.sha, limit: 5000 });
        expect(new Set(cy), `${d.uri} @${c.sha.slice(0, 7)}`).toEqual(new Set(existing(nav.nodes.map((n) => n.uri), c.seq)));
        cases++;
      }),
      { seed: SEED, numRuns: 150 },
    );
    report.push(`temporal: ${cases} cases`);
  }, 180_000);
});

/* ------------------------------------------------------------------ safety */

describe('safety', () => {
  it('times out pathological queries, caps rows and depth, rejects writes', async () => {
    const t = Date.now();
    await expect(run('MATCH (a), (b), (c) RETURN count(*)')).rejects.toMatchObject({ code: 'cypher_timeout' });
    expect(Date.now() - t).toBeLessThan(6000);
    // The engine recovers after a timeout.
    expect(await col('MATCH (s:Spec) RETURN count(s)')).toHaveLength(1);
    const capped = await run('MATCH (n) RETURN n.ref', {}, { limit: 5 });
    expect(capped.rows).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    await expect(run('MATCH (a)-[*1..7]->(b) RETURN b')).rejects.toThrow(/limited to 6 hops/);
    for (const w of ['CREATE (n) RETURN n', 'MERGE (n) RETURN n', 'MATCH (n) DELETE n RETURN n', 'MATCH (n) SET n.x = 1 RETURN n']) {
      await expect(run(w)).rejects.toBeInstanceOf(CypherError);
    }
    await expect(fx.index.graphQuery({ query: 'MATCH (n) RETURN n', limit: 5001 })).rejects.toBeInstanceOf(ZodError);
  }, 30_000);

  it('the query connection is read-only', async () => {
    const runner = new CypherRunner((fx.index as unknown as { opts: { index: { path: string } } }).opts.index.path, 2000);
    await expect(runner.run('DELETE FROM nodes', {})).rejects.toThrow(/only read statements|readonly/);
    await expect(runner.run("SELECT * FROM nodes; DELETE FROM nodes", {})).rejects.toThrow();
    await runner.close();
  });

  it('structured errors with hints', async () => {
    await expect(run('MATCH (n:Specs) RETURN n')).rejects.toThrow(/unknown label 'Specs'.*did you mean 'Spec'/);
    await expect(run('MATCH (a)-[:HAS_SECTIONS]->(b) RETURN b')).rejects.toThrow(/did you mean 'HAS_SECTION'/);
    await expect(run('MATCH (n) RETURN m')).rejects.toThrow(/unknown variable 'm'/);
    await expect(run('MATCH (n {ref: $r}) RETURN n')).rejects.toThrow(/missing parameter \$r/);
    await expect(run('MATCH (n {ref: $r}) RETURN n', { r: 'mandate://specs/nope' })).rejects.toThrow(/unknown node/);
  });

  it('uses indexes (EXPLAIN QUERY PLAN)', async () => {
    const runner = new CypherRunner((fx.index as unknown as { opts: { index: { path: string } } }).opts.index.path, 2000);
    const plan = await explainQuery(undefined as never, runner, "MATCH (d:Spec {ref: 'mandate://specs/login-sso'})-[:HAS_SECTION]->(s) RETURN s.ref");
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX|USING AUTOMATIC/);
    await runner.close();
  });
});

/* ------------------------------------------------------------------ practical queries */

describe('practical agent questions', () => {
  it('answers 15 realistic questions', async () => {
    const qs: { q: string; params?: Record<string, unknown>; check: (rows: unknown[][]) => void }[] = [
      {
        // 1. Sections referencing src/auth/session.ts lines 30-40, and the standards they follow.
        q: "MATCH (s:Section)-[:REFERENCES_CODE]->(c:CodeRange) WHERE c.path = 'src/auth/session.ts' AND c.lineStart <= 40 AND c.lineEnd >= 30 MATCH (d)-[:HAS_SECTION]->(s) OPTIONAL MATCH (s)-[:USES_STANDARD]->(st) OPTIONAL MATCH (d)-[:USES_STANDARD]->(ds:Standard) RETURN s.ref, collect(DISTINCT st.ref) AS follows, collect(DISTINCT ds.ref) AS docStandards",
        check: (r) => {
          expect(r.map((x) => x[0])).toContain('mandate://specs/login-sso/sections/callback');
          const row = r.find((x) => x[0] === 'mandate://specs/login-sso/sections/callback')!;
          expect([...(row[1] as string[]), ...(row[2] as string[])].some((u) => u.startsWith('mandate://standards/security-baseline'))).toBe(true);
        },
      },
      {
        // 2. Blocked sections and their blockers.
        q: "MATCH (s:Section)-[l:LINKS_TO]->(b:Section) WHERE l.rel = 'depends_on' RETURN s.ref AS blocked, b.ref AS blocker",
        check: (r) => expect(r).toContainEqual(['mandate://specs/mfa-totp/sections/login-flow', 'mandate://specs/login-sso/sections/callback']),
      },
      {
        // 3. Criteria without a passing verification, for specs using security-baseline.
        q: "MATCH (d:Spec)-[:USES_STANDARD]->(:Standard {ref: 'mandate://standards/security-baseline'}) MATCH (d)-[:HAS_SECTION]->(c:AcceptanceSection) WHERE NOT EXISTS { (v:Verification)-[:VERIFIES]->(c) WHERE v.result = 'pass' } RETURN d.ref, c.ref",
        check: (r) => {
          expect(r.length).toBeGreaterThan(0);
          for (const [, c] of r) expect(rows("SELECT 1 FROM edges e JOIN nodes v ON v.uri = e.from_uri AND v.valid_to IS NULL WHERE e.kind = 'verifies' AND e.to_uri = ? AND e.valid_to IS NULL AND json_extract(v.props, '$.result') = 'pass'", c)).toEqual([]);
        },
      },
      {
        // 4. Open feedback per standard section.
        q: "MATCH (f:Feedback)-[:TARGETS]->(s:Section)<-[:HAS_SECTION]-(d:Standard) WHERE f.status = 'open' RETURN s.ref, count(f) AS open ORDER BY open DESC",
        check: (r) => r.forEach((x) => expect(Number(x[1])).toBeGreaterThan(0)),
      },
      {
        // 5. What changed in a spec since it was implemented.
        q: "MATCH (d:Spec {ref: 'mandate://specs/usage-metering'}) MATCH (ic:Commit) WHERE ic.sha STARTS WITH d.implementedCommit MATCH (c:Commit)-[ch:CHANGED]->(x) WHERE isAncestor(ic, c) AND (x.ref = d.ref OR x.docUri = d.ref) RETURN c.sha, x.ref, ch.changeKinds ORDER BY c.date",
        check: (r) => {
          expect(r.length).toBeGreaterThan(0);
          expect(r.map((x) => x[1])).toContain('mandate://specs/usage-metering/sections/aggregation');
        },
      },
      {
        // 6. Deviations and their notes.
        q: 'MATCH (s:Section)-[d:DEVIATES_FROM]->(t) RETURN s.ref, t.ref, d.note',
        check: (r) => {
          expect(r.length).toBeGreaterThan(0);
          for (const x of r) expect(typeof x[2]).toBe('string');
        },
      },
      {
        // 7. Specs depending (transitively) on user-sessions.
        q: "MATCH (x:Spec)-[:DEPENDS_ON*1..3]->(s:Spec {ref: 'mandate://specs/user-sessions'}) RETURN DISTINCT x.ref ORDER BY x.ref",
        check: (r) => expect(r.map((x) => x[0])).toEqual(expect.arrayContaining(['mandate://specs/login-sso', 'mandate://specs/mfa-totp'])),
      },
      {
        // 8. Open work orders and the sections they cover.
        q: "MATCH (w:WorkOrder)-[:COVERS]->(s:Section) WHERE w.status IN ['pending', 'in_progress'] RETURN w.ref, w.status, collect(s.ref) AS sections",
        check: (r) => {
          expect(r.length).toBeGreaterThan(0);
          r.forEach((x) => expect((x[2] as string[]).length).toBeGreaterThan(0));
        },
      },
      {
        // 9. Who resolved feedback (commits with Feedback trailers).
        q: 'MATCH (c:Commit)-[:RESOLVES]->(f:Feedback) MATCH (c)-[:AUTHORED_BY]->(a:Agent) RETURN a.name, count(DISTINCT f) AS n ORDER BY n DESC',
        check: (r) => r.forEach((x) => expect(Number(x[1])).toBeGreaterThan(0)),
      },
      {
        // 10. Standards that apply to specs of repo `app` through appliesTo rules.
        q: "MATCH (st:Standard)-[:APPLIES_TO]->(d:Spec) WHERE d.repo = 'app' RETURN st.ref, collect(d.ref) AS specs",
        check: (r) => expect(r.map((x) => x[0])).toContain('mandate://standards/security-baseline'),
      },
      {
        // 11. Failing verifications and what they verify.
        q: "MATCH (v:Verification)-[:VERIFIES]->(c) WHERE v.result = 'fail' RETURN v.ref, c.ref",
        check: (r) => r.forEach((x) => expect(String(x[1])).toContain('/sections/')),
      },
      {
        // 12. Most frequently changed sections.
        q: 'MATCH (c:Commit)-[:CHANGED]->(s:Section) RETURN s.ref, count(c) AS n ORDER BY n DESC, s.ref LIMIT 5',
        check: (r) => {
          expect(r).toHaveLength(5);
          for (let i = 1; i < r.length; i++) expect(Number(r[i - 1]![1])).toBeGreaterThanOrEqual(Number(r[i]![1]));
        },
      },
      {
        // 13. Versions of a section, oldest first.
        q: "MATCH (v:Version)-[:VERSION_OF]->(s {ref: 'mandate://specs/login-sso/sections/overview'}) MATCH (v)-[:CREATED_IN]->(c:Commit) RETURN v.sha, v.action ORDER BY c.date",
        check: (r) => expect(r[0]![1]).toBe('created'),
      },
      {
        // 14. Symbols mentioned by in-progress specs.
        q: "MATCH (d:Spec)-[:HAS_SECTION]->(s)-[:MENTIONS_SYMBOL]->(y:Symbol) WHERE d.status = 'in_progress' RETURN d.ref, collect(DISTINCT y.label) AS symbols",
        check: (r) => {
          const sso = r.find((x) => x[0] === 'mandate://specs/login-sso');
          if (sso) expect(sso[1]).toContain('AuthService.login');
        },
      },
      {
        // 15. Specs whose claim is held by an agent, with the claim.
        q: 'MATCH (d:Spec) WHERE d.claim IS NOT NULL RETURN d.ref, d.claim.agent',
        check: (r) => r.forEach((x) => expect(typeof x[1]).toBe('string')),
      },
    ];
    for (const { q, params, check } of qs) {
      const r = await run(q, params ?? {});
      check(r.rows);
    }
    report.push(`practical: ${qs.length} queries`);
  }, 60_000);
});

/* ------------------------------------------------------------------ schema and batch */

describe('graph_schema and graph_batch', () => {
  it('schema covers every label and type, and every example query runs', async () => {
    const s = await fx.index.graphSchema();
    expect(s.labels.map((l) => l.label)).toEqual(expect.arrayContaining([...Object.values(NODE_LABELS), ...Object.keys(DERIVED_LABELS)]));
    expect(s.relationships.map((r) => r.type)).toEqual(expect.arrayContaining(EDGE_KINDS.map(relTypeOf)));
    for (const r of s.relationships) expect(r.reverse).toBeTruthy();
    expect(s.labels.find((l) => l.label === 'Spec')!.properties).toEqual(expect.arrayContaining(['ref', 'status', 'repo']));
    expect(s.examples).toHaveLength(11);
    for (const ex of s.examples) {
      await run(ex.query, { ref: 'mandate://specs/user-sessions', symbol: 'mandate://symbols/SessionStore.create' });
    }
  }, 60_000);

  it('runs ops in order; per-op errors do not fail the batch', async () => {
    const r = await fx.index.graphBatch({
      ops: [
        { op: 'resolveRef', args: { ref: 'mandate://specs/login-sso' } },
        { op: 'graphNode', args: { uri: 'mandate://specs/nope' } },
        { op: 'search', args: { q: '' } },
        { op: 'graphQuery', args: { query: 'MATCH (s:Spec) RETURN count(s)' } },
        { op: 'graphQuery', args: { query: 'CREATE (n) RETURN n' } },
      ],
    });
    expect(r.map((x) => x.ok)).toEqual([true, false, false, true, false]);
    expect(r[1]).toMatchObject({ ok: false, error: { code: 'unknown_node' } });
    expect(r[2]).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(r[4]).toMatchObject({ ok: false, error: { code: 'cypher_syntax' } });
    await expect(fx.index.graphBatch({ ops: Array.from({ length: 21 }, () => ({ op: 'graphSchema' as const, args: {} })) })).rejects.toBeInstanceOf(ZodError);
    await expect(fx.index.graphBatch({ ops: [{ op: 'dropEverything' as never, args: {} }] })).rejects.toBeInstanceOf(ZodError);
  });

  it('prints the report', () => console.info(`cypher equivalence: ${report.join(', ')}`));
});
