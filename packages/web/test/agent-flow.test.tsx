// @vitest-environment jsdom
/** Settings → Agent flow (policy, my agents' switches, locks, all clients) and the sidebar badge summary. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentFlowSection } from '../src/setup/AgentFlowSection';
import { flowSummary, type FlowClient, type FlowProject, type FlowState } from '../src/setup/flowApi';
import { installDom, Wrap } from './dom';

beforeAll(installDom);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = (o: Partial<FlowClient>): FlowClient => ({
  id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'ada', version: '2.1', flow: null, approval: null, updatedAt: null, updatedVia: null,
  lastSeenAt: new Date().toISOString(), effective: { flow: 'on', approval: 'on' }, locked: { flow: false, approval: false }, editable: true, ...o,
});

function serve(state: FlowState) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET') return json(state);
    return json({});
  });
  return calls;
}

const mount = () => render(<AgentFlowSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });

describe('Settings → Agent flow', () => {
  it('my agents: switches write my client preference; the policy is admin-only', async () => {
    const calls = serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    const sw = await screen.findByLabelText('Flow for Claude Code');
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/ui/flow/web/clients/ada%2Fclaude-code', body: { flow: 'off' } }));
    expect(screen.getByText('Only Mandate admins change the policy.')).toBeTruthy();
    expect(screen.queryByTestId('flow-all-web')).toBeNull();
  });

  it('locked by policy: disabled switch with "enforced by policy"; admins see all clients', async () => {
    serve({
      mode: 'server', admin: true, user: 'ada',
      projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'required', approvalPolicy: 'optional' }, mine: [client({ locked: { flow: true, approval: false } })], all: [client({ editable: true }), client({ id: 'bob/codex', label: 'Codex', client: 'codex', user: 'bob', editable: false })] }],
    });
    mount();
    const sw = (await screen.findByLabelText('Flow for Claude Code')) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText(/enforced by policy/)).toBeTruthy();
    expect(screen.getByTestId('flow-all-web').textContent).toContain('bob');
  });
});

describe('Settings → Agent flow: questions', () => {
  it('per client: via Mandate (default) | in chat, saved through the client preference', async () => {
    const calls = serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({ questions: null, effective: { flow: 'on', approval: 'on', questions: 'mandate' } })] }] });
    mount();
    const ctl = await screen.findByTestId('flow-questions-ada/claude-code');
    expect((ctl.querySelector('input[value="mandate"]') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(ctl.querySelector('input[value="chat"]')!);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/ui/flow/web/clients/ada%2Fclaude-code', body: { questions: 'chat' } }));
  });

  it('older servers without the field: no questions column', async () => {
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    await screen.findByLabelText('Flow for Claude Code');
    expect(screen.queryByTestId('flow-questions-ada/claude-code')).toBeNull();
    expect(screen.queryByText('Questions')).toBeNull();
  });
});

describe('badge summary', () => {
  const p = (o: Partial<FlowProject>): FlowProject => ({ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [], ...o });
  it('shows my effective state', () => {
    expect(flowSummary(p({ policy: { flowPolicy: 'required', approvalPolicy: 'optional' } })).label).toBe('Flow: required');
    expect(flowSummary(p({ policy: { flowPolicy: 'off', approvalPolicy: 'optional' } })).label).toBe('Flow: off');
    expect(flowSummary(p({ mine: [client({}), client({ id: 'x' })] })).label).toBe('Flow on · 2 agents');
    expect(flowSummary(p({ mine: [client({}), client({ id: 'x', effective: { flow: 'off', approval: 'on' } })] }))).toEqual({ label: 'Flow 1/2 on', tone: 'mixed' });
    expect(flowSummary(p({})).label).toBe('Flow on');
  });
});
