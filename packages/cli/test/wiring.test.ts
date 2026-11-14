/** install (user scope) / connect (project scope) / uninstall: idempotent, reversible, never a raw key outside ~/.mandate. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AGENTS, agentById } from '../src/agents.js';
import { connectChanges } from '../src/connect.js';
import { applyChanges } from '../src/edits.js';
import { disconnectChanges, uninstallChanges, userWiringChanges } from '../src/install.js';
import { envFile, keysFile } from '../src/context.js';
import { repoSection, writeManifest } from '../src/wiring.js';
import { capture, registerProjects, snapshotTree, tempCtx, write } from './helpers.js';


function setupHome(projects = ['web-app']) {
  const ctx = tempCtx('darwin');
  // Existing user content in several agents' configs.
  write(path.join(ctx.home, '.claude.json'), `${JSON.stringify({ numStartups: 1, mcpServers: { other: { type: 'stdio', command: 'x' } } }, null, 2)}\n`);
  write(path.join(ctx.home, '.codex', 'config.toml'), 'model = "o4"\n');
  write(path.join(ctx.home, '.cursor', 'mcp.json'), '{\n  "mcpServers": {}\n}\n');
  write(path.join(ctx.home, '.zshrc'), 'export EDITOR=vim\n');
  write(path.join(ctx.home, '.claude', 'commands', 'mine.md'), 'mine\n');
  registerProjects(ctx, projects);
  return ctx;
}

describe('install (user scope)', () => {
  it('wires every agent, is idempotent, and keeps keys out of agent files', () => {
    const ctx = setupHome();
    const before = snapshotTree(ctx.home);
    const { changes, skipped } = userWiringChanges(ctx, AGENTS, 'http://localhost:4000');
    // Agents that cannot sign in with GitHub by themselves are skipped (personal token: connect --auth token).
    expect(skipped.map((x) => x.split(':')[0]).sort()).toEqual(['Amp', 'Cline', 'JetBrains Junie', 'Zed']);
    applyChanges(changes, { dryRun: false, out: capture() });
    // MCP OAuth: no key anywhere (no keys.json, no env.sh, no Authorization header).
    expect(existsSync(keysFile(ctx))).toBe(false);
    expect(existsSync(envFile(ctx))).toBe(false);
    const claude = JSON.parse(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8')).mcpServers;
    expect(claude['mandate-web-app']).toEqual({ type: 'http', url: 'http://localhost:4000/p/web-app/mcp' });
    expect(readFileSync(path.join(ctx.home, '.codex', 'config.toml'), 'utf8')).not.toContain('bearer_token_env_var');
    expect(JSON.parse(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('other');
    expect(existsSync(path.join(ctx.home, '.claude', 'skills', 'mandate', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(ctx.home, '.agents', 'skills', 'mandate', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(ctx.home, '.claude', 'commands', 'mandate-flow.md'))).toBe(true);
    expect(existsSync(path.join(ctx.home, '.gemini', 'commands', 'mandate-bootstrap.toml'))).toBe(true);
    // Idempotent.
    expect(userWiringChanges(ctx, AGENTS, 'http://localhost:4000').changes.filter(Boolean)).toEqual([]);
    // Uninstall restores the user's files (the cursor file had an empty mcpServers, which stays pruned).
    applyChanges(uninstallChanges(ctx), { dryRun: false, out: capture() });
    const after = snapshotTree(ctx.home);
    for (const f of Object.keys(after)) if (f.startsWith('.mandate/')) delete after[f];
    const expected = { ...before };
    for (const f of Object.keys(expected)) if (f.startsWith('.mandate/')) delete expected[f];
    expected['.cursor/mcp.json'] = '{}\n';
    delete expected['.cursor/mcp.json'];
    expect(after).toEqual(expected);
  });

  it('several projects: no user-scope MCP entries (one Mandate server per config file); skills and commands still', () => {
    const ctx = setupHome(['web-app', 'api']);
    const { changes, skipped } = userWiringChanges(ctx, AGENTS, 'http://localhost:4000');
    expect(skipped.some((x) => /2 projects: user-scope MCP entries not written/.test(x))).toBe(true);
    applyChanges(changes, { dryRun: false, out: capture() });
    expect(Object.keys(JSON.parse(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8')).mcpServers)).toEqual(['other']);
    expect(existsSync(path.join(ctx.home, '.claude', 'skills', 'mandate', 'SKILL.md'))).toBe(true);
  });

  it('dry-run writes nothing', () => {
    const ctx = setupHome();
    const before = snapshotTree(ctx.home);
    const { changes } = userWiringChanges(ctx, AGENTS, 'http://localhost:4000');
    const out = capture();
    applyChanges(changes, { dryRun: true, out, home: ctx.home });
    const now = snapshotTree(ctx.home);
    delete now['.mandate/keys.json']; // keys are ensured (as the server does on startup)
    expect(now).toEqual(before);
    expect(out.text()).toContain('would create ~/.claude/skills/mandate/SKILL.md');
    expect(out.text()).not.toMatch(/mnd_[A-Za-z0-9]{8}/);
  });
});

describe('connect (project scope)', () => {
  it('writes env-var MCP entries and a marked section; disconnect restores the repo', () => {
    const ctx = setupHome();
    const repo = path.join(ctx.dir, 'repo');
    write(path.join(repo, 'CLAUDE.md'), '# Repo\n\nOur rules.\n');
    write(path.join(repo, '.vscode', 'settings.json'), '{\n  "editor.tabSize": 2\n}\n');
    const before = snapshotTree(repo);
    const { changes } = connectChanges(ctx, repo, 'web-app', 'https://mandate.example.com', AGENTS);
    applyChanges(changes, { dryRun: false, out: capture() });
    const tree = snapshotTree(repo);
    expect(Object.keys(tree).sort()).toMatchSnapshot();
    for (const [f, t] of Object.entries(tree)) {
      expect(t, f).not.toMatch(/mnd_/);
      if (/mcp|settings\.json|config\.toml|opencode\.json/.test(f) && f !== '.vscode/settings.json') expect(t, f).toContain('https://mandate.example.com/p/web-app/mcp');
    }
    expect(tree['CLAUDE.md']).toMatch(/^# Repo\n\nOur rules\.\n\n<!-- mandate:begin section .*-->\n## Mandate\n[\s\S]*<!-- mandate:end section -->\n$/);
    expect(connectChanges(ctx, repo, 'web-app', 'https://mandate.example.com', AGENTS).changes.filter(Boolean)).toEqual([]);
    applyChanges(disconnectChanges(ctx, repo, 'web-app'), { dryRun: false, out: capture() });
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('writes AGENTS.md for non-Claude agents when no instruction file exists', () => {
    const ctx = setupHome();
    const repo = path.join(ctx.dir, 'r2');
    write(path.join(repo, 'x'), '');
    const { changes } = connectChanges(ctx, repo, 'api', 'http://localhost:4000', [agentById('codex')!]);
    expect(changes.filter(Boolean).map((c) => path.relative(repo, c!.file)).sort()).toEqual(['.codex/config.toml', 'AGENTS.md']);
    const cc = connectChanges(ctx, repo, 'api', 'http://localhost:4000', [agentById('claude-code')!]).changes.filter(Boolean).map((c) => path.relative(repo, c!.file)).sort();
    expect(cc).toEqual(['.claude/commands/mandate-bootstrap.md', '.claude/commands/mandate-flow.md', '.mcp.json', 'CLAUDE.md']);
  });

  it('uninstall also removes the wiring of connected repos (manifest)', () => {
    const ctx = setupHome();
    const repo = path.join(ctx.dir, 'repo');
    write(path.join(repo, 'README.md'), 'hi\n');
    applyChanges(connectChanges(ctx, repo, 'api', 'http://localhost:4000', [agentById('claude-code')!]).changes, { dryRun: false, out: capture() });
    writeManifest(ctx, { version: 1, repos: [{ repo, project: 'api', agents: ['claude-code'], at: 'now' }] });
    applyChanges(uninstallChanges(ctx), { dryRun: false, out: capture() });
    expect(snapshotTree(repo)).toEqual({ 'README.md': 'hi\n' });
  });
});

describe('repoSection', () => {
  it('stays within its token budget (tokens ≈ chars / 4)', () => {
    const t = repoSection('web-app', 'https://mandate.example.com/p/web-app/mcp');
    for (const x of ['project_info', 'explicit user confirmation', '/mandate-flow', '/mandate-bootstrap']) expect(t).toContain(x);
    expect(Math.ceil(t.length / 4)).toBeLessThanOrEqual(130);
  });
});
