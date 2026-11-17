// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRef, OVERLAY_TONE, STEP_TONE, MATURITY_STEPS, type MaturityOverlayKind, type MaturityStep, type Spec, type SpecMaturity } from '@mandate/shared';
import { installDom } from './dom';
import { MaturityBadge, MaturityDetails } from '../src/components/maturity/MaturityBadge';
import { compareMaturity, componentMaturity, matchesMaturityFilter } from '../src/lib/maturity';
import { sortItems } from '../src/components/SortMenu';

installDom();
vi.mock('../src/mcp/client', () => ({ callTool: vi.fn(async () => ({})), McpToolError: class extends Error {}, onNotification: () => () => undefined, onConnectionChange: () => () => undefined }));

const LABEL: Record<MaturityStep, string> = { draft: 'Draft', specified: 'Specified', in_progress: 'In progress · 3/5', implemented: 'Implemented' };
const mat = (step: MaturityStep, overlays: MaturityOverlayKind[] = [], o: Partial<SpecMaturity> = {}): SpecMaturity => ({
  step,
  stepIndex: MATURITY_STEPS.indexOf(step) + 1,
  label: LABEL[step],
  tone: overlays[0] ? OVERLAY_TONE[overlays[0]] : STEP_TONE[step],
  sections: { implemented: 3, total: 5, inProgress: 1 },
  criteria: { total: 4, verified: 2, waived: 1, failing: 1, stale: 1, unverified: 0 },
  audit: null,
  overlays: overlays.map((k) => ({ kind: k, reason: `${k} because`, refs: [buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'ac-1' })] })),
  storedStatus: 'done',
  ...o,
});

function R({ children, scheme = 'light' }: { children: React.ReactNode; scheme?: 'light' | 'dark' }) {
  return (
    <MantineProvider forceColorScheme={scheme}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}
afterEach(cleanup);

describe.each(['light', 'dark'] as const)('maturity badge (%s)', (scheme) => {
  it.each(MATURITY_STEPS)('step %s: tone, meter fill and label', (step) => {
    const { container } = render(<R scheme={scheme}><MaturityBadge m={mat(step)} /></R>);
    const b = container.querySelector('.maturity-badge')!;
    expect(b.getAttribute('data-tone')).toBe(STEP_TONE[step]);
    expect(b.querySelectorAll('.maturity-seg[data-on]')).toHaveLength(MATURITY_STEPS.indexOf(step) + 1);
    expect(b.textContent).toContain(LABEL[step]);
    expect(b.querySelector('.maturity-marker')).toBeNull();
  });

  it.each(['failing', 'outdated', 'blocked', 'archived'] as const)('overlay %s: overlay tone + marker, step label kept', (k) => {
    const { container } = render(<R scheme={scheme}><MaturityBadge m={mat('implemented', [k, 'outdated'].filter((x, i, a) => a.indexOf(x) === i) as MaturityOverlayKind[])} /></R>);
    const b = container.querySelector('.maturity-badge')!;
    expect(b.getAttribute('data-tone')).toBe(OVERLAY_TONE[k]);
    expect(b.textContent).toContain('Implemented');
    expect(b.querySelector('.maturity-marker')!.getAttribute('data-kind')).toBe(k);
    expect(b.getAttribute('aria-label')).toMatch(new RegExp(k, 'i'));
  });
});

describe('maturity details (hover breakdown)', () => {
  it('lists sections, criteria, audit, overlays with links and stored vs derived status', () => {
    const m = mat('implemented', ['failing', 'blocked'], {
      audit: { id: 'a1', uri: buildRef({ kind: 'audits', id: 'a1' }), at: new Date().toISOString(), auditor: { agent: 'codex' }, result: 'warn', openFindings: 2, openMust: 0, openShould: 2, stale: true, commitsSince: 3 },
    });
    const { container } = render(<R><MaturityDetails m={m} /></R>);
    const t = container.textContent!;
    expect(t).toContain('3/5 implemented · 1 in progress');
    expect(t).toContain('2/4 verified (failing 1, stale 1, waived 1)');
    expect(t).toMatch(/2 open findings · stale/);
    expect(t).toContain('failing because');
    expect(t).toContain('blocked because');
    expect(container.querySelector('a.maturity-ref')!.getAttribute('href')).toBe('/specs/login-sso#section-ac-1');
    // The stored status is only a secondary detail: "Set by the author".
    expect(t).toContain('Set by the author: Done');
    expect(t).not.toContain('Stored status');
    expect(screen.getAllByText(/Failing|Blocked/).length).toBeGreaterThanOrEqual(2);
  });

  it('never audited, no gating criteria', () => {
    const { container } = render(<R><MaturityDetails m={mat('draft', [], { criteria: { total: 0, verified: 0, waived: 0, failing: 0, stale: 0, unverified: 0 }, storedStatus: 'draft' })} /></R>);
    expect(container.textContent).toContain('Never audited');
    expect(container.textContent).toContain('none gating');
  });
});

describe('maturity filter, sort and component roll-up', () => {
  const spec = (id: string, m?: SpecMaturity, affects: string[] = []) =>
    ({ id, title: id, updatedAt: '', createdAt: '', versionCount: 0, maturity: m, sections: [{ id: 's', links: affects.map((c) => ({ rel: 'affects', to: buildRef({ kind: 'components', id: c }) })) }] }) as unknown as Spec;
  const specs = [spec('a', mat('implemented')), spec('b', mat('draft')), spec('c', mat('implemented', ['failing'])), spec('d', mat('in_progress', ['blocked'])), spec('e', mat('implemented', ['archived'])), spec('f')];

  it('filters by step or overlay', () => {
    expect(specs.filter((s) => matchesMaturityFilter(s, ['implemented'])).map((s) => s.id)).toEqual(['a', 'c', 'e']);
    expect(specs.filter((s) => matchesMaturityFilter(s, ['failing', 'draft'])).map((s) => s.id)).toEqual(['b', 'c']);
    expect(specs.filter((s) => matchesMaturityFilter(s, [])).length).toBe(6);
  });

  it('sorts overlays first (worst first), archived last, then by step', () => {
    expect([...specs].sort(compareMaturity).map((s) => s.id)).toEqual(['c', 'd', 'f', 'b', 'a', 'e']);
    expect(sortItems(specs, 'maturity').map((s) => s.id)).toEqual(['c', 'd', 'f', 'b', 'a', 'e']);
  });

  it('component: least mature step, worst overlay of the specs affecting it (archived ignored)', () => {
    const list = [spec('a', mat('implemented'), ['auth']), spec('c', mat('implemented', ['outdated']), ['auth', 'db']), spec('e', mat('draft', ['archived']), ['auth'])];
    const cm = componentMaturity(list, ['auth'])!;
    expect(cm.step).toBe('implemented');
    expect(cm.overlay).toBe('outdated');
    expect(cm.tone).toBe('orange');
    expect(cm.specs.map((s) => s.id)).toEqual(['a', 'c']);
    expect(componentMaturity(list, ['billing'])).toBeNull();
    expect(componentMaturity([spec('a', mat('implemented'), ['db'])], ['parent', 'db'])!.tone).toBe('blue');
  });
});

describe('maturity badge: accessible, focusable breakdown (X5)', () => {
  it('the badge is an image with a name; the trigger is a focusable button opening the card on Enter, Space and click', async () => {
    render(<R><MaturityBadge m={mat('implemented', ['failing'])} /></R>);
    const badge = document.querySelector('.maturity-badge')!;
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Maturity: Implemented · Failing');
    const trigger = screen.getByTestId('maturity-trigger');
    expect(trigger.getAttribute('role')).toBe('button');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('maturity-stored').textContent).toBe('Set by the author: Done'));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(trigger, { key: ' ' });
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    // A click (tap) toggles it too, and does not bubble to an enclosing row link.
    const onRow = vi.fn();
    cleanup();
    render(<R><div onClick={onRow}><MaturityBadge m={mat('implemented')} /></div></R>);
    fireEvent.click(screen.getByTestId('maturity-trigger'));
    await waitFor(() => expect(screen.getByTestId('maturity-stored')).toBeTruthy());
    expect(onRow).not.toHaveBeenCalled();
  });
});
