// @vitest-environment jsdom
/** The one-line installer: sh / PowerShell by platform, per-agent `--agents`, copy; the compact per-agent block. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstallOneLiner } from '../src/connect/InstallOneLiner';
import { agentDef, installFlags } from '../src/connect/agentCatalog';
import { installCommand, shellFor, uninstallCommand, verifyCommands } from '../src/connect/snippets';
import { installDom, Wrap } from './dom';

// Multi-agent UI: enable every agent through the shared switch (the default shows Claude Code only: supported-agents.test.tsx).
vi.mock('@mandate/shared', async (orig) => ({ ...(await orig<typeof import('@mandate/shared')>()), SUPPORTED_AGENTS: ['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode', 'junie', 'amp', 'goose', 'cline', 'zed'] }));

beforeAll(installDom);
afterEach(cleanup);

describe('installer snippets', () => {
  it('one line per platform, no token, the project path', () => {
    expect(installCommand('https://mandate.example.com/', 'web', 'sh')).toBe('curl -fsSL https://mandate.example.com/p/web/install.sh | sh');
    expect(installCommand('https://mandate.example.com', 'web', 'powershell')).toBe('irm https://mandate.example.com/p/web/install.ps1 | iex');
    expect(shellFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('powershell');
    expect(shellFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('sh');
    expect(verifyCommands('https://m.example.com', 'web', 'sh')).toContain('install.sh.sha256 | shasum -a 256 -c -');
    expect(verifyCommands('https://m.example.com', 'web', 'powershell')).toContain('Get-FileHash install.ps1 -Algorithm SHA256');
    expect(uninstallCommand('https://m.example.com/', 'sh')).toBe('curl -fsSL https://m.example.com/uninstall.sh | sh');
    expect(uninstallCommand('https://m.example.com', 'powershell')).toBe('irm https://m.example.com/uninstall.ps1 | iex');
  });

  it('passes the agent to getmandate connect (sh -s -- / the scriptblock form of install.ps1)', () => {
    expect(installCommand('https://m.example.com', 'web', 'sh', '--agents claude-code')).toBe('curl -fsSL https://m.example.com/p/web/install.sh | sh -s -- --agents claude-code');
    expect(installCommand('https://m.example.com', 'web', 'powershell', '--agents codex')).toBe('& ([scriptblock]::Create((irm https://m.example.com/p/web/install.ps1))) --agents codex');
    expect(verifyCommands('https://m.example.com', 'web', 'sh', '--agents codex')).toMatch(/\nsh install\.sh --agents codex$/);
    expect(verifyCommands('https://m.example.com', 'web', 'powershell', '--agents codex')).toMatch(/\n\.\\install\.ps1 --agents codex$/);
    // Agents without MCP OAuth need a personal token on a team server.
    expect(installFlags(agentDef('claude-code'), true)).toBe('--agents claude-code');
    expect(installFlags(agentDef('junie'), true)).toBe('--agents junie --auth token');
    expect(installFlags(agentDef('junie'), false)).toBe('--agents junie');
  });

  it('compact block: agent tabs, the platform command, sign-in in one line', () => {
    render(
      <Wrap>
        <InstallOneLiner projectId="web" mcpUrl="https://mandate.example.com/p/web/mcp" userAgent="Mozilla/5.0 (Windows NT 10.0)" />
      </Wrap>,
    );
    expect(screen.getByTestId('install-command').textContent).toBe('& ([scriptblock]::Create((irm https://mandate.example.com/p/web/install.ps1))) --agents claude-code');
    fireEvent.click(screen.getByText('macOS / Linux'));
    expect(screen.getByTestId('install-command').textContent).toBe('curl -fsSL https://mandate.example.com/p/web/install.sh | sh -s -- --agents claude-code');
    expect(screen.getByTestId('signin-inline').textContent).toContain('/mcp');
    expect(screen.getByTestId('signin-inline').textContent).toContain('mandate-web');
    fireEvent.click(screen.getByTestId('agent-tab-codex'));
    expect(screen.getByTestId('install-command').textContent).toBe('curl -fsSL https://mandate.example.com/p/web/install.sh | sh -s -- --agents codex');
    expect(screen.getByTestId('signin-inline').textContent).toContain('codex mcp login mandate-web');
    expect(document.body.textContent).not.toMatch(/mnd_|Bearer/);
  });
});
