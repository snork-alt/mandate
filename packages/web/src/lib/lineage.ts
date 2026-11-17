import { useQuery } from '@tanstack/react-query';
import {
  buildFindingRef,
  buildRef,
  parseNodeUri,
  CAUSAL_EDGES,
  type CodeRulesResponse,
  type LineageEdge,
  type LineageEvent,
  type LineageSummary,
  type LineageDirection,
  type LineageNode,
  type LineageResponse,
  type LineageStatus,
  type WhereUsedResponse,
  type WritersResponse,
} from '@mandate/shared';
import type { RefKind } from '@mandate/shared/refs';
import { callTool, McpToolError } from '../mcp/client';
import { parseProjectPath } from '../project';

const MENTION = /^@mandate:/i;
/** A reference without its `@mandate:` prefix. */
export const bareRef = (r: string) => r.trim().replace(MENTION, '');

export interface LineageArgs {
  ref: string;
  direction?: LineageDirection;
  depth?: number;
  at?: string;
  status?: LineageStatus[];
  kinds?: string[];
  hideHistory?: boolean;
  limit?: number;
  /** Include structural edges (default false: causal lineage only). */
  structure?: boolean;
  /** Also return the chronological story. */
  story?: boolean;
  eventLimit?: number;
}

/** Lineage args as sent (defaults left to the server, empty filters dropped). */
export function lineageCallArgs(a: LineageArgs): Record<string, unknown> {
  return {
    ref: bareRef(a.ref),
    ...(a.direction ? { direction: a.direction } : {}),
    ...(a.depth ? { depth: a.depth } : {}),
    ...(a.at ? { at: a.at } : {}),
    ...(a.status?.length ? { status: a.status } : {}),
    ...(a.kinds?.length ? { kinds: a.kinds } : {}),
    ...(a.hideHistory === false ? { hideHistory: false } : {}),
    ...(a.limit ? { limit: a.limit } : {}),
    ...(a.structure ? { structure: true } : {}),
    ...(a.story ? { story: true } : {}),
    ...(a.eventLimit ? { eventLimit: a.eventLimit } : {}),
  };
}

const STALE = 15_000;

/** `lineage` for one element (cached per arguments; refetched by live activity through the `mcp` key). */
export function useLineage(args: LineageArgs | null, enabled = true) {
  const a = args ? lineageCallArgs(args) : null;
  return useQuery<LineageResponse, McpToolError>({
    queryKey: ['mcp', 'lineage', a],
    queryFn: ({ signal }) => callTool<LineageResponse>('lineage', a!, signal),
    enabled: enabled && !!a && !!a.ref,
    staleTime: STALE,
    retry: false,
    placeholderData: (p) => p,
  });
}

/** `standard_where_used` for a standard or a rule section. */
export function useWhereUsed(ref: string, enabled = true) {
  return useQuery<WhereUsedResponse, McpToolError>({
    queryKey: ['mcp', 'standard_where_used', ref],
    queryFn: ({ signal }) => callTool<WhereUsedResponse>('standard_where_used', { ref: bareRef(ref) }, signal),
    enabled: enabled && !!ref,
    staleTime: STALE,
    retry: false,
  });
}

/** `code_rules` for a code reference (lazy: tooltips enable it on open; cached per reference). */
export function useCodeRules(ref: string, enabled = true) {
  return useQuery<CodeRulesResponse, McpToolError>({
    queryKey: ['mcp', 'code_rules', ref],
    queryFn: ({ signal }) => callTool<CodeRulesResponse>('code_rules', { ref: bareRef(ref) }, signal),
    enabled: enabled && !!ref,
    staleTime: 60_000,
    retry: false,
  });
}

/** `writers_recent` (Settings). `call` overrides the transport (Settings runs outside a project). */
export function useWriters(call: ((name: string, args: Record<string, unknown>) => Promise<WritersResponse>) | null, key: string | null, limit = 500) {
  return useQuery<WritersResponse, McpToolError>({
    queryKey: ['writers_recent', key, limit],
    queryFn: () => call!('writers_recent', { limit }),
    enabled: !!call && !!key,
    staleTime: 30_000,
    retry: false,
  });
}

/* ------------------------------------------------------------------ status */

export const STATUS_META: Record<LineageStatus, { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'done' },
  in_progress: { label: 'In progress', tone: 'progress' },
  attention: { label: 'Needs attention', tone: 'attention' },
  neutral: { label: 'Neutral', tone: 'neutral' },
};

/* ------------------------------------------------------------------ input -> reference */

const DOC_KINDS = new Set<RefKind>(['specs', 'standards', 'components', 'audits', 'work-orders', 'feedback']);

/**
 * Any element the user can paste: an `@mandate:` mention, a node reference, or a UI link
 * (`https://host/p/<project>/specs/x?version=<sha>#section-y`, `/audits/a#finding-f1`). Null when not a reference.
 */
export function refFromInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const bare = bareRef(t);
  if (parseNodeUri(bare)) return bare;
  let url: URL;
  try {
    url = new URL(t, 'http://x');
  } catch {
    return null;
  }
  if (!t.includes('/')) return null;
  const path = parseProjectPath(url.pathname)?.rest ?? url.pathname;
  const m = /^\/([a-z-]+)\/([^/?#]+)/.exec(path);
  if (!m || !DOC_KINDS.has(m[1] as RefKind)) return null;
  const kind = m[1] as RefKind;
  const id = decodeURIComponent(m[2]!).split('@')[0]!;
  const hash = decodeURIComponent(url.hash.slice(1));
  if (kind === 'audits' && hash.startsWith('finding-')) return buildFindingRef({ audit: id, id: hash.slice(8) });
  const sectionId = hash.startsWith('section-') ? hash.slice(8) : undefined;
  const commit = url.searchParams.get('version') ?? undefined;
  try {
    return buildRef({ kind, id, ...(sectionId && kind !== 'work-orders' && kind !== 'feedback' ? { sectionId } : {}), ...(commit && kind !== 'work-orders' && kind !== 'feedback' ? { commit } : {}) } as Parameters<typeof buildRef>[0]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ declutter (pure, unit-tested) */

const CAUSAL = new Set<string>(CAUSAL_EDGES);
/** A causal edge: recorded at write time, or one of the flow edges (feedback -> change -> work order -> code ...). */
export const isCausalEdge = (e: Pick<LineageEdge, 'kind' | 'recorded'>) => e.recorded || CAUSAL.has(e.kind);

/**
 * "Show all" off: drop neutral nodes without any causal edge (the element itself always stays), and the edges that
 * pointed at them.
 */
export function causalOnly(nodes: LineageNode[], edges: LineageEdge[], rootUri: string): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const causal = new Set<string>();
  for (const e of edges) if (isCausalEdge(e)) causal.add(e.from), causal.add(e.to);
  const keep = nodes.filter((n) => n.uri === rootUri || n.status !== 'neutral' || causal.has(n.uri));
  const ids = new Set(keep.map((n) => n.uri));
  return { nodes: keep, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** Node of the graph: a lineage node, or a collapsed group of siblings. */
export interface GraphItem {
  uri: string;
  kind: string;
  label: string;
  layer: number;
  status: LineageStatus;
  node?: LineageNode;
  /** Collapsed siblings (group items only). */
  members?: LineageNode[];
  createdAt?: LineageNode['createdAt'];
}

export const GROUP_PREFIX = 'group:';
const KIND_PLURAL: Record<string, string> = { work_order: 'work orders', code_file: 'files', code_range: 'code ranges', verification: 'verifications', finding: 'findings', feedback: 'requests', comment: 'comments', commit: 'commits', spec: 'specs', standard: 'standards', component: 'components', audit: 'audits' };

/** The document a node belongs to (sections -> their spec / standard); null for documents and other kinds. */
function parentOf(n: LineageNode): string | null {
  const r = parseNodeUri(n.uri);
  if (r && 'sectionId' in r && r.sectionId) return buildRef({ kind: r.kind, id: r.id } as Parameters<typeof buildRef>[0]);
  return null;
}

const worst = (ss: LineageStatus[]): LineageStatus => (ss.includes('attention') ? 'attention' : ss.includes('in_progress') ? 'in_progress' : ss.includes('done') ? 'done' : 'neutral');

/**
 * Collapse siblings: more than `threshold` nodes of the same kind (and, for sections, the same document) in one layer
 * become one group item ("12 sections of Login with SSO", "8 rules of Security baseline"), unless expanded. Edges are
 * re-pointed at the group and de-duplicated (self-loops dropped).
 */
export function groupSiblings(nodes: LineageNode[], edges: LineageEdge[], rootUri: string, expanded: ReadonlySet<string> = new Set(), threshold = 3): { items: GraphItem[]; edges: (LineageEdge & { id: string })[] } {
  const label = new Map(nodes.map((n) => [n.uri, n.label]));
  const buckets = new Map<string, LineageNode[]>();
  for (const n of nodes) {
    if (n.uri === rootUri) continue;
    const parent = n.kind === 'section' ? parentOf(n) : null;
    const key = `${GROUP_PREFIX}${n.layer}:${n.kind}:${parent ?? ''}`;
    buckets.set(key, [...(buckets.get(key) ?? []), n]);
  }
  const into = new Map<string, string>();
  const items: GraphItem[] = [];
  const grouped = new Set<string>();
  for (const [key, ms] of buckets) {
    if (ms.length <= threshold || expanded.has(key)) continue;
    const kind = ms[0]!.kind;
    const parent = key.split(':').slice(3).join(':');
    const isRules = kind === 'section' && parseNodeUri(parent)?.kind === 'standards';
    const what = kind === 'section' ? (isRules ? 'rules' : 'sections') : (KIND_PLURAL[kind] ?? `${kind.replace(/_/g, ' ')}s`);
    const of = parent ? ` of ${label.get(parent) ?? (parseNodeUri(parent) as { id?: string } | null)?.id ?? parent}` : '';
    items.push({ uri: key, kind, label: `${ms.length} ${what}${of}`, layer: ms[0]!.layer, status: worst(ms.map((m) => m.status)), members: ms, createdAt: ms.map((m) => m.createdAt).filter(Boolean).sort((a, b) => a!.date.localeCompare(b!.date))[0] ?? null });
    for (const m of ms) into.set(m.uri, key), grouped.add(m.uri);
  }
  for (const n of nodes) if (!grouped.has(n.uri)) items.push({ uri: n.uri, kind: n.kind, label: n.label, layer: n.layer, status: n.status, node: n, createdAt: n.createdAt });
  const seen = new Set<string>();
  const out: (LineageEdge & { id: string })[] = [];
  for (const e of edges) {
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (from === to) continue;
    const id = `${from}->${to}`;
    if (seen.has(id)) {
      // Keep "recorded" if any of the merged edges was recorded; "inferred" only if every merged edge is.
      const have = out.find((x) => x.id === id)!;
      if (e.recorded) have.recorded = true;
      if (e.confidence !== 'low') delete have.confidence;
      continue;
    }
    seen.add(id);
    out.push({ ...e, from, to, id });
  }
  return { items, edges: out };
}

/* ------------------------------------------------------------------ layering (pure, unit-tested) */

export const LIN_NODE_W = 220;
export const LIN_NODE_H = 76;
export const LIN_GAP_X = 28;
export const LIN_GAP_Y = 70;
/** Wrapped sub-rows of one layer sit closer together. */
export const LIN_WRAP_GAP_Y = 22;
/** Extra horizontal space between kind groups in a row. */
export const LIN_GROUP_GAP = 36;
/** Items per row before a layer wraps (keeps depth 3 readable without zooming). */
export const LIN_MAX_PER_ROW = 4;

export interface PlacedItem {
  item: GraphItem;
  x: number;
  y: number;
}

export interface LineageLayoutResult {
  nodes: PlacedItem[];
  /** Layers top to bottom: layer number, y of its first sub-row and the number of items. */
  rows: { layer: number; y: number; count: number }[];
  width: number;
  height: number;
}

const KIND_ORDER = ['feedback', 'finding', 'audit', 'work_order', 'spec', 'standard', 'section', 'component', 'verification', 'comment', 'pull_request', 'commit', 'code_commit', 'code_file', 'code_range', 'symbol'];
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
};

/**
 * Layered layout: the element in the centre row (layer 0), causes above (negative layers), effects below; each layer is
 * grouped by kind (stable kind order, then label), wrapped after `maxPerRow` items and centred on x = 0.
 */
export function layoutLineage(items: (GraphItem | LineageNode)[], maxPerRow = LIN_MAX_PER_ROW): LineageLayoutResult {
  const all: GraphItem[] = items.map((i) => ('node' in i || 'members' in i ? (i as GraphItem) : { uri: i.uri, kind: i.kind, label: i.label, layer: i.layer, status: i.status, node: i as LineageNode, createdAt: (i as LineageNode).createdAt }));
  const byLayer = new Map<number, GraphItem[]>();
  for (const n of all) byLayer.set(n.layer, [...(byLayer.get(n.layer) ?? []), n]);
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const placed: PlacedItem[] = [];
  const rows: LineageLayoutResult['rows'] = [];
  let width = 0;
  let y = 0;
  let zero = 0;
  for (const layer of layers) {
    const row = byLayer.get(layer)!.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label) || a.uri.localeCompare(b.uri));
    if (layer === 0) zero = y;
    rows.push({ layer, y, count: row.length });
    for (let i = 0; i < row.length; i += maxPerRow) {
      const sub = row.slice(i, i + maxPerRow);
      const groups = new Set(sub.map((n) => n.kind)).size;
      const rowW = sub.length * LIN_NODE_W + (sub.length - 1) * LIN_GAP_X + (groups - 1) * LIN_GROUP_GAP;
      width = Math.max(width, rowW);
      let x = -rowW / 2;
      let prev: string | null = null;
      for (const n of sub) {
        if (prev !== null && prev !== n.kind) x += LIN_GROUP_GAP;
        placed.push({ item: n, x, y });
        x += LIN_NODE_W + LIN_GAP_X;
        prev = n.kind;
      }
      y += LIN_NODE_H + (i + maxPerRow < row.length ? LIN_WRAP_GAP_Y : LIN_GAP_Y);
    }
  }
  // Centre row (the element) at y = 0.
  for (const p of placed) p.y -= zero;
  for (const r of rows) r.y -= zero;
  return { nodes: placed, rows, width, height: Math.max(0, y - LIN_GAP_Y) };
}

/* ------------------------------------------------------------------ story (pure, unit-tested) */

export interface StoryDay {
  day: string;
  events: LineageEvent[];
}

/** Events grouped by local day; `asc`: oldest first (newest at the bottom), `desc`: newest first. */
export function storyDays(events: LineageEvent[], order: 'asc' | 'desc' = 'asc'): StoryDay[] {
  const sorted = events.slice().sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  if (order === 'desc') sorted.reverse();
  const days: StoryDay[] = [];
  for (const e of sorted) {
    const d = new Date(e.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const last = days[days.length - 1];
    if (last?.day === day) last.events.push(e);
    else days.push({ day, events: [e] });
  }
  return days;
}

/** `through`: one link ends at this row and the next one in the same lane starts here (a continuous line through the dot). */
export type GutterCell = 'none' | 'start' | 'mid' | 'end' | 'through';
export interface GutterLayout {
  lanes: number;
  /** Per displayed event: the cell of each lane (`start` / `end`: the link attaches to this event's dot). */
  cells: GutterCell[][];
  /** Lanes passing through the boundary before displayed event `k` (day headers). */
  passing: (k: number) => number[];
  links: { from: number; to: number; lane: number }[];
}

/**
 * Git-graph-like gutter for the story: one vertical line per causal link (`causedBy`) between the displayed rows of
 * the cause and the effect, packed greedily into the fewest lanes. Works for either display order.
 */
export function gutterLayout(display: LineageEvent[]): GutterLayout {
  const index = new Map(display.map((e, i) => [e.id, i]));
  const spans = display
    .map((e, i) => (e.causedBy && index.has(e.causedBy) ? { a: Math.min(i, index.get(e.causedBy)!), b: Math.max(i, index.get(e.causedBy)!) } : null))
    .filter((x): x is { a: number; b: number } => !!x && x.a !== x.b)
    .sort((x, y) => x.a - y.a || x.b - y.b);
  const laneEnd: number[] = [];
  const links: GutterLayout['links'] = [];
  for (const s of spans) {
    // A lane is free from the row where its last link ends (the line continues through that dot).
    let lane = laneEnd.findIndex((end) => end <= s.a);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = s.b;
    links.push({ from: s.a, to: s.b, lane });
  }
  const lanes = laneEnd.length;
  const cells: GutterCell[][] = display.map(() => Array.from({ length: lanes }, () => 'none' as GutterCell));
  for (const l of links) {
    cells[l.from]![l.lane] = cells[l.from]![l.lane] === 'end' ? 'through' : 'start';
    cells[l.to]![l.lane] = cells[l.to]![l.lane] === 'start' ? 'through' : 'end';
    for (let k = l.from + 1; k < l.to; k++) cells[k]![l.lane] = 'mid';
  }
  return { lanes, cells, links, passing: (k) => links.filter((l) => l.from < k && l.to >= k).map((l) => l.lane).sort((a, b) => a - b) };
}

/* ------------------------------------------------------------------ summary chips */

export interface SummaryChip {
  id: string;
  label: string;
  /** Node kinds it shows in the graph. */
  nodeKinds: string[];
  /** Story event kinds it shows (`sections`: events that changed sections). */
  eventKinds: string[];
  changing: boolean;
}

/** The "Changed / Changing" summary as clickable filters (zero counts left out). */
export function summaryChips(s: LineageSummary | undefined): SummaryChip[] {
  if (!s) return [];
  const c = s.changed;
  const g = s.changing;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const chips: (SummaryChip & { n: number })[] = [
    { id: 'sections', n: c.sections, label: plural(c.sections, 'section'), nodeKinds: ['section'], eventKinds: ['sections'], changing: false },
    { id: 'docs', n: c.docs, label: plural(c.docs, 'document'), nodeKinds: ['spec', 'standard'], eventKinds: ['spec', 'standard'], changing: false },
    { id: 'components', n: c.components, label: plural(c.components, 'component'), nodeKinds: ['component'], eventKinds: ['component'], changing: false },
    { id: 'files', n: c.files, label: plural(c.files, 'file'), nodeKinds: ['code_file', 'code_range'], eventKinds: ['other'], changing: false },
    { id: 'workOrders', n: c.workOrders, label: plural(c.workOrders, 'work order'), nodeKinds: ['work_order'], eventKinds: ['work_order'], changing: false },
    { id: 'commits', n: c.commits, label: plural(c.commits, 'commit'), nodeKinds: ['commit', 'code_commit'], eventKinds: [], changing: false },
    { id: 'changing-wo', n: g.workOrders, label: plural(g.workOrders, 'work order'), nodeKinds: ['work_order'], eventKinds: ['work_order'], changing: true },
    { id: 'changing-findings', n: g.findings, label: plural(g.findings, 'finding'), nodeKinds: ['finding'], eventKinds: ['audit'], changing: true },
    { id: 'changing-feedback', n: g.feedback, label: plural(g.feedback, 'request'), nodeKinds: ['feedback'], eventKinds: ['feedback'], changing: true },
  ];
  return chips.filter((x) => x.n > 0).map(({ n: _n, ...x }) => x);
}

/** Does a story event match a chip? */
export const eventMatches = (e: LineageEvent, chip: SummaryChip | null) =>
  !chip || chip.eventKinds.includes(e.kind) || (chip.eventKinds.includes('sections') && !!e.sections?.length);

/** "3m", "2h", "4d" (step durations). */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.abs(ms) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Split lineage nodes for the panel: causes (Why), effects (Led to) and the collapsed "also affected" ring. */
export function splitLineage(r: Pick<LineageResponse, 'nodes' | 'root'>): { why: LineageNode[]; ledTo: LineageNode[]; alsoAffected: LineageNode[] } {
  const others = (r.nodes ?? []).filter((n) => n.uri !== r.root.uri && n.layer !== 0);
  const why = others.filter((n) => n.layer < 0).sort((a, b) => b.layer - a.layer);
  const down = others.filter((n) => n.layer > 0).sort((a, b) => a.layer - b.layer);
  // Direct effects and anything with a status are the primary list; farther neutral nodes are the "also affected" ring.
  const ledTo = down.filter((n) => n.layer === 1 || n.status !== 'neutral');
  const alsoAffected = down.filter((n) => !(n.layer === 1 || n.status !== 'neutral'));
  return { why, ledTo, alsoAffected };
}
