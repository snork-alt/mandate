// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNodeUri, buildRef } from '@mandate/shared';
import { installDom } from './dom';
import { RefChip } from '../src/components/refs/RefChip';
import { RefTable } from '../src/components/refs/TableEmbed';
import { RefEmbed } from '../src/components/refs/RefEmbed';
import { GraphEmbed } from '../src/components/refs/GraphEmbed';
import { ActivityPanel, groupHeartbeats } from '../src/components/activity/ActivityPanel';
import { activityRenderers } from '../src/components/activity/renderers';
import type { ActivityEvent } from '../src/components/activity/types';

installDom();

const nodes: Record<string, { label: string; kind: string; props?: Record<string, unknown> }> = {};
const calls: [string, unknown][] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === 'graph_node') {
      const n = nodes[args.uri as string];
      if (!n) throw Object.assign(new Error('unknown node'), { code: 'unknown_node' });
      return { node: { ref: args.uri, kind: n.kind, label: n.label, props: n.props ?? {} } };
    }
    if (name === 'graph_neighbors') {
      return { root: args.uri, nodes: [{ ref: buildRef({ kind: 'standards', id: 'sec' }), kind: 'standard', label: 'Security' }], edges: [{ from: args.uri, to: buildRef({ kind: 'standards', id: 'sec' }), kind: 'follows' }] };
    }
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
vi.mock('../src/api', () => ({
  api: {
    get: vi.fn(async (kind: string, id: string) => ({ id, title: `T ${id}`, summary: 'sum', status: 'ready', sections: [{ id: 'auth-flow', title: 'Auth flow', type: 'acceptance', body: 'Users sign in', refs: [], symbols: [], links: [] }] })),
    workOrder: vi.fn(async (id: string) => ({ item: { id, kind: 'implement', status: 'in_progress', sections: [{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }] }, spec: { title: 'Login' } })),
    feedbackItem: vi.fn(async (id: string) => ({ feedback: { id, kind: 'ambiguity', status: 'closed', resolution: 'applied', body: 'Unclear wording\nmore' } })),
  },
}));

const ref = (kind: 'specs' | 'standards' | 'work-orders' | 'feedback', id: string, extra: object = {}) => buildRef({ kind, id, ...extra } as never);
const SHA = 'a'.repeat(40);
const URIS = {
  spec: ref('specs', 'login-sso'),
  standard: ref('standards', 'security-baseline'),
  section: ref('specs', 'login-sso', { sectionId: 'auth-flow' }),
  version: ref('specs', 'login-sso', { commit: SHA }),
  excerpt: ref('specs', 'login-sso', { sectionId: 'auth-flow', lines: { start: 3, end: 5 } }),
  work_order: ref('work-orders', 'q-0001'),
  feedback: ref('feedback', 'fb-0001'),
  symbol: buildNodeUri({ kind: 'symbols', name: 'AuthService.login' }),
  code_range: buildNodeUri({ kind: 'code', repo: 'app', path: 'src/auth/oidc.ts', lines: { start: 1, end: 9 } }),
  commit: buildNodeUri({ kind: 'commits', sha: SHA }),
};

function R({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          {children}
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}
const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>;
};
beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(nodes)) delete nodes[k];
  nodes[URIS.spec] = { label: 'Login with SSO', kind: 'spec', props: { status: 'in_progress', summary: 'Sign in with OIDC' } };
});
afterEach(cleanup);

describe('RefChip', () => {
  it.each(Object.entries(URIS))('renders a %s reference', async (kind, uri) => {
    nodes[uri] = { label: `Label ${kind}`, kind };
    render(<R><RefChip to={uri} /></R>);
    const chip = await screen.findByText(`Label ${kind}`);
    expect(chip.closest('a')?.getAttribute('data-kind')).toBe(kind);
  });
  it('shows the live status icon and opens the document', async () => {
    render(<R><RefChip to={URIS.spec} /></R>);
    await screen.findByText('Login with SSO');
    expect(screen.getByLabelText('in progress')).toBeTruthy();
    fireEvent.click(screen.getByText('Login with SSO'));
    expect(screen.getByTestId('where').textContent).toBe('/specs/login-sso');
  });
  it('opens sections scrolled to the section and versions in the pinned view', () => {
    render(<R><RefChip to={URIS.section} resolve={false} /><RefChip to={URIS.version} resolve={false} /></R>);
    fireEvent.click(screen.getAllByRole('link')[0]!);
    expect(screen.getByTestId('where').textContent).toBe('/specs/login-sso#section-auth-flow');
    fireEvent.click(screen.getAllByRole('link')[1]!);
    expect(screen.getByTestId('where').textContent).toContain(`version=${SHA}`);
  });
  it('marks unresolved references visibly and does not navigate', () => {
    const bad = ref('specs', 'no-such');
    render(<R><RefChip to={bad} check={{ ref: bad, resolved: false, error: 'unknown spec' }} /></R>);
    const a = screen.getByLabelText(`Unresolved reference ${bad}`);
    expect(a.getAttribute('data-unresolved')).toBe('true');
    fireEvent.click(a);
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(calls.filter(([n]) => n === 'graph_node')).toHaveLength(0);
  });
  it('falls back to a readable label when the node cannot be resolved', async () => {
    render(<R><RefChip to={URIS.work_order} /></R>);
    expect(await screen.findByText('q-0001')).toBeTruthy();
  });
});

describe('embeds', () => {
  it('table cells that are references become chips', async () => {
    render(<R><RefTable columns={['spec', 'n']} rows={[[URIS.spec, 3]]} /></R>);
    expect(await screen.findByText('Login with SSO')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
  it('work order card shows progress; feedback card shows kind and resolution; doc card shows summary', async () => {
    render(<R><RefEmbed uri={URIS.work_order} /><RefEmbed uri={URIS.feedback} /><RefEmbed uri={URIS.spec} /></R>);
    expect(await screen.findByText(/1\/2 sections done/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(await screen.findByText(/ambiguity · applied/)).toBeTruthy();
    expect(await screen.findByText('sum')).toBeTruthy();
  });
  it('section card uses the criterion card for acceptance sections', async () => {
    render(<R><RefEmbed uri={URIS.section} /></R>);
    expect(await screen.findByText('Auth flow')).toBeTruthy();
    expect(document.querySelector('.criterion-card')).toBeTruthy();
  });
  it('commit card shows the subject', async () => {
    nodes[URIS.commit] = { label: 'abc subject', kind: 'commit', props: { sha: SHA, subject: 'spec: edit login', author: 'Matteo', date: '2026-01-01T00:00:00Z' } };
    render(<R><RefEmbed uri={URIS.commit} /></R>);
    expect(await screen.findByText('spec: edit login')).toBeTruthy();
  });
  it('invalid references render as an error card', () => {
    render(<R><RefEmbed uri="nonsense" /></R>);
    expect(screen.getByText(/Not a valid Mandate reference/)).toBeTruthy();
  });
  it('graph embed draws the neighbours of the refs', async () => {
    render(<R><GraphEmbed refs={[URIS.spec]} depth={1} /></R>);
    await waitFor(() => expect(document.querySelector('[role="img"][aria-label^="Relation graph"]')).toBeTruthy(), { timeout: 5000 });
    expect(document.querySelectorAll('.graph-node[data-ref]').length).toBeGreaterThanOrEqual(2);
    // The seed is highlighted and every style is inline (the fullscreen portal is outside any scoped CSS).
    const seed = document.querySelector<HTMLElement>('.graph-node[data-seed]')!;
    expect(seed.style.background).toContain('--mantine-primary-color-light');
    expect(document.querySelector('marker path')?.getAttribute('style')).toContain('fill');
  });
});

const ev = (over: Partial<ActivityEvent> & { type: string }): ActivityEvent =>
  ({ id: `${Math.random().toString(16).slice(2)}:0`, commit: SHA, at: new Date().toISOString(), refs: [URIS.section, URIS.spec], summary: `summary of ${over.type}`, ...over }) as ActivityEvent;

describe('activity renderers', () => {
  const fixtures: ActivityEvent[] = [
    ev({ type: 'spec.section.updated', details: { preview: [{ op: 'equal', text: 'keep ' }, { op: 'insert', text: 'added' }, { op: 'delete', text: 'removed' }] } }),
    ev({ type: 'spec.status_changed', refs: [URIS.spec], details: { status: { from: 'draft', to: 'in_progress' } } }),
    ev({ type: 'work_order.section_done', refs: [URIS.work_order], details: { progress: { done: 2, total: 3 }, sectionTitle: 'Overview' } }),
    ev({ type: 'work_order.claimed', refs: [URIS.work_order], agent: 'other-agent' }), // another actor: one actor's runs group
    ev({ type: 'feedback.closed', refs: [URIS.feedback], details: { kind: 'ambiguity', resolution: 'applied' } }),
    ev({ type: 'verification.recorded', details: { result: 'pass' } }),
    ev({ type: 'git.pulled', refs: [], details: { commits: ['a', 'b'] } }),
    ev({ type: 'commit', refs: [URIS.commit] }),
  ];
  it('registry covers every event family', () => {
    for (const k of ['spec.section.*', 'standard.section.*', 'spec.status_changed', 'work_order.*', 'feedback.*', 'verification.recorded', 'git.pulled']) expect(activityRenderers[k]).toBeTruthy();
  });
  it('renders every fixture with its specific content', () => {
    render(<R><ActivityPanel events={fixtures} connected /></R>);
    expect(document.querySelector('.wp-ins')?.textContent).toBe('added');
    expect(document.querySelector('.wp-del')?.textContent).toBe('removed');
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')[0]!.getAttribute('aria-valuenow')).toBe('67');
    expect(screen.getByText('applied')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText(/2 commits pulled/)).toBeTruthy();
    expect(screen.getByText('Summary of commit')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });
  it('groups consecutive heartbeats of one work order', () => {
    const hb = (n: number) => ev({ type: 'work_order.heartbeat', id: `h${n}:0`, refs: [URIS.work_order], heartbeat: true });
    const rows = groupHeartbeats([hb(1), hb(2), hb(3), ev({ type: 'work_order.claimed', refs: [URIS.work_order] })]);
    expect(rows.map((r) => r.count)).toEqual([3, 1]);
    render(<R><ActivityPanel events={[hb(1), hb(2), hb(3)]} /></R>);
    expect(screen.getByText(/^3 heartbeats on /)).toBeTruthy();
  });
  it('filters with the shared multi-select menus (no native selects), shows the offline state', async () => {
    render(<R><ActivityPanel events={[...fixtures, ev({ type: 'spec.updated', agent: 'claude-code@mbp' }), ev({ type: 'feedback.created', agent: 'codex' })]} connected={false} /></R>);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Type/ }));
    fireEvent.click(await screen.findByText('feedback'));
    expect(screen.queryByText('Summary of commit')).toBeNull();
    expect(screen.getAllByText('applied').length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByText('git'));
    expect(screen.getByText(/2 commits pulled/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Type: / }).textContent).toContain('feedback +1');
    fireEvent.click(screen.getByLabelText('Clear Type filter'));
    expect(screen.getByText('Summary of commit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Agent/ }));
    await waitFor(() => expect(document.querySelector('.filter-option [data-testid], .filter-option')?.textContent).toBeTruthy());
    fireEvent.click(await waitFor(() => { const o = [...document.querySelectorAll('.filter-option')].find((e) => e.textContent?.endsWith('codex')); if (!o) throw new Error('no codex option'); return o; }));
    await waitFor(() => expect(screen.queryByText('Summary of commit')).toBeNull());
    expect(screen.getByText('Summary of feedback.created')).toBeTruthy();
  });
  it('pause holds events back (button label counts them)', () => {
    const on = vi.fn();
    render(<R><ActivityPanel events={fixtures} paused buffered={4} onPausedChange={on} /></R>);
    fireEvent.click(screen.getByText(/Resume · 4 new/));
    expect(on).toHaveBeenCalledWith(false);
  });
});
void act;
