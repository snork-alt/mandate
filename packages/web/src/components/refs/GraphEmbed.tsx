import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Tooltip } from '@mantine/core';
import { IconHash } from '@tabler/icons-react';
import { useQueries } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { mentionOf } from '@mandate/shared';
import { callTool } from '../../mcp/client';
import { CanvasViewer } from '../doc/CanvasViewer';
import { roundedPath, midOf } from '../architecture/layout';
import { KIND_ICON, fallbackLabel, refHref, refKind } from './kinds';
import type { RefNode } from './useRefNode';
import { bestLayout, collapseLeaves, collapseThreshold, edgeKindLabel, mergeEdges, mergeNeighbors, type Graph, type GraphLayout, type Neighbors, type PlacedEdge, type PlacedNode } from './graphLayout';

/** Kind tints, the same as the Ask context picker (rail.css `.ask-picker-icon`). */
const KIND_TINT: Record<string, string> = {
  spec: 'var(--mantine-color-lilac-6)',
  standard: 'var(--mantine-color-teal-6)',
  component: 'var(--mantine-color-blue-6)',
  work_order: 'var(--mantine-color-orange-6)',
  feedback: 'var(--mantine-color-pink-6)',
};
const tint = (k: string) => KIND_TINT[k] ?? 'var(--app-text-muted)';

/** Edge colours per relation kind (legend); unknown kinds stay neutral. */
const EDGE_TINT: Record<string, string> = {
  depends_on: 'var(--mantine-color-blue-5)',
  spec_depends_on: 'var(--mantine-color-blue-3)',
  component_depends_on: 'var(--mantine-color-blue-3)',
  uses_standard: 'var(--mantine-color-teal-5)',
  follows: 'var(--mantine-color-teal-7)',
  deviates_from: 'var(--mantine-color-orange-7)',
  inherits_rule: 'var(--mantine-color-grape-5)',
  affects: 'var(--mantine-color-pink-5)',
  covers: 'var(--mantine-color-cyan-5)',
  verifies: 'var(--mantine-color-green-5)',
  extends: 'var(--mantine-color-lime-7)',
  supersedes: 'var(--mantine-color-lime-7)',
  relates_to: 'var(--mantine-color-lime-7)',
  conflicts_with: 'var(--mantine-color-red-6)',
  acts_on: 'var(--mantine-color-pink-7)',
  similar_to: 'var(--mantine-color-yellow-5)',
  in_repo: 'var(--mantine-color-gray-5)',
};
const NEUTRAL = 'var(--app-text-faint)';
const edgeTint = (e: PlacedEdge) => (e.kinds.length === 1 ? (EDGE_TINT[e.kinds[0]!.kind] ?? NEUTRAL) : NEUTRAL);
const edgeText = (e: PlacedEdge) => e.kinds.map((k) => `${edgeKindLabel(k.kind)}${k.count > 1 ? ` ×${k.count}` : ''}`).join(' · ');

/** Midpoint of the segment touching one end of a polyline. */
function nearEnd(pts: { x: number; y: number }[], end: 'start' | 'end') {
  const [a, b] = end === 'end' ? [pts[pts.length - 2]!, pts[pts.length - 1]!] : [pts[0]!, pts[1]!];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Width of an element (content box), for choosing a layout that fits the rail or the main column. */
function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Small subgraph around the listed refs (graph_neighbors), laid out with ELK in the shared CanvasViewer. */
export function GraphEmbed({ refs, depth }: { refs: string[]; depth: number }) {
  const results = useQueries({
    queries: refs.map((uri) => ({
      queryKey: ['mcp', 'graph_neighbors', uri, depth],
      queryFn: ({ signal }: { signal: AbortSignal }) => callTool<Neighbors>('graph_neighbors', { uri, depth, limit: 12 }, signal),
      staleTime: 30_000,
      retry: false,
    })),
  });
  // Seed titles (the neighbour lists do not include the seed node itself); same cache as RefChip.
  const seeds = useQueries({
    queries: refs.map((r) => {
      const uri = r.trim().replace(/^@mandate:/, '');
      return {
        queryKey: ['mcp', 'node', uri],
        queryFn: async ({ signal }: { signal: AbortSignal }) => (await callTool<{ node: RefNode }>('graph_node', { uri }, signal)).node,
        staleTime: 30_000,
        retry: false,
      };
    }),
  });
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const pending = results.some((r) => r.isPending) || seeds.some((r) => r.isPending);
  const dataKey = [...results, ...seeds].map((r) => r.dataUpdatedAt).join(',');
  const full = useMemo((): Graph | null => {
    if (pending) return null;
    const titles = new Map(refs.map((r, i) => [r.trim().replace(/^@mandate:/, ''), seeds[i]?.data?.label]));
    const m = mergeNeighbors(refs, results.map((r) => r.data), refKind, (u) => titles.get(u) ?? fallbackLabel(u));
    return { nodes: m.nodes, edges: mergeEdges(m.edges) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, dataKey, refs.join('\n')]);
  const inline = useGraphLayout(full, expanded, showAll, width);
  const graph = inline.graph;
  const layout = inline.layout;
  const expand = (id: string) => setExpanded((s) => new Set([...s, id]));
  const toggleAll = () => setShowAll((s) => !s);

  const failed = results.find((r) => r.error);
  let body: React.ReactNode;
  if (pending) body = <div className="embed-sub">Loading graph…</div>;
  else if (failed && results.every((r) => r.error)) body = <div className="embed-sub">Graph unavailable: {(failed.error as Error).message}</div>;
  else if (graph && graph.nodes.length <= refs.length && graph.edges.length === 0) body = <div className="embed-sub">No relations found.</div>;
  else if (layout.error) body = <div className="embed-sub">Layout failed: {layout.error.message}</div>;
  else if (!layout.data) body = <div className="embed-sub">Laying out…</div>;
  else {
    const l = layout.data;
    body = (
      <CanvasViewer
        title="Graph"
        source={JSON.stringify({ refs, depth, nodes: graph!.nodes.map((n) => n.id), edges: graph!.edges.map((e) => ({ from: e.from, to: e.to, kinds: e.kinds })) }, null, 2)}
        sourceLang="json"
        interactive
        reference={() => refs.map((r) => mentionOf(r.trim().replace(/^@mandate:/, ''))).join(' ')}
        maxInlineHeight={460}
        render={({ fullscreen, exitFullscreen }) =>
          fullscreen ? (
            <FullscreenGraph full={full!} expanded={expanded} showAll={showAll} onExpand={expand} onToggle={toggleAll} onNavigate={exitFullscreen} />
          ) : (
            <GraphCanvas layout={l} onExpand={expand} toggle={toggleOf(full!, graph!, showAll, width, toggleAll)} />
          )
        }
      />
    );
  }
  return (
    <div className="embed-card embed-graph" ref={box}>
      {body}
    </div>
  );
}

/** Summary (collapsed) or full graph for a container width, and its ELK layout (async; the previous one stays until ready). */
function useGraphLayout(full: Graph | null, expanded: ReadonlySet<string>, showAll: boolean, width: number) {
  // Round the width so small resizes do not re-run the layout.
  const avail = Math.max(280, Math.floor(((width || 600) - 2) / 40) * 40);
  const threshold = collapseThreshold(avail);
  const graph = useMemo(() => (full && !showAll ? collapseLeaves(full, expanded, threshold) : full), [full, expanded, showAll, threshold]);
  const [layout, setLayout] = useState<{ data?: GraphLayout; error?: Error }>({});
  useEffect(() => {
    if (!graph || !graph.nodes.length) return;
    let live = true;
    bestLayout(graph, avail).then(
      (data) => live && setLayout({ data }),
      (error: Error) => live && setLayout({ error }),
    );
    return () => {
      live = false;
    };
  }, [graph, avail]);
  return { graph, layout };
}

/** "Show all" / "Summarise" when the graph is big enough to be summarised at this width. */
function toggleOf(full: Graph, graph: Graph, showAll: boolean, width: number, onClick: () => void) {
  if (full.nodes.length <= collapseThreshold(width)) return undefined;
  const hidden = graph.hiddenEdges ?? 0;
  return { label: showAll ? 'Summarise' : `Show all ${full.nodes.length} nodes${hidden ? ` · ${hidden} more links` : ''}`, onClick };
}

/** Fullscreen: laid out again for the screen width (roomier, summarised only above the wide threshold). */
function FullscreenGraph({ full, expanded, showAll, onExpand, onToggle, onNavigate }: { full: Graph; expanded: ReadonlySet<string>; showAll: boolean; onExpand: (id: string) => void; onToggle: () => void; onNavigate: () => void }) {
  const width = Math.max(600, window.innerWidth - 80);
  const { graph, layout } = useGraphLayout(full, expanded, showAll, width);
  if (!layout.data || !graph) return <div className="embed-sub">{layout.error ? `Layout failed: ${layout.error.message}` : 'Laying out…'}</div>;
  return <GraphCanvas layout={layout.data} onExpand={onExpand} toggle={toggleOf(full, graph, showAll, width, onToggle)} onNavigate={onNavigate} />;
}

const S = {
  node: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    boxSizing: 'border-box',
    padding: '0 10px 0 8px',
    borderRadius: 13,
    border: '1px solid var(--app-border-strong)',
    background: 'var(--app-surface)',
    color: 'var(--mantine-color-text)',
    font: '500 11px/1 var(--mantine-font-family)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transition: 'opacity 120ms, background 120ms, border-color 120ms',
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  pill: {
    position: 'absolute',
    transform: 'translate(-50%, -50%)',
    padding: '1px 6px',
    borderRadius: 8,
    border: '1px solid var(--app-border-strong)',
    background: 'var(--app-bg)',
    color: 'var(--app-text-muted)',
    font: '500 10px/14px var(--mantine-font-family)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 2,
  },
  legend: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', padding: '6px 12px 2px', font: '400 10.5px/16px var(--mantine-font-family)', color: 'var(--app-text-muted)' },
} satisfies Record<string, CSSProperties>;

/** The laid-out graph: HTML nodes over an SVG edge layer, styled inline so it renders the same inline and in the fullscreen portal. */
export function GraphCanvas({ layout: l, onExpand, toggle, onNavigate }: { layout: GraphLayout; onExpand: (id: string) => void; toggle?: { label: string; onClick: () => void }; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const uid = useId().replace(/:/g, '');
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [hoverKind, setHoverKind] = useState<string | null>(null);
  useEffect(() => setHoverNode(null), [l]);

  const active = (e: PlacedEdge) => e.id === hoverEdge || (hoverNode !== null && (e.from === hoverNode || e.to === hoverNode)) || (hoverKind !== null && e.kinds.some((k) => k.kind === hoverKind));
  const focus = hoverNode ?? hoverEdge ?? hoverKind;
  const lit = new Set<string>();
  if (focus) for (const e of l.edges) if (active(e)) lit.add(e.from).add(e.to);
  if (hoverNode) lit.add(hoverNode);
  const kinds = [...new Set(l.edges.flatMap((e) => e.kinds.map((k) => k.kind)))];
  const width = Math.max(l.width, 200);
  const color = (e: PlacedEdge) => (focus && active(e) ? 'var(--mantine-primary-color-filled)' : edgeTint(e));

  const open = (n: PlacedNode) => {
    if (n.group) return onExpand(n.id);
    const href = refHref(n.id);
    if (!href) return;
    onNavigate?.();
    void navigate(href);
  };

  const marker = (id: string, fill: string) => (
    <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path d="M0,0.8 L7.5,4 L0,7.2 z" style={{ fill }} />
    </marker>
  );
  const markers = new Map<string, string>();
  const markerFor = (c: string) => {
    if (!markers.has(c)) markers.set(c, `gm-${uid}-${markers.size}`);
    return markers.get(c)!;
  };
  const paths = l.edges.map((e) => {
    const c = color(e);
    const m = markerFor(c);
    const on = !focus || active(e);
    return (
      <g key={e.id} style={{ opacity: on ? 1 : 0.25, transition: 'opacity 120ms' }} onMouseEnter={() => setHoverEdge(e.id)} onMouseLeave={() => setHoverEdge(null)}>
        <path d={roundedPath(e.points, 8)} style={{ fill: 'none', stroke: 'transparent', strokeWidth: 10, pointerEvents: 'stroke' }} />
        <path
          d={roundedPath(e.points, 8)}
          style={{ fill: 'none', stroke: c, strokeWidth: focus && active(e) ? 1.6 : 1.2 }}
          markerEnd={`url(#${m})`}
          markerStart={e.both ? `url(#${m})` : undefined}
        />
      </g>
    );
  });

  return (
    <div style={{ width, fontFamily: 'var(--mantine-font-family)' }} onMouseLeave={() => { setHoverNode(null); setHoverEdge(null); }}>
      <div style={{ position: 'relative', width: l.width, height: l.height, margin: '0 auto' }} role="img" aria-label={`Relation graph: ${l.nodes.length} nodes, ${l.edges.length} edges`}>
        <svg width={l.width} height={l.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <defs>{[...new Set(l.edges.map(color))].map((c) => marker(markerFor(c), c))}</defs>
          {paths}
        </svg>
        {l.edges.map((e) => {
          const mid = midOf(e.points);
          if (!mid) return null;
          if (hoverEdge === e.id || (hoverNode && active(e))) {
            // On node hover, label each edge next to the node at its far end (labels of a fan stay apart).
            const pt = hoverEdge === e.id ? mid : nearEnd(e.points, hoverNode === e.from ? 'end' : 'start');
            return (
              <span key={e.id} style={{ ...S.pill, left: pt.x, top: pt.y, color: 'var(--mantine-color-text)', borderColor: 'var(--mantine-primary-color-filled)' }}>
                {edgeText(e)}
              </span>
            );
          }
          if (e.count > 1 && !focus) {
            return (
              <span key={e.id} style={{ ...S.pill, left: mid.x, top: mid.y, padding: '0 4px', minWidth: 14, textAlign: 'center', font: '600 9px/12px var(--mantine-font-family)' }}>
                {e.count}
              </span>
            );
          }
          return null;
        })}
        {l.nodes.map((n) => {
          const Icon = (KIND_ICON as Record<string, typeof IconHash>)[n.kind] ?? IconHash;
          const href = n.group ? null : refHref(n.id);
          const dim = focus && !lit.has(n.id);
          const hov = hoverNode === n.id;
          const style: CSSProperties = {
            ...S.node,
            left: n.x,
            top: n.y,
            width: n.w,
            height: n.h,
            opacity: dim ? 0.35 : 1,
            cursor: href || n.group ? 'pointer' : 'default',
            ...(n.seed ? { background: 'var(--mantine-primary-color-light)', borderColor: 'var(--mantine-primary-color-filled)', borderWidth: 1.5, fontWeight: 600 } : null),
            ...(n.group ? { borderStyle: 'dashed', color: 'var(--app-text-muted)', background: 'var(--app-bg)' } : null),
            ...(hov && !n.seed ? { background: 'var(--app-hover)', borderColor: 'var(--mantine-primary-color-filled)' } : null),
          };
          const tip = n.group ? (
            <span>
              {n.label}
              <br />
              <span style={{ opacity: 0.7 }}>Click to expand</span>
            </span>
          ) : (
            <span>
              {n.label}
              <span style={{ opacity: 0.7 }}> · {edgeKindLabel(n.kind)}</span>
            </span>
          );
          return (
            <Tooltip key={n.id} label={tip} withinPortal openDelay={250} multiline maw={320} fz="xs">
              <button
                type="button"
                data-ref={n.group ? undefined : n.id}
                data-seed={n.seed || undefined}
                data-group={n.group ? true : undefined}
                className="graph-node"
                style={style}
                onMouseEnter={() => setHoverNode(n.id)}
                onMouseLeave={() => setHoverNode(null)}
                onClick={() => open(n)}
              >
                <Icon size={13} stroke={1.8} style={{ flex: 'none', color: tint(n.kind), stroke: tint(n.kind) }} />
                <span style={S.label}>{n.short}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      {(kinds.length > 0 || toggle) && (
        <div style={S.legend}>
          {kinds.map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'default', color: hoverKind === k ? 'var(--mantine-color-text)' : undefined }} onMouseEnter={() => setHoverKind(k)} onMouseLeave={() => setHoverKind(null)}>
              <svg width="14" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="14" y2="3" style={{ stroke: EDGE_TINT[k] ?? NEUTRAL, strokeWidth: 2 }} />
              </svg>
              {edgeKindLabel(k)}
            </span>
          ))}
          {toggle && (
            <button type="button" onClick={toggle.onClick} style={{ marginLeft: 'auto', border: 0, background: 'none', padding: 0, font: 'inherit', color: 'var(--mantine-primary-color-filled)', cursor: 'pointer' }}>
              {toggle.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
