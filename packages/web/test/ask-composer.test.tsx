// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AskProvider } from '../src/components/ask/AskProvider';
import { AskView, effectiveModel } from '../src/components/ask/AskView';
import { AnswerView } from '../src/components/ask/AskThread';
import { suggestionsFor } from '../src/components/ask/suggestions';
import { SearchField } from '../src/components/SearchField';
import type { AskStatus } from '../src/mcp/queries';
import type { AskDeps } from '../src/components/ask/stream';

const idle: AskDeps = { callTool: (() => new Promise(() => undefined)) as never, onNotification: () => () => undefined };

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    // no storage
  }
});
beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});
const model = (id: string, label: string, configured = true) => ({
  id,
  label,
  provider: 'openai-compatible' as const,
  model: `${id}-model`,
  apiKeySet: configured,
  configured,
  missing: configured ? [] : (['apiKey'] as const).slice(),
  ...(configured ? {} : { reason: 'set OFF_KEY (environment or ~/.mandate/secrets.env)' }),
});
const ok: AskStatus = { configured: true, default: 'luna', models: [model('luna', 'GPT-6 Luna')], missing: [] };
const three: AskStatus = { configured: true, default: 'luna', models: [model('luna', 'GPT-6 Luna'), model('haiku', 'Claude Haiku 5.5'), model('off', 'Off model', false)], missing: [] };
function mount(status: AskStatus, deps: AskDeps = idle) {
  const qc = new QueryClient();
  qc.setQueryData(['mcp', 'ask_status', {}], status);
  render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/specs/a']}>
          <AskProvider deps={deps}>
            <AskView />
          </AskProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return screen.getByLabelText('Question') as HTMLTextAreaElement;
}

describe('Ask composer', () => {
  it('Enter sends the question with the context chips to the ask tool; Shift+Enter does not', () => {
    const callTool = vi.fn(() => new Promise(() => undefined));
    const q = mount(ok, { callTool: callTool as never, onNotification: () => () => undefined });
    const send = screen.getByLabelText('Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(q, { target: { value: ' why? ' } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(q, { key: 'Enter', shiftKey: true });
    expect(callTool).not.toHaveBeenCalled();
    fireEvent.keyDown(q, { key: 'Enter' });
    expect(callTool).toHaveBeenCalledWith('ask', expect.objectContaining({ question: 'why?', context: expect.any(Array) }), expect.anything(), expect.objectContaining({ retry: false }));
    expect(q.value).toBe('');
    expect(screen.getByText('why?')).toBeTruthy();
    expect(screen.getByLabelText('Stop')).toBeTruthy();
  });
  it('the stop button cancels the request', async () => {
    let signal: AbortSignal | undefined;
    const callTool = vi.fn((_n: string, _a: unknown, s?: AbortSignal) => new Promise((_, rej) => { signal = s; s?.addEventListener('abort', () => rej(new Error('aborted'))); }));
    const q = mount(ok, { callTool: callTool as never, onNotification: () => () => undefined });
    fireEvent.change(q, { target: { value: 'hi' } });
    fireEvent.keyDown(q, { key: 'Enter' });
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText(/Stopped/)).toBeTruthy();
  });
  it('shows context suggestions that fill the field', () => {
    const q = mount(ok);
    fireEvent.click(screen.getByText("What's blocking it?"));
    expect(q.value).toBe("What's blocking it?");
    expect(suggestionsFor([])).toContain('Which specs are blocked?');
  });
  it('is a disabled field with the configuration note when no model is set', () => {
    const q = mount({ configured: false, default: null, models: [], missing: ['provider', 'model'] });
    expect(q.disabled).toBe(true);
    expect(screen.getByText(/configure a model in/)).toBeTruthy();
    expect(screen.queryByText("What's blocking it?")).toBeNull();
  });
});

describe('Ask model picker', () => {
  const sendWith = (q: HTMLTextAreaElement, text: string) => {
    fireEvent.change(q, { target: { value: text } });
    fireEvent.keyDown(q, { key: 'Enter' });
  };
  it('sends with the server default, shows its label, and lists unconfigured models disabled', async () => {
    const callTool = vi.fn(() => new Promise(() => undefined));
    const q = mount(three, { callTool: callTool as never, onNotification: () => () => undefined });
    const picker = screen.getByLabelText('Model: GPT-6 Luna');
    sendWith(q, 'one');
    expect(callTool).toHaveBeenLastCalledWith('ask', expect.objectContaining({ question: 'one', model: 'luna' }), expect.anything(), expect.anything());
    fireEvent.click(picker);
    const off = await screen.findByText('Off model');
    expect(off.closest('button')?.disabled ?? off.closest('[data-disabled]') !== null).toBe(true);
  });
  it('remembers the choice per browser and sends it', async () => {
    const callTool = vi.fn(() => new Promise(() => undefined));
    mount(three, { callTool: callTool as never, onNotification: () => () => undefined });
    fireEvent.click(screen.getByLabelText('Model: GPT-6 Luna'));
    fireEvent.click(await screen.findByText('Claude Haiku 5.5'));
    await waitFor(() => expect(screen.getByLabelText('Model: Claude Haiku 5.5')).toBeTruthy());
    expect(window.localStorage.getItem('mandate.ask.model')).toBe('haiku');
    cleanup();
    const q = mount(three, { callTool: callTool as never, onNotification: () => () => undefined });
    expect(screen.getByLabelText('Model: Claude Haiku 5.5')).toBeTruthy();
    sendWith(q, 'two');
    expect(callTool).toHaveBeenLastCalledWith('ask', expect.objectContaining({ model: 'haiku' }), expect.anything(), expect.anything());
  });
  it('falls back to the default (or the first configured model) when the choice is not usable', () => {
    expect(effectiveModel(three, 'off')).toBe('luna');
    expect(effectiveModel(three, 'gone')).toBe('luna');
    expect(effectiveModel(three, null)).toBe('luna');
    expect(effectiveModel({ ...three, default: 'off' }, null)).toBe('luna');
    expect(effectiveModel({ ...three, models: [model('off', 'Off', false)], configured: false }, null)).toBeUndefined();
  });
  it('hides the configuration note while any model is configured', () => {
    mount({ ...three, default: 'off' });
    expect(screen.queryByText(/configure a model in/)).toBeNull();
  });
  it('shows a tiny model label on each answer', () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <AnswerView result={{ conversationId: 'c', answer: 'hi', embeds: [], references: [], toolCalls: [], usage: { inputTokens: 1, outputTokens: 2 }, stopReason: 'done', provider: 'openai-compatible', model: 'claude-haiku-5.5', modelId: 'haiku', modelLabel: 'Claude Haiku 5.5' }} />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(screen.getByTestId('answer-model').textContent).toBe('Claude Haiku 5.5');
  });
});

describe('SearchField', () => {
  it('renders button and input variants with the same shell class', () => {
    const { container } = render(
      <MantineProvider>
        <SearchField variant="button" label="Search" keys={['⌘', 'K']} onClick={() => undefined} />
        <SearchField variant="input" value="" onChange={() => undefined} ariaLabel="x" />
      </MantineProvider>,
    );
    expect(container.querySelectorAll('.search-trigger.search-field')).toHaveLength(2);
  });
});
