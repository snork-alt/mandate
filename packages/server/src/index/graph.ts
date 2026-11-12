import { diffDocs, type DocFormat } from '@mandate/doc';
import {
  REVERSE_EDGE_NAMES,
  buildNodeUri,
  graphChangesInputSchema,
  graphEvolutionInputSchema,
  graphHistoryInputSchema,
  graphImpactInputSchema,
  graphNeighborsInputSchema,
  graphNodeInputSchema,
  graphPathInputSchema,
  graphSearchInputSchema,
  nodeKindOf,
  parseNodeUri,
  parseRef,
  type At,
  type ChangeKind,
  type CommitPoint,
  type ContentChange,
  type EdgeKind,
  type EvolutionEntry,
  type GraphChangesInput,
  type GraphChangesResponse,
  type GraphEdge,
  type GraphEvolutionInput,
  type GraphEvolutionResponse,
  type GraphHistoryInput,
  type GraphHistoryResponse,
  type GraphImpactInput,
  type GraphImpactResponse,
  type GraphNeighborsInput,
  type GraphNeighborsResponse,
  type GraphNode,
  type GraphNodeInput,
  type GraphNodeKind,
  type GraphNodeResponse,
  type GraphPathInput,
  type GraphPathResponse,
  type GraphSearchInput,
  type HistoryEvent,
} from '@mandate/shared';
import { parseJson, type DB } from './db.js';
import {
  GraphError,
  edgesOf,
  expandCode,
  headPoint,
  labelOf,
  liveOf,
  nodeExists,
  nodeRow,
  toNode,
  pointAt,
  pub,
  resolveAt,
  resolveRef,
  selfOrSections,
  toEdge,
  valid,
  type EdgeRow,
  type GraphContext,
  type NodeRow,
} from './resolve.js';

export { GraphError, resolveAt, resolveRef, type GraphContext } from './resolve.js';
import { decodeCursor, encodeCursor, search, symbolSearch } from './search.js';

/** Edges written per commit (history bookkeeping), left out of structural queries unless asked for. */
export const COMMIT_EDGE_KINDS: EdgeKind[] = ['changed', 'parent', 'authored_by', 'on_branch', 'resolves', 'created_in'];
const STRUCTURAL = (kinds?: EdgeKind[]) => kinds ?? null;

/** A node with its neighbours grouped by edge kind and direction (counts + first `limit`). Works for deleted nodes. */
export async function graphNode(ctx: GraphContext, input: GraphNodeInput): Promise<GraphNodeResponse> {
  const inp = graphNodeInputSchema.parse(input);
  const { db } = ctx;
  const r = await resolveRef(ctx, inp.uri, inp.at);
  const { at, seq } = r;
  const uri = r.node.uri;
  const uris = expandCode(db, uri);
  const node: GraphNodeResponse['node'] = { ...r.node };
  let deletedSeq: number | null = null;
  const row = r.node.kind === 'excerpt' ? null : nodeRow(db, uri, seq);
  if (row) {
    // First appearance in the linear order (side-branch snapshots have negative points: compare by magnitude).
    const first = db.prepare('SELECT valid_from AS s FROM nodes WHERE uri = ? ORDER BY abs(valid_from) LIMIT 1').get(uri) as { s: number } | undefined;
    if (first) node.createdAt = pub(pointAt(db, first.s)) ?? undefined;
    const last = nodeRow(db, uri, null)!;
    if (last.valid_to !== null && last.valid_to > 0 && (seq === null || last.valid_to <= seq)) {
      node.deletedAt = pub(pointAt(db, last.valid_to)) ?? undefined;
      deletedSeq = last.valid_to;
    }
  }
  // A deleted node shows the relationships it had just before deletion.
  const nseq = deletedSeq !== null && seq === null ? deletedSeq - 1 : seq;
  const groups = new Map<string, GraphNodeResponse['neighbors'][number]>();
  const groupSeen = new Map<string, Set<string>>();
  for (const dir of ['out', 'in'] as const) {
    for (const e of edgesOf(ctx, dir === 'in' ? uris : [uri], dir, nseq, null)) {
      const other = dir === 'out' ? e.to_uri : e.from_uri;
      if (other === uri) continue;
      const key = `${dir}:${e.kind}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: e.kind, direction: dir, name: dir === 'out' ? e.kind : REVERSE_EDGE_NAMES[e.kind], count: 0, nodes: [] };
        groups.set(key, g);
      }
      // Dedupe on every neighbour seen (not only the first `limit` kept): parallel edges differ only in props.
      let seenInGroup = groupSeen.get(key);
      if (!seenInGroup) groupSeen.set(key, (seenInGroup = new Set()));
      if (seenInGroup.has(other)) continue;
      seenInGroup.add(other);
      g.count++;
      if (g.nodes.length < inp.limit) g.nodes.push(labelOf(ctx, other, nseq));
    }
  }
  return { node, at: pub(at), neighbors: [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
}

/* ------------------------------------------------------------------ traversal */

/** Breadth-first neighbourhood (depth <= 3), cycle-safe and paginated. */
export async function graphNeighbors(ctx: GraphContext, input: GraphNeighborsInput): Promise<GraphNeighborsResponse & { truncated?: boolean }> {
  const inp = graphNeighborsInputSchema.parse(input);
  const { db } = ctx;
  const resolved = await resolveRef(ctx, inp.uri, inp.at);
  const seq = resolved.seq;
  const root = resolved.node.uri;
  const kinds = STRUCTURAL(inp.kinds);
  const dirs: ('out' | 'in')[] = inp.direction === 'both' ? ['out', 'in'] : [inp.direction];
  const seen = new Map<string, number>([[root, 0]]);
  const order: string[] = [];
  const edges = new Map<string, GraphEdge>();
  let frontier = [root];
  const MAX = 5000;
  let truncated = false;
  for (let d = 1; d <= inp.depth && frontier.length && !truncated; d++) {
    const next: string[] = [];
    frontierLoop: for (const u of frontier) {
      const group = expandCode(db, u);
      for (const dir of dirs) {
        // Code nodes aggregate the INCOMING edges of overlapping ranges (who references this code); outgoing edges are the node's own.
        for (const e of edgesOf(ctx, dir === 'in' ? group : [u], dir, seq, kinds, kinds ? [] : COMMIT_EDGE_KINDS)) {
          const other = dir === 'out' ? e.to_uri : e.from_uri;
          if (other === u) continue;
          if (!seen.has(other) && seen.size >= MAX) {
            // Cap reached mid-hop: stop here and say so rather than growing without bound.
            truncated = true;
            break frontierLoop;
          }
          edges.set(`${e.from_uri}|${e.to_uri}|${e.kind}`, toEdge(e));
          if (!seen.has(other)) {
            seen.set(other, d);
            order.push(other);
            next.push(other);
          }
        }
      }
    }
    frontier = next;
  }
  const offset = decodeCursor(inp.cursor);
  const pageUris = order.slice(offset, offset + inp.limit);
  const pageSet = new Set([root, ...pageUris]);
  return {
    root,
    nodes: pageUris.map((u) => {
      const n = labelOf(ctx, u, seq);
      return { ...n, props: { ...n.props, depth: seen.get(u) } };
    }),
    edges: [...edges.values()].filter((e) => pageSet.has(e.from) || pageSet.has(e.to)),
    nextCursor: offset + inp.limit < order.length ? encodeCursor(offset + inp.limit) : null,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Shortest path between two nodes (edges in either direction), bidirectional BFS. */
export async function graphPath(ctx: GraphContext, input: GraphPathInput): Promise<GraphPathResponse> {
  const inp = graphPathInputSchema.parse(input);
  const { db } = ctx;
  const a = await resolveRef(ctx, inp.from, inp.at);
  const b = await resolveRef(ctx, inp.to, inp.at);
  if (a.at && b.at && a.at.seq !== b.at.seq) {
    throw new GraphError('`from` and `to` pin different versions', 400, 'conflicting_versions', 'pin at most one point in time (at or one @sha)');
  }
  const seq = a.seq ?? b.seq;
  const from = a.node.uri;
  const to = b.node.uri;
  const kinds = STRUCTURAL(inp.kinds);
  const neighbours = (u: string) => {
    // Stored edges only (no code-range overlap expansion, no version views): paths are symmetric.
    const group = [u];
    const out: { node: string; edge: EdgeRow }[] = [];
    // Stored edges only (version views exist in one direction): paths are symmetric.
    for (const e of edgesOf(ctx, group, 'out', seq, kinds, kinds ? [] : [...COMMIT_EDGE_KINDS, 'similar_to'], false)) out.push({ node: e.to_uri, edge: e });
    for (const e of edgesOf(ctx, group, 'in', seq, kinds, kinds ? [] : [...COMMIT_EDGE_KINDS, 'similar_to'], false)) out.push({ node: e.from_uri, edge: e });
    return out;
  };
  const prevA = new Map<string, { node: string; edge: EdgeRow } | null>([[from, null]]);
  const prevB = new Map<string, { node: string; edge: EdgeRow } | null>([[to, null]]);
  let fa = [from];
  let fb = [to];
  let meet: string | null = from === to ? from : null;
  for (let depth = 0; !meet && depth < inp.maxDepth && fa.length && fb.length; depth++) {
    const expandA = fa.length <= fb.length;
    const frontier = expandA ? fa : fb;
    const prev = expandA ? prevA : prevB;
    const other = expandA ? prevB : prevA;
    const next: string[] = [];
    for (const u of frontier) {
      for (const n of neighbours(u)) {
        if (prev.has(n.node)) continue;
        prev.set(n.node, { node: u, edge: n.edge });
        next.push(n.node);
        if (other.has(n.node)) {
          meet = n.node;
          break;
        }
      }
      if (meet) break;
    }
    if (expandA) fa = next;
    else fb = next;
  }
  if (!meet) return { from, to, found: false, nodes: [], edges: [] };
  const left: string[] = [];
  const edges: GraphEdge[] = [];
  for (let u: string | undefined = meet; u; ) {
    left.unshift(u);
    const p = prevA.get(u);
    if (p) edges.unshift(toEdge(p.edge));
    u = p?.node;
  }
  for (let u: string | undefined = prevB.get(meet)?.node, p = prevB.get(meet); u; ) {
    if (p) edges.push(toEdge(p.edge));
    left.push(u);
    p = prevB.get(u);
    u = p?.node;
  }
  return { from, to, found: true, nodes: left.map((u) => labelOf(ctx, u, seq)), edges };
}

/** Impact rules: edge kind and the direction to follow from an affected node to what it affects. */
export const IMPACT: [EdgeKind, 'in' | 'out'][] = [
  // Precise, section-level: links from sections (depends_on, follows, deviates_from); derived document-level
  // spec_depends_on / component_depends_on are not followed (the section links are).
  ['depends_on', 'in'],
  ['follows', 'in'],
  ['deviates_from', 'in'],
  // A standard affects the specs / components using it through appliesTo (link users are reached via follows).
  ['uses_standard', 'in'],
  ['references_code', 'in'],
  ['covers', 'in'],
  ['targets', 'in'],
  ['mentions_symbol', 'in'],
  ['in_file', 'in'],
  ['has_section', 'in'],
];

/** `uses_standard` propagates only through appliesTo (section links are followed precisely); work-order depends_on never. */
export const impactEdge = (e: EdgeRow) => {
  if (e.kind === 'uses_standard') return (parseJson<{ via?: string[] }>(e.props, {}).via ?? []).includes('appliesTo');
  if (e.kind === 'depends_on') return e.from_uri.includes('/sections/');
  return true;
};

/** Everything that transitively depends on, uses, references, covers or targets the node, grouped by node kind. */
export async function graphImpact(ctx: GraphContext, input: GraphImpactInput): Promise<GraphImpactResponse> {
  const inp = graphImpactInputSchema.parse(input);
  const { db } = ctx;
  const resolved = await resolveRef(ctx, inp.uri, inp.at);
  const seq = resolved.seq;
  // Versions and excerpts affect what their live doc / sections affect.
  const root = resolved.node.uri;
  const found = new Map<string, { depth: number; via: EdgeKind }>();
  let frontier = resolved.live.flatMap((u) => expandCode(db, u));
  // A document's sections are affected with it.
  for (const live of resolved.live) {
    if (!live.includes('/sections/') && /^mandate:\/\/(specs|standards|components|audits|work-orders)\//.test(live)) {
      frontier = [...frontier, ...edgesOf(ctx, [live], 'out', seq, ['has_section']).map((e) => e.to_uri)];
    }
  }
  frontier = [...new Set([root, ...frontier])];
  const start = new Set(frontier);
  for (let d = 1; d <= inp.maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const [kind, dir] of IMPACT) {
      for (const e of edgesOf(ctx, frontier, dir, seq, [kind])) {
        if (!impactEdge(e)) continue;
        const raw = dir === 'in' ? e.from_uri : e.to_uri;
        // P4: covers comes from a work-order section: the work order is what is affected.
        const other = kind === 'covers' ? raw.split('/sections/')[0]! : raw;
        if (start.has(other) || found.has(other)) continue;
        found.set(other, { depth: d, via: kind });
        next.push(other);
      }
    }
    frontier = next;
  }
  const groups: GraphImpactResponse['groups'] = {};
  for (const [uri, info] of found) {
    const n = labelOf(ctx, uri, seq);
    if (n.kind === 'code_range' || n.kind === 'code_file') continue; // structure, not impact
    (groups[n.kind] ??= []).push({ ...n, ...info });
  }
  for (const list of Object.values(groups)) list!.sort((a, b) => a.depth - b.depth || a.uri.localeCompare(b.uri));
  return { uri: root, groups, total: Object.values(groups).reduce((n, l) => n + l!.length, 0) };
}

/* ------------------------------------------------------------------ history */

interface ChangedRow extends EdgeRow {
  sha: string;
  seq: number;
  date: string;
  subject: string;
  author: string;
  agent: string | null;
  branch: string | null;
}

/** URIs whose changes make up a node's history (sections mentioning a symbol or referencing code, ...). */
function historyTargets(db: DB, uri: string): string[] {
  const ref = parseNodeUri(uri)!;
  switch (ref.kind) {
    case 'symbols':
      return (db.prepare("SELECT DISTINCT from_uri AS u FROM edges WHERE kind = 'mentions_symbol' AND to_uri = ?").all(uri) as { u: string }[]).map((r) => r.u);
    case 'code': {
      const group = expandCode(db, uri);
      return (
        db.prepare(`SELECT DISTINCT from_uri AS u FROM edges WHERE kind = 'references_code' AND to_uri IN (${group.map(() => '?').join(', ')})`).all(...group) as { u: string }[]
      ).map((r) => r.u);
    }
    default:
      return [uri];
  }
}

function seqBound(db: DB, at: At | undefined): number | null {
  return at === undefined ? null : Math.abs(resolveAt(db, at)!.seq);
}

/** Ordered change events of a node (newest first), each with its commit. */
export async function graphHistory(ctx: GraphContext, input: GraphHistoryInput): Promise<GraphHistoryResponse> {
  const inp = graphHistoryInputSchema.parse(input);
  const { db } = ctx;
  const resolved = await resolveRef(ctx, inp.uri);
  const uri = resolved.node.uri;
  const ref = parseNodeUri(resolved.live[0] ?? uri)!;
  // A merge's own diff repeats its side branch's changes (recorded on those commits): leave it out.
  const c: string[] = ["e.kind = 'changed'", "json_extract(e.props, '$.merge') IS NOT 1"];
  const p: unknown[] = [];
  if (ref.kind === 'commits') {
    c.push('e.from_uri = ?');
    p.push(uri);
  } else if (ref.kind === 'agents') {
    c.push("e.from_uri IN (SELECT from_uri FROM edges WHERE kind = 'authored_by' AND to_uri = ?)");
    p.push(uri);
  } else {
    const targets = [...new Set(resolved.live.flatMap((u) => historyTargets(db, u)))];
    if (!targets.length) return { uri, events: [], total: 0, nextCursor: null };
    c.push(`e.to_uri IN (${targets.map(() => '?').join(', ')})`);
    p.push(...targets);
  }
  const since = seqBound(db, inp.since);
  // A version (or versioned excerpt) shows the history up to that version.
  const untilSeq = seqBound(db, inp.until) ?? (resolved.at ? Math.abs(resolved.at.seq) : null);
  if (since !== null) {
    c.push('abs(c.seq) >= ?');
    p.push(since);
  }
  if (untilSeq !== null) {
    c.push('abs(c.seq) <= ?');
    p.push(untilSeq);
  }
  if (inp.agent) {
    c.push('(c.agent = ? OR c.author = ?)');
    p.push(inp.agent, inp.agent);
  }
  if (inp.kinds?.length) {
    c.push(`EXISTS (SELECT 1 FROM json_each(e.props, '$.changeKinds') WHERE value IN (${inp.kinds.map(() => '?').join(', ')}))`);
    p.push(...inp.kinds);
  }
  const sql = `FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha WHERE ${c.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...p) as { n: number }).n;
  const offset = decodeCursor(inp.cursor);
  const rows = db
    .prepare(`SELECT e.*, c.sha, c.seq, c.date, c.subject, c.author, c.agent, c.branch ${sql} ORDER BY abs(c.seq) DESC, e.to_uri LIMIT ? OFFSET ?`)
    .all(...p, inp.limit, offset) as ChangedRow[];
  const events: HistoryEvent[] = rows.map((r) => {
    const props = parseJson<{ action: HistoryEvent['action']; changeKinds: ChangeKind[]; linesAdded: number; linesRemoved: number }>(r.props, {
      action: 'modified',
      changeKinds: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
    return {
      commit: {
        sha: r.sha,
        date: r.date,
        subject: r.subject,
        author: r.author,
        agent: r.agent ?? undefined,
        branch: r.branch ?? undefined,
        uri: buildNodeUri({ kind: 'commits', sha: r.sha }),
      },
      target: r.to_uri,
      action: props.action,
      changeKinds: props.changeKinds,
      linesAdded: props.linesAdded,
      linesRemoved: props.linesRemoved,
    };
  });
  return { uri, events, total, nextCursor: offset + inp.limit < total ? encodeCursor(offset + inp.limit) : null };
}

/** Graph diff between two points: nodes / edges added and removed, plus changed content (with diffDocs summaries). */
export async function graphChanges(ctx: GraphContext, input: GraphChangesInput): Promise<GraphChangesResponse> {
  const inp = graphChangesInputSchema.parse(input);
  const { db } = ctx;
  const from = resolveAt(db, inp.from)!;
  const to = inp.to === undefined ? headPoint(db) : resolveAt(db, inp.to);
  if (!to) throw new GraphError('the index is empty');
  // Any two points (also side-branch commits): exact set difference of the states, keyed by (from, to, kind, props).
  const kinds = inp.kinds ?? null;
  const kindSql = kinds ? `AND e.kind IN (${kinds.map(() => '?').join(', ')})` : `AND e.kind NOT IN (${COMMIT_EDGE_KINDS.map(() => '?').join(', ')})`;
  const kindParams = kinds ?? COMMIT_EDGE_KINDS;
  const w = inp.within ? (await resolveRef(ctx, inp.within)).live[0] : undefined;
  // Exact prefix matches (not LIKE: case-insensitive and `_`/`%` are wildcards).
  const wf = w ? selfOrSections('e.from_uri', w) : null;
  const wt = w ? selfOrSections('e.to_uri', w) : null;
  const wn = w ? selfOrSections('n.uri', w) : null;
  const withinSql = wf && wt ? `AND (${wf.sql} OR ${wt.sql})` : '';
  const withinParams = wf && wt ? [...wf.params, ...wt.params] : [];
  const edgesAt = (p: number) => {
    const v = valid('e', p);
    const rows = db.prepare(`SELECT e.* FROM edges e WHERE ${v.sql} ${kindSql} ${withinSql}`).all(...v.params, ...kindParams, ...withinParams) as EdgeRow[];
    return new Map(rows.map((e) => [`${e.from_uri}\u0000${e.to_uri}\u0000${e.kind}\u0000${e.props ?? ''}`, e]));
  };
  const nodeWithin = wn ? `AND ${wn.sql}` : '';
  const nodesAt = (p: number) => {
    const v = valid('n', p);
    const rows = db.prepare(`SELECT n.* FROM nodes n WHERE ${v.sql} AND n.kind != 'commit' ${nodeWithin}`).all(...v.params, ...(wn?.params ?? [])) as NodeRow[];
    return new Map(rows.map((n) => [n.uri, n]));
  };
  const [ef, et, nf, nt] = [edgesAt(from.seq), edgesAt(to.seq), nodesAt(from.seq), nodesAt(to.seq)];
  const added = [...et].filter(([k]) => !ef.has(k)).map(([, e]) => e);
  const removed = [...ef].filter(([k]) => !et.has(k)).map(([, e]) => e);
  const nodesAdded = [...nt].filter(([u]) => !nf.has(u)).map(([, n]) => n);
  const nodesRemoved = [...nf].filter(([u]) => !nt.has(u)).map(([, n]) => n);

  // Content changes: `changed` edges of the commits reachable from `to` but not from `from` (git ancestry, merges included).
  const changed = db
    .prepare(
      `WITH RECURSIVE
         a_to(sha) AS (SELECT ? UNION SELECT p.parent FROM commit_parents p JOIN a_to ON p.sha = a_to.sha),
         a_from(sha) AS (SELECT ? UNION SELECT p.parent FROM commit_parents p JOIN a_from ON p.sha = a_from.sha)
       SELECT e.to_uri, e.props, c.sha FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha
        WHERE e.kind = 'changed' AND c.sha IN (SELECT sha FROM a_to EXCEPT SELECT sha FROM a_from)
          AND json_extract(e.props, '$.merge') IS NOT 1
          ${wt ? `AND ${wt.sql}` : ''} ORDER BY abs(c.seq)`,
    )
    .all(to.sha, from.sha, ...(wt?.params ?? [])) as { to_uri: string; props: string; sha: string }[];
  const content = new Map<string, ContentChange & { first: string; last: string }>();
  for (const r of changed) {
    const p = parseJson<{ action: ContentChange['action']; changeKinds: ChangeKind[] }>(r.props, { action: 'modified', changeKinds: [] });
    const ref = parseRef(r.to_uri);
    if (!ref) continue;
    const kind: ContentChange['kind'] = ref.sectionId ? 'section' : ref.kind === 'specs' ? 'spec' : ref.kind === 'standards' ? 'standard' : ref.kind === 'work-orders' ? 'work_order' : ref.kind === 'components' ? 'component' : ref.kind === 'audits' ? 'audit' : ref.kind;
    const c = content.get(r.to_uri) ?? { uri: r.to_uri, kind, action: p.action, changeKinds: [], commits: [], first: p.action, last: p.action };
    c.last = p.action;
    c.changeKinds = [...new Set([...c.changeKinds, ...p.changeKinds])];
    if (!c.commits.includes(r.sha)) c.commits.push(r.sha);
    content.set(r.to_uri, c);
  }
  const out: ContentChange[] = [];
  for (const { first, last, ...c } of content.values()) {
    if (first === 'created' && last === 'deleted') continue;
    c.action = first === 'created' ? 'created' : last === 'deleted' ? 'deleted' : first === 'renamed' ? 'renamed' : 'modified';
    const ref = parseRef(c.uri)!;
    if ((c.kind === 'spec' || c.kind === 'standard' || c.kind === 'component' || c.kind === 'audit' || c.kind === 'work_order') && ctx.git && ctx.formats) {
      const dir = ref.kind as 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';
      const path = `${dir}/${ref.id}.md`;
      try {
        const before = await ctx.git.readFileAt(from.sha, path);
        const after = await ctx.git.readFileAt(to.sha, path);
        const d = diffDocs(ctx.formats[dir], before, after);
        c.summary = {
          frontmatter: d.frontmatter.map((x) => x.key),
          sectionsAdded: d.sections.filter((s) => s.status === 'added').map((s) => s.id),
          sectionsRemoved: d.sections.filter((s) => s.status === 'removed').map((s) => s.id),
          sectionsModified: d.sections.filter((s) => s.status === 'modified' || (s.before?.summary ?? null) !== (s.after?.summary ?? null)).filter((s) => s.status !== 'added' && s.status !== 'removed').map((s) => s.id),
        };
      } catch {
        /* unparsable version: no summary */
      }
    }
    out.push(c);
  }
  return {
    from: pub(from)!,
    to: pub(to)!,
    nodesAdded: nodesAdded.map(toNode),
    nodesRemoved: nodesRemoved.map(toNode),
    edgesAdded: added.map(toEdge),
    edgesRemoved: removed.map(toEdge),
    content: out,
  };
}

/** When each relationship of a node appeared and disappeared, with the node's version at those points. */
export async function graphEvolution(ctx: GraphContext, input: GraphEvolutionInput): Promise<GraphEvolutionResponse> {
  const inp = graphEvolutionInputSchema.parse(input);
  const { db } = ctx;
  const resolved = await resolveRef(ctx, inp.uri);
  // Evolution is about the live node (a version or excerpt shows the evolution of what it is a version of).
  const uri = resolved.live[0] ?? resolved.node.uri;
  const versions = (
    db
      .prepare(
        `SELECT DISTINCT c.seq, c.sha, c.date, c.subject FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha
          WHERE e.kind = 'changed' AND e.to_uri = ? AND json_extract(e.props, '$.merge') IS NOT 1 ORDER BY abs(c.seq)`,
      )
      .all(uri) as { seq: number; sha: string; date: string; subject: string }[]
  ).map((v, i) => ({ ...v, version: i + 1 }));
  const versionAt = (seq: number) => versions.filter((v) => Math.abs(v.seq) <= Math.abs(seq)).length;
  const point = (seq: number) => ({ ...(pub(pointAt(db, seq)) ?? { sha: '', date: '' }), version: versionAt(seq) });
  const rows = db
    .prepare(
      `SELECT e.*, 'out' AS dir FROM edges e WHERE e.from_uri = ? AND e.source <> 'snapshot' AND e.kind NOT IN (${COMMIT_EDGE_KINDS.map(() => '?').join(', ')})
       UNION ALL
       SELECT e.*, 'in' AS dir FROM edges e WHERE e.to_uri = ? AND e.source <> 'snapshot' AND e.kind NOT IN (${COMMIT_EDGE_KINDS.map(() => '?').join(', ')})
       ORDER BY valid_from`,
    )
    .all(uri, ...COMMIT_EDGE_KINDS, uri, ...COMMIT_EDGE_KINDS) as (EdgeRow & { dir: 'out' | 'in' })[];
  const entries: EvolutionEntry[] = rows.map((e) => {
    const otherUri = e.dir === 'out' ? e.to_uri : e.from_uri;
    const other = nodeRow(db, otherUri, null);
    return {
      kind: e.kind,
      direction: e.dir,
      name: e.dir === 'out' ? e.kind : REVERSE_EDGE_NAMES[e.kind],
      other: { uri: otherUri, label: other?.label ?? otherUri, kind: other?.kind ?? null },
      from: point(e.valid_from),
      to: e.valid_to === null ? null : point(e.valid_to),
      ...(e.props ? { props: parseJson(e.props, {}) } : {}),
    };
  });
  if (!versions.length && !entries.length && !nodeExists(db, uri, null)) throw new GraphError(`node '${uri}' not found`);
  return { uri, versions: versions.map(({ seq: _s, ...v }) => v), entries };
}

/** Entry points for traversal: hybrid search hits, symbols and code files as graph nodes. */
export async function graphSearch(ctx: GraphContext, input: GraphSearchInput): Promise<{ nodes: (GraphNode & { score: number })[] }> {
  const inp = graphSearchInputSchema.parse(input);
  const out = new Map<string, GraphNode & { score: number }>();
  for (const s of symbolSearch(ctx, { name: inp.q, match: 'fuzzy', limit: 5 }).symbols) {
    out.set(s.uri, { ...labelOf(ctx, s.uri, null), score: (s.match === 'exact' || s.match === 'normalized' ? 10 : 1) + s.score });
  }
  if (/[/.]/.test(inp.q) && !/\s/.test(inp.q)) {
    const files = ctx.db.prepare("SELECT uri FROM nodes WHERE kind = 'code_file' AND label LIKE ? LIMIT 5").all(`%${inp.q}%`) as { uri: string }[];
    for (const f of files) out.set(f.uri, { ...labelOf(ctx, f.uri, null), score: 1.5 });
  }
  const res = await search(ctx, { q: inp.q, mode: 'hybrid', limit: inp.limit });
  for (const g of res.groups) {
    for (const h of g.hits) {
      const uri = h.uri.replace(/#.*$/, '');
      if (!out.has(uri)) out.set(uri, { ...labelOf(ctx, uri, null), score: h.score * 30 });
    }
  }
  return { nodes: [...out.values()].sort((a, b) => b.score - a.score).slice(0, inp.limit) };
}
