/**
 * Lineage over the temporal graph (lineage-brief §1, §2, §4, §6): why an element exists or changed (causes,
 * upstream) and what it led to (effects, downstream), plus the blast radius of a change and where standards are used
 * in code. A walk over `caused_by` (recorded at write time) and structural edges, oriented cause -> effect by
 * `LINEAGE_EDGES`; `at` time-travels (edges are temporal).
 *
 * Phase B extension points (after the work-order rework): `changingOf` (open work orders: claim, branch, sections
 * remaining, touched code so far, open PRs) and `blastRadius.openWorkOrders` on the same FILES (touches edges).
 */
import {
  CAUSAL_EDGES,
  CAUSE_TRAILER,
  LINEAGE_EDGES,
  LINK_EDGE_KINDS,
  MIGRATION_TRAILER_KEY,
  type LineageEvent,
  type WorkProgress,
  type LineageEventKind,
  blastRadiusInputSchema,
  buildNodeUri,
  buildRef,
  lineageInputSchema,
  parseNodeUri,
  parseRef,
  userOfTrailers,
  whereUsedInputSchema,
  codeRulesInputSchema,
  type Attribution,
  type BlastItem,
  type BlastRadiusInput,
  type BlastRadiusResponse,
  type CodeRulesInput,
  type CodeRulesResponse,
  type EdgeKind,
  type GraphNode,
  type GraphNodeKind,
  type LineageEdge,
  type LineageInput,
  type LineageNode,
  type LineageResponse,
  type LineageStatus,
  type UsageLocation,
  type WhereUsedInput,
  type WhereUsedResponse,
} from '@mandate/shared';
import { parseJson } from './db.js';
import { edgesOf, expandCode, GraphError, labelOf, nodeRow, pointAt, pub, resolveRef, valid, type EdgeRow, type GraphContext } from './resolve.js';

/* ------------------------------------------------------------------ causes of a commit */

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Causes a commit records: `Caused-By` refs plus the `Feedback` / `Work-Order` / `Audit` trailers (and the legacy
 * `Queue-Item`, read as `Work-Order`, L-10). `Verification` and `Feedback-Item` are identity trailers (they name the
 * record the commit writes), never causes (L-9a).
 */
export function commitCauses(trailers: Record<string, string>): { uri: string; trailer: string }[] {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(trailers)) {
    const key = k.toLowerCase();
    const parts = v.split(/[\s,]+/).filter(Boolean);
    if (key === CAUSE_TRAILER.toLowerCase()) {
      for (const p of parts) {
        const uri = canonicalCause(p);
        if (uri && !out.has(uri)) out.set(uri, k);
      }
      continue;
    }
    for (const id of parts.filter((x) => ID_RE.test(x))) {
      const uri =
        key === 'feedback' || key === 'request'
          ? buildRef({ kind: 'feedback', id })
          : key === 'work-order' || key === 'queue-item'
            ? buildRef({ kind: 'work-orders', id })
            : key === 'audit'
              ? buildRef({ kind: 'audits', id })
              : null;
      if (uri && !out.has(uri)) out.set(uri, k);
    }
  }
  return [...out].map(([uri, trailer]) => ({ uri, trailer }));
}

/** Id trailers name one record of a family: a commit never makes a sibling record of that family its effect (L-1). */
export const ID_TRAILER_FAMILY: Record<string, string> = {
  feedback: 'mandate://requests/',
  'work-order': 'mandate://work-orders/',
  'queue-item': 'mandate://work-orders/',
  audit: 'mandate://audits/',
};

/** A migration commit (`Mandate-Migration: <anything but no / false>`): records no causes (L-1). */
export function isMigrationCommit(trailers: Record<string, string>): boolean {
  const v = Object.entries(trailers).find(([k]) => k.toLowerCase() === MIGRATION_TRAILER_KEY.toLowerCase())?.[1];
  return v !== undefined && !/^(no|false|0)$/i.test(v.trim());
}

/** A commit changing more work orders than this (without a migration trailer) is a bulk rewrite: no causes (L-1). */
export const BULK_WORK_ORDERS = 3;

/** A reference without a pinned version or line range. */
function canonicalCause(ref: string): string | null {
  const r = parseRef(ref);
  if (r) return buildRef({ kind: r.kind, id: r.id, ...(r.sectionId ? { sectionId: r.sectionId } : {}) });
  const n = parseNodeUri(ref);
  return n ? buildNodeUri(n) : null;
}

/* ------------------------------------------------------------------ lineage */

const HISTORY_EDGES: EdgeKind[] = ['changed', 'authored_by', 'on_branch', 'parent', 'version_of', 'previous_version', 'created_in', 'excerpt_of'];
const HISTORY_KINDS = new Set<GraphNodeKind>(['commit', 'agent', 'branch', 'version']);
const RECORDED = new Set<EdgeKind>(['caused_by', 'acts_on', 'resolves', 'from_finding', 'fixed_by', 'reported_in', 'implements', 'applies_at', 'violated_at']);
/** Fan-out guards: edges that would pull whole repositories / documents into a lineage beyond the first hop. */
const FIRST_HOP_ONLY = new Set<EdgeKind>(['in_repo', 'in_file', 'has_section', 'owns', 'contains', 'includes', 'related_to']);
/** A section of a document (causal mode reports it as the document, L-4). */
const DOC_SECTION_RE = /^(mandate:\/\/(?:specs|standards|components|audits|work-orders)\/[a-z0-9]+(?:-[a-z0-9]+)*)\/sections\//;
/** Work-order kinds a covered section causes (L-2); review / verify orders look at a section, they do not act on it. */
const COVER_CAUSES = new Set(['implement', 'update', 'fix']);

/**
 * When an edge's fact came to be (L-3): the seq of the commit that recorded it (caused_by / annotations: the annotated
 * commit), else the first point the edge appeared. Cached per walk.
 */
function edgeTimes(ctx: GraphContext): (e: EdgeRow) => number | null {
  const bySha = new Map<string, number | null>();
  const byKey = new Map<string, number | null>();
  const shaQ = ctx.db.prepare('SELECT seq FROM commits WHERE sha = ?');
  const firstQ = ctx.db.prepare('SELECT min(abs(valid_from)) AS s FROM edges WHERE from_uri = ? AND to_uri = ? AND kind = ?');
  return (e) => {
    const props = parseJson<{ commit?: unknown }>(e.props, {});
    if (e.kind === 'caused_by' && typeof props.commit === 'string') {
      if (!bySha.has(props.commit)) {
        const r = shaQ.get(props.commit) as { seq: number } | undefined;
        bySha.set(props.commit, r ? Math.abs(r.seq) : null);
      }
      const t = bySha.get(props.commit)!;
      if (t !== null) return t;
    }
    const key = `${e.from_uri}|${e.to_uri}|${e.kind}`;
    if (!byKey.has(key)) byKey.set(key, (firstQ.get(e.from_uri, e.to_uri, e.kind) as { s: number | null } | undefined)?.s ?? null);
    return byKey.get(key)!;
  };
}

const FORWARD = Object.entries(LINEAGE_EDGES)
  .filter(([, d]) => d === 'forward')
  .map(([k]) => k as EdgeKind);
const REVERSE = Object.entries(LINEAGE_EDGES)
  .filter(([, d]) => d === 'reverse')
  .map(([k]) => k as EdgeKind);

const OPEN_WO = new Set(['pending', 'ready', 'in_progress', 'claimed', 'blocked', 'review', 'open']);

/** done (changed) / in progress (changing) / needs attention / neutral, from the node's own status. */
export function lineageStatus(n: Pick<GraphNode, 'kind' | 'props'>): { status: LineageStatus; raw?: string } {
  const p = n.props ?? {};
  const raw = typeof p.status === 'string' ? p.status : typeof p.result === 'string' ? p.result : undefined;
  const r = raw ?? '';
  let status: LineageStatus = 'neutral';
  switch (n.kind) {
    case 'work_order':
      // pending | in_progress (open: changing) | done | failed | cancelled (WORK_ORDER_STATUSES).
      // A pending work order nobody has claimed is planned, not changing.
      status =
        r === 'done'
          ? 'done'
          : r === 'failed'
            ? 'attention'
            : r === 'cancelled' || (r === 'pending' && !hasClaim(p))
              ? 'neutral'
              : 'in_progress';
      break;
    case 'feedback':
      // Closed feedback counts as done only when it was applied: rejected / duplicate items changed nothing.
      status =
        r === 'closed'
          ? p.resolution === 'rejected' || p.resolution === 'duplicate'
            ? 'neutral'
            : 'done'
          : r === 'accepted'
            ? 'in_progress'
            : 'attention';
      break;
    case 'comment':
      status = r === 'resolved' ? 'done' : r === 'open' ? 'attention' : 'neutral';
      break;
    case 'question':
      status = r === 'answered' ? 'done' : r === 'open' ? 'attention' : 'neutral';
      break;
    case 'finding':
      status = r === 'resolved' ? 'done' : r === 'wont_fix' ? 'neutral' : 'attention';
      break;
    case 'verification':
      status = r === 'pass' ? 'done' : r === 'fail' ? 'attention' : 'neutral';
      break;
    case 'audit':
      status = p.completedAt ? (openFindings(p) ? 'attention' : 'done') : p.abandonedAt ? 'neutral' : 'in_progress';
      break;
    case 'spec':
      status = r === 'done' ? 'done' : r === 'in_progress' ? 'in_progress' : 'neutral';
      break;
    case 'pull_request':
      status = r === 'merged' ? 'done' : r === 'open' ? 'in_progress' : 'neutral';
      break;
    case 'commit':
    case 'code_commit':
      status = 'done';
      break;
  }
  return { status, ...(raw ? { raw } : {}) };
}

const hasClaim = (p: Record<string, unknown>) =>
  Boolean((p.claim && typeof p.claim === 'object') || (Array.isArray(p.claims) && p.claims.length > 0));

/** A spec is changing when an open work order covering it is in progress or claimed at `seq` (L-8). */
function specChanging(ctx: GraphContext, spec: string, seq: number | null): boolean {
  const secs = edgesOf(ctx, [spec], 'out', seq, ['has_section']).map((e) => e.to_uri);
  for (const e of edgesOf(ctx, secs, 'in', seq, ['covers'])) {
    const n = nodeRow(ctx.db, e.from_uri.split('/sections/')[0]!, seq);
    if (!n || n.kind !== 'work_order') continue;
    const p = parseJson<{ status?: string; claim?: { agent?: string } }>(n.props, {});
    if (p.status === 'in_progress' || (p.status === 'pending' && !!p.claim?.agent)) return true;
  }
  return false;
}

const openFindings = (p: Record<string, unknown>) => Number((p.counts as { findings?: { open?: number } } | undefined)?.findings?.open ?? 0) > 0;

/** Progress of a work order from its document props (wo-sections, claim, git context with pull requests). */
export function workProgress(p: Record<string, unknown>): WorkProgress {
  const secs = Array.isArray(p.sections) ? (p.sections as { status?: string }[]) : [];
  const live = secs.filter((x) => x.status !== 'obsolete');
  const claim = p.claim && typeof p.claim === 'object' ? (p.claim as { agent?: string; branch?: string }) : null;
  const git = Array.isArray(p.git) ? (p.git as { repo?: string; branch?: string; pr?: { number?: number; url?: string; status?: string } }[]) : [];
  const branch = claim?.branch ?? git.find((g) => g.branch)?.branch;
  return {
    sectionsDone: live.filter((x) => x.status === 'done').length,
    sectionsTotal: live.length,
    ...(claim?.agent ? { claimedBy: claim.agent } : {}),
    ...(branch ? { branch } : {}),
    prs: git.filter((g) => g.repo && typeof g.pr?.number === 'number').map((g) => ({ repo: g.repo!, number: g.pr!.number!, ...(g.pr!.url ? { url: g.pr!.url } : {}), ...(g.pr!.status ? { status: g.pr!.status } : {}) })),
  };
}

/** "1/2 sections · x on feat/y · PR #42 open". */
export function progressLine(w: WorkProgress): string {
  return [
    w.sectionsTotal ? `${w.sectionsDone}/${w.sectionsTotal} sections` : null,
    w.claimedBy ? `${w.claimedBy}${w.branch ? ` on ${w.branch}` : ''}` : w.branch ? `on ${w.branch}` : null,
    ...w.prs.map((pr) => `PR #${pr.number}${pr.status ? ` ${pr.status}` : ''}`),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** First appearance of a node and who created it (trailers of that commit). */
function createdOf(ctx: GraphContext, uri: string): { createdAt: LineageNode['createdAt']; createdBy?: Attribution } {
  const first = ctx.db.prepare('SELECT valid_from AS s FROM nodes WHERE uri = ? ORDER BY abs(valid_from) LIMIT 1').get(uri) as { s: number } | undefined;
  if (!first) return { createdAt: null };
  const p = pointAt(ctx.db, Math.abs(first.s));
  if (!p) return { createdAt: null };
  const c = ctx.db.prepare('SELECT agent, author, trailers FROM commits WHERE sha = ?').get(p.sha) as { agent: string | null; author: string; trailers: string } | undefined;
  const user = c ? userOfTrailers(parseJson<Record<string, string>>(c.trailers, {})) : undefined;
  return { createdAt: pub(p), ...(c ? { createdBy: { ...(user ? { user } : {}), agent: c.agent ?? c.author, at: p.date, commit: p.sha } } : {}) };
}

/** Lineage of any node: causes (negative layers) and effects (positive layers). */
export async function lineage(ctx: GraphContext, input: LineageInput): Promise<LineageResponse> {
  const inp = lineageInputSchema.parse(input);
  const resolved = await resolveRef(ctx, inp.ref, inp.at);
  const { seq } = resolved;
  const root = resolved.node;
  const rootIsHistory = HISTORY_KINDS.has(root.kind) || root.kind === 'excerpt';
  const hide = inp.hideHistory && !rootIsHistory;
  const causalOnly = !inp.structure;
  const edgeOk = (k: EdgeKind) => (!hide || !HISTORY_EDGES.includes(k)) && (!causalOnly || CAUSAL_EDGES.includes(k));
  const forward = FORWARD.filter(edgeOk);
  const reverse = REVERSE.filter(edgeOk);
  // A version / excerpt / code location has the lineage of what it stands for.
  const starts = [...new Set([root.uri, ...resolved.live.flatMap((u) => expandCode(ctx.db, u))])];
  // Causal lineage: a document's own sections count as the document (their causes and effects are the document's).
  const alias = new Map<string, string>();
  if (causalOnly) {
    for (const live of resolved.live.filter((u) => !u.includes('/sections/') && /^mandate:\/\/(specs|standards|components|audits|work-orders)\//.test(u))) {
      for (const e of edgesOf(ctx, [live], 'out', seq, ['has_section'])) alias.set(e.to_uri, root.uri);
    }
    for (const u of resolved.live) if (u !== root.uri) alias.set(u, root.uri);
  }
  // Causal lineage (L-4): a section reached mid-walk also brings its document (same layer, an edge with the section as
  // `via`; the document is not expanded), and a code location reached mid-walk expands to the ranges overlapping it,
  // like a root does.
  const sectionDoc = (u: string) => (causalOnly ? (DOC_SECTION_RE.exec(u)?.[1] ?? null) : null);
  const canon = (u: string) => alias.get(u) ?? u;
  const layer = new Map<string, number>(starts.map((u) => [canon(u), 0]));
  const walkStarts = [...new Set([...starts, ...alias.keys()])];
  const edges = new Map<string, LineageEdge>();
  let truncated = false;
  const time = edgeTimes(ctx);
  const woKind = new Map<string, string | null>();
  const kindOfWo = (u: string) => {
    if (!woKind.has(u)) {
      const n = nodeRow(ctx.db, u, seq) ?? nodeRow(ctx.db, u, null);
      woKind.set(u, n ? (parseJson<{ kind?: string }>(n.props, {}).kind ?? null) : null);
    }
    return woKind.get(u)!;
  };

  const walk = (dir: 'up' | 'down') => {
    let frontier = [...walkStarts];
    // L-3 time guard: up, a cause must not be later than the step that reached its effect; down, an effect must not be
    // earlier than the step that reached its cause. Roots are unbounded.
    const bound = new Map<string, number | null>(frontier.map((u) => [u, null]));
    const expanded = new Set<string>(frontier);
    for (let d = 1; d <= inp.depth && frontier.length; d++) {
      const next: string[] = [];
      // up: edges where the frontier node is the EFFECT; down: where it is the CAUSE.
      const found: { e: EdgeRow; at: string; other: string; cause: string; effect: string }[] = [];
      const fw = d === 1 ? forward : forward.filter((k) => !FIRST_HOP_ONLY.has(k));
      const rv = d === 1 ? reverse : reverse.filter((k) => !FIRST_HOP_ONLY.has(k));
      if (dir === 'up') {
        for (const e of edgesOf(ctx, frontier, 'in', seq, fw)) found.push({ e, at: e.to_uri, other: e.from_uri, cause: e.from_uri, effect: e.to_uri });
        for (const e of edgesOf(ctx, frontier, 'out', seq, rv)) found.push({ e, at: e.from_uri, other: e.to_uri, cause: e.to_uri, effect: e.from_uri });
      } else {
        for (const e of edgesOf(ctx, frontier, 'out', seq, fw)) found.push({ e, at: e.from_uri, other: e.to_uri, cause: e.from_uri, effect: e.to_uri });
        for (const e of edgesOf(ctx, frontier, 'in', seq, rv)) found.push({ e, at: e.to_uri, other: e.from_uri, cause: e.to_uri, effect: e.from_uri });
      }
      const nextBound = new Map<string, number | null>();
      for (const raw of found) {
        // L-2: a covered section causes only implement / update / fix work orders.
        if (causalOnly && raw.e.kind === 'covers' && !COVER_CAUSES.has(kindOfWo(raw.effect.split('/sections/')[0]!) ?? '')) continue;
        const t = time(raw.e);
        const b = bound.get(raw.at) ?? null;
        if (b !== null && t !== null && (dir === 'up' ? t > b : t < b)) continue;
        const f = { e: raw.e, other: canon(raw.other), cause: canon(raw.cause), effect: canon(raw.effect) };
        if (f.cause === f.effect) continue;
        if (!layer.has(f.other)) {
          if (hide && HISTORY_KINDS.has(labelOf(ctx, f.other, seq).kind)) continue;
          if (layer.size >= inp.limit) {
            truncated = true;
            continue;
          }
          layer.set(f.other, dir === 'up' ? -d : d);
        }
        // Expand from the raw node (a section, not its whole document); loosest bound among same-hop arrivals.
        const loosen = (u: string) => {
          const p = nextBound.get(u);
          nextBound.set(u, p === undefined ? t : p === null || t === null ? null : dir === 'up' ? Math.max(p, t) : Math.min(p, t));
        };
        loosen(raw.other);
        if (!expanded.has(raw.other)) {
          expanded.add(raw.other);
          next.push(raw.other);
          if (causalOnly && raw.other.startsWith('mandate://code/')) {
            for (const x of expandCode(ctx.db, raw.other)) {
              if (expanded.has(x)) continue;
              expanded.add(x);
              if (!alias.has(x) && !layer.has(x)) alias.set(x, f.other);
              loosen(x);
              next.push(x);
            }
          }
        }
        const key = `${f.cause}|${f.effect}|${f.e.kind}`;
        if (edges.has(key)) continue;
        const props = parseJson<Record<string, unknown>>(f.e.props, {});
        const via = [raw.cause, raw.effect].find((u, i) => u !== [f.cause, f.effect][i]);
        edges.set(key, {
          from: f.cause,
          to: f.effect,
          kind: f.e.kind,
          recorded: RECORDED.has(f.e.kind),
          ...(typeof props.commit === 'string' ? { commit: props.commit } : {}),
          ...(typeof props.date === 'string' ? { at: props.date } : typeof props.at === 'string' ? { at: props.at } : {}),
          ...(props.source === 'annotation' || props.source === 'reason' ? { source: props.source } : f.e.kind === 'acts_on' ? { source: 'reason' as const } : f.e.kind === 'caused_by' ? { source: 'trailer' as const } : {}),
          ...(props.confidence === 'low' ? { confidence: 'low' as const } : {}),
          ...(via ? { via } : {}),
        });
        // L-4: the reached section's document, reported with the section as `via`.
        const doc = sectionDoc(f.other);
        if (doc && canon(doc) !== canon(f.cause === f.other ? f.effect : f.cause) && (layer.has(doc) || layer.size < inp.limit)) {
          if (!layer.has(doc)) layer.set(doc, layer.get(f.other)!);
          const dc = f.cause === f.other ? doc : f.cause;
          const de = f.effect === f.other ? doc : f.effect;
          const dk = `${dc}|${de}|${f.e.kind}`;
          if (!edges.has(dk)) edges.set(dk, { ...edges.get(key)!, from: dc, to: de, via: f.other });
        }
      }
      for (const [u, b] of nextBound) bound.set(u, b);
      for (const u of next) if (!bound.has(u)) bound.set(u, null);
      frontier = next;
    }
  };
  if (inp.direction !== 'down') walk('up');
  if (inp.direction !== 'up') walk('down');

  const toNode = (uri: string, l: number): LineageNode => {
    const n = uri === root.uri ? root : labelOf(ctx, uri, seq);
    const st = lineageStatus(n);
    const live = nodeRow(ctx.db, uri, null);
    const c = createdOf(ctx, uri);
    return {
      uri,
      ref: n.ref ?? uri,
      kind: n.kind,
      label: n.label,
      layer: l,
      status: st.status,
      ...(st.raw ? { rawStatus: st.raw } : {}),
      createdAt: c.createdAt,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      ...(live && live.valid_to !== null && live.valid_to > 0 && (seq === null || live.valid_to <= seq) ? { deleted: true } : {}),
      ...(n.kind === 'work_order' ? { progress: workProgress(n.props ?? {}) } : {}),
      ...(n.kind === 'pull_request' && typeof n.props?.url === 'string' ? { url: n.props.url } : {}),
    };
  };
  let nodes = [...layer].map(([u, l]) => toNode(u, l));
  // L-8: specs store no in-progress status: an open, claimed work order covering the spec makes it changing.
  for (const n of nodes) if (n.kind === 'spec' && n.status === 'neutral' && specChanging(ctx, n.uri, seq)) n.status = 'in_progress';
  // Effects recorded at write time are changes that happened: they count as done.
  const recordedEffects = new Set([...edges.values()].filter((e) => e.recorded && layer.get(e.to)! > 0).map((e) => e.to));
  // Only nodes without a status of their own: an open comment / rejected feedback stays what its status says.
  for (const n of nodes) if (n.status === 'neutral' && !n.rawStatus && recordedEffects.has(n.uri)) n.status = 'done';
  // Code touched by a done work order (or one of its sections) was changed: it counts as done (and as a changed file).
  const byUri = new Map(nodes.map((n) => [n.uri, n]));
  const woDone = (u: string) => {
    const doc = u.split('/sections/')[0]!;
    if (!doc.startsWith('mandate://work-orders/')) return false;
    return (byUri.get(doc) ?? lineageStatus(labelOf(ctx, doc, seq))).status === 'done';
  };
  for (const e of edges.values()) {
    if (e.kind !== 'touches') continue;
    const n = byUri.get(e.to);
    if (n && n.layer > 0 && n.status === 'neutral' && (n.kind === 'code_file' || n.kind === 'code_range') && woDone(e.from)) n.status = 'done';
  }
  const rootNode = nodes.find((n) => n.uri === root.uri)!;
  const keep = (n: LineageNode) => n.uri === root.uri || ((!inp.status || inp.status.includes(n.status)) && (!inp.kinds || inp.kinds.includes(n.kind)));
  nodes = nodes.filter(keep);
  const kept = new Set(nodes.map((n) => n.uri));
  // Excluded intermediate nodes keep the walk honest: edges are only those between kept nodes.
  const outEdges = [...edges.values()].filter((e) => kept.has(e.from) && kept.has(e.to));
  nodes.sort((a, b) => a.layer - b.layer || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  const at = resolved.at;
  const pr = parseRef(root.uri);
  const viewRef = at && pr && !pr.commit ? buildRef({ ...pr, commit: at.sha }) : root.ref;
  // Down only: the story starts when the element appeared (earlier history of its effects is not part of it).
  const first = inp.direction === 'down' ? (ctx.db.prepare('SELECT min(abs(valid_from)) AS s FROM nodes WHERE uri = ?').get(root.uri) as { s: number | null } | undefined) : undefined;
  const since = first?.s ?? null;
  const story = inp.story ? storyOf(ctx, [...new Set([...layer.keys(), ...alias.keys()])], seq, inp.eventLimit, since) : null;
  return {
    root: rootNode,
    at: pub(at),
    direction: inp.direction,
    depth: inp.depth,
    nodes,
    edges: outEdges,
    summary: summarize(nodes),
    truncated,
    viewRef,
    structure: inp.structure,
    ...(story ? { events: story.events, eventsTruncated: story.truncated } : {}),
  };
}

/* ------------------------------------------------------------------ story */

const EVENT_KIND: Record<string, LineageEventKind> = {
  specs: 'spec',
  standards: 'standard',
  components: 'component',
  'work-orders': 'work_order',
  feedback: 'feedback',
  verifications: 'verification',
  audits: 'audit',
  comments: 'comment',
  questions: 'question',
};
const DOC_KINDS = new Set(['specs', 'standards', 'components', 'audits', 'work-orders']);

interface ChangedRow {
  to_uri: string;
  props: string | null;
  sha: string;
  seq: number;
  date: string;
  subject: string;
  agent: string | null;
  author: string;
  branch: string | null;
  trailers: string;
}

/**
 * The chronological story of a lineage: one event per commit and element (a document's section edits are folded into
 * the document's event), oldest first, with actor, causes, the earlier event that caused it and the gap to the
 * previous step. Built from the temporal `changed` edges and the commits table.
 */
export function storyOf(ctx: GraphContext, uris: string[], seq: number | null, limit: number, since: number | null = null): { events: LineageEvent[]; truncated: boolean } {
  const rows: ChangedRow[] = [];
  const v = valid('e', seq);
  for (let i = 0; i < uris.length; i += 400) {
    const chunk = uris.slice(i, i + 400);
    rows.push(
      ...(ctx.db
        .prepare(
          `SELECT e.to_uri, e.props, c.sha, c.seq, c.date, c.subject, c.agent, c.author, c.branch, c.trailers FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha
           WHERE e.kind = 'changed' AND e.to_uri IN (${chunk.map(() => '?').join(', ')}) AND ${v.sql}`,
        )
        .all(...chunk, ...v.params) as ChangedRow[]),
    );
  }
  const byKey = new Map<string, { row: ChangedRow; doc: string; docProps: Record<string, unknown> | null; sections: { uri: string; props: Record<string, unknown> }[] }>();
  for (const r of rows) {
    const doc = r.to_uri.split('/sections/')[0]!;
    const key = `${r.sha}:${doc}`;
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { row: r, doc, docProps: null, sections: [] }));
    const props = parseJson<Record<string, unknown>>(r.props, {});
    if (r.to_uri === doc) g.docProps = props;
    else g.sections.push({ uri: r.to_uri, props });
  }
  const groups = [...byKey.values()].filter((g) => since === null || Math.abs(g.row.seq) >= since).sort((a, b) => a.row.date.localeCompare(b.row.date) || Math.abs(a.row.seq) - Math.abs(b.row.seq));
  const truncated = groups.length > limit;
  const kept = truncated ? groups.slice(groups.length - limit) : groups;
  const events: LineageEvent[] = [];
  for (const g of kept) {
    const n = parseNodeUri(g.doc);
    const kind: LineageEventKind = (n && EVENT_KIND[n.kind]) || 'other';
    const node = nodeRow(ctx.db, g.doc, Math.abs(g.row.seq)) ?? nodeRow(ctx.db, g.doc, null);
    const nprops = node ? parseJson<Record<string, unknown>>(node.props, {}) : {};
    const label = node?.label ?? g.doc;
    const action = String(g.docProps?.action ?? (g.sections.length ? 'modified' : 'modified'));
    const changeKinds = (g.docProps?.changeKinds as string[] | undefined) ?? [];
    const verb: LineageEvent['verb'] = action === 'created' ? 'created' : action === 'deleted' ? 'deleted' : !g.sections.length && changeKinds.length && !changeKinds.includes('text') ? 'status' : 'edited';
    const status = typeof nprops.status === 'string' ? nprops.status : typeof nprops.result === 'string' ? nprops.result : undefined;
    const sections = g.sections.map((x) => ({ uri: x.uri, title: labelOf(ctx, x.uri, Math.abs(g.row.seq)).label.split(' \u203a ').pop()!, action: (x.props.action === 'created' || x.props.action === 'deleted' ? x.props.action : 'modified') as 'created' | 'modified' | 'deleted' }));
    const trailers = parseJson<Record<string, string>>(g.row.trailers, {});
    const user = userOfTrailers(trailers);
    const text = sentence(kind, verb, label, status, sections, g.row.subject, nprops);
    events.push({
      id: `${g.row.sha}:${g.doc}`,
      at: g.row.date,
      commit: g.row.sha,
      kind,
      verb,
      subject: g.doc,
      label,
      text,
      commitSubject: g.row.subject,
      ...(sections.length ? { sections } : {}),
      ...(typeof g.docProps?.linesAdded === 'number' ? { linesAdded: g.docProps.linesAdded as number, linesRemoved: (g.docProps.linesRemoved as number) ?? 0 } : {}),
      ...(status ? { status } : {}),
      ...(user ? { user } : {}),
      agent: g.row.agent ?? g.row.author,
      ...(g.row.branch ? { branch: g.row.branch } : {}),
      causes: commitCauses(trailers).map((c) => c.uri).filter((c) => c !== g.doc && !c.startsWith(`${g.doc}/`)),
      ...(n && DOC_KINDS.has(n.kind) && 'id' in n ? { version: buildRef({ kind: n.kind as 'specs', id: (n as { id: string }).id, commit: g.row.sha }) } : {}),
    });
  }
  // Causal links: the latest earlier event of a cause element; gaps between consecutive steps.
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (i > 0) e.gapMs = Math.max(0, Date.parse(e.at) - Date.parse(events[i - 1]!.at));
    for (const c of e.causes) {
      const docC = c.split('/sections/')[0]!;
      for (let j = i - 1; j >= 0; j--) {
        if (events[j]!.subject === c || events[j]!.subject === docC) {
          e.causedBy = events[j]!.id;
          break;
        }
      }
      if (e.causedBy) break;
    }
  }
  return { events, truncated };
}

/** One short sentence per event. */
function sentence(kind: LineageEventKind, verb: LineageEvent['verb'], label: string, status: string | undefined, sections: { title: string; action: string }[], subject: string, props: Record<string, unknown>): string {
  const q = (t: string) => `\u201c${t}\u201d`;
  const what = subject.replace(/^[a-z-]+(\([^)]*\))?:\s*/i, '');
  switch (kind) {
    case 'feedback':
      return verb === 'created' ? `Feedback filed: ${label}` : verb === 'status' && status ? `Feedback ${status}: ${label}` : `Feedback updated: ${label}`;
    case 'verification':
      return `Verification ${status ?? 'recorded'}${props.criterion ? `: ${String(props.criterion).replace('mandate://', '')}` : ''}`;
    case 'question':
      return verb === 'created' ? `Question asked: ${label}` : `Question ${status ?? 'updated'}: ${label}`;
    case 'comment':
      return `${props.blocking ? 'Blocking comment' : 'Comment'} on ${String(props.target ?? label).replace('mandate://', '')}`;
    case 'work_order':
      return verb === 'created' ? `Work order created: ${label}` : `Work order ${what || 'updated'}`;
    case 'audit':
      return verb === 'created' ? `Audit started: ${label}` : `Audit ${what || 'updated'}`;
    default: {
      const noun = kind === 'other' ? 'Changed' : '';
      if (verb === 'created') return `Created ${label}`;
      if (verb === 'deleted') return `Deleted ${label}`;
      if (verb === 'status') return `${status ? `Status ${status}` : 'Metadata changed'}: ${label}`;
      if (sections.length === 1) return `Edited ${q(sections[0]!.title)} in ${label}`;
      if (sections.length > 1) return `Edited ${sections.length} sections of ${label}`;
      return `${noun || 'Edited'} ${label}`;
    }
  }
}

/**
 * "Changed: 3 sections in 2 specs, 1 component, 14 files · Changing: 1 work order". Phase B: `changing` gets the open
 * work orders' progress (sections done / total), branches and open PRs from the work-order rework.
 */
export function summarize(nodes: LineageNode[]): LineageResponse['summary'] {
  const down = nodes.filter((n) => n.layer > 0);
  const done = down.filter((n) => n.status === 'done');
  const sections = done.filter((n) => n.kind === 'section');
  const docsOfSections = new Set(sections.map((n) => n.uri.split('/sections/')[0]));
  const changed = {
    sections: sections.length,
    docs: new Set([...docsOfSections, ...done.filter((n) => n.kind === 'spec' || n.kind === 'standard').map((n) => n.uri)]).size,
    components: done.filter((n) => n.kind === 'component').length,
    files: new Set(done.filter((n) => n.kind === 'code_file' || n.kind === 'code_range').map((n) => n.uri.split('#')[0])).size,
    workOrders: done.filter((n) => n.kind === 'work_order').length,
    commits: done.filter((n) => n.kind === 'commit' || n.kind === 'code_commit').length,
    total: done.length,
  };
  const prog = down.filter((n) => n.status === 'in_progress' || n.status === 'attention');
  const openWos = prog.filter((n) => n.kind === 'work_order' && n.status === 'in_progress');
  // Open PRs: PR nodes in the lineage plus those recorded on open work orders.
  const prs = new Set([...prog.filter((n) => n.kind === 'pull_request').map((n) => n.label), ...openWos.flatMap((w) => (w.progress?.prs ?? []).filter((p) => p.status === 'open').map((p) => `${p.repo}#${p.number}`))]);
  const changing = {
    workOrders: openWos.length,
    findings: prog.filter((n) => n.kind === 'finding').length,
    feedback: prog.filter((n) => n.kind === 'feedback').length,
    prs: prs.size,
    branches: [...new Set(openWos.map((w) => w.progress?.branch).filter((b): b is string => !!b))],
    total: prog.length,
    items: [...openWos, ...prog.filter((n) => !openWos.includes(n))].slice(0, 20).map((n) => ({
      uri: n.uri,
      kind: n.kind,
      label: n.label,
      ...(n.progress ? { work: n.progress, progress: progressLine(n.progress) || n.rawStatus } : n.rawStatus ? { progress: n.rawStatus } : {}),
      ...(n.url ? { url: n.url } : {}),
    })),
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (changed.sections) parts.push(`${plural(changed.sections, 'section')} in ${plural(changed.docs, 'doc')}`);
  else if (changed.docs) parts.push(plural(changed.docs, 'doc'));
  if (changed.components) parts.push(plural(changed.components, 'component'));
  if (changed.files) parts.push(plural(changed.files, 'file'));
  if (changed.workOrders) parts.push(`${plural(changed.workOrders, 'work order')} done`);
  const ing: string[] = [];
  if (changing.workOrders) {
    const w = openWos.find((x) => x.progress?.sectionsTotal);
    ing.push(`${plural(changing.workOrders, 'work order')}${changing.workOrders === 1 && w ? ` (${w.progress!.sectionsDone}/${w.progress!.sectionsTotal})` : ''}`);
  }
  if (changing.prs) ing.push(changing.prs === 1 ? `PR ${[...prs][0]!.replace(/^.*#/, '#')} open` : `${changing.prs} PRs open`);
  if (changing.findings) ing.push(`${plural(changing.findings, 'open finding')}`);
  if (changing.feedback) ing.push(`${changing.feedback} feedback`);
  const causes = nodes.filter((n) => n.layer < 0).length;
  const text = [parts.length ? `Changed: ${parts.join(', ')}` : 'Changed: nothing recorded yet', ...(ing.length ? [`Changing: ${ing.join(', ')}`] : [])].join(' · ');
  return { changed, changing, causes, text };
}

/* ------------------------------------------------------------------ blast radius */

const docOf = (uri: string) => uri.split('/sections/')[0]!;

export async function blastRadius(ctx: GraphContext, input: BlastRadiusInput): Promise<BlastRadiusResponse> {
  const inp = blastRadiusInputSchema.parse(input);
  const resolved = await resolveRef(ctx, inp.ref, inp.at);
  const { seq } = resolved;
  const root = resolved.node;
  const lives = resolved.live.length ? resolved.live : [root.uri];
  const out = (uris: string[], kinds: EdgeKind[]) => edgesOf(ctx, uris, 'out', seq, kinds);
  const inn = (uris: string[], kinds: EdgeKind[]) => edgesOf(ctx, uris, 'in', seq, kinds);
  const groups = { dependentSpecs: new Map<string, BlastItem>(), followers: new Map<string, BlastItem>(), ownedCode: new Map<string, BlastItem>(), components: new Map<string, BlastItem>(), openWorkOrders: new Map<string, BlastItem>(), openIssues: new Map<string, BlastItem>() };
  const add = (g: keyof typeof groups, uri: string, via: string) => {
    if (groups[g].has(uri) || lives.includes(uri) || groups[g].size >= inp.limit) return;
    const n = labelOf(ctx, uri, seq);
    const status = typeof n.props.status === 'string' ? n.props.status : undefined;
    groups[g].set(uri, { uri, kind: n.kind, label: n.label, ...(status ? { status } : {}), via });
  };
  // The documents and sections in play.
  const docs = [...new Set(lives.filter((u) => /^mandate:\/\/(specs|standards|components)\//.test(u)).map(docOf))];
  const sections = new Set(lives.filter((u) => u.includes('/sections/')));
  for (const d of docs) if (!lives.some((u) => u.includes('/sections/') && docOf(u) === d)) out([d], ['has_section']).forEach((e) => sections.add(e.to_uri));
  const secs = [...sections];
  // Dependent specs: depends_on (transitive) and section links into these sections.
  let frontier = docs.filter((d) => d.startsWith('mandate://specs/'));
  const seen = new Set(frontier);
  for (let d = 0; d < 4 && frontier.length; d++) {
    const next: string[] = [];
    for (const e of inn(frontier, ['spec_depends_on'])) {
      if (seen.has(e.from_uri)) continue;
      seen.add(e.from_uri);
      next.push(e.from_uri);
      add('dependentSpecs', e.from_uri, d === 0 ? 'depends_on' : `depends_on ×${d + 1}`);
    }
    frontier = next;
  }
  for (const e of inn(secs, [...LINK_EDGE_KINDS])) if (docOf(e.from_uri).startsWith('mandate://specs/') && !docs.includes(docOf(e.from_uri))) add('dependentSpecs', docOf(e.from_uri), e.kind);
  // Followers of a standard / rule.
  for (const d of docs.filter((x) => x.startsWith('mandate://standards/'))) for (const e of inn([d], ['uses_standard'])) add('followers', e.from_uri, 'uses_standard');
  for (const e of inn(secs.filter((s) => s.startsWith('mandate://standards/')), ['inherits_rule', 'deviates_from'])) add('followers', e.from_uri, e.kind);
  // Components affected / owned, and their code.
  const comps = new Set<string>();
  for (const e of out(secs, ['affects'])) comps.add(e.to_uri);
  for (const d of docs.filter((x) => x.startsWith('mandate://components/'))) {
    comps.add(d);
    for (const e of out([d], ['contains'])) add('components', e.to_uri, 'contains');
  }
  if (root.kind === 'code_file' || root.kind === 'code_range') for (const e of out(lives.flatMap((u) => expandCode(ctx.db, u)), ['owned_by'])) comps.add(e.to_uri);
  for (const c of comps) add('components', c, docs.includes(c) ? 'self' : 'affects');
  for (const e of out([...comps], ['owns'])) add('ownedCode', e.to_uri, 'owns');
  for (const e of out(secs, ['references_code'])) add('ownedCode', e.to_uri, 'references_code');
  for (const d of docs.filter((x) => x.startsWith('mandate://standards/'))) for (const e of out([d, ...secs], ['governs'])) add('ownedCode', e.to_uri, 'governs');
  // Code: the sections referencing it are the specs in play.
  if (root.kind === 'code_file' || root.kind === 'code_range') {
    for (const e of inn(lives.flatMap((u) => expandCode(ctx.db, u)), ['references_code', 'governs'])) {
      if (e.kind === 'governs') add('followers', e.from_uri, 'governs');
      else add('dependentSpecs', docOf(e.from_uri), 'references_code');
    }
  }
  // Open work orders and open issues on the same specs (phase B: and on the same files via `touches`).
  const specScope = [...new Set([...docs.filter((d) => d.startsWith('mandate://specs/')), ...groups.dependentSpecs.keys(), ...[...groups.followers.keys()].map(docOf).filter((d) => d.startsWith('mandate://specs/'))])];
  // P4: covers comes from work-order sections (legacy records: the work order) into spec sections.
  for (const e of inn([...new Set(out(specScope, ['has_section']).map((x) => x.to_uri))], ['covers'])) {
    const wo = docOf(e.from_uri);
    const n = labelOf(ctx, wo, seq);
    if (n.kind === 'work_order' && OPEN_WO.has(String(n.props.status ?? 'pending'))) add('openWorkOrders', wo, `covers ${docOf(e.to_uri).replace('mandate://', '')}`);
  }
  // ... and open work orders that touched the same files (touches: work order / wo-section -> file or range).
  const codeScope = [...new Set([...groups.ownedCode.keys(), ...(root.kind === 'code_file' || root.kind === 'code_range' ? lives : [])].filter((u) => u.startsWith('mandate://code/')).flatMap((u) => [u, u.split('#')[0]!]).flatMap((u) => expandCode(ctx.db, u)))];
  for (const e of inn(codeScope, ['touches'])) {
    const wo = docOf(e.from_uri);
    const n = labelOf(ctx, wo, seq);
    if (n.kind === 'work_order' && OPEN_WO.has(String(n.props.status ?? 'pending'))) add('openWorkOrders', wo, `touches ${e.to_uri.replace(/^mandate:\/\/code\//, '')}`);
  }
  const scopeSecs = [...secs, ...out(specScope, ['has_section']).map((e) => e.to_uri)];
  for (const e of inn([...new Set(scopeSecs)], ['targets', 'concerns'])) {
    const n = labelOf(ctx, e.from_uri, seq);
    const st = String(n.props.status ?? 'open');
    if ((n.kind === 'feedback' && (st === 'open' || st === 'accepted')) || (n.kind === 'finding' && st === 'open')) add('openIssues', e.from_uri, e.kind);
  }
  const res = Object.fromEntries(Object.entries(groups).map(([k, m]) => [k, [...m.values()]])) as Record<keyof typeof groups, BlastItem[]>;
  const total = Object.values(res).reduce((n, l) => n + l.length, 0);
  const label = (n: number, w: string) => (n ? `${n} ${w}` : null);
  const text =
    [label(res.dependentSpecs.length, 'dependent specs'), label(res.followers.length, 'followers'), label(res.components.length, 'components'), label(res.ownedCode.length, 'code locations'), label(res.openWorkOrders.length, 'open work orders'), label(res.openIssues.length, 'open issues')]
      .filter(Boolean)
      .join(', ') || 'No known impact';
  return { root: { uri: root.uri, kind: root.kind, label: root.label }, at: pub(resolved.at), ...res, total, text };
}

/* ------------------------------------------------------------------ where standards are used in code */

function codeParts(uri: string): { repo: string; path: string; lines?: { start: number; end: number } } | null {
  const n = parseNodeUri(uri);
  return n?.kind === 'code' ? { repo: n.repo, path: n.path, ...(n.lines ? { lines: n.lines } : {}) } : null;
}

export async function whereUsed(ctx: GraphContext, input: WhereUsedInput): Promise<WhereUsedResponse> {
  const inp = whereUsedInputSchema.parse(input);
  const resolved = await resolveRef(ctx, inp.ref);
  const uri = resolved.live[0] ?? resolved.node.uri;
  const ref = parseRef(uri);
  if (!ref || ref.kind !== 'standards') throw new GraphError('where-used works on a standard or one of its rule sections', 400, 'invalid_input', 'pass mandate://standards/<id> or mandate://standards/<id>/sections/<rule>');
  const std = buildRef({ kind: 'standards', id: ref.id });
  const rules = ref.sectionId ? [uri] : edgesOf(ctx, [std], 'out', null, ['has_section']).map((e) => e.to_uri);
  // Latest recorded state per (rule, location): applies_at = compliant, violated_at = violating.
  const latest = new Map<string, UsageLocation & { order: string }>();
  for (const e of edgesOf(ctx, [...rules, std], 'out', null, ['applies_at', 'violated_at'])) {
    const parts = codeParts(e.to_uri);
    if (!parts) continue;
    const props = parseJson<Record<string, unknown>>(e.props, {});
    const at = typeof props.at === 'string' ? props.at : undefined;
    const key = `${e.from_uri}|${e.to_uri}`;
    const order = at ?? '';
    const prev = latest.get(key);
    if (prev && prev.order > order) continue;
    const owner = edgesOf(ctx, [buildNodeUri({ kind: 'code', repo: parts.repo, path: parts.path })], 'out', null, ['owned_by'])[0]?.to_uri ?? null;
    latest.set(key, {
      uri: e.to_uri,
      ...parts,
      state: e.kind === 'applies_at' ? 'compliant' : 'violating',
      rule: e.from_uri,
      ruleTitle: labelOf(ctx, e.from_uri, null).label,
      component: owner,
      ...(typeof props.source === 'string' ? { source: props.source } : {}),
      ...(at ? { at } : {}),
      order,
    });
  }
  // Reconciled work: code touched by DONE work orders on spec sections that follow these rules applies them there
  // (lower precedence than a recorded verification / finding for the same location).
  for (const t of touchedFollowing(ctx, rules)) {
    const key = `${t.rule}|${t.code}`;
    if (latest.has(key)) continue;
    const parts = codeParts(t.code);
    if (!parts) continue;
    const owner = edgesOf(ctx, [buildNodeUri({ kind: 'code', repo: parts.repo, path: parts.path })], 'out', null, ['owned_by'])[0]?.to_uri ?? null;
    latest.set(key, { uri: t.code, ...parts, state: 'compliant', rule: t.rule, ruleTitle: labelOf(ctx, t.rule, null).label, component: owner, source: t.workOrder, ...(t.at ? { at: t.at } : {}), order: t.at ?? '' });
  }
  // Scope: files the rule(s) / standard govern (appliesTo globs over files known to the graph).
  const inScope = new Set(edgesOf(ctx, ref.sectionId ? rules : [std, ...rules], 'out', null, ['governs']).map((e) => e.to_uri.split('#')[0]!));
  const locations = [...latest.values()].map(({ order: _o, ...l }) => l);
  const fileOf = (l: UsageLocation) => buildNodeUri({ kind: 'code', repo: l.repo, path: l.path });
  const checkedFiles = new Set(locations.map(fileOf));
  const violatingFiles = new Set(locations.filter((l) => l.state === 'violating').map(fileOf));
  const unchecked = [...inScope].filter((f) => !checkedFiles.has(f)).sort();
  // In-scope files never checked are listed as unchecked locations too (first `limit`).
  for (const f of unchecked.slice(0, Math.max(0, inp.limit - locations.length))) {
    const parts = codeParts(f);
    if (!parts) continue;
    const owner = edgesOf(ctx, [f], 'out', null, ['owned_by'])[0]?.to_uri ?? null;
    locations.push({ uri: f, ...parts, state: 'unchecked', rule: ref.sectionId ? uri : std, component: owner });
  }
  const byComponent = new Map<string | null, WhereUsedResponse['byComponent'][number]>();
  for (const l of locations) {
    const c = l.component ?? null;
    let g = byComponent.get(c);
    if (!g) byComponent.set(c, (g = { component: c, label: c ? labelOf(ctx, c, null).label : 'No component', compliant: 0, violating: 0, unchecked: 0 }));
    g[l.state]++;
  }
  const checkedInScope = [...inScope].filter((f) => checkedFiles.has(f)).length;
  return {
    standard: std,
    ...(ref.sectionId ? { rule: uri } : {}),
    locations: locations.slice(0, inp.limit),
    byComponent: [...byComponent.values()].sort((a, b) => b.violating - a.violating || b.compliant + b.violating - (a.compliant + a.violating) || a.label.localeCompare(b.label)),
    coverage: { inScope: inScope.size, checked: checkedInScope, violating: [...inScope].filter((f) => violatingFiles.has(f)).length, unchecked: unchecked.slice(0, inp.limit), ratio: inScope.size ? checkedInScope / inScope.size : null },
  };
}

/** Rules a code location follows / violates (code-ref tooltips). */
export async function codeRules(ctx: GraphContext, input: CodeRulesInput): Promise<CodeRulesResponse> {
  const inp = codeRulesInputSchema.parse(input);
  const n = parseNodeUri(inp.ref);
  if (n?.kind !== 'code') throw new GraphError('code_rules works on code references', 400, 'invalid_input', 'pass mandate://code/<repo>/<path>[#La-Lb]');
  const uri = buildNodeUri(n);
  const file = buildNodeUri({ kind: 'code', repo: n.repo, path: n.path });
  // A range matches recorded ranges overlapping it and whole-file records; a file aggregates its ranges.
  const targets = [...new Set([...expandCode(ctx.db, uri), file])];
  const follows = new Map<string, CodeRulesResponse['follows'][number]>();
  const violates = new Map<string, CodeRulesResponse['violates'][number]>();
  for (const e of edgesOf(ctx, targets, 'in', null, ['applies_at', 'violated_at'])) {
    const std = docOf(e.from_uri);
    // A section label already reads "Standard › Section": keep only its last part after the standard title.
    const label = e.from_uri.includes('/sections/') ? `${labelOf(ctx, std, null).label} › ${labelOf(ctx, e.from_uri, null).label.split(' \u203a ').pop()}` : labelOf(ctx, std, null).label;
    const props = parseJson<Record<string, unknown>>(e.props, {});
    const item = { rule: e.from_uri, standard: std, label, ...(typeof props.source === 'string' ? { source: props.source } : {}) };
    (e.kind === 'applies_at' ? follows : violates).set(e.from_uri, item);
  }
  // Reconciled work orders that touched this code, on spec sections following a rule. Same semantics as
  // standard_where_used (`touchedFollowing`: section-level inheritance only), so the two views agree.
  const touchers = [...new Set(edgesOf(ctx, targets, 'in', null, ['touches']).map((e) => docOf(e.from_uri)))];
  const candidates = new Set<string>();
  for (const wo of touchers) {
    const w = labelOf(ctx, wo, null);
    if (w.kind !== 'work_order' || w.props.status !== 'done') continue;
    const secs = coveredSections(ctx, wo, null);
    for (const r of edgesOf(ctx, secs, 'out', null, ['inherits_rule'])) candidates.add(r.to_uri);
  }
  const targetSet = new Set(targets);
  for (const t of touchedFollowing(ctx, [...candidates])) {
    if (!targetSet.has(t.code) || follows.has(t.rule)) continue;
    const std = docOf(t.rule);
    follows.set(t.rule, { rule: t.rule, standard: std, label: `${labelOf(ctx, std, null).label} › ${labelOf(ctx, t.rule, null).label.split(' \u203a ').pop()}`, source: t.workOrder });
  }
  for (const k of violates.keys()) follows.delete(k);
  return { ref: uri, follows: [...follows.values()], violates: [...violates.values()] };
}

/** Spec sections a work order covers (P4: through its wo-sections; legacy records cover them directly). */
export function coveredSections(ctx: GraphContext, wo: string, seq: number | null): string[] {
  const own = edgesOf(ctx, [wo], 'out', seq, ['has_section']).map((e) => e.to_uri);
  return [...new Set(edgesOf(ctx, [wo, ...own], 'out', seq, ['covers']).map((e) => e.to_uri).filter((u) => u.includes('/sections/')))];
}

/**
 * Code touched by done (reconciled) work orders covering spec sections (or specs) that inherit one of `rules`:
 * `{ rule, code, workOrder, at }` (lineage-brief §4: "from the touched code of work orders whose sections follow the
 * standard, at reconcile").
 */
export function touchedFollowing(ctx: GraphContext, rules: string[]): { rule: string; code: string; workOrder: string; at?: string }[] {
  const out: { rule: string; code: string; workOrder: string; at?: string }[] = [];
  const seen = new Set<string>();
  for (const inh of edgesOf(ctx, rules, 'in', null, ['inherits_rule'])) {
    // Sections that follow the rule (spec-wide inheritance is too broad to place a rule in specific code).
    if (!inh.from_uri.includes('/sections/')) continue;
    const secs = [inh.from_uri];
    for (const cov of edgesOf(ctx, secs, 'in', null, ['covers'])) {
      const wo = docOf(cov.from_uri);
      const w = labelOf(ctx, wo, null);
      if (w.kind !== 'work_order' || w.props.status !== 'done') continue;
      const at = typeof w.props.completedAt === 'string' ? w.props.completedAt : undefined;
      for (const t of edgesOf(ctx, [wo], 'out', null, ['touches'])) {
        if (parseJson<{ change?: string }>(t.props, {}).change === 'deleted') continue;
        const key = `${inh.to_uri}|${t.to_uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ rule: inh.to_uri, code: t.to_uri, workOrder: wo, ...(at ? { at } : {}) });
      }
    }
  }
  return out;
}
