/**
 * Contract: the Postgres index (published from the SQLite build) answers like the SQLite index.
 * Mirror completeness (incl. after an incremental commit), lineage edges (caused_by / applies_at / violated_at …) and
 * the lineage walk, the Cypher lineage relationships, lexical / vector search and RRF fusion.
 * Runs on PGlite; real Postgres with MANDATE_INDEX_BACKEND=postgres + MANDATE_TEST_PG_URL.
 */
import { LINEAGE_EDGES, relTypeOf, type EdgeKind } from '@mandate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgEdgesOf, pgKnn, pgLexical, pgLineageWalk, pgSymbols, rrf } from '../src/db/pg-index/query.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

process.env.MANDATE_INDEX_BACKEND ??= 'pglite';
let fx: GraphFixture;
beforeAll(async () => {
  fx = await graphFixture();
}, 240_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const lite = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
const pg = () => fx.index.mirror!.db;
const overlap = (a: string[], b: string[]) => (a.length ? a.filter((x) => b.includes(x)).length / Math.min(a.length, b.length) : 1);

/** Reference lineage walk on SQLite (same semantics as pgLineageWalk). */
function liteWalk(roots: string[], dir: 'up' | 'down' | 'both', depth: number, seq: number | null) {
  const valid = seq === null ? 'valid_to IS NULL' : `valid_from <= ${seq} AND (valid_to IS NULL OR valid_to > ${seq})`;
  const kinds = Object.keys(LINEAGE_EDGES) as EdgeKind[];
  const fw = kinds.filter((k) => LINEAGE_EDGES[k] === 'forward');
  const rv = kinds.filter((k) => LINEAGE_EDGES[k] === 'reverse');
  const edgesOf = (us: string[], d: 'out' | 'in', ks: string[]) =>
    lite<{ from_uri: string; to_uri: string; kind: string }>(
      `SELECT from_uri, to_uri, kind FROM edges WHERE ${d === 'out' ? 'from_uri' : 'to_uri'} IN (${us.map(() => '?').join(',')}) AND ${valid} AND kind IN (${ks.map(() => '?').join(',')}) ORDER BY id`,
      ...us,
      ...ks,
    );
  const layers = new Map<string, number>(roots.map((u) => [u, 0]));
  const edges = new Set<string>();
  const walk = (w: 'up' | 'down') => {
    let frontier = [...roots];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const found: [string, string, string, string][] = [];
      if (w === 'up') {
        for (const e of edgesOf(frontier, 'in', fw)) found.push([e.from_uri, e.from_uri, e.to_uri, e.kind]);
        for (const e of edgesOf(frontier, 'out', rv)) found.push([e.to_uri, e.to_uri, e.from_uri, e.kind]);
      } else {
        for (const e of edgesOf(frontier, 'out', fw)) found.push([e.to_uri, e.from_uri, e.to_uri, e.kind]);
        for (const e of edgesOf(frontier, 'in', rv)) found.push([e.from_uri, e.to_uri, e.from_uri, e.kind]);
      }
      const next: string[] = [];
      for (const [other, cause, effect, kind] of found) {
        if (cause === effect) continue;
        if (!layers.has(other)) {
          if (layers.size >= 500) continue;
          layers.set(other, w === 'up' ? -d : d);
          next.push(other);
        }
        edges.add(`${cause}|${effect}|${kind}`);
      }
      frontier = next;
    }
  };
  if (dir !== 'down') walk('up');
  if (dir !== 'up') walk('down');
  return { layers, edges };
}

describe('Postgres index contract', () => {
  it('mirrors every table of the build (rows equal), including lineage edges', async () => {
    for (const t of ['docs', 'sections', 'nodes', 'edges', 'symbols', 'code_refs', 'chunks', 'commits', 'commit_uris', 'commit_parents', 'versions', 'embedding_cache']) {
      const n = lite<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n;
      const m = (await pg().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${pg().dialect.table(t)}`))!.n;
      expect(m, t).toBe(n);
    }
    const kinds = lite<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind ORDER BY kind');
    const pk = await pg().all<{ kind: string; n: number }>(`SELECT kind, COUNT(*) AS n FROM ${pg().dialect.table('edges')} GROUP BY kind ORDER BY kind`);
    expect(pk).toEqual(kinds);
    expect((await pg().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${pg().dialect.table('fts_sections')}`))!.n).toBe(lite<{ n: number }>('SELECT COUNT(*) AS n FROM fts_sections')[0]!.n);
    expect((await pg().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${pg().dialect.table('entries')}`))!.n).toBe(lite<{ n: number }>('SELECT COUNT(*) AS n FROM entries')[0]!.n);
  });

  it('lineage relationships read the same through Cypher on both stores (CAUSED_BY, APPLIES_AT, VIOLATED_AT, …)', async () => {
    const { CypherRunner } = await import('../src/index/cypher/runner.js');
    const { compileCypher } = await import('../src/index/cypher/compile.js');
    const { parseCypher } = await import('../src/index/cypher/parser.js');
    const sqlite = new CypherRunner((fx.index as unknown as { opts: { index: { path: string } } }).opts.index.path, 5000);
    try {
      for (const k of ['caused_by', 'applies_at', 'violated_at', 'resolves', 'targets', 'changed', 'uses_standard'] as EdgeKind[]) {
        for (const q of [`MATCH (a)-[r:${relTypeOf(k)}]->(b) RETURN count(r) AS n`, `MATCH (a)-[r:${relTypeOf(k)}*1..2]->(b) RETURN a.ref, b.ref ORDER BY a.ref, b.ref LIMIT 50`]) {
          const c = compileCypher(parseCypher(q).clauses, { seq: null, params: {}, refs: new Map(), virtualNodes: [], virtualEdges: [], boundVersions: [], rowCap: 500 });
          const want = (await sqlite.run(c.sql, c.binds)) as unknown[][];
          const got = await fx.index.graphQuery({ query: q, params: {}, limit: 500 } as never);
          expect(got.rows.map((r) => r.map((v) => (typeof v === 'number' ? v : String(v)))), `${k}: ${q}`).toEqual(want.map((r) => r.map((v) => (typeof v === 'number' ? v : String(v)))));
        }
      }
      // Sanity: the lineage edges exist in the fixture (counted on the build).
      expect(lite<{ n: number }>("SELECT COUNT(*) AS n FROM edges WHERE kind IN ('caused_by', 'applies_at', 'violated_at')")[0]!.n).toBeGreaterThan(0);
    } finally {
      await sqlite.close();
    }
  });

  it('the lineage walk on Postgres equals the SQLite walk (HEAD and an older point, both directions)', async () => {
    const roots = lite<{ uri: string }>(
      `SELECT uri FROM (SELECT DISTINCT from_uri AS uri FROM edges WHERE kind IN ('caused_by', 'applies_at', 'violated_at', 'targets', 'uses_standard') AND valid_to IS NULL
         UNION SELECT DISTINCT to_uri FROM edges WHERE kind IN ('caused_by', 'applies_at', 'violated_at', 'targets') AND valid_to IS NULL) ORDER BY uri LIMIT 12`,
    ).map((r) => r.uri);
    expect(roots.length).toBeGreaterThan(0);
    const mid = lite<{ s: number }>('SELECT seq AS s FROM commits WHERE mainline = 1 ORDER BY seq LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM commits WHERE mainline = 1)')[0]?.s ?? null;
    for (const seq of [null, mid]) {
      for (const root of roots) {
        const a = liteWalk([root], 'both', 2, seq);
        const b = await pgLineageWalk(pg(), [root], { direction: 'both', depth: 2, seq });
        expect([...b.layers].sort(), `${root}@${seq}`).toEqual([...a.layers].sort());
        expect([...b.edges].sort(), `${root}@${seq}`).toEqual([...a.edges].sort());
      }
    }
    const e = await pgEdgesOf(pg(), roots.slice(0, 3), 'out', null, null);
    expect(e.length).toBe(lite<{ n: number }>(`SELECT COUNT(*) AS n FROM edges WHERE from_uri IN (${roots.slice(0, 3).map(() => '?').join(',')}) AND valid_to IS NULL`, ...roots.slice(0, 3))[0]!.n);
  });

  it('lexical search: weighted tsvector ranking agrees with BM25 on the top results', async () => {
    for (const q of ['session timeout', 'rate limit', 'password reset', 'audit log export', 'dark mode']) {
      const terms = q.split(' ');
      const a = lite<{ uri: string }>(`SELECT uri FROM fts_sections WHERE fts_sections MATCH ? ORDER BY bm25(fts_sections, 0, 0, 5, 3, 1, 3) LIMIT 10`, terms.map((t) => `"${t}"*`).join(' AND ')).map((r) => r.uri);
      const b = (await pgLexical(pg(), q, 10)).map((r) => r.uri);
      if (!a.length) continue;
      expect(b.length, q).toBeGreaterThan(0);
      expect(overlap(a.slice(0, 10), b.slice(0, 10)), q).toBeGreaterThanOrEqual(0.6);
      expect(b.slice(0, 3).some((u) => a.slice(0, 5).includes(u)), q).toBe(true);
    }
  });

  it('vector KNN (pgvector HNSW per model) matches vec0, and RRF fusion is shared', async () => {
    if (!pg().caps.vector) return;
    const rows = lite<{ content_hash: string; vector: Buffer; model_id: string }>('SELECT content_hash, vector, model_id FROM embedding_cache ORDER BY content_hash LIMIT 5');
    for (const r of rows) {
      const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4);
      const a = lite<{ id: string }>(`SELECT id FROM vec_chunks_${v.length} WHERE embedding MATCH ? AND k = 10 AND model_id = ? ORDER BY distance`, v, r.model_id).map((x) => x.id.slice(r.model_id.length + 1));
      const b = (await pgKnn(pg(), r.model_id, v, 10)).map((x) => x.hash);
      expect(b[0]).toBe(r.content_hash);
      expect(overlap(a, b)).toBeGreaterThanOrEqual(0.8);
    }
    expect(rrf([{ uris: ['a', 'b'] }, { uris: ['b', 'c'] }]).map((x) => x.uri)).toEqual(['b', 'a', 'c']);
  });

  it('typo-tolerant symbols (pg_trgm)', async () => {
    const name = lite<{ name: string }>('SELECT name FROM symbols WHERE length(name) > 8 ORDER BY name LIMIT 1')[0]?.name;
    if (!name || !pg().caps.trigram) return;
    const typo = name.slice(0, -2) + name.slice(-1);
    expect((await pgSymbols(pg(), typo)).map((r) => r.name)).toContain(name);
  });

  it('publishes incrementally after a new commit (rows equal again)', async () => {
    const before = fx.index.mirror!.lastPublish;
    const storage = (await import('../src/storage/index.js')).createStorage(fx.git);
    const specs = await storage.specs.list();
    const id = (specs[0] as { id: string }).id;
    const cur = (await storage.specs.get(id)) as { sections: unknown[] };
    await storage.specs.update(id, { sections: [...cur.sections, { id: 'pg-contract', title: 'pg contract', type: 'markdown', body: 'Published incrementally to Postgres.', summary: 'pg' }] } as never, { agent: 'test' } as never);
    await fx.index.sync();
    await fx.index.idle();
    expect(fx.index.mirror!.lastPublish?.mode).toBe('incremental');
    expect(before).not.toBe(fx.index.mirror!.lastPublish);
    for (const t of ['nodes', 'edges', 'sections', 'chunks']) {
      const n = lite<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n;
      expect((await pg().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${pg().dialect.table(t)}`))!.n, t).toBe(n);
    }
    const hit = await pgLexical(pg(), 'published incrementally');
    expect(hit.map((h) => h.uri).some((u) => u.endsWith('/sections/pg-contract'))).toBe(true);
  });
});
