// @vitest-environment jsdom
/** UI review fixes (plans/fable-ui-review.md): two-row section header (D1), type chips (O6/A6), loopback note (E1), groups sized to titles (C1). */
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Section } from '@mandate/shared';
import { installDom } from './dom';
import { SectionBlock } from '../src/components/doc';
import { sectionTarget } from '../src/lib/refs';
import { isLoopbackUrl, urlReachNote } from '../src/connect/snippets';
import { groupHeadWidth, NODE_W } from '../src/components/architecture/layout';
import { MIN_READABLE_ZOOM } from '../src/components/architecture/ArchitectureView';
import '../src/components/doc/types';

installDom();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async () => ({ contributors: {} })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(cleanup);

const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
const sec = (o: Partial<Section> & { id: string; type: string }): Section => ({ title: o.id, body: 'Body.', refs: [], symbols: [], links: [], verifiedBy: [], ...o }) as unknown as Section;

describe('section header (D1)', () => {
  it('puts the title and actions on row 1, state chips and contributors on row 2', () => {
    const s = sec({ id: 'callback', type: 'acceptance', title: 'Microsoft sign-in works for personal and work accounts' });
    wrap(<SectionBlock section={s} badge={<span data-testid="impl">Not implemented</span>} target={sectionTarget('specs', 'login-sso', s)} />);
    const header = document.querySelector('.doc-section-header-2row')!;
    const title = header.querySelector('.doc-section-titlerow')!;
    const sub = header.querySelector('.doc-section-subrow')!;
    expect(title.querySelector('h2')?.textContent).toContain('Microsoft sign-in works');
    expect(title.querySelector('.section-actions')).toBeTruthy();
    expect(sub.querySelector('.doc-section-badges [data-testid="impl"]')).toBeTruthy();
    expect(sub.querySelector('.type-badge')).toBeTruthy();
    expect(sub.querySelector('.section-people')).toBeTruthy();
  });
  it('drops the redundant type chip on work-order sections and audit items (O6, A6)', () => {
    for (const type of ['wo-section', 'audit-item', 'markdown']) {
      wrap(<SectionBlock section={sec({ id: 's1', type })} />);
      expect(document.querySelector('.type-badge')).toBeNull();
      cleanup();
    }
  });
});

describe('Connect agent URL note (E1)', () => {
  it('detects loopback URLs', () => {
    for (const u of ['http://localhost:4000/mcp/x', 'http://127.0.0.1:4000/mcp', 'http://[::1]:4000/', 'http://app.localhost/']) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ['https://mandate.example.com/mcp', 'http://10.0.0.5:4000/mcp', 'not a url']) expect(isLoopbackUrl(u)).toBe(false);
  });
  it('says "this machine only" for loopback and "public" otherwise', () => {
    expect(urlReachNote('http://localhost:4000/mcp')).toMatch(/this machine only/);
    expect(urlReachNote('https://m.example.com/mcp', true)).toMatch(/public.*with the key/);
  });
});

describe('architecture readability (C1)', () => {
  it('sizes a group to its title and keeps a readable minimum zoom', () => {
    expect(groupHeadWidth('Auth service and session management')).toBeGreaterThan(NODE_W);
    expect(groupHeadWidth('x'.repeat(500))).toBeLessThanOrEqual(520);
    expect(MIN_READABLE_ZOOM).toBeGreaterThanOrEqual(0.8);
  });
});
