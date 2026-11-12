// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodeRef, buildFindingRef, buildRef, type LineageEvent, type LineageNode, type LineageResponse, type WhereUsedResponse } from '@mandate/shared';
import { installDom } from './dom';
import { LIN_NODE_H, LIN_GAP_Y, causalOnly, formatDuration, groupSiblings, gutterLayout, layoutLineage, refFromInput, splitLineage, storyDays, summaryChips } from '../src/lib/lineage';
import { LineageStory } from '../src/components/lineage/LineageStory';
import { graphOf } from '../src/pages/LineagePage';
import { LineageView } from '../src/components/lineage/LineagePanel';
import { WhereUsedView } from '../src/components/lineage/WhereUsedPanel';

installDom();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async () => ({})),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(cleanup);

const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const node = (uri: string, layer: number, o: Partial<LineageNode> = {}): LineageNode => ({ uri, ref: uri, kind: 'spec', label: uri.split('/').pop()!, layer, status: 'neutral', ...o });
const t = (iso: string) => ({ sha: 'a'.repeat(40), date: iso });

const FB = buildRef({ kind: 'feedback', id: 'fb-01' });
const WO = buildRef({ kind: 'work-orders', id: 'wo-0042' });
const SEC = buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'rotate' });
const DEP = buildRef({ kind: 'specs', id: 'billing' });
const COMP = buildRef({ kind: 'components', id: 'auth' });
const FINDING = buildFindingRef({ audit: 'a1', id: 'f1' });

const nodes: LineageNode[] = [
  node(SPEC, 0, { label: 'Login with SSO', status: 'done', createdAt: t('2026-11-01T10:00:00Z') }),
  node(FB, -1, { kind: 'feedback', label: 'Rotate tokens', status: 'done', createdAt: t('2026-10-30T10:00:00Z') }),
  node(FINDING, -2, { kind: 'finding', label: 'Token reuse', status: 'attention', createdAt: t('2026-10-29T10:00:00Z') }),
  node(SEC, 1, { kind: 'section', label: 'Rotate the session token', status: 'done', createdAt: t('2026-11-01T12:00:00Z') }),
  node(WO, 1, { kind: 'work_order', label: 'Implement rotation', status: 'in_progress', rawStatus: 'in_progress', createdAt: t('2026-11-02T10:00:00Z') }),
  node(COMP, 1, { kind: 'component', label: 'Auth', status: 'neutral' }),
  node(DEP, 2, { label: 'Billing', status: 'neutral' }),
];
const response: LineageResponse = {
  root: nodes[0]!,
  at: null,
  direction: 'both',
  depth: 2,
  nodes,
  edges: [
    { from: FB, to: SPEC, kind: 'caused_by', recorded: true },
    { from: FINDING, to: FB, kind: 'from_finding', recorded: true },
    { from: SPEC, to: SEC, kind: 'has_section', recorded: false },
    { from: SPEC, to: WO, kind: 'covers', recorded: false },
  ],
  summary: {
    changed: { sections: 1, docs: 1, components: 1, files: 0, workOrders: 0, commits: 0, total: 3 },
    changing: { workOrders: 1, findings: 0, feedback: 0, total: 1, items: [] },
    causes: 2,
    text: 'Changed: 1 section in 1 spec, 1 component · Changing: 1 work order',
  },
  truncated: false,
  viewRef: SPEC,
};

const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );

describe('lineage layout (pure)', () => {
  it('puts the element in the centre row, causes above and effects below, grouped by kind', () => {
    const l = layoutLineage(nodes);
    const y = (uri: string) => l.nodes.find((p) => p.item.uri === uri)!.y;
    expect(y(SPEC)).toBe(0);
    expect(y(FB)).toBe(-(LIN_NODE_H + LIN_GAP_Y));
    expect(y(FINDING)).toBe(-2 * (LIN_NODE_H + LIN_GAP_Y));
    expect(y(WO)).toBe(LIN_NODE_H + LIN_GAP_Y);
    expect(y(DEP)).toBe(2 * (LIN_NODE_H + LIN_GAP_Y));
    expect(l.rows.map((r) => r.layer)).toEqual([-2, -1, 0, 1, 2]);
    // Layer 1 grouped by kind (work order, section, component), left to right, and centred on x = 0.
    const row = l.nodes.filter((p) => p.item.layer === 1).sort((a, b) => a.x - b.x);
    expect(row.map((p) => p.item.kind)).toEqual(['work_order', 'section', 'component']);
    const left = row[0]!.x;
    const right = row[row.length - 1]!.x + 220;
    expect(Math.abs(left + right)).toBeLessThan(1);
    // The element is centred too.
    expect(l.nodes.find((p) => p.item.uri === SPEC)!.x).toBe(-110);
  });

  it('splits Why / Led to / also affected', () => {
    const s = splitLineage(response);
    expect(s.why.map((n) => n.uri)).toEqual([FB, FINDING]);
    expect(s.ledTo.map((n) => n.uri).sort()).toEqual([SEC, WO, COMP].sort());
    expect(s.alsoAffected.map((n) => n.uri)).toEqual([DEP]);
  });

  it('accepts mentions, references and UI links as the picked element', () => {
    expect(refFromInput(`@mandate:${SPEC}`)).toBe(SPEC);
    expect(refFromInput(SEC)).toBe(SEC);
    expect(refFromInput('http://localhost:5173/p/default/specs/login-sso#section-rotate')).toBe(SEC);
    expect(refFromInput('/audits/a1#finding-f1')).toBe(FINDING);
    expect(refFromInput('/work-orders/wo-0042')).toBe(WO);
    expect(refFromInput('login')).toBeNull();
    expect(refFromInput('/nope/x')).toBeNull();
  });
});

describe('Lineage panel', () => {
  it('shows the summary, Why / Led to tabs with statuses and a collapsed "also affected" ring', () => {
    wrap(<LineageView data={response} />);
    expect(screen.getByTestId('lineage-summary').textContent).toBe(response.summary.text);
    // Why first (there are causes): feedback (done) and the finding (needs attention).
    let items = screen.getAllByTestId('lineage-item');
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['done', 'attention']);
    expect(within(items[1]!).getByLabelText('Needs attention')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Led to/ }));
    items = screen.getAllByTestId('lineage-item');
    expect(items).toHaveLength(3);
    expect(items.some((i) => i.getAttribute('data-status') === 'in_progress' && i.textContent?.includes('Implement rotation'))).toBe(true);
    // "Also affected" is collapsed by default.
    expect(screen.queryByText('Billing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Also affected · 1/ }));
    expect(screen.getByText('Billing')).toBeTruthy();
    // Items with a page link to it.
    expect(screen.getByText('Implement rotation').closest('a')!.getAttribute('href')).toBe('/work-orders/wo-0042');
  });
});

describe('Where it is used', () => {
  const STD = buildRef({ kind: 'standards', id: 'tokens' });
  const RULE = buildRef({ kind: 'standards', id: 'tokens', sectionId: 'rotate' });
  const data: WhereUsedResponse = {
    standard: STD,
    locations: [
      { uri: buildCodeRef({ repo: 'app', path: 'src/auth/session.ts', lines: '10-20' }), repo: 'app', path: 'src/auth/session.ts', lines: { start: 10, end: 20 }, state: 'compliant', rule: RULE, ruleTitle: 'Rotate tokens', component: 'auth', source: buildRef({ kind: 'feedback', id: 'fb-01' }), at: '2026-11-10T10:00:00Z' },
      { uri: buildCodeRef({ repo: 'app', path: 'src/auth/login.ts' }), repo: 'app', path: 'src/auth/login.ts', state: 'violating', rule: RULE, ruleTitle: 'Rotate tokens', component: 'auth' },
      { uri: buildCodeRef({ repo: 'app', path: 'scripts/seed.ts' }), repo: 'app', path: 'scripts/seed.ts', state: 'unchecked', rule: RULE, component: null },
    ],
    byComponent: [
      { component: 'auth', label: 'Auth', compliant: 1, violating: 1, unchecked: 0 },
      { component: null, label: 'No component', compliant: 0, violating: 0, unchecked: 1 },
    ],
    coverage: { inScope: 4, checked: 2, violating: 1, unchecked: ['src/auth/oauth.ts', 'src/auth/keys.ts'], ratio: 0.5 },
  };
  it('groups locations by component with states, a coverage bar and the unchecked in-scope files', () => {
    wrap(<WhereUsedView data={data} />);
    const groups = screen.getAllByTestId('wu-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain('Auth');
    expect(groups[0]!.textContent).toContain('1 violating');
    expect(within(groups[0]!).getAllByTestId('wu-location').map((l) => l.getAttribute('data-state'))).toEqual(['compliant', 'violating']);
    expect(within(groups[1]!).getAllByTestId('wu-location').map((l) => l.getAttribute('data-state'))).toEqual(['unchecked']);
    const cov = screen.getByTestId('wu-coverage');
    expect(cov.textContent).toContain('2/4 in-scope files checked');
    expect(cov.textContent).toContain('50%');
    expect(cov.textContent).toContain('1 violating');
    expect(screen.queryByText('src/auth/oauth.ts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /never checked · 2/ }));
    expect(screen.getByText('src/auth/oauth.ts')).toBeTruthy();
  });
});

describe('declutter (pure)', () => {
  it('"Show all" off drops neutral nodes without a causal edge, never the element', () => {
    const r = causalOnly(nodes, response.edges, SPEC);
    const uris = r.nodes.map((n) => n.uri);
    // COMP / DEP are neutral and unconnected; the section is done (kept); the root stays.
    expect(uris).toContain(SPEC);
    expect(uris).toContain(SEC);
    expect(uris).not.toContain(COMP);
    expect(uris).not.toContain(DEP);
    // covers (work order) is a causal flow edge? no -> but the work order is in progress, so it stays.
    expect(uris).toContain(WO);
    const lonelyNeutral = node(buildRef({ kind: 'specs', id: 'x' }), 1, { status: 'neutral' });
    const linked = node(buildRef({ kind: 'specs', id: 'y' }), 1, { status: 'neutral' });
    const r2 = causalOnly([nodes[0]!, lonelyNeutral, linked], [
      { from: SPEC, to: lonelyNeutral.uri, kind: 'has_section', recorded: false },
      { from: SPEC, to: linked.uri, kind: 'caused_by', recorded: true },
    ], SPEC);
    expect(r2.nodes.map((n) => n.uri)).toEqual([SPEC, linked.uri]);
    expect(r2.edges).toHaveLength(1);
  });

  it('groups more than 3 siblings (same kind, same document, same layer) and re-points edges', () => {
    const secs = Array.from({ length: 12 }, (_, i) => node(buildRef({ kind: 'specs', id: 'login-sso', sectionId: `s${i}` }), 1, { kind: 'section', label: `S${i}`, status: i === 0 ? 'in_progress' : 'done' }));
    const rules = Array.from({ length: 8 }, (_, i) => node(buildRef({ kind: 'standards', id: 'tokens', sectionId: `r${i}` }), -1, { kind: 'section', label: `R${i}` }));
    const std = node(buildRef({ kind: 'standards', id: 'tokens' }), -2, { kind: 'standard', label: 'Tokens' });
    const all = [nodes[0]!, ...secs, ...rules, std, nodes[4]!];
    const edges = [...secs.map((x) => ({ from: SPEC, to: x.uri, kind: 'caused_by' as const, recorded: true })), ...rules.map((x) => ({ from: x.uri, to: SPEC, kind: 'inherits_rule' as const, recorded: false }))];
    const g = groupSiblings(all, edges, SPEC);
    const groups = g.items.filter((i) => i.members);
    expect(groups.map((i) => i.label).sort()).toEqual(['12 sections of Login with SSO', '8 rules of Tokens']);
    expect(groups.find((i) => i.label.startsWith('12'))!.status).toBe('in_progress');
    // Twelve caused_by edges become one, still recorded.
    expect(g.edges.filter((e) => e.from === SPEC)).toHaveLength(1);
    expect(g.edges.find((e) => e.from === SPEC)!.recorded).toBe(true);
    expect(g.items.find((i) => i.uri === WO)).toBeTruthy();
    // Expanding a group shows its members again.
    const key = groups.find((i) => i.label.startsWith('12'))!.uri;
    const g2 = groupSiblings(all, edges, SPEC, new Set([key]));
    expect(g2.items.filter((i) => i.kind === 'section' && !i.members)).toHaveLength(12);
    // Three siblings are not grouped.
    expect(groupSiblings([nodes[0]!, ...secs.slice(0, 3)], [], SPEC).items.some((i) => i.members)).toBe(false);
  });

  it('wraps wide layers so depth 3 stays readable', () => {
    const many = Array.from({ length: 12 }, (_, i) => node(buildRef({ kind: 'work-orders', id: `wo-${i}` }), 1, { kind: 'work_order', label: `W${i}` }));
    const l = layoutLineage([nodes[0]!, ...many]);
    expect(l.width).toBeLessThanOrEqual(4 * 220 + 3 * 28);
    expect(new Set(l.nodes.filter((p) => p.item.layer === 1).map((p) => p.y)).size).toBe(3);
  });

  it('summary chips filter both views', () => {
    const chips = summaryChips(response.summary);
    expect(chips.map((c) => `${c.changing ? 'changing' : 'changed'}:${c.label}`)).toEqual(['changed:1 section', 'changed:1 document', 'changed:1 component', 'changing:1 work order']);
    const g = graphOf(response, { showAll: true, chip: chips.find((c) => c.id === 'changing-wo')!, expanded: new Set() });
    expect(g.items.map((i) => i.uri).sort()).toEqual([SPEC, WO].sort());
  });
});

const ev = (id: string, at: string, o: Partial<LineageEvent> = {}): LineageEvent => ({ id, at, commit: id, kind: 'spec', verb: 'edited', subject: SPEC, label: 'Login with SSO', text: `Event ${id}`, commitSubject: '', causes: [], ...o });

describe('story', () => {
  const events = [
    ev('a', '2026-11-10T09:00:00', { kind: 'feedback', subject: FB, label: 'Rotate tokens', text: 'Feedback filed' }),
    ev('b', '2026-11-10T11:00:00', { causedBy: 'a', gapMs: 2 * 36e5, text: 'Edited 2 sections of Login with SSO', version: buildRef({ kind: 'specs', id: 'login-sso', commit: 'b'.repeat(40) }), user: 'octocat', agent: 'claude-code' }),
    ev('c', '2026-11-11T10:00:00', { kind: 'work_order', subject: WO, causedBy: 'b', gapMs: 23 * 36e5, text: 'Work order created' }),
    ev('d', '2026-11-13T10:00:00', { kind: 'verification', causedBy: 'a', gapMs: 2 * 864e5, text: 'Verification pass' }),
  ];
  it('groups by day, oldest first or newest first', () => {
    const asc = storyDays(events.slice().reverse(), 'asc');
    expect(asc.map((d) => d.day)).toEqual(['2026-11-10', '2026-11-11', '2026-11-13']);
    expect(asc[0]!.events.map((e) => e.id)).toEqual(['a', 'b']);
    const desc = storyDays(events, 'desc');
    expect(desc.map((d) => d.day)).toEqual(['2026-11-13', '2026-11-11', '2026-11-10']);
    expect(desc[2]!.events.map((e) => e.id)).toEqual(['b', 'a']);
  });
  it('lays out causal links in the fewest gutter lanes', () => {
    const g = gutterLayout(events);
    // a->b (0..1) and b->c (1..2) chain through b in one lane; a->d (0..3) needs a second lane.
    expect(g.lanes).toBe(2);
    expect(g.links).toEqual([
      { from: 0, to: 1, lane: 0 },
      { from: 0, to: 3, lane: 1 },
      { from: 1, to: 2, lane: 0 },
    ]);
    expect(g.cells[0]).toEqual(['start', 'start']);
    expect(g.cells[1]).toEqual(['through', 'mid']);
    expect(g.cells[2]).toEqual(['end', 'mid']);
    expect(g.cells[3]).toEqual(['none', 'end']);
    expect(g.passing(2)).toEqual([0, 1]);
    // Reversed display order works too.
    expect(gutterLayout(events.slice().reverse()).lanes).toBe(2);
  });
  it('renders entries with gaps, actor, tracked-changes links and the in-progress tail', () => {
    wrap(<LineageStory events={events} changing={[{ uri: WO, label: 'Implement rotation', progress: '2/3' }]} />);
    expect(screen.getAllByTestId('story-day')).toHaveLength(3);
    const entries = screen.getAllByTestId('story-entry');
    expect(entries.map((e) => e.getAttribute('data-kind'))).toEqual(['feedback', 'spec', 'work_order', 'verification']);
    expect(entries[1]!.textContent).toContain('+2h');
    expect(entries[3]!.textContent).toContain('+2d');
    // Local mode (no auth): "via <agent>" only.
    expect(entries[1]!.textContent).toContain('via claude-code');
    expect(entries[1]!.textContent).not.toContain('octocat');
    expect(within(entries[1]!).getByText('tracked changes').closest('a')!.getAttribute('href')).toBe(`/specs/login-sso?version=${'b'.repeat(40)}`);
    const now = screen.getByTestId('story-now');
    expect(now.textContent).toContain('Implement rotation');
    expect(now.textContent).toContain('2/3');
    // Newest at the bottom: the tail comes after the last entry.
    expect(entries[3]!.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('element actions', () => {
  it('selection card: kind, status, causes and the three actions', async () => {
    const { ElementCard } = await import('../src/components/lineage/ElementActions');
    const onCenter = vi.fn();
    wrap(<ElementCard info={{ uri: WO, kind: 'work_order', label: 'Implement rotation', status: 'in_progress', rawStatus: 'in_progress', causes: [FB] }} onCenter={onCenter} />);
    const card = screen.getByTestId('element-card');
    expect(card.textContent).toContain('Implement rotation');
    expect(card.textContent).toContain('in progress');
    expect(card.textContent).toContain('Caused by');
    expect(within(card).getByRole('button', { name: /Open/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Copy @mandate ref/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /Center lineage here/ }));
    expect(onCenter).toHaveBeenCalledWith(WO);
  });
  it('story rows are keyboard-focusable links', () => {
    wrap(<LineageStory events={[{ id: 'x', at: '2026-11-10T09:00:00', commit: 'x', kind: 'spec', verb: 'edited', subject: SPEC, label: 'Login with SSO', text: 'Edited', commitSubject: '', causes: [FB] }]} />);
    const row = screen.getByTestId('story-entry');
    expect(row.getAttribute('role')).toBe('link');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.textContent).toContain('caused by');
  });
});
