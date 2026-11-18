/**
 * What the one-line installer runs (`connect --url <server> --project <id>`): the MCP server entry per agent at user
 * scope (through the adapter registry), skills and commands, a per-agent summary, idempotent updates, `--remove`;
 * never a literal secret in a file an agent could commit.
 */
import { vi } from 'vitest';
// These tests exercise the multi-agent wiring that stays in the code: enable every agent through the shared switch.
vi.mock('../../shared/src/supported-agents.js', async (orig) => ({ ...(await orig<typeof import('../../shared/src/supported-agents.js')>()), SUPPORTED_AGENTS: ['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode', 'junie', 'amp', 'goose', 'cline', 'zed'] }));
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.js';
import { capture, tempCtx, write } from './helpers.js';

const envOf = (ctx: ReturnType<typeof tempCtx>) => ({ ...ctx.env, MANDATE_PORT: '4391' });
const claudeJson = (ctx: ReturnType<typeof tempCtx>) => JSON.parse(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8'));
const codexToml = (ctx: ReturnType<typeof tempCtx>) => readFileSync(path.join(ctx.home, '.codex', 'config.toml'), 'utf8');

describe('installer: connect --url (user scope)', () => {
  it('GitHub sign-in (MCP OAuth) entries (no header, nothing secret), skills, commands and a summary; idempotent; --remove', async () => {
    const ctx = tempCtx();
    const out = capture();
    const args = ['connect', '--yes', '--no-repo', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code,codex,junie'];
    expect(await run(args, envOf(ctx), out, ctx.dir)).toBe(0);
    const entry = claudeJson(ctx).mcpServers['mandate-web'];
    expect(entry).toEqual({ type: 'http', url: 'https://mandate.example.com/p/web/mcp' });
    // Codex does not refresh its list on tools/list_changed: every tool set from the start.
    expect(codexToml(ctx)).toContain('url = "https://mandate.example.com/p/web/mcp?tools=all"');
    expect(codexToml(ctx)).not.toContain('bearer_token_env_var');
    expect(existsSync(path.join(ctx.home, '.claude', 'skills', 'mandate', 'SKILL.md'))).toBe(true);
    const text = out.text();
    expect(text).toMatch(/Claude Code: MCP ✓ skills ✓ commands ✓/);
    expect(text).toMatch(/Junie: MCP needs a personal token/);
    expect(text).toContain('claude mcp list');
    expect(text).toContain('codex mcp login mandate-web');
    expect(existsSync(path.join(ctx.mandateHome, 'env.sh'))).toBe(false); // no token anywhere
    // Idempotent: a second run updates in place (one entry).
    expect(await run(args, envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(Object.keys(claudeJson(ctx).mcpServers)).toEqual(['mandate-web', 'mandate_events_web']); // + the event channel (push.ts)
    expect(codexToml(ctx).match(/\[mcp_servers\.mandate-web\]/g)).toHaveLength(1);
    // --remove (the installer's --uninstall)
    expect(await run([...args, '--remove'], envOf(ctx), capture(), ctx.dir)).toBe(0);
    const f = path.join(ctx.home, '.claude.json');
    expect(!existsSync(f) || claudeJson(ctx).mcpServers?.['mandate-web'] === undefined).toBe(true);
    expect(existsSync(path.join(ctx.home, '.codex', 'config.toml')) ? codexToml(ctx) : '').not.toContain('mandate-web');
  });

  it('--auth token (agents that cannot sign in): entries reference $MANDATE_KEY_<P>; the token lives only in env.sh (0600), never echoed', async () => {
    const ctx = tempCtx();
    const out = capture();
    const env = { ...envOf(ctx), MANDATE_KEY_WEB: 'mndp_web_secret_value_123' };
    expect(await run(['connect', '--yes', '--no-repo', '--auth', 'token', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code,codex,junie'], env, out, ctx.dir)).toBe(0);
    expect(claudeJson(ctx).mcpServers['mandate-web'].headers).toEqual({ Authorization: 'Bearer ${MANDATE_KEY_WEB}' });
    expect(codexToml(ctx)).toContain('bearer_token_env_var = "MANDATE_KEY_WEB"');
    expect(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8')).not.toContain('mndp_web_secret_value_123');
    expect(codexToml(ctx)).not.toContain('mndp_web_secret_value_123');
    expect(readFileSync(path.join(ctx.mandateHome, 'env.sh'), 'utf8')).toContain("MANDATE_KEY_WEB='mndp_web_secret_value_123'");
    expect(out.text()).not.toContain('mndp_web_secret_value_123');
    expect(out.text()).toMatch(/Junie: MCP ✓/); // no env-var expansion: the token in its user config (0600), never a repo
  });

  it('a key in the environment is not used without --auth token (no owner-token path)', async () => {
    const ctx = tempCtx();
    const repo = path.join(ctx.dir, 'repo');
    write(path.join(repo, 'README.md'), 'x\n');
    const env = { ...envOf(ctx), MANDATE_KEY_NOTES: 'mnd_notes_should_not_be_used' };
    expect(await run(['connect', '--yes', '--repo', '--url', 'http://localhost:4391', '--project', 'notes', '--agents', 'claude-code'], env, capture(), repo)).toBe(0);
    // --repo: the project-scope entry only (the user scope would repeat it).
    expect(existsSync(path.join(ctx.home, '.claude.json')) ? claudeJson(ctx).mcpServers?.['mandate-notes'] : undefined).toBeUndefined();
    const project = readFileSync(path.join(repo, '.mcp.json'), 'utf8');
    expect(JSON.parse(project).mcpServers['mandate-notes']).toEqual({ type: 'http', url: 'http://localhost:4391/p/notes/mcp' });
    expect(project).not.toMatch(/Authorization|mnd_/);
    expect(existsSync(path.join(ctx.mandateHome, 'env.sh'))).toBe(false);
  });
});

describe('one Mandate server per config file', () => {
  const stacked = {
    numStartups: 1,
    mcpServers: {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
      'mandate-wafrpay': { type: 'http', url: 'https://mandate.example.com/p/wafrpay/mcp' },
      'mandate-wafrpay2': { type: 'http', url: 'https://mandate.example.com/p/wafrpay2/mcp' },
      wafr3: { type: 'http', url: 'https://mandate.example.com/p/wafrpay3/mcp?tools=all' },
      elsewhere: { type: 'http', url: 'https://other.example.com/p/x/mcp' },
    },
  };

  it('connect replaces the other Mandate entries of the file (by name or URL), prints what it replaced, keeps the rest', async () => {
    const ctx = tempCtx();
    write(path.join(ctx.home, '.claude.json'), `${JSON.stringify(stacked, null, 2)}\n`);
    const out = capture();
    expect(await run(['connect', '--yes', '--no-repo', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code'], envOf(ctx), out, ctx.dir)).toBe(0);
    const j = claudeJson(ctx);
    expect(Object.keys(j.mcpServers).sort()).toEqual(['elsewhere', 'github', 'mandate-web', 'mandate_events_web']);
    expect(j.numStartups).toBe(1);
    expect(out.text().split('\n').filter((l) => l.includes('replaced mandate-wafrpay, mandate-wafrpay2, wafr3'))).toHaveLength(1);
  });

  it('codex: managed blocks of other projects are replaced; its own tables stay', async () => {
    const ctx = tempCtx();
    const args = (p: string) => ['connect', '--yes', '--no-repo', '--url', 'https://mandate.example.com', '--project', p, '--agents', 'codex'];
    expect(await run(args('one'), envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(await run(args('two'), envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(codexToml(ctx)).not.toContain('mandate-one');
    expect(codexToml(ctx).match(/\[mcp_servers\.mandate-/g)).toHaveLength(1);
  });

  it('--repo: project scope replaces stacked project entries and the user-scope entry of the project (Codex keeps it: trusted projects only)', async () => {
    const ctx = tempCtx();
    const repo = path.join(ctx.dir, 'repo');
    write(path.join(repo, 'README.md'), 'x\n');
    write(path.join(repo, '.mcp.json'), `${JSON.stringify({ mcpServers: stacked.mcpServers }, null, 2)}\n`);
    write(path.join(ctx.home, '.claude.json'), `${JSON.stringify({ mcpServers: { 'mandate-web': { type: 'http', url: 'https://mandate.example.com/p/web/mcp' }, github: { type: 'http', url: 'https://x' } } }, null, 2)}\n`);
    expect(await run(['connect', '--yes', '--repo', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code,codex'], envOf(ctx), capture(), repo)).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers).sort()).toEqual(['elsewhere', 'github', 'mandate-web']);
    expect(Object.keys(claudeJson(ctx).mcpServers).sort()).toEqual(['github', 'mandate_events_web']);
    expect(codexToml(ctx)).toContain('[mcp_servers.mandate-web]');
  });
});
