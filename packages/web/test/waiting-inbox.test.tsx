// @vitest-environment jsdom
/**
 * Questions bound to requests: the "Waiting for you" inbox (grouped by request, what each blocks, inline answer), the nav
 * without a Questions item (a badge on the inbox item), the old /questions route, block links, and request / work order
 * pages that show the questions waiting on them.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Question } from '@mandate/shared';
import { installDom } from './dom';
import { WaitingPage, groupByRequest } from '../src/pages/WaitingPage';
import { QuestionsRedirect } from '../src/router';
import { AppLayout } from '../src/components/AppLayout';
import { BlockChips } from '../src/components/questions/BlockChips';
import { blockTarget, blockedWorkOrderIds, questionsBlockingWorkOrder, questionsByRequest, waitingRequestIds } from '../src/lib/requestLinks';

beforeAll(installDom);

const ask = (id: string, o: Partial<Question> = {}): Question => ({
  id,
  uri: `mandate://questions/${id}`,
  asker: { agent: 'claude-code@mbp', user: 'ada', client: 'cli-a' },
  context: [],
  purpose: 'decision',
  blocking: false,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  status: 'open',
  questions: [{ id: 'q1', header: 'Auth', question: 'Which login method should the API use?', options: [{ label: 'OAuth', description: 'Delegated' }, { label: 'API key', description: 'Static' }], recommended: 'OAuth', multiSelect: false }],
  ...o,
});

let OPEN: Question[] = [];
const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'decision_access') return { canDecide: true, mode: 'server', user: 'ada', override: { ok: false, why: '' } };
    if (name === 'list' && args.of === 'decisions') return { items: [], total: OPEN.length, counts: { question: OPEN.length } };
    if (name === 'list' && args.of === 'questions') return { items: OPEN, total: OPEN.length };
    if (name === 'list' && args.of === 'requests') return [];
    if (name === 'question_answer') {
      OPEN = OPEN.filter((x) => x.id !== args.id);
      return { ok: true };
    }
    if (name === 'activity_list') return { events: [] };
    if (name === 'agents_presence') return { agents: [] };
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({ items: [] })),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  OPEN = [];
});

let where = '';
function Where() {
  const l = useLocation();
  where = `${l.pathname}${l.search}`;
  return null;
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('pure helpers', () => {
  it('blockTarget names what is blocked', () => {
    expect(blockTarget('mandate://requests/fb-0003')).toMatchObject({ kind: 'request', href: '/requests/fb-0003', label: 'fb-0003' });
    expect(blockTarget('mandate://work-orders/wo-1')).toMatchObject({ kind: 'work-order', href: '/work-orders/wo-1' });
    expect(blockTarget('mandate://work-orders/wo-1/steps/s2')).toMatchObject({ kind: 'step', href: '/work-orders/wo-1', label: 'task s2 of wo-1' });
    expect(blockTarget('mandate://specs/login/sections/session')).toMatchObject({ kind: 'section', href: '/specs/login' });
  });
  it('questions are grouped by request; waiting / blocked sets are derived from open questions only', () => {
    const qs = [
      ask('ask-0001', { request: 'fb-0001', blocks: ['mandate://requests/fb-0001'] }),
      ask('ask-0002', { request: 'fb-0001' }),
      ask('ask-0003', { request: 'fb-0002', blocks: ['mandate://work-orders/wo-9/steps/s1'] }),
      ask('ask-0004'),
      ask('ask-0005', { request: 'fb-0003', status: 'answered' }),
    ];
    const g = groupByRequest(qs);
    expect(g.map((x) => [x.request, x.items.map((q) => q.id)])).toEqual([['fb-0001', ['ask-0001', 'ask-0002']], ['fb-0002', ['ask-0003']], ['~none', ['ask-0004']]]);
    expect([...waitingRequestIds(qs)].sort()).toEqual(['fb-0001', 'fb-0002']);
    expect([...blockedWorkOrderIds(qs)]).toEqual(['wo-9']);
    expect(questionsBlockingWorkOrder(qs, 'wo-9').map((q) => q.id)).toEqual(['ask-0003']);
    expect(questionsByRequest(qs).get('fb-0001')!.map((q) => q.id)).toEqual(['ask-0001', 'ask-0002']);
  });
  it('BlockChips: informational questions say so', () => {
    render(<MemoryRouter><BlockChips q={{}} /></MemoryRouter>);
    expect(screen.getByTestId('q-blocks').textContent).toMatch(/Blocks nothing/);
  });
});

describe('Waiting for you inbox', () => {
  const mount = () =>
    render(
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={client()}>
          <MemoryRouter initialEntries={['/waiting']}>
            <Routes>
              <Route path="/waiting" element={<WaitingPage />} />
              <Route path="*" element={<div data-testid="elsewhere" />} />
            </Routes>
            <Where />
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );

  it('groups open questions by request with what each blocks, and answers inline', async () => {
    OPEN = [
      ask('ask-0001', { request: 'fb-0001', blocks: ['mandate://requests/fb-0001'] }),
      ask('ask-0002', { request: 'fb-0002', blocks: ['mandate://work-orders/wo-3/steps/s1'] }),
      ask('ask-0003'),
    ];
    mount();
    const groups = await screen.findAllByTestId('waiting-group');
    expect(groups.map((g) => g.getAttribute('data-request'))).toEqual(['fb-0001', 'fb-0002', '~none']);
    expect(within(groups[1]!).getByTestId('q-blocks').textContent).toMatch(/task s1 of wo-3/);
    expect(within(groups[2]!).getByTestId('q-blocks').textContent).toMatch(/Blocks nothing/);
    // Inline answer: the recommended option is preselected; submit records it.
    const card = within(groups[0]!).getByTestId('waiting-question');
    fireEvent.click(within(card).getByRole('button', { name: /submit|send|answer/i }));
    await waitFor(() => expect(calls.some((c) => c.name === 'question_answer' && c.args.id === 'ask-0001')).toBe(true));
  });

  it('is empty when nothing waits', async () => {
    mount();
    expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
  });
});

describe('navigation', () => {
  it('no Questions item; "Waiting for you" carries the open count', async () => {
    OPEN = [ask('ask-0001', { request: 'fb-0001' }), ask('ask-0002')];
    render(
      <MantineProvider>
        <QueryClientProvider client={client()}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<div />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(screen.queryByTestId('nav-questions-item')).toBeNull();
    expect(screen.queryByText('Questions')).toBeNull();
    const item = screen.getByTestId('nav-waiting-item');
    expect(within(item).getByText('Waiting for you')).toBeTruthy();
    expect((await within(item).findByTestId('nav-waiting')).textContent).toBe('2');
  });

  it('the old /questions route lands on the inbox (a filtered view on the history list)', () => {
    const go = (path: string) => {
      cleanup();
      render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/questions" element={<QuestionsRedirect />} />
            <Route path="*" element={<div />} />
          </Routes>
          <Where />
        </MemoryRouter>,
      );
      return where;
    };
    expect(go('/questions')).toBe('/waiting');
    expect(go('/questions?tab=answered')).toBe('/waiting/history?tab=answered');
  });
});
