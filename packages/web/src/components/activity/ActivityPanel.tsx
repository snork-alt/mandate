import { useState, type ReactNode } from 'react';
import { activityRenderers } from './renderers';
import { RefChip } from '../refs/RefChip';
import { ActivityFilterBar } from './ActivityFilterBar';
import { IconActivity, IconGitCommit, IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { filterEvents, type ActivityEvent, type ActivityFilters, type ActivityRenderer, type ActivityRendererRegistry } from './types';

/** Default renderer registry; add per-type renderers with `registry['spec.updated'] = ...` (`spec.*` matches a prefix). */
export const defaultActivityRenderers: ActivityRendererRegistry = activityRenderers;

function rendererFor(registry: ActivityRendererRegistry, type: string): ActivityRenderer | undefined {
  if (registry[type]) return registry[type];
  const parts = type.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const r = registry[`${parts.slice(0, i).join('.')}.*`];
    if (r) return r;
  }
  return undefined;
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

export interface ActivityPanelProps {
  events: ActivityEvent[];
  /** Restrict to one document (`mandate` reference of the current page); omit for the global feed. */
  docUri?: string;
  /** Controlled filters; uncontrolled when omitted. */
  filters?: ActivityFilters;
  onFiltersChange?: (f: ActivityFilters) => void;
  renderers?: ActivityRendererRegistry;
  connected?: boolean;
  paused?: boolean;
  onPausedChange?: (p: boolean) => void;
  /** Live events held back while paused. */
  buffered?: number;
  /** Keys (`id|type`) of events that arrived live: they slide in. */
  fresh?: ReadonlySet<string>;
}

const isHeartbeat = (e: ActivityEvent) => !!e.heartbeat || e.type === 'work_order.heartbeat';
interface Row { event: ActivityEvent; count: number }
/** Consecutive heartbeats of the same work order collapse into one row ("heartbeat x12"). */
export function groupHeartbeats(events: ActivityEvent[]): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (last && isHeartbeat(e) && isHeartbeat(last.event) && last.event.refs[0] === e.refs[0]) last.count++;
    else rows.push({ event: e, count: 1 });
  }
  return rows;
}

export function ActivityPanel({ events, docUri, filters: controlled, onFiltersChange, renderers = defaultActivityRenderers, connected, paused, onPausedChange, buffered = 0, fresh }: ActivityPanelProps) {
  const [limit, setLimit] = useState(60);
  const [local, setLocal] = useState<ActivityFilters>({});
  const filters = controlled ?? local;
  const setFilters = (f: ActivityFilters) => (onFiltersChange ? onFiltersChange(f) : setLocal(f));
  const agents = Array.from(new Set(events.map((e) => e.agent).filter(Boolean) as string[]));
  const types = Array.from(new Set(events.map((e) => e.type.split('.')[0]!)));
  const shown = groupHeartbeats(filterEvents(events, filters, docUri));

  const header = (
    <div className="activity-bar">
      <span className="activity-conn" data-connected={connected || undefined} title={connected ? 'Connected: live' : 'Offline: reconnecting'} />
      <span className="rail-faint">{connected ? 'Live' : 'Offline'}</span>
      {onPausedChange && (
        <button type="button" className="activity-pause" onClick={() => onPausedChange(!paused)} aria-pressed={!!paused}>
          {paused ? <IconPlayerPlay size={12} /> : <IconPlayerPause size={12} />}
          {paused ? `Resume${buffered ? ` · ${buffered} new` : ''}` : 'Pause'}
        </button>
      )}
    </div>
  );

  if (!events.length) {
    return (
      <div className="activity">
        {header}
        <div className="activity-empty" data-testid="activity-empty">
          <IconActivity size={22} stroke={1.5} />
          <div>Live agent activity will appear here</div>
          <div className="rail-faint">{docUri ? 'Events for this document show up as agents work on it.' : 'Spec edits, work order progress and feedback from connected agents.'}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="activity">
      {header}
      <ActivityFilterBar filters={filters} onChange={setFilters} agents={agents} types={types} />
      {shown.length === 0 && <div className="activity-empty">No matching events</div>}
      <ol className="activity-list">
        {shown.slice(0, limit).map(({ event: e, count }) => {
          const custom = rendererFor(renderers, e.type);
          const key = `${e.id}|${e.type}`;
          return (
            <li key={key} className="activity-item" data-fresh={fresh?.has(key) || undefined} data-type={e.type}>
              <div className="activity-head">
                <IconGitCommit size={13} stroke={1.6} />
                <span className="activity-type">{count > 1 ? `heartbeat ×${count}` : e.type}</span>
                {e.agent && <span className="rail-faint">{e.agent}</span>}
                <span className="rail-faint activity-time">{ago(e.at)}</span>
              </div>
              <div className="activity-body">{count > 1 ? (e.refs[0] ? <RefChip to={e.refs[0]} /> : e.summary) : custom ? custom(e) : defaultBody(e)}</div>
            </li>
          );
        })}
      </ol>
      {shown.length > limit && (
        <button type="button" className="activity-more" onClick={() => setLimit((l) => l + 60)}>
          Show more
        </button>
      )}
    </div>
  );
}

function defaultBody(e: ActivityEvent): ReactNode {
  return (
    <>
      <div className="activity-summary">{e.summary}</div>
      {e.refs.length > 0 && (
        <div className="ref-chips">
          {e.refs.slice(0, 4).map((r) => (
            <RefChip key={r} to={r} />
          ))}
        </div>
      )}
    </>
  );
}
