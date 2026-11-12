import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, HoverCard, SegmentedControl, Select, Switch, TextInput, Tooltip, useComputedColorScheme } from '@mantine/core';
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconArrowsMaximize, IconArrowsMinimize, IconCircleDashed, IconClock, IconSortAscending, IconSortDescending, IconStack2 } from '@tabler/icons-react';
import { useSearchParams } from 'react-router';
import { LINEAGE_STATUSES, mentionOf, type LineageDirection, type LineageResponse, type LineageStatus } from '@mandate/shared';
import { TopBar } from '../components/TopBar';
import { FilterButton } from '../components/FilterButton';
import { CopyMenu } from '../components/copy';
import { KIND_ICON } from '../components/refs/kinds';
import { LineageStatusIcon } from '../components/lineage/LineagePanel';
import { LineageStory } from '../components/lineage/LineageStory';
import { ElementPicker } from '../components/lineage/ElementPicker';
import { WorkProgressLine, PrLink } from '../components/lineage/WorkProgress';
import { AvatarStack, Contributors } from '../components/people/People';
import { useContributors } from '../lib/people';
import { ElementCard, ElementMenu, useOpenElement, type ElementInfo, type MenuAt } from '../components/lineage/ElementActions';
import {
  GROUP_PREFIX,
  LIN_NODE_H,
  LIN_NODE_W,
  STATUS_META,
  causalOnly,
  eventMatches,
  groupSiblings,
  layoutLineage,
  summaryChips,
  useLineage,
  type GraphItem,
  type SummaryChip,
} from '../lib/lineage';
import { appOrigin } from '../project';
import type { CopyTarget } from '../lib/refs';
import { relativeTime } from '../lib/time';
import { maturityText, useSpecMaturities } from '../components/maturity/SpecMaturity';
import { parseRef } from '@mandate/shared/refs';
import '../components/lineage/lineage.css';

type LinNodeData = { it: GraphItem; root: boolean; info: ElementInfo };
type LinNode = Node<LinNodeData, 'lin'>;

/** Node interactions (keyboard): set by the canvas. */
const ActionsCtx = createContext<{ activate: (id: string, e?: { metaKey?: boolean; ctrlKey?: boolean }) => void; selected?: string | null }>({ activate: () => undefined });

const LinCard = memo(function LinCard({ data }: NodeProps<LinNode>) {
  const { it, root, info } = data;
  const { activate, selected } = useContext(ActionsCtx);
  const Icon = KIND_ICON[it.kind as keyof typeof KIND_ICON] ?? IconCircleDashed;
  const group = !!it.members;
  const n = it.node;
  const card = (
    <div
      className="lin-node"
      data-status={it.status}
      data-root={root || undefined}
      data-group={group || undefined}
      data-deleted={n?.deleted || undefined}
      tabIndex={0}
      role="button"
      aria-label={group ? `${it.label}, expand` : `${it.kind.replace(/_/g, ' ')} ${it.label}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.preventDefault(), activate(it.uri, { metaKey: true });
      }}
    >
      <Handle id="t" type="target" position={Position.Top} className="lin-handle" isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} className="lin-handle" isConnectable={false} />
      <div className="lin-node-head">
        {group ? <IconStack2 size={13} stroke={1.6} /> : <Icon size={13} stroke={1.6} />}
        <span className="lin-node-kind">{group ? 'group' : it.kind.replace(/_/g, ' ')}</span>
        {n && (
          <span className="lin-node-people">
            <Contributors refUri={n.uri} size="xs" max={3} />
          </span>
        )}
        <LineageStatusIcon status={it.status} size={13} />
      </div>
      <div className="lin-node-label">{it.label}</div>
      {n?.progress ? (
        <WorkProgressLine work={n.progress} compact />
      ) : null}
      <div className="lin-node-meta">
        {group
          ? `${it.members!.filter((m) => m.status !== 'neutral').length} with a status · click to expand`
          : (
            <>
              {info.rawStatus ? info.rawStatus.replace(/_/g, ' ') : STATUS_META[it.status].label}
              {n?.createdAt?.date && <> · {relativeTime(n.createdAt.date)}</>}
            </>
          )}
      </div>
      <Handle id="b" type="source" position={Position.Bottom} className="lin-handle" isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} className="lin-handle" isConnectable={false} />
    </div>
  );
  // G5: the selected node already shows its selection card; no hover card on top of it.
  if (group || selected === it.uri) return card;
  return (
    <HoverCard openDelay={500} closeDelay={100} width={300} position="right-start" shadow="md" withinPortal>
      <HoverCard.Target>{card}</HoverCard.Target>
      <HoverCard.Dropdown p={10}>
        <ElementCard info={info} actions={false} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
});
const NODE_TYPES = { lin: LinCard };

/** The graph after the client-side declutter: causal-only (unless "Show all"), chip filter, sibling groups. */
export function graphOf(data: Pick<LineageResponse, 'nodes' | 'edges' | 'root'>, opts: { showAll: boolean; chip: SummaryChip | null; expanded: ReadonlySet<string> }) {
  let { nodes, edges } = opts.showAll ? { nodes: data.nodes, edges: data.edges } : causalOnly(data.nodes, data.edges, data.root.uri);
  if (opts.chip) {
    const chip = opts.chip;
    nodes = nodes.filter((n) => n.uri === data.root.uri || (chip.nodeKinds.includes(n.kind) && (!chip.changing || n.status === 'in_progress')));
    const ids = new Set(nodes.map((n) => n.uri));
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }
  return groupSiblings(nodes, edges, data.root.uri, opts.expanded);
}

function Canvas({ data, showAll, chip, onCentre }: { data: LineageResponse; showAll: boolean; chip: SummaryChip | null; onCentre: (uri: string) => void }) {
  const rf = useReactFlow();
  const scheme = useComputedColorScheme('light');
  const open = useOpenElement();
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const maturities = useSpecMaturities();
  const specMaturity = (uri: string) => {
    const r = parseRef(uri);
    return r?.kind === 'specs' && !r.sectionId ? maturities.get(r.id) : undefined;
  };
  const causesOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of data.edges) if (e.recorded) m.set(e.to, [...(m.get(e.to) ?? []), e.from]);
    return m;
  }, [data.edges]);
  const infoOf = useCallback(
    (it: GraphItem): ElementInfo => ({
      uri: it.uri,
      kind: it.kind,
      label: it.label,
      status: it.status,
      // Specs read by maturity (the one state, X1), other nodes by their own status.
      rawStatus: (it.kind === 'spec' && specMaturity(it.uri) ? maturityText(specMaturity(it.uri)!) : undefined) ?? it.node?.rawStatus,
      by: it.node?.createdBy,
      at: it.node?.createdAt?.date,
      causes: causesOf.get(it.uri),
      extra: it.node?.progress ? <WorkProgressLine work={it.node.progress} /> : it.node?.url ? (
        <a className="wp-pr" href={it.node.url} target="_blank" rel="noreferrer noopener">
          Open pull request ↗
        </a>
      ) : undefined,
    }),
    [causesOf, maturities], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const graph = useMemo(() => graphOf(data, { showAll, chip, expanded }), [data, showAll, chip, expanded]);
  const layout = useMemo(() => layoutLineage(graph.items), [graph.items]);
  const pos = useMemo(() => new Map(layout.nodes.map((p) => [p.item.uri, p])), [layout]);
  const nodes = useMemo<LinNode[]>(
    () =>
      layout.nodes.map((p) => ({
        id: p.item.uri,
        type: 'lin',
        position: { x: p.x, y: p.y },
        width: LIN_NODE_W,
        height: LIN_NODE_H,
        data: { it: p.item, root: p.item.uri === data.root.uri, info: infoOf(p.item) },
      })),
    [layout, data.root.uri, infoOf],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        // Draw every edge downward (cause above effect when layers allow) and same-row edges side to side, so no edge
        // loops back around its own nodes.
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        const same = !!a && !!b && a.y === b.y;
        const flip = !!a && !!b && (same ? a.x > b.x : a.y > b.y);
        return {
        id: e.id,
        source: flip ? e.to : e.from,
        target: flip ? e.from : e.to,
        ...(same ? { sourceHandle: 'r', targetHandle: 'l' } : { sourceHandle: 'b', targetHandle: 't' }),
        type: 'smoothstep',
        className: `lin-edge${e.recorded ? ' lin-edge-recorded' : ''}${e.confidence === 'low' ? ' lin-edge-inferred' : ''}`,
        // Labels show on hover only (lineage.css); a low-confidence annotation is drawn dashed and says "inferred".
        label: `${e.kind.replace(/_/g, ' ')}${e.confidence === 'low' ? ' · inferred' : ''}`,
        labelShowBg: true,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        labelClassName: 'lin-edge-label',
        interactionWidth: 14,
        };
      }),
    [graph.edges, pos],
  );
  useEffect(() => {
    const t = requestAnimationFrame(() => requestAnimationFrame(() => void rf.fitView({ padding: 0.08, duration: 0, maxZoom: 1.1 })));
    return () => cancelAnimationFrame(t);
  }, [nodes, rf]);
  /** Click: select (card); Cmd/Ctrl+click or Enter: open; groups expand. */
  const activate = useCallback(
    (id: string, ev?: { metaKey?: boolean; ctrlKey?: boolean }) => {
      if (id.startsWith(GROUP_PREFIX)) return setExpanded((x) => new Set([...x, id]));
      if (ev?.metaKey || ev?.ctrlKey) {
        const url = graph.items.find((i) => i.uri === id)?.node?.url;
        return url ? void window.open(url, '_blank', 'noopener') : open(id);
      }
      setSelected(id);
    },
    [open, graph.items],
  );
  const actions = useMemo(() => ({ activate, selected }), [activate, selected]);
  const sel = selected ? graph.items.find((i) => i.uri === selected) : undefined;
  return (
    <ActionsCtx.Provider value={actions}>
    <div className="arch-flow lin-flow">
      <ReactFlow<LinNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={scheme}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(ev, n) => activate(n.id, ev)}
        onNodeDoubleClick={(_, n) => {
          if (n.id.startsWith(GROUP_PREFIX)) return;
          const url = (n.data as LinNodeData).it.node?.url;
          if (url) window.open(url, '_blank', 'noopener');
          else open(n.id);
        }}
        onNodeContextMenu={(ev, n) => {
          if (n.id.startsWith(GROUP_PREFIX)) return;
          ev.preventDefault();
          setMenu({ uri: n.id, x: ev.clientX, y: ev.clientY });
        }}
        onPaneClick={() => setSelected(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--diagram-grid-dot)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={(n) => `var(--lin-${(n.data as LinNodeData).it.status})`} nodeBorderRadius={6} maskColor="var(--arch-mm-mask)" />
      </ReactFlow>
      {expanded.size > 0 && (
        <button type="button" className="arch-focus-pill lin-collapse" onClick={() => setExpanded(new Set())}>
          Collapse groups
        </button>
      )}
      {sel && (
        <div className="lin-selection">
          <ElementCard info={infoOf(sel)} onCenter={sel.uri === data.root.uri ? undefined : onCentre} onClose={() => setSelected(null)} />
        </div>
      )}
      <ElementMenu at={menu} onClose={() => setMenu(null)} onCenter={onCentre} />
    </div>
    </ActionsCtx.Provider>
  );
}

/** In-progress items with their work (claim, branch, sections, PRs). */
export function ChangingList({ items }: { items: LineageResponse['summary']['changing']['items'] }) {
  return (
    <div className="lin-changing" data-testid="changing-list">
      {items.map((i) => (
        <div key={i.uri} className="lin-changing-row">
          <span>
            <LineageStatusIcon status="in_progress" size={12} /> <strong>{i.label}</strong>
          </span>
          {i.work ? <WorkProgressLine work={i.work} /> : i.progress ? <span className="faint">{i.progress}</span> : null}
          {i.url && !i.work && (
            <a className="wp-pr" href={i.url} target="_blank" rel="noreferrer noopener">
              Open ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

const DEPTHS = ['1', '2', '3', '4', '5', '6'];
const isDir = (v: string | null): v is LineageDirection => v === 'up' || v === 'down' || v === 'both';

/**
 * `/lineage?ref=&at=&dir=&depth=&mode=story&structure=1&all=1&focus=<chip>`: the lineage of any element, as a causal
 * graph (Layers) or as a chronological story.
 */
export function LineagePage() {
  const [params, setParams] = useSearchParams();
  const ref = params.get('ref') ?? '';
  const at = params.get('at') ?? '';
  const dirParam = params.get('dir');
  const dir: LineageDirection = isDir(dirParam) ? dirParam : 'both';
  const depth = Math.min(6, Math.max(1, Number(params.get('depth')) || 3));
  const mode = params.get('mode') === 'story' ? 'story' : 'layers';
  const onlyProgress = params.get('only') === 'in_progress';
  const structure = params.get('structure') === '1';
  const showAll = params.get('all') === '1';
  const order = params.get('order') === 'desc' ? 'desc' : 'asc';
  const focus = params.get('focus');
  const kinds = params.getAll('kind');
  const statuses = params.getAll('status') as LineageStatus[];
  const [atDraft, setAtDraft] = useState(at);
  useEffect(() => setAtDraft(at), [at]);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => {
    document.title = 'Lineage · Mandate';
  }, []);

  const update = useCallback(
    (patch: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        next.delete(k);
        if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
        else if (v) next.set(k, v);
      }
      setParams(next);
    },
    [params, setParams],
  );
  const status = onlyProgress ? (['in_progress'] as LineageStatus[]) : statuses;
  const q = useLineage(
    ref ? { ref, direction: dir, depth, ...(at ? { at } : {}), ...(status.length ? { status } : {}), ...(kinds.length ? { kinds } : {}), ...(structure ? { structure } : {}), ...(mode === 'story' ? { story: true } : {}) } : null,
  );
  const [knownKinds, setKnownKinds] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setKnownKinds((k) => Array.from(new Set([...k, ...q.data.nodes.map((n) => n.kind)])).sort());
  }, [q.data]);
  const chips = useMemo(() => summaryChips(q.data?.summary), [q.data]);
  const chip = chips.find((c) => c.id === focus) ?? null;
  const events = useMemo(() => (q.data?.events ?? []).filter((e) => eventMatches(e, chip)), [q.data, chip]);
  const target: CopyTarget | null = q.data
    ? {
        label: 'lineage view',
        ref: mentionOf(q.data.viewRef),
        link: `${appOrigin()}/lineage?${params.toString()}`,
        extras: [{ label: 'Copy summary', value: () => q.data!.summary.text }],
      }
    : null;
  const atValid = !atDraft || /^[0-9a-f]{4,40}$/.test(atDraft) || /^\d{4}-\d{2}-\d{2}/.test(atDraft);
  const changed = chips.filter((c) => !c.changing);
  const changing = chips.filter((c) => c.changing);
  const changingItems = q.data?.summary.changing.items ?? [];
  const people = useContributors(q.data?.root.uri);
  const chipButton = (c: SummaryChip) => {
    const btn = (
      <button key={c.id} type="button" className="lin-chip" aria-pressed={focus === c.id} data-changing={c.changing || undefined} onClick={() => update({ focus: focus === c.id ? null : c.id })}>
        {c.label}
        {c.id === 'changing-wo' && changingItems[0]?.work && (
          <span className="faint">
            {' '}
            · {changingItems[0].work.sectionsDone}/{changingItems[0].work.sectionsTotal}
          </span>
        )}
      </button>
    );
    if (!c.changing || !changingItems.length) return btn;
    return (
      <HoverCard key={c.id} openDelay={250} closeDelay={120} width={340} position="bottom-start" shadow="md" withinPortal>
        <HoverCard.Target>{btn}</HoverCard.Target>
        <HoverCard.Dropdown p={10}>
          <ChangingList items={changingItems} />
        </HoverCard.Dropdown>
      </HoverCard>
    );
  };

  return (
    <div className="arch-page lin-page" ref={box}>
      <TopBar crumbs={[{ label: 'Lineage' }]}>
        {target && <CopyMenu target={target} visible />}
        <Tooltip label={full ? 'Exit fullscreen' : 'Fullscreen'}>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Fullscreen" onClick={() => (full ? void document.exitFullscreen() : void box.current?.requestFullscreen?.())}>
            {full ? <IconArrowsMinimize size={14} /> : <IconArrowsMaximize size={14} />}
          </ActionIcon>
        </Tooltip>
      </TopBar>
      <div className="arch-view">
        <div className="arch-toolbar lin-toolbar">
          <ElementPicker value={ref} valueLabel={q.data?.root.label} valueKind={q.data?.root.kind} onPick={(r) => update({ ref: r, focus: null })} onClear={() => update({ ref: null, focus: null })} />
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => update({ mode: v === 'story' ? 'story' : null })}
            data={[
              { value: 'layers', label: 'Graph' },
              { value: 'story', label: 'Story' },
            ]}
            aria-label="View"
          />
          <SegmentedControl
            size="xs"
            value={dir}
            onChange={(v) => update({ dir: v === 'both' ? null : v })}
            data={[
              { value: 'up', label: 'Why' },
              { value: 'both', label: 'Both' },
              { value: 'down', label: 'Led to' },
            ]}
            aria-label="Direction"
          />
          <Select size="xs" w={92} data={DEPTHS.map((d) => ({ value: d, label: `Depth ${d}` }))} value={String(depth)} onChange={(v) => update({ depth: v === '3' ? null : v })} aria-label="Depth" allowDeselect={false} comboboxProps={{ withinPortal: true }} />
          {mode === 'layers' && (
            <>
              <FilterButton label="Kind" options={knownKinds.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))} selected={kinds} onChange={(v) => update({ kind: v })} clearable summary="colon" />
              <FilterButton
                label="Status"
                options={LINEAGE_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label, icon: <LineageStatusIcon status={s} /> }))}
                selected={statuses}
                onChange={(v) => update({ status: v })}
                clearable
                summary="colon"
              />
              <Switch size="xs" label="Only in progress" checked={onlyProgress} onChange={(e) => update({ only: e.currentTarget.checked ? 'in_progress' : null })} />
              <Switch size="xs" label="Show structure" checked={structure} onChange={(e) => update({ structure: e.currentTarget.checked ? '1' : null })} />
              <Switch size="xs" label="Show all" checked={showAll} onChange={(e) => update({ all: e.currentTarget.checked ? '1' : null })} />
            </>
          )}
          {mode === 'story' && (
            <Tooltip label={order === 'asc' ? 'Oldest first (newest at the bottom)' : 'Newest first'}>
              <ActionIcon variant="default" size="md" aria-label="Order" onClick={() => update({ order: order === 'asc' ? 'desc' : null })}>
                {order === 'asc' ? <IconSortAscending size={15} /> : <IconSortDescending size={15} />}
              </ActionIcon>
            </Tooltip>
          )}
          <TextInput
            size="xs"
            w={170}
            leftSection={<IconClock size={13} />}
            placeholder="As of: sha or date"
            value={atDraft}
            error={!atValid}
            aria-label="As of commit or date"
            onChange={(e) => setAtDraft(e.currentTarget.value.trim())}
            onBlur={() => atValid && atDraft !== at && update({ at: atDraft || null })}
            onKeyDown={(e) => e.key === 'Enter' && atValid && update({ at: atDraft || null })}
          />
        </div>
        {q.data && (
          <div className="lin-page-summary" data-testid="lineage-chips">
            <span className="lin-page-root">{q.data.root.label}</span>
            {q.data.at && <span className="lin-at">as of {q.data.at.sha.slice(0, 7)} · {q.data.at.date.slice(0, 10)}</span>}
            <span className="lin-chip-group">
              <span className="lin-chip-title">Changed</span>
              {changed.length ? changed.map(chipButton) : <span className="faint">nothing recorded yet</span>}
            </span>
            <span className="lin-chip-group">
              <span className="lin-chip-title">Changing</span>
              {changing.length ? changing.map(chipButton) : <span className="faint">nothing in progress</span>}
            </span>
            {(q.data.summary.changing.prs ?? 0) > 0 && (
              <span className="lin-chip-group">
                {changingItems.flatMap((i) => i.work?.prs ?? []).filter((p, k, a) => a.findIndex((x) => x.repo === p.repo && x.number === p.number) === k).map((p) => (
                  <PrLink key={`${p.repo}#${p.number}`} pr={p} />
                ))}
              </span>
            )}
            {people.data && people.data.length > 0 && (
              <span className="lin-people" data-testid="people-involved">
                People involved: {people.data.length}
                <AvatarStack contributors={people.data} size="xs" max={5} />
              </span>
            )}
            {q.data.truncated && <span className="lin-at">truncated</span>}
            <span style={{ flex: 1 }} />
            {mode === 'layers' && (
              <span className="lin-legend small">
                {(['done', 'in_progress', 'attention'] as LineageStatus[]).map((s) => (
                  <span key={s} className="lin-legend-item">
                    <LineageStatusIcon status={s} size={12} /> {STATUS_META[s].label}
                  </span>
                ))}
                <span className="lin-legend-item"><span className="lin-legend-edge" data-recorded /> recorded cause</span>
                <span className="lin-legend-item"><span className="lin-legend-edge" /> flow</span>
              </span>
            )}
          </div>
        )}
        {!ref && <div className="lin-placeholder">Pick an element to see why it exists and what it led to: causes above, effects below.</div>}
        {ref && q.isError && <div className="lin-placeholder">Could not load the lineage: {q.error.message}</div>}
        {ref && q.isPending && <div className="lin-placeholder">Loading…</div>}
        {q.data && mode === 'layers' && (
          <ReactFlowProvider>
            <Canvas key={q.data.root.uri} data={q.data} showAll={showAll} chip={chip} onCentre={(uri) => update({ ref: uri, focus: null })} />
          </ReactFlowProvider>
        )}
        {q.data && mode === 'story' && (
          <div className="lin-story-scroll">
            <LineageStory events={events} changing={!chip || chip.changing ? q.data.summary.changing.items : []} order={order} truncated={q.data.eventsTruncated} onCenter={(uri) => update({ ref: uri, focus: null })} />
          </div>
        )}
      </div>
    </div>
  );
}
