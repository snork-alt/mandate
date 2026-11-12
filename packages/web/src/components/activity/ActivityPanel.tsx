import { useState, type ReactNode } from 'react';
import { Skeleton, Tooltip } from '@mantine/core';
import { activityRenderers } from './renderers';
import { RefChip } from '../refs/RefChip';
import { ActivityFilterBar, FAMILY_ICON } from './ActivityFilterBar';
import { IconActivity, IconChevronRight, IconGitCommit, IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { useShowUsers, usersOf, attributionText } from '../../lib/attribution';
import { ByLine } from '../attribution/Attribution';
import { AgentAvatar, UserFilterContext } from '../people/People';
import { filterEvents, type ActivityEvent, type ActivityFilters, type ActivityRenderer, type ActivityRendererRegistry } from './types';
import { isCommitRef, eventTarget, eventTitle, groupEvents, groupTitle, type ActivityGroup } from '../../lib/activity';
import { absoluteTime, compactTime } from '../../lib/time';
import './activity.css';

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

export interface ActivityPanelProps {
  events: ActivityEvent[];
  /** Restrict to one document (`mandate` reference of the current page); omit for the global feed. */
  docUri?: string;
  /** Controlled filters; uncontrolled when omitted. */
  filters?: ActivityFilters;
  onFiltersChange?: (f: ActivityFilters) => void;
  renderers?: ActivityRendererRegistry;
  connected?: boolean;
  /** The first load settled (default true): before that the panel shows skeletons and "Connecting…", never "Offline" or the empty state. */
  loaded?: boolean;
  paused?: boolean;
  onPausedChange?: (p: boolean) => void;
  /** Live events held back while paused. */
  buffered?: number;
  /** Keys (`id|type`) of events that arrived live: they slide in. */
  fresh?: ReadonlySet<string>;
}

const isHeartbeat = (e: ActivityEvent) => !!e.heartbeat || e.type === 'work_order.heartbeat';
interface Row { event: ActivityEvent; count: number }
/** Consecutive heartbeats of the same work order collapse into one row ("heartbeat x12"). Kept for callers; the panel uses groupEvents. */
export function groupHeartbeats(events: ActivityEvent[]): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (last && isHeartbeat(e) && isHeartbeat(last.event) && last.event.refs[0] === e.refs[0]) last.count++;
    else rows.push({ event: e, count: 1 });
  }
  return rows;
}

const familyIcon = (type: string) => FAMILY_ICON[type.split('.')[0]!] ?? <IconGitCommit size={14} stroke={1.6} />;

function When({ iso }: { iso: string }) {
  return (
    <Tooltip label={absoluteTime(iso)} openDelay={300}>
      <time className="rail-faint activity-time" dateTime={iso}>
        {compactTime(iso).replace(/ ago$/, '')}
      </time>
    </Tooltip>
  );
}

function Actor({ e, showUsers }: { e: ActivityEvent; showUsers: boolean }) {
  return (
    <span className="rail-faint activity-actor">
      {e.agent || (showUsers && e.user) ? <ByLine a={{ user: e.user, agent: e.agent }} showUsers={showUsers} size={14} agentAvatar /> : <AgentAvatar size={14} legacy={showUsers} verb="Acted" />}
    </span>
  );
}

function GroupItem({ g, renderers, fresh, showUsers }: { g: ActivityGroup; renderers: ActivityRendererRegistry; fresh?: ReadonlySet<string>; showUsers: boolean }) {
  const [open, setOpen] = useState(false);
  const e = g.events[0]!;
  const n = g.events.length;
  const custom = rendererFor(renderers, e.type);
  const target = n > 1 ? eventTarget(e) : undefined;
  return (
    <li className="activity-item" data-fresh={g.events.some((x) => fresh?.has(`${x.id}|${x.type}`)) || undefined} data-type={e.type} data-count={n > 1 ? n : undefined}>
      <div className="activity-head">
        <span className="activity-icon" aria-hidden>
          {familyIcon(e.type)}
        </span>
        <span className="activity-title">{groupTitle(g)}</span>
        <When iso={e.at} />
      </div>
      <div className="activity-meta">
        <Actor e={e} showUsers={showUsers} />
      </div>
      <div className="activity-body">
        {n === 1 ? (
          custom ? custom(e) : defaultBody(e)
        ) : (
          <>
            {target && !isCommitRef(target) && <RefChip to={target} />}
            <button type="button" className="activity-expand" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <IconChevronRight size={12} className="activity-expand-chevron" />
              {open ? 'Hide' : 'Show'} {n} events
            </button>
            {open && (
              <ol className="activity-sublist">
                {g.events.map((x) => (
                  <li key={`${x.id}|${x.type}`} className="activity-subitem">
                    <span className="activity-subtitle">{eventTitle(x)}</span>
                    <When iso={x.at} />
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function ActivityPanel({ events, docUri, filters: controlled, onFiltersChange, renderers = defaultActivityRenderers, connected, loaded = true, paused, onPausedChange, buffered = 0, fresh }: ActivityPanelProps) {
  const [limit, setLimit] = useState(60);
  const [local, setLocal] = useState<ActivityFilters>({});
  const filters = controlled ?? local;
  const setFilters = (f: ActivityFilters) => (onFiltersChange ? onFiltersChange(f) : setLocal(f));
  const showUsers = useShowUsers();
  const agents = Array.from(new Set(events.map((e) => e.agent).filter(Boolean) as string[]));
  const users = usersOf(events, showUsers);
  const types = Array.from(new Set(events.map((e) => e.type.split('.')[0]!)));
  const shown = groupEvents(filterEvents(events, showUsers ? filters : { ...filters, users: undefined }, docUri));
  const state = !loaded && !events.length ? 'connecting' : connected ? 'live' : 'offline';
  const stateLabel = state === 'connecting' ? 'Connecting…' : state === 'live' ? 'Live' : 'Offline';
  const stateTip = state === 'connecting' ? 'Loading recent activity' : state === 'live' ? 'Connected: live' : 'Offline: reconnecting';

  const header = (
    <div className="activity-bar">
      <Tooltip label={stateTip} openDelay={300}>
        <span className="activity-conn" data-connected={state === 'live' || undefined} data-state={state} role="img" aria-label={stateTip} />
      </Tooltip>
      <span className="rail-faint">{stateLabel}</span>
      {onPausedChange && (
        <button type="button" className="activity-pause" onClick={() => onPausedChange(!paused)} aria-pressed={!!paused}>
          {paused ? <IconPlayerPlay size={12} /> : <IconPlayerPause size={12} />}
          {paused ? `Resume${buffered ? ` · ${buffered} new` : ''}` : 'Pause'}
        </button>
      )}
    </div>
  );

  if (state === 'connecting') {
    return (
      <div className="activity" aria-busy="true">
        {header}
        <div className="activity-skeleton" data-testid="activity-loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="activity-skeleton-row">
              <Skeleton height={10} width="70%" radius="sm" />
              <Skeleton height={8} width="40%" radius="sm" mt={6} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="activity">
        {header}
        <div className="activity-empty" data-testid="activity-empty">
          <IconActivity size={22} stroke={1.5} />
          <div>{state === 'offline' ? 'Activity is unavailable while offline' : 'Live agent activity will appear here'}</div>
          <div className="rail-faint">
            {state === 'offline' ? 'Reconnecting: recent events load as soon as the server is reachable.' : docUri ? 'Events for this document show up as agents work on it.' : 'Spec edits, work order progress and feedback from connected agents.'}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="activity">
      {header}
      <ActivityFilterBar filters={filters} onChange={setFilters} agents={agents} types={types} users={users} />
      {shown.length === 0 && <div className="activity-empty">No matching events</div>}
      <UserFilterContext.Provider value={showUsers ? (u: string) => setFilters({ ...filters, users: [u] }) : null}>
        <ol className="activity-list">
          {shown.slice(0, limit).map((g) => (
            <GroupItem key={g.key + g.events[0]!.id} g={g} renderers={renderers} fresh={fresh} showUsers={showUsers} />
          ))}
        </ol>
      </UserFilterContext.Provider>
      {shown.length > limit && (
        <button type="button" className="activity-more" onClick={() => setLimit((l) => l + 60)}>
          Show more
        </button>
      )}
    </div>
  );
}

function defaultBody(e: ActivityEvent): ReactNode {
  const refs = e.refs.filter((r) => !isCommitRef(r));
  return refs.length > 0 ? (
    <div className="ref-chips">
      {refs.slice(0, 4).map((r) => (
        <RefChip key={r} to={r} />
      ))}
    </div>
  ) : null;
}

/** "<user> via <agent>", else "via <agent>" (older agent-only commits). */
export const actorLabel = (e: { agent?: string; user?: string }, showUsers = false) => attributionText(e, showUsers);
