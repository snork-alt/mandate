/**
 * Regression tests of the graph-structure review (plans/fable-data-review.md, section 3, G-*; GQ-9 of section 4),
 * run on a clone of the seeded data repo.
 */
import { execFileSync } from 'node:child_process';
import { EDGE_KINDS, REVERSE_EDGE_NAMES, buildRef, ownerOf } from '@mandate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from '../src/storage/index.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
let storage: Storage;
beforeAll(async () => {
  fx = await graphFixture('clone');
  storage = createStorage(fx.git);
}, 180_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
const cy = async (query: string, params: Record<string, unknown> = {}, at?: string) => (await fx.index.graphQuery({ query, params, limit: 5000, ...(at ? { at } : {}) })).rows;
const git = (...args: string[]) => execFileSync('git', args, { cwd: fx.dir, encoding: 'utf8' });

describe('graph structure (G-*)', () => {
  it('G-1: one open row per agent and branch node; Cypher count(*) equals the edge count', async () => {
    const dup = rows<{ uri: string; n: number }>("SELECT uri, count(*) AS n FROM nodes WHERE kind IN ('agent', 'branch') AND valid_to IS NULL GROUP BY uri HAVING n > 1");
    expect(dup).toEqual([]);
    const agents = rows<{ n: number }>("SELECT count(DISTINCT uri) AS n FROM nodes WHERE kind = 'agent'")[0]!.n;
    expect(agents).toBeGreaterThan(1);
    // P6: a commit is authored_by its agent and, in server mode, its user too.
    const authored = rows<{ n: number }>("SELECT count(*) AS n FROM edges WHERE kind = 'authored_by' AND from_uri LIKE 'mandate://commits/%' AND to_uri LIKE 'mandate://agents/%' AND valid_to IS NULL")[0]!.n;
    expect(authored).toBeGreaterThan(agents); // agents with several commits
    expect(await cy('MATCH (c:Commit)-[:AUTHORED_BY]->(a:Agent) RETURN count(*)')).toEqual([[authored]]);
    const onBranch = rows<{ n: number }>("SELECT count(*) AS n FROM edges WHERE kind = 'on_branch' AND from_uri LIKE 'mandate://commits/%' AND valid_to IS NULL")[0]!.n;
    expect(await cy('MATCH (c:Commit)-[:ON_BRANCH]->(b:Branch) RETURN count(*)')).toEqual([[onBranch]]);
    const [[n, d]] = (await cy('MATCH (a:Agent) RETURN count(a), count(DISTINCT a)')) as [[number, number]];
    expect(n).toBe(d);
  });

  it('G-2: waiver fields stay on the link edge and the waiver points at its approving feedback', async () => {
    const m = await storage.model();
    const waivers = m.specs.flatMap((s) => s.sections.flatMap((x) => x.links.filter((l) => (l as { feedback?: string }).feedback).map((l) => ({ from: buildRef({ kind: 'specs', id: s.id, sectionId: x.id }), l: l as typeof l & { feedback: string; pin?: string; by?: string } }))));
    expect(waivers.length).toBeGreaterThan(0);
    for (const { from, l } of waivers) {
      const e = rows<{ props: string }>("SELECT props FROM edges WHERE kind = ? AND from_uri = ? AND to_uri = ? AND valid_to IS NULL", l.rel, from, l.to);
      expect(e.length, from).toBe(1);
      expect(JSON.parse(e[0]!.props)).toMatchObject({ rel: l.rel, feedback: l.feedback, ...(l.pin ? { pin: l.pin } : {}), ...(l.by ? { by: l.by } : {}) });
      const w = rows("SELECT 1 FROM edges WHERE kind = 'waived_by' AND from_uri = ? AND to_uri = ? AND valid_to IS NULL", from, buildRef({ kind: 'feedback', id: l.feedback }));
      expect(w.length, from).toBe(1);
    }
    // Queryable in Cypher.
    const got = await cy('MATCH (s:Section)-[w:WAIVED_BY]->(f:Feedback) RETURN s.ref, f.ref');
    expect(got.length).toBe(waivers.length);
  });

  it('G-4: reverse edge names are unique and never collide with an edge kind', () => {
    const names = EDGE_KINDS.map((k) => REVERSE_EDGE_NAMES[k]);
    expect(new Set(names).size).toBe(names.length);
    for (const k of EDGE_KINDS) expect((EDGE_KINDS as readonly string[]).includes(REVERSE_EDGE_NAMES[k]), `${k} -> ${REVERSE_EDGE_NAMES[k]}`).toBe(false);
  });

  it('G-5: reason, createdBy, verification code commit and work-order proofs become edges', async () => {
    const wos = await storage.workOrders.list();
    const withReason = wos.filter((w) => ((w as { reason?: string[] }).reason ?? []).length);
    expect(withReason.length).toBeGreaterThan(0);
    for (const w of withReason) {
      for (const r of (w as { reason?: string[] }).reason!) {
        expect(rows("SELECT 1 FROM edges WHERE kind = 'acts_on' AND from_uri = ? AND to_uri = ? AND valid_to IS NULL", buildRef({ kind: 'work-orders', id: w.id }), buildRef({ kind: 'feedback', id: r })).length, w.id).toBe(1);
      }
    }
    const created = rows<{ n: number }>("SELECT count(*) AS n FROM edges WHERE kind = 'authored_by' AND json_extract(props, '$.role') = 'created' AND valid_to IS NULL")[0]!.n;
    expect(created).toBeGreaterThan(0);
    const vr = rows<{ props: string }>("SELECT props FROM nodes WHERE kind = 'verification' AND valid_to IS NULL").filter((r) => JSON.parse(r.props).code?.commit);
    const vac = rows<{ n: number }>("SELECT count(*) AS n FROM edges WHERE kind = 'verified_at_code' AND valid_to IS NULL")[0]!.n;
    expect(vac).toBe(vr.length);
    expect((await cy('MATCH (v:Verification)-[:VERIFIED_AT_CODE]->(c:CodeCommit) RETURN count(*)'))[0]![0]).toBe(vr.length);
    const proofs = rows<{ n: number }>("SELECT count(*) AS n FROM edges WHERE kind = 'proven_by' AND valid_to IS NULL")[0]!.n;
    expect(proofs).toBeGreaterThan(0);
  });

  it('G-6: every code file inside a component glob has an owner, whatever edge introduced it', async () => {
    const m = await storage.model();
    const comps = (m.components ?? []).filter((c) => c.status !== 'archived');
    const files = rows<{ uri: string; props: string }>("SELECT uri, props FROM nodes WHERE kind = 'code_file' AND valid_to IS NULL");
    let owned = 0;
    for (const f of files) {
      const p = JSON.parse(f.props) as { repo: string; path: string };
      const o = ownerOf(p.repo, p.path, comps);
      const e = rows<{ to_uri: string }>("SELECT to_uri FROM edges WHERE kind = 'owned_by' AND from_uri = ? AND valid_to IS NULL", f.uri);
      if (o) {
        owned++;
        expect(e.map((x) => x.to_uri), f.uri).toEqual([buildRef({ kind: 'components', id: o.component.id })]);
      } else expect(e, f.uri).toEqual([]);
    }
    expect(owned).toBeGreaterThan(0);
  });

  it('G-7: shared structural edges (in_file, code in_repo) are stored once', () => {
    const dup = rows("SELECT from_uri, to_uri, kind, count(*) AS n FROM edges WHERE (kind = 'in_file' OR (kind = 'in_repo' AND from_uri LIKE 'mandate://code/%')) AND valid_to IS NULL GROUP BY from_uri, to_uri, kind HAVING n > 1");
    expect(dup).toEqual([]);
    expect(rows("SELECT 1 FROM edges WHERE kind = 'in_file' AND source <> 'shared' AND source <> 'snapshot'")).toEqual([]);
  });

  it('G-8: an explicit follows of a whole standard inherits all its rules, whatever the referenced code', async () => {
    const m = await storage.model();
    let checked = 0;
    for (const spec of m.specs.filter((s) => s.status !== 'archived')) {
      for (const s of spec.sections.filter((x) => !x.archived)) {
        for (const l of s.links.filter((x) => x.rel === 'follows' && /^mandate:\/\/standards\/[a-z0-9-]+$/.test(x.to))) {
          const std = m.standards.find((x) => `mandate://standards/${x.id}` === l.to);
          if (!std || std.status !== 'active') continue;
          const inherited = new Set(rows<{ to_uri: string }>("SELECT to_uri FROM edges WHERE kind = 'inherits_rule' AND from_uri = ? AND valid_to IS NULL", buildRef({ kind: 'specs', id: spec.id, sectionId: s.id })).map((r) => r.to_uri));
          for (const r of std.sections.filter((x) => x.type === 'rule' && !x.archived)) {
            const waived = spec.sections.some((x) => x.links.some((y) => y.rel === 'deviates_from' && y.to === `${l.to}/sections/${r.id}`));
            if (waived) continue;
            expect(inherited.has(`${l.to}/sections/${r.id}`), `${spec.id}/${s.id} ${r.id}`).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('G-10: violated_at carries a stable time (the audit start), not one that moves at completion', () => {
    const v = rows<{ props: string }>("SELECT props FROM edges WHERE kind = 'violated_at' AND json_extract(props, '$.source') LIKE 'mandate://findings/%'");
    for (const e of v) {
      const p = JSON.parse(e.props) as { source: string; at: string | null };
      const audit = `mandate://audits/${p.source.slice('mandate://findings/'.length).split('/')[0]}`;
      const a = rows<{ props: string }>('SELECT props FROM nodes WHERE uri = ? ORDER BY valid_from DESC LIMIT 1', audit)[0];
      if (a) expect(p.at).toBe(JSON.parse(a.props).startedAt ?? null);
    }
    // No violated_at fact was closed and reopened with the same endpoints and source.
    const churn = rows("SELECT from_uri, to_uri, json_extract(props, '$.source') AS s, count(*) AS n FROM edges WHERE kind = 'violated_at' AND source <> 'snapshot' GROUP BY from_uri, to_uri, s HAVING n > 1");
    expect(churn).toEqual([]);
  });

  it('G-13: the audits edge carries no audit status', () => {
    expect(rows("SELECT props FROM edges WHERE kind = 'audits' AND props IS NOT NULL")).toEqual([]);
  });

  it('G-14: symbols named on touched code of work orders become symbol nodes', async () => {
    const wos = await storage.workOrders.list();
    const named = wos.flatMap((w) => [
      ...(((w as { touched?: { symbols?: string[] }[] }).touched ?? []).flatMap((t) => t.symbols ?? []).map((s) => ({ w: buildRef({ kind: 'work-orders', id: w.id }), s }))),
    ]);
    expect(named.length).toBeGreaterThan(0);
    for (const { w, s } of named) {
      expect(rows("SELECT 1 FROM edges WHERE kind = 'mentions_symbol' AND from_uri = ? AND to_uri = ? AND valid_to IS NULL", w, `mandate://symbols/${encodeURIComponent(s)}`).length, `${w} ${s}`).toBe(1);
    }
  });
});

describe('graph query correctness (indexer side)', () => {
  it('GQ-9: time travel to a commit with the legacy spec-level dependsOn sees the dependency', async () => {
    const shas = git('log', '--format=%H', '-S', 'dependsOn:', '--', 'specs').split('\n').filter(Boolean);
    let hit: { sha: string; spec: string; dep: string } | null = null;
    for (const sha of shas) {
      const out = (() => {
        try {
          return git('grep', '-h', '-E', '^dependsOn: \\[[a-z]', sha, '--', 'specs');
        } catch {
          return '';
        }
      })();
      if (!out) continue;
      const file = git('grep', '-l', '-E', '^dependsOn: \\[[a-z]', sha, '--', 'specs').split('\n')[0]!;
      const spec = file.replace(/^[^:]+:specs\//, '').replace(/\.md$/, '');
      const dep = /^dependsOn: \[([a-z0-9-]+)/m.exec(git('show', `${sha}:specs/${spec}.md`))![1]!;
      hit = { sha, spec, dep };
      break;
    }
    expect(hit).not.toBeNull();
    const got = await cy('MATCH (a:Spec {ref: $a})-[:SPEC_DEPENDS_ON]->(b:Spec) RETURN b.ref', { a: buildRef({ kind: 'specs', id: hit!.spec }) }, hit!.sha);
    expect(got.map((r) => r[0])).toContain(buildRef({ kind: 'specs', id: hit!.dep }));
  });
});
