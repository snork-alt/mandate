/**
 * Claude Code wiring for the driven flow: permission allow rules for the project's Mandate MCP tools, the strict-flow edit
 * guard hook (only with --strict-flow), their removal, and the `mandate guard` hook decision (blocks with exit 2, fails open).
 */
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { guardChange, guardCommand, permissionChange, permissionRule } from '../src/claude-flow.js';
import { guardDecision, type GuardDeps } from '../src/guard.js';
import type { Args } from '../src/args.js';
import { parseArgs } from '../src/args.js';
import { capture, tempCtx, write } from './helpers.js';

const envOf = (ctx: ReturnType<typeof tempCtx>) => ({ ...ctx.env, MANDATE_PORT: '4391' });
const settings = (ctx: ReturnType<typeof tempCtx>) => JSON.parse(readFileSync(path.join(ctx.home, '.claude', 'settings.json'), 'utf8'));
const URL = 'https://mandate.example.com';

describe('permission rules', () => {
  it('connect allows the project\'s Mandate tools in ~/.claude/settings.json, keeping other entries; idempotent; --remove', async () => {
    const ctx = tempCtx();
    write(path.join(ctx.home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)'] } }, null, 2) + '\n');
    const args = ['connect', '--yes', '--no-repo', '--url', URL, '--project', 'web', '--agents', 'claude-code'];
    expect(await run(args, envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(settings(ctx)).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)', 'mcp__mandate-web__*'], deny: ['Bash(rm *)'] } });
    expect(permissionRule('web')).toBe('mcp__mandate-web__*');
    expect(await run(args, envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(settings(ctx).permissions.allow).toEqual(['Bash(ls)', 'mcp__mandate-web__*']);
    expect(await run([...args, '--remove'], envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(settings(ctx).permissions.allow).toEqual(['Bash(ls)']);
  });

  it('not written for agents other than Claude Code', async () => {
    const ctx = tempCtx();
    expect(await run(['connect', '--yes', '--no-repo', '--url', URL, '--project', 'web', '--agents', 'codex'], envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(existsSync(path.join(ctx.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('permissionChange is a no-op when the rule exists; remove of a missing file is null', () => {
    const ctx = tempCtx();
    expect(permissionChange(ctx, 'web', true)).toBeNull();
    write(path.join(ctx.home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__mandate-web__*', 'Bash(ls)'] } }));
    expect(permissionChange(ctx, 'web')).toBeNull();
  });
});

describe('strict-flow edit guard hook', () => {
  const repoOf = (ctx: ReturnType<typeof tempCtx>) => {
    const repo = path.join(ctx.dir, 'repo');
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(repo, '.git'));
    return repo;
  };
  const local = (repo: string) => JSON.parse(readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));

  it('installed only with --strict-flow, in the repo\'s local settings, as one PreToolUse entry; removed with the connection', async () => {
    const ctx = tempCtx();
    const repo = repoOf(ctx);
    const base = ['connect', '--yes', '--url', URL, '--project', 'web', '--agents', 'claude-code'];
    const go = (extra: string[]) => run([...base, ...extra], envOf(ctx), capture(), repo);
    expect(await go([])).toBe(0);
    expect(existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(await go(['--strict-flow'])).toBe(0);
    expect(local(repo).hooks.PreToolUse).toEqual([{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guardCommand(URL, 'web') }] }]);
    expect(guardCommand(URL, 'web')).toBe(`mandate guard --url ${URL} --project web`);
    expect(await go(['--strict-flow'])).toBe(0);
    expect(local(repo).hooks.PreToolUse).toHaveLength(1);
    expect(await go(['--remove'])).toBe(0);
    expect(existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('keeps other hooks; guardChange touches only its own entry', () => {
    const repo = path.join(tempCtx().dir, 'r');
    write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    const c = guardChange(repo, URL, 'web')!;
    expect(JSON.parse(c.after!).hooks.PreToolUse).toHaveLength(2);
    expect(guardChange(repo, URL, 'other', true)).toBeNull();
  });
});

describe('mandate guard decision', () => {
  const ctx = tempCtx();
  const args = (extra = '') => parseArgs(['guard', '--url', URL, '--project', 'web', ...(extra ? extra.split(' ') : [])]) as Args;
  const repo = path.join(ctx.dir, 'repo');
  const deps = (over: Partial<GuardDeps> = {}): GuardDeps => ({
    stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.ts') }, cwd: repo }),
    call: async () => ({ allowed: false, reason: 'no claimed work order: run flow_next' }),
    repoOf: () => ({ root: repo, github: 'acme/app' }),
    ...over,
  });
  const withKey = { ...ctx, env: { ...ctx.env, MANDATE_KEY_WEB: 'mnd_testkey_12345678' } };

  it('blocks (exit 2, reason on stderr) when Mandate says not allowed; passes the repo and relative path', async () => {
    let seen: Record<string, unknown> = {};
    const r = await guardDecision(withKey, args(), deps({ call: async (_u, _k, _p, a) => ((seen = a), { allowed: false, reason: 'no claimed work order: run flow_next' }) }));
    expect(r).toEqual({ code: 2, message: 'Mandate strict flow: no claimed work order: run flow_next' });
    expect(seen).toEqual({ path: path.join('src', 'a.ts'), repo: 'acme/app' });
  });

  it('allows when Mandate allows; ignores edits outside the repo and Claude\'s own files', async () => {
    expect((await guardDecision(withKey, args(), deps({ call: async () => ({ allowed: true }) }))).code).toBe(0);
    expect((await guardDecision(withKey, args(), deps({ stdin: JSON.stringify({ tool_input: { file_path: '/tmp/elsewhere.txt' }, cwd: repo }) }))).code).toBe(0);
    expect((await guardDecision(withKey, args(), deps({ stdin: JSON.stringify({ tool_input: { file_path: path.join(repo, '.claude', 'plans', 'x.md') }, cwd: repo }) }))).code).toBe(0);
    expect((await guardDecision(withKey, args(), deps({ stdin: JSON.stringify({ tool_name: 'Edit', tool_input: {} }) }))).code).toBe(0);
  });

  it('fails open: no token, Mandate unreachable, bad input, missing flags', async () => {
    expect((await guardDecision(ctx, args(), deps())).message).toMatch(/no personal token/);
    expect((await guardDecision(ctx, args(), deps())).code).toBe(0);
    expect(await guardDecision(withKey, args(), deps({ call: async () => null }))).toMatchObject({ code: 0, message: expect.stringMatching(/unreachable/) });
    expect((await guardDecision(withKey, args(), deps({ stdin: 'not json' }))).code).toBe(0);
    expect((await guardDecision(withKey, parseArgs(['guard']) as Args, deps())).code).toBe(0);
  });
});
