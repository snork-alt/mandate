// @vitest-environment jsdom
/** Settings → Agent flow (policy, my agents' read-only state, locks, all clients) and the sidebar badge summary. */
import { within, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'ada', version: '2.1', flow: null, updatedAt: null, updatedVia: null,
  lastSeenAt: new Date().toISOString(), effective: { flow: 'on' }, locked: { flow: false }, ...o,
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
    const calls = serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({ effective: { flow: 'off' } })] }] });
    mount();
    const st = await screen.findByLabelText('Flow for Claude Code: off');
    expect(st.textContent).toBe('Off');
    expect(screen.queryByLabelText(/Approval for/)).toBeNull();
    expect(screen.queryByText(/Approval/)).toBeNull();
    // No per-client switches (only the admin's project-level strict flow one).
    const notStrict = (el: Element) => !el.closest('[data-testid^="flow-strict-"], [data-testid^="flow-audit-"]');
    expect(screen.queryAllByRole('switch').filter(notStrict)).toEqual([]);
    expect([...document.querySelectorAll('input[type="checkbox"]')].filter(notStrict)).toEqual([]);
    fireEvent.click(st);
    expect(screen.getByTestId('flow-mine-hint-web').textContent).toContain('/mandate-flow on|off');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(screen.getByText('Only Mandate admins change the policy.')).toBeTruthy();
    expect(screen.queryByTestId('flow-all-web')).toBeNull();
  });

  it('strict flow: an admin switch (PUT strictFlow); read-only for others', async () => {
    const calls = serve({ mode: 'server', admin: true, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', strictFlow: false }, mine: [client({})] }] });
    mount();
    const sw = (await screen.findByLabelText('Strict flow')) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/policy') && JSON.stringify(c.body) === '{"strictFlow":true}')).toBe(true));
    cleanup();
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', strictFlow: true }, mine: [client({})] }] });
    mount();
    expect(((await screen.findByLabelText('Strict flow')) as HTMLInputElement).disabled).toBe(true);
  });

  it('audit after work orders: an admin switch (PUT auditAfterWorkOrder), off by default; read-only for others', async () => {
    const calls = serve({ mode: 'server', admin: true, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    const sw = (await screen.findByLabelText('Audit after work orders')) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/policy') && JSON.stringify(c.body) === '{"auditAfterWorkOrder":"on"}')).toBe(true));
    cleanup();
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', auditAfterWorkOrder: 'on' }, mine: [client({})] }] });
    mount();
    const ro = (await screen.findByLabelText('Audit after work orders')) as HTMLInputElement;
    expect(ro.checked).toBe(true);
    expect(ro.disabled).toBe(true);
  });

  it('git: commit / branch / push switches (PUT patch); read-only for others', async () => {
    const calls = serve({ mode: 'server', admin: true, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    const ask = (await screen.findByLabelText('Ask before committing')) as HTMLInputElement;
    expect((screen.getByLabelText('Commit automatically') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Branch per request') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Never push') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(ask);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/policy') && JSON.stringify(c.body) === '{"commit":"ask"}')).toBe(true));
    fireEvent.click(screen.getByLabelText('Push and open a PR'));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body) === '{"push":"auto"}')).toBe(true));
    fireEvent.click(screen.getByLabelText('Current branch'));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body) === '{"branch":"current"}')).toBe(true));
    fireEvent.click(within(screen.getByTestId('flow-components-web')).getByLabelText('Optional'));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body) === '{"components":"optional"}')).toBe(true));
    cleanup();
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional', commit: 'ask' }, mine: [client({})] }] });
    mount();
    const ro = (await screen.findByLabelText('Ask before committing')) as HTMLInputElement;
    expect(ro.checked).toBe(true);
    expect(ro.disabled).toBe(true);
  });

  it('locked by policy: state with "enforced by policy"; admins see all clients', async () => {
    serve({
      mode: 'server', admin: true, user: 'ada',
      projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'required' }, mine: [client({ locked: { flow: true } })], all: [client({}), client({ id: 'bob/codex', label: 'Codex', client: 'codex', user: 'bob' })] }],
    });
    mount();
    expect((await screen.findByLabelText('Flow for Claude Code: on')).textContent).toBe('On');
    expect(screen.getByText(/enforced by policy/)).toBeTruthy();
    expect(screen.getByTestId('flow-all-web').textContent).toContain('bob');
  });
});

describe('Settings → Agent flow: no approval', () => {
  it('no Approval column or policy; the policy PUT carries only flowPolicy', async () => {
    const calls = serve({ mode: 'server', admin: true, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({})], all: [client({})] }] });
    mount();
    await screen.findByTestId('flow-mine-web');
    expect(screen.queryByText(/^Approval/)).toBeNull();
    expect(screen.queryByLabelText(/Approval/)).toBeNull();
    expect(screen.getByTestId('flow-mine-hint-web').textContent).toContain('questions mandate|chat');
    expect(screen.getByTestId('flow-all-web').textContent).toContain('flow on');
    fireEvent.click(screen.getByText('Required'));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ flowPolicy: 'required' });
  });
});

describe('Settings → Agent flow: questions', () => {
  it('per client: via Mandate (default) | in chat, shown read-only', async () => {
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({ questions: null, effective: { flow: 'on', questions: 'mandate' } }), client({ id: 'ada/codex', label: 'Codex', client: 'codex', questions: 'chat', effective: { flow: 'on', questions: 'chat' } })] }] });
    mount();
    expect((await screen.findByTestId('flow-questions-ada/claude-code')).textContent).toBe('Via Mandate');
    expect(screen.getByTestId('flow-questions-ada/codex').textContent).toBe('In chat');
    expect(screen.getByTestId('flow-questions-ada/codex').querySelector('input')).toBeNull();
  });

  it('older servers without the field: no questions column', async () => {
    serve({ mode: 'server', admin: false, user: 'ada', projects: [{ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [client({})] }] });
    mount();
    await screen.findByLabelText('Flow for Claude Code: on');
    expect(screen.queryByTestId('flow-questions-ada/claude-code')).toBeNull();
    expect(screen.queryByText('Questions')).toBeNull();
  });
});

describe('badge summary', () => {
  const p = (o: Partial<FlowProject>): FlowProject => ({ id: 'web', name: 'Web', policy: { flowPolicy: 'optional' }, mine: [], ...o });
  it('shows my effective state', () => {
    expect(flowSummary(p({ policy: { flowPolicy: 'required' } })).label).toBe('Flow: required');
    expect(flowSummary(p({ policy: { flowPolicy: 'off' } })).label).toBe('Flow: off');
    expect(flowSummary(p({ mine: [client({}), client({ id: 'x' })] })).label).toBe('Flow on · 2 agents');
    expect(flowSummary(p({ mine: [client({}), client({ id: 'x', effective: { flow: 'off' } })] }))).toEqual({ label: 'Flow 1/2 on', tone: 'mixed' });
    expect(flowSummary(p({})).label).toBe('Flow on');
  });
});
