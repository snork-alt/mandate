// @vitest-environment jsdom
/**
 * Ask answered by agents: the question is posted (ask_post) to the only online agent / the picked one / any; with no
 * agent online the panel says how to connect one and the question waits; progress and the final answer are polled
 * (ask_get); a waiting question can be cancelled.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AskProvider, type AskDeps } from '../src/components/ask/AskProvider';
import { AskView } from '../src/components/ask/AskView';
import { suggestionsFor } from '../src/components/ask/suggestions';

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string) => {
    if (name === 'agents_presence') return PRESENCE;
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({})),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

let PRESENCE: Record<string, unknown> = { agents: [] };
const agent = (id: string, handle: string, label: string, state = 'online') => ({ id, handle, label, state, busyWith: [], repos: [] });

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (document as unknown as { fonts: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  PRESENCE = { agents: [] };
});

const SUGGEST = suggestionsFor([{ uri: 'u', kind: 'spec', label: 'a' }])[0]!;
const posted = { id: 'ask-1', conversationId: 'conv-1', status: 'waiting', answer: '', agent: null, to: null };
function mount(callTool: AskDeps['callTool']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/specs/a']}>
          <AskProvider deps={{ callTool }}>
            <AskView />
          </AskProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return screen.getByLabelText('Question') as HTMLTextAreaElement;
}
const ask = (q: HTMLTextAreaElement, text: string) => {
  fireEvent.change(q, { target: { value: text } });
  fireEvent.keyDown(q, { key: 'Enter' });
};

describe('Ask panel (answered by agents)', () => {
  it('one agent online: posts to it, shows who answers, the answer grows, then done', async () => {
    PRESENCE = { agents: [agent('ada/claude-code', 'claude-code', 'Claude Code (ada)')] };
    const replies = [
      { ...posted, status: 'answering', answer: 'Part one. ', agent: 'Claude Code (ada)' },
      { ...posted, status: 'done', answer: 'Part one. Part two, see [Login](mandate://specs/login).', agent: 'Claude Code (ada)' },
    ];
    const callTool = vi.fn(async (name: string) => (name === 'ask_post' ? { ...posted, to: 'ada/claude-code', agent: 'Claude Code (ada)' } : replies.shift() ?? replies[0]));
    const q = mount(callTool as never);
    await screen.findByTestId('ask-agent-auto');
    expect(screen.getByTestId('ask-agent-auto').textContent).toContain('Answered by Claude Code (ada)');
    ask(q, ' why? ');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('ask_post', expect.objectContaining({ question: 'why?', context: expect.any(Array), to: 'claude-code' }), undefined, expect.anything()));
    expect(q.value).toBe('');
    expect(screen.getByText('why?')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ask-progress').textContent).toContain('Claude Code (ada) is answering'), { timeout: 5000 });
    expect(screen.getByTestId('ask-answer').textContent).toContain('Part one.');
    await waitFor(() => expect(screen.getByTestId('answered-by').textContent).toContain('Claude Code (ada)'), { timeout: 5000 });
    expect(screen.getByTestId('ask-answer').textContent).toContain('Part two');
  });

  it('no agent online: says how to connect one; the question is posted unassigned and waits', async () => {
    PRESENCE = { agents: [] };
    const callTool = vi.fn(async (name: string) => (name === 'ask_post' ? posted : posted));
    const q = mount(callTool as never);
    expect((await screen.findByTestId('ask-no-agent')).textContent).toContain('mandate claude');
    ask(q, 'anyone there?');
    await waitFor(() => expect(callTool).toHaveBeenCalled());
    const args = (callTool.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(args.to).toBeUndefined();
    expect((await screen.findByTestId('ask-waiting')).textContent).toContain('Waiting for an agent to connect');
  });

  it('several agents online: a picker (active agents only); the choice is sent as to; a waiting question can be cancelled', async () => {
    PRESENCE = { agents: [agent('ada/claude-code', 'claude-code', 'Claude Code (ada)'), agent('bo/codex', 'codex', 'Codex (bo)', 'busy')], suggested: 'ada/claude-code' };
    let cancelled = false;
    const callTool = vi.fn(async (name: string) => {
      if (name === 'ask_cancel') cancelled = true;
      return { ...posted, to: 'bo/codex', agent: 'Codex (bo)', status: cancelled ? 'cancelled' : 'waiting' };
    });
    const q = mount(callTool as never);
    const picker = await screen.findByRole('radiogroup');
    expect(within(picker).queryByText('Any agent')).toBeNull();
    fireEvent.click(within(picker).getByText('Codex (bo)'));
    ask(q, 'status?');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('ask_post', expect.objectContaining({ to: 'codex' }), undefined, expect.anything()));
    const waiting = await screen.findByTestId('ask-waiting');
    expect(waiting.textContent).toContain('Waiting for Codex (bo)');
    fireEvent.click(within(waiting).getByText('Cancel'));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('ask_cancel', { id: 'ask-1' }, undefined, expect.anything()));
    await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy(), { timeout: 5000 });
  }, 15_000);

  it('a context suggestion sends right away', async () => {
    PRESENCE = { agents: [agent('ada/claude-code', 'claude-code', 'Claude Code (ada)')] };
    const callTool = vi.fn(async () => posted);
    mount(callTool as never);
    await screen.findByTestId('ask-agent-auto');
    fireEvent.click(screen.getByText(SUGGEST!));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('ask_post', expect.objectContaining({ question: SUGGEST }), undefined, expect.anything()));
  });
});
