// @vitest-environment jsdom
/**
 * Agent audits from the web UI: the Audit button + dialog (active-agent picker, none active -> disabled with the
 * `mandate claude` hint), live progress lines, and the Outdated / Upstream changed popover (change summaries and the
 * Accept / Update / Audit actions).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDom } from './dom';
import { AuditProgressLine, AuditRequestButton } from '../src/components/audits/AuditRequest';
import { ChangePopover, SectionChangeContext } from '../src/components/doc/ChangeActions';

beforeAll(() => {
  installDom();
  (document as unknown as { fonts: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() };
});

const calls: { name: string; args: Record<string, any> }[] = [];
const agents = [{ id: 'ada/claude-code', handle: 'claude-code', label: 'Claude Code (ada)', state: 'online', busyWith: [], repos: [], wakeable: true }];
let AGENTS: any[] = agents;
let ACTIVE: any[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, any>) => {
    calls.push({ name, args });
    if (name === 'agents_presence') return { agents: AGENTS, suggested: 'ada/claude-code' };
    if (name === 'audit_request') return { audit: { id: '2026-11-18-login' }, queued: false };
    if (name === 'audit_list') return { audits: ACTIVE };
    if (name === 'section_accept' || name === 'section_link_ack') return { ref: args.ref };
    if (name === 'request_create') return { request: { id: 'fb-0001' } };
    if (name === 'search') return { groups: [] };
    if (name === 'list') return [];
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({})),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  calls.length = 0;
  AGENTS = agents;
  ACTIVE = [];
});

describe('Audit button', () => {
  it('opens the dialog with the active-agent picker and queues a full audit for the chosen agent', async () => {
    wrap(<AuditRequestButton target="mandate://specs/login" title="Login" />);
    fireEvent.click(await screen.findByTestId('audit-button'));
    expect(await screen.findByText('Claude Code (ada)')).toBeTruthy();
    expect(screen.getByTestId('audit-request').textContent).toMatch(/every section/);
    fireEvent.click(screen.getByTestId('audit-request-submit'));
    await waitFor(() => expect(calls.find((c) => c.name === 'audit_request')?.args).toEqual({ target: 'mandate://specs/login', assignee: 'claude-code' }));
  });

  it('no agent active: the button is disabled and says how to start one', async () => {
    AGENTS = [{ ...agents[0], state: 'offline' }];
    wrap(<AuditRequestButton target="mandate://specs/login" title="Login" />);
    expect(await screen.findByTestId('audit-no-agent')).toBeTruthy();
    expect((screen.getByTestId('audit-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('audit-no-agent').textContent).toContain('mandate claude');
  });
});

describe('audit progress', () => {
  it('shows queued and running audits with items / sections checked', async () => {
    const base = { id: 'a1', uri: 'mandate://audits/a1', target: 'mandate://specs/login', auditor: { agent: 'x' }, assignee: 'ada/claude-code' };
    ACTIVE = [
      { ...base, status: 'requested', progress: { items: { done: 0, total: 12 }, sections: { done: 0, total: 5 } } },
      { ...base, id: 'a2', status: 'in_progress', progress: { items: { done: 3, total: 12 }, sections: { done: 2, total: 5 } } },
    ];
    wrap(<AuditProgressLine target="mandate://specs/login" />);
    const box = await screen.findByTestId('audit-progress');
    await waitFor(() => expect(box.textContent).toMatch(/queued for Claude Code \(ada\)/));
    expect(box.textContent).toMatch(/3\/12 items · 2 sections of 5 checked/);
  });
});

describe('Outdated / Upstream changed popover', () => {
  const changes = [
    { commit: 'c1', by: 'ada', at: new Date().toISOString(), summary: 'Sessions now last 30 days.' },
    { commit: 'c2', by: 'bo', at: new Date().toISOString(), summary: null },
  ];
  const show = (kind: 'outdated' | 'upstream') =>
    wrap(
      <SectionChangeContext.Provider value={{ specId: 'login', specTitle: 'Login' }}>
        <ChangePopover kind={kind} sectionId="session" sectionTitle="Session" changes={changes} {...(kind === 'upstream' ? { upstream: { to: 'mandate://specs/auth/sections/tokens', title: 'Auth › Tokens' } } : {})}>
          <span>badge</span>
        </ChangePopover>
      </SectionChangeContext.Provider>,
    );

  it('lists the summaries (no code diff; legacy edits say how to get one) and Accept sets the section as accepted', async () => {
    show('outdated');
    fireEvent.click(screen.getByTestId('change-badge-outdated'));
    const pop = await screen.findByTestId('change-popover');
    expect(pop.textContent).toContain('Changed since implemented');
    expect(pop.textContent).toContain('Sessions now last 30 days.');
    expect(pop.textContent).toContain('No summary; run an Audit to refresh this section.');
    fireEvent.click(screen.getByTestId('change-accept'));
    await waitFor(() => expect(calls.find((c) => c.name === 'section_accept')?.args).toMatchObject({ ref: 'mandate://specs/login/sections/session' }));
  });

  it('Upstream changed: Accept acknowledges the link; Update files a request for the suggested agent with the summary and a reference', async () => {
    show('upstream');
    fireEvent.click(screen.getByTestId('change-badge-upstream'));
    await screen.findByTestId('change-popover');
    fireEvent.click(screen.getByTestId('change-accept'));
    await waitFor(() => expect(calls.find((c) => c.name === 'section_link_ack')?.args).toMatchObject({ ref: 'mandate://specs/login/sections/session', to: 'mandate://specs/auth/sections/tokens' }));
    fireEvent.click(screen.getByTestId('change-update'));
    await waitFor(() => {
      const r = calls.find((c) => c.name === 'request_create')?.args;
      expect(r).toMatchObject({ assignee: 'claude-code', kind: 'improvement' });
      expect(r!.body).toContain('mandate://specs/login/sections/session');
      expect(r!.body).toContain('Sessions now last 30 days.');
    });
  });

  it('Audit opens the audit dialog for the whole spec', async () => {
    show('outdated');
    fireEvent.click(screen.getByTestId('change-badge-outdated'));
    await screen.findByTestId('change-popover');
    fireEvent.click(screen.getByTestId('change-audit'));
    fireEvent.click(await screen.findByTestId('audit-request-submit'));
    await waitFor(() => expect(calls.find((c) => c.name === 'audit_request')?.args).toMatchObject({ target: 'mandate://specs/login', assignee: 'claude-code', note: 'Outdated: Session' }));
  });
});
