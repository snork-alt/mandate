// @vitest-environment jsdom
/** The one-line installer shown first in the Connect dialog: sh / PowerShell by platform, copy, checksum expander. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InstallOneLiner } from '../src/connect/InstallOneLiner';
import { installCommand, shellFor, verifyCommands } from '../src/connect/snippets';
import { installDom, Wrap } from './dom';

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
  });

  it('renders first in the dialog with the platform\'s command and a checksum expander', () => {
    render(
      <Wrap>
        <InstallOneLiner projectId="web" mcpUrl="https://mandate.example.com/p/web/mcp" userAgent="Mozilla/5.0 (Windows NT 10.0)" />
      </Wrap>,
    );
    expect(screen.getByTestId('install-command').textContent).toBe('irm https://mandate.example.com/p/web/install.ps1 | iex');
    fireEvent.click(screen.getByText('macOS / Linux'));
    expect(screen.getByTestId('install-command').textContent).toBe('curl -fsSL https://mandate.example.com/p/web/install.sh | sh');
    expect(screen.getByTestId('install-verify').textContent).toContain('SHA-256');
    expect(document.body.textContent).not.toMatch(/mnd_|Bearer/);
  });
});
