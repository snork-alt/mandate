// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNodeUri, buildRef, type CommentThread, type ResolvedWorkOrder, type TouchedFile } from '@mandate/shared';
import { installDom } from './dom';
import { WorkOrderPage } from '../src/pages/WorkOrderPage';
import { CodeTouched, CommentList, GitPanel, WorkOrderGitSummary } from '../src/components/work-orders/parts';
import { activityRenderers } from '../src/components/activity/renderers';
import '../src/components/doc/types';

installDom();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };

const WO = 'q-0005';
const WO_URI = buildRef({ kind: 'work-orders', id: WO });
const secUri = (sid: string) => buildRef({ kind: 'work-orders', id: WO, sectionId: sid });
const now = new Date().toISOString();

const touched: TouchedFile[] = [
  { repo: 'app', path: 'src/auth/totp.ts', lines: ['12-58'], change: 'modified' },
  { repo: 'app', path: 'src/auth/recovery.ts', change: 'added' },
  { repo: 'app', path: 'src/auth/old-otp.ts', change: 'deleted' },
  { repo: 'app', path: 'src/auth/otp/verify.ts', from: 'src/auth/verify.ts', change: 'renamed' },
];

const threads: CommentThread[] = [
  {
    id: 'c-1',
    uri: buildNodeUri({ kind: 'comments', id: 'c-1' }),
    target: secUri('login-flow'),
    author: { agent: 'review-agent@ci' },
    body: 'TOTP verification has no attempt limit.',
    blocking: true,
    createdAt: now,
    status: 'open',
    events: [],
    replies: [{ id: 'c-2', uri: buildNodeUri({ kind: 'comments', id: 'c-2' }), target: secUri('login-flow'), parent: 'c-1', author: { agent: 'claude-code', user: 'matteo' }, body: 'On it.', createdAt: now }],
  },
  {
    id: 'c-3',
    uri: buildNodeUri({ kind: 'comments', id: 'c-3' }),
    target: WO_URI,
    author: { agent: 'review-agent@ci' },
    body: 'Nit: export the bucket type.',
    createdAt: now,
    status: 'resolved',
    resolvedBy: 'review-agent@ci',
    resolvedAt: now,
    resolveNote: 'Done.',
    events: [{ type: 'resolve', by: 'review-agent@ci', at: now }],
    replies: [],
  },
];

const git = [{ repo: 'app', branch: 'feat/mfa-totp', baseBranch: 'main', commits: ['8d2c41aa90e1'], worktree: { path: '/wt/q-0005', host: 'mbp' }, pr: { number: 42, status: 'open' as const, url: 'https://example.test/pr/42' } }];

const resolved: ResolvedWorkOrder = {
  item: {
    id: WO,
    spec: 'mfa-totp',
    specCommit: 'a'.repeat(40),
    kind: 'review',
    status: 'in_progress',
    sections: [
      { id: 'enrolment-ui', status: 'done' },
      { id: 'login-flow', status: 'pending' },
    ],
    reason: [],
    createdAt: now,
    updatedAt: now,
    title: 'Review TOTP multi-factor authentication',
    touched,
    git,
    hasPlan: true,
    claim: { agent: 'review-agent@ci', startedAt: now, heartbeatAt: now } as never,
  },
  spec: { id: 'mfa-totp', title: 'TOTP multi-factor authentication', status: 'ready' } as never,
  sections: [{ id: 'login-flow', status: 'pending', section: { id: 'login-flow', title: 'Login flow', type: 'markdown', body: 'Lock after 5 wrong codes.', refs: [], symbols: [], links: [], verifiedBy: [] } as never, headChanged: false }],
  specMovedTo: null,
  doc: {
    plan: 'Review both sections.',
    reconciliation: '',
    outcome: '',
    sections: [
      { id: 'enrolment-ui', uri: secUri('enrolment-ui'), target: buildRef({ kind: 'specs', id: 'mfa-totp', sectionId: 'enrolment-ui' }), title: 'Enrolment screen', status: 'done', notes: '', verifications: [], codeRefs: [], deviations: [] },
      { id: 'login-flow', uri: secUri('login-flow'), target: buildRef({ kind: 'specs', id: 'mfa-totp', sectionId: 'login-flow' }), title: 'Login flow', status: 'pending', notes: '', verifications: [], codeRefs: [touched[0]!], deviations: [] },
    ],
  },
  comments: { counts: { open: 1, openBlocking: 1, resolved: 1 }, threads },
  claims: [{ agent: 'old-agent', startedAt: now, endedAt: now, ended: 'released' }],
  git,
  touched,
};

const sec = (o: Record<string, unknown>) => ({ refs: [], symbols: [], links: [], verifiedBy: [], body: '', ...o });

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string) => {
    if (name === 'graph_node') throw Object.assign(new Error('unknown node'), { code: 'unknown_node' });
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
vi.mock('../src/api', () => ({
  api: {
    list: vi.fn(async () => []),
    history: vi.fn(async () => []),
    raw: vi.fn(async () => ''),
    get: vi.fn(async () => ({ id: 'mfa-totp', title: 'TOTP', sections: [] })),
    workOrder: vi.fn(async () => resolved),
    comments: vi.fn(async () => ({ target: WO_URI, counts: { open: 1, openBlocking: 1, resolved: 1 }, threads })),
    workOrderDoc: vi.fn(async () => ({
      id: WO,
      title: 'Review TOTP multi-factor authentication',
      spec: 'mfa-totp',
      specCommit: 'a'.repeat(40),
      kind: 'review',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      reason: [],
      lastCommit: 'b'.repeat(40),
      sections: [
        sec({ id: 'plan', title: 'Plan', type: 'markdown', body: 'Review **both** sections.' }),
        sec({ id: 'enrolment-ui', title: 'Enrolment screen', type: 'wo-section', target: buildRef({ kind: 'specs', id: 'mfa-totp', sectionId: 'enrolment-ui' }), status: 'done', body: 'Looks right.', verifications: [buildRef({ kind: 'specs', id: 'mfa-totp', sectionId: 'ac-enrol' })] }),
        sec({ id: 'login-flow', title: 'Login flow', type: 'wo-section', target: buildRef({ kind: 'specs', id: 'mfa-totp', sectionId: 'login-flow' }), status: 'pending', codeRefs: [touched[0]], deviations: ['Lockout is 10 minutes, not 15.'] }),
        sec({ id: 'outcome', title: 'Outcome', type: 'markdown' }),
      ],
      workOrder: resolved,
    })),
  },
}));

function R({ children, scheme = 'light', path = '/' }: { children: React.ReactNode; scheme?: 'light' | 'dark'; path?: string }) {
  return (
    <MantineProvider forceColorScheme={scheme}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}
afterEach(cleanup);

describe.each(['light', 'dark'] as const)('work order page (%s)', (scheme) => {
  it('renders the document: plan, wo-sections with status, notes, code, deviations and inline comments', { timeout: 20000 }, async () => {
    const { container } = render(
      <R scheme={scheme} path={`/work-orders/${WO}`}>
        <Routes>
          <Route path="/work-orders/:id" element={<WorkOrderPage />} />
        </Routes>
      </R>,
    );
    await screen.findByRole('heading', { name: 'Review TOTP multi-factor authentication' }, { timeout: 8000 });
    expect(container.querySelector('.wo-sec-status[data-status="done"]')).toBeTruthy();
    expect(container.querySelector('.wo-sec-status[data-status="pending"]')).toBeTruthy();
    await screen.findByText(/Lockout is 10 minutes/, undefined, { timeout: 8000 });
    expect(screen.getByText(/1 blocking comment/)).toBeTruthy();
    // the blocking thread is inline under its section (anchored) and listed in the rail
    const inline = await waitFor(() => {
      const el = container.querySelector('.wo-sec-body #comment-c-1');
      if (!el) throw new Error('no inline comment');
      return el as HTMLElement;
    }, { timeout: 8000 });
    expect(within(inline).getByText('Blocking')).toBeTruthy();
    expect(within(inline).getByRole('button', { name: 'Copy reference to this comment' })).toBeTruthy();
    expect(container.querySelector('.wo-comment-count[data-blocking]')).toBeTruthy();
    // rail: progress, code tree, git (branch, PR)
    // progress shows in the header status strip and in the rail
    expect(screen.getAllByText('1/2 sections').length).toBe(2);
    // layout (review #9): title first, then the status strip, then the compact dependency panel; empty scaffolding hidden
    const title = screen.getByRole('heading', { name: 'Review TOTP multi-factor authentication' });
    const strip = screen.getByTestId('wo-status-strip');
    expect(title.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.dep-strip-wrap')).toBeNull();
    expect(container.querySelector('#section-outcome')).toBeNull();
    expect(screen.getByTestId('wo-not-written').textContent).toContain('Outcome');
    expect(screen.queryByTestId('wo-plan-missing')).toBeNull();
    expect(container.textContent).not.toContain('No content yet');
    expect(container.textContent).toContain('Not started: the agent writes notes here when the section is done.');
    expect(container.querySelector('.wo-tree-file[data-change="renamed"]')!.textContent).toContain('← src/auth/verify.ts');
    expect(screen.getAllByText(/feat\/mfa-totp/).length).toBeGreaterThan(0);
    expect(container.querySelector('a.wo-pr[data-status="open"]')!.getAttribute('href')).toBe('https://example.test/pr/42');
  });
});

describe('all sections done', () => {
  it('shows Waiting for completion (with the hint) instead of a stale claim and Release claim', async () => {
    const saved = { sections: resolved.item.sections, claim: resolved.item.claim };
    resolved.item.sections = [{ id: 'enrolment-ui', status: 'done' }, { id: 'login-flow', status: 'obsolete' }];
    resolved.item.claim = { agent: 'review-agent@ci', startedAt: now, heartbeatAt: new Date(Date.now() - 50 * 60_000).toISOString() } as never;
    try {
      render(
        <R path={`/work-orders/${WO}`}>
          <Routes>
            <Route path="/work-orders/:id" element={<WorkOrderPage />} />
          </Routes>
        </R>,
      );
      await screen.findByRole('heading', { name: 'Review TOTP multi-factor authentication' }, { timeout: 8000 });
      const strip = screen.getByTestId('wo-status-strip');
      expect(within(strip).getByTestId('wo-waiting-completion').textContent).toContain('Waiting for completion');
      expect(strip.textContent).not.toMatch(/Stale|heartbeat/);
      expect(screen.queryByText('Release claim')).toBeNull();
      expect(strip.querySelector('button[aria-label*="actions" i], [data-testid="item-menu"]')).toBeNull();
    } finally {
      resolved.item.sections = saved.sections;
      resolved.item.claim = saved.claim;
    }
  }, 20000);
});

describe('work-order parts', () => {
  it('comment list: blocking first, resolved collapsed until expanded, replies shown', () => {
    const { container } = render(
      <R>
        <CommentList threads={[threads[1]!, threads[0]!]} workOrderId={WO} showTarget anchor={() => true} />
      </R>,
    );
    const cards = container.querySelectorAll('.wo-thread');
    expect(cards[0]!.getAttribute('data-blocking')).toBe('true');
    expect(cards[1]!.getAttribute('data-status')).toBe('resolved');
    expect(within(cards[0] as HTMLElement).getByText('On it.')).toBeTruthy();
    expect(within(cards[1] as HTMLElement).queryByText('Done.', { exact: false })).toBeNull();
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: /Resolved by review-agent@ci/ }));
    expect(within(cards[1] as HTMLElement).getByText(/Resolved: Done\./)).toBeTruthy();
  });

  it('code touched tree groups by repo and folder, links sections', () => {
    const { container } = render(
      <R>
        <CodeTouched touched={touched} sections={[{ id: 'login-flow', title: 'Login flow', codeRefs: [touched[0]!] }]} />
      </R>,
    );
    expect(container.querySelector('.wo-tree-repo-name')!.textContent).toContain('app');
    expect([...container.querySelectorAll('.wo-change')].map((e) => e.textContent).sort()).toEqual(['A', 'D', 'M', 'R']);
    expect(container.querySelector('a.wo-tree-sec')!.getAttribute('href')).toBe('#section-login-flow');
    expect(container.textContent).toContain('L12-58');
  });

  it('git panel and list summary', () => {
    const { container } = render(
      <R>
        <GitPanel git={git} claims={resolved.claims!} />
        <WorkOrderGitSummary item={{ git }} />
      </R>,
    );
    expect(container.textContent).toContain('mbp:/wt/q-0005');
    expect(container.textContent).toContain('released');
    expect(container.querySelectorAll('.wo-pr')).toHaveLength(2);
    expect(container.querySelector('.wo-list-git .wo-branch')!.textContent).toContain('feat/mfa-totp');
  });

  it('activity renderers for work-order and comment events', () => {
    const base = { id: 'x:0', commit: 'c'.repeat(40), at: now, summary: 'event summary' };
    const cases = [
      ['work_order.plan_set', [WO_URI], { preview: [{ op: 'insert', text: 'the plan' }] }, /the plan/],
      ['work_order.touched', [WO_URI], { files: ['app:src/auth/totp.ts'] }, /app:src\/auth\/totp\.ts/],
      ['work_order.git_updated', [WO_URI], { git }, /feat\/mfa-totp.*#42/],
      ['comment.added', [threads[0]!.uri, secUri('login-flow')], { blocking: true, preview: [{ op: 'insert', text: 'no attempt limit' }] }, /no attempt limit.*blocking/],
      ['comment.resolved', [threads[0]!.uri, secUri('login-flow')], {}, /resolved/],
      ['comment.reopened', [threads[0]!.uri, secUri('login-flow')], {}, /reopened/],
    ] as const;
    for (const [type, refs, details, re] of cases) {
      const r = activityRenderers[type] ?? activityRenderers['comment.*'];
      expect(r, type).toBeTruthy();
      const { container, unmount } = render(<R>{r!({ ...base, type, refs: [...refs], details } as never)}</R>);
      expect(container.textContent).toMatch(re);
      unmount();
    }
  });
});
