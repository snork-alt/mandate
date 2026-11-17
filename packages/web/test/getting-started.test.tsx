// @vitest-environment jsdom
/** Getting started: opens on the Overview of an EMPTY project only; "Don't show again" persists per project; banner + top-bar reopen. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectOverview } from '@mandate/shared';
import { OverviewPage } from '../src/pages/OverviewPage';
import { isEmptyProject, resetAutoOpened } from '../src/connect/GettingStarted';
import { installDom } from './dom';

const zero = { specs: 0, standards: 0, components: 0, workOrders: 0, feedback: 0 };
let counts = zero;
const overview = {
  head: null,
  at: new Date().toISOString(),
  maturity: { total: 0, archived: 0, steps: { draft: 0, specified: 0, in_progress: 0, implemented: 0, audited: 0 }, overlays: { failing: 0, drifted: 0, blocked: 0, stale: 0 } },
  attention: { failing: 0, drifted: 0, blocked: 0, stale: 0, mustFindings: 0, staleClaims: 0, failedWorkOrders: 0, integrityErrors: 0, integrityWarnings: 0, integritySnoozed: 0, specs: [] },
  inProgress: [],
  inProgressTotal: 0,
  queued: 0,
  blocked: [],
  blockedTotal: 0,
  mustFindingSpecs: [],
  byCategory: [],
  neverAudited: [],
  unverified: [],
  warnings: [],
  gaps: [],
  warningGroups: [],
  coverage: { criteria: { total: 0, verified: 0, waived: 0, failing: 0, stale: 0, unverified: 0 }, sections: { implemented: 0, total: 0 }, audits: { total: 0, never: 0, stale: 0, recent: 0 }, lineage: null },
} as unknown as ProjectOverview;

vi.mock('../src/project', async (orig) => ({ ...(await orig<typeof import('../src/project')>()), getCurrentProject: () => 'shop' }));
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string) => {
    if (name === 'project_overview') return overview;
    if (name === 'activity_list') return { events: [], total: 0, nextCursor: null, head: null };
    return {};
  }),
  callRootTool: vi.fn(async () => ({ defaultProject: 'shop', items: [{ id: 'shop', name: 'Shop', counts, access: 'write' }] })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

const connect = { project: { id: 'shop', name: 'Shop' }, mcpPath: '/p/shop/mcp', key: null, keysFile: null, cli: { create: 'c', list: 'l', revoke: 'r' }, auth: 'oauth', mcpUrl: 'https://m.example.com/p/shop/mcp', access: 'write' };

function R() {
  return (
    <MantineProvider>
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

beforeAll(installDom);
beforeEach(() => {
  counts = zero;
  resetAutoOpened();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(connect), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Getting started', () => {
  it('isEmptyProject: no specs, standards, components or work orders (unknown counts are not empty)', () => {
    expect(isEmptyProject({ counts: zero })).toBe(true);
    expect(isEmptyProject({ counts: { ...zero, standards: 1 } })).toBe(false);
    expect(isEmptyProject({ counts: { ...zero, feedback: 3 } })).toBe(true);
    expect(isEmptyProject(undefined)).toBe(false);
  });

  it('opens by itself on an empty project, with the installer and the two ways to start', async () => {
    render(<R />);
    const gs = await screen.findByTestId('getting-started');
    expect(gs.textContent).toContain('Welcome to Shop');
    expect(await screen.findByTestId('install-command')).toBeTruthy();
    expect(gs.textContent).toContain('/mandate-bootstrap');
    expect(gs.textContent).toContain('Using Mandate, let’s spec a login with GitHub SSO');
    expect(gs.textContent).toContain('Explore the empty project');
    expect(gs.textContent).toContain('Open the connect guide (advanced setup)');
    fireEvent.click(screen.getByTestId('gs-existing'));
    expect(screen.getByTestId('gs-existing').getAttribute('aria-checked')).toBe('true');
  });

  it('closed: banner and top-bar button reopen it; "Don\'t show again" persists for the project', async () => {
    render(<R />);
    await screen.findByTestId('getting-started');
    fireEvent.click(screen.getByLabelText("Don't show again for this project"));
    fireEvent.click(screen.getByTestId('gs-explore'));
    await waitFor(() => expect(screen.queryByTestId('getting-started')).toBeNull());
    expect(await screen.findByTestId('gs-banner')).toBeTruthy();
    expect(screen.getByTestId('gs-topbar')).toBeTruthy();
    expect(Object.keys(localStorage).some((k) => k.includes('gettingStarted.modal') && k.endsWith('.shop'))).toBe(true);
    fireEvent.click(screen.getByTestId('gs-topbar'));
    expect(await screen.findByTestId('getting-started')).toBeTruthy();
    cleanup();
    // A new session: not opened again.
    resetAutoOpened();
    render(<R />);
    expect(await screen.findByTestId('gs-banner')).toBeTruthy();
    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('never shows for a project with content', async () => {
    counts = { ...zero, specs: 2 };
    render(<R />);
    await screen.findByTestId('overview');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('getting-started')).toBeNull();
    expect(screen.queryByTestId('gs-topbar')).toBeNull();
    expect(screen.queryByTestId('gs-banner')).toBeNull();
  });
});
