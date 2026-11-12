import { Fragment, useMemo, useState } from 'react';
import { Tooltip } from '@mantine/core';
import {
  IconCircleDashed,
  IconClipboardList,
  IconComponents,
  IconFileText,
  IconGitCommit,
  IconListCheck,
  IconMessage,
  IconMessageReport,
  IconProgress,
  IconRuler2,
  IconShieldCheck,
  IconMessageQuestion,
} from '@tabler/icons-react';
import { Link } from 'react-router';
import { parseRef } from '@mandate/shared/refs';
import type { LineageEvent, LineageEventKind, LineageSummary } from '@mandate/shared';
import { formatDuration, gutterLayout, storyDays, type GutterCell } from '../../lib/lineage';
import { refHref } from '../refs/kinds';
import { ByLine } from '../attribution/Attribution';
import { RefChip } from '../refs/RefChip';
import { WorkProgressLine } from './WorkProgress';
import { ElementMenu, useOpenElement, type MenuAt } from './ElementActions';
import { absoluteTime } from '../../lib/time';
import './lineage.css';

const KIND_ICON: Record<LineageEventKind, typeof IconFileText> = {
  feedback: IconMessageReport,
  spec: IconFileText,
  standard: IconRuler2,
  component: IconComponents,
  work_order: IconClipboardList,
  verification: IconShieldCheck,
  audit: IconListCheck,
  comment: IconMessage,
  question: IconMessageQuestion,
  other: IconGitCommit,
};

const LANE_W = 10;
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Tracked changes" link of a document version (`…/specs/x@sha` -> `/specs/x?version=sha`). */
export function versionHref(version: string | undefined): string | null {
  if (!version) return null;
  const r = parseRef(version);
  return r?.commit ? `/${r.kind}/${r.id}?version=${r.commit}` : null;
}

function Gutter({ cells, lanes, dot }: { cells: GutterCell[]; lanes: number; dot: boolean }) {
  if (!lanes) return <span className="story-gutter" style={{ width: 14 }}>{dot && <span className="story-dot" style={{ left: 3 }} />}</span>;
  const w = lanes * LANE_W + 14;
  const dotX = lanes * LANE_W + 3;
  return (
    <span className="story-gutter" style={{ width: w }} aria-hidden>
      {cells.map((c, lane) =>
        c === 'none' ? null : (
          <Fragment key={lane}>
            <span className="story-line" data-cell={c} style={{ left: lane * LANE_W + 4 }} />
            {(c === 'start' || c === 'end' || c === 'through') && <span className="story-stub" data-cell={c} style={{ left: lane * LANE_W + 4, width: dotX - lane * LANE_W - 2 }} />}
          </Fragment>
        ),
      )}
      {dot && <span className="story-dot" style={{ left: dotX }} />}
    </span>
  );
}

function Entry({ e, showGap }: { e: LineageEvent; showGap: boolean }) {
  const Icon = KIND_ICON[e.kind] ?? IconCircleDashed;
  const tracked = versionHref(e.version);
  return (
    <div className="story-body">
      <div className="story-line1">
        <Tooltip label={absoluteTime(e.at)} openDelay={300} withinPortal>
          <span className="story-time">{TIME_FMT.format(new Date(e.at))}</span>
        </Tooltip>
        <Icon size={14} stroke={1.6} className="story-kind" data-kind={e.kind} />
        <span className="story-text">{e.text}</span>
        {showGap && e.gapMs != null && e.gapMs > 0 && <span className="story-gap">+{formatDuration(e.gapMs)}</span>}
      </div>
      <div className="story-line2">
        <ByLine a={{ user: e.user, agent: e.agent }} size={13} />
        <RefChip to={e.subject} label={e.label} resolve={false} />
        {tracked && (
          <Link to={tracked} className="story-link" onClick={(ev) => ev.stopPropagation()}>
            tracked changes
          </Link>
        )}
        {e.causes.length > 0 && (
          <span className="story-causes">
            <span className="faint">caused by</span>
            {e.causes.slice(0, 3).map((c) => (
              <RefChip key={c} to={c} />
            ))}
          </span>
        )}
        {e.status && <span className="story-status">{e.status.replace(/_/g, ' ')}</span>}
        {(e.linesAdded || e.linesRemoved) ? (
          <span className="story-lines">
            <span data-tone="added">+{e.linesAdded ?? 0}</span> <span data-tone="removed">−{e.linesRemoved ?? 0}</span>
          </span>
        ) : null}
      </div>
      {e.sections && e.sections.length > 0 && (
        <div className="story-sections">
          {e.sections.slice(0, 4).map((s) => (
            <Link key={s.uri} to={refHref(s.uri) ?? '#'} className="story-section" data-action={s.action} onClick={(ev) => ev.stopPropagation()}>
              {s.action === 'created' ? '+' : s.action === 'deleted' ? '−' : '~'} {s.title}
            </Link>
          ))}
          {e.sections.length > 4 && <span className="faint">+{e.sections.length - 4} more</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The lineage as a chronological story: events grouped by day, a git-graph-like gutter connecting each event to the
 * event that caused it (causal links only), the gap between steps and an in-progress tail ("now: …").
 */
export function LineageStory({ events, changing, order = 'asc', truncated, onCenter }: { events: LineageEvent[]; changing?: LineageSummary['changing']['items']; order?: 'asc' | 'desc'; truncated?: boolean; onCenter?: (uri: string) => void }) {
  const days = useMemo(() => storyDays(events, order), [events, order]);
  const open = useOpenElement();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const display = useMemo(() => days.flatMap((d) => d.events), [days]);
  const g = useMemo(() => gutterLayout(display), [display]);
  const tail = (changing ?? []).length > 0 && (
    <div className="story-now" data-testid="story-now">
      {changing!.map((c) => (
        <div key={c.uri} className="story-now-row">
          <IconProgress size={14} className="lin-status-icon" data-status="in_progress" />
          <span className="story-time">now</span>
          {refHref(c.uri) ? <Link to={refHref(c.uri)!}>{c.label}</Link> : <span>{c.label}</span>}
          {c.work ? <WorkProgressLine work={c.work} /> : <span className="faint">in progress{c.progress ? ` · ${c.progress}` : ''}</span>}
          {c.url && !c.work && (
            <a className="wp-pr" href={c.url} target="_blank" rel="noreferrer noopener">
              open ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
  if (!events.length && !tail) return <div className="lin-placeholder">No recorded events yet.</div>;
  let k = 0;
  return (
    <div className="story" data-testid="lineage-story">
      {order === 'desc' && tail}
      {truncated && order === 'asc' && <div className="faint small story-trunc">Older events left out.</div>}
      {days.map((d) => {
        const first = k;
        return (
          <section key={d.day} className="story-day" data-testid="story-day">
            <div className="story-day-head">
              <Gutter cells={Array.from({ length: g.lanes }, (_, lane) => (g.passing(first).includes(lane) ? 'mid' : 'none'))} lanes={g.lanes} dot={false} />
              <span>{DAY_FMT.format(new Date(`${d.day}T12:00:00`))}</span>
            </div>
            {d.events.map((e) => {
              const i = k++;
              return (
                <div
                  key={e.id}
                  className="story-entry"
                  data-testid="story-entry"
                  data-kind={e.kind}
                  data-caused={e.causedBy ? true : undefined}
                  role="link"
                  tabIndex={0}
                  aria-label={e.text}
                  onClick={(ev) => {
                    // Clicks on inline chips / links handle themselves.
                    if ((ev.target as HTMLElement).closest('a, button, .ref-chip-rich')) return;
                    open(e.subject, ev.metaKey || ev.ctrlKey);
                  }}
                  onKeyDown={(ev) => ev.key === 'Enter' && ev.target === ev.currentTarget && open(e.subject, ev.metaKey || ev.ctrlKey)}
                  onContextMenu={(ev) => {
                    if ((ev.target as HTMLElement).closest('.ref-chip-rich')) return;
                    ev.preventDefault();
                    setMenu({ uri: e.subject, x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <Gutter cells={g.cells[i]!} lanes={g.lanes} dot />
                  <Entry e={e} showGap={i > 0} />
                </div>
              );
            })}
          </section>
        );
      })}
      {truncated && order === 'desc' && <div className="faint small story-trunc">Older events left out.</div>}
      {order === 'asc' && tail}
      <ElementMenu at={menu} onClose={() => setMenu(null)} onCenter={onCenter} />
    </div>
  );
}
