// @vitest-environment jsdom
/** Reference hover card: kind label + breadcrumb, title, clamped excerpt, readable contributor names; click navigates. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRef } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { RefChip } from '../src/components/refs/RefChip';

installDom();
const at = new Date(Date.now() - 2 * 3600_000).toISOString();
const person = (user: string) => ({ user, userRecorded: true, kind: 'direct', roles: ['edited'], count: 1, lastAt: at, agents: [] });
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { refs?: string[]; uri?: string }) => {
    if (name === 'contributors') return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, ['snork-alt', 'alice', 'bob', 'carol', 'dave'].map(person)])) };
    if (name === 'graph_node')
      return { node: { ref: args.uri, kind: 'section', label: 'Transfer lifecycle and ledger › Transfer stub routes', props: { status: 'in_progress', summary: 'information-requests and evidence-intents routes check ownership, then answer an empty list or 404.' } } };
    if (name === 'users_resolve') return { users: [] };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(cleanup);

const server: AuthStatus = { authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login', mode: 'server' };
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={server}>
          <MemoryRouter>
            <Routes>
              <Route path="*" element={<>{ui}<Where /></>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );

const uri = buildRef({ kind: 'specs', id: 'transfers', sectionId: 'stub-routes' });

describe('RefChip hover card', () => {
  it('shows kind label, breadcrumb, title, status, excerpt, contributor names and the click hint', async () => {
    wrap(<RefChip to={uri} />);
    await waitFor(() => expect(document.querySelector('.ref-chip-label')!.textContent).toContain('Transfer stub routes'));
    fireEvent.mouseEnter(document.querySelector('.ref-chip-rich')!);
    await waitFor(() => expect(screen.getByTestId('ref-preview')).toBeTruthy());
    expect(screen.getByTestId('ref-preview-kind').textContent).toBe('Section');
    expect(screen.getByTestId('ref-preview-crumb').textContent).toContain('Transfer lifecycle and ledger');
    expect(document.querySelector('.ref-card-title')!.textContent).toBe('Transfer stub routes');
    expect(screen.getByText('in progress')).toBeTruthy();
    const ex = screen.getByTestId('ref-preview-excerpt');
    expect(ex.className).toBe('ref-card-excerpt');
    expect(ex.textContent).toContain('information-requests');
    await waitFor(() => expect(document.querySelector('.ref-card-names')).toBeTruthy());
    const names = document.querySelector('.ref-card-names')!.textContent!;
    expect(names).toContain('snork-alt, alice, bob');
    expect(names).toContain('+2');
    expect(screen.getByText('Click to open')).toBeTruthy();
  });

  it('click still navigates to the section', async () => {
    wrap(<RefChip to={uri} />);
    fireEvent.click(document.querySelector('.ref-chip-rich')!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('transfers'));
  });
});
