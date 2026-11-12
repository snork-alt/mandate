/**
 * Regression tests for the graph-query review findings (plans/fable-data-review.md §4, GQ-*).
 * Runs on a clone of the fixture repository; synthetic rows are added to the temporary index only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lineageStatus } from '../src/index/lineage.js';
import { commitBySha, expandCode } from '../src/index/resolve.js';
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

const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
const SEP = ' › ';

describe('graph.ts / resolve.ts', () => {
  it('GQ-2: graph_node neighbour counts do not depend on limit (parallel edges counted once)', async () => {
    const dups = rows<{ u: string }>(
      `SELECT from_uri AS u FROM edges WHERE valid_to IS NULL GROUP BY from_uri, to_uri, kind HAVING count(*) > 1
       UNION SELECT to_uri FROM edges WHERE valid_to IS NULL GROUP BY from_uri, to_uri, kind HAVING count(*) > 1 LIMIT 15`,
    ).map((r) => r.u);
    expect(dups.length).toBeGreaterThan(0);
    for (const uri of dups) {
      const counts = async (limit: number) => {
        const r = await fx.index.graphNode({ uri, limit });
        return Object.fromEntries(r.neighbors.map((g) => [`${g.direction}:${g.kind}`, g.count]));
      };
      expect(await counts(1), uri).toEqual(await counts(100));
    }
  });

  it('GQ-4: code paths with _ or % or a different case are not wildcards', () => {
    const range = rows<{ uri: string }>("SELECT uri FROM nodes WHERE kind = 'code_range' AND valid_to IS NULL AND uri LIKE '%.%#%' LIMIT 1")[0]!.uri;
    const file = range.split('#')[0]!;
    expect(expandCode(fx.index.db, file)).toContain(range);
    for (const variant of [file.toUpperCase(), file.replace(/\.([^.]*)$/, '_$1'), file.replace(/\/[^/]+$/, '/%')]) {
      expect(expandCode(fx.index.db, variant), variant).toEqual([variant]);
    }
    // Short shas: `%` / `_` are not wildcards (used to report an ambiguous commit), and case is folded on input.
    const sha = rows<{ sha: string }>('SELECT sha FROM commits LIMIT 1')[0]!.sha;
    expect(commitBySha(fx.index.db, sha.slice(0, 10).toUpperCase()).sha).toBe(sha);
    let code: string | undefined;
    try {
      commitBySha(fx.index.db, '%');
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).not.toBe('ambiguous_commit');
  });

  it('GQ-4: code_rules on a case-variant path does not report the other file', async () => {
    const v = rows<{ uri: string }>("SELECT DISTINCT to_uri AS uri FROM edges WHERE kind IN ('applies_at', 'violated_at') AND valid_to IS NULL AND to_uri LIKE 'mandate://code/%' LIMIT 1")[0]?.uri;
    if (!v) return;
    const file = v.split('#')[0]!;
    const other = file.replace(/\/([^/]+)$/, (_, name: string) => `/${name.toUpperCase()}`);
    if (other === file) return;
    const r = await fx.index.codeRules({ ref: other });
    expect(r.follows.length + r.violates.length).toBe(0);
  });

  it('GQ-14: graph_neighbors stops at the node cap inside a hop and says it truncated', async () => {
    const seq = rows<{ s: number }>('SELECT min(seq) AS s FROM commits WHERE mainline = 1')[0]!.s;
    const hub = 'mandate://agents/gq14-hub';
    const db = fx.index.db;
    const node = db.prepare("INSERT INTO nodes (uri, kind, label, props, source, valid_from, valid_to) VALUES (?, 'agent', ?, '{}', 'gq14', ?, NULL)");
    const edge = db.prepare("INSERT INTO edges (from_uri, to_uri, kind, props, source, valid_from, valid_to) VALUES (?, ?, 'relates_to', NULL, 'gq14', ?, NULL)");
    db.transaction(() => {
      node.run(hub, 'gq14-hub', seq);
      for (let i = 0; i < 5100; i++) {
        const u = `mandate://agents/gq14-n${i}`;
        node.run(u, `gq14-n${i}`, seq);
        edge.run(hub, u, seq);
      }
    })();
    try {
      const r = await fx.index.graphNeighbors({ uri: hub, depth: 1, direction: 'out', limit: 10 });
      expect(r.truncated).toBe(true);
      const small = await fx.index.graphNeighbors({ uri: 'mandate://agents/gq14-n0', depth: 1, direction: 'in', limit: 10 });
      expect(small.truncated).toBeUndefined();
    } finally {
      db.prepare("DELETE FROM edges WHERE source = 'gq14'").run();
      db.prepare("DELETE FROM nodes WHERE source = 'gq14'").run();
    }
  });
});

describe('lineage.ts', () => {
  const ruleFollowsFromWorkOrders = () =>
    rows<{ code: string }>(
      `SELECT DISTINCT t.to_uri AS code FROM edges t JOIN nodes w ON w.uri = t.from_uri AND w.valid_to IS NULL
        WHERE t.kind = 'touches' AND t.valid_to IS NULL AND w.kind = 'work_order' AND json_extract(w.props, '$.status') = 'done' LIMIT 40`,
    ).map((r) => r.code);

  it('GQ-3: code_rules work-order follows agree with standard_where_used', async () => {
    for (const code of ruleFollowsFromWorkOrders()) {
      const r = await fx.index.codeRules({ ref: code });
      const targets = new Set([...expandCode(fx.index.db, code), code.split('#')[0]!]);
      for (const f of r.follows.filter((x) => x.source?.startsWith('mandate://work-orders/'))) {
        const w = await fx.index.whereUsed({ ref: f.rule, limit: 2000 });
        const hit = w.locations.some((l) => l.rule === f.rule && targets.has(l.uri));
        expect(hit, `${code} follows ${f.rule} via ${f.source}, absent from where_used`).toBe(true);
      }
    }
    // The fixture's spec-wide case (flush.ts via q-0002 covering specs/usage-metering) must not credit doc-level rules.
    const flush = await fx.index.codeRules({ ref: 'mandate://code/api/src/metering/flush.ts#L30-L95' }).catch(() => null);
    if (flush) expect(flush.follows.filter((f) => f.source === 'mandate://work-orders/q-0002' && f.rule.includes('api-conventions'))).toEqual([]);
  }, 120_000);

  it('GQ-6: lineage summary counts code touched by a done work order as changed files', async () => {
    const wo = rows<{ uri: string }>(
      `SELECT DISTINCT t.from_uri AS uri FROM edges t JOIN nodes w ON w.uri = t.from_uri AND w.valid_to IS NULL
        WHERE t.kind = 'touches' AND t.valid_to IS NULL AND w.kind = 'work_order' AND json_extract(w.props, '$.status') = 'done' LIMIT 1`,
    )[0]?.uri;
    expect(wo).toBeTruthy();
    const r = await fx.index.lineage({ ref: wo!, direction: 'down', depth: 2 });
    const code = r.nodes.filter((n) => n.layer > 0 && (n.kind === 'code_file' || n.kind === 'code_range'));
    expect(code.length).toBeGreaterThan(0);
    for (const n of code) expect(n.status, n.uri).toBe('done');
    expect(r.summary.changed.files).toBeGreaterThan(0);
  });

  it('GQ-7: status mapping (comments, feedback resolution, unclaimed pending work orders, no promotion over own status)', async () => {
    expect(lineageStatus({ kind: 'comment', props: { status: 'open' } }).status).toBe('attention');
    expect(lineageStatus({ kind: 'comment', props: { status: 'resolved' } }).status).toBe('done');
    expect(lineageStatus({ kind: 'feedback', props: { status: 'closed', resolution: 'applied' } }).status).toBe('done');
    expect(lineageStatus({ kind: 'feedback', props: { status: 'closed', resolution: 'rejected' } }).status).toBe('neutral');
    expect(lineageStatus({ kind: 'feedback', props: { status: 'closed', resolution: 'duplicate' } }).status).toBe('neutral');
    expect(lineageStatus({ kind: 'work_order', props: { status: 'pending' } }).status).toBe('neutral');
    expect(lineageStatus({ kind: 'work_order', props: { status: 'pending', claim: { agent: 'a' } } }).status).toBe('in_progress');
    expect(lineageStatus({ kind: 'work_order', props: { status: 'in_progress' } }).status).toBe('in_progress');
    // End to end: no node whose own status is open/rejected is promoted to done by a recorded edge.
    const wos = rows<{ uri: string }>("SELECT uri FROM nodes WHERE kind = 'work_order' AND valid_to IS NULL ORDER BY uri LIMIT 10").map((r) => r.uri);
    for (const wo of wos) {
      const r = await fx.index.lineage({ ref: wo, direction: 'both', depth: 2 });
      for (const n of r.nodes) {
        if (n.rawStatus === 'open') expect(n.status, `${n.uri} (${n.kind}, open)`).not.toBe('done');
        if (n.kind === 'comment' && n.rawStatus === 'open') expect(n.status).toBe('attention');
      }
    }
  }, 120_000);

  it('GQ-8: code_rules labels do not repeat the standard title', async () => {
    const codes = rows<{ uri: string }>(
      "SELECT DISTINCT to_uri AS uri FROM edges WHERE kind IN ('applies_at', 'violated_at') AND valid_to IS NULL AND to_uri LIKE 'mandate://code/%' LIMIT 20",
    ).map((r) => r.uri);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of [...codes, ...ruleFollowsFromWorkOrders().slice(0, 10)]) {
      const r = await fx.index.codeRules({ ref: code });
      for (const x of [...r.follows, ...r.violates]) {
        const parts = x.label.split(SEP);
        expect(new Set(parts).size, x.label).toBe(parts.length);
        expect(parts.length).toBeLessThanOrEqual(2);
      }
    }
  });
});
