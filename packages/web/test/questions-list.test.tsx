// @vitest-environment jsdom
/** Questions list page (/questions): Open | Answered tabs, filters, rows, navigation; the open-questions badge on the sidebar Questions item. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRef, type Question } from '@mandate/shared';
import { installDom } from './dom';
import { QuestionsListPage } from '../src/pages/QuestionsListPage';
import { AskProvider, useAsk } from '../src/components/ask/AskProvider';
import { AskView } from '../src/components/ask/AskView';
import { RailProvider, useRail } from '../src/components/rail/RailProvider';
import { QuestionSummary } from '../src/components/questions/QuestionCard';
import { AppLayout } from '../src/components/AppLayout';

beforeAll(installDom);

const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const WO = buildRef({ kind: 'work-orders', id: 'wo-0001' });
const ask = (id: string, o: Partial<Question> = {}): Question => ({
  id,
  uri: `mandate://questions/${id}`,
  asker: { agent: 'claude-code@mbp', user: 'ada', client: 'cli-a' },
  context: [SPEC],
  purpose: 'decision',
  blocking: true,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  status: 'open',
  questions: [{ id: 'q1', header: 'Auth method', question: 'Which login method should the API use?', options: [{ label: 'OAuth', description: 'Delegated' }, { label: 'API key', description: 'Static' }], recommended: 'OAuth', multiSelect: false }],
  ...o,
});
const at = new Date(Date.now() - 600_000).toISOString();
let OPEN: Question[] = [];
let CLOSED: Question[] = [];
let openCount = 0;
const calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'decision_access') return { canDecide: true, mode: 'server', user: 'ada', override: { ok: false, why: '' } };
    if (name === 'list' && args.of === 'decisions') return { items: [], total: openCount, counts: { question: openCount } };
    if (name === 'list' && args.of === 'questions') {
      const items = args.status === 'open' ? OPEN : args.status === 'all' ? [...OPEN, ...CLOSED] : CLOSED;
      return { items, total: items.length };
    }
    if (name === 'question_answer') {
      OPEN = OPEN.filter((x) => x.id !== args.id);
      return { ok: true };
    }
    if (name === 'activity_list') return { events: [] };
    if (name === 'agents_presence') return { agents: [] };
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({ items: [] })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  OPEN = [];
  CLOSED = [];
  openCount = 0;
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function mount(path = '/questions') {
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/questions" element={<QuestionsListPage />} />
            <Route path="/questions/:id" element={<div data-testid="question-page" />} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('questions list page', () => {
  it('Open tab: every open question as an answer card, grouped by purpose with counts; blocking first; page answer-all', async () => {
    OPEN = [
      ask('ask-0002', { blocking: false, createdAt: new Date(Date.now() - 60_000).toISOString() }),
      ask('ask-0001', { purpose: 'approval', blocking: false, context: [WO] }),
      ask('ask-0004'),
      ask('ask-0006', { purpose: 'other', blocking: false }),
    ];
    CLOSED = [ask('ask-0003', { status: 'answered', answer: { by: { agent: 'mandate-ui', user: 'ada' }, at, answers: { q1: 'OAuth' }, via: 'ui' } })];
    mount();
    const groups = await screen.findByTestId('q-open-groups');
    // Approvals, then Decisions, then Other (order of PURPOSE_GROUP); no empty groups.
    const sections = within(groups).getAllByRole('region');
    expect(sections.map((x) => x.getAttribute('aria-label'))).toEqual(['Approvals', 'Decisions', 'Other']);
    const dec = screen.getByTestId('q-group-decision');
    expect(within(dec).getByTestId('q-group-count').textContent).toBe('2');
    // Blocking (older) before the newer non-blocking one.
    const cards = within(dec).getAllByTestId(/^question-ask-/);
    expect(cards.map((c) => c.dataset.testid)).toEqual(['question-ask-0004', 'question-ask-0002']);
    // The answer card in place: choices, Submit, copy-ref and the question page link.
    expect(within(cards[0]!).getByRole('radio', { name: 'OAuth (recommended)' })).toBeTruthy();
    expect(within(cards[0]!).getByTestId('q-submit')).toBeTruthy();
    expect(within(cards[0]!).getByLabelText(/Copy reference/)).toBeTruthy();
    expect(within(cards[0]!).getByTestId('q-open-page').getAttribute('href')).toBe('/questions/ask-0004');
    expect(screen.queryByTestId('question-ask-0003')).toBeNull();
    expect(screen.getByTestId('q-answer-all')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Open 4')).toBeTruthy());
    expect(screen.getByText('Answered 1')).toBeTruthy();
    // Collapsing a group hides its cards.
    fireEvent.click(within(dec).getByTestId('q-group-toggle'));
    expect(within(dec).queryByTestId('question-ask-0004')).toBeNull();
  });

  it('Group by: what it is about (element title + link) and agent, kept in the URL', async () => {
    OPEN = [ask('ask-0001', { context: [WO] }), ask('ask-0002'), ask('ask-0005', { context: [], asker: { agent: 'codex@box' } })];
    mount();
    await screen.findByTestId('q-open-groups');
    fireEvent.click(within(screen.getByTestId('q-group-by')).getByText("What it's about"));
    await waitFor(() => expect(screen.getByTestId('q-open-groups').dataset.groupBy).toBe('about'));
    expect(screen.getByTestId('where').textContent).toBe('/questions?group=about');
    const wo = screen.getByTestId(`q-group-${WO}`);
    expect(within(wo).getByTestId('question-ask-0001')).toBeTruthy();
    expect(within(wo).getByTestId('q-group-link').getAttribute('href')).toBe('/work-orders/wo-0001');
    expect(within(screen.getByTestId(`q-group-${SPEC}`)).getByTestId('question-ask-0002')).toBeTruthy();
    expect(within(screen.getByTestId('q-group-~none')).getByTestId('question-ask-0005')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('q-group-by')).getByText('Agent'));
    await waitFor(() => expect(screen.getByTestId('q-open-groups').dataset.groupBy).toBe('agent'));
    expect(within(screen.getByTestId('q-group-codex@box')).getByTestId('question-ask-0005')).toBeTruthy();
    expect(within(screen.getByTestId('q-group-claude-code@mbp')).getAllByTestId(/^question-ask-/)).toHaveLength(2);
  });

  it("a group's Answer all recommended answers only that group's questions", async () => {
    OPEN = [ask('ask-0001', { purpose: 'approval' }), ask('ask-0002'), ask('ask-0004')];
    mount();
    const btn = (await screen.findByTestId('q-group-answer-all-decision')) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    fireEvent.click(await screen.findByTestId('q-group-answer-all-decision-confirm'));
    await waitFor(() => expect(calls.filter((c) => c.name === 'question_answer')).toHaveLength(2));
    expect(calls.filter((c) => c.name === 'question_answer').map((c) => c.args.id).sort()).toEqual(['ask-0002', 'ask-0004']);
    // Both shown as answered in place; the approval still open.
    expect(await screen.findByTestId('question-summary-ask-0002')).toBeTruthy();
    expect(screen.getByTestId('question-summary-ask-0004')).toBeTruthy();
    expect(screen.getByTestId('question-ask-0001')).toBeTruthy();
  });

  it('answering in place collapses the card to the answered summary with the continue line', async () => {
    OPEN = [ask('ask-0001'), ask('ask-0002')];
    mount();
    const card = await screen.findByTestId('question-ask-0001');
    await waitFor(() => expect((within(card).getByTestId('q-submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByRole('radio', { name: 'API key' }));
    fireEvent.click(within(card).getByTestId('q-submit'));
    const sum = await screen.findByTestId('question-summary-ask-0001');
    expect(calls.find((c) => c.name === 'question_answer')?.args).toMatchObject({ id: 'ask-0001', answers: { q1: 'API key' } });
    expect(within(sum).getByTestId('q-continue')).toBeTruthy();
    expect(within(sum).getByTestId('q-answer-pill').textContent).toContain('API key');
    expect(screen.queryByTestId('question-ask-0001')).toBeNull();
    expect(screen.getByTestId('question-ask-0002')).toBeTruthy();
  });

  it('many questions: a page of cards per group with Show more', async () => {
    OPEN = Array.from({ length: 25 }, (_, i) => ask(`ask-${String(100 + i).padStart(4, '0')}`));
    mount();
    const dec = await screen.findByTestId('q-group-decision');
    expect(within(dec).getAllByTestId(/^question-ask-/)).toHaveLength(20);
    fireEvent.click(within(dec).getByTestId('q-group-more'));
    expect(within(dec).getAllByTestId(/^question-ask-/)).toHaveLength(25);
  });

  it('switches to Answered: answer summary, closed status marks, Status filter, no answer-all', async () => {
    OPEN = [ask('ask-0001')];
    CLOSED = [
      ask('ask-0003', { status: 'answered', answer: { by: { agent: 'mandate-ui', user: 'ada' }, at, answers: { q1: 'API key' }, notes: 'keep it simple', via: 'ui' } }),
      ask('ask-0004', { status: 'cancelled', cancelled: { by: { agent: 'claude-code@mbp' }, at, reason: 'decided by the spec' } }),
    ];
    mount();
    await screen.findByTestId('question-ask-0001');
    fireEvent.click(within(screen.getByTestId('q-tabs')).getByText(/^Answered/));
    expect(await screen.findByTestId('q-row-ask-0003')).toBeTruthy();
    expect(screen.queryByTestId('q-row-ask-0001')).toBeNull();
    expect(screen.getByText(/Answer: API key — keep it simple/)).toBeTruthy();
    expect(screen.getByText('Withdrawn: decided by the spec')).toBeTruthy();
    expect(screen.getByLabelText('Withdrawn')).toBeTruthy();
    expect(screen.queryByTestId('q-answer-all')).toBeNull();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/questions?tab=answered');
  });

  it('filters by purpose, asker and context from the URL', async () => {
    OPEN = [
      ask('ask-0001', { purpose: 'approval' }),
      ask('ask-0002', { asker: { agent: 'codex@box', client: 'cli-b' }, context: [WO] }),
      ask('ask-0005', { context: [] }),
    ];
    mount('/questions?purpose=approval');
    expect(await screen.findByTestId('question-ask-0001')).toBeTruthy();
    expect(screen.queryByTestId('question-ask-0002')).toBeNull();
    cleanup();
    mount('/questions?by=agent:codex@box');
    expect(await screen.findByTestId('question-ask-0002')).toBeTruthy();
    expect(screen.queryByTestId('question-ask-0001')).toBeNull();
    cleanup();
    mount('/questions?by=client:cli-b');
    expect(await screen.findByTestId('question-ask-0002')).toBeTruthy();
    expect(screen.queryByTestId('question-ask-0005')).toBeNull();
    cleanup();
    mount(`/questions?about=${encodeURIComponent(WO)}`);
    expect(await screen.findByTestId('question-ask-0002')).toBeTruthy();
    expect(screen.queryByTestId('question-ask-0001')).toBeNull();
    cleanup();
    mount('/questions?about=~none');
    expect(await screen.findByTestId('question-ask-0005')).toBeTruthy();
    expect(screen.queryByTestId('question-ask-0002')).toBeNull();
    // Nothing matches: the filtered empty state, and Clear resets the filters.
    cleanup();
    mount('/questions?purpose=clarification');
    expect(await screen.findByText('No matching questions')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear'));
    expect(await screen.findByTestId('question-ask-0001')).toBeTruthy();
  });

  it('Answered tab: a row opens the question page; a context chip opens the element', async () => {
    CLOSED = [ask('ask-0003', { status: 'answered', context: [WO], answer: { by: { agent: 'mandate-ui' }, at, answers: { q1: 'OAuth' }, via: 'ui' } })];
    mount('/questions?tab=answered');
    fireEvent.click(await screen.findByTestId('q-row-ask-0003'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/questions/ask-0003'));
    cleanup();
    mount('/questions?tab=answered');
    const row = (await screen.findByTestId('q-row-ask-0003')).closest('a')!;
    fireEvent.click(within(row).getAllByTestId('q-context-chip').find((c) => !c.closest('[aria-hidden]'))!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/work-orders/wo-0001'));
  });

  it('empty states per tab', async () => {
    mount();
    expect(await screen.findByText('No open questions')).toBeTruthy();
    cleanup();
    mount('/questions?tab=answered');
    expect(await screen.findByText('No answered questions yet')).toBeTruthy();
  });
});

const idleAsk = { callTool: (() => new Promise(() => undefined)) as never, onNotification: () => () => undefined };
const railDeps = { subscribe: () => () => undefined, list: async () => ({ events: [] }), watchConnection: () => () => undefined };

function Probe() {
  const { chips } = useAsk();
  const rail = useRail();
  return <div data-testid="probe">{`${rail.activeTab}|${chips.map((c) => `${c.kind}:${c.uri}`).join(',')}`}</div>;
}

function mountAsk(node: React.ReactNode, path = '/questions') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['agents-presence', ''], { agents: [] });
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <RailProvider activity={railDeps}>
            <AskProvider deps={idleAsk}>
              {node}
              <Probe />
            </AskProvider>
          </RailProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('questions in the Ask pane', () => {
  it('the Add picker finds questions by id and text and adds the question chip', async () => {
    OPEN = [ask('ask-0007', { questions: [{ id: 'q1', header: 'Session', question: 'How long should remember-me last?', options: [{ label: '30 days', description: '' }, { label: '7 days', description: '' }], recommended: '30 days', multiSelect: false }] })];
    mountAsk(<AskView />);
    fireEvent.click(screen.getByLabelText('Add context'));
    fireEvent.change(screen.getByLabelText('Add context', { selector: 'input' }), { target: { value: 'remember' } });
    const opt = await screen.findByRole('option', { name: /remember-me/ });
    expect(within(opt).getByText('Question')).toBeTruthy();
    fireEvent.click(opt);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('question:mandate://questions/ask-0007'));
    expect(calls.some((c) => c.name === 'list' && c.args.of === 'questions' && c.args.status === 'all')).toBe(true);
  });

  it('"Ask about this" on a question adds its chip and opens the Ask tab', async () => {
    mountAsk(<QuestionSummary q={ask('ask-0003')} />);
    fireEvent.click(screen.getByTestId('q-ask-about'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ask|question:mandate://questions/ask-0003'));
  });

  it('without the app shell (no Ask / rail providers) the action is not shown', () => {
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <QuestionSummary q={ask('ask-0003')} />
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(screen.queryByTestId('q-ask-about')).toBeNull();
  });
});

describe('sidebar', () => {
  it('Waiting for you: badge of what only you can do, links to /waiting; no Actions item; Overview: no badge', async () => {
    openCount = 3;
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<div />} />
                <Route path="waiting" element={<div data-testid="questions-route" />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    const item = screen.getByTestId('nav-waiting-item');
    expect(within(item).getByText('Waiting for you')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.name === 'list' && c.args.of === 'decisions')).toBe(true));
    expect((await within(item).findByTestId('nav-waiting')).textContent).toBe('3');
    expect(within(screen.getByTestId('nav-overview')).queryByTestId('nav-waiting')).toBeNull();
    // The Actions page was merged into Waiting for you: no Actions item; Overview has no badge.
    expect(screen.queryByTestId('nav-actions-item')).toBeNull();
    expect(screen.getByTestId('nav-overview').querySelector('.nav-count-alert')).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByTestId('questions-route')).toBeTruthy();
  });
});
