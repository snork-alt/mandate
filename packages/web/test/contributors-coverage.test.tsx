// @vitest-environment jsdom
/**
 * Contributors coverage (plans/contributors-coverage.md): every element kind's detail view / section header / preview
 * shows a contributors stack. `contributors` is mocked to return one direct contributor for any ref.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodeRef, buildCommentRef, buildCommitRef, buildFindingRef, buildNodeUri, buildPrRef, buildRef, type AuditFinding, type Section } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { DocPage, SectionBlock } from '../src/components/doc';
import { AcceptanceCard } from '../src/components/doc/Acceptance';
import { RuleCard } from '../src/components/rules/RuleParts';
import { FindingCard } from '../src/components/audits/parts';
import { RefChip } from '../src/components/refs/RefChip';
import { sectionTarget } from '../src/lib/refs';
import '../src/components/doc/types';

installDom();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
const asked = new Set<string>();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { refs?: string[]; logins?: string[] }) => {
    if (name === 'contributors') {
      for (const r of args.refs ?? []) asked.add(r);
      return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, [{ user: 'carol', userRecorded: true, kind: 'direct', roles: ['edited'], count: 1, lastAt: new Date().toISOString(), agents: ['claude-code'] }]])) };
    }
    if (name === 'users_resolve') return { users: [] };
    if (name === 'graph_node') throw Object.assign(new Error('unknown'), { code: 'unknown_node' });
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  asked.clear();
});

const server: AuthStatus = { authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login', mode: 'server' };
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={server}>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );
const sec = (o: Partial<Section> & { id: string; type: string }): Section => ({ title: o.id, body: 'Body.', refs: [], symbols: [], links: [], verifiedBy: [], ...o }) as unknown as Section;
const stackIn = async (el: () => HTMLElement) => waitFor(() => expect(within(el()).getByTestId('avatar-stack')).toBeTruthy());

describe('detail views: every document kind shows its contributors (header)', () => {
  for (const kind of ['specs', 'standards', 'components', 'audits', 'work-orders', 'feedback'] as const) {
    it(kind, async () => {
      wrap(<DocPage doc={{ kind, id: 'x1', title: 'X' }} header={<h1>X</h1>} sections={[]} history={{ entries: [], loading: false, now: Date.now() }} lineageRef={null} />);
      await stackIn(() => screen.getByTestId('doc-people'));
      expect(asked.has(buildRef({ kind, id: 'x1' }))).toBe(true);
    });
  }
});

describe('section headers', () => {
  it('spec / component / audit-item sections (SectionBlock)', async () => {
    for (const kind of ['specs', 'components', 'audits'] as const) {
      const s = sec({ id: 'intro', type: 'markdown' });
      wrap(<SectionBlock section={s} target={sectionTarget(kind, 'x1', s)} />);
      await stackIn(() => document.querySelector('.section-people') as HTMLElement);
      expect(asked.has(buildRef({ kind, id: 'x1', sectionId: 'intro' }))).toBe(true);
      cleanup();
    }
  });
  it('standard rule sections (RuleCard)', async () => {
    const s = sec({ id: 'r1', type: 'rule', level: 'must' } as never);
    wrap(<RuleCard section={s} target={sectionTarget('standards', 'sec', s)} />);
    await stackIn(() => document.querySelector('.rule-people') as HTMLElement);
  });
  it('acceptance criteria and their verification records', async () => {
    const s = sec({ id: 'ac1', type: 'acceptance' });
    const record = { id: 'v-01', criterion: '', result: 'pass', code: { repo: 'app', commit: 'a'.repeat(40) }, evidence: {}, by: 'claude-code', byUser: 'carol', at: new Date().toISOString() };
    wrap(<AcceptanceCard section={s} target={sectionTarget('specs', 'x1', s)} state={{ state: 'verified', last: record, history: [record] } as never} />);
    await stackIn(() => document.querySelector('.criterion-head .section-people') as HTMLElement);
    await stackIn(() => screen.getByTestId('verification-people'));
    expect(asked.has(buildNodeUri({ kind: 'verifications', id: 'v-01' }))).toBe(true);
  });
});

describe('findings, comments, commits, PRs and code refs', () => {
  it('finding cards', async () => {
    const f = { id: 'f1', uri: buildFindingRef({ audit: 'a1', id: 'f1' }), audit: 'a1', title: 'Finding', severity: 'major', classification: 'code_deviates', description: '', codeRefs: [], ref: '', section: 's', itemTitle: 'Item', kind: 'criterion', level: 'must', status: 'open', resolution: { status: 'open' }, rechecks: [] } as unknown as AuditFinding;
    wrap(<FindingCard f={f} />);
    await stackIn(() => screen.getByTestId('finding-people'));
    expect(asked.has(f.uri)).toBe(true);
  });
  for (const [label, uri] of [
    ['commit', buildCommitRef('b'.repeat(40))],
    ['pull request', buildPrRef({ repo: 'app', number: 412 })],
    ['code range', buildCodeRef({ repo: 'app', path: 'src/auth/session.ts', lines: '10-40' })],
    ['comment', buildCommentRef('c-01')],
  ] as const) {
    it(`${label} chip preview (RefChip hover, also used by Ask answers)`, async () => {
      wrap(<RefChip to={uri} resolve={false} />);
      fireEvent.mouseEnter(document.querySelector('.ref-chip-rich')!);
      await stackIn(() => screen.getByTestId('ref-people'));
      expect(asked.has(uri)).toBe(true);
    });
  }
});
