/**
 * Adapter registry: per agent, MCP config merging with fixtures (idempotent, removal restores the file, keys only
 * where allowed), the files written by install / connect / uninstall (snapshots), shared locations, --force gating.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AGENTS, agentById, can, CHECKED, commandChanges, cursorCommand, geminiCommand, makeServer, markdownCommand, mcpRemove, mcpUpsert, skillChanges, skillMd, bootstrapSkillMd, COMMANDS, STUB_VERSION, vscodePrompt } from '../src/agents.js';
import { applyChanges, change } from '../src/edits.js';
import { connectChanges } from '../src/connect.js';
import { uninstallChanges, userWiringChanges } from '../src/install.js';
import { inventory } from '../src/inventory.js';
import { capture, registerProjects, snapshotTree, tempCtx, write } from './helpers.js';

const server = makeServer('http://localhost:4000', 'web-app');

/** Existing user content per agent (as the agents write it). */
const FIXTURES: Record<string, string> = {
  'claude-code': `${JSON.stringify({ numStartups: 3, mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } }, projects: {} }, null, 2)}\n`,
  codex: 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n',
  cursor: `${JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }, null, 2)}\n`,
  vscode: `${JSON.stringify({ servers: { gh: { type: 'http', url: 'https://x' } }, inputs: [] }, null, '\t')}\n`,
  gemini: `${JSON.stringify({ theme: 'Default', mcpServers: { fs: { command: 'npx', args: ['fs-mcp'] } } }, null, 2)}\n`,
  windsurf: `${JSON.stringify({ mcpServers: { figma: { serverUrl: 'https://figma/mcp' } } }, null, 2)}\n`,
  opencode: `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', theme: 'tokyonight' }, null, 2)}\n`,
  junie: `${JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }, null, 2)}\n`,
  amp: `${JSON.stringify({ 'amp.theme': 'dark', 'amp.mcpServers': { playwright: { command: 'npx' } } }, null, 2)}\n`,
  cline: `${JSON.stringify({ mcpServers: { gh: { type: 'streamableHttp', url: 'https://x' } } }, null, 2)}\n`,
  zed: `${JSON.stringify({ theme: 'One Dark', context_servers: { other: { url: 'https://x' } } }, null, 2)}\n`,
};

const writable = AGENTS.filter((a) => a.userMcp && a.caps.mcp !== 'manual');

describe('adapter metadata', () => {
  it('every adapter cites official docs, declares every capability and its instructions file', () => {
    expect(CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const a of AGENTS) {
      expect(a.docs.length, a.id).toBeGreaterThan(0);
      for (const u of a.docs) expect(u, a.id).toMatch(/^https:\/\//);
      for (const k of ['mcp', 'skills', 'commands'] as const) expect(['verified', 'unverified', 'manual', 'unsupported']).toContain(a.caps[k]);
      expect(a.caps.instructions.length, a.id).toBeGreaterThan(0);
      if (a.caps.commands !== 'unsupported') expect(a.commands, a.id).toBeDefined();
    }
    expect(AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode', 'junie', 'amp', 'goose', 'cline', 'zed']);
    expect(agentById('claude')?.id).toBe('claude-code');
    expect(agentById('copilot')?.id).toBe('vscode');
  });
});

describe.each(writable.map((a) => a.id))('%s MCP', (id) => {
  const agent = agentById(id)!;
  it('merges into the existing user config, idempotently; removal restores it', () => {
    const ctx = tempCtx('darwin');
    const target = agent.userMcp!(ctx);
    write(target.file, FIXTURES[id]!);
    const s = agent.envSyntax === null ? { ...server, key: 'mnd_web-app_SECRETKEY123' } : server;
    applyChanges([mcpUpsert(agent, target, s)], { dryRun: false, out: capture() });
    const text = readFileSync(target.file, 'utf8');
    expect(mcpUpsert(agent, target, s)).toBeNull();
    expect(text).toContain('http://localhost:4000/p/web-app/mcp');
    if (agent.envSyntax === null) expect(text).toContain('mnd_web-app_SECRETKEY123');
    else {
      expect(text).not.toMatch(/mnd_/);
      expect(text).toContain('MANDATE_KEY_WEB_APP');
    }
    if (target.format === 'json') {
      const before = JSON.parse(FIXTURES[id]!);
      const after = JSON.parse(text);
      for (const k of Object.keys(before)) if (!['mcpServers', 'servers', 'mcp', 'amp.mcpServers', 'context_servers'].includes(k)) expect(after[k]).toEqual(before[k]);
      expect(agent.jsonPath!(s, text, target.file).reduce((o: any, k) => o?.[k], after)).toMatchSnapshot();
    } else expect(text).toContain('bearer_token_env_var = "MANDATE_KEY_WEB_APP"');
    applyChanges([mcpRemove(agent, target, server.name)], { dryRun: false, out: capture() });
    expect(readFileSync(target.file, 'utf8')).toBe(FIXTURES[id]!);
  });
});

/** Files written for one agent (install + connect), relative, sorted. */
function filesFor(id: string) {
  const ctx = tempCtx('darwin');
  registerProjects(ctx, ['web-app']);
  const agent = agentById(id)!;
  const home0 = snapshotTree(ctx.home);
  const { changes } = userWiringChanges(ctx, [agent], 'http://localhost:4000');
  applyChanges(changes, { dryRun: false, out: capture() });
  const repo = path.join(ctx.dir, 'repo');
  write(path.join(repo, 'README.md'), 'x\n');
  const repo0 = snapshotTree(repo);
  applyChanges(connectChanges(ctx, repo, 'web-app', 'http://localhost:4000', [agent]).changes, { dryRun: false, out: capture() });
  const installed = Object.keys(snapshotTree(ctx.home)).filter((f) => !f.startsWith('.mandate/')).sort();
  const connected = Object.keys(snapshotTree(repo)).filter((f) => f !== 'README.md').sort();
  // Idempotent.
  expect(userWiringChanges(ctx, [agent], 'http://localhost:4000').changes.filter(Boolean)).toEqual([]);
  expect(connectChanges(ctx, repo, 'web-app', 'http://localhost:4000', [agent]).changes.filter(Boolean)).toEqual([]);
  // No key in the repo, ever.
  for (const [f, t] of Object.entries(snapshotTree(repo))) expect(t, f).not.toMatch(/mnd_|mndp_/);
  // Uninstall (with the manifest entry connect would write) restores home and repo.
  write(path.join(ctx.mandateHome, 'wiring.json'), JSON.stringify({ version: 1, repos: [{ repo, project: 'web-app', agents: [id], at: 'now' }] }));
  applyChanges(uninstallChanges(ctx), { dryRun: false, out: capture() });
  const homeAfter = snapshotTree(ctx.home);
  for (const f of Object.keys(homeAfter)) if (f.startsWith('.mandate/')) delete homeAfter[f];
  for (const f of Object.keys(home0)) if (f.startsWith('.mandate/')) delete home0[f];
  expect(homeAfter).toEqual(home0);
  expect(snapshotTree(repo)).toEqual(repo0);
  return { installed, connected };
}

describe.each(AGENTS.map((a) => a.id))('%s install / connect / uninstall', (id) => {
  it('writes exactly these files, idempotently, and uninstall removes them', () => {
    expect(filesFor(id)).toMatchSnapshot();
  });
});

describe('shared locations and gating', () => {
  it('~/.agents/skills is written once for several agents and kept while another agent still reads it', () => {
    const ctx = tempCtx();
    write(path.join(ctx.home, '.codex', 'x'), '');
    write(path.join(ctx.home, '.cursor', 'x'), '');
    const both = [agentById('codex')!, agentById('cursor')!];
    const ch = skillChanges(ctx, both).filter(Boolean).map((c) => c!.file.replace(ctx.home, '~'));
    expect(ch.sort()).toEqual(['~/.agents/skills/mandate-bootstrap/SKILL.md', '~/.agents/skills/mandate/SKILL.md']);
    applyChanges(skillChanges(ctx, both), { dryRun: false, out: capture() });
    // Uninstall codex only: cursor (detected) still reads the shared folder.
    applyChanges(uninstallChanges(ctx, [agentById('codex')!]), { dryRun: false, out: capture() });
    expect(existsSync(path.join(ctx.home, '.agents', 'skills', 'mandate', 'SKILL.md'))).toBe(true);
    const inv = inventory(ctx, [agentById('cursor')!])[0]!;
    expect(inv.shared[0]).toMatchObject({ path: '~/.agents/skills', with: expect.arrayContaining(['codex']) });
    applyChanges(uninstallChanges(ctx), { dryRun: false, out: capture() });
    expect(existsSync(path.join(ctx.home, '.agents', 'skills', 'mandate'))).toBe(false);
  });

  it('unverified capabilities are written only with --force (Junie commands, Zed MCP)', () => {
    const ctx = tempCtx();
    registerProjects(ctx, ['web-app']);
    const junie = agentById('junie')!;
    const zed = agentById('zed')!;
    expect(can(junie, 'commands')).toBe(false);
    expect(commandChanges(ctx, [junie]).filter(Boolean)).toEqual([]);
    const { changes, skipped } = userWiringChanges(ctx, [zed], 'http://localhost:4000');
    expect(changes.filter(Boolean).some((c) => c!.file.includes('zed'))).toBe(false);
    expect(skipped[0]).toMatch(/unverified/);
    const forced = { ...ctx, force: true };
    expect(commandChanges(forced, [junie]).filter(Boolean).length).toBe(COMMANDS.length);
    // Forced past the unverified location, Zed still cannot sign in with GitHub by itself: a personal token is needed.
    expect(userWiringChanges(forced, [zed], 'http://localhost:4000').skipped[0]).toMatch(/cannot sign in by itself/);
  });
});

describe('skills and command templates', () => {
  it('two skills, open-format front matter, one source each', () => {
    expect(skillMd()).toMatch(/^---\nname: mandate\ndescription: ".+"\nmetadata:\n  managed-by: mandate\n---\n/);
    expect(bootstrapSkillMd()).toMatch(/^---\nname: mandate-bootstrap\ndescription: ".+"\nmetadata:\n  managed-by: mandate\n---\n/);
    // Stubs: the text itself comes from the server (instructions_get), so a server update needs no reinstall.
    expect(skillMd()).toContain('instructions_get {"name":"core","stubVersion":' + STUB_VERSION + '}');
    expect(bootstrapSkillMd()).toContain('instructions_get {"name":"bootstrap"');
    for (const md of [skillMd(), bootstrapSkillMd()]) {
      expect(md).toContain(`mandate-stub v${STUB_VERSION} `);
      expect(md).toMatch(/stop and tell the user/);
      expect(md).not.toMatch(/## Intake|Stage 2: DISTILL/);
      expect(Math.ceil(md.length / 4)).toBeLessThanOrEqual(300); // front matter (description) + stub; the full skill was ~2,200
    }
    expect(skillMd()).toMatchSnapshot();
  });
  it('each command renders per agent format', () => {
    for (const c of COMMANDS) {
      expect(markdownCommand(c)).toContain('"$ARGUMENTS"');
      expect(geminiCommand(c)).toContain('{{args}}');
      expect(vscodePrompt(c)).toContain('${input:args}');
      expect(cursorCommand(c)).toContain('(the text after the command)');
    }
    expect(COMMANDS.map((c) => markdownCommand(c))).toMatchSnapshot();
    // /mandate-flow as written for every agent that has commands: a stub that loads the current text from the server.
    for (const a of AGENTS.filter((x) => x.commands)) {
      const flow = a.commands!.render(COMMANDS[0]!);
      expect(flow, a.id).toContain('instructions_get {"name":"flow","args":');
      expect(flow, a.id).toContain(`"stubVersion":${STUB_VERSION}`);
      expect(flow, a.id).not.toMatch(/Claude/);
      expect(flow).toMatchSnapshot(a.id);
    }
  });
  it('inventory flags installed files that are not the current stub (full text of an earlier version)', () => {
    const ctx = tempCtx();
    const cc = agentById('claude-code')!;
    applyChanges([...skillChanges(ctx, [cc]), ...commandChanges(ctx, [cc])], { dryRun: false, out: capture() });
    expect(inventory(ctx, [cc])[0]!.outdated).toEqual([]);
    write(`${ctx.home}/.claude/skills/mandate/SKILL.md`, '---\nname: mandate\n---\n<!-- managed by mandate -->\n# Mandate\nold full text\n');
    expect(inventory(ctx, [cc])[0]!.outdated).toEqual(['~/.claude/skills/mandate/SKILL.md']);
    // Install / connect overwrite managed files with the current stub.
    applyChanges(skillChanges(ctx, [cc]), { dryRun: false, out: capture() });
    expect(inventory(ctx, [cc])[0]!.outdated).toEqual([]);
  });
  it('uninstall also removes the slash commands of earlier versions (managed only)', () => {
    const ctx = tempCtx();
    write(`${ctx.home}/.claude/commands/mandate-verify.md`, '<!-- managed by mandate -->\nold\n');
    write(`${ctx.home}/.gemini/commands/mandate/impact.toml`, '# managed by mandate\n');
    write(`${ctx.home}/.claude/commands/mandate-impact.md`, 'my own\n');
    const rm = commandChanges(ctx, AGENTS, true).filter(Boolean).map((c) => c!.file.replace(ctx.home, '~'));
    expect(rm.sort()).toEqual(['~/.claude/commands/mandate-verify.md', '~/.gemini/commands/mandate/impact.toml']);
  });
  it('never overwrites user files with the same name; refuses an unmanaged skill', () => {
    const ctx = tempCtx();
    const cc = agentById('claude-code')!;
    const mine = `${ctx.home}/.claude/commands/mandate-flow.md`;
    write(mine, 'my own flow command\n');
    applyChanges([...commandChanges(ctx, [cc])], { dryRun: false, out: capture() });
    expect(readFileSync(mine, 'utf8')).toBe('my own flow command\n');
    applyChanges(commandChanges(ctx, [cc], true), { dryRun: false, out: capture() });
    expect(readFileSync(mine, 'utf8')).toBe('my own flow command\n');
    expect(change(`${ctx.home}/nothing`, null, 'x')).toBeNull();
    write(`${ctx.home}/.claude/skills/mandate/SKILL.md`, '---\nname: mandate\n---\nmine\n');
    expect(() => skillChanges(ctx, [cc])).toThrow(/not managed/);
  });
});
