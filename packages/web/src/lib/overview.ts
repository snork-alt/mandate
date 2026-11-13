/** Overview page data: the `project_overview` aggregate and the last 7 days of activity, grouped by day and document. */
import { useQuery } from '@tanstack/react-query';
import type { ActivityListResponse, ProjectOverview } from '@mandate/shared';
import { parseRef } from '@mandate/shared/refs';
import { callTool } from '../mcp/client';
import type { ActivityEvent } from '../components/activity/types';
import { refHref } from '../components/refs/kinds';
import { dayKey, eventTarget, eventTitle } from './activity';

export const RECENT_DAYS = 7;
/** What "Recently changed" shows: content edits, completed work orders, closed feedback, audits. */
export const RECENT_TYPES = ['spec.*', 'standard.*', 'component.*', 'work_order.completed', 'feedback.closed', 'audit.completed', 'audit.abandoned', 'audit.started'];

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => callTool<ProjectOverview>('project_overview', {}, signal), staleTime: 10_000 });
}

export function useRecentActivity(now = Date.now()) {
  // Rounded to the hour so the key (and the cache) stays stable while the page is open.
  const since = new Date(Math.floor((now - RECENT_DAYS * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
  return useQuery({
    queryKey: ['overview', 'recent', since],
    queryFn: ({ signal }) => callTool<ActivityListResponse>('activity_list', { since, types: RECENT_TYPES, includeHeartbeats: false, limit: 500 }, signal),
    staleTime: 10_000,
  });
}

export type RecentCategory = 'edit' | 'work_order' | 'feedback' | 'audit';

export interface RecentItem {
  key: string;
  category: RecentCategory;
  /** The document / work order / feedback / audit. */
  target: string;
  title: string;
  /** "3 changes · Edited section Limits" or the event sentence. */
  detail: string;
  events: ActivityEvent[];
  /** Distinct actors, most recent first. */
  actors: { agent?: string; user?: string }[];
  /** Newest event time. */
  at: string;
  /** Where to look: tracked changes of the newest commit for documents, else the item. */
  href: string | null;
}

export interface RecentDay {
  day: string;
  items: RecentItem[];
}

const categoryOf = (t: string): RecentCategory => (t.startsWith('work_order.') ? 'work_order' : t.startsWith('feedback.') ? 'feedback' : t.startsWith('audit.') ? 'audit' : 'edit');
const CONTENT = /^mandate:\/\/(specs|standards|components)\/[^/]+$/;

/** Events (newest first) → days (newest first) → one item per (category, target), newest first. */
export function groupRecent(events: ActivityEvent[]): RecentDay[] {
  const days = new Map<string, Map<string, RecentItem>>();
  for (const e of events) {
    const target = eventTarget(e);
    if (!target) continue;
    const day = dayKey(e.at);
    const category = categoryOf(e.type);
    const key = `${category}|${target}`;
    const items = days.get(day) ?? new Map<string, RecentItem>();
    days.set(day, items);
    let it = items.get(key);
    if (!it) {
      const id = parseRef(target)?.id ?? target;
      const title = typeof e.details?.title === 'string' && e.details.title ? e.details.title : id;
      const base = refHref(target);
      it = { key, category, target, title, detail: '', events: [], actors: [], at: e.at, href: base && CONTENT.test(target) && e.commit ? `${base}?version=${e.commit}` : base };
      items.set(key, it);
    }
    it.events.push(e);
    if (!it.actors.some((a) => a.agent === e.agent && a.user === e.user)) it.actors.push({ agent: e.agent, user: e.user });
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, items]) => ({
      day,
      items: [...items.values()]
        .map((it) => {
          const n = it.events.length;
          const first = eventTitle(it.events[0]!);
          return { ...it, detail: n === 1 ? first : `${n} changes · latest: ${first}` };
        })
        .sort((a, b) => b.at.localeCompare(a.at)),
    }));
}

/** Specs-list URL filtered on maturity steps / overlays. */
export const specsFiltered = (...maturity: string[]) => `/specs?maturity=${maturity.join(',')}`;

/** Maturity step colours (the same as the Specs summary bar). */
export const STEP_COLOR: Record<string, string> = {
  draft: 'var(--app-text-faint)',
  specified: 'var(--app-text-muted)',
  in_progress: 'var(--mantine-color-lilac-5, var(--mantine-primary-color-filled))',
  implemented: 'var(--mantine-color-blue-5)',
  verified: 'var(--mantine-color-teal-5)',
  audited: 'var(--mantine-color-teal-7)',
};

/* ---------------------------------------------------------------- tabs */

/** Overview tabs ("Action needed" became its own page, /actions). */
export const OVERVIEW_TABS = ['progress', 'health'] as const;
export type OverviewTab = (typeof OVERVIEW_TABS)[number];
/** What a header chip focuses inside a tab (`?focus=`). */
export type AttentionFocus = 'failing' | 'drifted' | 'blocked' | 'stale' | 'findings' | 'claims' | 'failed' | 'errors' | 'warnings';

export const isTab = (v: unknown): v is OverviewTab => typeof v === 'string' && (OVERVIEW_TABS as readonly string[]).includes(v);
const tabKey = (projectId: string) => `mandate.overview.tab.${projectId}`;
export function loadTab(projectId: string): OverviewTab | null {
  try {
    const v = localStorage.getItem(tabKey(projectId));
    return isTab(v) ? v : null;
  } catch {
    return null;
  }
}
export function saveTab(projectId: string, tab: OverviewTab): void {
  try {
    localStorage.setItem(tabKey(projectId), tab);
  } catch {
    /* storage unavailable */
  }
}

/** Items on the Actions page: decisions, blocked items, specs needing attention, specs with open must findings. */
export function actionCount(o: Pick<ProjectOverview, 'blockedTotal' | 'attention' | 'mustFindingSpecs'>, decisionsTotal: number): number {
  return decisionsTotal + o.blockedTotal + o.attention.specs.length + o.mustFindingSpecs.length;
}

/** The tab to show: the URL, else the one remembered for this project, else "In progress". */
export function pickTab(url: string | null, remembered: OverviewTab | null): OverviewTab {
  if (isTab(url)) return url;
  return remembered ?? 'progress';
}

/** Header chip → Overview tab (or the Actions page, `actions`) and focus. */
export const CHIP_TARGET: Record<string, { tab: OverviewTab | 'actions'; focus: AttentionFocus; card: string }> = {
  failing: { tab: 'actions', focus: 'failing', card: 'attention' },
  drifted: { tab: 'actions', focus: 'drifted', card: 'attention' },
  blocked: { tab: 'actions', focus: 'blocked', card: 'attention' },
  stale: { tab: 'actions', focus: 'stale', card: 'attention' },
  findings: { tab: 'actions', focus: 'findings', card: 'findings' },
  claims: { tab: 'actions', focus: 'claims', card: 'decisions' },
  failed: { tab: 'progress', focus: 'failed', card: 'in-progress' },
  'integrity-errors': { tab: 'actions', focus: 'errors', card: 'decisions' },
  'integrity-warnings': { tab: 'health', focus: 'warnings', card: 'warnings' },
};
