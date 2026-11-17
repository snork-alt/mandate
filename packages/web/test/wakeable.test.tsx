// @vitest-environment jsdom
/**
 * Agents that are connected over MCP but cannot be woken: the picker warning, the banner on a queued request, the
 * Connect dialog's event-channel status and the "start with mandate claude" step; and the `/cli-login` approval page.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Feedback } from '@mandate/shared';
import { installDom } from './dom';
import { AgentPicker } from '../src/components/comments/CommentsPanel';
import { RequestProgress } from '../src/components/requests/RequestProgress';
import { CliLoginPage } from '../src/pages/CliLoginPage';
import { ChannelStatus, StartClaudeStep } from '../src/connect/AgentSetup';
import { AuthContext, type AuthStatus } from '../src/auth';
import { deliveryProblem } from '../src/lib/requests';

beforeAll(() => {
  installDom();
  (document as unknown as { fonts: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() };
});

let agents: any[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string) => {
    if (name === 'agents_presence') return { agents, suggested: null };
    if (name === 'flow_next') return { state: 'matching', next: null, done: false };
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({})),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = (o: Record<string, unknown>) => ({ id: 'ada/claude-code', handle: 'claude-code', label: 'Claude Code (ada)', state: 'online', wakeable: false, busyWith: [], repos: [], ...o });
const wrap = (ui: React.ReactNode, auth?: Partial<AuthStatus>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider>
        <AuthContext.Provider value={auth as AuthStatus}>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </MantineProvider>
    </QueryClientProvider>,
  );
};
const req = (o: Partial<Feedback> = {}) => ({ id: 'fb-0001', status: 'open', kind: 'improvement', body: 'x', targets: [], changes: [], createdAt: '2026-01-01T00:00:00Z', assignee: 'any', ...o }) as unknown as Feedback;

describe('deliveryProblem', () => {
  it('names the fix for MCP-only and offline agents, nothing for a wakeable one or a started request', () => {
    const only = { agents: [A({})] } as any;
    expect(deliveryProblem(req(), only)).toContain('mandate channel login');
    expect(deliveryProblem(req({ assignee: 'ada/claude-code' }), only)).toContain("can't be woken");
    expect(deliveryProblem(req(), { agents: [A({ wakeable: true })] } as any)).toBeNull();
    expect(deliveryProblem(req(), { agents: [A({ state: 'offline' })] } as any)).toContain('None is connected');
    expect(deliveryProblem(req({ assignee: 'zed/claude-code' }), only)).toContain('offline');
    expect(deliveryProblem(req({ startedBy: 'ada/claude-code' }), only)).toBeNull();
    expect(deliveryProblem(req({ status: 'closed' }), only)).toBeNull();
    expect(deliveryProblem(req(), undefined)).toBeNull();
  });
});

describe('agent picker and request banner', () => {
  it('shows the warning for a connected agent that cannot be woken, not for a wakeable one', () => {
    wrap(<AgentPicker presence={{ agents: [A({}), A({ id: 'bo/codex', handle: 'codex', label: 'Codex (bo)', wakeable: true })] } as any} value="any" onChange={() => undefined} />);
    expect(screen.getAllByTestId('cant-wake')).toHaveLength(1);
    expect(screen.getByTestId('cant-wake').textContent).toContain("connected, can't be woken: run mandate channel login and start with mandate claude");
  });
  it('a queued request assigned to a non-wakeable agent shows the banner', async () => {
    agents = [A({})];
    wrap(<RequestProgress f={req({ assignee: 'ada/claude-code' })} workOrderIds={[]} />);
    const b = await screen.findByTestId('rq-delivery-warning');
    expect(b.textContent).toContain("can't be woken");
    expect(b.textContent).toContain('mandate claude');
  });
  it('no banner when the assignee is wakeable', async () => {
    agents = [A({ wakeable: true })];
    wrap(<RequestProgress f={req({ assignee: 'ada/claude-code' })} workOrderIds={[]} />);
    await screen.findByTestId('request-progress');
    await waitFor(() => expect(screen.queryByTestId('rq-delivery-warning')).toBeNull());
  });
});

describe('Connect dialog parts', () => {
  const auth = { user: { login: 'ada', avatarUrl: '' } } as Partial<AuthStatus>;
  it('event channel status: connected yes / no', async () => {
    agents = [A({ wakeable: true })];
    wrap(<ChannelStatus />, auth);
    await waitFor(() => expect(screen.getByTestId('channel-status').dataset.connected).toBe('yes'));
    cleanup();
    agents = [A({})];
    wrap(<ChannelStatus />, auth);
    await waitFor(() => expect(screen.getByTestId('channel-status').textContent).toContain("can't be woken"));
    expect(screen.getByTestId('channel-status').dataset.connected).toBe('no');
  });
  it('step 3 explains mandate claude', () => {
    wrap(<StartClaudeStep />);
    expect(screen.getByTestId('start-claude').textContent).toContain('mandate claude');
  });
});

describe('CLI login page', () => {
  it('shows host, project and code; Approve posts to the approve route', async () => {
    window.history.pushState({}, '', '/cli-login?code=ABCD-2345');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.method === 'POST' ? { status: 'approved' } : { code: 'ABCD-2345', project: { id: 'web', name: 'Web' }, hostname: 'my-laptop', user: 'ada', status: 'pending', expiresAt: '2030-01-01T00:00:00Z' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<CliLoginPage />);
    await screen.findByTestId('cli-login-host');
    expect(screen.getByTestId('cli-login-host').textContent).toBe('my-laptop');
    expect(screen.getByTestId('cli-login-code').textContent).toBe('ABCD-2345');
    fireEvent.click(screen.getByTestId('cli-login-approve'));
    await screen.findByTestId('cli-login-approved');
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/ui/cli-login/ABCD-2345/approve');
  });
  it('an unknown or expired code shows the server message', async () => {
    window.history.pushState({}, '', '/cli-login?code=NOPE-0000');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'this code is unknown or expired: run the command again' } }), { status: 404, headers: { 'content-type': 'application/json' } })));
    wrap(<CliLoginPage />);
    expect((await screen.findByTestId('cli-login-error')).textContent).toContain('unknown or expired');
  });
});
