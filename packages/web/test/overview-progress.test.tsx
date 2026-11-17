// @vitest-environment jsdom
/** Overview "In progress" tab: agents-today lanes, work grouped by spec (plan step), stuck items with Release, recently completed, specs moving; pure helpers. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRef, planProgress, type ProjectOverview, type SpecMaturity } from '@mandate/shared';
import { installDom } from './dom';
import { OverviewPage } from '../src/pages/OverviewPage';
import { buildTimeline, duration, groupBySpec, specsMoving } from '../src/lib/progress';
import type { ActivityEvent } from '../src/components/activity/types';

installDom();

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const mat = (step: SpecMaturity['step'], implemented: number, total: number, inProgress = 1): SpecMaturity => ({
  step,
  stepIndex: ['draft', 'specified', 'in_progress', 'implemented', 'verified', 'audited'].indexOf(step) + 1,
  label: step === 'in_progress' ? `In progress · ${implemented}/${total}` : step,
  tone: 'lilac',
  sections: { implemented, total, inProgress },
  criteria: { total: 0, verified: 0, waived: 0, failing: 0, stale: 0, unverified: 0 },
  audit: null,
  overlays: [],
  storedStatus: 'active',
});
const steps0 = { draft: 0, specified: 0, in_progress: 2, implemented: 0, verified: 0, audited: 0 };
const wo = (id: string, spec: string, specTitle: string, extra: Partial<ProjectOverview['inProgress'][number]> = {}): ProjectOverview['inProgress'][number] => ({
  id,
  title: `Work ${id}`,
  spec,
  specTitle,
  kind: 'implement',
  status: 'in_progress',
  sections: { done: 1, total: 3 },
  claim: { agent: 'claude-code@mbp', branch: `feat/${id}`, startedAt: ago(90), heartbeatAt: ago(1), stale: false },
  git: [],
  hasPlan: true,
  plan: { total: 5, done: 2, current: { index: 3, text: 'Write the coupon validation tests' } },
  updatedAt: ago(1),
  ...extra,
});
const overview = (): ProjectOverview => ({
  head: null,
  at: new Date(NOW).toISOString(),
  maturity: { total: 3, archived: 0, steps: { ...steps0, implemented: 1 }, overlays: { failing: 0, drifted: 0, blocked: 1, stale: 0 } },
  attention: { failing: 0, drifted: 0, blocked: 1, stale: 0, mustFindings: 0, staleClaims: 1, failedWorkOrders: 0, integrityErrors: 0, integrityWarnings: 0, integritySnoozed: 0, specs: [] },
  inProgress: [
    wo('wo-118', 'coupons', 'Checkout coupons'),
    wo('wo-120', 'coupons', 'Checkout coupons', { kind: 'fix', title: 'Coupon rounding', plan: { total: 3 } }),
    wo('wo-099', 'webhooks', 'Stripe webhooks', { title: 'Retry webhooks', claim: { agent: 'codex@ci', startedAt: ago(26 * 60), heartbeatAt: ago(21 * 60), stale: true } }),
  ],
  inProgressTotal: 3,
  queued: 12,
  progressSpecs: [
    { id: 'coupons', title: 'Checkout coupons', maturity: mat('in_progress', 3, 7) },
    { id: 'webhooks', title: 'Stripe webhooks', maturity: mat('in_progress', 1, 4) },
  ],
  sessions: [
    { workOrder: 'wo-109', kind: 'review', title: 'Review', agent: 'claude-code@ci', startedAt: ago(300), endedAt: ago(200), ended: 'completed' },
    { workOrder: 'wo-118', kind: 'implement', title: 'Work wo-118', agent: 'claude-code@mbp', startedAt: ago(90), heartbeatAt: ago(1), stale: false },
  ],
  recentlyCompleted: [{ id: 'wo-115', title: 'Refund emails show the right currency', kind: 'implement', spec: 'refunds', specTitle: 'Refund emails', agent: 'codex@sofia', startedAt: ago(110), completedAt: ago(40) }],
  blocked: [{ kind: 'work_order', uri: buildRef({ kind: 'work-orders', id: 'wo-126' }), id: 'wo-126', title: 'Refund to store credit', specId: 'refunds', specTitle: 'Refund emails', blockedBy: [{ uri: buildRef({ kind: 'work-orders', id: 'wo-118' }), state: 'work_order', title: 'Apply a coupon', workOrder: { id: 'wo-118', status: 'in_progress' } }] }],
  blockedTotal: 1,
  mustFindingSpecs: [],
  byCategory: [{ category: 'checkout', total: 3, steps: { ...steps0, implemented: 1 }, specs: [{ id: 'coupons', title: 'Checkout coupons', step: 'in_progress' }, { id: 'webhooks', title: 'Stripe webhooks', step: 'in_progress' }, { id: 'refunds', title: 'Refund emails', step: 'implemented' }] }],
  neverAudited: [],
  unverified: [],
  gaps: [],
  warningGroups: [],
  warnings: [],
  coverage: { criteria: { total: 0, verified: 0, waived: 0, failing: 0, stale: 0, unverified: 0 }, sections: { implemented: 4, total: 11 }, audits: { total: 0, never: 0, stale: 0, recent: 0 }, lineage: null },
});
const moveEvent: ActivityEvent = { id: 'e1', commit: 'e1', type: 'work_order.completed', at: ago(40), agent: 'codex@sofia', summary: 'codex@sofia completed wo-115', refs: [buildRef({ kind: 'work-orders', id: 'wo-115' }), buildRef({ kind: 'specs', id: 'refunds' })], details: { kind: 'implement' } } as ActivityEvent;

let data = overview();
const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'project_overview') return data;
    if (name === 'activity_list') return { events: (args.types as string[]).includes('work_order.claimed') ? [moveEvent] : [], total: 0, nextCursor: null, head: null };
    if (name === 'decision_access') return { canDecide: true, mode: 'server', user: 'ada' };
    return {};
  }),
  callRootTool: vi.fn(async () => ({ items: [{ id: 'default', name: 'Checkout' }] })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

function R() {
  return (
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}
beforeEach(() => {
  data = overview();
  calls.length = 0;
  localStorage.clear();
});
afterEach(cleanup);

describe('progress helpers', () => {
  it('planProgress: checkbox steps give the current step; plain lists only a count; no list → null', () => {
    expect(planProgress('Intro\n\n- [x] Read\n- [ ] **Write** tests\n  - [ ] nested\n- [ ] Ship')).toEqual({ total: 3, done: 1, current: { index: 2, text: 'Write tests' } });
    expect(planProgress('1. One\n2. Two')).toEqual({ total: 2 });
    expect(planProgress('- [x] a\n- [X] b')).toEqual({ total: 2, done: 2 });
    expect(planProgress('```\n- [ ] code\n```\nJust prose.')).toBeNull();
  });
  it('groupBySpec keeps first-appearance order and attaches maturity', () => {
    const g = groupBySpec(overview());
    expect(g.map((x) => [x.id, x.items.length])).toEqual([['coupons', 2], ['webhooks', 1]]);
    expect(g[0]!.maturity?.sections.total).toBe(7);
  });
  it('buildTimeline: one lane per agent, states, live / stale counts', () => {
    const t = buildTimeline(overview().sessions!, NOW);
    expect(new Set(t.lanes.map((l) => l.agent)).size).toBe(t.lanes.length);
    const live = t.lanes.find((l) => l.agent === 'claude-code@mbp')!;
    expect(live.bars[0]).toMatchObject({ workOrder: 'wo-118', state: 'live', end: NOW });
    expect(t.live).toBe(1);
    expect(t.from).toBeLessThan(t.to);
    const st = buildTimeline([{ workOrder: 'x', kind: 'fix', title: 'x', agent: 'a', startedAt: ago(30), heartbeatAt: ago(20), stale: true }], NOW);
    expect(st.stale).toBe(1);
    expect(st.lanes[0]!.bars[0]!.state).toBe('stale');
  });
  it('duration and specsMoving (only when the spec is at the step the event moves it to)', () => {
    expect(duration(70 * 60_000)).toBe('1h 10m');
    expect(duration(40 * 60_000)).toBe('40m');
    const steps = new Map([['refunds', { title: 'Refund emails', step: 'implemented' as const }]]);
    expect(specsMoving([moveEvent], steps)).toMatchObject([{ id: 'refunds', from: 'in_progress', to: 'implemented' }]);
    expect(specsMoving([moveEvent], new Map([['refunds', { title: 'R', step: 'in_progress' as const }]]))).toEqual([]);
  });
});

describe('In progress tab', () => {
  it('timeline lanes, work grouped by spec with plan step, stuck list, recently completed and specs moving', async () => {
    render(<R />);
    const today = await screen.findByTestId('ov-agents-today');
    expect(within(today).getAllByTestId('pg-lane').length).toBeGreaterThanOrEqual(1);
    expect(within(today).getByText('claude-code@mbp')).toBeTruthy();
    expect(within(today).getAllByTestId('pg-bar').some((b) => b.textContent === 'wo-118')).toBe(true);

    const groups = screen.getAllByTestId('pg-spec-group');
    expect(groups.map((g) => g.querySelector('.pg-group-title')?.textContent)).toEqual(['Checkout coupons', 'Stripe webhooks']);
    expect(within(groups[0]!).getAllByTestId('pg-wo')).toHaveLength(2);
    expect(within(groups[0]!).getByText('3/7 sections done')).toBeTruthy();
    expect(within(groups[0]!).getByText('Write the coupon validation tests')).toBeTruthy();
    expect(within(groups[0]!).getByText('Plan · 3 steps')).toBeTruthy();
    expect(groups[0]!.textContent).toContain('feat/wo-118');
    // The stale claim row is flagged and offers Release claim.
    const stale = within(groups[1]!).getByTestId('pg-wo');
    expect(stale.getAttribute('data-stale')).toBe('true');
    expect(within(stale).getByTestId('item-primary').textContent).toContain('Release claim');
    expect(screen.getByText('12 more work orders waiting for an agent')).toBeTruthy();

    const stuck = screen.getByTestId('ov-stuck');
    expect(within(stuck).getByTestId('pg-stuck-claim').textContent).toContain('wo-099 has a stale claim');
    expect(within(stuck).getByTestId('pg-stuck-blocked').textContent).toContain('waits on wo-118 Apply a coupon');

    const done = screen.getByTestId('ov-completed');
    expect(within(done).getByTestId('pg-completed').textContent).toContain('Refund emails show the right currency');
    expect(within(done).getByTestId('pg-duration').textContent).toContain('1h 10m');

    const moving = screen.getByTestId('ov-moving');
    expect((await within(moving).findByTestId('pg-move')).textContent).toContain('Refund emails');
    expect(screen.getByTestId('ov-recent')).toBeTruthy();
  });

  it('an all-sections-done work order shows Waiting for completion, no stale flag, no Release and is not stuck', async () => {
    data.inProgress[2] = { ...data.inProgress[2]!, sections: { done: 3, total: 3 } };
    data.attention.staleClaims = 0;
    render(<R />);
    const stuck = await screen.findByTestId('ov-stuck');
    expect(within(stuck).queryByTestId('pg-stuck-claim')).toBeNull();
    const row = screen.getAllByTestId('pg-wo').find((e) => e.textContent?.includes('wo-099'))!;
    expect(within(row).getByTestId('pg-waiting-completion').textContent).toContain('Waiting for completion');
    expect(within(row).queryByText('Release claim')).toBeNull();
    expect(within(row).queryByTestId('item-primary')).toBeNull();
  });

  it('Release from the Stuck list records it through work_order_release', async () => {
    render(<R />);
    const stuck = await screen.findByTestId('ov-stuck');
    fireEvent.click(within(within(stuck).getByTestId('pg-stuck-claim')).getByTestId('item-primary'));
    fireEvent.click(await screen.findByTestId('decision-confirm'));
    await waitFor(() => expect(calls.some((c) => c.name === 'work_order_release' && c.args.ref === buildRef({ kind: 'work-orders', id: 'wo-099' }))).toBe(true));
  });

  it('empty: no work, no lanes, nothing stuck', async () => {
    data = { ...overview(), inProgress: [], inProgressTotal: 0, queued: 0, sessions: [], recentlyCompleted: [], blocked: [], blockedTotal: 0, progressSpecs: [] };
    render(<R />);
    expect(await screen.findByText('No agent is working right now')).toBeTruthy();
    expect(screen.getByText('No agent has held a work order today.')).toBeTruthy();
    expect(screen.getByText('Nothing is stuck')).toBeTruthy();
    expect(screen.getByText('No work order completed this week')).toBeTruthy();
  });
});
