/** The command dispatcher end to end in a temp HOME (no service, no server, no browser). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.js';
import { configFile } from '../src/context.js';
import { parseArgs } from '../src/args.js';
import { capture, tempCtx, write } from './helpers.js';

const envOf = (ctx: ReturnType<typeof tempCtx>, port = 4391) => ({ ...ctx.env, MANDATE_PORT: String(port) });

describe('mandate CLI', () => {
  it('parses flags', () => {
    expect(parseArgs(['install', '--yes', '--mode', 'server', '--public-url=https://x.y', '--no-service', '-n', '5', 'pos'])).toMatchObject({
      cmd: 'install',
      positional: ['pos'],
      flags: { yes: true, mode: 'server', 'public-url': 'https://x.y', service: false, lines: '5' },
    });
  });

  it('help and version', async () => {
    const out = capture();
    expect(await run(['help'], {}, out)).toBe(0);
    expect(out.text()).toContain('npx getmandate install');
    expect(await run(['nope'], {}, capture())).toBe(2);
  });

  it('status --json when stopped', async () => {
    const ctx = tempCtx();
    const out = capture();
    expect(await run(['status', '--json'], envOf(ctx), out, ctx.dir)).toBe(3);
    expect(JSON.parse(out.text())).toMatchObject({ running: false, mode: 'local', port: 4391, setup: 'pending', projects: 0 });
  });

  it('install --mode local --yes: config, projects folder, no GitHub mention', async () => {
    const ctx = tempCtx();
    const out = capture();
    expect(await run(['install', '--yes', '--no-service', '--no-open', '--no-agents'], envOf(ctx), out, ctx.dir)).toBe(0);
    expect(JSON.parse(readFileSync(configFile(ctx), 'utf8')).server).toMatchObject({ mode: 'local', bind: '127.0.0.1', port: 4391 });
    expect(existsSync(path.join(ctx.home, 'mandate'))).toBe(true);
    expect(out.text()).not.toMatch(/github/i);
    // Idempotent: a second run keeps the mode.
    expect(await run(['install', '--yes', '--no-service', '--no-open', '--no-agents'], envOf(ctx), capture(), ctx.dir)).toBe(0);
  });

  it('install --mode server: public URL, proxy snippets, http warning, tunnel guidance', async () => {
    const ctx = tempCtx('linux');
    const out = capture();
    const code = await run(['install', '--yes', '--mode', 'server', '--public-url', 'http://mandate.example.com', '--no-behind-proxy', '--no-service', '--no-agents'], envOf(ctx), out, ctx.dir);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(configFile(ctx), 'utf8')).server).toEqual({ mode: 'server', port: 4391, bind: '0.0.0.0', trustProxy: false, publicUrl: 'http://mandate.example.com' });
    expect(out.text()).toMatch(/plain http/);
    expect(out.text()).toContain('flush_interval -1');
    expect(out.text()).toContain('proxy_buffering off;');
    const https = tempCtx('linux');
    await run(['install', '--yes', '--mode', 'server', '--public-url', 'https://mandate.example.com', '--no-service', '--no-agents'], envOf(https), capture(), https.dir);
    expect(JSON.parse(readFileSync(configFile(https), 'utf8')).server).toMatchObject({ bind: '127.0.0.1', trustProxy: true });
  });

  it('server mode without a public URL fails clearly', async () => {
    const ctx = tempCtx();
    await expect(run(['install', '--yes', '--mode', 'server', '--no-service'], envOf(ctx), capture(), ctx.dir)).rejects.toThrow(/public-url/);
  });

  it('install --dry-run writes nothing', async () => {
    const ctx = tempCtx();
    write(path.join(ctx.home, '.claude', 'settings.json'), '{}\n');
    const out = capture();
    expect(await run(['install', '--yes', '--dry-run', '--no-service', '--no-open'], envOf(ctx), out, ctx.dir)).toBe(0);
    expect(existsSync(ctx.mandateHome)).toBe(false);
    expect(existsSync(path.join(ctx.home, '.claude', 'skills'))).toBe(false);
    expect(out.text()).toContain('would create ~/.claude/skills/mandate/SKILL.md');
  });

  it('key commands keep working under the same binary', async () => {
    const ctx = tempCtx();
    const out = capture();
    expect(await run(['key', 'list'], envOf(ctx), out, ctx.dir)).toBe(0);
    expect(out.text()).toMatch(/no keys|default/);
  });

  it('connect --url (developer machine, remote server): public URL in configs, key only in env.sh, merged', async () => {
    const ctx = tempCtx();
    const repo = path.join(ctx.dir, 'repo');
    write(path.join(repo, 'README.md'), 'x\n');
    write(path.join(ctx.mandateHome, 'env.sh'), "export MANDATE_KEY_OTHER='mnd_other_keepme'\n");
    const env = { ...envOf(ctx), MANDATE_KEY_WEB: 'mnd_web_abcdefghijklmnop' };
    const out = capture();
    expect(await run(['connect', '--yes', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code,codex'], env, out, repo)).toBe(0);
    const mcp = readFileSync(path.join(repo, '.mcp.json'), 'utf8');
    expect(mcp).toContain('https://mandate.example.com/p/web/mcp');
    expect(mcp).not.toContain('mnd_');
    const sh = readFileSync(path.join(ctx.mandateHome, 'env.sh'), 'utf8');
    expect(sh).toContain("export MANDATE_KEY_OTHER='mnd_other_keepme'");
    expect(sh).toContain("export MANDATE_KEY_WEB='mnd_web_abcdefghijklmnop'");
    expect(out.text()).not.toContain('mnd_web_abcdefghijklmnop');
    expect(await run(['connect', '--remove'], env, capture(), repo)).toBe(0);
    expect(existsSync(path.join(repo, '.mcp.json'))).toBe(false);
  });
});
