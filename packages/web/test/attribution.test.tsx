// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry, WritersResponse } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { ByLine, DocAttribution } from '../src/components/attribution/Attribution';
import { HistoryTimeline } from '../src/components/doc/HistoryTimeline';
import { ActivityPanel } from '../src/components/activity/ActivityPanel';
import { WritersTable } from '../src/setup/WritersSection';
import type { ActivityEvent } from '../src/components/activity/types';

installDom();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { logins?: string[] }) =>
    name === 'users_resolve' ? { users: (args.logins ?? []).map((l) => ({ login: l, name: l === 'octocat' ? 'The Octocat' : null, avatarUrl: `https://avatars.example/${l}`, known: true, service: false })) } : {},
  ),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(cleanup);
const txt = (e: Element) => {
  const c = e.cloneNode(true) as Element;
  c.querySelectorAll('.pp-initials').forEach((x) => x.remove());
  return c.textContent!.replace(/\s+/g, ' ').trim();
};

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

const now = Date.now();
const ago = (h: number) => new Date(now - h * 36e5).toISOString();
const entry = (commit: string, user: string | undefined, agent: string, subject: string): HistoryEntry => ({ commit: commit.repeat(40).slice(0, 40), subject, body: '', author: 'mandate', email: 'm@x', date: ago(1), trailers: {}, agent, ...(user ? { user } : {}) });
const entries = [entry('a', 'octocat', 'claude-code', 'Rotate tokens'), entry('b', 'hubot', 'codex', 'Add SSO'), entry('c', 'service:ci', 'ci-bot', 'Nightly audit')];
const doc = { createdAt: ago(48), updatedAt: ago(2), updatedBy: 'codex', createdBy: { user: 'octocat', agent: 'claude-code', at: ago(48), commit: 'c1' }, lastEditedBy: { user: 'hubot', agent: 'codex', at: ago(2), commit: 'c2' } };

describe('attribution: without a known auth status', () => {
  it('users are hidden', () => {
    render(<MantineProvider><ByLine a={{ user: 'octocat', agent: 'claude-code' }} /></MantineProvider>);
    expect(txt(screen.getByTestId('attr-by'))).toBe('via claude-code');
  });
});

describe('attribution', () => {
  it('object pages: "Created by <user> via <agent>" with avatars', async () => {
    wrap('server', <DocAttribution item={doc} />);
    const t = txt(screen.getByTestId('doc-attribution'));
    expect(t).toContain('Created by octocat via claude-code');
    expect(t).toContain('Last edited by hubot via codex');
    // Directory avatar (users_resolve, batched), never a GitHub API call from the browser.
    await waitFor(() => expect(document.querySelector('img.pp-avatar')!.getAttribute('src')).toBe('https://avatars.example/octocat'));
  });
  it('service accounts get a neutral "service" badge, no avatar', () => {
    wrap('server', <ByLine a={{ user: 'service:ci', agent: 'ci-bot' }} />);
    expect(screen.getByTestId('service-badge').textContent).toBe('service');
    expect(txt(screen.getByTestId('attr-by'))).toBe('service ci via ci-bot');
    expect(document.querySelector('img')).toBeNull();
  });
  it('history rail: user + "via <agent>" and a working "by user" filter', async () => {
    wrap('server', <HistoryTimeline entries={entries} now={now} />);
    expect(screen.getAllByTestId('attr-by').map(txt)).toEqual(['octocat via claude-code', 'hubot via codex', 'service ci via ci-bot']);
    fireEvent.click(screen.getByRole('button', { name: /User/ }));
    fireEvent.click(await screen.findByText('hubot', { selector: '.filter-option span' }));
    expect(screen.getAllByTestId('attr-by').map(txt)).toEqual(['hubot via codex']);
    expect(screen.queryByText('Rotate tokens')).toBeNull();
    expect(screen.getByText('Add SSO')).toBeTruthy();
  });
  it('activity feed: user filter', async () => {
    const evs = [
      { id: 'a:0', commit: 'a', type: 'spec.updated', at: ago(1), refs: [], summary: 'By octocat', agent: 'claude-code', user: 'octocat' },
      { id: 'b:0', commit: 'b', type: 'spec.updated', at: ago(2), refs: [], summary: 'By hubot', agent: 'codex', user: 'hubot' },
    ] as ActivityEvent[];
    wrap('server', <ActivityPanel events={evs} />);
    expect(screen.getAllByTestId('attr-by').map(txt)).toEqual(['octocat via claude-code', 'hubot via codex']);
    fireEvent.click(screen.getByRole('button', { name: /^User/ }));
    fireEvent.click(await screen.findByText('octocat', { selector: '.filter-option span' }));
    expect(screen.queryByText('By hubot')).toBeNull();
    expect(screen.getByText('By octocat')).toBeTruthy();
  });
});

describe('Settings: recent writers', () => {
  const data = (): WritersResponse => ({
    writers: [
      { user: 'octocat', agent: 'claude-code', source: 'oauth', commits: 12, last: ago(1) },
      { user: null, agent: 'codex', source: 'shared-key', commits: 3, last: ago(5) },
      { user: 'service:ci', agent: 'ci-bot', source: 'ci-key', commits: 9, last: ago(2) },
    ],
    unattributed: 3,
    service: 9,
    scanned: 24,
  });
  it('users, unattributed and service writes highlighted', () => {
    render(<MantineProvider><WritersTable data={data()} /></MantineProvider>);
    expect(screen.getByText('User')).toBeTruthy();
    expect(screen.getByTestId('writers-stats').textContent).toContain('3 without a user');
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    expect(rows.map((r) => r.getAttribute('data-flag'))).toEqual([null, 'unattributed', 'service']);
  });
});
