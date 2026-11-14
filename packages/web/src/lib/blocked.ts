/**
 * Actions › Blocked: the Overview's blocked items regrouped by what blocks them (start with the blocker that unblocks
 * the most) or by the spec that waits. Pure functions so the grouping is testable without rendering.
 */
import type { OverviewBlocked, OverviewBlocker } from '@mandate/shared';

export type BlockedGrouping = 'blocker' | 'spec';

export interface BlockerGroup {
  /** null: items waiting on a dependency that is missing or archived (no listed blocker). */
  blocker: OverviewBlocker | null;
  /** Items waiting on it directly. */
  waiting: OverviewBlocked[];
  /** Items unblocked once it is done: direct plus everything waiting on those (transitively, listed items only). */
  unblocks: number;
  /** The blocker is itself a blocked item (listed): what it waits on. */
  itself?: OverviewBlocked;
}

/** Group by blocker, the one that unblocks the most first (then most direct, then title). */
export function groupByBlocker(items: OverviewBlocked[]): BlockerGroup[] {
  const byUri = new Map(items.map((b) => [b.uri, b]));
  const groups = new Map<string, { blocker: OverviewBlocker; waiting: OverviewBlocked[] }>();
  const orphans: OverviewBlocked[] = [];
  for (const b of items) {
    if (!b.blockedBy.length) orphans.push(b);
    for (const x of b.blockedBy) {
      const g = groups.get(x.uri) ?? { blocker: x, waiting: [] };
      if (!g.waiting.some((w) => w.uri === b.uri)) g.waiting.push(b);
      groups.set(x.uri, g);
    }
  }
  const unblocks = (uri: string): number => {
    const seen = new Set<string>();
    const queue = [uri];
    while (queue.length) {
      const u = queue.shift()!;
      for (const w of groups.get(u)?.waiting ?? []) {
        if (seen.has(w.uri) || w.uri === uri) continue;
        seen.add(w.uri);
        queue.push(w.uri);
      }
    }
    return seen.size;
  };
  const out: BlockerGroup[] = [...groups.entries()].map(([uri, g]) => {
    const itself = byUri.get(uri);
    return { blocker: g.blocker, waiting: g.waiting, unblocks: unblocks(uri), ...(itself ? { itself } : {}) };
  });
  out.sort((a, b) => b.unblocks - a.unblocks || b.waiting.length - a.waiting.length || a.blocker!.title.localeCompare(b.blocker!.title));
  if (orphans.length) out.push({ blocker: null, waiting: orphans, unblocks: orphans.length });
  return out;
}

export interface SpecGroup {
  specId: string;
  specTitle: string;
  /** Blocked sections and work orders of the spec, sections first. */
  items: OverviewBlocked[];
  /** Blocked sections (not work orders). */
  sections: number;
}

/** Group by the spec that waits, the spec with most blocked items first (then title). */
export function groupBySpec(items: OverviewBlocked[]): SpecGroup[] {
  const groups = new Map<string, SpecGroup>();
  for (const b of items) {
    const g = groups.get(b.specId) ?? { specId: b.specId, specTitle: b.specTitle ?? b.specId, items: [], sections: 0 };
    g.items.push(b);
    if (b.kind === 'section') g.sections++;
    groups.set(b.specId, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'section' ? -1 : 1));
  return out.sort((a, b) => b.items.length - a.items.length || a.specTitle.localeCompare(b.specTitle));
}

const KEY = 'mandate.actions.blockedGrouping';

/** The remembered grouping (default: by blocker). Storage can be unavailable (private mode, blocked site data). */
export function readGrouping(): BlockedGrouping {
  try {
    return window.localStorage.getItem(KEY) === 'spec' ? 'spec' : 'blocker';
  } catch {
    return 'blocker';
  }
}

export function writeGrouping(g: BlockedGrouping): void {
  try {
    window.localStorage.setItem(KEY, g);
  } catch {
    /* not remembered */
  }
}
