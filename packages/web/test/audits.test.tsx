// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditIndicator, buildFindingRef, buildRef, type Audit, type AuditFinding, type AuditSummary, type LastAudit, type LevelCounts, type SpecAudits, type StandardAudits } from '@mandate/shared';
import { installDom } from './dom';
import { AuditIndicator, AuditsPanel, ComplianceView, LastAuditLine } from '../src/components/audits/panels';
import { AuditDetailPage } from '../src/pages/AuditPages';
import { activityRenderers } from '../src/components/activity/renderers';
import { auditHref, sectionHref } from '../src/lib/links';
import { refHref } from '../src/components/refs/kinds';
import { lastAuditTone, matchesAuditFilter } from '../src/lib/audits';
import { sortItems } from '../src/components/SortMenu';
import { KIND_LABEL } from '../src/lib/specs';
import '../src/components/doc/types';

installDom();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };

const SHA = 'b'.repeat(40);
const AUDIT = '2026-11-12-login-sso';
const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const AUDIT_URI = buildRef({ kind: 'audits', id: AUDIT });
const now = Date.now();
const ago = (days: number) => new Date(now - days * 864e5).toISOString();

const lc = (o: Partial<LevelCounts> = {}): LevelCounts => ({ pass: 0, fail: 0, partial: 0, n_a: 0, pending: 0, ...o });
const counts = { must: lc({ pass: 3, fail: 1 }), should: lc({ pass: 1, partial: 1 }), may: lc() };
const findingsCount = { open: 2, resolved: 1, wont_fix: 0, total: 3, openMust: 1, openShould: 1, openMay: 0 };

const finding = (id: string, o: Partial<AuditFinding> = {}): AuditFinding => ({
  id,
  uri: buildFindingRef({ audit: AUDIT, id }),
  audit: AUDIT,
  title: `Finding ${id}`,
  severity: 'major',
  classification: 'code_deviates',
  description: 'Session tokens are not rotated after login.',
  evidence: 'const token = old;',
  codeRefs: ['app:src/auth/session.ts#L10-L40'],
  ref: buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'rotate' }),
  section: 'rotate-token',
  itemTitle: 'Rotate the session token',
  kind: 'criterion',
  level: 'must',
  status: 'open',
  resolution: { status: 'open' },
  rechecks: [],
  ...o,
});

const summary = (id: string, o: Partial<AuditSummary> = {}): AuditSummary => ({
  id,
  uri: buildRef({ kind: 'audits', id }),
  target: SPEC,
  targetKind: 'spec',
  targetTitle: 'Login with SSO',
  status: 'completed',
  at: ago(3),
  startedAt: ago(3),
  completedAt: ago(3),
  auditor: { agent: 'codex', user: 'octocat' },
  commit: SHA,
  code: { repo: 'app', commit: 'c'.repeat(40) },
  summary: 'Two gaps in session handling.',
  outcome: 'fail',
  counts,
  findings: findingsCount,
  stale: true,
  staleReasons: ['Criterion rotate changed'],
  commitsSince: 5,
  ...o,
});

const specAudits: SpecAudits = {
  latest: summary(AUDIT),
  history: [summary(AUDIT), summary('2026-10-01-login-sso', { outcome: 'pass', at: ago(40), stale: false, findings: { ...findingsCount, open: 0, openMust: 0, openShould: 0 } })],
  findings: [
    finding('f1', { resolution: { status: 'open', workOrder: 'wo-0042', workOrderStatus: 'in_progress' } }),
    finding('f2', { severity: 'minor', level: 'should', classification: 'ambiguous', resolution: { status: 'open', feedback: 'fb-0007', feedbackStatus: 'open' } }),
    finding('f3', { status: 'resolved', resolution: { status: 'resolved', commit: 'd'.repeat(40) }, rechecks: [{ at: ago(1), by: 'codex', result: 'pass', commit: 'd'.repeat(7) }] }),
  ],
};

const last = (o: Partial<LastAudit> = {}): LastAudit => ({
  id: AUDIT,
  uri: AUDIT_URI,
  at: ago(3),
  auditor: { agent: 'codex' },
  result: 'fail',
  openFindings: 2,
  openMust: 1,
  openShould: 1,
  stale: false,
  commitsSince: 0,
  ...o,
});

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string) => {
    if (name === 'graph_node') throw Object.assign(new Error('unknown node'), { code: 'unknown_node' });
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

const auditView: Audit = {
  id: AUDIT,
  uri: AUDIT_URI,
  target: SPEC,
  targetKind: 'spec',
  targetTitle: 'Login with SSO',
  commit: SHA,
  code: { repo: 'app', commit: 'c'.repeat(40), branch: 'main' },
  auditor: { agent: 'codex', user: 'octocat' },
  startedAt: ago(4),
  completedAt: ago(3),
  status: 'completed',
  summary: 'Two gaps in session handling.',
  items: [
    {
      sectionId: 'rotate-token',
      uri: buildRef({ kind: 'audits', id: AUDIT, sectionId: 'rotate-token' }),
      ref: buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'rotate' }),
      kind: 'criterion',
      level: 'must',
      title: 'Rotate the session token',
      result: 'fail',
      findings: [finding('f1', { resolution: { status: 'open', workOrder: 'wo-0042', workOrderStatus: 'pending' } })],
    },
  ],
  counts,
  findings: findingsCount,
  outcome: 'fail',
  staleness: { stale: true, reasons: ['Criterion rotate changed'], commitsSince: 5 },
};

vi.mock('../src/api', () => ({
  api: {
    list: vi.fn(async () => []),
    history: vi.fn(async () => []),
    raw: vi.fn(async () => ''),
    get: vi.fn(async (_kind: string, id: string) => ({
      id,
      title: 'Audit of Login with SSO',
      summary: 'Two gaps in session handling.',
      target: SPEC,
      commit: SHA,
      code: { repo: 'app', commit: 'c'.repeat(40), branch: 'main' },
      auditor: { agent: 'codex', user: 'octocat' },
      status: 'completed',
      startedAt: ago(4),
      completedAt: ago(3),
      lastCommit: SHA,
      sections: [
        { id: 'overview', title: 'Overview', type: 'markdown', body: 'Scope: the login flow. Assessment: mostly sound.', refs: [], symbols: [], links: [], verifiedBy: [] },
        {
          id: 'rotate-token',
          title: 'Rotate the session token',
          type: 'audit-item',
          body: 'Read session.ts; the token is reused after login.',
          refs: [],
          symbols: [],
          links: [],
          verifiedBy: [],
          ref: buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'rotate' }),
          kind: 'criterion',
          level: 'must',
          result: 'fail',
          findings: [{ id: 'f1', title: 'Finding f1', severity: 'major', classification: 'code_deviates', description: 'Session tokens are not rotated after login.', suggestedFix: 'Call `rotate()` after login.', codeRefs: ['app:src/auth/session.ts#L10-L40'] }],
        },
      ],
      audit: auditView,
    })),
  },
}));

function R({ children, scheme, path = '/' }: { children: React.ReactNode; scheme: 'light' | 'dark'; path?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider forceColorScheme={scheme}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}
afterEach(cleanup);

describe.each(['light', 'dark'] as const)('audits UI (%s)', (scheme) => {
  it('spec Audits panel: latest, counts per level, findings by status, history and links', () => {
    const { container } = render(
      <R scheme={scheme}>
        <AuditsPanel audits={specAudits} />
      </R>,
    );
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe(scheme);
    const panel = screen.getByRole('region', { name: 'Audits' });
    expect(within(panel).getAllByText('Open must findings').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Stale · 5 commits since')).toBeTruthy();
    // counts table: must row with 1 fail
    const must = within(panel).getByRole('rowheader', { name: 'Must' }).closest('tr')!;
    expect(must.querySelector('td[data-result="fail"]')!.textContent).toBe('1');
    // findings grouped by status
    const groups = [...container.querySelectorAll('.audit-finding-group')].map((g) => g.getAttribute('data-status'));
    expect(groups).toEqual(['open', 'resolved']);
    expect(container.querySelector('#finding-f1 [data-severity="major"]')).toBeTruthy();
    expect(within(panel).getByText('wo-0042').closest('a')!.getAttribute('href')).toBe('/work-orders/wo-0042');
    expect(within(panel).getByText('fb-0007').closest('a')!.getAttribute('href')).toBe('/requests/fb-0007');
    expect(within(panel).getByText('Re-checks')).toBeTruthy();
    // history + trend link to the audit pages
    expect(container.querySelectorAll('.audit-history a')).toHaveLength(2);
    expect(container.querySelector(`.audit-trend a[href="/audits/${AUDIT}"]`)).toBeTruthy();
    expect(container.querySelector('.audit-spark')).toBeTruthy();
  });

  it('spec Audits panel: never audited', () => {
    render(
      <R scheme={scheme}>
        <AuditsPanel audits={{ latest: null, history: [], findings: [] }} />
      </R>,
    );
    expect(screen.getByText(/Never audited/)).toBeTruthy();
  });

  it('spec header line and row indicator tones', () => {
    const { container } = render(
      <R scheme={scheme}>
        <LastAuditLine last={last({ stale: true, commitsSince: 5 })} />
        <LastAuditLine last={null} />
        <AuditIndicator last={last()} />
        <AuditIndicator last={last({ result: 'warn', openMust: 0 })} />
        <AuditIndicator last={last({ result: 'pass', openFindings: 0, stale: true, commitsSince: 2 })} />
        <AuditIndicator last={last({ result: 'pass', openFindings: 0 })} />
        <AuditIndicator last={null} />
      </R>,
    );
    const line = container.querySelector('a.audit-line')!;
    expect(line.getAttribute('href')).toBe(`/audits/${AUDIT}`);
    expect(line.textContent).toMatch(/Last audited .* by codex\s*· 2 open findings\s*· stale \(5 commits since\)/);
    expect(screen.getByText('Never audited')).toBeTruthy();
    const tones = [...container.querySelectorAll('.audit-indicator')].map((e) => e.getAttribute('data-tone'));
    expect(tones).toEqual(['fail', 'warn', 'stale', 'pass', 'none']);
    expect(screen.getByLabelText('Never audited')).toBeTruthy();
    expect(container.querySelectorAll('.audit-indicator')[0]!.textContent).toBe('3d');
  });

  it('standard page: audits panel + compliance (rows x rules, cells link to the audit)', () => {
    const rules = [
      { ref: buildRef({ kind: 'standards', id: 'sec', sectionId: 'r1' }), title: 'Rotate tokens', level: 'must' as const },
      { ref: buildRef({ kind: 'standards', id: 'sec', sectionId: 'r2' }), title: 'Log auth events', level: 'should' as const },
    ];
    const audits: StandardAudits = {
      latest: summary('2026-11-01-sec', { target: buildRef({ kind: 'standards', id: 'sec' }), targetKind: 'standard', outcome: 'pass', stale: false }),
      history: [summary('2026-11-01-sec', { outcome: 'pass', stale: false })],
      findings: [finding('f1', { audit: '2026-11-01-sec', uri: buildFindingRef({ audit: '2026-11-01-sec', id: 'f1' }) })],
      compliance: {
        rules,
        rows: [
          { subject: SPEC, kind: 'spec', title: 'Login with SSO', audit: summary(AUDIT), results: { [rules[0]!.ref]: 'fail', [rules[1]!.ref]: 'pass' }, openFindings: { [rules[0]!.ref]: 2 } },
          { subject: buildRef({ kind: 'standards', id: 'sec' }), kind: 'standard', title: 'Security', audit: summary('2026-11-01-sec', { stale: false }), results: { [rules[1]!.ref]: 'partial' }, openFindings: {} },
        ],
      },
    };
    const { container } = render(
      <R scheme={scheme}>
        <AuditsPanel audits={audits} kind="standard" />
        <ComplianceView audits={audits} />
      </R>,
    );
    const rows = container.querySelectorAll('.compliance-table tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/specs/login-sso');
    expect(rows[0]!.querySelector('td.verif-cell a')!.getAttribute('href')).toBe(`/audits/${AUDIT}`);
    expect(rows[1]!.querySelector('td.verif-cell')!.textContent).toBe('not audited');
    expect([...rows[0]!.querySelectorAll('td.verif-cell')].map((c) => c.getAttribute('data-result'))).toEqual(['fail', 'pass']);
    expect(rows[0]!.querySelector('.compliance-open')!.textContent).toBe('2');
    expect([...rows[1]!.querySelectorAll('td.verif-cell')].map((c) => c.getAttribute('data-result'))).toEqual(['none', 'partial']);
    expect(screen.getByText('Whole standard')).toBeTruthy();
    // the standard's own audits panel: latest, findings, history
    const panel = screen.getByRole('region', { name: 'Audits' });
    expect(within(panel).getByText('History · 1')).toBeTruthy();
    expect(panel.querySelector('#finding-f1')).toBeTruthy();
  });

  it('audit detail page: document view, header, item sections with findings and copyable references', { timeout: 20000 }, async () => {
    const { container } = render(
      <R scheme={scheme} path={`/audits/${AUDIT}`}>
        <Routes>
          <Route path="/audits/:id" element={<AuditDetailPage />} />
        </Routes>
      </R>,
    );
    await screen.findByRole('heading', { name: 'Audit of Login with SSO' }, { timeout: 8000 });
    expect(screen.getAllByText('Open must findings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Stale · 5 commits since').length).toBeGreaterThan(0);
    expect(screen.getByText(/app@ccccccc \(main\)/)).toBeTruthy();
    // audit-item: result accent, prose, finding with suggested fix, code ref and fix work order (joined from the derived view)
    expect(container.querySelector('.audit-item-badge[data-result="fail"]')).toBeTruthy();
    await screen.findByText(/the token is reused after login/, undefined, { timeout: 8000 });
    const f1 = await waitFor(() => {
      const el = container.querySelector('.audit-item-body #finding-f1');
      if (!el) throw new Error('no finding');
      return el as HTMLElement;
    }, { timeout: 8000 });
    expect(within(f1).getByText('Suggested fix')).toBeTruthy();
    expect(within(f1).getByText('wo-0042').closest('a')!.getAttribute('href')).toBe('/work-orders/wo-0042');
    expect(f1.textContent).toMatch(/session\.ts/);
    // copy menus: the audit header and every finding carry an @mandate reference button
    expect(screen.getAllByRole('button', { name: 'Copy reference to this audit' }).length).toBeGreaterThan(0);
    expect(within(f1).getByRole('button', { name: 'Copy reference to this finding' })).toBeTruthy();
  });
});

describe('audit helpers', () => {
  it('links: audits are documents, findings open the audit page at their anchor', () => {
    const f = buildFindingRef({ audit: AUDIT, id: 'f2' });
    expect(sectionHref(AUDIT_URI)).toBe(`/audits/${AUDIT}`);
    expect(auditHref(f)).toBe(`/audits/${AUDIT}#finding-f2`);
    expect(sectionHref(f)).toBe(`/audits/${AUDIT}#finding-f2`);
    expect(refHref(AUDIT_URI)).toBe(`/audits/${AUDIT}`);
    expect(refHref(`@mandate:${f}`)).toBe(`/audits/${AUDIT}#finding-f2`);
  });

  it('tone, filter and "last audited" sort', () => {
    expect(lastAuditTone({ result: 'pass', stale: true })).toBe('stale');
    expect(lastAuditTone({ result: 'fail', stale: true })).toBe('fail');
    const specs = [
      { title: 'b', updatedAt: '', createdAt: '', versionCount: 0, lastAudit: last({ at: ago(1), openFindings: 0 }) },
      { title: 'a', updatedAt: '', createdAt: '', versionCount: 0, lastAudit: null },
      { title: 'c', updatedAt: '', createdAt: '', versionCount: 0, lastAudit: last({ at: ago(9), stale: true }) },
    ];
    expect(sortItems(specs, 'audited').map((s) => s.title)).toEqual(['a', 'c', 'b']);
    expect(specs.filter((s) => matchesAuditFilter(s, ['never'])).map((s) => s.title)).toEqual(['a']);
    expect(specs.filter((s) => matchesAuditFilter(s, ['outdated'])).map((s) => s.title)).toEqual([]);
    expect(specs.filter((s) => matchesAuditFilter(s, ['findings'])).map((s) => s.title)).toEqual(['c']);
    expect(specs.filter((s) => matchesAuditFilter(s, ['passed'])).map((s) => s.title)).toEqual(['b']);
    expect(auditIndicator(last({ stale: true, openFindings: 0, openMust: 0, openShould: 0 }))).toBe('outdated');
    expect(KIND_LABEL.fix).toBe('Fix');
  });

  it('activity renderers cover the five audit event types', () => {
    const base = { id: 'x:0', commit: SHA, at: ago(0), refs: [AUDIT_URI, SPEC], summary: 'audit event' };
    for (const [type, details] of [
      ['audit.started', { title: 'Login with SSO' }],
      ['audit.item_recorded', { title: 'Login with SSO', result: 'fail', level: 'must', findings: 1 }],
      ['audit.completed', { title: 'Login with SSO', outcome: 'warn', findings: 2 }],
      ['audit.abandoned', { title: 'Login with SSO' }],
      ['audit.finding_resolved', { title: 'Login with SSO', status: { from: 'open', to: 'resolved' }, severity: 'major' }],
    ] as const) {
      const key = Object.keys(activityRenderers).find((k) => k === type || (k.endsWith('.*') && type.startsWith(k.slice(0, -1))));
      expect(key, type).toBe('audit.*');
      const { container, unmount } = render(
        <R scheme="light">
          <>{activityRenderers[key!]!({ ...base, type, details } as never)}</>
        </R>,
      );
      // The panel header shows the event sentence; bodies never repeat the summary.
      expect(container.textContent).not.toContain('audit event');
      if (type === 'audit.item_recorded') expect(container.textContent).toMatch(/fail.*must.*1 finding/);
      if (type === 'audit.finding_resolved') expect(container.textContent).toMatch(/open.*resolved.*major/);
      unmount();
    }
  });
});
