import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { HoverCard, Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import type { CopyTarget } from '../../lib/refs';
import { absoluteTime, compactTime } from '../../lib/time';
import { CopyRef, copyTargetProps } from '../copy';
import './list.css';

/**
 * One list-row layout for every list (specs, standards, components, work orders, feedback, audits):
 *
 *   lead (icons) · id · title + excerpt (flex) · copy · chips (shrinks) · fixed columns… · people · time
 *
 * Everything right of the title has a fixed width per list (chips: a fixed basis that only shrinks with the row), so
 * the left edge of every column is the same on every row. Optional columns hide with the row's own width (container
 * queries on `.lr`, `data-hide`), never by clipping.
 */

/**
 * Row content widths at which a column hides: 2xl ≤ 1400, xl ≤ 1100, lg ≤ 940, md ≤ 780, sm ≤ 620, xs ≤ 440 (the id
 * hides at lg, the time at xs). Priorities: the title keeps at least ~45% of the row; low-value columns (version, link
 * counts) go first, the state column (maturity) last.
 */
export type HideAt = '2xl' | 'xl' | 'lg' | 'md' | 'sm' | 'xs';

/** Column geometry + its header label (shared by the header row and every row, so they always line up). */
export interface ColDef {
  key: string;
  width: number;
  hide?: HideAt;
  /** A narrower width below a breakpoint (e.g. a maturity badge collapsing to its ring). */
  narrow?: { at: HideAt; width: number };
  align?: 'start' | 'end' | 'center';
  /** Header label and its tooltip (what the column means). */
  label?: ReactNode;
  tip?: ReactNode;
}

export interface ListCol extends ColDef {
  node: ReactNode;
}

/** Attach per-row content to shared column definitions (`withNodes(COLS, { audit: <AuditIndicator/> })`). */
export function withNodes(defs: ColDef[], nodes: Record<string, ReactNode>): ListCol[] {
  return defs.map((d) => ({ ...d, node: nodes[d.key] ?? null }));
}

export interface ChipItem {
  key: string;
  node: ReactNode;
  /** A shorter whole-word form, used when it lets more chips fit (e.g. a target's document title without the section). */
  short?: ReactNode;
  /** Text for the "+N" hover card (defaults to the node itself). */
  label?: ReactNode;
}

interface ListRowProps {
  to: string;
  /** List name (`data-list`), for list-specific CSS and the alignment checker. */
  list: string;
  className?: string;
  copy?: CopyTarget;
  lead?: ReactNode;
  leadWidth?: number;
  id?: ReactNode;
  idWidth?: number;
  /** Where the id column hides (default lg). */
  idHide?: HideAt;
  title: ReactNode;
  excerpt?: ReactNode;
  /** Undefined: no chips column. An array (even empty): the column is always laid out. */
  chips?: ChipItem[];
  chipsWidth?: number;
  chipsMax?: number;
  chipsHide?: HideAt;
  cols?: ListCol[];
  people: ReactNode;
  /** Where the people column hides (default: never). */
  peopleHide?: HideAt;
  time: ReactNode;
  timeWidth?: number;
}

export function ListRow({ to, list, className, copy, lead, leadWidth = 18, id, idWidth = 72, idHide = 'lg', peopleHide, title, excerpt, chips, chipsWidth = 220, chipsMax, chipsHide = 'md', cols = [], people, time, timeWidth = 64 }: ListRowProps) {
  return (
    <Link to={to} className={`row lr${copy ? ' has-copy-ref' : ''}${className ? ` ${className}` : ''}`} data-list={list} {...(copy ? copyTargetProps(copy) : {})}>
      {lead !== undefined && (
        <span className="lr-lead" data-col="lead" style={{ width: leadWidth }}>
          {lead}
        </span>
      )}
      {id !== undefined && (
        <span className="row-id lr-id" data-col="id" data-hide={idHide} style={{ width: idWidth, maxWidth: idWidth }}>
          {id}
        </span>
      )}
      <span className="lr-main" data-col="main">
        <span className="row-title">{title}</span>
        {excerpt && <span className="row-excerpt">{excerpt}</span>}
      </span>
      <span className="row-copy lr-copy" data-col="copy">
        {copy && <CopyRef target={copy} size="xs" />}
      </span>
      {chips && <ChipList items={chips} max={chipsMax} width={chipsWidth} hide={chipsHide} />}
      {cols.map((c) => (
        <span
          key={c.key}
          className="lr-col"
          data-col={c.key}
          data-hide={c.hide}
          data-narrow={c.narrow?.at}
          data-align={c.align}
          style={{ width: c.width, ...(c.narrow ? { ['--lr-narrow' as string]: `${c.narrow.width}px` } : {}) }}
        >
          {c.node}
        </span>
      ))}
      <span className="lr-people-col" data-col="people" data-hide={peopleHide}>
        {people}
      </span>
      <span className="row-time lr-time" data-col="time" data-hide="xs" style={{ width: timeWidth }}>
        {time}
      </span>
    </Link>
  );
}

/** A header label: text plus the tooltip explaining the column. */
export interface HeadLabel {
  label: ReactNode;
  tip?: ReactNode;
}

function HeadCell({ h }: { h?: HeadLabel }) {
  if (!h?.label) return null;
  return h.tip ? (
    <Tooltip label={h.tip} openDelay={300} multiline maw={280} withinPortal>
      <span className="lr-head-label" tabIndex={0}>
        {h.label}
      </span>
    </Tooltip>
  ) : (
    <span className="lr-head-label">{h.label}</span>
  );
}

interface ListHeaderProps {
  list: string;
  /** Lead column (icons) present: its width (no label). */
  leadWidth?: number;
  lead?: boolean;
  id?: HeadLabel;
  idWidth?: number;
  idHide?: HideAt;
  main: HeadLabel;
  chips?: HeadLabel;
  chipsWidth?: number;
  chipsHide?: HideAt;
  cols?: ColDef[];
  people?: HeadLabel;
  peopleHide?: HideAt;
  time?: HeadLabel;
  timeWidth?: number;
}

/**
 * Slim column header row: the same box and columns as ListRow (same classes, widths and `data-hide`), so every label
 * sits exactly over its column and hides with it.
 */
export function ListHeader({ list, lead = true, leadWidth = 18, id, idWidth = 72, idHide = 'lg', peopleHide, main, chips, chipsWidth = 220, chipsHide = 'md', cols = [], people = { label: 'People', tip: 'Who created and last edited it (people and agents)' }, time = { label: 'Updated', tip: 'When it last changed' }, timeWidth = 64 }: ListHeaderProps) {
  return (
    <div className="row lr lr-head" data-list={list} data-header="" role="row" data-testid="list-header">
      {lead && <span className="lr-lead" data-col="lead" style={{ width: leadWidth }} />}
      {id && (
        <span className="row-id lr-id" data-col="id" data-hide={idHide} style={{ width: idWidth, maxWidth: idWidth }}>
          <HeadCell h={id} />
        </span>
      )}
      <span className="lr-main" data-col="main">
        <HeadCell h={main} />
      </span>
      <span className="row-copy lr-copy" data-col="copy" />
      {chips && (
        <span className="lr-chips" data-col="chips" data-hide={chipsHide} style={{ flexBasis: chipsWidth, width: chipsWidth }}>
          <HeadCell h={chips} />
        </span>
      )}
      {cols.map((c) => (
        <span
          key={c.key}
          className="lr-col"
          data-col={c.key}
          data-hide={c.hide}
          data-narrow={c.narrow?.at}
          data-align={c.align}
          style={{ width: c.width, ...(c.narrow ? { ['--lr-narrow' as string]: `${c.narrow.width}px` } : {}) }}
        >
          <HeadCell h={c.label ? { label: c.label, tip: c.tip } : undefined} />
        </span>
      ))}
      <span className="lr-people-col" data-col="people" data-hide={peopleHide}>
        <HeadCell h={people} />
      </span>
      <span className="row-time lr-time" data-col="time" data-hide="xs" style={{ width: timeWidth }}>
        <HeadCell h={time} />
      </span>
    </div>
  );
}

const GAP = 4;
const MORE_W = 30;
/** Below this width the column shows only the "+N" counter (never a sliver of a chip). */
export const CHIPS_MIN_W = 48;

/** How many chips fit in `avail` px (whole chips only; room for a "+N" pill when some are left out). Pure, tested. */
export function fitChips(widths: number[], avail: number, max = Infinity): number {
  const n = widths.length;
  const cap = Math.min(n, max);
  if (avail < CHIPS_MIN_W) return 0;
  const sum = (k: number) => widths.slice(0, k).reduce((a, w) => a + w, 0) + GAP * Math.max(0, k - 1);
  if (cap === n && sum(n) <= avail) return n;
  for (let k = cap; k > 0; k--) if (sum(k) + GAP + MORE_W <= avail) return k;
  return 0;
}

/**
 * Chips that are never cut: as many whole chips as fit (and at most `max`), then a "+N" pill with a hover card listing
 * the rest; when not even one fits (or the column is under CHIPS_MIN_W), only "+N". Widths are measured once from an
 * invisible copy; the visible count follows the column width.
 */
export function ChipList({ items, max, width, hide, className }: { items: ChipItem[]; max?: number; width?: number; hide?: HideAt; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const full = useRef<HTMLSpanElement>(null);
  const short = useRef<HTMLSpanElement>(null);
  const cap = Math.min(items.length, max ?? Infinity);
  const [fit, setFit] = useState<{ shown: number; short: boolean }>({ shown: cap, short: false });
  const sig = items.map((i) => i.key).join('\u0000');
  const hasShort = items.some((i) => i.short);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !full.current) return;
    const widths = (m: HTMLElement | null) => (m ? Array.from(m.children).map((c) => (c as HTMLElement).getBoundingClientRect().width) : []);
    const update = () => {
      const avail = el.getBoundingClientRect().width;
      // jsdom / hidden: no layout, keep the cap.
      if (!(avail > 0)) return setFit({ shown: cap, short: false });
      const kFull = fitChips(widths(full.current), avail, max);
      const kShort = hasShort ? fitChips(widths(short.current), avail, max) : -1;
      setFit(kShort > kFull ? { shown: kShort, short: true } : { shown: kFull, short: hasShort && kFull === 0 });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig, max]); // eslint-disable-line react-hooks/exhaustive-deps
  const rest = items.slice(fit.shown);
  const face = (i: ChipItem) => (fit.short && i.short ? i.short : i.node);
  const style: CSSProperties | undefined = width ? { flexBasis: width, width } : undefined;
  return (
    <span ref={box} className={`lr-chips${className ? ` ${className}` : ''}`} data-col="chips" data-hide={hide} style={style} data-testid="chip-list">
      <span ref={full} className="lr-chips-measure" aria-hidden>
        {items.map((i) => (
          <span key={i.key} className="lr-chip">
            {i.node}
          </span>
        ))}
      </span>
      {hasShort && (
        <span ref={short} className="lr-chips-measure" aria-hidden>
          {items.map((i) => (
            <span key={i.key} className="lr-chip">
              {i.short ?? i.node}
            </span>
          ))}
        </span>
      )}
      {items.slice(0, fit.shown).map((i) => (
        <span key={i.key} className="lr-chip">
          {face(i)}
        </span>
      ))}
      {rest.length > 0 && (
        <HoverCard openDelay={250} closeDelay={100} position="bottom-end" shadow="md" withinPortal>
          <HoverCard.Target>
            <span className="tag-pill lr-more" data-testid="chips-more">
              +{rest.length}
            </span>
          </HoverCard.Target>
          <HoverCard.Dropdown p={8} onClick={(e) => (e.preventDefault(), e.stopPropagation())}>
            <div className="lr-more-list" data-testid="chips-more-list">
              {rest.map((i) => (
                <div key={i.key}>{i.label ?? i.node}</div>
              ))}
            </div>
          </HoverCard.Dropdown>
        </HoverCard>
      )}
    </span>
  );
}

/** Time column: compact ("closed 18h ago"), never clipped, with the full date(s) in a tooltip. */
export function RowTime({ iso, prefix, label }: { iso: string; prefix?: string; label?: ReactNode }) {
  if (!iso) return null;
  return (
    <Tooltip label={label ?? absoluteTime(iso)} openDelay={250}>
      <time dateTime={iso} className="lr-time-text">
        {prefix ? `${prefix} ` : ''}
        {compactTime(iso)}
      </time>
    </Tooltip>
  );
}
