// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRef, type OverviewBlocked, type OverviewBlocker } from '@mandate/shared';
import { groupByBlocker, groupBySpec, readGrouping, writeGrouping } from '../src/lib/blocked';

const sec = (spec: string, id: string) => buildRef({ kind: 'specs', id: spec, sectionId: id });
const blocker = (uri: string, title: string): OverviewBlocker => ({ uri, state: 'not_implemented', title });
const item = (spec: string, id: string, by: OverviewBlocker[], kind: OverviewBlocked['kind'] = 'section'): OverviewBlocked => ({ kind, uri: kind === 'section' ? sec(spec, id) : buildRef({ kind: 'work-orders', id }), id: kind === 'section' ? spec : id, title: id, specId: spec, specTitle: spec.toUpperCase(), blockedBy: by });

// gateway ← route (itself blocked) ← lookups, submission; gateway ← corridor-run; key ← eligibility
const GW = blocker(sec('partner', 'gateway'), 'Gateway timeouts');
const ROUTE = blocker(sec('corridor', 'route'), 'Route eligibility');
const KEY = blocker(sec('idem', 'key'), 'Mutating routes require the key');
const items = [
  item('corridor', 'run', [GW]),
  item('corridor', 'route', [GW]),
  item('payout', 'lookups', [ROUTE]),
  item('transfer', 'submission', [ROUTE]),
  item('app', 'eligibility', [KEY]),
  item('legal', 'orphan', []),
];

describe('Blocked grouping', () => {
  it('by blocker: transitive unblock counts, most unblocked first, itself-blocked blockers, orphans last', () => {
    const g = groupByBlocker(items);
    expect(g.map((x) => x.blocker?.title ?? null)).toEqual(['Gateway timeouts', 'Route eligibility', 'Mutating routes require the key', null]);
    expect(g[0]).toMatchObject({ unblocks: 4 });
    expect(g[0]!.waiting.map((w) => w.title)).toEqual(['run', 'route']);
    expect(g[0]!.itself).toBeUndefined();
    expect(g[1]).toMatchObject({ unblocks: 2 });
    expect(g[1]!.itself?.title).toBe('route');
    expect(g[2]!.unblocks).toBe(1);
    expect(g[3]!.waiting.map((w) => w.title)).toEqual(['orphan']);
  });

  it('by blocker: an item waiting on two blockers is listed under both; cycles terminate', () => {
    const a = blocker(sec('x', 'a'), 'A');
    const b = blocker(sec('x', 'b'), 'B');
    const g = groupByBlocker([item('x', 'a', [b]), item('x', 'b', [a]), item('y', 'c', [a, b])]);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.unblocks === 2)).toBe(true);
    expect(g.every((x) => x.waiting.some((w) => w.title === 'c'))).toBe(true);
  });

  it('by spec: one group per waiting spec, sections before work orders, section counts', () => {
    const g = groupBySpec([...items, item('corridor', 'wo-1', [GW], 'work_order')]);
    expect(g[0]).toMatchObject({ specId: 'corridor', specTitle: 'CORRIDOR', sections: 2 });
    expect(g[0]!.items.map((b) => b.kind)).toEqual(['section', 'section', 'work_order']);
    expect(g.map((x) => x.specId).slice(1)).toEqual(['app', 'legal', 'payout', 'transfer']);
  });

  describe('remembered choice', () => {
    afterEach(() => vi.restoreAllMocks());
    it('defaults to blocker, remembers spec, survives unavailable storage', () => {
      window.localStorage.clear();
      expect(readGrouping()).toBe('blocker');
      writeGrouping('spec');
      expect(readGrouping()).toBe('spec');
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(readGrouping()).toBe('blocker');
      expect(() => writeGrouping('spec')).not.toThrow();
    });
  });
});
