/** Overview "In progress" tab: work grouped by spec, the agents-today timeline, stuck items and specs moving (pure helpers + the 24 h activity query). */
import { useQuery } from '@tanstack/react-query';
import type { ActivityListResponse, MaturityStep, OverviewBlocked, OverviewSession, OverviewWorkOrder, ProjectOverview, SpecMaturity } from '@mandate/shared';
import { parseRef } from '@mandate/shared/refs';
import { callTool } from '../mcp/client';
import type { ActivityEvent } from '../components/activity/types';

const HOUR = 3_600_000;

/* ---------------------------------------------------------------- grouped by spec */

export interface SpecGroup {
  id: string;
  title: string;
  maturity?: SpecMaturity;
  items: OverviewWorkOrder[];
}

/** Work in progress grouped by spec (first appearance order: fresh heartbeats first). */
export function groupBySpec(o: Pick<ProjectOverview, 'inProgress' | 'progressSpecs'>): SpecGroup[] {
  const specs = new Map((o.progressSpecs ?? []).map((s) => [s.id, s]));
  const out = new Map<string, SpecGroup>();
  for (const w of o.inProgress) {
    let g = out.get(w.spec);
    if (!g) {
      const s = specs.get(w.spec);
      g = { id: w.spec, title: s?.title ?? w.specTitle ?? w.spec, ...(s ? { maturity: s.maturity } : {}), items: [] };
      out.set(w.spec, g);
    }
    g.items.push(w);
  }
  return [...out.values()];
}

/* ---------------------------------------------------------------- agents today */

export interface Bar {
  workOrder: string;
  title: string;
  kind: string;
  start: number;
  end: number;
  /** live (fresh claim), stale (no heartbeat), completed, or how it ended (released, failed…). */
  state: 'live' | 'stale' | 'completed' | 'ended';
}
export interface Lane {
  agent: string;
  bars: Bar[];
}
export interface Timeline {
  from: number;
  to: number;
  lanes: Lane[];
  live: number;
  stale: number;
}

/** One lane per agent with a session today (local day; from 08:00 or the first session, to now). */
export function buildTimeline(sessions: OverviewSession[], now: number): Timeline {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.getTime();
  const lanes = new Map<string, Lane>();
  let first = Infinity;
  const live = new Set<string>();
  const stale = new Set<string>();
  for (const s of sessions) {
    const start = Date.parse(s.startedAt);
    const end = s.endedAt ? Date.parse(s.endedAt) : s.stale ? Date.parse(s.heartbeatAt ?? s.startedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < dayStart) continue;
    const state: Bar['state'] = s.endedAt ? (s.ended === 'completed' ? 'completed' : 'ended') : s.stale ? 'stale' : 'live';
    if (state === 'live') live.add(s.agent);
    if (state === 'stale') stale.add(s.agent);
    const b: Bar = { workOrder: s.workOrder, title: s.title, kind: s.kind, start: Math.max(start, dayStart), end: Math.max(end, Math.max(start, dayStart)), state };
    first = Math.min(first, b.start);
    const lane = lanes.get(s.agent) ?? { agent: s.agent, bars: [] };
    lane.bars.push(b);
    lanes.set(s.agent, lane);
  }
  const from = Math.min(dayStart + 8 * HOUR, Number.isFinite(first) ? Math.floor(first / HOUR) * HOUR : dayStart + 8 * HOUR, now - HOUR);
  const to = Math.max(now, from + HOUR);
  return { from, to, lanes: [...lanes.values()], live: live.size, stale: [...stale].filter((a) => !live.has(a)).length };
}

/** Hour ticks of the axis (at most ~6). */
export function hourTicks(from: number, to: number): number[] {
  const hours = Math.max(1, (to - from) / HOUR);
  const step = Math.max(1, Math.ceil(hours / 5)) * HOUR;
  const out: number[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += step) out.push(t);
  return out;
}

/* ---------------------------------------------------------------- stuck */

export type StuckItem = { kind: 'claim'; w: OverviewWorkOrder } | { kind: 'blocked'; b: OverviewBlocked };

/** Stale claims first, then blocked work orders and sections. */
export function stuckItems(o: Pick<ProjectOverview, 'inProgress' | 'blocked'>): StuckItem[] {
  return [...o.inProgress.filter((w) => w.claim?.stale && !(w.sections.total > 0 && w.sections.done >= w.sections.total)).map((w) => ({ kind: 'claim' as const, w })), ...o.blocked.map((b) => ({ kind: 'blocked' as const, b }))];
}

/* ---------------------------------------------------------------- durations */

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/* ---------------------------------------------------------------- specs moving */

export const MOVING_TYPES = ['spec.status_changed', 'work_order.claimed', 'work_order.section_done', 'work_order.completed', 'verification.recorded', 'audit.completed'];
const BUILD_KINDS = new Set(['implement', 'update', 'fix']);

export interface SpecMove {
  id: string;
  title: string;
  from: MaturityStep;
  to: MaturityStep;
  at: string;
  event: ActivityEvent;
}

/** The maturity step an event moves its spec to (and from), when it is a step-changing kind of event. */
function implied(e: ActivityEvent): { from: MaturityStep; to: MaturityStep } | null {
  const d = (e.details ?? {}) as Record<string, any>;
  switch (e.type) {
    case 'spec.status_changed':
      return null;
    case 'work_order.claimed':
      return BUILD_KINDS.has(d.kind) ? { from: 'specified', to: 'in_progress' } : null;
    case 'work_order.section_done':
    case 'work_order.completed':
      return BUILD_KINDS.has(d.kind) ? { from: 'in_progress', to: 'implemented' } : null;
    default:
      return null;
  }
}

const specOf = (e: ActivityEvent): string | null => {
  for (const r of e.refs ?? []) {
    const p = parseRef(r);
    if (p?.kind === 'specs') return p.id;
  }
  return null;
};

/**
 * Specs whose current maturity step is the one an event of the window moved them to (newest event per spec): the step
 * transitions the activity explains. Events newest first.
 */
export function specsMoving(events: ActivityEvent[], steps: Map<string, { title: string; step: MaturityStep }>): SpecMove[] {
  const out = new Map<string, SpecMove>();
  for (const e of events) {
    const id = specOf(e);
    if (!id || out.has(id)) continue;
    const t = implied(e);
    const s = steps.get(id);
    if (!t || !s || s.step !== t.to) continue;
    out.set(id, { id, title: s.title, from: t.from, to: t.to, at: e.at, event: e });
  }
  return [...out.values()];
}

/** Every non-archived spec's current step (categories list them all; in-progress specs carry their full maturity). */
export function stepsOf(o: Pick<ProjectOverview, 'byCategory' | 'progressSpecs'>): Map<string, { title: string; step: MaturityStep }> {
  const m = new Map<string, { title: string; step: MaturityStep }>();
  for (const c of o.byCategory) for (const s of c.specs) m.set(s.id, { title: s.title, step: s.step });
  for (const s of o.progressSpecs ?? []) m.set(s.id, { title: s.title, step: s.maturity.step });
  return m;
}

export const MOVING_HOURS = 24;

export function useMovingActivity(now = Date.now()) {
  const since = new Date(Math.floor((now - MOVING_HOURS * HOUR) / (5 * 60_000)) * 5 * 60_000).toISOString();
  return useQuery({
    queryKey: ['overview', 'moving', since],
    queryFn: ({ signal }) => callTool<ActivityListResponse>('activity_list', { since, types: MOVING_TYPES, includeHeartbeats: false, limit: 300 }, signal),
    staleTime: 10_000,
  });
}

/** `claude-code@mbp` → `claude-code` (the client, for its mark). */
export const agentClient = (agent: string) => agent.split(/[@/]/)[0]!.trim().toLowerCase().replace(/\s+/g, '-');
