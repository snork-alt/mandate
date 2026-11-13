// @vitest-environment jsdom
/** Settings → Agent flow (policy, my agents' read-only state, locks, all clients) and the sidebar badge summary. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  lastSeenAt: new Date().toISOString(), effective: { flow: 'on', approval: 'on' }, locked: { flow: false, approval: false }, ...o,
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
  it('my agents: read-only state (changed only from the agent); the policy is admin-only', async () => {
    const calls = serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({ effective: { flow: 'off', approval: 'on' } })] }] });
    mount();
    const st = await screen.findByLabelText('Flow for Claude Code: off');
    expect(st.textContent).toBe('Off');
    expect(screen.getByLabelText('Approval for Claude Code: on')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(st);
    expect(screen.getByTestId('flow-mine-hint-web').textContent).toContain('/mandate-flow on|off');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(screen.getByText('Only Mandate admins change the policy.')).toBeTruthy();
    expect(screen.queryByTestId('flow-all-web')).toBeNull();
  });

  it('locked by policy: state with "enforced by policy"; admins see all clients', async () => {
    serve({
      mode: 'server', admin: true, user: 'ada',
      projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'required', approvalPolicy: 'optional' }, mine: [client({ locked: { flow: true, approval: false } })], all: [client({}), client({ id: 'bob/codex', label: 'Codex', client: 'codex', user: 'bob' })] }],
    });
    mount();
    expect((await screen.findByLabelText('Flow for Claude Code: on')).textContent).toBe('On');
    expect(screen.getByText(/enforced by policy/)).toBeTruthy();
    expect(screen.getByTestId('flow-all-web').textContent).toContain('bob');
  });
});

describe('Settings → Agent flow: questions', () => {
  it('per client: via Mandate (default) | in chat, shown read-only', async () => {
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({ questions: null, effective: { flow: 'on', approval: 'on', questions: 'mandate' } }), client({ id: 'ada/codex', label: 'Codex', client: 'codex', questions: 'chat', effective: { flow: 'on', approval: 'on', questions: 'chat' } })] }] });
    mount();
    expect((await screen.findByTestId('flow-questions-ada/claude-code')).textContent).toBe('Via Mandate');
    expect(screen.getByTestId('flow-questions-ada/codex').textContent).toBe('In chat');
    expect(screen.getByTestId('flow-questions-ada/codex').querySelector('input')).toBeNull();
  });

  it('older servers without the field: no questions column', async () => {
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', approvalPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    await screen.findByLabelText('Flow for Claude Code: on');
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
