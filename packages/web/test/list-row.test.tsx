// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contributor, Feedback } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { ChipList, fitChips, ListRow, RowTime } from '../src/components/list/ListRow';
import { RowPeople, withFirst } from '../src/components/people/People';
import { FeedbackOutcome } from '../src/components/FeedbackParts';
import { compactTime } from '../src/lib/time';

installDom();
let contributors: Record<string, Contributor[]> = {};
/** Refs whose `contributors` call never answers (a busy server). */
const HANG = 'mandate://specs/slow-spec';
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { refs?: string[]; logins?: string[] }) => {
    if (name === 'contributors' && args.refs?.includes('mandate://specs/slow-spec')) return new Promise(() => undefined);
    if (name === 'contributors') return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, contributors[r] ?? []])) };
    if (name === 'users_resolve') return { users: [] };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  contributors = {};
});

const status = (_where: 'computer' | 'server'): AuthStatus => ({ authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login' });
const wrap = (mode: 'computer' | 'server', ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={status(mode)}>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );
const c = (user: string, o: Partial<Contributor> = {}): Contributor => ({ user, userRecorded: true, kind: 'direct', roles: ['edited'], count: 1, lastAt: new Date().toISOString(), agents: ['claude-code'], ...o });

describe('ListRow slots', () => {
  it('lays out lead, id, main, copy, chips, columns, people and time in order, with fixed widths', () => {
    wrap(
      'server',
      <ListRow
        to="/requests/fb-1"
        list="feedback"
        lead={<span>L</span>}
        leadWidth={36}
        id="fb-1"
        idWidth={84}
        title="A title"
        excerpt="an excerpt"
        chips={[{ key: 'a', node: <span>alpha</span> }]}
        chipsWidth={300}
        cols={[
          { key: 'issues', width: 72, hide: 'xl', node: null },
          { key: 'outcome', width: 104, node: <span>done</span> },
        ]}
        people={<span>P</span>}
        time={<span>T</span>}
        timeWidth={96}
      />,
    );
    const row = screen.getByRole('link');
    expect(row.getAttribute('data-list')).toBe('feedback');
    const cols = [...row.children].map((e) => (e as HTMLElement).dataset.col);
    expect(cols).toEqual(['lead', 'id', 'main', 'copy', 'chips', 'issues', 'outcome', 'people', 'time']);
    const byCol = (k: string) => row.querySelector(`[data-col="${k}"]`) as HTMLElement;
    expect(byCol('id').style.width).toBe('84px');
    expect(byCol('outcome').style.width).toBe('104px');
    expect(byCol('time').style.width).toBe('96px');
    expect(byCol('issues').dataset.hide).toBe('xl');
    // Empty columns keep their slot (alignment).
    expect(byCol('issues')).toBeTruthy();
    expect(within(byCol('main')).getByText('an excerpt')).toBeTruthy();
  });

  it('chips: whole chips only, "+N" with the rest; the cap applies without layout', () => {
    expect(fitChips([60, 60, 60], 200)).toBe(3); // 60+4+60+4+60 = 188: all three
    expect(fitChips([80, 80, 80], 200)).toBe(2); // 80+4+80 + 4+30 ("+1") = 198
    expect(fitChips([80, 80, 80], 160)).toBe(1);
    expect(fitChips([300], 100)).toBe(0);
    expect(fitChips([10, 10, 10, 10], 1000, 2)).toBe(2);
    wrap('server', <ChipList items={['a', 'b', 'c', 'd'].map((k) => ({ key: k, node: <span className="tag-pill">{k}</span> }))} max={2} />);
    const list = screen.getByTestId('chip-list');
    expect([...list.querySelectorAll(':scope > .lr-chip')].map((e) => e.textContent)).toEqual(['a', 'b']);
    expect(screen.getByTestId('chips-more').textContent).toBe('+2');
  });

  it('time: compact relative text, full date in the tooltip label', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(compactTime('2026-11-11T18:00:00Z', now)).toBe('18h ago');
    expect(compactTime('2026-11-12T11:55:00Z', now)).toBe('5m ago');
    expect(compactTime('2026-11-12T11:59:40Z', now)).toBe('now');
    expect(compactTime('2026-08-01T00:00:00Z', now)).toBe('3mo ago');
    wrap('server', <RowTime iso={new Date(Date.now() - 18 * 3600e3 - 60e3).toISOString()} prefix="closed" />);
    expect(screen.getByText('closed 18h ago')).toBeTruthy();
  });
});

describe('people column: never empty', () => {
  const REF = 'mandate://feedback/fb-0001';
  it('team, legacy item (no contributors, no user): the agent avatar with a dashed ring', async () => {
    wrap('server', <RowPeople refUri={REF} fallback={{ agent: 'claude-code', verb: 'Filed' }} />);
    const a = await screen.findByTestId('agent-avatar');
    expect(a.getAttribute('data-legacy')).toBe('true');
    expect(a.getAttribute('data-agent')).toBe('claude-code');
    expect(a.textContent).toContain('CC');
  });
  it('team, agent-only contributors (userRecorded: false): agent faces in the stack', async () => {
    contributors[REF] = [c('codex', { userRecorded: false })];
    wrap('server', <RowPeople refUri={REF} fallback={{ agent: 'claude-code' }} />);
    const stack = await screen.findByTestId('avatar-stack');
    expect(within(stack).getByTestId('agent-avatar').getAttribute('data-agent')).toBe('codex');
  });
  it('an older agent-only item shows the agent avatar (no user recorded)', async () => {
    wrap('computer', <RowPeople refUri={REF} fallback={{ agent: 'claude-code' }} />);
    const a = await screen.findByTestId('agent-avatar');
    expect(a.getAttribute('data-legacy')).toBe('true');
  });
  it('the recorded user shows while contributors are still loading (slow index)', async () => {
    wrap('server', <RowPeople refUri={HANG} fallback={{ user: 'snork-alt', agent: 'claude-code', verb: 'Created' }} />);
    await waitFor(() => expect(screen.getByTestId('row-people').querySelector('[data-user="snork-alt"]')).toBeTruthy());
    expect(screen.queryByTestId('agent-avatar')).toBeNull();
    // Let the (hanging) batched call go out on its own so it does not swallow the next test's refs.
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.getByTestId('row-people').querySelector('[data-user="snork-alt"]')).toBeTruthy();
  });
  it('feedback: the filer leads the stack', async () => {
    contributors[REF] = [c('bob'), c('alice')];
    expect(withFirst(contributors[REF]!, { user: 'alice' }).map((x) => x.user)).toEqual(['alice', 'bob']);
    expect(withFirst([c('bob')], { user: 'carol', agent: 'codex' }).map((x) => x.user)).toEqual(['carol', 'bob']);
    wrap('server', <RowPeople refUri={REF} first fallback={{ user: 'alice', agent: 'claude-code' }} />);
    const stack = await screen.findByTestId('avatar-stack');
    await waitFor(() => expect([...stack.querySelectorAll('[data-user]')].map((e) => e.getAttribute('data-user'))[0]).toBe('alice'));
  });
});

describe('feedback outcome column', () => {
  const f = (o: Partial<Feedback>) => ({ status: 'open', changes: [], ...o }) as unknown as Feedback;
  const text = (ui: React.ReactNode) => {
    const r = wrap('server', ui);
    const t = r.container.querySelector('[data-testid=fb-outcome]')?.textContent ?? '';
    cleanup();
    return t;
  };
  it('renders applied / rejected / duplicate / open work order', () => {
    const ch = { action: 'modified' } as Feedback['changes'][number];
    expect(text(<FeedbackOutcome f={f({ status: 'closed', resolution: 'applied', changes: [ch, ch, ch] })} />)).toBe('✓3 changes');
    expect(text(<FeedbackOutcome f={f({ status: 'closed', resolution: 'rejected', resolutionNote: 'no' })} />)).toBe('✕rejected');
    expect(text(<FeedbackOutcome f={f({ status: 'closed', resolution: 'duplicate', duplicateOf: 'fb-0002' })} />)).toBe('⧉duplicate');
    expect(text(<FeedbackOutcome f={f({ status: 'accepted' })} workOrder={{ id: 'q-0007', status: 'in_progress' }} />)).toBe('→q-0007');
    expect(text(<FeedbackOutcome f={f({ status: 'open' })} />)).toBe('');
  });
});
