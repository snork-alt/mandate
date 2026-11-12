/**
 * Navigation contract: from any reference, the graph can be walked consistently, now and in the past.
 * Exhaustive where feasible, property-based (fast-check, fixed seed) where not.
 */
import { sectionLineRange } from '@mandate/doc';
import { EDGE_KINDS, REVERSE_EDGE_NAMES, buildRef, parseRef, type EdgeKind, type MandateRef } from '@mandate/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMIT_EDGE_KINDS, IMPACT, impactEdge } from '../src/index/graph.js';
import type { EdgeRow } from '../src/index/resolve.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, rng, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
beforeAll(async () => {
  fx = await graphFixture();
}, 120_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const SEED = 20261112;
const report: string[] = [];
const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
/** Mainline commits (first-parent chain), oldest first; `seq` is the index's internal point (tests may read it). */
const commitSeqs = () => rows<{ seq: number; sha: string }>('SELECT seq, sha FROM commits WHERE mainline = 1 ORDER BY seq');
/** Every commit, side-branch ones included (their point is negative: a snapshot). */
const allCommits = () => rows<{ seq: number; sha: string }>('SELECT seq, sha FROM commits ORDER BY abs(seq)');
const edgeKey = (e: { from: string; to: string; kind: string; props?: unknown }) => `${e.from}|${e.to}|${e.kind}|${e.props ? JSON.stringify(e.props) : ''}`;
/** Kinds whose nodes are owned by a file (they appear and disappear); other kinds are created once and kept. */
const OWNED = ['spec', 'standard', 'section', 'work_order', 'feedback', 'verification'];
/** Kinds allowed to point at nodes that no longer exist (references into history). */
const HISTORICAL = new Set<EdgeKind>(['targets', 'covers', 'verifies', 'applied_to', 'changed', 'version_of', 'depends_on', 'links_to', 'uses_standard', 'deviates_from']);

describe('edge integrity', () => {
  it('every edge endpoint resolves, and no edge dangles at HEAD or at any commit', async () => {
    const endpoints = rows<{ u: string }>('SELECT from_uri AS u FROM edges UNION SELECT to_uri FROM edges');
    for (const { u } of endpoints) {
      const r = await fx.index.resolveRef({ ref: u });
      expect(r.node.ref).toBe(r.node.uri);
    }
    // Owned endpoints exist at every point where the edge is valid (except references into history).
    let checked = 0;
    const dangling: string[] = [];
    for (const { seq } of allCommits()) {
      const bad = rows<{ from_uri: string; to_uri: string; kind: EdgeKind; side: string }>(
        `SELECT e.from_uri, e.to_uri, e.kind, s.side FROM edges e, (SELECT 'from' AS side UNION SELECT 'to') s
          WHERE e.valid_from <= @s AND (e.valid_to IS NULL OR e.valid_to > @s)
            AND EXISTS (SELECT 1 FROM nodes k WHERE k.uri = CASE s.side WHEN 'from' THEN e.from_uri ELSE e.to_uri END AND k.kind IN (${OWNED.map((k) => `'${k}'`).join(',')}))
            AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.uri = CASE s.side WHEN 'from' THEN e.from_uri ELSE e.to_uri END
                              AND n.valid_from <= @s AND (n.valid_to IS NULL OR n.valid_to > @s))`,
        { s: seq },
      );
      checked += (rows<{ n: number }>('SELECT COUNT(*) AS n FROM edges WHERE valid_from <= @s AND (valid_to IS NULL OR valid_to > @s)', { s: seq })[0]!).n;
      for (const b of bad) if (b.side === 'from' || !HISTORICAL.has(b.kind)) dangling.push(`${seq} ${b.kind} ${b.from_uri} -> ${b.to_uri}`);
    }
    expect(dangling).toEqual([]);
    report.push(`edge integrity: ${endpoints.length} endpoints resolved, ${checked} edge-at-commit checks`);
  }, 120_000);
});

describe('neighbour closure and bidirectionality', () => {
  it('neighbors(depth 1) works for every node and every returned ref resolves back to it', async () => {
    const nodes = rows<{ uri: string; kind: string }>('SELECT DISTINCT uri, kind FROM nodes');
    // Plus excerpts (virtual): one per current section.
    const excerpts = rows<{ uri: string; line_start: number }>('SELECT uri, line_start FROM sections WHERE line_start IS NOT NULL').map((s) => {
      const m = parseRef(s.uri)!;
      return { uri: buildRef({ ...m, lines: { start: s.line_start, end: s.line_start + 1 } }), kind: 'excerpt' };
    });
    const resolved = new Set<string>();
    const kinds = new Set<string>();
    let returned = 0;
    for (const n of [...nodes, ...excerpts]) {
      const r = await fx.index.graphNeighbors({ uri: n.uri, depth: 1, limit: 500 });
      kinds.add(n.kind);
      for (const x of r.nodes) {
        returned++;
        if (resolved.has(x.ref)) continue;
        const back = await fx.index.resolveRef({ ref: x.ref });
        expect(back.node.uri, x.ref).toBe(x.uri);
        resolved.add(x.ref);
      }
    }
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['agent', 'code_file', 'code_range', 'commit', 'excerpt', 'feedback', 'section', 'spec', 'work_order', 'standard', 'symbol', 'verification', 'version']));
    report.push(`neighbour closure: ${nodes.length + excerpts.length} nodes, ${returned} neighbours, ${resolved.size} distinct refs resolved back`);
  }, 120_000);

  it('every edge is visible from both ends, under its name and its reverse name', async () => {
    for (const k of EDGE_KINDS) expect(REVERSE_EDGE_NAMES[k], k).toBeTruthy();
    const edges = rows<EdgeRow>("SELECT * FROM edges WHERE valid_to IS NULL AND kind != 'similar_to'");
    const outCache = new Map<string, Set<string>>();
    const inCache = new Map<string, Map<string, Set<string>>>();
    const out = async (u: string, k: EdgeKind) => {
      const key = `${u}|${k}`;
      if (!outCache.has(key)) {
        const r = await fx.index.graphNeighbors({ uri: u, direction: 'out', kinds: [k], limit: 500 });
        outCache.set(key, new Set(r.nodes.map((n) => n.uri)));
      }
      return outCache.get(key)!;
    };
    const named = async (u: string) => {
      if (!inCache.has(u)) {
        const r = await fx.index.graphNode({ uri: u, limit: 100 });
        const m = new Map<string, Set<string>>();
        for (const g of r.neighbors) m.set(`${g.direction}:${g.name}`, new Set(g.nodes.map((n) => n.uri)));
        inCache.set(u, m);
      }
      return inCache.get(u)!;
    };
    const kindsSeen = new Set<string>();
    for (const e of edges) {
      expect(await out(e.from_uri, e.kind), `${e.kind} ${e.from_uri} -> ${e.to_uri}`).toContain(e.to_uri);
      const back = await fx.index.graphNeighbors({ uri: e.to_uri, direction: 'in', kinds: [e.kind], limit: 500 });
      expect(back.nodes.map((n) => n.uri), `${e.kind} reverse of ${e.to_uri}`).toContain(e.from_uri);
      const fromNamed = (await named(e.from_uri)).get(`out:${e.kind}`);
      const toNamed = (await named(e.to_uri)).get(`in:${REVERSE_EDGE_NAMES[e.kind]}`);
      expect(fromNamed?.size ?? 0).toBeGreaterThan(0);
      expect(toNamed?.size ?? 0).toBeGreaterThan(0);
      kindsSeen.add(e.kind);
    }
    report.push(`bidirectionality: ${edges.length} edges, ${kindsSeen.size} edge kinds, both names reachable`);
  }, 120_000);
});

describe('reachability', () => {
  it('sections from their document, documents from repo or search, versions as gap-free chains, no orphans', async () => {
    const docs = rows<{ uri: string; title: string; repo: string | null; kind: string }>("SELECT uri, title, repo, kind FROM docs WHERE kind IN ('spec', 'standard')");
    for (const d of docs) {
      const secs = rows<{ uri: string }>('SELECT uri FROM sections WHERE doc_uri = ?', d.uri).map((s) => s.uri);
      const r = await fx.index.graphNeighbors({ uri: d.uri, direction: 'out', kinds: ['has_section'], limit: 500 });
      expect(new Set(r.nodes.map((n) => n.uri))).toEqual(new Set(secs));
      if (d.repo) {
        const repo = await fx.index.graphNeighbors({ uri: `mandate://repos/${d.repo}`, direction: 'in', kinds: ['in_repo'], limit: 500 });
        expect(repo.nodes.map((n) => n.uri)).toContain(d.uri);
      } else {
        const s = await fx.index.search({ q: d.title, mode: 'text', limit: 50 });
        expect(s.groups.map((g) => g.docUri)).toContain(d.uri);
      }
    }
    // Version chains.
    const lives = rows<{ u: string }>("SELECT DISTINCT to_uri AS u FROM edges WHERE kind = 'version_of'");
    let versions = 0;
    for (const { u } of lives) {
      const chain = rows<{ uri: string; seq: number }>("SELECT uri, point AS seq FROM versions WHERE of_uri = ? ORDER BY abs(point)", u);
      const changes = rows<{ n: number }>("SELECT COUNT(DISTINCT from_uri) AS n FROM edges WHERE kind = 'changed' AND to_uri = ?", u)[0]!.n;
      expect(chain.length, u).toBe(changes);
      const has = await fx.index.graphNeighbors({ uri: u, direction: 'in', kinds: ['version_of'], limit: 500 });
      expect(new Set(has.nodes.map((n) => n.uri))).toEqual(new Set(chain.map((c) => c.uri)));
      // Each version but the first has exactly one previous version (the one current at its first parent),
      // earlier in history; and next(prev(v)) contains v. With branches a version can have several next versions.
      let roots = 0;
      const inChain = new Set(chain.map((c) => c.uri));
      const order = new Map(chain.map((c, k) => [c.uri, k]));
      for (const v of chain) {
        const prev = await fx.index.graphNeighbors({ uri: v.uri, direction: 'out', kinds: ['previous_version'] });
        expect(prev.nodes.length, v.uri).toBeLessThanOrEqual(1);
        if (!prev.nodes.length) {
          roots++;
          continue;
        }
        const p = prev.nodes[0]!.uri;
        expect(inChain.has(p)).toBe(true);
        expect(order.get(p)!).toBeLessThan(order.get(v.uri)!);
        const next = await fx.index.graphNeighbors({ uri: p, direction: 'in', kinds: ['previous_version'] });
        expect(next.nodes.map((n) => n.uri)).toContain(v.uri);
      }
      expect(roots, u).toBe(1);
      versions += chain.length;
    }
    // Orphans: nodes with no edge at all (roots: none expected).
    const orphans = rows<{ uri: string; kind: string }>('SELECT DISTINCT n.uri, n.kind FROM nodes n WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_uri = n.uri OR e.to_uri = n.uri)');
    expect(orphans).toEqual([]);
    report.push(`reachability: ${docs.length} docs, ${lives.length} version chains (${versions} versions), 0 orphans`);
  }, 120_000);
});

describe('path and impact', () => {
  it('random pairs: path is a real edge chain and the reverse path has the same length', async () => {
    const nodes = rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE valid_to IS NULL AND kind NOT IN ('commit', 'agent', 'branch', 'version')").map((n) => n.uri);
    const edgeSet = new Set(
      rows<EdgeRow>(`SELECT * FROM edges WHERE valid_to IS NULL AND kind NOT IN (${[...COMMIT_EDGE_KINDS, 'similar_to'].map((k) => `'${k}'`).join(',')})`).flatMap((e) => [
        `${e.from_uri}|${e.to_uri}|${e.kind}`,
      ]),
    );
    let found = 0;
    let pairs = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(nodes.length - 1), fc.nat(nodes.length - 1), async (i, j) => {
        pairs++;
        const a = nodes[i]!;
        const b = nodes[j]!;
        const p = await fx.index.graphPath({ from: a, to: b });
        if (!p.found) {
          expect((await fx.index.graphPath({ from: b, to: a })).found).toBe(false);
          return;
        }
        found++;
        expect(p.nodes[0]!.uri).toBe(a);
        expect(p.nodes.at(-1)!.uri).toBe(b);
        expect(p.edges.length).toBe(p.nodes.length - 1);
        p.edges.forEach((e, k) => {
          const x = p.nodes[k]!.uri;
          const y = p.nodes[k + 1]!.uri;
          const real = (e.from === x && e.to === y) || (e.from === y && e.to === x);
          // Code nodes are joined by overlap: an edge may attach to an overlapping range of the same file.
          expect(real || x.startsWith('mandate://code/') || y.startsWith('mandate://code/'), `${x} ${e.kind} ${y}`).toBe(true);
          // A version node's outgoing edges are a view: the live node's edge valid at the version's point.
          const view = rows<{ of_uri: string; point: number }>('SELECT of_uri, point FROM versions WHERE uri = ?', e.from)[0];
          const ok = edgeSet.has(`${e.from}|${e.to}|${e.kind}`) || (view
            ? rows('SELECT 1 FROM edges WHERE from_uri = ? AND to_uri = ? AND kind = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)', view.of_uri, e.to, e.kind, view.point, view.point).length > 0
            : false);
          expect(ok, `${e.from} ${e.kind} ${e.to}`).toBe(true);
        });
        const back = await fx.index.graphPath({ from: b, to: a });
        expect(back.found).toBe(true);
        expect(back.edges.length).toBe(p.edges.length);
      }),
      { seed: SEED, numRuns: 300 },
    );
    expect(found).toBeGreaterThan(50);
    report.push(`path: ${pairs} random pairs, ${found} connected`);
  }, 120_000);

  it('impact only contains nodes with a directed rule chain back to the root', async () => {
    const pick = rng(SEED);
    const nodes = rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE valid_to IS NULL AND kind IN ('spec', 'standard', 'section', 'symbol', 'code_file', 'code_range')").map((n) => n.uri);
    const sample = nodes.filter(() => pick() < 0.35);
    const current = rows<EdgeRow>('SELECT * FROM edges WHERE valid_to IS NULL');
    let impacted = 0;
    for (const root of sample) {
      const r = await fx.index.graphImpact({ uri: root });
      const all = Object.values(r.groups).flat();
      const depthOf = new Map(all.map((n) => [n!.uri, n!.depth]));
      for (const n of all) {
        impacted++;
        // A rule edge links n to the root (expanded) or to a node one level closer.
        const ok = current.some((e) => {
          if (!impactEdge(e) || e.kind !== n!.via) return false;
          const rule = IMPACT.find(([k]) => k === e.kind)!;
          const [src, dst] = rule[1] === 'in' ? [e.to_uri, e.from_uri] : [e.from_uri, e.to_uri];
          if (dst !== n!.uri) return false;
          const d = depthOf.get(src);
          return d === n!.depth - 1 || src === root || src.startsWith(root) || n!.depth === 1;
        });
        expect(ok, `${root} -> ${n!.uri} via ${n!.via}`).toBe(true);
      }
    }
    report.push(`impact: ${sample.length} roots, ${impacted} impacted nodes justified`);
  }, 120_000);
});

describe('temporal navigation', () => {
  it('a version node shows the live node’s edges at that commit', async () => {
    const versions = rows<{ uri: string; of: string; sha: string }>(
      "SELECT uri, json_extract(props, '$.of') AS of, json_extract(props, '$.sha') AS sha FROM nodes WHERE kind = 'version' AND json_extract(props, '$.action') != 'deleted'",
    );
    const own = new Set(['version_of', 'created_in', 'previous_version']);
    for (const v of versions) {
      const a = await fx.index.graphNode({ uri: v.uri, limit: 100 });
      const b = await fx.index.graphNode({ uri: v.of, at: v.sha, limit: 100 });
      const outs = (r: typeof a) =>
        r.neighbors
          .filter((g) => g.direction === 'out' && !own.has(g.kind))
          .map((g) => `${g.kind}:${g.nodes.map((n) => n.uri).sort().join(',')}`)
          .sort();
      expect(outs(a), v.uri).toEqual(outs(b));
    }
    report.push(`versions: ${versions.length} version nodes equal to node(live, at=sha)`);
  }, 120_000);

  it('history and evolution events point to resolvable commits and versions', async () => {
    const docs = rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE kind IN ('spec', 'standard')");
    let events = 0;
    for (const { uri } of docs) {
      const h = await fx.index.graphHistory({ uri, limit: 200 });
      for (const e of h.events) {
        await fx.index.resolveRef({ ref: e.commit.uri });
        const m = parseRef(e.target)!;
        const v = await fx.index.resolveRef({ ref: buildRef({ ...m, commit: e.commit.sha }) });
        expect(v.node.kind).toBe('version');
        expect(v.node.props.sha).toBe(e.commit.sha);
        events++;
      }
      const evo = await fx.index.graphEvolution({ uri });
      for (const x of evo.entries) {
        await fx.index.resolveRef({ ref: x.other.uri });
        await fx.index.resolveRef({ ref: `mandate://commits/${x.from.sha}` });
        if (x.to) await fx.index.resolveRef({ ref: `mandate://commits/${x.to.sha}` });
      }
    }
    report.push(`history: ${events} events with resolvable commit and version nodes`);
  }, 120_000);

  it('the deleted spec is navigable at old commits and deleted at HEAD', async () => {
    const live = 'mandate://specs/legacy-xml-export';
    const h = await fx.index.graphHistory({ uri: live });
    const old = h.events.at(-1)!.commit;
    const n = await fx.index.graphNeighbors({ uri: live, at: old.sha, direction: 'out', kinds: ['has_section'] });
    expect(n.nodes.length).toBeGreaterThan(0);
    const head = await fx.index.graphNode({ uri: live });
    expect(head.node.deletedAt).toBeDefined();
    await expect(fx.index.graphNeighbors({ uri: live, at: commitSeqs().at(-1)!.sha })).rejects.toThrow(/does not exist/);
  });

  it('changes(from, to) equals the exact set difference of edges at both points', async () => {
    const seqs = allCommits();
    const at = (seq: number) =>
      new Set(
        rows<EdgeRow>(
          `SELECT * FROM edges WHERE valid_from <= @s AND (valid_to IS NULL OR valid_to > @s) AND kind NOT IN (${COMMIT_EDGE_KINDS.map((k) => `'${k}'`).join(',')})`,
          { s: seq },
        ).map((e) => edgeKey({ from: e.from_uri, to: e.to_uri, kind: e.kind, props: e.props ? JSON.parse(e.props) : undefined })),
      );
    let pairs = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(seqs.length - 1), fc.nat(seqs.length - 1), async (i, j) => {
        const [f, t] = [seqs[i]!, seqs[j]!];
        const r = await fx.index.graphChanges({ from: f.sha, to: t.sha });
        const A = at(f.seq);
        const Bs = at(t.seq);
        const added = new Set([...Bs].filter((k) => !A.has(k)));
        const removed = new Set([...A].filter((k) => !Bs.has(k)));
        expect(new Set(r.edgesAdded.map(edgeKey))).toEqual(added);
        expect(new Set(r.edgesRemoved.map(edgeKey))).toEqual(removed);
        pairs++;
      }),
      { seed: SEED, numRuns: 60 },
    );
    report.push(`changes: ${pairs} commit pairs match the exact edge set difference`);
  }, 120_000);
});

describe('excerpts', () => {
  it('random line ranges link to the right section and version, with a subset of its symbols and code refs', async () => {
    const sections = rows<{ uri: string; line_start: number; line_end: number }>('SELECT uri, line_start, line_end FROM sections WHERE line_start IS NOT NULL');
    const targets = (u: string, k: EdgeKind) => new Set(rows<{ t: string }>('SELECT to_uri AS t FROM edges WHERE from_uri = ? AND kind = ? AND valid_to IS NULL', u, k).map((r) => r.t));
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(fc.nat(sections.length - 1), fc.nat(1000), fc.nat(1000), fc.boolean(), async (i, x, y, versioned) => {
        const s = sections[i]!;
        const len = s.line_end - s.line_start + 1;
        const a = s.line_start + (x % len);
        const b = Math.min(s.line_end, a + (y % len));
        const m = parseRef(s.uri)! as MandateRef;
        let commit: string | undefined;
        let sectionVersion: string | undefined;
        if (versioned) {
          // The version current at HEAD (so the HEAD line numbers apply).
          const head = (await fx.git.head())!;
          const v = await fx.index.resolveRef({ ref: buildRef({ ...m, commit: head }) });
          // Lines refer to the file at the pinned commit: pin HEAD (whose version of the section is v).
          commit = head;
          sectionVersion = v.node.uri;
        }
        const ref = buildRef({ ...m, commit, lines: { start: a, end: b } });
        const r = await fx.index.graphNode({ uri: ref, limit: 100 });
        expect(r.node.kind).toBe('excerpt');
        const out = (k: string) => r.neighbors.find((g) => g.direction === 'out' && g.kind === k)?.nodes.map((n) => n.uri) ?? [];
        expect(out('excerpt_of')).toEqual([sectionVersion ?? s.uri]);
        for (const sym of out('mentions_symbol')) expect(targets(s.uri, 'mentions_symbol')).toContain(sym);
        for (const c of out('references_code')) expect(targets(s.uri, 'references_code')).toContain(c);
        checked++;
      }),
      { seed: SEED, numRuns: 300 },
    );
    // Whole-doc excerpts map lines to the containing section.
    for (const s of sections.slice(0, 20)) {
      const m = parseRef(s.uri)!;
      const r = await fx.index.resolveRef({ ref: buildRef({ kind: m.kind, id: m.id, lines: { start: s.line_start, end: s.line_start } }) });
      expect(r.node.props.sections).toEqual([m.sectionId]);
      const text = (await fx.git.readFileAt((await fx.git.head())!, `${m.kind}/${m.id}.md`))!;
      expect(sectionLineRange(text, m.sectionId!)?.start).toBe(s.line_start);
    }
    report.push(`excerpts: ${checked} random ranges (versioned and live)`);
  }, 120_000);
});

describe('search entry points', () => {
  it('every hit ref resolves and is navigable', async () => {
    let hits = 0;
    for (const q of ['refresh token rotation', 'login', 'stripe webhook', 'rate limit', 'audit', 'dark mode', 'MFA recovery codes', 'claims heartbeat', 'pagination cursor', 'accessibility focus']) {
      for (const mode of ['hybrid', 'text', 'semantic'] as const) {
        const r = await fx.index.search({ q, mode, limit: 20 });
        for (const h of r.groups.flatMap((g) => g.hits)) {
          const res = await fx.index.resolveRef({ ref: h.uri });
          await fx.index.graphNeighbors({ uri: res.node.ref });
          hits++;
        }
      }
    }
    expect(hits).toBeGreaterThan(50);
    report.push(`search: ${hits} hits resolved and navigated`);
  }, 120_000);
});

describe('scale and safety', () => {
  it('depth-3 traversal from the most connected node paginates consistently', async () => {
    const structural = `kind NOT IN (${COMMIT_EDGE_KINDS.map((k) => `'${k}'`).join(',')}) AND valid_to IS NULL`;
    const top = rows<{ u: string }>(
      `SELECT u FROM (SELECT from_uri AS u FROM edges WHERE ${structural} UNION ALL SELECT to_uri FROM edges WHERE ${structural}) GROUP BY u ORDER BY COUNT(*) DESC LIMIT 1`,
    )[0]!.u;
    const all = await fx.index.graphNeighbors({ uri: top, depth: 3, limit: 500 });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await fx.index.graphNeighbors({ uri: top, depth: 3, limit: 37, cursor });
      for (const n of p.nodes) {
        expect(seen).not.toContain(n.uri);
        seen.push(n.uri);
      }
      cursor = p.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 1000);
    expect(seen.length).toBeGreaterThan(50);
    if (!all.nextCursor) expect(new Set(seen)).toEqual(new Set(all.nodes.map((n) => n.uri)));
    for (const dir of ['out', 'in', 'both'] as const) await fx.index.graphNeighbors({ uri: top, depth: 3, direction: dir, kinds: [...EDGE_KINDS], limit: 500 });
    report.push(`scale: ${top} depth 3 → ${seen.length} nodes over ${pages} pages`);
  }, 120_000);

  it('prints the report', () => {
    console.info(`graph navigation:\n  ${report.join('\n  ')}`);
  });
});
