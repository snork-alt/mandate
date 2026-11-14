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
import { buildAnswers, QuestionSummary, readAnswer } from '../src/components/questions/QuestionCard';
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

const pressed = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true';

describe('question cards', () => {
  it('preselects the recommended option, marks it, and uses toggle buttons for multiSelect', async () => {
    mount([ask('ask-0001')]);
    const card = await screen.findByTestId('question-ask-0001');
    const q1 = within(card).getByTestId('q-item-q1');
    expect(pressed(within(q1).getByRole('radio', { name: /OAuth/ }))).toBe(true);
    expect(within(q1).getByRole('radio', { name: 'OAuth (recommended)' })).toBeTruthy();
    expect(pressed(within(q1).getByRole('radio', { name: /API key/ }))).toBe(false);
    expect(within(q1).getByRole('radio', { name: /Other/ })).toBeTruthy();
    // The selected option's description on one line, with the Recommended mark.
    expect(within(q1).getByText('Recommended')).toBeTruthy();
    expect(within(q1).getByText('Delegated login')).toBeTruthy();
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(q1).getByRole('radio', { name: /API key/ }));
    expect(within(q1).getByText('Static secret')).toBeTruthy();
    expect(within(q1).queryByText('Recommended')).toBeNull();
    const q2 = within(card).getByTestId('q-item-q2');
    expect(within(q2).queryAllByRole('radio')).toHaveLength(0);
    expect(within(q2).getAllByRole('checkbox').map(pressed)).toEqual([true, true, false]);
    expect(within(card).getByText('Blocking')).toBeTruthy();
    expect(within(card).getByText('Decision')).toBeTruthy();
    // Legacy question (no title / badge / evidence): the header is the title, the question text the detail.
    expect(within(q1).getByText('Auth method')).toBeTruthy();
    expect(within(q1).getByTestId('qa-detail').textContent).toBe('Which login method should the API use?');
    expect(within(q1).queryByTestId('qa-evidence')).toBeNull();
    expect(within(q1).queryByTestId('qa-more')).toBeNull();
    expect(within(card).getByTestId('q-progress').textContent).toContain('2 of 2');
  });

  it('A layout: title, badge, header, clamped detail with More, evidence files with conform / violate counts', async () => {
    const long = 'Every mutating route requires an `Idempotency-Key` (16-128 printable ASCII) and runs through the shared `idemFor(deps)` builder or `idempotentReply`, scoped per (caller, operation, key); a replay returns the stored response.';
    const std = ask('ask-0003', {
      purpose: 'standard_confirmation',
      questions: [
        {
          id: 'q1',
          header: 'Idempotency',
          title: 'Idempotent mutating routes',
          badge: 'MUST',
          question: long,
          evidence: [{ ref: 'mandate://code/app/src/http/idempotency.ts', conforming: 13, violating: 0 }, { ref: 'app:src/app.ts#L127-L139', conforming: 0, violating: 1 }],
          options: [{ label: 'Approve', description: 'Create as written' }, { label: 'Edit', description: 'Create after the change in notes' }, { label: 'Skip', description: 'Do not create' }],
          recommended: 'Approve',
          multiSelect: false,
        },
        { id: 'q2', header: 'Pagination', title: 'Keyset pagination', badge: 'MUST', question: 'List endpoints use cursors.', options: [{ label: 'Approve', description: 'Create as written' }, { label: 'Skip', description: 'Do not create' }], recommended: 'Approve', multiSelect: false },
      ],
    });
    mount([std]);
    const card = await screen.findByTestId('question-ask-0003');
    const q1 = within(card).getByTestId('q-item-q1');
    expect(within(q1).getByText('Idempotent mutating routes')).toBeTruthy();
    expect(within(q1).getByText('MUST')).toBeTruthy();
    expect(within(q1).getByText('Idempotency')).toBeTruthy();
    expect(within(card).getByText('Confirm a standard')).toBeTruthy();
    const detail = within(q1).getByTestId('qa-detail');
    expect(detail.getAttribute('data-clamped')).toBe('true');
    expect(within(detail).getByText('Idempotency-Key').tagName).toBe('CODE');
    fireEvent.click(within(q1).getByTestId('qa-more'));
    expect(detail.getAttribute('data-clamped')).toBeNull();
    expect(within(q1).getByTestId('qa-more').textContent).toBe('Less');
    const ev = within(q1).getByTestId('qa-evidence');
    expect(within(ev).getByText('src/http/idempotency.ts')).toBeTruthy();
    expect(within(ev).getByText('src/app.ts#L127-L139')).toBeTruthy();
    expect(within(ev).getByLabelText('13 conform, 1 violate')).toBeTruthy();
    expect(within(card).getByTestId('q-card-answer-all')).toBeTruthy();
  });

  it('Edit reveals a text field; the answer carries the change ("Edit: ...") and Submit waits for it', async () => {
    const std = ask('ask-0004', {
      purpose: 'standard_confirmation',
      questions: [
        { id: 'q1', header: 'Logging', title: 'No secrets in logs', badge: 'MUST', question: 'The logger redacts secrets.', options: [{ label: 'Approve', description: 'Create as written' }, { label: 'Edit', description: 'Create after the change' }, { label: 'Skip', description: 'Do not create' }], recommended: 'Approve', multiSelect: false },
        { id: 'q2', header: 'Pagination', question: 'Keyset pagination?', options: [{ label: 'Approve', description: 'Create as written' }, { label: 'Skip', description: 'Do not create' }], recommended: 'Approve', multiSelect: false },
      ],
    });
    mount([std]);
    const card = await screen.findByTestId('question-ask-0004');
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    expect(within(card).queryByTestId('q-edit-q1')).toBeNull();
    fireEvent.click(within(card).getByRole('radio', { name: 'Edit' }));
    expect(within(card).getByText('What should change? (sent to the coding agent)')).toBeTruthy();
    expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByTestId('q-progress').textContent).toContain('1 of 2');
    fireEvent.change(within(card).getByLabelText('What should change: No secrets in logs'), { target: { value: 'Also mask card numbers.' } });
    expect(within(card).getByTestId('q-progress').textContent).toContain('2 of 2');
    fireEvent.click(within(card).getByTestId('q-submit'));
    await waitFor(() => expect(answerCall()).toEqual([{ name: 'question_answer', args: { id: 'ask-0004', answers: { q1: 'Edit: Also mask card numbers.', q2: 'Approve' } } }]));
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

  it('a single question shows its options as cards (no progress, no per-card answer-all)', async () => {
    mount([ask('ask-0005', { questions: [{ id: 'q1', header: 'Rounding', question: 'Which rounding rule applies to partial refunds?', options: [{ label: 'Half-even', description: 'Matches the ledger' }, { label: 'Half-up', description: 'What the UI shows' }], recommended: 'Half-even', multiSelect: false }] })]);
    const card = await screen.findByTestId('question-ask-0005');
    expect(card.querySelectorAll('.qa-opt-card')).toHaveLength(3);
    expect(within(card).getByText('Matches the ledger')).toBeTruthy();
    expect(within(card).getByText('What the UI shows')).toBeTruthy();
    expect(pressed(within(card).getByRole('radio', { name: 'Half-even (recommended)' }))).toBe(true);
    expect(within(card).queryByTestId('q-progress')).toBeNull();
    expect(within(card).queryByTestId('q-card-answer-all')).toBeNull();
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByRole('radio', { name: 'Half-up' }));
    fireEvent.click(within(card).getByTestId('q-submit'));
    await waitFor(() => expect(answerCall()).toEqual([{ name: 'question_answer', args: { id: 'ask-0005', answers: { q1: 'Half-up' } } }]));
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
    // The confirmation carries the line to tell the coding agent to continue (every id answered), with a copy button.
    const line = 'Your Mandate questions ask-0001, ask-0002 were answered — read them with get and continue.';
    await waitFor(() => expect(screen.getAllByTestId('q-continue').some((n) => n.textContent?.includes(line))).toBe(true));
    const note = screen.getAllByTestId('q-continue').find((n) => n.textContent?.includes(line))!;
    expect(note.textContent).toContain('Tell your coding agent to continue');
    expect(within(note).getByTestId('q-continue-copy')).toBeTruthy();
  });

  it('the card\'s "Answer all recommended" answers that question only', async () => {
    mount([ask('ask-0001'), ask('ask-0002')]);
    const card = await screen.findByTestId('question-ask-0002');
    await waitFor(() => expect((within(card).getByTestId('q-card-answer-all') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByTestId('q-card-answer-all'));
    fireEvent.click(await screen.findByTestId('q-card-answer-all-confirm'));
    await waitFor(() => expect(answerCall().map((c) => c.args)).toEqual([{ id: 'ask-0002', answers: { q1: 'OAuth', q2: ['Google', 'GitHub'] } }]));
  });

  it('after one answer: the continue line for that question', async () => {
    mount([ask('ask-0001')]);
    const card = await screen.findByTestId('question-ask-0001');
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByTestId('q-submit'));
    await waitFor(() => expect(screen.getAllByTestId('q-continue').some((n) => n.textContent?.includes('Your Mandate question ask-0001 was answered — read it with get and continue.'))).toBe(true));
  });

  it('without write access: read-only with the reason', async () => {
    canDecide = false;
    mount([ask('ask-0001')]);
    expect(await screen.findByText(/needs write \(push\) access/)).toBeTruthy();
    expect((screen.getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('q-answer-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('q-card-answer-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /API key/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('answered summary', () => {
  const mountSummary = (q: Question) =>
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ul>
              <QuestionSummary q={q} />
            </ul>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
  it('compact read-only rows: title, badge, the answer as a pill; Edit / Other text quoted; notes', () => {
    const q = ask('ask-0006', {
      status: 'answered',
      purpose: 'standard_confirmation',
      questions: [
        { id: 'q1', header: 'Idempotency', title: 'Idempotent mutating routes', badge: 'MUST', question: 'x'.repeat(300), options: [{ label: 'Approve', description: 'a' }, { label: 'Edit', description: 'b' }], recommended: 'Approve', multiSelect: false },
        { id: 'q2', header: 'Logging', title: 'No secrets in logs', badge: 'MUST', question: 'y', options: [{ label: 'Approve', description: 'a' }, { label: 'Edit', description: 'b' }], recommended: 'Approve', multiSelect: false },
        { id: 'q3', header: 'Auth', question: 'Which auth?', options: [{ label: 'OAuth', description: 'a' }, { label: 'Key', description: 'b' }], recommended: 'OAuth', multiSelect: false },
      ],
      answer: { by: { agent: 'mandate-ui', user: 'matteo' }, at: new Date().toISOString(), answers: { q1: 'Approve', q2: 'Edit: Also mask card numbers.', q3: 'Passkeys' }, notes: 'Thanks', via: 'ui' },
    });
    mountSummary(q);
    const card = screen.getByTestId('question-summary-ask-0006');
    expect(within(card).getByText('Answered')).toBeTruthy();
    expect(within(within(card).getByTestId('q-row-q1')).getByTestId('q-answer-pill').textContent).toBe('Approved');
    expect(within(within(card).getByTestId('q-row-q2')).getByTestId('q-answer-pill').textContent).toBe('Edited');
    expect(within(card).getByText('Also mask card numbers.')).toBeTruthy();
    expect(within(within(card).getByTestId('q-row-q3')).getByTestId('q-answer-pill').textContent).toBe('Other');
    expect(within(card).getByText('Passkeys')).toBeTruthy();
    expect(within(card).getAllByText('MUST')).toHaveLength(2);
    expect(within(card).queryByTestId('qa-detail')).toBeNull(); // answered rows stay compact
    expect(within(card).getByText('Thanks')).toBeTruthy();
    expect(card.textContent).toContain('answered by');
  });
  it('withdrawn: the reason and the question text', () => {
    mountSummary(ask('ask-0007', { status: 'cancelled', cancelled: { by: { agent: 'claude-code' }, at: new Date().toISOString(), reason: 'decided by the spec' } }));
    const card = screen.getByTestId('question-summary-ask-0007');
    expect(within(card).getByText('Withdrawn')).toBeTruthy();
    expect(within(card).getByText('Withdrawn: decided by the spec')).toBeTruthy();
    expect(within(card).getAllByTestId('qa-detail')).toHaveLength(2);
  });
});

describe('question helpers', () => {
  it('recommended answers and the answer payload', () => {
    const q = ask('ask-0001');
    expect(recommendedAnswers(q)).toEqual({ q1: 'OAuth', q2: ['Google', 'GitHub'] });
    expect(buildAnswers(q.questions, { q1: { choice: 'API key', other: '', multi: [] }, q2: { choice: '', other: '', multi: [] } })).toBeNull();
    expect(buildAnswers(q.questions, { q1: { choice: 'API key', other: '', multi: [] }, q2: { choice: '', other: '', multi: ['Okta'] } })).toEqual({ q1: 'API key', q2: ['Okta'] });
    expect(readAnswer(q.questions[0]!, 'OAuth')).toEqual({ label: 'OAuth', text: null });
    expect(readAnswer(q.questions[0]!, 'Passkeys')).toEqual({ label: null, text: 'Passkeys' });
  });
  it('activity titles and links', () => {
    const e = (type: string, details: Record<string, unknown> = {}): ActivityEvent => ({ id: '1', type, at: new Date().toISOString(), agent: 'claude-code', summary: 'claude-code asked ask-0001', refs: ['mandate://questions/ask-0001', SPEC], details }) as unknown as ActivityEvent;
    expect(eventTitle(e('question.asked', { header: 'Auth method' }))).toBe('Asked question: Auth method');
    expect(eventTitle(e('question.answered'))).toBe('Answered question ask-0001');
    expect(eventTitle(e('question.cancelled', { title: 'Retry' }))).toBe('Withdrew question: Retry');
    expect(refHref('mandate://questions/ask-0001')).toBe('/questions/ask-0001');
  });
});
