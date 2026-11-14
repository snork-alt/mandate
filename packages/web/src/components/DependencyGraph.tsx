import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Menu, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArchive,
  IconAt,
  IconChevronRight,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconClipboardList,
  IconFileText,
  IconHierarchy3,
  IconLink,
  IconRuler2,
  IconSection,
} from '@tabler/icons-react';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { DependencyEdge, DependencyNode, DependencyTree } from '@mandate/shared';
import { refMention } from '@mandate/shared/refs';
import { useNavigate } from 'react-router';
import { copyText } from '../lib/copy';
import type { CopyTarget } from '../lib/refs';
import { KIND_LABEL, useNow } from '../lib/specs';
import { maturityText, SpecMaturityDot, useSpecMaturities } from './maturity/SpecMaturity';
import { copyTargetProps } from './copy/copyTargets';
import { CanvasViewer, ClaimAvatar } from './doc';
import { WORK_ORDER_STATUS_META, WorkOrderStatusIcon } from './WorkOrderStatusIcon';
import { KIND_ICON } from './refs/kinds';

const ComponentIcon = KIND_ICON.component;

const OPEN_KEY = 'mandate.work-order-deps.open';
const NODE_W = 236;
const NODE_H = 80;
const CENTER_W = 252;
const CENTER_H = 80;
const FOOT_ROW = 22;

/** Rough width (px) of the footer chips at 11px, so the card can grow a row instead of cutting them off. */
function footerRows(n: DependencyNode, width: number): number {
  const text = (t: string, pad = 0) => t.length * 6.3 + pad;
  const items: number[] = [];
  if (n.type === 'work_order') items.push(text(`${WORK_ORDER_STATUS_META[n.workOrders[0]!.status].label}${n.blocked ? '' : ' · not blocked'}`));
  if (n.blocker) items.push(text('Blocks this', 12));
  if (n.blocked) items.push(text('Blocked', 12));
  if (n.broken) items.push(text('Broken dependency', 12));
  if (n.upstreamChanged) items.push(text('Upstream changed', 12));
  for (const c of (n.components ?? []).slice(0, 2)) items.push(text(c, 26));
  if (n.type !== 'work_order') for (const w of n.workOrders.slice(0, 2)) items.push(text(w.id.length > 10 ? w.id.slice(0, 10) : w.id, 28));
  if (n.workOrders.length > 2 && n.type !== 'work_order') items.push(text('+9'));
  const avail = width - 20;
  let rows = 1;
  let x = 0;
  for (const w of items) {
    const need = Math.min(w, avail);
    if (x > 0 && x + 5 + need > avail) {
      rows++;
      x = need;
    } else x += (x > 0 ? 5 : 0) + need;
  }
  return Math.min(rows, 3);
}

/** The remembered choice: true / false, or null when the user never toggled the panel. */
const readOpen = (): boolean | null => {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
};
const writeOpen = (open: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
};

/** UI path of a node (pinned to `commit` when the graph shows an old version). */
function nodeHref(n: DependencyNode, commit: string | null): string | null {
  if (n.type === 'work_order') return null;
  const q = commit ? `?version=${commit}` : '';
  return `/${n.docKind}/${n.docId}${q}${n.sectionId ? `#section-${n.sectionId}` : ''}`;
}

function nodeTarget(n: DependencyNode, commit: string | null): CopyTarget {
  const c = commit ?? undefined;
  if (n.type === 'work_order') {
    const id = n.workOrders[0]!.id;
    return { label: 'work order', ref: refMention({ kind: 'work-orders', id }), link: `${location.origin}/work-orders/${id}` };
  }
  const href = nodeHref(n, commit);
  return {
    label: n.type === 'spec' ? 'spec' : 'section',
    ref: refMention({ kind: n.docKind, id: n.docId, ...(n.sectionId ? { sectionId: n.sectionId } : {}), commit: c }),
    ...(href ? { link: `${location.origin}${href}` } : {}),
  };
}

const unfinished = (n?: DependencyNode) => !!n && (n.state === 'not_implemented' || n.state === 'missing');

function StateIcon({ n, size = 13 }: { n: DependencyNode; size?: number }) {
  if (n.type === 'work_order') return <WorkOrderStatusIcon status={n.workOrders[0]!.status} size={size} />;
  if (n.state === 'implemented') return <IconCircleCheckFilled size={size} color="var(--mantine-color-teal-6)" aria-label="Implemented" />;
  if (n.state === 'standard') return <IconRuler2 size={size} color="var(--app-text-muted)" aria-label="Standard" />;
  if (n.state === 'archived') return <IconArchive size={size} color="var(--app-text-faint)" aria-label="Archived" />;
  if (n.state === 'missing') return <IconAlertTriangle size={size} color="var(--mantine-color-red-6)" aria-label="Missing" />;
  return <IconCircleDashed size={size} color="var(--app-text-muted)" aria-label="Not implemented" />;
}

const STATE_LABEL: Record<DependencyNode['state'], string> = {
  implemented: 'Implemented',
  not_implemented: 'Not implemented',
  standard: 'Standard',
  missing: 'Missing',
  archived: 'Archived',
};

function KindIcon({ n }: { n: DependencyNode }) {
  if (n.type === 'work_order' || n.workOrders.length) return <IconClipboardList size={14} aria-label="Has a work order" />;
  if (n.docKind === 'standards') return <IconRuler2 size={14} aria-label="Standard section" />;
  if (n.type === 'spec') return <IconFileText size={14} aria-label="Spec" />;
  return <IconSection size={14} aria-label="Section" />;
}

function nodeTitle(n: DependencyNode) {
  if (n.type === 'work_order') return n.workOrders[0]!.id;
  return n.sectionId ? (n.sectionTitle ?? n.sectionId) : n.docKind === 'standards' ? 'Whole standard' : 'Whole spec';
}

function Badges({ n }: { n: DependencyNode }) {
  return (
    <>
      {n.blocker && (
        <span className="link-badge" data-tone="danger">
          Blocks this
        </span>
      )}
      {n.type === 'work_order' && n.blocked && (
        <span className="link-badge" data-tone="danger">
          Blocked
        </span>
      )}
      {!n.blocker && n.blocked && n.type !== 'work_order' && (
        <span className="link-badge" data-tone="warn">
          Blocked
        </span>
      )}
      {n.broken && (
        <span className="link-badge" data-tone="danger">
          Broken dependency
        </span>
      )}
      {n.upstreamChanged && (
        <span className="link-badge" data-tone="warn">
          Upstream changed
        </span>
      )}
    </>
  );
}

function HoverSummary({ n }: { n: DependencyNode }) {
  // The spec's maturity (the one state, X1), not its stored status.
  const specM = useSpecMaturities(n.docKind === 'specs').get(n.docId);
  return (
    <div className="dep-hover">
      <div className="dep-hover-title">
        {n.docTitle ?? n.docId}
        {n.sectionId && ` › ${n.sectionTitle ?? n.sectionId}`}
      </div>
      {n.summary && <div className="dep-hover-summary">{n.summary}</div>}
      <div className="dep-hover-meta">
        {n.type === 'work_order' ? WORK_ORDER_STATUS_META[n.workOrders[0]!.status].label : STATE_LABEL[n.state]}
        {n.type !== 'work_order' && specM && ` · spec ${maturityText(specM)}`}
        {n.claim && ` · claimed by ${n.claim.agent}`}
        {n.truncated && ' · more beyond the depth limit'}
      </div>
      {n.type !== 'work_order' && n.workOrders.length > 0 && (
        <div className="dep-hover-orders">
          {n.workOrders.map((w) => (
            <span key={w.id} className="inline-icon">
              <WorkOrderStatusIcon status={w.status} size={12} /> {KIND_LABEL[w.kind]} <span className="mono">{w.id}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One node card: click opens it, hover shows its summary, right-click copies its reference (reference first). */
function NodeCard({ n, commit, style, now }: { n: DependencyNode; commit: string | null; style?: React.CSSProperties; now: number }) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const target = useMemo(() => nodeTarget(n, commit), [n, commit]);
  const href = nodeHref(n, commit);
  return (
    <Menu opened={menu} onChange={setMenu} position="bottom-start" width={220} withinPortal>
      <Menu.Target>
        <div
          className="dep-node"
          data-center={n.type === 'work_order' || undefined}
          data-blocker={n.blocker || undefined}
          data-state={n.state}
          style={style}
          role={href ? 'link' : undefined}
          tabIndex={0}
          onClick={(e) => {
            if (e.button !== 0) return;
            if (href) navigate(href);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && href) navigate(href);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
          }}
          {...copyTargetProps(target)}
        >
          <Tooltip label={<HoverSummary n={n} />} openDelay={350} multiline w={300} withinPortal position="top">
            <div className="dep-node-inner">
              <div className="dep-node-head">
                <span className="dep-node-kind">
                  <KindIcon n={n} />
                </span>
                <span className="dep-node-doc">{n.type === 'work_order' ? `${KIND_LABEL[n.workOrders[0]!.kind]} · ${n.docTitle ?? n.docId}` : (n.docTitle ?? n.docId)}</span>
                {n.type !== 'work_order' && n.docKind === 'specs' && <SpecMaturityDot id={n.docId} details={n.type === 'spec'} />}
                {n.claim && <ClaimAvatar claim={n.claim} now={now} size={16} />}
              </div>
              <div className="dep-node-title">
                <StateIcon n={n} />
                <span className={n.type === 'work_order' ? 'mono' : undefined}>{nodeTitle(n)}</span>
                {n.truncated && <span className="faint">…</span>}
              </div>
              <div className="dep-node-foot">
                {n.type === 'work_order' && (
                  <span className="faint small">
                    {WORK_ORDER_STATUS_META[n.workOrders[0]!.status].label}
                    {n.blocked ? '' : ' · not blocked'}
                  </span>
                )}
                <Badges n={n} />
                {(n.components ?? []).slice(0, 2).map((c) => (
                  <Tooltip key={c} label={`Component ${c}`} openDelay={300}>
                    <span className="dep-node-comp">
                      <ComponentIcon size={10} />
                      {c}
                    </span>
                  </Tooltip>
                ))}
                {n.type !== 'work_order' &&
                  n.workOrders.slice(0, 2).map((w) => (
                    <Tooltip key={w.id} label={`${KIND_LABEL[w.kind]} · ${WORK_ORDER_STATUS_META[w.status].label}`} openDelay={300}>
                      <span className="dep-node-wo">
                        <WorkOrderStatusIcon status={w.status} size={11} />
                        <span className="mono">{w.id.length > 10 ? `${w.id.slice(0, 9)}…` : w.id}</span>
                      </span>
                    </Tooltip>
                  ))}
                {n.workOrders.length > 2 && n.type !== 'work_order' && <span className="faint small">+{n.workOrders.length - 2}</span>}
              </div>
            </div>
          </Tooltip>
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Copy {target.label}</Menu.Label>
        <Menu.Item leftSection={<IconAt size={14} />} rightSection={<span className="kbd-hint">C</span>} onClick={() => void copyText(target.ref)}>
          Copy reference
        </Menu.Item>
        {target.link && (
          <Menu.Item leftSection={<IconLink size={14} />} onClick={() => void copyText(target.link!, 'Link copied')}>
            Copy link
          </Menu.Item>
        )}
        {n.workOrders
          .filter(() => n.type !== 'work_order')
          .map((w) => (
            <Menu.Item key={w.id} leftSection={<IconClipboardList size={14} />} onClick={() => navigate(`/work-orders/${w.id}`)}>
              Open work order {w.id.length > 12 ? `${w.id.slice(0, 11)}…` : w.id}
            </Menu.Item>
          ))}
      </Menu.Dropdown>
    </Menu>
  );
}

interface Layout {
  width: number;
  height: number;
  pos: Map<string, { x: number; y: number; w: number; h: number }>;
}

/** ELK layered layout, left to right (upstream -> work order -> downstream). */
async function layoutGraph(tree: DependencyTree): Promise<Layout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  // Every card the same size: the widest card width and the tallest footer among all nodes.
  const width = Math.max(CENTER_W, NODE_W);
  const rows = Math.max(1, ...tree.nodes.map((n) => footerRows(n, width)));
  const uniform = { width, height: Math.max(CENTER_H, NODE_H) + (rows - 1) * FOOT_ROW };
  const size = (_n: DependencyNode) => uniform;
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '18',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.padding': '[top=8,left=8,bottom=8,right=8]',
    },
    children: tree.nodes.map((n) => ({ id: n.key, ...size(n) })),
    edges: tree.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const res = await elk.layout(graph);
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const c of res.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? NODE_W, h: c.height ?? NODE_H });
  return { width: res.width ?? 0, height: res.height ?? 0, pos };
}

function edgeTone(e: DependencyEdge, byKey: Map<string, DependencyNode>, root: string): 'blocker' | 'blocked' | 'soft' | 'plain' {
  if (e.soft) return 'soft';
  const from = byKey.get(e.from);
  if (unfinished(from)) return e.to === root || from?.blocker ? 'blocker' : 'blocked';
  return 'plain';
}

function GraphCanvas({ tree, layout, now }: { tree: DependencyTree; layout: Layout; now: number }) {
  const byKey = useMemo(() => new Map(tree.nodes.map((n) => [n.key, n])), [tree]);
  return (
    <div className="dep-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg className="dep-edges" width={layout.width} height={layout.height} aria-hidden>
        <defs>
          {(['plain', 'soft', 'blocked', 'blocker'] as const).map((t) => (
            <marker key={t} id={`dep-arrow-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" className={`dep-arrow dep-edge-${t}`} />
            </marker>
          ))}
        </defs>
        {tree.edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + a.w;
          const y1 = a.y + a.h / 2;
          const x2 = b.x - 2;
          const y2 = b.y + b.h / 2;
          const dx = Math.max(24, (x2 - x1) / 2);
          const tone = edgeTone(e, byKey, tree.root);
          return (
            <path
              key={i}
              d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
              className={`dep-edge dep-edge-${tone}`}
              strokeDasharray={e.soft ? '5 4' : undefined}
              markerEnd={`url(#dep-arrow-${tone})`}
            >
              <title>{`${e.rel.replace(/_/g, ' ')}${e.via ? ` (via ${e.via})` : ''}`}</title>
            </path>
          );
        })}
      </svg>
      {tree.nodes.map((n) => {
        const p = layout.pos.get(n.key);
        if (!p) return null;
        return <NodeCard key={n.key} n={n} commit={tree.commit} now={now} style={{ left: p.x, top: p.y, width: p.w, height: p.h }} />;
      })}
    </div>
  );
}

/** Indented tree of one side; nodes seen before become "↻ see above" stubs. */
function SideList({ tree, side, now }: { tree: DependencyTree; side: 'upstream' | 'downstream'; now: number }) {
  const byKey = new Map(tree.nodes.map((n) => [n.key, n]));
  const children = (key: string) =>
    tree.edges
      .filter((e) => (side === 'upstream' ? e.to === key : e.from === key))
      .map((e) => ({ e, n: byKey.get(side === 'upstream' ? e.from : e.to)! }))
      .filter((x) => x.n && x.n.side === side);
  const seen = new Set<string>();
  const render = (key: string, level: number): ReactNode[] =>
    children(key).flatMap(({ e, n }) => {
      const id = `${key}>${n.key}`;
      if (seen.has(n.key)) {
        return [
          <li key={id} className="dep-list-item" style={{ paddingLeft: level * 16 }}>
            <span className="faint small">
              ↻ {n.sectionTitle ?? n.docTitle ?? n.docId} (see above)
            </span>
          </li>,
        ];
      }
      seen.add(n.key);
      return [
        <li key={id} className="dep-list-item" style={{ paddingLeft: level * 16 }} data-soft={e.soft || undefined}>
          <span className="faint small dep-list-rel">{e.rel.replace(/_/g, ' ')}</span>
          <NodeCard n={n} commit={tree.commit} now={now} />
        </li>,
        ...render(n.key, level + 1),
      ];
    });
  const items = render(tree.root, 0);
  return (
    <div className="dep-list">
      <div className="dep-list-title">{side === 'upstream' ? 'Upstream' : 'Downstream'}</div>
      {items.length ? <ul>{items}</ul> : <div className="faint small">None</div>}
    </div>
  );
}

/** Markdown outline of the graph (the canvas "source" and its copy action). */
function toMarkdown(tree: DependencyTree): string {
  const byKey = new Map(tree.nodes.map((n) => [n.key, n]));
  const lines: string[] = [];
  const label = (n: DependencyNode) =>
    `${n.docTitle ?? n.docId}${n.sectionId ? ` › ${n.sectionTitle ?? n.sectionId}` : ''} (${STATE_LABEL[n.state]}${n.workOrders.length && n.type !== 'work_order' ? `; ${n.workOrders.map((w) => `${w.id} ${w.status}`).join(', ')}` : ''}) ${refMention(n.sectionId ? { kind: n.docKind, id: n.docId, sectionId: n.sectionId } : { kind: n.docKind, id: n.docId })}`;
  for (const side of ['upstream', 'downstream'] as const) {
    lines.push(`## ${side === 'upstream' ? 'Upstream' : 'Downstream'}`);
    const seen = new Set<string>();
    const walk = (key: string, level: number) => {
      for (const e of tree.edges.filter((x) => (side === 'upstream' ? x.to === key : x.from === key))) {
        const n = byKey.get(side === 'upstream' ? e.from : e.to);
        if (!n || n.side !== side) continue;
        const pad = '  '.repeat(level);
        if (seen.has(n.key)) {
          lines.push(`${pad}- ↻ ${n.sectionTitle ?? n.docTitle ?? n.docId} (see above)`);
          continue;
        }
        seen.add(n.key);
        lines.push(`${pad}- ${e.rel}${e.soft ? ' (soft)' : ''}: ${label(n)}`);
        walk(n.key, level + 1);
      }
    };
    walk(tree.root, 0);
    if (!seen.size) lines.push('- none');
    lines.push('');
  }
  return lines.join('\n');
}

export function summaryLine(tree: DependencyTree): string {
  const s = tree.summary;
  const parts: string[] = [];
  if (s.blockedBySections) parts.push(`Blocked by ${s.blockedBySections} ${s.blockedBySections === 1 ? 'section' : 'sections'} in ${s.blockedBySpecs} ${s.blockedBySpecs === 1 ? 'spec' : 'specs'}`);
  else parts.push(s.upstream ? 'Upstream is done' : 'No upstream dependencies');
  parts.push(s.dependentWorkOrders ? `${s.dependentWorkOrders} ${s.dependentWorkOrders === 1 ? 'work order depends' : 'work orders depend'} on this` : s.downstream ? `${s.downstream} downstream ${s.downstream === 1 ? 'item' : 'items'}` : 'Nothing depends on this');
  return parts.join(' · ');
}

/**
 * Collapsible upstream / downstream dependency panel of a work order: a one-line summary, expanded on demand. Without a
 * remembered choice it starts collapsed, and expanded only when the work order is blocked (the graph explains why).
 */
export function DependencyGraph({ tree }: { tree: DependencyTree }) {
  const now = useNow();
  const [open, setOpen] = useState(() => readOpen() ?? tree.summary.blockedBySections > 0);
  const narrow = useMediaQuery('(max-width: 760px)');
  const [layout, setLayout] = useState<Layout | null>(null);
  const empty = tree.nodes.length <= 1;

  useEffect(() => {
    if (!open || narrow || empty) return;
    let live = true;
    void layoutGraph(tree).then((l) => live && setLayout(l));
    return () => {
      live = false;
    };
  }, [tree, open, narrow, empty]);

  const toggle = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };
  const blocked = tree.summary.blockedBySections > 0;

  return (
    <section className="dep-strip" data-open={open || undefined}>
      <button type="button" className="dep-strip-head" onClick={toggle} aria-expanded={open}>
        <IconChevronRight size={14} className="dep-chevron" />
        <IconHierarchy3 size={14} />
        <span className="dep-strip-title">Dependencies</span>
        <span className="dep-strip-summary" data-blocked={blocked || undefined}>
          {summaryLine(tree)}
        </span>
        {tree.commit && <span className="mono faint small">@{tree.commit.slice(0, 7)}</span>}
      </button>
      {open &&
        (empty ? (
          <div className="faint small dep-empty">No section links lead to or from this work order.</div>
        ) : narrow ? (
          <div className="dep-lists">
            <SideList tree={tree} side="upstream" now={now} />
            <SideList tree={tree} side="downstream" now={now} />
          </div>
        ) : layout ? (
          <CanvasViewer
            title="Dependencies"
            icon={<IconHierarchy3 size={14} />}
            source={toMarkdown(tree)}
            sourceLang="markdown"
            maxInlineHeight={420}
            render={() => <GraphCanvas tree={tree} layout={layout} now={now} />}
          />
        ) : (
          <div className="dep-loading" />
        ))}
    </section>
  );
}
