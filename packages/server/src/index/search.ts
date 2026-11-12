import {
  codeSearchInputSchema,
  historySearchInputSchema,
  metadataQueryInputSchema,
  relatedInputSchema,
  searchInputSchema,
  symbolSearchInputSchema,
  textSearchInputSchema,
  buildNodeUri,
  parseNodeUri,
  type CodeSearchInput,
  type CodeSearchResponse,
  type CommitRecord,
  type DocKind,
  type HistorySearchInput,
  type HistorySearchResponse,
  type MatchSource,
  type MetadataItem,
  type MetadataQueryInput,
  type MetadataResponse,
  type RelatedInput,
  type RelatedResponse,
  type SearchHit,
  type SearchInput,
  type SearchKind,
  type SearchResponse,
  type SymbolResult,
  type SymbolSearchInput,
  type SymbolSearchResponse,
  type TextMatch,
  type TextSearchInput,
  type TextSearchResponse,
} from '@mandate/shared';
import { parseJson, type DB } from './db.js';
import { fromBlob, vecId } from './embed/queue.js';
import type { EmbeddingProvider } from './embed/types.js';
import { ftsQuote, identifierParts, normalizeSymbol, trigrams, trigramSimilarity } from './identifiers.js';
import { selfOrSections } from './resolve.js';

/** What the search functions need from the index service. */
export interface SearchContext {
  db: DB;
  /** Null when semantic search is disabled (`provider: none`). */
  provider: EmbeddingProvider | null;
  queryPrefix: string;
  vecTable: string | null;
  /** Chunks still waiting for vectors. */
  pending(): number;
  /** Set while semantic search is paused (model switch without a usable previous model): the reason. */
  unavailable?(): string | null;
  /** Section ids of a spec changed since they were implemented (metadata_query `outdated`). */
  outdatedSections?(specId: string): Promise<string[]>;
  /** Cached query embeddings. */
  queryCache?: Map<string, Float32Array>;
  /** Effective heartbeat of a work order's claim (runtime state; git only stores startedAt). */
  claimHeartbeat?(workOrderId: string, claim: { agent: string; startedAt: string }): string;
}

/** Claims with no heartbeat for this long are stale (same rule as the web UI). */
export const CLAIM_STALE_AFTER_MS = 30 * 60_000;
const RRF_K = 60;
const STOP = new Set(
  'a an and are as at be by do does for from how i in is it of on or that the this to was what when where which who why with you your can should'.split(' '),
);

/* ------------------------------------------------------------------ helpers */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
export function decodeCursor(c?: string): number {
  if (!c) return 0;
  const n = Number(Buffer.from(c, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Query words (lowercase, no stop words); falls back to all words when only stop words are given. */
export function queryTerms(q: string): string[] {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1 || /\d/.test(w));
  const content = words.filter((w) => !STOP.has(w));
  return [...new Set(content.length ? content : words)];
}

/** Escaped excerpt around the first matching term, with `<mark>` highlights. */
export function highlight(text: string, terms: string[], max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!terms.length) return escapeHtml(flat.length > max ? `${flat.slice(0, max)}…` : flat);
  const re = new RegExp(`(${terms.map((t) => escapeRe(t)).join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  const first = flat.search(re);
  let start = first > 60 ? flat.lastIndexOf(' ', first - 40) + 1 : 0;
  if (start < 0) start = 0;
  let piece = flat.slice(start, start + max);
  if (start + max < flat.length) piece += '…';
  if (start > 0) piece = `…${piece}`;
  return escapeHtml(piece).replace(new RegExp(`(${terms.map((t) => escapeRe(escapeHtml(t))).join('|')})[\\p{L}\\p{N}_]*`, 'giu'), '<mark>$&</mark>');
}

/** Upper bound for date-only `until` values. */
const until = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999Z` : d);

interface Filters {
  kinds?: SearchKind[];
  status?: string[];
  category?: string[];
  repo?: string[];
  tags?: string[];
  standards?: string[];
  sectionType?: string[];
  updatedSince?: string;
  updatedUntil?: string;
  within?: string;
}

/** SQL conditions on the `entries` view (alias `e`). */
export function filterSql(f: Filters, e = 'e'): { sql: string; params: unknown[] } {
  const c: string[] = [];
  const p: unknown[] = [];
  const inList = (col: string, vals?: string[]) => {
    if (!vals?.length) return;
    c.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
    p.push(...vals);
  };
  if (f.kinds?.length) {
    const docKinds = f.kinds.filter((k) => k !== 'section');
    const parts: string[] = [];
    if (docKinds.length) {
      parts.push(`${e}.doc_kind IN (${docKinds.map(() => '?').join(', ')})`);
      p.push(...docKinds);
    }
    if (f.kinds.includes('section')) parts.push(`${e}.kind = 'section'`);
    c.push(`(${parts.join(' OR ')})`);
  }
  inList(`${e}.status`, f.status);
  inList(`${e}.category`, f.category);
  inList(`${e}.repo`, f.repo);
  inList(`${e}.section_type`, f.sectionType);
  for (const t of f.tags ?? []) {
    c.push(`EXISTS (SELECT 1 FROM json_each(${e}.tags) WHERE value = ?)`);
    p.push(t);
  }
  if (f.standards?.length) {
    c.push(`EXISTS (SELECT 1 FROM json_each(${e}.standards) WHERE value IN (${f.standards.map(() => '?').join(', ')}))`);
    p.push(...f.standards);
  }
  if (f.updatedSince) {
    c.push(`${e}.updated_at >= ?`);
    p.push(f.updatedSince);
  }
  if (f.updatedUntil) {
    c.push(`${e}.updated_at <= ?`);
    p.push(until(f.updatedUntil));
  }
  if (f.within) {
    c.push(f.within.includes('/sections/') ? `${e}.uri = ?` : `${e}.doc_uri = ?`);
    p.push(f.within);
  }
  return { sql: c.length ? c.join(' AND ') : '1', params: p };
}

interface EntryRow {
  uri: string;
  doc_uri: string;
  kind: SearchKind;
  doc_kind: DocKind;
  doc_title: string;
  section_id: string | null;
  section_title: string | null;
  section_type: string | null;
  status: string | null;
  category: string | null;
  repo: string | null;
  tags: string;
  line_start: number | null;
  line_end: number | null;
}

interface ChunkRow {
  uri: string;
  chunk_index: number;
  kind: string;
  line_start: number | null;
  line_end: number | null;
  content_hash: string;
  text: string;
}

async function queryVector(ctx: SearchContext, q: string): Promise<Float32Array> {
  const cache = (ctx.queryCache ??= new Map());
  const key = `${ctx.provider!.modelId}\u0000${q}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [v] = await ctx.provider!.embed([ctx.queryPrefix + q]);
  cache.set(key, v!);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return v!;
}

/** Nearest chunks to a vector (current model only), best first. */
export function knn(ctx: SearchContext, vector: Float32Array, k: number): { hash: string; distance: number }[] {
  if (!ctx.provider || !ctx.vecTable) return [];
  const model = ctx.provider.modelId;
  const rows = ctx.db
    .prepare(`SELECT id, distance FROM ${ctx.vecTable} WHERE embedding MATCH ? AND k = ? AND model_id = ? ORDER BY distance`)
    .all(vector, Math.min(4096, k), model) as { id: string; distance: number }[];
  return rows.map((r) => ({ hash: r.id.slice(model.length + 1), distance: r.distance }));
}

function semanticStatus(ctx: SearchContext): { ok: boolean; reason?: string } {
  const paused = ctx.unavailable?.();
  if (paused) return { ok: false, reason: paused };
  if (!ctx.provider || !ctx.vecTable) return { ok: false, reason: 'semantic search is disabled (embedding.provider is "none")' };
  const n = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${ctx.vecTable} WHERE model_id = ?`).get(ctx.provider.modelId) as { n: number }).n;
  if (!n) return { ok: false, reason: 'no vectors yet for the current model (embedding in progress)' };
  return { ok: true };
}

/* ------------------------------------------------------------------ hybrid search */

/** Hybrid (BM25 + vectors + symbols, fused with RRF), text or semantic search, grouped by document. */
export async function search(ctx: SearchContext, input: SearchInput): Promise<SearchResponse> {
  const inp = searchInputSchema.parse(input);
  const { db } = ctx;
  const where = filterSql(inp);
  const terms = queryTerms(inp.q);
  const ranks = new Map<string, { score: number; by: Set<MatchSource>; chunk?: ChunkRow; snippet?: string }>();
  const add = (uri: string, rank: number, by: MatchSource, weight = 1) => {
    const r = ranks.get(uri) ?? { score: 0, by: new Set<MatchSource>() };
    r.score += weight / (RRF_K + rank);
    r.by.add(by);
    ranks.set(uri, r);
    return r;
  };

  if (inp.mode !== 'semantic' && terms.length) {
    // All terms first (precise), then any term (recall, down-weighted).
    const stmt = db.prepare(
      `SELECT f.uri, snippet(fts_sections, -1, char(1), char(2), '…', 24) AS snip, bm25(fts_sections, 0, 0, 5, 3, 1, 3) AS score
         FROM fts_sections f JOIN entries e ON e.uri = f.uri
        WHERE fts_sections MATCH ? AND ${where.sql} ORDER BY score LIMIT 200`,
    );
    const all = stmt.all(terms.map(ftsQuote).join(' AND '), ...where.params) as { uri: string; snip: string; score: number }[];
    const any = terms.length > 1 ? (stmt.all(terms.map(ftsQuote).join(' OR '), ...where.params) as typeof all) : [];
    const seen = new Set(all.map((r) => r.uri));
    const weight = all.length ? 1 : 0.5;
    [...all, ...any.filter((r) => !seen.has(r.uri))].forEach((r, i) => {
      const hit = add(r.uri, i + 1, 'text', i < all.length ? 1 : weight);
      hit.snippet = escapeHtml(r.snip.replace(/\s+/g, ' ')).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
    });
  }

  if (inp.mode !== 'semantic') {
    // Symbols: the whole query and identifier-like words.
    const candidates = [inp.q.trim(), ...inp.q.split(/\s+/).filter((w) => /[._:A-Z]/.test(w.slice(1)) || w.includes('_'))];
    let rank = 0;
    const seen = new Set<string>();
    for (const cand of candidates) {
      const syms = symbolMatches(db, cand, 'exact', 20);
      for (const s of syms) {
        for (const use of s.uses) {
          if (seen.has(use)) continue;
          const ok = db.prepare(`SELECT 1 FROM entries e WHERE e.uri = ? AND ${where.sql}`).get(use, ...where.params);
          if (!ok) continue;
          seen.add(use);
          add(use, ++rank, 'symbol', s.match === 'exact' || s.match === 'normalized' ? 3 : 1);
        }
      }
    }
  }

  const sem = semanticStatus(ctx);
  let semanticUsed = false;
  if (inp.mode !== 'text' && sem.ok) {
    try {
      const v = await queryVector(ctx, inp.q);
      const near = knn(ctx, v, 40);
      const chunkStmt = db.prepare(
        `SELECT c.uri, c.chunk_index, c.kind, c.line_start, c.line_end, c.content_hash, c.text FROM chunks c JOIN entries e ON e.uri = c.uri WHERE c.content_hash = ? AND ${where.sql}`,
      );
      let rank = 0;
      for (const n of near) {
        for (const c of chunkStmt.all(n.hash, ...where.params) as ChunkRow[]) {
          if (ranks.get(c.uri)?.by.has('semantic')) continue;
          const hit = add(c.uri, ++rank, 'semantic');
          hit.chunk ??= c;
        }
      }
      semanticUsed = true;
    } catch (e) {
      sem.reason = `semantic search failed: ${(e as Error).message}`;
    }
  }

  // Resolve hits.
  const entryStmt = db.prepare('SELECT * FROM entries WHERE uri = ?');
  const chunksOf = db.prepare('SELECT uri, chunk_index, kind, line_start, line_end, content_hash, text FROM chunks WHERE uri = ? ORDER BY chunk_index');
  const hits: (SearchHit & { entry: EntryRow })[] = [];
  for (const [uri, r] of ranks) {
    const e = entryStmt.get(uri) as EntryRow | undefined;
    if (!e) continue;
    let chunk = r.chunk;
    if (!chunk && terms.length) {
      // Best chunk for the text match: most query terms.
      const all = (chunksOf.all(uri) as ChunkRow[]).filter((c) => c.kind !== 'summary');
      let best = -1;
      for (const c of all) {
        const low = c.text.toLowerCase();
        const n = terms.filter((t) => low.includes(t)).length;
        if (n > best) {
          best = n;
          chunk = c;
        }
      }
    }
    const lines =
      chunk?.line_start && chunk.kind !== 'summary'
        ? { start: chunk.line_start, end: chunk.line_end ?? chunk.line_start }
        : e.line_start
          ? { start: e.line_start, end: e.line_end ?? e.line_start }
          : undefined;
    const base = lines ? `${uri}#L${lines.start}${lines.end > lines.start ? `-L${lines.end}` : ''}` : uri;
    hits.push({
      uri: base,
      docUri: e.doc_uri,
      docTitle: e.doc_title,
      sectionId: e.section_id ?? undefined,
      sectionTitle: e.section_title ?? undefined,
      kind: e.kind,
      docKind: e.doc_kind,
      snippet: (() => {
        const fromChunk = chunk ? highlight(chunk.text || chunk.uri, terms) : '';
        if (fromChunk.includes('<mark>') || !r.snippet) return fromChunk || r.snippet || '';
        return r.snippet;
      })(),
      score: Number(r.score.toFixed(6)),
      matchedBy: (['text', 'semantic', 'symbol'] as MatchSource[]).filter((m) => r.by.has(m)),
      lines,
      entry: e,
    });
  }
  hits.sort((a, b) => b.score - a.score);

  // Facets over every hit.
  const facets: SearchResponse['facets'] = { kinds: {}, status: {}, category: {}, repo: {}, tags: {}, sectionType: {} };
  const inc = (m: Record<string, number>, k: string | null | undefined) => {
    if (k) m[k] = (m[k] ?? 0) + 1;
  };
  for (const h of hits) {
    inc(facets.kinds, h.kind);
    inc(facets.status, h.entry.status);
    inc(facets.category, h.entry.category);
    inc(facets.repo, h.entry.repo);
    inc(facets.sectionType, h.entry.section_type);
    for (const t of parseJson<string[]>(h.entry.tags, [])) inc(facets.tags, t);
  }

  // Group by document.
  const groups = new Map<string, SearchResponse['groups'][number]>();
  for (const { entry, ...h } of hits) {
    let g = groups.get(h.docUri);
    if (!g) {
      g = { docUri: h.docUri, docTitle: h.docTitle, docKind: h.docKind, status: entry.status ?? undefined, category: entry.category ?? undefined, score: h.score, hits: [] };
      groups.set(h.docUri, g);
    }
    if (g.hits.length < 5) g.hits.push(h);
  }
  const all = [...groups.values()];
  const offset = decodeCursor(inp.cursor);
  const page = all.slice(offset, offset + inp.limit);
  return {
    query: inp.q,
    mode: inp.mode,
    groups: page,
    facets,
    total: hits.length,
    nextCursor: offset + inp.limit < all.length ? encodeCursor(offset + inp.limit) : null,
    semantic: { used: semanticUsed, reason: semanticUsed ? undefined : inp.mode === 'text' ? 'text mode' : sem.reason, pending: ctx.pending() },
  };
}

/* ------------------------------------------------------------------ literal / regex */

/** Exact phrase or regex over stored source text (no stemming), line by line. */
export function textSearch(ctx: SearchContext, input: TextSearchInput): TextSearchResponse {
  const inp = textSearchInputSchema.parse(input);
  const { db } = ctx;
  const where = filterSql(inp);
  let pattern = inp.regex ? inp.q : escapeRe(inp.q);
  if (inp.wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  const re = new RegExp(pattern, `gu${inp.caseSensitive ? '' : 'i'}`);

  // Trigram prefilter: a literal (or the longest literal run of a simple regex) must occur.
  let literal: string | null = inp.regex ? null : inp.q;
  if (inp.regex && !/[|]/.test(inp.q)) {
    const runs = inp.q.split(/\\.|[.*+?^${}()[\]]/).filter((r) => r.length >= 3);
    literal = runs.sort((a, b) => b.length - a.length)[0] ?? null;
  }
  const rows = (
    literal && literal.length >= 3
      ? db
          .prepare(`SELECT r.uri, r.body, e.* FROM fts_raw r JOIN entries e ON e.uri = r.uri WHERE fts_raw MATCH ? AND ${where.sql} ORDER BY e.doc_uri, e.line_start`)
          .all(ftsQuote(literal), ...where.params)
      : db.prepare(`SELECT r.uri, r.body, e.* FROM fts_raw r JOIN entries e ON e.uri = r.uri WHERE ${where.sql} ORDER BY e.doc_uri, e.line_start`).all(...where.params)
  ) as (EntryRow & { body: string })[];

  const matches: TextMatch[] = [];
  for (const r of rows) {
    const first = r.line_start ?? 1;
    r.body.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (!re.test(line)) return;
      re.lastIndex = 0;
      const n = first + i;
      let text = '';
      let last = 0;
      for (const m of line.matchAll(re)) {
        if (!m[0]) continue;
        text += `${escapeHtml(line.slice(last, m.index))}<mark>${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      text += escapeHtml(line.slice(last));
      matches.push({
        uri: `${r.uri}#L${n}`,
        docUri: r.doc_uri,
        docTitle: r.doc_title,
        sectionId: r.section_id ?? undefined,
        sectionTitle: r.section_title ?? undefined,
        kind: r.kind,
        line: n,
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      });
    });
  }
  const offset = decodeCursor(inp.cursor);
  return {
    matches: matches.slice(offset, offset + inp.limit),
    total: matches.length,
    nextCursor: offset + inp.limit < matches.length ? encodeCursor(offset + inp.limit) : null,
  };
}

/* ------------------------------------------------------------------ symbols */

interface SymbolMatch {
  name: string;
  match: SymbolResult['match'];
  score: number;
  uses: string[];
}

function symbolMatches(db: DB, query: string, mode: 'exact' | 'prefix' | 'fuzzy', limit: number): SymbolMatch[] {
  const q = query.trim();
  if (!q) return [];
  const norm = normalizeSymbol(q);
  const qparts = identifierParts(q);
  const all = db.prepare('SELECT name, normalized, parts, group_concat(section_uri, char(1)) AS uses FROM symbols GROUP BY name').all() as {
    name: string;
    normalized: string;
    parts: string;
    uses: string;
  }[];
  const out = new Map<string, SymbolMatch>();
  const put = (row: (typeof all)[number], match: SymbolMatch['match'], score: number) => {
    const prev = out.get(row.name);
    if (!prev || prev.score < score) out.set(row.name, { name: row.name, match, score, uses: [...new Set(row.uses.split('\u0001'))] });
  };
  for (const row of all) {
    const parts = row.parts.split(' ').filter(Boolean);
    if (row.name === q) put(row, 'exact', 1);
    else if (row.normalized === norm) put(row, 'normalized', 0.95);
    else if (qparts.length && qparts.every((p) => parts.includes(p))) put(row, 'part', 0.6 + 0.3 * (qparts.length / Math.max(parts.length, 1)));
    else if (mode !== 'exact' && (row.normalized.startsWith(norm) || (qparts.length && parts.some((p) => p.startsWith(qparts[qparts.length - 1]!)) && qparts.slice(0, -1).every((p) => parts.includes(p)))))
      put(row, 'prefix', 0.5);
  }
  if (mode === 'fuzzy' && q.length >= 3) {
    const grams = [...trigrams(q)];
    const cand = grams.length
      ? (db.prepare('SELECT DISTINCT name FROM symbols_trgm WHERE symbols_trgm MATCH ?').all(grams.map(ftsQuote).join(' OR ')) as { name: string }[])
      : [];
    const byName = new Map(all.map((r) => [r.name, r]));
    for (const { name } of cand) {
      const row = byName.get(name);
      if (!row || out.has(name)) continue;
      const sim = Math.max(trigramSimilarity(q, name), ...row.parts.split(' ').map((p) => trigramSimilarity(q, p)));
      if (sim >= 0.3) put(row, 'fuzzy', 0.45 * sim);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Symbols by exact / normalized / identifier-part name, optionally by prefix or fuzzily (typos). */
export function symbolSearch(ctx: SearchContext, input: SymbolSearchInput): SymbolSearchResponse {
  const inp = symbolSearchInputSchema.parse(input);
  const sec = ctx.db.prepare('SELECT s.uri, s.title, s.line_start, s.line_end, d.uri AS doc_uri, d.title AS doc_title FROM sections s JOIN docs d ON d.uri = s.doc_uri WHERE s.uri = ?');
  return {
    query: inp.name,
    symbols: symbolMatches(ctx.db, inp.name, inp.match, inp.limit).map((m) => ({
      name: m.name,
      uri: buildNodeUri({ kind: 'symbols', name: m.name }),
      match: m.match,
      score: Number(m.score.toFixed(4)),
      usedIn: m.uses.flatMap((u) => {
        const s = sec.get(u) as { uri: string; title: string; line_start: number | null; line_end: number | null; doc_uri: string; doc_title: string } | undefined;
        return s
          ? [{ sectionUri: s.uri, docUri: s.doc_uri, docTitle: s.doc_title, sectionTitle: s.title, lines: s.line_start ? { start: s.line_start, end: s.line_end ?? s.line_start } : undefined }]
          : [];
      }),
    })),
  };
}

/* ------------------------------------------------------------------ code */

/** Sections referencing a repo / path (file or directory) / glob, optionally overlapping a line range. */
export function codeSearch(ctx: SearchContext, input: CodeSearchInput): CodeSearchResponse {
  const inp = codeSearchInputSchema.parse(input);
  const c: string[] = [];
  const p: unknown[] = [];
  if (inp.repo) {
    c.push('cr.repo = ?');
    p.push(inp.repo);
  }
  if (inp.path) {
    const path = inp.path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    c.push("(cr.path = ? OR cr.path LIKE ? ESCAPE '\\')");
    p.push(path, `${path.replace(/[%_\\]/g, '\\$&')}/%`);
  }
  if (inp.glob) {
    c.push('cr.path GLOB ?');
    p.push(inp.glob.replace(/^\.?\/+/, '').replace(/\*\*\/?/g, '*'));
  }
  let lines: { start: number; end: number } | undefined;
  if (inp.lines) {
    const [a, b] = inp.lines.split('-').map(Number);
    lines = { start: a!, end: b ?? a! };
    c.push('(cr.line_start IS NULL OR (cr.line_start <= ? AND COALESCE(cr.line_end, cr.line_start) >= ?))');
    p.push(lines.end, lines.start);
  }
  const rows = ctx.db
    .prepare(
      `SELECT cr.repo, cr.path, cr.line_start, cr.line_end, cr.commit_sha, s.uri AS section_uri, s.title AS section_title, d.uri AS doc_uri, d.title AS doc_title, d.status
         FROM code_refs cr JOIN sections s ON s.uri = cr.section_uri JOIN docs d ON d.uri = s.doc_uri
        WHERE ${c.join(' AND ') || '1'} ORDER BY cr.repo, cr.path, cr.line_start LIMIT ?`,
    )
    .all(...p, inp.limit) as {
    repo: string;
    path: string;
    line_start: number | null;
    line_end: number | null;
    commit_sha: string | null;
    section_uri: string;
    section_title: string;
    doc_uri: string;
    doc_title: string;
    status: string | null;
  }[];
  // Work orders that touched matching code (current `touches` edges of work orders and their sections).
  const wantPath = inp.path?.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const globRe = inp.glob ? new RegExp(`^${inp.glob.replace(/^\.?\/+/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`) : null;
  const doc = ctx.db.prepare('SELECT title, status FROM docs WHERE uri = ?');
  const touches = (ctx.db.prepare("SELECT from_uri, to_uri, props FROM edges WHERE kind = 'touches' AND valid_to IS NULL").all() as { from_uri: string; to_uri: string; props: string | null }[])
    .flatMap((e) => {
      const n = parseNodeUri(e.to_uri);
      if (!n || n.kind !== 'code') return [];
      if (inp.repo && n.repo !== inp.repo) return [];
      if (wantPath && n.path !== wantPath && !n.path.startsWith(`${wantPath}/`)) return [];
      if (globRe && !globRe.test(n.path)) return [];
      if (lines && n.lines && (n.lines.start > lines.end || n.lines.end < lines.start)) return [];
      const woUri = e.from_uri.replace(/\/sections\/.*$/, '');
      const d = doc.get(woUri) as { title: string; status: string | null } | undefined;
      const p = parseJson<{ change?: string }>(e.props, {});
      return [{ workOrder: woUri, ...(e.from_uri !== woUri ? { section: e.from_uri } : {}), title: d?.title ?? woUri, ...(d?.status ? { status: d.status } : {}), repo: n.repo, path: n.path, ...(n.lines ? { lines: n.lines } : {}), ...(p.change ? { change: p.change } : {}) }];
    })
    .slice(0, inp.limit);
  return {
    repo: inp.repo,
    path: inp.path,
    glob: inp.glob,
    lines,
    ...(touches.length ? { workOrders: touches } : {}),
    refs: rows.map((r) => {
      const l = r.line_start ? { start: r.line_start, end: r.line_end ?? r.line_start } : undefined;
      return {
        uri: buildNodeUri({ kind: 'code', repo: r.repo, path: r.path, lines: l }),
        repo: r.repo,
        path: r.path,
        lines: l,
        commit: r.commit_sha ?? undefined,
        sectionUri: r.section_uri,
        docUri: r.doc_uri,
        docTitle: r.doc_title,
        sectionTitle: r.section_title,
        status: r.status ?? undefined,
      };
    }),
  };
}

/* ------------------------------------------------------------------ related */

/** Mean vector of a doc's or section's chunks for the current model (null if none embedded yet). */
export function vectorOf(ctx: SearchContext, uri: string): Float32Array | null {
  if (!ctx.provider) return null;
  const isDoc = !uri.includes('/sections/');
  const rows = ctx.db
    .prepare(
      `SELECT e.vector FROM chunks c JOIN embedding_cache e ON e.content_hash = c.content_hash AND e.model_id = ?
        WHERE c.uri = ? ${isDoc ? "AND c.kind = 'doc'" : ''}`,
    )
    .all(ctx.provider.modelId, uri) as { vector: Buffer }[];
  if (!rows.length) return null;
  const dims = ctx.provider.dimensions;
  const sum = new Float32Array(dims);
  for (const r of rows) {
    const v = fromBlob(r.vector);
    for (let i = 0; i < dims; i++) sum[i]! += v[i]!;
  }
  const n = Math.hypot(...sum) || 1;
  return sum.map((x) => x / n);
}

/** Semantic nearest neighbours of a doc or section (excluding itself), best first. */
export function nearest(ctx: SearchContext, uri: string, limit: number, kinds?: SearchKind[]): RelatedResponse['items'] {
  const v = vectorOf(ctx, uri);
  if (!v) return [];
  const near = knn(ctx, v, Math.max(50, limit * 12));
  const chunkStmt = ctx.db.prepare('SELECT DISTINCT c.uri FROM chunks c WHERE c.content_hash = ?');
  const entry = ctx.db.prepare('SELECT * FROM entries WHERE uri = ?');
  const out: RelatedResponse['items'] = [];
  const seen = new Set<string>([uri]);
  for (const n of near) {
    for (const { uri: u } of chunkStmt.all(n.hash) as { uri: string }[]) {
      if (seen.has(u)) continue;
      seen.add(u);
      const e = entry.get(u) as EntryRow | undefined;
      if (!e) continue;
      if (kinds?.length && !kinds.includes(e.kind) && !(e.kind === 'section' && kinds.includes(e.doc_kind))) continue;
      out.push({ uri: u, docUri: e.doc_uri, docTitle: e.doc_title, sectionTitle: e.section_title ?? undefined, kind: e.kind, score: Number((1 - n.distance).toFixed(4)) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function related(ctx: SearchContext, input: RelatedInput): RelatedResponse {
  const inp = relatedInputSchema.parse(input);
  const ref = parseNodeUri(inp.uri);
  const base = ref && 'id' in ref ? inp.uri.replace(/[@#].*$/, '') : inp.uri;
  const sem = semanticStatus(ctx);
  if (!sem.ok) return { uri: base, items: [], reason: sem.reason };
  const items = nearest(ctx, base, inp.limit, inp.kinds);
  return { uri: base, items, reason: items.length ? undefined : 'no vector for this node yet (not a doc or section, or still embedding)' };
}

/* ------------------------------------------------------------------ metadata */

/** Structured listing with derived fields: stale claims, outdated sections, open feedback counts. */
export async function metadataQuery(ctx: SearchContext, input: MetadataQueryInput): Promise<MetadataResponse> {
  const inp = metadataQueryInputSchema.parse(input);
  const c: string[] = [];
  const p: unknown[] = [];
  const inList = (col: string, vals?: string[]) => {
    if (!vals?.length) return;
    c.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
    p.push(...vals);
  };
  inList('d.kind', inp.kinds);
  inList('d.status', inp.status);
  inList('d.category', inp.category);
  inList('d.repo', inp.repo);
  inList('d.owner', inp.owner);
  inList('d.priority', inp.priority);
  for (const t of inp.tags ?? []) {
    c.push('EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)');
    p.push(t);
  }
  if (inp.standards?.length) {
    c.push(
      `(EXISTS (SELECT 1 FROM json_each(d.standards) WHERE value IN (${inp.standards.map(() => '?').join(', ')}))
        OR EXISTS (SELECT 1 FROM sections s, json_each(s.standards) j WHERE s.doc_uri = d.uri AND j.value IN (${inp.standards.map(() => '?').join(', ')})))`,
    );
    p.push(...inp.standards, ...inp.standards);
  }
  if (inp.updatedSince) {
    c.push('d.updated_at >= ?');
    p.push(inp.updatedSince);
  }
  if (inp.updatedUntil) {
    c.push('d.updated_at <= ?');
    p.push(until(inp.updatedUntil));
  }
  const rows = ctx.db
    .prepare(
      `SELECT d.*, (SELECT COUNT(DISTINCT f.uri) FROM edges t JOIN docs f ON f.uri = t.from_uri
                     WHERE t.kind = 'targets' AND t.valid_to IS NULL AND f.status = 'open'
                       AND (t.to_uri = d.uri OR substr(t.to_uri, 1, length(d.uri) + 10) = d.uri || '/sections/')) AS open_feedback
         FROM docs d WHERE ${c.join(' AND ') || '1'} ORDER BY d.updated_at DESC, d.uri`,
    )
    .all(...p) as {
    uri: string;
    kind: DocKind;
    id: string;
    title: string;
    status: string | null;
    category: string | null;
    repo: string | null;
    tags: string;
    owner: string | null;
    priority: string | null;
    props: string;
    updated_at: string | null;
    open_feedback: number;
  }[];
  const now = Date.now();
  // Claims live on work orders; a spec shows the claim of its open work order.
  const woClaim = ctx.db.prepare(
    `SELECT id, json_extract(props, '$.claim') AS claim FROM docs WHERE kind = 'work_order' AND json_extract(props, '$.spec') = ?
       AND json_extract(props, '$.claim') IS NOT NULL AND (status IS NULL OR status IN ('pending', 'in_progress')) ORDER BY id DESC LIMIT 1`,
  );
  let items: MetadataItem[] = rows.map((r) => {
    type C = { agent: string; startedAt: string; heartbeatAt?: string };
    const own = parseJson<{ claim?: C }>(r.props, {});
    const wo = r.kind === 'spec' ? (woClaim.get(r.id) as { id: string; claim: string | null } | undefined) : undefined;
    const fromWo = wo?.claim ?? null;
    const raw = r.kind === 'work_order' ? own.claim : fromWo ? parseJson<C>(fromWo, undefined as never) : undefined;
    const woId = r.kind === 'work_order' ? r.id : wo?.id;
    // Heartbeats are runtime state (not in git): ask the server; legacy jsonl claims carried heartbeatAt.
    const hb = raw ? (raw.heartbeatAt ?? (ctx.claimHeartbeat && woId ? ctx.claimHeartbeat(woId, raw) : raw.startedAt)) : undefined;
    const props = { claim: raw ? { agent: raw.agent, heartbeatAt: hb! } : undefined };
    const claim = props.claim
      ? {
          agent: props.claim.agent,
          stale: now - Date.parse(props.claim.heartbeatAt) > CLAIM_STALE_AFTER_MS,
          staleSince: new Date(Date.parse(props.claim.heartbeatAt) + CLAIM_STALE_AFTER_MS).toISOString(),
        }
      : null;
    if (claim && !claim.stale) delete (claim as { staleSince?: string }).staleSince;
    return {
      uri: r.uri,
      kind: r.kind,
      id: r.id,
      title: r.title,
      status: r.status ?? undefined,
      category: r.category ?? undefined,
      repo: r.repo ?? undefined,
      tags: parseJson<string[]>(r.tags, []),
      owner: r.owner ?? undefined,
      priority: r.priority ?? undefined,
      updatedAt: r.updated_at ?? undefined,
      claim: r.kind === 'spec' || r.kind === 'work_order' ? claim : undefined,
      outdatedSections: [],
      openFeedback: r.open_feedback,
    };
  });
  if (inp.staleClaim !== undefined) items = items.filter((i) => Boolean(i.claim?.stale) === inp.staleClaim);
  if (inp.minOpenFeedback) items = items.filter((i) => i.openFeedback >= inp.minOpenFeedback!);
  const fill = async (list: MetadataItem[]) => {
    if (!ctx.outdatedSections) return;
    for (const i of list) if (i.kind === 'spec') i.outdatedSections = await ctx.outdatedSections(i.id).catch(() => []);
  };
  if (inp.outdated !== undefined) {
    await fill(items);
    items = items.filter((i) => (i.outdatedSections.length > 0) === inp.outdated);
  }
  const offset = decodeCursor(inp.cursor);
  const page = items.slice(offset, offset + inp.limit);
  if (inp.outdated === undefined) await fill(page);
  return { items: page, total: items.length, nextCursor: offset + inp.limit < items.length ? encodeCursor(offset + inp.limit) : null };
}

/* ------------------------------------------------------------------ history */

/** Commits by message / trailer text, touched uri, author, agent, branch, feedback, change kind and date. */
export function historySearch(ctx: SearchContext, input: HistorySearchInput): HistorySearchResponse {
  const inp = historySearchInputSchema.parse(input);
  const c: string[] = [];
  const p: unknown[] = [];
  if (inp.q) {
    const terms = queryTerms(inp.q);
    if (terms.length) {
      c.push('c.sha IN (SELECT sha FROM fts_commits WHERE fts_commits MATCH ?)');
      p.push(terms.map(ftsQuote).join(' '));
    }
  }
  if (inp.uri) {
    const base = inp.uri.replace(/[@#].*$/, '');
    const m = selfOrSections('uri', base);
    c.push(`c.sha IN (SELECT sha FROM commit_uris WHERE ${m.sql})`);
    p.push(...m.params);
  }
  if (inp.author) {
    c.push('(c.author LIKE ? OR c.email LIKE ?)');
    p.push(`%${inp.author}%`, `%${inp.author}%`);
  }
  if (inp.agent) {
    c.push('c.agent = ?');
    p.push(inp.agent);
  }
  if (inp.branch) {
    c.push('c.branch = ?');
    p.push(inp.branch);
  }
  if (inp.feedback) {
    c.push("EXISTS (SELECT 1 FROM edges r WHERE r.kind = 'resolves' AND r.from_uri = 'mandate://commits/' || c.sha AND r.to_uri = ?)");
    p.push(`mandate://feedback/${inp.feedback}`);
  }
  if (inp.changeKinds?.length) {
    c.push(`EXISTS (SELECT 1 FROM json_each(c.kinds) WHERE value IN (${inp.changeKinds.map(() => '?').join(', ')}))`);
    p.push(...inp.changeKinds);
  }
  if (inp.since) {
    c.push('c.date >= ?');
    p.push(inp.since);
  }
  if (inp.until) {
    c.push('c.date <= ?');
    p.push(until(inp.until));
  }
  const where = c.join(' AND ') || '1';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM commits c WHERE ${where}`).get(...p) as { n: number }).n;
  const offset = decodeCursor(inp.cursor);
  const rows = ctx.db
    .prepare(`SELECT * FROM commits c WHERE ${where} ORDER BY c.seq DESC, c.mainline DESC, c.date DESC LIMIT ? OFFSET ?`)
    .all(...p, inp.limit, offset) as CommitRow[];
  return { commits: rows.map(toCommitRecord), total, nextCursor: offset + inp.limit < total ? encodeCursor(offset + inp.limit) : null };
}

export interface CommitRow {
  sha: string;
  seq: number;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  trailers: string;
  agent: string | null;
  branch: string | null;
  kinds: string;
  uris: string;
}

export function toCommitRecord(r: CommitRow): CommitRecord {
  return {
    sha: r.sha,
    uri: buildNodeUri({ kind: 'commits', sha: r.sha }),
    subject: r.subject,
    body: r.body,
    author: r.author,
    email: r.email,
    date: r.date,
    trailers: parseJson(r.trailers, {}),
    agent: r.agent ?? undefined,
    branch: r.branch ?? undefined,
    changeKinds: parseJson(r.kinds, []),
    uris: parseJson(r.uris, []),
  };
}
