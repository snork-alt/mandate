// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from './dom';
import { WritersSection } from '../src/setup/WritersSection';
import type { SectionProps } from '../src/setup/sections';

installDom();
vi.mock('../src/mcp/client', () => ({
  callRootTool: vi.fn(async () => ({ defaultProject: 'default', items: [{ id: 'default', name: 'Default' }] })),
  callProjectTool: vi.fn(async () => ({ mode: 'server', writers: [], unattributed: 0, service: 0, scanned: 0 })),
  callTool: vi.fn(async () => ({})),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(status: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login', ...status }), { status: 200 })));
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WritersSection {...({} as SectionProps)} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('Settings → Recent writers: legacy-install notice', () => {
  it('shows the notice on a legacy install (GitHub sign-in, no explicit server.mode)', async () => {
    mount({ legacy: true, mode: 'server' });
    expect((await screen.findByTestId('legacy-notice')).textContent).toContain('server.mode');
  });
  it('hides it otherwise', async () => {
    mount({ legacy: false, mode: 'server' });
    await waitFor(() => expect(screen.getByTestId('writers-stats')).toBeTruthy());
    expect(screen.queryByTestId('legacy-notice')).toBeNull();
  });
});
