// @vitest-environment jsdom
/** Projects home cards: counts as stat tiles, active work orders, code repos, open actions, access badge, activity. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPage, projectTone } from '../src/pages/ProjectsPage';
import { installDom, Wrap } from './dom';

const now = new Date().toISOString();
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async () => ({})),
  callRootTool: vi.fn(async () => ({
    defaultProject: 'checkout',
    items: [
      {
        id: 'checkout',
        name: 'Checkout',
        description: 'Cart and payments.',
        dataDir: '/Users/me/.mandate/checkout',
        branch: 'main',
        remote: null,
        mcpPath: '/p/checkout/mcp',
        counts: { specs: 42, standards: 9, components: 14, workOrders: 23, feedback: 2, activeWorkOrders: 3 },
        openActions: 2,
        codeRepos: ['web-app', 'api'],
        access: 'write',
        github: { repo: 'acme/checkout-specs', path: null, connectedBy: 'ada', status: 'reconnect' },
        lastActivity: { at: now, summary: 'claude-code completed WO-118 Apply a coupon', agent: 'claude-code' },
      },
      {
        id: 'billing',
        name: 'Billing',
        dataDir: '/Users/me/.mandate/billing',
        branch: 'main',
        remote: null,
        mcpPath: '/p/billing/mcp',
        counts: { specs: 0, standards: 0, components: 0, workOrders: 0, feedback: 0, activeWorkOrders: 0 },
        openActions: 0,
        codeRepos: [],
        access: 'read',
        github: { repo: 'acme/billing-specs', path: null, connectedBy: 'ada', status: 'ok' },
        lastActivity: null,
      },
    ],
  })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

beforeAll(installDom);
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('project cards', () => {
  it('renders the stats, repos, open actions, reconnect, the read-only badge and the activity', async () => {
    render(
      <Wrap>
        <ProjectsPage />
      </Wrap>,
    );
    const card = await screen.findByTestId('project-checkout');
    expect(screen.getByTestId('stats-checkout').textContent).toMatch(/42specs.*9standards.*14components.*23work orders3 active/);
    expect(screen.getByTestId('code-repos-checkout').textContent).toContain('web-app, api');
    expect(screen.getByTestId('code-repos-checkout').textContent).toContain('2 code repos');
    expect(screen.getByTestId('actions-checkout').textContent).toContain('2 open actions');
    expect(screen.getByTestId('reconnect-checkout')).toBeTruthy();
    expect(card.textContent).toContain('acme/checkout-specs');
    expect(card.textContent).toContain('@main');
    expect(card.textContent).toContain('default');
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).toContain('completed WO-118 Apply a coupon');
    expect(card.querySelector('[data-testid="access-write"]')).toBeTruthy();

    const billing = screen.getByTestId('project-billing');
    expect(billing.querySelector('[data-testid="access-read"]')?.textContent).toContain('Read only');
    expect(screen.getByTestId('active-billing').textContent).toBe('none active');
    expect(screen.getByTestId('code-repos-billing').textContent).toContain('No code repositories');
    expect(screen.queryByTestId('actions-billing')).toBeNull();
    expect(billing.textContent).toContain('No activity yet');
  });

  it('gives each project a stable tone', () => {
    expect(projectTone('checkout')).toBe(projectTone('checkout'));
    expect(['lilac', 'indigo', 'teal', 'amber', 'rose', 'slate']).toContain(projectTone('x'));
  });
});
