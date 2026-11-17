// @vitest-environment jsdom
/**
 * New request from the web UI (the `/mandate <text>` equivalent): form validation, @-references (objects inserted as
 * reference tokens and shown as chips), the agent picker (suggested, offline = queued, any agent), submit -> the
 * request page; the request page's flow bar, assignee / Queued and the plan-ready Approve button.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Feedback } from '@mandate/shared';
import { installDom } from './dom';
import { NewRequestModal } from '../src/components/requests/NewRequestModal';
import { RequestProgress } from '../src/components/requests/RequestProgress';
import { requestStages, type FlowState } from '../src/lib/requests';

beforeAll(() => {
  installDom();
  (document as unknown as { fonts: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() };
});

const calls: { name: string; args: Record<string, any> }[] = [];
let FLOW: FlowState = { state: 'matching', next: null, done: false };
const agents = [
  { id: 'ada/claude-code', handle: 'claude-code', label: 'Claude Code (ada)', state: 'online', busyWith: [], repos: [] },
  { id: 'bo/codex', handle: 'codex', label: 'Codex (bo)', state: 'busy', busyWith: [{ ref: 'r', summary: 'wo-1: fix login' }], repos: [] },
  { id: 'cy/claude-code', handle: 'cy-claude-code', label: 'Claude Code (cy)', state: 'offline', busyWith: [], repos: [] },
];
let AGENTS: any[] = agents;
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, any>) => {
    calls.push({ name, args });
    if (name === 'agents_presence') return { agents: AGENTS, suggested: 'ada/claude-code' };
    if (name === 'search')
      return { groups: [{ docUri: 'mandate://specs/login-sso', docTitle: 'Login SSO', docKind: 'spec', score: 1, hits: [{ uri: 'mandate://specs/login-sso/sections/auth-flow', docUri: 'mandate://specs/login-sso', docTitle: 'Login SSO', sectionId: 'auth-flow', sectionTitle: 'Auth flow', kind: 'section', docKind: 'spec', snippet: '', score: 1, matchedBy: ['text'] }] }] };
    if (name === 'list') return [];
    if (name === 'request_create') return { request: { id: 'fb-0042' } };
    if (name === 'flow_next') return FLOW;
    if (name === 'request_plan_approve') return {};
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({})),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider>
        <MemoryRouter initialEntries={['/requests']}>
          <Routes>
            <Route path="*" element={<><Where />{ui}</>} />
          </Routes>
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  calls.length = 0;
  FLOW = { state: 'matching', next: null, done: false };
});

const textarea = () => screen.getAllByLabelText('What do you want?').find((e) => e.tagName === 'TEXTAREA') as HTMLTextAreaElement;

describe('New request form', () => {
  it('requires the text; nothing is sent without it', async () => {
    wrap(<NewRequestModal opened onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('new-request-submit').textContent).toBe('Send to Claude Code (ada)'));
    fireEvent.click(screen.getByTestId('new-request-submit'));
    expect(await screen.findByText('Tell the agent what you want')).toBeTruthy();
    expect(calls.some((c) => c.name === 'request_create')).toBe(false);
  });

  it('picker: only active agents (no offline, no Any agent); the suggested one is preselected, busy ones say with what', async () => {
    wrap(<NewRequestModal opened onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('new-request-submit').textContent).toBe('Send to Claude Code (ada)'));
    expect(screen.getByText(/suggested/)).toBeTruthy();
    expect(screen.getByText(/busy: wo-1: fix login/)).toBeTruthy();
    expect(screen.queryByText(/offline/)).toBeNull();
    expect(screen.queryByLabelText(/Any agent/)).toBeNull();
    expect(screen.queryByLabelText(/Claude Code \(cy\)/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Codex \(bo\)/));
    expect(screen.getByTestId('new-request-submit').textContent).toBe('Send to Codex (bo)');
  });

  it('no active agent: says how to start one and Send is disabled', async () => {
    AGENTS = agents.map((a) => ({ ...a, state: 'offline' }));
    wrap(<NewRequestModal opened onClose={() => undefined} />);
    expect((await screen.findByTestId('no-agent-active')).textContent).toContain('mandate claude');
    expect((screen.getByTestId('new-request-submit') as HTMLButtonElement).disabled).toBe(true);
    AGENTS = agents;
  });

  it('@ inserts an object reference as a chip; submit sends assignee, priority, planOnly and the refs, then opens the request', async () => {
    wrap(<NewRequestModal opened onClose={() => undefined} />);
    await screen.findByTestId('new-request-submit');
    fireEvent.change(textarea(), { target: { value: 'Add SSO to @auth' } });
    const opt = await screen.findByRole('option', { name: /Auth flow/ });
    fireEvent.click(opt);
    expect(textarea().value).toBe('Add SSO to mandate://specs/login-sso/sections/auth-flow ');
    expect(screen.getByTestId('ref-chips').textContent).toContain('specs/login-sso/sections/auth-flow');
    fireEvent.click(screen.getByLabelText(/Codex \(bo\)/));
    fireEvent.click(screen.getByText('High'));
    fireEvent.click(screen.getByLabelText(/Plan only/));
    fireEvent.click(screen.getByTestId('new-request-submit'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/requests/fb-0042'));
    const call = calls.find((c) => c.name === 'request_create')!;
    expect(call.args).toMatchObject({ kind: 'improvement', assignee: 'codex', priority: 'high', planOnly: true, context: ['mandate://specs/login-sso/sections/auth-flow'] });
    expect(call.args.body).toContain('Add SSO to');
  });
});

const fb = (o: Partial<Feedback> = {}): Feedback => ({ id: 'fb-0042', kind: 'improvement', status: 'open', body: 'Add SSO', targets: [], relatedTo: [], changes: [], warnings: [], createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z', source: 'ui', createdByUser: 'ada', createdBy: 'mandate-ui', ...o }) as unknown as Feedback;

describe('Request page: live progress', () => {
  it('stages derive from the request and flow_next', () => {
    const f = fb({ specMatch: { at: 'x', by: 'a', refs: [] }, changes: [{ commit: 'c' } as never] });
    const flow: FlowState = { state: 'steps', next: null, done: false, progress: { workOrder: 'wo-1', kind: 'implement', status: 'in_progress', tasks: [{ id: 's1', text: 'a', status: 'done' }, { id: 's2', text: 'b', status: 'in_progress' }, { id: 's3', text: 'c', status: 'pending' }], sections: { total: 2, done: 0 }, criteria: { total: 2, proved: 0 } } };
    const s = requestStages(f, flow);
    expect(s.map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'active', 'todo']);
    expect(s[3]!.detail).toBe('3 tasks');
    expect(s[4]!.detail).toBe('task 2 of 3');
    expect(s[5]!.detail).toBe('0 of 2 criteria');
    expect(requestStages(fb({ status: 'closed' }), undefined).every((x) => x.status === 'done')).toBe(true);
    expect(requestStages(fb(), undefined).map((x) => x.status)).toEqual(['done', 'active', 'todo', 'todo', 'todo', 'todo']);
  });

  it('shows source, the assignee with presence and Queued, the flow bar and the steps', async () => {
    FLOW = { state: 'matching', next: null, done: false, queued: true };
    wrap(<RequestProgress f={fb({ assignee: 'cy/claude-code', assignedAt: '2026-01-01T10:00:01Z' })} workOrderIds={[]} />);
    expect((await screen.findByTestId('rq-source')).textContent).toBe('From the web UI by ada');
    await waitFor(() => expect(screen.getByTestId('rq-assignee').textContent).toMatch(/Claude Code \(cy\).*Queued: offline/));
    expect(screen.getByTestId('rq-flow').querySelectorAll('.rq-stage')).toHaveLength(6);
    expect(screen.getByTestId('rq-reassign')).toBeTruthy();
  });

  it('plan ready: Approve plan & implement is the only action and calls request_plan_approve', async () => {
    FLOW = { state: 'plan_ready', next: null, done: true, progress: { workOrder: 'wo-1', kind: 'implement', status: 'pending', tasks: [{ id: 's1', text: 'Write it', status: 'pending' }], sections: { total: 1, done: 0 }, criteria: { total: 1, proved: 0 } } };
    wrap(<RequestProgress f={fb({ planOnly: true, startedBy: 'ada/claude-code', assignee: 'ada/claude-code', changes: [{ commit: 'c' } as never], specMatch: { at: 'x', by: 'a', refs: [] } })} workOrderIds={['wo-1']} />);
    const btn = await screen.findByTestId('rq-approve-plan');
    expect(screen.getByText('Plan ready — review')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('rq-steps').textContent).toContain('Write it'));
    expect(screen.queryByTestId('rq-reassign')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(calls.find((c) => c.name === 'request_plan_approve')?.args).toEqual({ ref: 'fb-0042' }));
  });

  it('no approve button for a request that is not plan-only', async () => {
    FLOW = { state: 'claim', next: null, done: false };
    wrap(<RequestProgress f={fb()} workOrderIds={['wo-1']} />);
    await screen.findByTestId('rq-flow');
    expect(screen.queryByTestId('rq-approve-plan')).toBeNull();
  });
});
