import type { ReactNode } from 'react';
import { ACTIVITY_NOTIFICATION, activityTouches, activityTypeMatches, type ActivityEvent } from '@mandate/shared';

export type { ActivityEvent };

export interface ActivityFilters {
  /** Any of these agents (empty / absent: all). */
  agents?: string[];
  /** Any of these event types or type prefixes (`spec`, `work_order.section_done`). */
  types?: string[];
  /** Any of these users (server mode only; local mode records no users). */
  users?: string[];
}

/** Renders the body of one event type (like section renderers); register per type or `prefix.*`. */
export type ActivityRenderer = (event: ActivityEvent) => ReactNode;
export type ActivityRendererRegistry = Record<string, ActivityRenderer>;

export const ACTIVITY_METHOD = ACTIVITY_NOTIFICATION;
export const MAX_ACTIVITY_EVENTS = 200;

/** Narrow an unknown notification payload to an event (null when malformed). */
export function toActivityEvent(p: unknown): ActivityEvent | null {
  const e = p as Partial<ActivityEvent> | null;
  if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.summary !== 'string') return null;
  return { ...e, commit: e.commit ?? e.id, at: e.at ?? new Date().toISOString(), refs: Array.isArray(e.refs) ? e.refs : [] } as ActivityEvent;
}

export function filterEvents(events: ActivityEvent[], f: ActivityFilters, docUri?: string): ActivityEvent[] {
  return events.filter(
    (e) =>
      (!f.agents?.length || (!!e.agent && f.agents.includes(e.agent))) &&
      (!f.users?.length || (!!e.user && f.users.includes(e.user))) &&
      (!f.types?.length || f.types.some((t) => e.type === t || activityTypeMatches(e.type, t.includes('.') || t === '*' ? t : `${t}.*`))) &&
      (!docUri || activityTouches(e, docUri)),
  );
}
