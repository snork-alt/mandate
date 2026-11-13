// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATURITY_STEPS, STEP_TONE, type Spec, type SpecMaturity } from '@mandate/shared';
import { installDom } from './dom';
import { AuthContext, type AuthStatus } from '../src/auth';
import { ChipList, CHIPS_MIN_W, fitChips } from '../src/components/list/ListRow';
import { SpecListHeader, SpecRow, specCols } from '../src/components/SpecRow';
import { SpecListPage } from '../src/pages/SpecListPage';
import { CommandPalette, openCommandPalette } from '../src/components/CommandPalette';

installDom();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { refs?: string[] }) => {
    if (name === 'contributors') return { contributors: Object.fromEntries((args.refs ?? []).map((r) => [r, []])) };
    if (name === 'users_resolve') return { users: [] };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const status: AuthStatus = { authenticated: true, user: null, configured: true, missing: [], callbackUrl: null, loginUrl: '/login', mode: 'server' };
function wrap(ui: React.ReactNode, { specs, url = '/' }: { specs?: Spec[]; url?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (specs) client.setQueryData(['specs'], specs);
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={status}>
          <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const mat = (step: SpecMaturity['step'], o: Partial<SpecMaturity> = {}): SpecMaturity => ({
  step,
  stepIndex: MATURITY_STEPS.indexOf(step) + 1,
  label: step === 'in_progress' ? 'In progress' : step[0]!.toUpperCase() + step.slice(1),
  tone: STEP_TONE[step],
  sections: { implemented: 1, total: 2, inProgress: 1 },
  criteria: { total: 2, verified: 1, waived: 0, failing: 0, stale: 0, unverified: 1 },
  audit: null,
  overlays: [],
  storedStatus: 'ready',
  ...o,
});
const spec = (id: string, o: Partial<Spec> = {}): Spec =>
  ({ id, title: `Title ${id}`, summary: 'A summary', status: 'ready', priority: 'p1', tags: ['security', 'payments'], category: 'auth', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), versionCount: 2, sections: [], maturity: mat('in_progress'), ...o }) as unknown as Spec;

const colsOf = (el: Element) =>
  [...el.children].map((c) => {
    const h = c as HTMLElement;
    return { col: h.dataset.col, width: h.style.width, hide: h.dataset.hide ?? null, narrow: h.dataset.narrow ?? null };
  });

describe('list column header (L1)', () => {
  it('has the same columns, widths and hide breakpoints as the rows, with a label per column', () => {
    const s = spec('login-sso');
    wrap(
      <>
        <SpecListHeader wide />
        <SpecRow spec={s} byId={new Map([[s.id, s]])} now={Date.now()} wide />
      </>,
    );
    const header = screen.getByTestId('list-header');
    const row = screen.getByRole('link', { name: /Title login-sso/ });
    expect(colsOf(header)).toEqual(colsOf(row));
    expect(header.getAttribute('data-list')).toBe('specs');
    const label = (k: string) => header.querySelector(`[data-col="${k}"]`)!.textContent;
    expect(label('main')).toBe('Spec');
    expect(label('chips')).toBe('Tags');
    expect(label('audit')).toBe('Audit');
    expect(label('progress')).toBe('Maturity');
    expect(label('version')).toBe('Version');
    expect(label('people')).toBe('People');
    expect(label('time')).toBe('Updated');
  });

  it('each label explains its column in a tooltip', async () => {
    wrap(<SpecListHeader wide />);
    fireEvent.mouseEnter(within(screen.getByTestId('list-header')).getByText('Audit'));
    expect(await screen.findByText(/last audit and whether it has open findings/)).toBeTruthy();
  });
});

describe('column priorities (L3/L4)', () => {
  const rank: Record<string, number> = { '2xl': 0, xl: 1, lg: 2, md: 3, sm: 4, xs: 5 };
  it('version and link counts hide first; people before maturity; maturity keeps a label-sized narrow form', () => {
    const cols = Object.fromEntries(specCols(true).map((c) => [c.key, c]));
    for (const k of ['version', 'deps', 'standards']) expect(cols[k]!.hide).toBe('2xl');
    expect(rank[cols.progress!.hide!]).toBe(5);
    expect(rank[cols.progress!.hide!]).toBeGreaterThan(rank[cols.audit!.hide!]!);
    expect(cols.progress!.narrow!.width).toBeGreaterThanOrEqual(120);
    const s = spec('x');
    wrap(<SpecRow spec={s} byId={new Map()} now={Date.now()} wide />);
    const people = screen.getByRole('link').querySelector('[data-col="people"]') as HTMLElement;
    expect(rank[people.dataset.hide!]).toBeLessThan(rank[cols.progress!.hide!]!);
  });

  it('the narrow maturity form drops the meter, never the label', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/components/list/list.css'), 'utf8');
    expect(css).toMatch(/\[data-narrow='xl'\] \.maturity-meter \{\s*display: none;/);
    expect(css).not.toMatch(/\.maturity-label \{\s*display: none/);
  });
});

describe('chips never render a sliver (L2)', () => {
  const items = ['security', 'payments', 'ux'].map((k) => ({ key: k, node: <span className="tag-pill">{k}</span> }));
  const withWidths = (avail: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = this.classList.contains('lr-chips') ? avail : 60;
      return { width: w, height: 20, left: 0, top: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });

  it('pure fit: nothing below the minimum width, whole chips otherwise', () => {
    expect(fitChips([20], CHIPS_MIN_W - 1)).toBe(0);
    expect(fitChips([20, 20], 200)).toBe(2);
    expect(fitChips([60, 60, 60], 130)).toBe(1);
  });

  it('narrow column: only "+N" (all chips), no partial chip', () => {
    withWidths(40);
    wrap(<ChipList items={items} />);
    const list = screen.getByTestId('chip-list');
    expect(list.querySelectorAll(':scope > .lr-chip')).toHaveLength(0);
    expect(screen.getByTestId('chips-more').textContent).toBe('+3');
  });

  it('a single chip that does not fit becomes "+1" (never an ellipsized pill)', () => {
    withWidths(40);
    wrap(<ChipList items={items.slice(0, 1)} />);
    expect(screen.getByTestId('chip-list').querySelectorAll(':scope > .lr-chip')).toHaveLength(0);
    expect(screen.getByTestId('chips-more').textContent).toBe('+1');
  });

  it('room for one chip: one whole chip and "+2"', () => {
    withWidths(100);
    wrap(<ChipList items={items} />);
    expect([...screen.getByTestId('chip-list').querySelectorAll(':scope > .lr-chip')].map((e) => e.textContent)).toEqual(['security']);
    expect(screen.getByTestId('chips-more').textContent).toBe('+2');
  });
});

describe('maturity is the one state (X1 / L5)', () => {
  it('a spec row shows maturity, not the stored status', () => {
    const s = spec('a', { status: 'ready', maturity: mat('implemented') });
    wrap(<SpecRow spec={s} byId={new Map()} now={Date.now()} wide />);
    const row = screen.getByRole('link');
    expect(row.textContent).toContain('Implemented');
    expect(row.textContent).not.toMatch(/\bReady\b/);
  });

  it('grouped by category: specs without a category are in the "General" group (last)', async () => {
    wrap(<SpecListPage />, { specs: [spec('a'), spec('b', { category: undefined })] });
    await waitFor(() => expect(document.querySelectorAll('.group-header')).toHaveLength(2));
    const heads = [...document.querySelectorAll('.group-header')].map((e) => e.textContent ?? '');
    expect(heads[0]).toContain('Auth');
    expect(heads[1]).toContain('General');
    expect(document.body.textContent).not.toContain('No category');
  });

  it('one Maturity filter with Stage and Flags groups; no Status filter; legacy ?status= keeps an advanced filter', async () => {
    const specs = [spec('a'), spec('b', { maturity: mat('verified', { overlays: [{ kind: 'failing', reason: 'x', refs: [] }] }) })];
    wrap(<SpecListPage />, { specs });
    expect([...document.querySelectorAll('.filter-button')].map((b) => b.textContent)).not.toContain('Status');
    expect(screen.queryByRole('button', { name: /Set by author/ })).toBeNull();
    const filterBtn = [...document.querySelectorAll('.filter-button')].find((b) => b.textContent?.startsWith('Maturity'))!;
    fireEvent.click(filterBtn);
    await waitFor(() => expect(document.querySelectorAll('.filter-group')).toHaveLength(2));
    expect([...document.querySelectorAll('.filter-group')].map((e) => e.textContent)).toEqual(['Stage', 'Flags']);
    expect(screen.getByTestId('list-header')).toBeTruthy();
    cleanup();
    wrap(<SpecListPage />, { specs, url: '/?status=ready' });
    expect(screen.getByRole('button', { name: /Set by author/ })).toBeTruthy();
  });

  it('the palette empty state offers Lineage, Settings and Connect agent (P1)', async () => {
    wrap(<CommandPalette />);
    act(() => openCommandPalette());
    expect(await screen.findByText('Go to Lineage')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByText('Connect agent')).toBeTruthy();
  });
});
