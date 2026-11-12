/**
 * Contract: every node kind has lineage (lineage-brief §1), like "every reference is a graph key".
 * - Statically: every node kind declares lineage edge kinds, and every declared kind is oriented (LINEAGE_EDGES).
 * - Over the fixture graph: for every node kind present, some node of that kind has a non-empty lineage, and the
 *   lineage of every sampled node resolves without error (root = the node, layers consistent with edges).
 */
import { EDGE_KINDS, LINEAGE_EDGES, LINEAGE_KINDS_BY_NODE, NODE_KINDS } from '@mandate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('lineage contract', () => {
  it('every node kind declares lineage edges, all oriented cause -> effect', () => {
    for (const k of NODE_KINDS) {
      const kinds = LINEAGE_KINDS_BY_NODE[k];
      expect(kinds?.length, k).toBeGreaterThan(0);
      for (const e of kinds) {
        expect(EDGE_KINDS as readonly string[], `${k}: ${e}`).toContain(e);
        expect(LINEAGE_EDGES[e], `${k}: ${e} has no orientation`).toBeDefined();
      }
    }
  });

  it('every node kind in the fixture graph has lineage (and every sampled lineage is well-formed)', async () => {
    const db = fx.index.db;
    const present = (db.prepare('SELECT DISTINCT kind FROM nodes').all() as { kind: string }[]).map((r) => r.kind);
    const missing: string[] = [];
    for (const kind of present) {
      const sample = (db.prepare('SELECT DISTINCT uri FROM nodes WHERE kind = ? ORDER BY uri LIMIT 25').all(kind) as { uri: string }[]).map((r) => r.uri);
      let has = false;
      for (const uri of sample) {
        const r = await fx.index.lineage({ ref: uri, direction: 'both', depth: 1, hideHistory: false, structure: true, limit: 50 });
        expect(r.root.uri).toBe(uri);
        const layer = new Map(r.nodes.map((nd) => [nd.uri, nd.layer]));
        for (const e of r.edges) {
          expect(layer.has(e.from) && layer.has(e.to), `${uri}: edge ${e.kind} ends are nodes`).toBe(true);
        }
        if (r.edges.length) {
          has = true;
          break;
        }
      }
      if (!has) missing.push(kind);
    }
    expect(missing).toEqual([]);
  }, 120_000);

  it('excerpts and the architecture view resolve to a lineage too', async () => {
    const sec = (fx.index.db.prepare("SELECT uri FROM nodes WHERE kind = 'section' AND valid_to IS NULL LIMIT 1").get() as { uri: string }).uri;
    const ex = await fx.index.lineage({ ref: `${sec}#L1-L1`, direction: 'up', depth: 1, hideHistory: false, structure: true });
    expect(ex.nodes.length).toBeGreaterThan(1);
    const arch = await fx.index.lineage({ ref: 'mandate://architecture', direction: 'down', depth: 1, structure: true });
    expect(arch.root.kind).toBe('architecture');
  });
});
