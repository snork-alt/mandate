/**
 * Every reference is a node. `resolveRef` turns any copied reference (`@mandate:` prefix,
 * `@sha` versions, `#Lx-Ly` excerpts, code ranges, symbols, commits, ...) into a graph node,
 * and every node carries its canonical `ref`, which resolves back to it.
 *
 * - Version nodes (`mandate://specs/x@sha[/sections/y]`) are stored for commits that changed the
 *   doc / section; their outgoing edges are a view of the live node's edges at the version's seq.
 * - Excerpt nodes (`...#Lx-Ly` on docs / sections) are virtual: computed on resolve, kept in memory.
 */
import { sectionLineRange, type DocFormat, type Section } from '@mandate/doc';
import {
  buildArchitectureRef,
  buildNodeUri,
  buildRef,
  nodeKindOf,
  parseNodeUri,
  type At,
  type CommitPoint,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type MandateRef,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { parseJson, type DB } from './db.js';
import { versionBefore } from './indexer.js';
import type { SearchContext } from './search.js';

export interface GraphContext extends SearchContext {
  git?: GitStore;
  formats?: { specs: DocFormat<unknown, unknown>; standards: DocFormat<unknown, unknown>; components: DocFormat<unknown, unknown>; audits: DocFormat<unknown, unknown>; 'work-orders': DocFormat<unknown, unknown> };
  /** Virtual nodes (excerpts) resolved recently, with their outgoing edges. */
  virtual?: Map<string, { node: GraphNode; edges: EdgeRow[] }>;
}

/** Structured graph error: `code` for agents, `hint` with a way forward. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly statusCode = 404,
    readonly code = statusCode === 400 ? 'invalid_reference' : 'not_found',
    readonly hint?: string,
  ) {
    super(hint ? `${message} (${hint})` : message);
    this.name = 'GraphError';
  }
}

/* ------------------------------------------------------------------ time */

/** Internal point: `seq` is a position in this index build only (never exposed; see db.ts). */
export interface Point {
  seq: number;
  sha: string;
  date: string;
}

/** Public form of a point: the sha (stable) and its date. */
export const pub = (p: Point | null | undefined): CommitPoint | null => (p ? { sha: p.sha, date: p.date } : null);

export const pointAt = (db: DB, seq: number): Point | null =>
  (db.prepare('SELECT seq, sha, date FROM commits WHERE seq = ?').get(seq) as Point | undefined) ?? null;

export function headPoint(db: DB): Point | null {
  return (db.prepare('SELECT seq, sha, date FROM commits WHERE mainline = 1 ORDER BY seq DESC LIMIT 1').get() as Point | undefined) ?? null;
}

/** Smallest string greater than every string that starts with `prefix` (code-point order = SQLite BINARY order for UTF-8). */
function prefixUpperBound(prefix: string): string {
  const cps = [...prefix];
  const last = cps.pop()!.codePointAt(0)!;
  return cps.join('') + String.fromCodePoint(last + 1);
}

/**
 * Exact, case-sensitive prefix match as an index-friendly range (`col >= p AND col < next(p)`).
 * Unlike `LIKE ? || '%'` it treats `_`/`%` literally and does not fold case.
 */
export function prefixMatch(col: string, prefix: string): { sql: string; params: string[] } {
  if (!prefix) return { sql: '1', params: [] };
  return { sql: `(${col} >= ? AND ${col} < ?)`, params: [prefix, prefixUpperBound(prefix)] };
}

/** `col = uri OR col` is one of `uri`'s sections (exact, see `prefixMatch`). */
export function selfOrSections(col: string, uri: string): { sql: string; params: string[] } {
  const m = prefixMatch(col, `${uri}/sections/`);
  return { sql: `(${col} = ? OR ${m.sql})`, params: [uri, ...m.params] };
}

/** Any commit (side-branch commits too) by full or short sha. */
export function commitBySha(db: DB, sha: string): Point {
  // Shas are lowercase hex: fold the input instead of the column, and match the prefix exactly (no LIKE wildcards).
  const shaPrefix = prefixMatch('sha', sha.toLowerCase());
  const rows = db.prepare(`SELECT seq, sha, date FROM commits WHERE ${shaPrefix.sql} LIMIT 2`).all(...shaPrefix.params) as Point[];
  if (rows.length > 1) throw new GraphError(`commit '${sha}' is ambiguous`, 400, 'ambiguous_commit', 'use more characters of the sha');
  if (!rows[0]) {
    const lost = db.prepare(`SELECT sha, lost_at, rewrite_new_head FROM lost_commits WHERE ${shaPrefix.sql} LIMIT 1`).get(...shaPrefix.params) as
      | { sha: string; lost_at: string; rewrite_new_head: string | null }
      | undefined;
    if (lost) {
      throw new GraphError(
        `pin lost: commit ${lost.sha.slice(0, 12)} is no longer in the repository`,
        410,
        'pin_lost',
        `history was rewritten (detected ${lost.lost_at}${lost.rewrite_new_head ? `, new head ${lost.rewrite_new_head.slice(0, 7)}` : ''}); the state at this pin is unknown`,
      );
    }
    throw new GraphError(`unknown commit '${sha}'`, 404, 'unknown_commit', 'see history_search for the commits of this repository');
  }
  return rows[0];
}

/** Resolve `at` (sha, seq or ISO date) to a commit; undefined = current HEAD (null). */
export function resolveAt(db: DB, at?: At | number): Point | null {
  if (at === undefined) return null;
  if (typeof at === 'number' || /^\d+$/.test(at)) {
    const row = pointAt(db, Number(at));
    if (row) return row;
    if (typeof at === 'number' || !/^[0-9a-f]{4,40}$/.test(at)) throw new GraphError(`no commit with seq ${at}`, 404, 'unknown_commit');
  }
  if (/^[0-9a-f]{4,40}$/.test(String(at))) return commitBySha(db, String(at));
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(at)) ? `${at}T23:59:59.999Z` : new Date(String(at)).toISOString();
  // Dates resolve on the first-parent chain: the last commit with a date <= t (dates need not be monotonic).
  const row = db.prepare('SELECT seq, sha, date FROM commits WHERE mainline = 1 AND date <= ? ORDER BY seq DESC LIMIT 1').get(iso) as Point | undefined;
  if (!row) throw new GraphError(`no commit at or before ${at}`, 404, 'unknown_commit');
  return row;
}

/** SQL condition: row valid at `seq` (null = current). */
export function valid(alias: string, seq: number | null): { sql: string; params: number[] } {
  return seq === null
    ? { sql: `${alias}.valid_to IS NULL`, params: [] }
    : { sql: `${alias}.valid_from <= ? AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)`, params: [seq, seq] };
}

/* ------------------------------------------------------------------ nodes */

export interface NodeRow {
  uri: string;
  kind: GraphNodeKind;
  label: string;
  props: string;
  valid_from: number;
  valid_to: number | null;
}

export interface EdgeRow {
  from_uri: string;
  to_uri: string;
  kind: EdgeKind;
  props: string | null;
  score: number | null;
  valid_from: number;
  valid_to: number | null;
}

export const toNode = (r: NodeRow): GraphNode => ({ uri: r.uri, ref: r.uri, kind: r.kind, label: r.label, props: parseJson(r.props, {}) });

export const toEdge = (e: EdgeRow): GraphEdge => ({
  from: e.from_uri,
  to: e.to_uri,
  kind: e.kind,
  ...(e.props ? { props: parseJson(e.props, {}) } : {}),
  ...(e.score !== null && e.score !== undefined ? { score: e.score } : {}),
});

/** Latest row of a node at `seq` (any row when seq is null: deleted nodes keep their last state). */
export function nodeRow(db: DB, uri: string, seq: number | null): NodeRow | null {
  const r = (
    seq === null
      ? db.prepare('SELECT * FROM nodes WHERE uri = ? ORDER BY valid_to IS NULL DESC, valid_from DESC LIMIT 1').get(uri)
      : db.prepare('SELECT * FROM nodes WHERE uri = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1').get(uri, seq)
  ) as NodeRow | undefined;
  return r ?? null;
}

export function nodeExists(db: DB, uri: string, seq: number | null): boolean {
  const v = valid('n', seq);
  return Boolean(db.prepare(`SELECT 1 FROM nodes n WHERE n.uri = ? AND ${v.sql}`).get(uri, ...v.params));
}

/** Code nodes resolve by overlap: a file aggregates its ranges, a range matches stored ranges overlapping it. */
export function expandCode(db: DB, uri: string): string[] {
  const ref = parseNodeUri(uri);
  if (!ref || ref.kind !== 'code') return [uri];
  const file = buildNodeUri({ kind: 'code', repo: ref.repo, path: ref.path });
  const inFile = prefixMatch('uri', `${file}#`);
  const ranges = db.prepare(`SELECT DISTINCT uri, props FROM nodes WHERE kind = 'code_range' AND ${inFile.sql}`).all(...inFile.params) as { uri: string; props: string }[];
  if (!ref.lines) return [uri, ...ranges.map((r) => r.uri).filter((u) => u !== uri)];
  const { start, end } = ref.lines;
  const overlapping = ranges.filter((r) => {
    const p = parseJson<{ lineStart: number; lineEnd: number }>(r.props, { lineStart: 0, lineEnd: 0 });
    return p.lineStart <= end && p.lineEnd >= start;
  });
  return [...new Set([uri, ...overlapping.map((r) => r.uri)])];
}

export function virtualNode(uri: string): GraphNode {
  const ref = parseNodeUri(uri)!;
  const kind = nodeKindOf(ref) as GraphNodeKind;
  const label = ref.kind === 'code' ? `${ref.repo}:${ref.path}${ref.lines ? `:${ref.lines.start}-${ref.lines.end}` : ''}` : uri;
  return {
    uri,
    ref: uri,
    kind,
    label,
    props: ref.kind === 'code' ? { repo: ref.repo, path: ref.path, ...(ref.lines ? { lineStart: ref.lines.start, lineEnd: ref.lines.end } : {}) } : {},
  };
}

export function labelOf(ctx: GraphContext, uri: string, seq: number | null): GraphNode {
  const v = ctx.virtual?.get(uri);
  if (v) return v.node;
  const r = nodeRow(ctx.db, uri, seq) ?? nodeRow(ctx.db, uri, null);
  return r ? toNode(r) : virtualNode(uri);
}

/** A version node's live uri and the point of its state (mainline seq or side-branch snapshot point). */
function versionInfo(db: DB, uri: string): { of: string; seq: number } | null {
  if (!uri.includes('@')) return null;
  const r = db.prepare('SELECT of_uri, point FROM versions WHERE uri = ?').get(uri) as { of_uri: string; point: number } | undefined;
  return r ? { of: r.of_uri, seq: r.point } : null;
}

/** The version node of `live` current at a point (null = HEAD): nearest version along first parents. */
export function versionAt(db: DB, live: string, at: Point | null): NodeRow | null {
  const sha = at?.sha ?? headPoint(db)?.sha;
  if (!sha) return null;
  const uri = versionBefore(db, live, sha);
  if (!uri) return null;
  return (db.prepare("SELECT * FROM nodes WHERE uri = ? AND kind = 'version' LIMIT 1").get(uri) as NodeRow | undefined) ?? null;
}

/**
 * Edges of `uris` in one direction at `seq`. Version nodes expose the live node's outgoing edges at the
 * version's seq (rewritten to start at the version); excerpt nodes their virtual edges.
 */
export function edgesOf(
  ctx: GraphContext,
  uris: string[],
  dir: 'out' | 'in',
  seq: number | null,
  kinds: EdgeKind[] | null,
  exclude: EdgeKind[] = [],
  /** Include version views (a version's outgoing edges as of its point). Off for symmetric traversals (paths). */
  views = true,
): EdgeRow[] {
  if (!uris.length) return [];
  const { db } = ctx;
  const keep = (k: EdgeKind) => (kinds ? kinds.includes(k) : !exclude.includes(k));
  const v = valid('e', seq);
  const col = dir === 'out' ? 'from_uri' : 'to_uri';
  const k = kinds ? `AND e.kind IN (${kinds.map(() => '?').join(', ')})` : exclude.length ? `AND e.kind NOT IN (${exclude.map(() => '?').join(', ')})` : '';
  const out = db
    .prepare(`SELECT e.* FROM edges e WHERE e.${col} IN (${uris.map(() => '?').join(', ')}) AND ${v.sql} ${k}`)
    .all(...uris, ...v.params, ...(kinds ?? exclude)) as EdgeRow[];
  // Versions are immutable facts: their own edges (version_of, created_in, previous_version) hold at every point
  // from their creation, and are visible even when querying an older seq through the version itself.
  if (seq !== null) {
    const vers = uris.filter((u) => u.includes('@'));
    if (vers.length) {
      const extra = db
        .prepare(`SELECT e.* FROM edges e WHERE e.${col} IN (${vers.map(() => '?').join(', ')}) AND e.source = 'versions' AND e.valid_from > ?`)
        .all(...vers, seq) as EdgeRow[];
      out.push(...extra.filter((e) => keep(e.kind)));
    }
  }
  if (dir === 'out') {
    for (const u of uris) {
      const vi = views ? versionInfo(db, u) : null;
      if (vi) {
        const live = edgesOf(ctx, [vi.of], 'out', vi.seq, kinds, exclude);
        for (const e of live) out.push({ ...e, from_uri: u });
      }
      const virt = ctx.virtual?.get(u);
      if (virt) out.push(...virt.edges.filter((e) => keep(e.kind)));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ resolve */

export interface Resolved {
  node: GraphNode;
  /** Commit pinned by `@sha` or `at`; null = HEAD (internal point; expose with pub()). */
  at: Point | null;
  seq: number | null;
  /** The live node behind a version / excerpt (for history, related, search scope). */
  live: string[];
}

const isDocRef = (r: { kind: string }): r is MandateRef => r.kind === 'specs' || r.kind === 'standards' || r.kind === 'components' || r.kind === 'work-orders' || r.kind === 'feedback' || r.kind === 'audits';

/** Error for a doc / section missing at `seq`, with the nearest version where it exists as a hint. */
function notPresent(db: DB, live: string, seq: number | null): GraphError {
  const rows = db.prepare('SELECT valid_from, valid_to FROM nodes WHERE uri = ? ORDER BY valid_from').all(live) as { valid_from: number; valid_to: number | null }[];
  if (!rows.length) return new GraphError(`unknown node '${live}'`, 404, 'unknown_node', 'check the id, or use search to find it');
  const target = seq ?? Number.MAX_SAFE_INTEGER;
  let best: number | null = null;
  for (const r of rows) {
    const last = r.valid_to === null ? Number.MAX_SAFE_INTEGER : r.valid_to - 1;
    const cand = target < r.valid_from ? r.valid_from : target > last ? last : target;
    if (best === null || Math.abs(cand - target) < Math.abs(best - target)) best = cand;
  }
  const p = best !== null && best !== Number.MAX_SAFE_INTEGER ? pointAt(db, best) : headPoint(db);
  return new GraphError(
    `'${live}' does not exist at ${seq === null ? 'HEAD' : `seq ${seq}`}`,
    404,
    'not_present_at_version',
    p ? `nearest version where it exists: ${p.sha.slice(0, 7)} (seq ${p.seq}, ${p.date})` : undefined,
  );
}

const MAX_VIRTUAL = 1000;

/** Build (and remember) the excerpt node for `ref#Lx-Ly`. */
async function excerptNode(ctx: GraphContext, ref: MandateRef & { lines: { start: number; end: number } }, point: Point | null, seq: number | null): Promise<{ node: GraphNode; live: string[] }> {
  const { db } = ctx;
  const dir = ref.kind as 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';
  const path = `${dir}/${ref.id}.md`;
  const text = point
    ? await ctx.git?.readFileAt(point.sha, path)
    : ((db.prepare('SELECT text FROM files WHERE path = ?').get(path) as { text: string } | undefined)?.text ?? null);
  if (!text) throw notPresent(db, buildRef({ kind: dir, id: ref.id }), seq);
  const lines = text.split('\n');
  const { start, end } = ref.lines;
  if (start > lines.length) throw new GraphError(`lines ${start}-${end} are past the end of ${path} (${lines.length} lines)`, 400, 'lines_out_of_range');
  let sections: Section[] = [];
  try {
    sections = ctx.formats ? (ctx.formats[dir].parse(text) as { sections: Section[] }).sections : [];
  } catch {
    /* unparsable version: excerpt of the doc only */
  }
  if (ref.sectionId && !sections.some((s) => s.id === ref.sectionId)) {
    throw notPresent(db, buildRef({ kind: dir, id: ref.id, sectionId: ref.sectionId }), seq);
  }
  const hit = sections.filter((s) => {
    if (ref.sectionId && s.id !== ref.sectionId) return false;
    const r = sectionLineRange(text, s.id);
    return r !== null && r.start <= end && r.end >= start;
  });
  const excerpt = lines.slice(start - 1, end).join('\n');
  const target = (sectionId?: string) => {
    const live = buildRef({ kind: dir, id: ref.id, sectionId });
    if (!point) return { node: live, live };
    return { node: versionAt(db, live, point)?.uri ?? live, live };
  };
  const uri = buildRef({ kind: dir, id: ref.id, sectionId: ref.sectionId, commit: point?.sha, lines: ref.lines });
  const edges: EdgeRow[] = [];
  const edge = (to: string, kind: EdgeKind, props?: Record<string, unknown>): EdgeRow => ({
    from_uri: uri,
    to_uri: to,
    kind,
    props: props ? JSON.stringify(props) : null,
    score: null,
    valid_from: seq ?? 0,
    valid_to: null,
  });
  const live: string[] = [];
  const targets = hit.length ? hit.map((s) => target(s.id)) : [target(ref.sectionId)];
  for (const t of targets) {
    edges.push(edge(t.node, 'excerpt_of'));
    live.push(t.live);
  }
  for (const s of hit) {
    for (const sym of s.symbols) if (excerpt.includes(sym)) edges.push(edge(buildNodeUri({ kind: 'symbols', name: sym }), 'mentions_symbol'));
    for (const r of s.refs) {
      const base = r.path.split('/').pop()!;
      if (!excerpt.includes(r.path) && !excerpt.includes(base)) continue;
      const [a, b] = r.lines ? r.lines.split('-').map(Number) : [];
      edges.push(edge(buildNodeUri({ kind: 'code', repo: r.repo, path: r.path, lines: a ? { start: a, end: b ?? a } : undefined }), 'references_code'));
    }
  }
  const docTitle = labelOf(ctx, buildRef({ kind: dir, id: ref.id }), seq).label;
  const node: GraphNode = {
    uri,
    ref: uri,
    kind: 'excerpt',
    label: `${docTitle} L${start}${end > start ? `-${end}` : ''}${point ? ` @ ${point.sha.slice(0, 7)}` : ''}`,
    props: { text: excerpt, lines: ref.lines, sha: point?.sha ?? null, sections: hit.map((s) => s.id), path },
  };
  const cache = (ctx.virtual ??= new Map());
  cache.set(uri, { node, edges });
  if (cache.size > MAX_VIRTUAL) cache.delete(cache.keys().next().value!);
  return { node, live };
}

/**
 * The single entry point from a reference to a graph node. Accepts every copyable form.
 * `at` and `@sha` must agree when both are given.
 */
export async function resolveRef(ctx: GraphContext, input: string, at?: At): Promise<Resolved> {
  const { db } = ctx;
  const ref = parseNodeUri(input);
  if (!ref) throw new GraphError(`malformed reference '${input}'`, 400, 'malformed_reference', 'expected mandate://<kind>/<id>[@sha][/sections/<sid>][#Lx-Ly]');
  let point = resolveAt(db, at);

  if (isDocRef(ref)) {
    const live = buildRef({ kind: ref.kind, id: ref.id, sectionId: ref.sectionId });
    if (ref.commit) {
      const c = commitBySha(db, ref.commit);
      if (point && point.seq !== c.seq) {
        throw new GraphError(`the reference pins ${c.sha.slice(0, 7)} but at=${String(at)} is ${point.sha.slice(0, 7)}`, 400, 'conflicting_versions', 'give the version once: either @sha in the reference or at');
      }
      point = c;
    }
    const seq = point?.seq ?? null;
    const versioned = ref.kind === 'specs' || ref.kind === 'standards' || ref.kind === 'components' || ref.kind === 'audits' || ref.kind === 'work-orders';
    if (ref.lines && versioned) {
      // Validate the doc / section exists at that point (excerpt resolution reads the file itself).
      if (!point && !nodeRow(db, live, null)) throw notPresent(db, live, null);
      const ex = await excerptNode(ctx, ref as MandateRef & { lines: { start: number; end: number } }, point, seq);
      return { node: ex.node, at: point, seq, live: ex.live };
    }
    if (ref.commit && versioned) {
      const v = versionAt(db, live, point);
      if (!v) throw notPresent(db, live, seq);
      return { node: toNode(v), at: point, seq, live: [live] };
    }
    const row = nodeRow(db, live, seq);
    if (!row || (seq !== null && !nodeExists(db, live, seq))) throw notPresent(db, live, seq);
    return { node: toNode(row), at: point, seq, live: [live] };
  }

  const seq = point?.seq ?? null;
  if (ref.kind === 'architecture') {
    // `mandate://architecture[@sha][?focus=<id>]`: a virtual node over the components valid at that point.
    if (ref.commit) {
      const c = commitBySha(db, ref.commit);
      if (point && point.seq !== c.seq) throw new GraphError('the reference pins a different commit than at', 400, 'conflicting_versions');
      point = c;
    }
    const node = architectureNode(ctx, point, ref.focus);
    return { node, at: point, seq: point?.seq ?? null, live: [node.uri] };
  }
  if (ref.kind === 'commits') {
    const c = commitBySha(db, ref.sha);
    const uri = buildNodeUri({ kind: 'commits', sha: c.sha });
    return { node: labelOf(ctx, uri, null), at: point, seq, live: [uri] };
  }
  const uri = buildNodeUri(ref);
  if (ref.kind === 'code') {
    const group = expandCode(db, uri);
    const fileExists = nodeRow(db, buildNodeUri({ kind: 'code', repo: ref.repo, path: ref.path }), null);
    if (!nodeRow(db, uri, null) && group.length < 2 && !fileExists) {
      throw new GraphError(`no specification references '${ref.repo}:${ref.path}'`, 404, 'unknown_node', 'try code_search with a directory or glob');
    }
    return { node: labelOf(ctx, uri, seq), at: point, seq, live: [uri] };
  }
  const row = nodeRow(db, uri, seq) ?? nodeRow(db, uri, null);
  if (!row) throw new GraphError(`unknown node '${uri}'`, 404, 'unknown_node', ref.kind === 'symbols' ? 'try symbol_search with match: fuzzy' : undefined);
  if (row.kind === 'version') {
    const of = parseJson<{ of: string }>(row.props, { of: uri }).of;
    return { node: toNode(row), at: point, seq, live: [of] };
  }
  return { node: toNode(row), at: point, seq, live: [uri] };
}

/**
 * The architecture view as a graph node: `includes` edges to the components valid at the point (with focus: the focused
 * component and its transitive depends_on upstream / downstream), props: commit, focus, components, edges (depends_on
 * between components, with the target section), the same content as `architectureGet` (graph format).
 */
export function architectureNode(ctx: GraphContext, point: Point | null, focus?: string): GraphNode {
  const { db } = ctx;
  const seq = point?.seq ?? null;
  const v = valid('n', seq);
  // Archived components are hidden, as in architectureGet's default view.
  const comps = (db.prepare(`SELECT n.uri FROM nodes n WHERE n.kind = 'component' AND coalesce(json_extract(n.props, '$.status'), '') <> 'archived' AND ${v.sql}`).all(...v.params) as { uri: string }[]).map((r) => r.uri);
  const edges = architectureEdges(ctx, seq);
  let shown = comps;
  if (focus) {
    const f = buildRef({ kind: 'components', id: focus });
    if (!comps.includes(f)) throw new GraphError(`no component '${focus}'${point ? ` at ${point.sha.slice(0, 7)}` : ''}`, 404, 'unknown_node');
    const reach = (next: (u: string) => string[]) => {
      const seen = new Set<string>();
      const stack = [f];
      while (stack.length) for (const n of next(stack.pop()!)) if (!seen.has(n)) (seen.add(n), stack.push(n));
      return seen;
    };
    const up = reach((u) => edges.filter((e) => e.from === u).map((e) => e.to));
    const down = reach((u) => edges.filter((e) => e.to === u).map((e) => e.from));
    shown = comps.filter((c) => c === f || up.has(c) || down.has(c));
  }
  const uri = buildArchitectureRef({ ...(point ? { commit: point.sha } : {}), ...(focus ? { focus } : {}) });
  const node: GraphNode = { uri, ref: uri, kind: 'architecture', label: `Architecture${focus ? ` (focus ${focus})` : ''}${point ? ` @ ${point.sha.slice(0, 7)}` : ''}`, props: { commit: point?.sha ?? null, focus: focus ?? null, components: shown, edges } };
  const cache = (ctx.virtual ??= new Map());
  cache.set(uri, { node, edges: shown.map((c) => ({ from_uri: uri, to_uri: c, kind: 'includes' as EdgeKind, props: null, score: null, valid_from: seq ?? 0, valid_to: null })) });
  return node;
}

/** Component-to-component depends_on of the architecture (component section links to a component or its section). */
export function architectureEdges(ctx: GraphContext, seq: number | null): { from: string; to: string; section?: string }[] {
  const v = valid('e', seq);
  const rows = ctx.db
    .prepare(
      `SELECT e.from_uri, e.to_uri FROM edges e WHERE e.kind = 'depends_on' AND ${v.sql}
         AND e.from_uri LIKE 'mandate://components/%/sections/%' AND e.to_uri LIKE 'mandate://components/%'`,
    )
    .all(...v.params) as { from_uri: string; to_uri: string }[];
  const comp = (u: string) => u.replace(/\/sections\/.*$/, '');
  const sv = valid('s', seq);
  const archived = ctx.db.prepare(`SELECT json_extract(s.props, '$.archived') AS a FROM nodes s WHERE s.uri = ? AND ${sv.sql}`);
  const exists = ctx.db.prepare(`SELECT 1 FROM nodes s WHERE s.uri = ? AND s.kind = 'component' AND coalesce(json_extract(s.props, '$.status'), '') <> 'archived' AND ${sv.sql}`);
  const out = new Map<string, { from: string; to: string; section?: string }>();
  for (const r of rows) {
    const from = comp(r.from_uri);
    const to = comp(r.to_uri);
    if (from === to || !exists.get(to, ...sv.params) || !exists.get(from, ...sv.params)) continue;
    if ((archived.get(r.from_uri, ...sv.params) as { a: unknown } | undefined)?.a) continue;
    const section = r.to_uri.includes('/sections/') ? r.to_uri.split('/sections/')[1] : undefined;
    out.set(`${from}|${to}|${section ?? ''}`, { from, to, ...(section ? { section } : {}) });
  }
  return [...out.values()];
}

/** Live uris behind a resolved node (versions -> live node, excerpts -> sections). */
export function liveOf(ctx: GraphContext, node: GraphNode): string[] {
  if (node.kind === 'version') return [String(node.props.of)];
  if (node.kind === 'excerpt') {
    return (ctx.virtual?.get(node.uri)?.edges ?? [])
      .filter((e) => e.kind === 'excerpt_of')
      .map((e) => (e.to_uri.includes('@') ? (versionInfo(ctx.db, e.to_uri)?.of ?? e.to_uri) : e.to_uri));
  }
  return [node.uri];
}

export type { GraphEdge, GraphNode };
