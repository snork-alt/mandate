// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Spec } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { FeedbackListPage } from '../src/pages/FeedbackListPage';
import { SpecListPage } from '../src/pages/SpecListPage';

// Regression: "Clear" used to run one URL update per filter key; each started from the same
// render's params, so only the last key was actually removed. Clearing is one update now.
installDom();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { refs?: string[] }) => {
    if (name === 'contributors') return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, []])) };
    if (name === 'users_resolve') return { users: [] };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => cleanup());

const status: AuthStatus = { authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login', mode: 'server' };
function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}
function mount(ui: React.ReactNode, url: string, data: Record<string, unknown[]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [k, v] of Object.entries(data)) client.setQueryData([k], v);
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={status}>
          <MemoryRouter initialEntries={[url]}>
            {ui}
            <Where />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}
const where = () => screen.getByTestId('where').textContent ?? '';

describe('list "Clear" removes every filter in one URL update', () => {
  it('Feedback list: kind, status, resolution and target all cleared; grouping kept', async () => {
    mount(<FeedbackListPage />, '/requests?kind=bug&status=closed&resolution=applied&target=specs&group=none', { feedback: [], 'work-orders': [], specs: [], standards: [] });
    fireEvent.click(await screen.findByText('Clear'));
    await waitFor(() => expect(where()).toBe('?group=none'));
  });

  it('Spec list: toolbar Clear drops all filters; "Clear filters" also drops the search', async () => {
    const spec = { id: 'a', title: 'A', summary: '', status: 'active', priority: 'p1', tags: ['x'], category: 'auth', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), versionCount: 1, sections: [] } as unknown as Spec;
    mount(<SpecListPage />, '/specs?priority=p0&tag=nope&category=none&audit=never&q=zzz&group=none', { specs: [spec], standards: [], 'work-orders': [] });
    fireEvent.click(await screen.findByText('Clear filters'));
    await waitFor(() => expect(where()).toBe('?group=none'));
    cleanup();
    mount(<SpecListPage />, '/specs?priority=p0&tag=nope&category=none&q=zzz', { specs: [spec], standards: [], 'work-orders': [] });
    fireEvent.click(await screen.findByText('Clear'));
    await waitFor(() => expect(where()).toBe('?q=zzz'));
  });
});
