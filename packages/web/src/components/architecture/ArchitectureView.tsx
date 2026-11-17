import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Menu, Select, Switch, Tooltip, useComputedColorScheme } from '@mantine/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  getSmoothStepPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  IconAlertTriangle,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconAt,
  IconBox,
  IconBrandStripe,
  IconChevronDown,
  IconChevronRight,
  IconClipboardList,
  IconCloud,
  IconDatabase,
  IconFileText,
  IconFocus2,
  IconLink,
  IconLock,
  IconMessageReport,
  IconPackage,
  IconRuler2,
  IconServer,
  IconX,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, ComponentKind } from '@mandate/shared';
import { mentionOf, refMention } from '@mandate/shared/refs';
import { useNavigate } from 'react-router';
import { api } from '../../api';
import { EmptyView, ErrorState } from '../ListStates';
import { copyText } from '../../lib/copy';
import type { CopyTarget } from '../../lib/refs';
import { copyTargetProps, CopyMenu } from '../copy';
import { sectionAnchor } from '../doc/anchors';
import { ArchAuditDot, ArchAuditProvider } from '../audits/ArchAudit';
import { ComponentMaturityDot } from '../maturity/SpecMaturity';
import { defaultCollapsed, GUTTER, layoutArchitecture, midOf, roundedPath, type Band, type Layout, type PlacedEdge, type PlacedNode } from './layout';

export const KIND_ICON: Record<ComponentKind, typeof IconServer> = {
  service: IconServer,
  module: IconPackage,
  library: IconBox,
  datastore: IconDatabase,
  external: IconCloud,
};

function nodeTarget(n: ArchitectureNode): CopyTarget {
  return { label: 'component', ref: refMention({ kind: 'components', id: n.id }), link: `${location.origin}/components/${n.id}` };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kindIcon = (n: ArchitectureNode) => (n.id === 'stripe' ? IconBrandStripe : KIND_ICON[n.kind]);

/** Counts badge (specs affecting it, standards followed) and the overlay chips that are non-zero. */
function Badges({ n, compact }: { n: ArchitectureNode; compact?: boolean }) {
  const o = n.overlay;
  const chips: { key: string; icon: React.ReactNode; text: string; tone?: string; tip: string }[] = [];
  if (o.workOrders) chips.push({ key: 'wo', icon: <IconClipboardList size={11} />, text: `${o.workOrders}`, tip: `${plural(o.workOrders, 'open work order')}${o.claims.length ? `, claimed by ${o.claims.join(', ')}` : ''}` });
  if (o.openFeedback) chips.push({ key: 'fb', icon: <IconMessageReport size={11} />, text: `${o.openFeedback}`, tip: plural(o.openFeedback, 'open request') });
  if (o.blocked) chips.push({ key: 'bl', icon: <IconLock size={11} />, text: `${o.blocked}`, tone: 'danger', tip: `${plural(o.blocked, 'affecting spec')} blocked` });
  if (o.drifted) chips.push({ key: 'dr', icon: <IconAlertTriangle size={11} />, text: `${o.drifted}`, tone: 'warn', tip: `${plural(o.drifted, 'affecting spec')} drifted since done` });
  if (o.upstreamChanged) chips.push({ key: 'up', icon: <IconAlertTriangle size={11} />, text: `${o.upstreamChanged}`, tone: 'warn', tip: `${plural(o.upstreamChanged, 'section')}: an interface it depends on changed` });
  if (o.failing) chips.push({ key: 'fa', icon: <IconX size={11} />, text: `${o.failing}`, tone: 'danger', tip: `${o.failing} failing criteria in affecting specs` });
  const standards = o.standards ?? 0;
  return (
    <span className="arch-badges">
      <Tooltip label={`${plural(o.specs, 'spec')} affecting it (incl. code its children own) · ${plural(standards, 'standard')} followed`} withinPortal>
        <span className="arch-count" data-empty={!o.specs && !standards ? true : undefined}>
          <span>
            <IconFileText size={11} />
            {o.specs}
          </span>
          <span className="arch-count-sep" />
          <span>
            <IconRuler2 size={11} />
            {standards}
          </span>
        </span>
      </Tooltip>
      {!compact && chips.map((c) => (
        <Tooltip key={c.key} label={c.tip} withinPortal>
          <span className="arch-chip" data-tone={c.tone}>
            {c.icon}
            {c.text}
          </span>
        </Tooltip>
      ))}
      {!compact && o.claims.length > 0 && (
        <Tooltip label={`Claimed by ${o.claims.join(', ')}`} withinPortal>
          <span className="arch-chip" data-tone="accent">
            {plural(o.claims.length, 'claim')}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

function NodeTip({ n }: { n: ArchitectureNode }) {
  return (
    <div className="arch-tip">
      <div className="arch-tip-text">{n.responsibility ?? n.summary ?? n.title}</div>
      <div className="arch-tip-meta">
        Layer: {n.layer}
        {n.layerSource === 'derived' ? ' (derived from depends_on)' : n.layerSource === 'inherited' ? ' (inherited from its parent)' : ''}
      </div>
      {n.owns.length > 0 ? (
        <div className="arch-tip-owns">
          {n.owns.slice(0, 6).map((o) => (
            <code key={o}>{o}</code>
          ))}
          {n.owns.length > 6 && <span>+{n.owns.length - 6} more</span>}
        </div>
      ) : (
        <div className="arch-tip-meta">Owns no code{n.kind === 'external' ? ' (external)' : ''}</div>
      )}
    </div>
  );
}

/** Right-click menu of a component (copy reference first). */
function NodeMenu({ n, opened, onChange, children }: { n: ArchitectureNode; opened: boolean; onChange: (o: boolean) => void; children: React.ReactNode }) {
  const { onFocus } = useContext(FlowCtx);
  const target = nodeTarget(n);
  return (
    <Menu opened={opened} onChange={onChange} position="bottom-start" width={230} withinPortal>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Copy component</Menu.Label>
        <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(target.ref)}>
          Copy reference
        </Menu.Item>
        <Menu.Item leftSection={<IconLink size={14} />} onClick={() => void copyText(target.link!, 'Link copied')}>
          Copy link
        </Menu.Item>
        <Menu.Item leftSection={<IconFocus2 size={14} />} onClick={() => onFocus(n.id)}>
          Focus upstream and downstream
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function FocusButton({ n }: { n: ArchitectureNode }) {
  const { onFocus } = useContext(FlowCtx);
  return (
    <Tooltip label="Focus: highlight its upstream and downstream" openDelay={300}>
      <button
        type="button"
        className="arch-node-focus nodrag"
        aria-label={`Focus ${n.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onFocus(n.id);
        }}
      >
        <IconFocus2 size={13} />
      </button>
    </Tooltip>
  );
}

function ToggleButton({ n, open }: { n: ArchitectureNode; open: boolean }) {
  const { toggle } = useContext(FlowCtx);
  return (
    <Tooltip label={open ? 'Collapse: hide its children (their edges attach to it)' : 'Expand: show its children'} multiline maw={320} openDelay={300}>
      <button
        type="button"
        className="arch-group-toggle nodrag"
        aria-label={`${open ? 'Collapse' : 'Expand'} ${n.title}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggle(n.id);
        }}
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      </button>
    </Tooltip>
  );
}

function NodeCard({ p }: { p: PlacedNode }) {
  const n = p.n;
  const [menu, setMenu] = useState(false);
  const Icon = kindIcon(n);
  const { open } = useContext(FlowCtx);
  return (
    <NodeMenu n={n} opened={menu} onChange={setMenu}>
      <div
        className="arch-node"
        data-kind={n.kind}
        data-status={n.status}
        data-focus={n.focus}
        data-diff={n.diff}
        data-collapsed={p.group === 'collapsed' || undefined}
        role="link"
        tabIndex={0}
        aria-label={`${n.title} (${n.kind}, ${n.status}, layer ${n.layer})`}
        onKeyDown={(e) => e.key === 'Enter' && open(n)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        {...copyTargetProps(nodeTarget(n))}
      >
        <Tooltip label={<NodeTip n={n} />} multiline openDelay={300} withinPortal position="bottom">
          <div className="arch-node-inner">
            <div className="arch-node-head">
              <span className="arch-node-icon">
                <Icon size={15} stroke={1.7} />
              </span>
              <span className="arch-node-titles">
                <span className="arch-node-title">
                  {n.title}
                  <ArchAuditDot id={n.id} />
                  <ComponentMaturityDot ids={[n.id, ...n.children]} />
                </span>
                <span className="arch-node-kind">
                  {n.kind}
                  {n.repos[0] ? ` · ${n.repos.join(', ')}` : ''}
                </span>
              </span>
              {n.status !== 'active' && <span className="arch-status">{n.status}</span>}
            </div>
            <span className="arch-node-foot">
              <Badges n={n} />
              {p.group === 'collapsed' && (
                <Tooltip label={`${plural(p.hidden, 'nested component')} hidden`} openDelay={300}>
                  <span className="arch-children-pill">+{p.hidden}</span>
                </Tooltip>
              )}
            </span>
          </div>
        </Tooltip>
        {p.group === 'collapsed' && <ToggleButton n={n} open={false} />}
        <FocusButton n={n} />
      </div>
    </NodeMenu>
  );
}

/** An expanded containing component: header (title, status, counts, collapse) above its children. */
function GroupBox({ p }: { p: PlacedNode }) {
  const n = p.n;
  const [menu, setMenu] = useState(false);
  const Icon = kindIcon(n);
  const { open } = useContext(FlowCtx);
  return (
    <div className="arch-group" data-status={n.status} data-focus={n.focus} data-diff={n.diff}>
      <NodeMenu n={n} opened={menu} onChange={setMenu}>
        <div
          className="arch-group-head"
          role="link"
          tabIndex={0}
          aria-label={`${n.title} (contains ${plural(n.children.length, 'component')})`}
          onKeyDown={(e) => e.key === 'Enter' && open(n)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
          }}
          {...copyTargetProps(nodeTarget(n))}
        >
          <ToggleButton n={n} open />
          <Tooltip label={<NodeTip n={n} />} multiline openDelay={300} withinPortal position="bottom-start">
            <span className="arch-group-title">
              <Icon size={14} stroke={1.7} />
              <span className="arch-node-title">{n.title}</span>
              <ArchAuditDot id={n.id} />
              <ComponentMaturityDot ids={[n.id, ...n.children]} />
              {n.status !== 'active' && <span className="arch-status">{n.status}</span>}
            </span>
          </Tooltip>
          <span style={{ flex: 1 }} />
          <Badges n={n} compact />
          <FocusButton n={n} />
        </div>
      </NodeMenu>
    </div>
  );
}

/* ---------------------------------------------------------------- React Flow */

type CardNode = Node<{ p: PlacedNode }, 'component'>;
type GroupNode = Node<{ p: PlacedNode }, 'compound'>;
type BandNode = Node<{ band: Band; index: number }, 'band'>;
type ArchNode = CardNode | GroupNode | BandNode;
type ArchEdge = Edge<{ placed: PlacedEdge; from: { x: number; y: number }; to: { x: number; y: number } }, 'arch'>;

/** Shared with the custom node / edge renderers. */
const FlowCtx = createContext<{
  g: ArchitectureGraph;
  onFocus: (id: string) => void;
  toggle: (id: string) => void;
  open: (n: ArchitectureNode) => void;
  marker: (tone: string) => string;
}>(null!);

const hidden = { opacity: 0, pointerEvents: 'none' } as const;

const ComponentNode = memo(function ComponentNode({ data }: NodeProps<CardNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <NodeCard p={data.p} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </>
  );
});

const GroupNodeView = memo(function GroupNodeView({ data }: NodeProps<GroupNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <GroupBox p={data.p} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </>
  );
});

const BandNodeView = memo(function BandNodeView({ data, width, height }: NodeProps<BandNode>) {
  const b = data.band;
  return (
    <div className="arch-band" data-odd={data.index % 2 === 1 || undefined} data-first={data.index === 0 || undefined} style={{ width, height }}>
      <div className="arch-band-label" style={{ width: GUTTER - 20 }}>
        <span className="arch-band-name">{b.label}</span>
        <span className="arch-band-count">
          {plural(b.count, 'component')}
          {b.derived ? ' · derived' : ''}
        </span>
      </div>
    </div>
  );
});

function edgeTone(g: ArchitectureGraph, p: PlacedEdge): string {
  const es = p.edges;
  if (es.every((e) => e.diff === 'added')) return 'added';
  if (es.every((e) => e.diff === 'removed')) return 'removed';
  const violation = p.lifted.violation;
  if (g.nodes.some((n) => n.focus)) return es.some((e) => e.focus) ? (violation ? 'violation' : 'focus') : 'dim';
  return violation ? 'violation' : 'plain';
}
const TONES = ['plain', 'focus', 'dim', 'added', 'removed', 'violation'];

function edgeTip(g: ArchitectureGraph, p: PlacedEdge): React.ReactNode {
  const node = (id: string) => g.nodes.find((n) => n.id === id);
  const title = (id: string) => node(id)?.title ?? id;
  const layer = (id: string) => g.layers.find((l) => l.id === node(id)?.layer)?.label ?? node(id)?.layer;
  const shown = p.edges.slice(0, 6);
  return (
    <div className="arch-tip">
      {p.lifted.lifted && (
        <div className="arch-tip-meta">
          {title(p.lifted.from)} → {title(p.lifted.to)} · {plural(p.edges.length, 'dependency', 'dependencies')} (collapsed)
        </div>
      )}
      {shown.map((e, i) => (
        <div key={i}>
          <b>{title(e.from)}</b> depends on <b>{title(e.to)}</b>
          {e.label ? ` · ${e.label}` : ''}
          {e.violation && (
            <div className="arch-tip-violation">
              Upward dependency: {layer(e.from)} → {layer(e.to)}. A lower layer should not depend on a higher one.
            </div>
          )}
        </div>
      ))}
      {p.edges.length > shown.length && <div className="arch-tip-meta">+{p.edges.length - shown.length} more</div>}
      {p.edges.some((e) => e.diff && e.diff !== 'unchanged') && <div className="arch-tip-meta">Changed since the compared commit</div>}
    </div>
  );
}

/** ELK's orthogonal route while both ends sit where the layout put them; a smooth step path once a node was dragged. */
const ArchEdgeView = memo(function ArchEdgeView({ source, target, sourceX, sourceY, targetX, targetY, data }: EdgeProps<ArchEdge>) {
  const { g, marker } = useContext(FlowCtx);
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!data) return null;
  const moved = (n: typeof a, p: { x: number; y: number }) => !n || Math.abs(n.internals.positionAbsolute.x - p.x) > 0.5 || Math.abs(n.internals.positionAbsolute.y - p.y) > 0.5;
  const route = data.placed.route;
  const routed = route.length > 1 && !moved(a, data.from) && !moved(b, data.to);
  const [step, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition: Position.Bottom, targetX, targetY, targetPosition: Position.Top, borderRadius: 10, offset: 18 });
  const d = routed ? roundedPath(route) : step;
  const t = edgeTone(g, data.placed);
  const mid = routed ? midOf(route) : { x: lx, y: ly };
  const count = data.placed.edges.length;
  return (
    <Tooltip.Floating label={edgeTip(g, data.placed)} multiline>
      <g className="arch-edge-g" data-tone={t}>
        <path d={d} className="arch-edge-hit" />
        <path d={d} className={`arch-edge arch-edge-${t}`} markerEnd={marker(t)} />
        {data.placed.lifted.violation && routed && <circle cx={route[0]!.x} cy={route[0]!.y} r={3.5} className="arch-edge-origin" />}
        {count > 1 && mid && (
          <g className="arch-edge-count" transform={`translate(${mid.x},${mid.y})`}>
            <rect x={-12} y={-9} width={24} height={18} rx={9} />
            <text textAnchor="middle" dy="0.35em">
              {count}
            </text>
          </g>
        )}
      </g>
    </Tooltip.Floating>
  );
});

const NODE_TYPES = { component: ComponentNode, compound: GroupNodeView, band: BandNodeView };
const EDGE_TYPES = { arch: ArchEdgeView };

function buildNodes(l: Layout): ArchNode[] {
  const bands: BandNode[] = l.bands.map((band, index) => ({
    id: `band:${band.id}`,
    type: 'band',
    position: { x: 0, y: band.top },
    width: l.width,
    height: band.height,
    data: { band: { ...band }, index },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -10,
  }));
  const comps = l.nodes.map((p): CardNode | GroupNode => ({
    id: p.n.id,
    type: p.group === 'open' ? 'compound' : 'component',
    position: p.rel,
    width: p.abs.w,
    height: p.abs.h,
    data: { p },
    ...(p.parent ? { parentId: p.parent, extent: 'parent' as const } : {}),
    ...(p.group === 'open' ? { zIndex: -1 } : {}),
  }));
  return [...bands, ...comps];
}

function buildEdges(l: Layout): ArchEdge[] {
  const abs = new Map(l.nodes.map((p) => [p.n.id, p.abs]));
  return l.edges.flatMap((placed) => {
    const a = abs.get(placed.lifted.from);
    const b = abs.get(placed.lifted.to);
    if (!a || !b) return [];
    return [{ id: placed.id, type: 'arch', source: placed.lifted.from, target: placed.lifted.to, zIndex: 1, data: { placed, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } } } satisfies ArchEdge];
  });
}

/** Below this zoom node text is too small to read (C1). */
export const MIN_READABLE_ZOOM = 0.8;

function Flow({ g, l, onFocus, toggle }: { g: ArchitectureGraph; l: Layout; onFocus: (id: string) => void; toggle: (id: string) => void }) {
  const navigate = useNavigate();
  const scheme = useComputedColorScheme('light');
  const rf = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const nodes = useMemo(() => buildNodes(l), [l]);
  const edges = useMemo(() => buildEdges(l), [l]);
  // C1: fit the whole graph when it stays readable; otherwise fit to width with a readable minimum zoom and
  // let the user scroll (pan) vertically instead of shrinking node text to a few pixels.
  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !l.width || !l.height) return void rf.fitView({ padding: 0.04, duration: 0 });
    const { width: bw, height: bh } = el.getBoundingClientRect();
    const pad = 16;
    const whole = Math.min((bw - 2 * pad) / l.width, (bh - 2 * pad) / l.height);
    if (whole >= MIN_READABLE_ZOOM) return void rf.fitView({ padding: 0.04, duration: 0, maxZoom: 1 });
    const zoom = Math.min(1, Math.max(MIN_READABLE_ZOOM, (bw - 2 * pad) / l.width));
    const x = Math.max(pad, (bw - l.width * zoom) / 2);
    void rf.setViewport({ x, y: pad, zoom }, { duration: 0 });
  }, [rf, l]);
  // New layout: fit to the canvas.
  useEffect(() => {
    const t = requestAnimationFrame(() => requestAnimationFrame(fit));
    return () => cancelAnimationFrame(t);
  }, [nodes, fit]);
  // Fit on resize of the canvas area.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false);
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  const uid = useMemo(() => Math.random().toString(36).slice(2, 8), []);
  const open = useCallback((n: ArchitectureNode) => n.diff !== 'removed' && navigate(`/components/${n.id}`), [navigate]);
  const ctx = useMemo(() => ({ g, onFocus, toggle, open, marker: (t: string) => `url(#arch-arrow-${t}-${uid})` }), [g, onFocus, toggle, open, uid]);
  return (
    <FlowCtx.Provider value={ctx}>
      <div ref={box} className="arch-flow">
        <svg className="arch-markers" aria-hidden>
          <defs>
            {TONES.map((t) => (
              <marker key={t} id={`arch-arrow-${t}-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1 L9 5 L1 9 z" className={`arch-arrow arch-edge-${t}`} />
              </marker>
            ))}
          </defs>
        </svg>
        <ReactFlow<ArchNode, ArchEdge>
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={scheme}
          minZoom={0.15}
          maxZoom={2.5}
          panOnScroll
          zoomActivationKeyCode={['Meta', 'Control']}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          elevateNodesOnSelect={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(ev, n) => {
            if (n.type === 'component') open((n as CardNode).data.p.n);
            else if (n.type === 'compound' && (ev.target as HTMLElement).closest('.arch-group-head')) open((n as GroupNode).data.p.n);
          }}
          onEdgeClick={(_, e) => {
            const es = (e as ArchEdge).data?.placed.edges ?? [];
            const x = es.length === 1 ? es[0]! : null;
            const to = (e as ArchEdge).target;
            if (x && x.diff !== 'removed') navigate(`/components/${x.to}${x.section ? `#${sectionAnchor(x.section)}` : ''}`);
            else if (!x) navigate(`/components/${to}`);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--diagram-grid-dot)" />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: 0.06 }} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => (n.type === 'band' ? 'transparent' : n.type === 'compound' ? 'var(--arch-mm-group)' : 'var(--arch-mm-node)')}
            nodeStrokeColor={(n) => (n.type === 'band' ? 'transparent' : 'var(--arch-mm-stroke)')}
            nodeBorderRadius={6}
            maskColor="var(--arch-mm-mask)"
          />
        </ReactFlow>
      </div>
    </FlowCtx.Provider>
  );
}

/** The generated architecture: components in layers (top to bottom), containment groups and depends_on, with overlays, focus, history and compare. */
export function ArchitectureView({ initialFocus }: { initialFocus?: string | null }) {
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);
  const [at, setAt] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  /** Collapsed containment groups; groups seen for the first time get the default (nested groups start folded). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const known = useRef(new Set<string>());
  const log = useQuery({ queryKey: ['git-log', 80], queryFn: () => api.gitLog(80), staleTime: 30_000 });
  const params = { ...(at ? { at } : {}), ...(compare ? { compare } : {}), ...(focus ? { focus } : {}), ...(includeArchived ? { includeArchived } : {}) };
  // format=mermaid returns the graph plus the flowchart ("Copy as Mermaid").
  const g = useQuery({ queryKey: ['architecture', params], queryFn: () => api.architecture({ ...params, format: 'mermaid' }), placeholderData: (p) => p });
  const [l, setL] = useState<Layout | null>(null);
  const groups = useMemo(() => (g.data?.nodes ?? []).filter((n) => n.children.length).map((n) => n.id), [g.data]);
  useEffect(() => {
    if (!g.data) return;
    const fresh = groups.filter((id) => !known.current.has(id));
    if (!fresh.length) return;
    const def = defaultCollapsed(g.data);
    for (const id of fresh) known.current.add(id);
    setCollapsed((c) => new Set([...c, ...fresh.filter((id) => def.has(id))]));
  }, [g.data, groups]);
  const ready = !!g.data && groups.every((id) => known.current.has(id));
  useEffect(() => {
    if (!g.data || !ready) return;
    let live = true;
    void layoutArchitecture(g.data, collapsed).then((x) => live && setL(x));
    return () => {
      live = false;
    };
  }, [g.data, collapsed, ready]);
  const toggle = useCallback((id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set([...c, id]))), []);
  const commits = useMemo(
    () => (log.data ?? []).map((c) => ({ value: c.id, label: `${c.id.slice(0, 7)} · ${c.message.split('\n')[0]!.slice(0, 60)}` })),
    [log.data],
  );
  const ref = g.data ? mentionOf(g.data.ref) : null;
  const target: CopyTarget | null =
    g.data && ref
      ? {
          label: 'architecture',
          ref,
          link: `${location.origin}/components${focus ? `?focus=${focus}` : ''}`,
          extras: [{ label: 'Copy as Mermaid', value: () => g.data?.mermaid ?? '' }],
        }
      : null;
  const diff = g.data?.compare
    ? {
        added: g.data.nodes.filter((n) => n.diff === 'added').length + g.data.edges.filter((e) => e.diff === 'added').length,
        removed: g.data.nodes.filter((n) => n.diff === 'removed').length + g.data.edges.filter((e) => e.diff === 'removed').length,
        changed: g.data.nodes.filter((n) => n.diff === 'changed').length,
      }
    : null;
  const violations = g.data?.edges.filter((e) => e.violation && e.diff !== 'removed') ?? [];
  const allCollapsed = groups.length > 0 && groups.every((id) => collapsed.has(id));
  return (
    <div className="arch-view">
      <div className="arch-toolbar">
        <Switch size="xs" label="Include archived" checked={includeArchived} onChange={(e) => setIncludeArchived(e.currentTarget.checked)} />
        <Select size="xs" w={190} placeholder="As of: latest" clearable searchable data={commits} value={at} onChange={setAt} comboboxProps={{ withinPortal: true }} aria-label="As of commit" />
        <Select size="xs" w={190} placeholder="Compare with…" clearable searchable data={commits} value={compare} onChange={setCompare} comboboxProps={{ withinPortal: true }} aria-label="Compare with commit" />
        {focus && (
          <button type="button" className="arch-focus-pill" onClick={() => setFocus(null)}>
            <IconFocus2 size={13} /> Focus: {focus} <IconX size={12} />
          </button>
        )}
        {diff && (
          <span className="arch-diff-summary small">
            <span data-tone="added">+{diff.added}</span> <span data-tone="removed">−{diff.removed}</span> <span data-tone="changed">~{diff.changed}</span>
          </span>
        )}
        {violations.length > 0 && (
          <Tooltip multiline w={300} label={`A lower layer depends on a higher one (a layering violation): ${violations.map((e) => `${e.from} → ${e.to}`).join(', ')}`}>
            <span className="arch-violation-pill">
              <IconAlertTriangle size={12} /> {plural(violations.length, 'layering violation', 'layering violations')}
            </span>
          </Tooltip>
        )}
        <span style={{ flex: 1 }} />
        <span className="arch-legend small">
          <span className="arch-legend-edge" /> depends on
          <span className="arch-legend-edge" data-tone="violation" /> depends on a higher layer (violation)
          <span className="arch-legend-node" data-status="deprecated" /> deprecated
        </span>
        {groups.length > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={allCollapsed ? <IconArrowsMaximize size={13} /> : <IconArrowsMinimize size={13} />}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups))}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}
        {target && <CopyMenu target={target} visible />}
      </div>
      {g.isError && <ErrorState error={g.error as Error} onRetry={() => void g.refetch()} />}
      {g.data && l && g.data.nodes.length > 0 && (
        <ArchAuditProvider>
          <ReactFlowProvider>
            <Flow g={g.data} l={l} onFocus={setFocus} toggle={toggle} />
          </ReactFlowProvider>
        </ArchAuditProvider>
      )}
      {g.data && !g.data.nodes.length && (
        <EmptyView
          icon={<IconBox size={22} stroke={1.5} />}
          title="No components yet"
          description="Components describe the architecture: coding agents add them with create as they document the system."
        />
      )}
    </div>
  );
}
