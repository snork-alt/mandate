// @vitest-environment jsdom
/** Ask: a provider retry discards the failed step's text (no duplicates); a failed answer offers Retry / another model. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AskEvent, AskResult } from '@mandate/shared';
import { emptyAnswer, reduceAskEvent } from '../src/components/ask/stream';
import { AskTurnView } from '../src/components/ask/AskThread';

afterEach(cleanup);
beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});
const ev = (e: Omit<AskEvent, 'askId'>) => ({ askId: 'a:1', ...e }) as AskEvent;
const result = (o: Partial<AskResult>): AskResult => ({
  conversationId: 'c',
  answer: '',
  embeds: [],
  references: [],
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'done',
  provider: 'openai-compatible',
  model: 'claude-haiku-5.5',
  modelId: 'haiku',
  modelLabel: 'Claude Haiku 5.5',
  ...o,
});

describe('retry events', () => {
  it('discard the partial text of the failed step and show a status line until text resumes', () => {
    let s = emptyAnswer();
    for (const e of [ev({ type: 'text', delta: 'Partial ans' }), ev({ type: 'retry', attempt: 1, max: 2, message: 'Provider interrupted; retrying (1/2)…', text: '' })]) s = reduceAskEvent(s, e);
    expect(s).toMatchObject({ text: '', notice: 'Provider interrupted; retrying (1/2)…' });
    s = reduceAskEvent(s, ev({ type: 'text', delta: 'Full answer' }));
    expect(s.text).toBe('Full answer');
    expect(s.notice).toBeUndefined();
  });

  it('shows the retry status while running', () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <AskTurnView turn={{ id: 1, question: 'q', running: true, state: { ...emptyAnswer(), notice: 'Provider interrupted; retrying (1/2)…' } }} />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(screen.getByRole('status').textContent).toContain('retrying (1/2)');
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });
});

describe('failed answer', () => {
  it('keeps the partial answer and offers Retry and the other configured models', () => {
    const onRetry = vi.fn();
    const r = result({ answer: 'Half an answer', stopReason: 'provider_error', error: { code: 'provider_error', message: 'Claude Haiku 5.5: the provider kept failing (2 retries): socket hang up' } });
    render(
      <MantineProvider>
        <MemoryRouter>
          <AskTurnView
            turn={{ id: 1, question: 'q', running: false, state: { ...emptyAnswer(), text: r.answer, result: r } }}
            onRetry={onRetry}
            otherModels={[
              { id: 'haiku', label: 'Claude Haiku 5.5' },
              { id: 'luna', label: 'GPT-6 Luna' },
            ]}
          />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(screen.getByText('Half an answer')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Claude Haiku 5.5: the provider kept failing');
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenLastCalledWith('haiku');
    expect(screen.queryByText('Try with Claude Haiku 5.5')).toBeNull();
    fireEvent.click(screen.getByText('Try with GPT-6 Luna'));
    expect(onRetry).toHaveBeenLastCalledWith('luna');
  });
});
