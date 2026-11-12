// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitStatus, IntegrityIssue } from '@mandate/shared';
import { installDom, Wrap } from './dom';

const issues: IntegrityIssue[] = [
  { rule: 'dangling_link', uri: 'mandate://specs/login-sso/sections/callback', message: 'verifiedBy points to a missing section', severity: 'error', hint: 'link an existing target' },
  { rule: 'depends_on_cycle', uri: 'mandate://specs/billing', message: 'billing depends on itself via invoices', severity: 'error' },
  { rule: 'component_no_code', uri: 'mandate://components/auth-service', message: 'auth-service owns no code', severity: 'warning', hint: 'declare owns globs' },
  ...Array.from({ length: 20 }, (_, n) => ({ rule: 'component_unreferenced', uri: `mandate://components/c${n}`, message: `component c${n} is unreferenced`, severity: 'warning' as const })),
];
const status: GitStatus = { branch: 'main', head: '5078efb0123456789', clean: true, files: [], remote: null, integrity: { head: null, at: '2026-11-12T10:00:00Z', issues } };

vi.mock('../src/api', () => ({ api: { gitStatus: async () => status, gitPush: async () => ({}), gitPull: async () => ({}) } }));

const { IntegrityPage, filterIssues, groupIssues } = await import('../src/pages/IntegrityPage');
const { GitStatusControl } = await import('../src/components/GitStatusControl');

installDom();
afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.hash}</div>;
}
function mount(path: string, el: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['git', 'status'], status);
  render(
    <Wrap client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/integrity" element={<IntegrityPage />} />
          <Route path="/sidebar" element={el} />
          <Route path="*" element={<span />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </Wrap>,
  );
}

describe('integrity view (S1)', () => {
  it('lists every issue grouped by severity and kind, with message, hint and element link', () => {
    mount('/integrity', null);
    expect(screen.getAllByTestId('integrity-issue')).toHaveLength(23);
    const errors = screen.getByTestId('integrity-group-error');
    expect(within(errors).getAllByTestId('integrity-issue')).toHaveLength(2);
    expect(within(errors).getByText('Dangling link')).toBeTruthy();
    expect(within(screen.getByTestId('integrity-group-warning')).getAllByTestId('integrity-issue')).toHaveLength(21);
    expect(screen.getByText('verifiedBy points to a missing section')).toBeTruthy();
    expect(screen.getByText('Fix: link an existing target')).toBeTruthy();
    expect(screen.getByTestId('integrity-repo').textContent).toContain('Remote: none');
    fireEvent.click(within(errors).getAllByRole('link')[0]!);
    expect(screen.getByTestId('where').textContent).toBe('/specs/login-sso#section-callback');
  });
  it('filters by severity, kind and text (from the URL)', () => {
    mount('/integrity?severity=warning&kind=component_no_code', null);
    expect(screen.getAllByTestId('integrity-issue')).toHaveLength(1);
    expect(screen.queryByTestId('integrity-group-error')).toBeNull();
    cleanup();
    mount('/integrity?q=billing', null);
    expect(screen.getAllByTestId('integrity-issue')).toHaveLength(1);
    cleanup();
    mount('/integrity?q=nothing-matches', null);
    expect(screen.getByText('No matching issues')).toBeTruthy();
  });
  it('filter and group helpers', () => {
    expect(filterIssues(issues, { severity: ['error'], kind: [], q: '' })).toHaveLength(2);
    expect(filterIssues(issues, { severity: [], kind: [], q: 'OWNS NO' })).toHaveLength(1);
    const g = groupIssues(issues);
    expect(g.map((x) => x.severity)).toEqual(['error', 'warning']);
    expect(g[1]!.rules.map((r) => r.rule)).toEqual(['component_no_code', 'component_unreferenced']);
  });
});

describe('sidebar git box (S1, S2)', () => {
  it('shows the count on its own line and is a focusable button opening the view', () => {
    const onNavigate = vi.fn();
    mount('/sidebar', <GitStatusControl onNavigate={onNavigate} />);
    expect(screen.getByTestId('git-integrity-count').textContent).toContain('23 integrity issues');
    expect(screen.queryByText(/No remote/)).toBeNull();
    const box = screen.getByTestId('git-box');
    expect(box.tagName).toBe('BUTTON');
    expect(box.getAttribute('aria-label')).toContain('23 integrity issues');
    box.focus();
    expect(document.activeElement).toBe(box);
    fireEvent.click(box);
    expect(screen.getByTestId('where').textContent).toBe('/integrity');
    expect(onNavigate).toHaveBeenCalled();
  });
});
