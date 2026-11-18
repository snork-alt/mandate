// @vitest-environment jsdom
/** Connect dialog: per-agent tabs (install one-liner + sign-in), everything else under "Advanced: set it up manually". */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectAgentGuide, type ConnectInfo } from '../src/connect/ConnectAgentGuide';
import { installDom, Wrap } from './dom';

// Multi-agent UI: enable every agent through the shared switch (the default shows Claude Code only: supported-agents.test.tsx).
vi.mock('@mandate/shared', async (orig) => ({ ...(await orig<typeof import('@mandate/shared')>()), SUPPORTED_AGENTS: ['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode', 'junie', 'amp', 'goose', 'cline', 'zed'] }));

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async () => ({})),
  callRootTool: vi.fn(async () => ({
    defaultProject: 'web',
    items: [{ id: 'web', name: 'Web', access: 'write', github: { repo: 'acme/web-specs', path: null, connectedBy: 'ada', status: 'ok' }, counts: { specs: 1, standards: 0, components: 0, workOrders: 0, feedback: 0 } }],
  })),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

const KEY = 'mnd_web_abcdefghijklmnopqrstuvwxyz0123456789';
const oauthInfo: ConnectInfo = { project: { id: 'web', name: 'Web' }, mcpPath: '/p/web/mcp', key: null, keysFile: null, cli: { create: 'c', list: 'l', revoke: 'r' }, auth: 'oauth', mcpUrl: 'https://m.example.com/p/web/mcp', access: 'write' };
const keyInfo: ConnectInfo = {
  project: { id: 'web', name: 'Web' },
  mcpPath: '/p/web/mcp',
  key: { id: 'k1', name: 'default', value: KEY, createdAt: '2026-01-01T00:00:00Z' },
  keysFile: '~/.mandate/keys.json',
  cli: { create: 'getmandate keys create web', list: 'getmandate keys list', revoke: 'getmandate keys revoke <id>' },
  auth: 'key',
  mcpUrl: 'http://localhost:4000/p/web/mcp',
};
let info = oauthInfo;

beforeAll(installDom);
beforeEach(() => {
  info = oauthInfo;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/tokens') ? { items: [{ id: 't1', login: 'ada', project: 'web', name: 'ci-runner', createdAt: '2026-01-01T00:00:00Z' }] } : info;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const cmd = () => screen.getByTestId('install-command').textContent;

describe('Connect dialog', () => {
  it('per-agent tabs: one-liner with --agents, sign-in as the CLI prints it, Windows one-liner', async () => {
    render(
      <Wrap>
        <ConnectAgentGuide projectId="web" />
      </Wrap>,
    );
    await screen.findByTestId('connect-guide');
    for (const t of ['Claude Code', 'Codex', 'Cursor', 'VS Code', 'Gemini CLI', 'Windsurf', 'opencode', 'More']) expect(screen.getByRole('tab', { name: new RegExp(t) })).toBeTruthy();
    fireEvent.click(screen.getByText('macOS / Linux'));
    expect(cmd()).toBe('curl -fsSL https://m.example.com/p/web/install.sh | sh -s -- --agents claude-code');
    const flow = screen.getByTestId('signin-flow').textContent!;
    expect(flow).toContain('/mcp');
    expect(flow).toContain('mandate-web');
    expect(flow).toContain('Authenticate');
    await waitFor(() => expect(screen.getByTestId('connect-guide').textContent).toContain('acme/web-specs'));

    fireEvent.click(screen.getByTestId('agent-tab-codex'));
    expect(cmd()).toBe('curl -fsSL https://m.example.com/p/web/install.sh | sh -s -- --agents codex');
    expect(screen.getByTestId('connect-guide').textContent).toContain('codex mcp login mandate-web');
    fireEvent.click(screen.getByText('Windows'));
    expect(cmd()).toBe('& ([scriptblock]::Create((irm https://m.example.com/p/web/install.ps1))) --agents codex');
  });

  it('Advanced holds the manual setup: MCP URL, registration, files, personal tokens, checksum, uninstall', async () => {
    render(
      <Wrap>
        <ConnectAgentGuide projectId="web" />
      </Wrap>,
    );
    await screen.findByTestId('connect-guide');
    fireEvent.click(screen.getByText('macOS / Linux'));
    expect(screen.queryByTestId('adv-mcp')).toBeNull();
    fireEvent.click(screen.getByTestId('connect-advanced-toggle'));
    const adv = screen.getByTestId('connect-advanced');
    expect((screen.getByLabelText('MCP URL') as HTMLInputElement).value).toBe('https://m.example.com/p/web/mcp');
    expect(adv.textContent).toContain('This URL is public');
    expect(adv.textContent).toContain('claude mcp add --transport http mandate-web https://m.example.com/p/web/mcp');
    expect(adv.textContent).toContain('~/.claude/skills/mandate');
    expect(adv.textContent).toContain('~/.claude/commands/');
    expect(adv.textContent).toContain('CLAUDE.md');
    expect(screen.getByTestId('personal-tokens')).toBeTruthy();
    await screen.findByText('ci-runner');
    expect(screen.getByTestId('token-create')).toBeTruthy();
    expect(adv.textContent).toContain('export MANDATE_KEY_WEB=<token>');
    expect(adv.textContent).toContain('sh install.sh --agents claude-code');
    expect(screen.getByTestId('uninstall-command').textContent).toContain('curl -fsSL https://m.example.com/uninstall.sh | sh');
  });

  it('More: the other agents of the CLI; without MCP OAuth they install with --auth token', async () => {
    render(
      <Wrap>
        <ConnectAgentGuide projectId="web" />
      </Wrap>,
    );
    await screen.findByTestId('connect-guide');
    fireEvent.click(screen.getByText('macOS / Linux'));
    fireEvent.click(screen.getByTestId('agent-tab-more'));
    for (const id of ['junie', 'amp', 'goose', 'cline', 'zed', 'other']) expect(await screen.findByTestId(`agent-more-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('agent-more-amp'));
    await waitFor(() => expect(cmd()).toBe('curl -fsSL https://m.example.com/p/web/install.sh | sh -s -- --agents amp --auth token'));
    expect(screen.getByTestId('connect-guide').textContent).toContain('personal token');
  });

  it('local server: the key (masked), per-agent entry, CLI and key commands under Advanced', async () => {
    info = keyInfo;
    render(
      <Wrap>
        <ConnectAgentGuide projectId="web" />
      </Wrap>,
    );
    await screen.findByTestId('connect-guide');
    fireEvent.click(screen.getByTestId('connect-advanced-toggle'));
    const key = screen.getByTestId('connect-key') as HTMLInputElement;
    expect(key.value).not.toBe(KEY);
    const adv = screen.getByTestId('connect-advanced').textContent!;
    expect(adv).toContain('claude mcp add --transport http mandate-web');
    expect(adv).toContain('mandate connect --project web');
    expect(adv).toContain('getmandate keys create web');
    expect(adv).toContain('~/.mandate/keys.json');
    expect(document.body.textContent).not.toContain(KEY);
  });
});
