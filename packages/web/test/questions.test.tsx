// @vitest-environment jsdom
/** Questions from coding agents: answer cards (recommended preselected, multiSelect, payloads, Ctrl+Enter, access), answer-all, activity titles, settings control. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRef, type Decision, type Question } from '@mandate/shared';
import { installDom } from './dom';
import { QuestionGroup } from '../src/components/questions/QuestionGroup';
import { buildAnswers } from '../src/components/questions/QuestionCard';
import { recommendedAnswers } from '../src/lib/questions';
import { eventTitle } from '../src/lib/activity';
import { refHref } from '../src/components/refs/kinds';
import type { ActivityEvent } from '../src/components/activity/types';

beforeAll(installDom);

let canDecide = true;
const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'decision_access') return { canDecide, mode: 'server', user: 'ada', override: { ok: false, why: '' } };
    return {};
  }),
  callRootTool: vi.fn(async () => ({ items: [] })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  canDecide = true;
});

const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const ask = (id: string, o: Partial<Question> = {}): Question => ({
  id,
  uri: `mandate://questions/${id}`,
  asker: { agent: 'claude-code@mbp', user: 'ada' },
  context: [SPEC],
  purpose: 'decision',
  blocking: true,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  status: 'open',
  questions: [
    { id: 'q1', header: 'Auth method', question: 'Which login method should the API use?', options: [{ label: 'OAuth', description: 'Delegated login' }, { label: 'API key', description: 'Static secret' }], recommended: 'OAuth', multiSelect: false },
    { id: 'q2', header: 'Providers', question: 'Which providers?', options: [{ label: 'Google', description: 'Workspace' }, { label: 'GitHub', description: 'Org SSO' }, { label: 'Okta', description: 'Enterprise' }], recommended: ['Google', 'GitHub'], multiSelect: true },
  ],
  ...o,
});
const item = (q: Question): Decision => ({ kind: 'question', ref: q.uri, title: q.questions[0]!.header, question: q.questions[0]!.question, options: [], ask: q, since: q.createdAt });

function mount(qs: Question[]) {
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <QuestionGroup items={qs.map(item)} title={`Questions from agents · ${qs.length}`} />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const answerCall = () => calls.filter((c) => c.name === 'question_answer');

describe('question cards', () => {
  it('preselects the recommended option, labels it, and uses checkboxes for multiSelect', async () => {
    mount([ask('ask-0001')]);
    const card = await screen.findByTestId('question-ask-0001');
    const q1 = within(card).getByTestId('q-item-q1');
    expect((within(q1).getByRole('radio', { name: /OAuth/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(q1).getByRole('radio', { name: /API key/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(q1).getByRole('radio', { name: /Other/ })).toBeTruthy();
    expect(within(q1).getByText('Recommended')).toBeTruthy();
    expect(within(q1).getByText('Delegated login')).toBeTruthy();
    const q2 = within(card).getByTestId('q-item-q2');
    expect(within(q2).queryAllByRole('radio')).toHaveLength(0);
    const boxes = within(q2).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    expect(within(card).getByText('Blocking')).toBeTruthy();
    expect(within(card).getByText('Decision')).toBeTruthy();
  });

  it('submits the chosen answers (labels, label lists, free text) with notes', async () => {
    mount([ask('ask-0001')]);
    const card = await screen.findByTestId('question-ask-0001');
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByRole('checkbox', { name: /GitHub/ }));
    fireEvent.click(within(card).getByRole('checkbox', { name: /Okta/ }));
    fireEvent.click(within(card).getByRole('radio', { name: /Other/ }));
    expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(true); // "Other" needs text
    fireEvent.change(within(card).getByLabelText('Your answer to Auth method'), { target: { value: 'Passkeys' } });
    fireEvent.click(within(card).getByText('Add a note'));
    fireEvent.change(within(card).getByTestId('q-notes'), { target: { value: 'Keep it simple' } });
    fireEvent.click(within(card).getByTestId('q-submit'));
    await waitFor(() => expect(answerCall()).toEqual([{ name: 'question_answer', args: { id: 'ask-0001', answers: { q1: 'Passkeys', q2: ['Google', 'Okta'] }, notes: 'Keep it simple' } }]));
  });

  it('Ctrl+Enter submits the focused card', async () => {
    mount([ask('ask-0001'), ask('ask-0002')]);
    const card = await screen.findByTestId('question-ask-0002');
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    const radio = within(card).getByRole('radio', { name: /API key/ });
    fireEvent.click(radio);
    fireEvent.keyDown(radio, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(answerCall()).toEqual([{ name: 'question_answer', args: { id: 'ask-0002', answers: { q1: 'API key', q2: ['Google', 'GitHub'] } } }]));
  });

  it('"Answer all recommended" answers every open question with its recommendations after a confirmation', async () => {
    mount([ask('ask-0001'), ask('ask-0002', { questions: [{ id: 'q1', header: 'Retry', question: 'Retry failed jobs?', options: [{ label: 'Yes', description: 'Up to 3 times' }, { label: 'No', description: 'Fail fast' }], recommended: 'No', multiSelect: false }] })]);
    await waitFor(() => expect((screen.getByTestId('q-answer-all') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('q-answer-all'));
    expect(answerCall()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('q-answer-all-confirm'));
    await waitFor(() =>
      expect(answerCall().map((c) => c.args)).toEqual([
        { id: 'ask-0001', answers: { q1: 'OAuth', q2: ['Google', 'GitHub'] } },
        { id: 'ask-0002', answers: { q1: 'No' } },
      ]),
    );
  });

  it('without write access: read-only with the reason', async () => {
    canDecide = false;
    mount([ask('ask-0001')]);
    expect(await screen.findByText(/needs write \(push\) access/)).toBeTruthy();
    expect((screen.getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('q-answer-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /API key/ }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('question helpers', () => {
  it('recommended answers and the answer payload', () => {
    const q = ask('ask-0001');
    expect(recommendedAnswers(q)).toEqual({ q1: 'OAuth', q2: ['Google', 'GitHub'] });
    expect(buildAnswers(q.questions, { q1: { choice: 'API key', other: '', multi: [] }, q2: { choice: '', other: '', multi: [] } })).toBeNull();
  });
  it('activity titles and links', () => {
    const e = (type: string, details: Record<string, unknown> = {}): ActivityEvent => ({ id: '1', type, at: new Date().toISOString(), agent: 'claude-code', summary: 'claude-code asked ask-0001', refs: ['mandate://questions/ask-0001', SPEC], details }) as unknown as ActivityEvent;
    expect(eventTitle(e('question.asked', { header: 'Auth method' }))).toBe('Asked question: Auth method');
    expect(eventTitle(e('question.answered'))).toBe('Answered question ask-0001');
    expect(eventTitle(e('question.cancelled', { title: 'Retry' }))).toBe('Withdrew question: Retry');
    expect(refHref('mandate://questions/ask-0001')).toBe('/questions/ask-0001');
  });
});
