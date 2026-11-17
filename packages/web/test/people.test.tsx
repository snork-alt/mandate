// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRef, type Contributor, type WorkProgress } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { AvatarStack, Contributors, UserAvatar, UserFilterContext } from '../src/components/people/People';
import { WorkProgressLine } from '../src/components/lineage/WorkProgress';
import { ChangingList } from '../src/pages/LineagePage';
import { contributorsLabel, labelText, namesPhrase } from '../src/lib/people';

installDom();
const FB = buildRef({ kind: 'feedback', id: 'fb-0007' });
const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const calls: { name: string; args: unknown }[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { logins?: string[]; refs?: string[] }) => {
    calls.push({ name, args });
    if (name === 'users_resolve') return { users: (args.logins ?? []).filter((l) => l !== 'noimg').map((l) => ({ login: l, name: `${l[0]!.toUpperCase()}${l.slice(1)} Doe`, avatarUrl: `https://avatars.example/${l}`, known: true, service: false })) };
    if (name === 'contributors') return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, [c('carol', 'direct'), c('alice', 'via')]])) };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  calls.length = 0;
});

const status = (_where: 'computer' | 'server'): AuthStatus => ({ authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login' });
const wrap = (mode: 'computer' | 'server', ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <AuthContext.Provider value={status(mode)}>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );
const cause = { uri: FB, kind: 'feedback' as const, label: 'Rotate tokens' };
function c(user: string, kind: 'direct' | 'via', o: Partial<Contributor> = {}): Contributor {
  return { user, userRecorded: true, kind, roles: [kind === 'direct' ? 'edited' : 'created'], count: 2, lastAt: new Date(Date.now() - 36e5).toISOString(), agents: ['claude-code'], ...(kind === 'via' ? { via: [cause] } : {}), ...o };
}

describe('phrasing (pure)', () => {
  it('names like GitHub', () => {
    expect(namesPhrase(['alice'])).toBe('alice');
    expect(namesPhrase(['alice', 'bob'])).toBe('alice and bob');
    expect(namesPhrase(['alice', 'bob', 'carol'])).toBe('alice, bob and carol');
    expect(namesPhrase(['alice', 'bob', 'carol', 'dave', 'erin'])).toBe('alice, bob and 3 others');
  });
  it('full and compact labels', () => {
    expect(labelText(contributorsLabel([c('alice', 'direct'), c('bob', 'direct')], 'full'))).toBe('alice and bob contributed');
    expect(labelText(contributorsLabel(['alice', 'bob', 'x', 'y', 'z'].map((u) => c(u, 'direct')), 'full'))).toBe('alice, bob and 3 others contributed');
    expect(labelText(contributorsLabel([c('carol', 'direct'), c('alice', 'via'), c('bob', 'via')], 'full'))).toBe('carol edited · alice and bob via fb-0007');
    expect(labelText(contributorsLabel([c('carol', 'direct'), c('alice', 'via'), c('bob', 'via')], 'compact'))).toBe('carol + 2 via feedback');
    expect(labelText(contributorsLabel([c('carol', 'direct'), c('dave', 'direct')], 'compact'))).toBe('carol + 1');
    expect(labelText(contributorsLabel([c('alice', 'via')], 'compact'))).toBe('1 via feedback');
    // Logins and the cause are separate parts (bold filter links, cause link).
    const parts = contributorsLabel([c('carol', 'direct'), c('alice', 'via')], 'full');
    expect(parts.filter((p) => p.user).map((p) => p.user)).toEqual(['carol', 'alice']);
    expect(parts.find((p) => p.cause)!.cause).toBe(FB);
  });
});

describe('UserAvatar', () => {
  it('directory image, initials fallback, service badge, styled hover card (no title=)', async () => {
    wrap('server', (
      <>
        <UserAvatar user="alice" agent="claude-code" at={new Date().toISOString()} />
        <UserAvatar user="noimg" />
        <UserAvatar user="service:ci" />
      </>
    ));
    await waitFor(() => expect(screen.getAllByTestId('avatar-img')).toHaveLength(1));
    expect(screen.getByTestId('avatar-img').getAttribute('src')).toBe('https://avatars.example/alice');
    expect(screen.getByTestId('avatar-img').getAttribute('loading')).toBe('lazy');
    expect(screen.getByTestId('avatar-initials').textContent).toBe('NO');
    expect(screen.getByTestId('service-badge').textContent).toBe('service');
    expect(document.querySelector('[title]')).toBeNull();
    // One batched users_resolve call for all logins.
    expect(calls.filter((x) => x.name === 'users_resolve')).toHaveLength(1);
    fireEvent.mouseEnter(screen.getByTestId('avatar-img').closest('.pp-slot')!);
    const card = await screen.findByTestId('user-card');
    expect(card.textContent).toContain('alice');
    expect(card.textContent).toContain('Alice Doe');
    expect(card.textContent).toContain('via claude-code');
  });
  it('a broken image falls back to initials', async () => {
    wrap('server', <UserAvatar user="alice" />);
    const img = await screen.findByTestId('avatar-img');
    fireEvent.error(img);
    expect(screen.getByTestId('avatar-initials').textContent).toBe('AL');
  });
  it('clicking an avatar filters the view by that user', () => {
    const filter = vi.fn();
    wrap('server', (
      <UserFilterContext.Provider value={filter}>
        <UserAvatar user="bob" hover={false} />
      </UserFilterContext.Provider>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Filter by bob' }));
    expect(filter).toHaveBeenCalledWith('bob');
  });
});

describe('AvatarStack', () => {
  it('direct first, a divider, faded "via", "+N" and the label', () => {
    const cs = [c('carol', 'direct'), c('dave', 'direct'), c('alice', 'via'), c('bob', 'via'), c('erin', 'via')];
    wrap('server', <AvatarStack contributors={cs} max={4} form="full" />);
    const stack = screen.getByTestId('avatar-stack');
    expect(Array.from(stack.querySelectorAll('.pp-stack-item')).map((x) => x.getAttribute('data-kind'))).toEqual(['direct', 'direct', 'via', 'via']);
    expect(stack.querySelectorAll('.pp-divider')).toHaveLength(1);
    expect(screen.getByTestId('avatar-more').textContent).toBe('+1');
    expect(screen.getByTestId('contributors-label').textContent).toBe('carol and dave edited · alice, bob and erin via fb-0007');
  });
  it('hover card groups "Edited by" and "Contributed via <cause>"; a user who is both notes "also via"', async () => {
    const cs = [c('carol', 'direct', { alsoVia: [cause] }), c('alice', 'via')];
    wrap('server', <AvatarStack contributors={cs} />);
    fireEvent.mouseEnter(screen.getByTestId('avatar-stack'));
    const list = await screen.findByTestId('contributors-list');
    const heads = Array.from(list.querySelectorAll('.pp-list-head')).map((h) => h.textContent);
    expect(heads).toEqual(['Edited by', 'Contributed via Rotate tokens']);
    expect(within(list).getByText('Rotate tokens').closest('a')!.getAttribute('href')).toBe('/requests/fb-0007');
    expect(list.textContent).toContain('also via fb-0007');
  });
  it('fetches contributors in one batched call', async () => {
    wrap('server', (
      <>
        <Contributors refUri={SPEC} form="compact" />
        <Contributors refUri={buildRef({ kind: 'specs', id: 'billing' })} form="compact" />
      </>
    ));
    await waitFor(() => expect(screen.getAllByTestId('avatar-stack')).toHaveLength(2));
    expect(calls.filter((x) => x.name === 'contributors')).toHaveLength(1);
    expect(screen.getAllByTestId('contributors-label')[0]!.textContent).toBe('carol + 1 via feedback');
  });
});

describe('Changing: progress and PR links', () => {
  const work: WorkProgress = { sectionsDone: 1, sectionsTotal: 2, claimedBy: 'claude-code', branch: 'wo/login-fix', prs: [{ repo: 'app', number: 412, url: 'https://github.com/acme/app/pull/412', status: 'open' }, { repo: 'app', number: 7 }] };
  it('progress, claim, branch and PRs that link out', () => {
    wrap('computer', <WorkProgressLine work={work} />);
    const line = screen.getByTestId('work-progress');
    expect(line.textContent).toContain('1/2 sections');
    expect(line.textContent).toContain('claude-code');
    expect(line.textContent).toContain('wo/login-fix');
    const links = screen.getAllByTestId('pr-link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://github.com/acme/app/pull/412');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(line.textContent).toContain('app#7');
  });
  it('the Changing list shows each in-progress item with its work', () => {
    wrap('computer', <ChangingList items={[{ uri: buildRef({ kind: 'work-orders', id: 'wo-1' }), label: 'Fix login', progress: '1/2 sections', work }]} />);
    const list = screen.getByTestId('changing-list');
    expect(list.textContent).toContain('Fix login');
    expect(list.textContent).toContain('1/2 sections');
    expect(within(list).getByTestId('pr-link').getAttribute('href')).toContain('/pull/412');
  });
});

describe('co-authored history', () => {
  it('the history rail shows "co-authored by" when recorded (team writes)', async () => {
    const { HistoryTimeline } = await import('../src/components/doc/HistoryTimeline');
    const e = { commit: 'a'.repeat(40), subject: 'update rule', body: '', author: 'm', email: 'm@x', date: new Date().toISOString(), trailers: {}, agent: 'claude-code', user: 'carol', coAuthors: ['alice', 'bob'] };
    wrap('server', <HistoryTimeline entries={[e]} now={Date.now()} />);
    const co = screen.getByTestId('co-authors');
    expect(co.textContent).toContain('co-authored by');
    expect(co.textContent).toContain('alice');
    expect(co.textContent).toContain('bob');
  });
});
