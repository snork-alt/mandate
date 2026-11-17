/** `mandate channel login`: browser approval (device authorization) against a fake server, fake browser opener; paste fallback; the installer's automatic login. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from '../src/args.js';
import { cmdChannelLogin } from '../src/login.js';
import { cmdConnect } from '../src/connect.js';
import { tokenFile } from '../src/events.js';
import { Prompter } from '../src/ui.js';
import type { Runtime } from '../src/install.js';
import { capture, tempCtx } from './helpers.js';

let server: http.Server;
let base: string;
let mode: 'approve' | 'deny' | 'expire' = 'approve';
let polls = 0;
let startBody: Record<string, unknown> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const b = body ? JSON.parse(body) : {};
      if (req.url === '/auth/cli/start') {
        startBody = b;
        return j(201, { deviceCode: 'D'.repeat(43), userCode: 'ABCD-2345', verificationPath: '/cli-login?code=ABCD-2345', interval: 0.01, expiresIn: 600 });
      }
      if (req.url === '/auth/cli/poll') {
        polls++;
        if (polls < 3) return j(200, { status: 'pending' });
        if (mode === 'approve') return j(200, { status: 'approved', token: 'mndp_web_abcdefghijklmnop', project: 'web', login: 'octo' });
        return j(200, { status: mode === 'deny' ? 'denied' : 'expired' });
      }
      j(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

function rt(tty = false, opened: string[] = []) {
  const ctx = tempCtx();
  const out = capture();
  const r: Runtime = { ctx, out, prompt: new Prompter(false), dryRun: false, login: { open: (u) => (opened.push(u), true), hostname: () => 'my-laptop', tty, sleep: async () => undefined } };
  return { ctx, out, r, opened };
}

describe('mandate channel login (browser)', () => {
  it('starts a login, opens the approval page, polls, stores the token 0600', async () => {
    polls = 0;
    mode = 'approve';
    const { ctx, out, r, opened } = rt();
    expect(await cmdChannelLogin(r, parseArgs(['channel', 'login', '--project', 'web', '--url', base]))).toBe(0);
    expect(startBody).toEqual({ project: 'web', hostname: 'my-laptop' });
    expect(opened).toEqual([`${base}/cli-login?code=ABCD-2345`]);
    expect(out.text()).toContain('ABCD-2345');
    expect(readFileSync(tokenFile(ctx, 'web'), 'utf8').trim()).toBe('mndp_web_abcdefghijklmnop');
    expect(statSync(tokenFile(ctx, 'web')).mode & 0o777).toBe(0o600);
    expect(out.text()).toContain('mandate claude');
  });

  it.each(['deny', 'expire'] as const)('%s: fails, stores nothing, points at --paste', async (m) => {
    polls = 0;
    mode = m;
    const { ctx, out, r } = rt();
    expect(await cmdChannelLogin(r, parseArgs(['channel', 'login', '--project', 'web', '--url', base]))).toBe(1);
    expect(existsSync(tokenFile(ctx, 'web'))).toBe(false);
    expect(out.text()).toContain('--paste');
  });

  it('prints the page when the browser cannot be opened; unreachable server falls back to --paste advice', async () => {
    polls = 0;
    mode = 'approve';
    const a = rt();
    a.r.login!.open = () => false;
    expect(await cmdChannelLogin(a.r, parseArgs(['channel', 'login', '--project', 'web', '--url', base]))).toBe(0);
    expect(a.out.text()).toContain(`open this page in your browser: ${base}/cli-login?code=ABCD-2345`);
    const b = rt();
    expect(await cmdChannelLogin(b.r, parseArgs(['channel', 'login', '--project', 'web', '--url', 'http://127.0.0.1:1']))).toBe(1);
    expect(b.out.text()).toContain('cannot reach');
  });

  it('--paste / --token / MANDATE_CHANNEL_TOKEN keep working without any server call', async () => {
    const { ctx, r } = rt();
    expect(await cmdChannelLogin(r, parseArgs(['channel', 'login', '--project', 'web', '--token', 'mndp_web_zzzzzzzzzzzz']))).toBe(0);
    expect(readFileSync(tokenFile(ctx, 'web'), 'utf8').trim()).toBe('mndp_web_zzzzzzzzzzzz');
    const e = rt();
    e.ctx.env.MANDATE_CHANNEL_TOKEN = 'mndp_web_envenvenvenv';
    expect(await cmdChannelLogin(e.r, parseArgs(['channel', 'login', '--project', 'web']))).toBe(0);
    expect(readFileSync(tokenFile(e.ctx, 'web'), 'utf8').trim()).toBe('mndp_web_envenvenvenv');
    const bad = rt();
    expect(await cmdChannelLogin(bad.r, parseArgs(['channel', 'login', '--project', 'web', '--paste']))).toBe(2);
  });
});

describe('installer: connect runs the channel login', () => {
  const connect = (r: Runtime, extra: string[] = []) => cmdConnect(r, parseArgs(['connect', '--no-repo', '--url', base, '--project', 'web', '--agents', 'claude-code', ...extra]));

  it('with a terminal and no token: approval in the browser, token stored', async () => {
    polls = 0;
    mode = 'approve';
    const { ctx, out, r, opened } = rt(true);
    expect(await connect(r)).toBe(0);
    expect(opened).toHaveLength(1);
    expect(readFileSync(tokenFile(ctx, 'web'), 'utf8').trim()).toBe('mndp_web_abcdefghijklmnop');
    expect(out.text()).not.toContain('needs a one-time approval');
  });

  it('without a terminal: one clear line with the command; nothing is opened', async () => {
    const { ctx, out, r, opened } = rt(false);
    expect(await connect(r)).toBe(0);
    expect(opened).toHaveLength(0);
    expect(existsSync(tokenFile(ctx, 'web'))).toBe(false);
    expect(out.text()).toContain(`mandate channel login --project web --url ${base}`);
  });

  it('with a token already: no login; denied login does not fail the install', async () => {
    const a = rt(true);
    a.ctx.env.MANDATE_CHANNEL_TOKEN = 'mndp_web_existingexisting';
    expect(await connect(a.r)).toBe(0);
    expect(a.opened).toHaveLength(0);
    polls = 0;
    mode = 'deny';
    const b = rt(true);
    expect(await connect(b.r)).toBe(0);
    expect(b.out.text()).toContain('denied');
    expect(b.out.text()).toContain('mandate channel login');
  });
});
