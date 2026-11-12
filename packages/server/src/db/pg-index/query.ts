/**
 * Read paths on the Postgres index (mirror.ts): hybrid search primitives and the temporal graph / lineage walk.
 *
 * Ranking vs SQLite:
 * - lexical: `ts_rank_cd(weights, tsv, query, 32)` over a weighted tsvector (title A, summary / symbols B, body D:
 *   the BM25 column weights 5 : 3 : 1). No IDF and no length saturation (cover density instead); `english` stemming
 *   is close to porter but its stop-word list differs. Like SQLite: all terms first (precise), then any term.
 * - hybrid results stay comparable because fusion is RRF over ranks (1 / (60 + rank)), never raw scores.
 * - vectors: pgvector HNSW (cosine), exact model filter through a partial index per model; equal to vec0's exact
 *   KNN up to the HNSW approximation.
 */
import { LINEAGE_EDGES, type EdgeKind } from '@mandate/shared';
import { vectorTableName } from './mirror.js';
import type { Db } from '../types.js';

export const RRF_K = 60;
export const TS_WEIGHTS = '{0.2,0.4,0.6,1.0}';

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1);

/** Lexical search: uris best first (all terms, then any term). */
export async function pgLexical(db: Db, query: string, limit = 200): Promise<{ uri: string; score: number }[]> {
  const terms = words(query);
  if (!terms.length) return [];
  const t = db.dialect.table('fts_sections');
  const run = (op: '&' | '|') =>
    db.all<{ uri: string; score: number }>(
      `SELECT f.uri, ts_rank_cd('${TS_WEIGHTS}'::float4[], f.tsv, q, 32) AS score
         FROM ${t} f, to_tsquery('english', ?) q WHERE f.tsv @@ q ORDER BY score DESC, f.uri LIMIT ?`,
      [terms.map((w) => `'${w.replace(/'/g, "''")}':*`).join(` ${op} `), limit],
    );
  const all = await run('&');
  if (terms.length === 1) return all;
  const seen = new Set(all.map((r) => r.uri));
  return [...all, ...(await run('|')).filter((r) => !seen.has(r.uri))];
}

/** Literal substring search over the raw text (pg_trgm GIN accelerates ILIKE). */
export async function pgLiteral(db: Db, text: string, limit = 200): Promise<string[]> {
  const pat = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return (await db.all<{ uri: string }>(`SELECT uri FROM ${db.dialect.table('fts_raw')} WHERE body ILIKE ? ORDER BY uri LIMIT ?`, [pat, limit])).map((r) => r.uri);
}

/** Typo-tolerant symbol names (pg_trgm similarity), best first. */
export async function pgSymbols(db: Db, name: string, limit = 20): Promise<{ name: string; score: number }[]> {
  const sim = db.dialect.ext('similarity');
  return db.all<{ name: string; score: number }>(
    `SELECT name, max(${sim}(name, ?)) AS score FROM ${db.dialect.table('symbols')} WHERE ${sim}(name, ?) > 0.3 GROUP BY name ORDER BY score DESC, name LIMIT ?`,
    [name, name, limit],
  );
}

/** Nearest chunk texts of a model (cosine distance), restricted to texts still indexed. */
export async function pgKnn(db: Db, modelId: string, vector: Float32Array | number[], k = 40): Promise<{ hash: string; distance: number }[]> {
  const d = db.dialect;
  const dims = vector.length;
  const rows = await db.tx(
    async (q) => {
      await q.exec('SET LOCAL hnsw.ef_search = 100');
      return q.all<{ hash: string; distance: number }>(
        `SELECT v.content_hash AS hash, v.embedding ${d.extOp('<=>')} ?::${d.ext('vector')} AS distance
           FROM ${d.table(vectorTableName(dims))} v WHERE v.model_id = ?
          ORDER BY v.embedding ${d.extOp('<=>')} ?::${d.ext('vector')} LIMIT ?`,
        [`[${Array.from(vector).join(',')}]`, modelId, `[${Array.from(vector).join(',')}]`, k * 3],
      );
    },
    { readOnly: true, statementTimeoutMs: 2000 },
  );
  if (!rows.length) return [];
  const live = new Set((await db.all<{ h: string }>(`SELECT DISTINCT content_hash AS h FROM ${d.table('chunks')} WHERE content_hash = ANY(?)`, [rows.map((r) => r.hash) as never])).map((r) => r.h));
  return rows.filter((r) => live.has(r.hash)).slice(0, k);
}

/** Reciprocal-rank fusion of ranked uri lists (the same fusion search.ts applies). */
export function rrf(lists: { uris: string[]; weight?: number }[]): { uri: string; score: number }[] {
  const score = new Map<string, number>();
  for (const l of lists) l.uris.forEach((u, i) => score.set(u, (score.get(u) ?? 0) + (l.weight ?? 1) / (RRF_K + i + 1)));
  return [...score].map(([uri, s]) => ({ uri, score: s })).sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri));
}

/** Hybrid search on Postgres: lexical + semantic (chunks → their entries), fused with RRF. */
export async function pgHybrid(db: Db, input: { q: string; modelId?: string; vector?: Float32Array | number[]; limit?: number }): Promise<{ uri: string; score: number }[]> {
  const lists: { uris: string[]; weight?: number }[] = [{ uris: (await pgLexical(db, input.q)).map((r) => r.uri) }];
  if (input.vector && input.modelId) {
    const near = await pgKnn(db, input.modelId, input.vector, 40);
    const uris: string[] = [];
    for (const n of near) for (const r of await db.all<{ uri: string }>(`SELECT uri FROM ${db.dialect.table('chunks')} WHERE content_hash = ? ORDER BY uri`, [n.hash])) if (!uris.includes(r.uri)) uris.push(r.uri);
    lists.push({ uris });
  }
  return rrf(lists).slice(0, input.limit ?? 20);
}

/* ---------------------------------------------------------------- temporal graph */

const validSql = (a: string, seq: number | null): { sql: string; params: number[] } =>
  seq === null ? { sql: `${a}.valid_to IS NULL`, params: [] } : { sql: `${a}.valid_from <= ? AND (${a}.valid_to IS NULL OR ${a}.valid_to > ?)`, params: [seq, seq] };

export interface PgEdge {
  from_uri: string;
  to_uri: string;
  kind: string;
  props: string | null;
}

/** Edges valid at `seq` (null = HEAD) leaving (`out`) or entering (`in`) any of `uris`, optionally of some kinds. */
export async function pgEdgesOf(db: Db, uris: string[], dir: 'out' | 'in', seq: number | null, kinds: string[] | null): Promise<PgEdge[]> {
  if (!uris.length) return [];
  const v = validSql('e', seq);
  const col = dir === 'out' ? 'from_uri' : 'to_uri';
  return db.all<PgEdge>(
    `SELECT e.from_uri, e.to_uri, e.kind, e.props FROM ${db.dialect.table('edges')} e WHERE e.${col} = ANY(?) AND ${v.sql}${kinds ? ' AND e.kind = ANY(?)' : ''} ORDER BY e.rid`,
    [uris as never, ...v.params, ...(kinds ? [kinds as never] : [])],
  );
}

export interface LineageWalk {
  /** uri → layer (negative: causes, positive: effects, 0: root). */
  layers: Map<string, number>;
  /** Oriented edges `cause|effect|kind`. */
  edges: Set<string>;
}

/**
 * The lineage walk on Postgres: breadth-first over LINEAGE_EDGES oriented cause → effect (forward: from is the cause;
 * reverse: to is the cause), up (causes) and / or down (effects), at a point in time. One query per hop and direction.
 */
export async function pgLineageWalk(
  db: Db,
  roots: string[],
  opts: { direction: 'up' | 'down' | 'both'; depth: number; seq: number | null; kinds?: EdgeKind[]; limit?: number },
): Promise<LineageWalk> {
  const kinds = (opts.kinds ?? (Object.keys(LINEAGE_EDGES) as EdgeKind[])).filter((k) => LINEAGE_EDGES[k]);
  const forward = kinds.filter((k) => LINEAGE_EDGES[k] === 'forward');
  const reverse = kinds.filter((k) => LINEAGE_EDGES[k] === 'reverse');
  const layers = new Map<string, number>(roots.map((u) => [u, 0]));
  const edges = new Set<string>();
  const limit = opts.limit ?? 500;
  const walk = async (dir: 'up' | 'down') => {
    let frontier = [...roots];
    for (let d = 1; d <= opts.depth && frontier.length; d++) {
      const found: { other: string; cause: string; effect: string; kind: string }[] = [];
      if (dir === 'up') {
        for (const e of await pgEdgesOf(db, frontier, 'in', opts.seq, forward)) found.push({ other: e.from_uri, cause: e.from_uri, effect: e.to_uri, kind: e.kind });
        for (const e of await pgEdgesOf(db, frontier, 'out', opts.seq, reverse)) found.push({ other: e.to_uri, cause: e.to_uri, effect: e.from_uri, kind: e.kind });
      } else {
        for (const e of await pgEdgesOf(db, frontier, 'out', opts.seq, forward)) found.push({ other: e.to_uri, cause: e.from_uri, effect: e.to_uri, kind: e.kind });
        for (const e of await pgEdgesOf(db, frontier, 'in', opts.seq, reverse)) found.push({ other: e.from_uri, cause: e.to_uri, effect: e.from_uri, kind: e.kind });
      }
      const next: string[] = [];
      for (const f of found) {
        if (f.cause === f.effect) continue;
        if (!layers.has(f.other)) {
          if (layers.size >= limit) continue;
          layers.set(f.other, dir === 'up' ? -d : d);
          next.push(f.other);
        }
        edges.add(`${f.cause}|${f.effect}|${f.kind}`);
      }
      frontier = next;
    }
  };
  if (opts.direction !== 'down') await walk('up');
  if (opts.direction !== 'up') await walk('down');
  return { layers, edges };
}
