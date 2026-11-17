/**
 * Event delivery to Claude Code: the config `connect` writes (channel entry, hooks; snapshots), its removal, the channel
 * (stdio MCP server emitting notifications/claude/channel), the rewake hook, the catch-up hook and the `claude` launcher.
 * A fake Mandate events endpoint stands in for the server (the real one is exercised in packages/server/test/mcp/events*.test.ts).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { channelNotification, CHANNEL_INSTRUCTIONS, serveChannel } from '../src/channel.js';
import { run } from '../src/cli.js';
import { applyChanges } from '../src/edits.js';
import { cmdEvents, eventText, type PushedEvent } from '../src/events.js';
import { uninstallChanges } from '../src/install.js';
import { cmdClaude } from '../src/push.js';
import { cmdWatch, waitForEvents } from '../src/watch.js';
import { capture, tempCtx, write } from './helpers.js';

const envOf = (ctx: ReturnType<typeof tempCtx>) => ({ ...ctx.env, MANDATE_PORT: '4391' });
const claudeJson = (ctx: ReturnType<typeof tempCtx>) => JSON.parse(readFileSync(path.join(ctx.home, '.claude.json'), 'utf8'));
const settings = (ctx: ReturnType<typeof tempCtx>) => JSON.parse(readFileSync(path.join(ctx.home, '.claude', 'settings.json'), 'utf8'));
const connect = (ctx: ReturnType<typeof tempCtx>, ...extra: string[]) => run(['connect', '--yes', '--no-repo', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code', ...extra], envOf(ctx), capture(), ctx.dir);

describe('connect: Claude Code event delivery wiring', () => {
  it('writes the channel server and the hooks (snapshot), idempotently', async () => {
    const ctx = tempCtx();
    expect(await connect(ctx)).toBe(0);
    expect(await connect(ctx)).toBe(0);
    const j = claudeJson(ctx);
    expect(j.mcpServers['mandate-web']).toEqual({ type: 'http', url: 'https://mandate.example.com/p/web/mcp' });
    expect(j.mcpServers.mandate_events_web).toEqual({ type: 'stdio', command: 'mandate', args: ['channel', '--project', 'web', '--url', 'https://mandate.example.com'], env: { MCP_PROTOCOL_NEGOTIATION: 'legacy' } });
    expect(JSON.stringify(j)).not.toMatch(/mndp_|Bearer/);
    expect(readFileSync(path.join(ctx.home, '.claude', 'settings.json'), 'utf8')).toMatchSnapshot();
    expect(settings(ctx).hooks.Stop).toHaveLength(1);
  });

  it('keeps other settings and hooks; rewake mode drops the channel entry; off removes everything of ours', async () => {
    const ctx = tempCtx();
    const foreign = { type: 'command', command: 'echo mine' };
    write(path.join(ctx.home, '.claude', 'settings.json'), `${JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [foreign] }], PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } }, null, 2)}\n`);
    expect(await connect(ctx)).toBe(0);
    let s = settings(ctx);
    expect(s.theme).toBe('dark');
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0]).toEqual(foreign);
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ asyncRewake: true, command: expect.stringContaining('mandate watch --rewake --project web') });
    expect(s.hooks.SessionStart.map((g: any) => g.hooks[0].command)).toEqual([expect.stringContaining('mandate events --pending --format=claude'), expect.stringContaining('mandate watch --rewake')]);

    expect(await connect(ctx, '--push', 'rewake')).toBe(0);
    expect(claudeJson(ctx).mcpServers.mandate_events_web).toBeUndefined();
    expect(settings(ctx).hooks.Stop).toHaveLength(2);

    expect(await connect(ctx, '--push', 'off')).toBe(0);
    s = settings(ctx);
    expect(s.hooks).toEqual({ Stop: [{ hooks: [foreign] }], PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] });
    expect(s.theme).toBe('dark');
  });

  it('--push off on a fresh machine writes nothing for events; a bad value is refused', async () => {
    const ctx = tempCtx();
    expect(await connect(ctx, '--push', 'off')).toBe(0);
    expect(existsSync(path.join(ctx.home, '.claude', 'settings.json'))).toBe(false);
    expect(claudeJson(ctx).mcpServers.mandate_events_web).toBeUndefined();
    expect(await connect(ctx, '--push', 'sometimes')).toBe(2);
  });

  it('--remove and uninstall take the channel entry and the hooks out (settings.json deleted when nothing else is in it)', async () => {
    const ctx = tempCtx();
    expect(await connect(ctx)).toBe(0);
    expect(await run(['connect', '--yes', '--no-repo', '--url', 'https://mandate.example.com', '--project', 'web', '--agents', 'claude-code', '--remove'], envOf(ctx), capture(), ctx.dir)).toBe(0);
    expect(existsSync(path.join(ctx.home, '.claude', 'settings.json'))).toBe(false);
    expect(!existsSync(path.join(ctx.home, '.claude.json')) || claudeJson(ctx).mcpServers?.mandate_events_web === undefined).toBe(true);

    const ctx2 = tempCtx();
    write(path.join(ctx2.home, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)}\n`);
    expect(await connect(ctx2)).toBe(0);
    applyChanges(uninstallChanges(ctx2), { dryRun: false, out: capture() });
    expect(settings(ctx2)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
    expect(existsSync(path.join(ctx2.home, '.claude.json')) ? JSON.stringify(claudeJson(ctx2)) : '{}').not.toContain('mandate_events');
  });
});

/* ------------------------------------------------------------------ fake events endpoint */

interface Fake {
  base: string;
  /** Push an event to every open stream. */
  emit(ev: PushedEvent): void;
  /** Drop every open stream (the client must reconnect). */
  drop(): void;
  requests: { url: string; headers: http.IncomingHttpHeaders }[];
  pending: PushedEvent[];
  close(): Promise<void>;
}
async function fakeServer(): Promise<Fake> {
  const streams = new Set<http.ServerResponse>();
  const f: Fake = {
    base: '',
    requests: [],
    pending: [],
    emit: (ev) => streams.forEach((r) => r.write(`id: ${ev.seq}\nevent: news\ndata: ${JSON.stringify(ev)}\n\n`)),
    drop: () => {
      streams.forEach((r) => r.end());
      streams.clear();
    },
    close: () => new Promise((r) => (f.drop(), srv.closeAllConnections(), srv.close(() => r()))),
  };
  const srv = http.createServer((req, res) => {
    f.requests.push({ url: req.url!, headers: req.headers });
    if (req.headers.authorization !== 'Bearer mndp_test_token_123') return void res.writeHead(401).end();
    if (req.url!.startsWith('/p/web/events/pending')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: f.pending.splice(0), next: 0 }));
    } else if (req.url!.startsWith('/p/web/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': mandate events\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return f;
}

const ev = (seq: number, over: Partial<PushedEvent> = {}): PushedEvent => ({ seq, kind: 'question_answered', ref: 'mandate://questions/ask-0001', summary: 'Question ask-0001 answered by ada', at: '2026-11-17T10:00:00.000Z', ...over });
const until = async (f: () => boolean, ms = 4000) => {
  for (const t = Date.now(); !f() && Date.now() - t < ms; ) await new Promise((r) => setTimeout(r, 20));
  expect(f()).toBe(true);
};

let fake: Fake;
beforeAll(async () => {
  fake = await fakeServer();
});
afterAll(async () => fake.close());

const TOKEN = 'mndp_test_token_123';

describe('mandate channel (stdio MCP server)', () => {
  it('formats events with identifier-only meta', () => {
    const n = channelNotification('web', ev(7));
    expect(n.method).toBe('notifications/claude/channel');
    expect(n.params.meta).toEqual({ kind: 'question_answered', ref: 'mandate://questions/ask-0001', seq: '7', project: 'web', question: 'ask-0001' });
    expect(Object.keys(n.params.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))).toBe(true);
    expect(n.params.content).toContain('question_get');
    expect(eventText(ev(1, { summary: 'a\nb\u0007 <x>' }))).not.toMatch(/[\n\u0007]/);
  });

  it('declares claude/channel, emits a notification per event and reconnects with Last-Event-ID', async () => {
    const ctx = tempCtx();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: any[] = [];
    stdout.on('data', (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    const stop = new AbortController();
    const done = serveChannel({ ctx: { ...ctx, env: { ...ctx.env, MANDATE_CHANNEL_FORCE: '1' } }, endpoint: { base: fake.base, project: 'web', token: TOKEN, consumer: 'c-test' }, io: { stdin, stdout, stderr: new PassThrough() }, backoff: () => 20, signal: stop.signal });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } })}\n`);
    await until(() => lines.some((l) => l.id === 1));
    const init = lines.find((l) => l.id === 1).result;
    expect(init.capabilities).toEqual({ experimental: { 'claude/channel': {} } });
    expect(init.instructions).toBe(CHANNEL_INSTRUCTIONS);
    expect(init.protocolVersion).toBe('2025-06-18');
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    await until(() => fake.requests.some((r) => r.url.startsWith('/p/web/events?')));
    expect(fake.requests.at(-1)!.url).toContain('consumer=c-test');
    fake.emit(ev(5));
    await until(() => lines.some((l) => l.method === 'notifications/claude/channel'));
    expect(lines.find((l) => l.method === 'notifications/claude/channel').params.meta.seq).toBe('5');
    // the connection drops: it reconnects, asking to resume after seq 5
    fake.drop();
    await until(() => fake.requests.some((r) => r.headers['last-event-id'] === '5'));
    fake.emit(ev(6, { kind: 'claim_released', ref: 'mandate://work-orders/wo-0001' }));
    await until(() => lines.filter((l) => l.method === 'notifications/claude/channel').length === 2);
    // nothing but JSON-RPC on stdout; unknown requests get an error
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'resources/list' })}\n`);
    await until(() => lines.some((l) => l.id === 9));
    expect(lines.find((l) => l.id === 9).error.code).toBe(-32601);
    stdin.end();
    expect(await done).toBe(0);
    stop.abort();
  });

  it('writes the active-channel marker only while running, and not at all when channels are off', async () => {
    const ctx = tempCtx();
    const marker = path.join(ctx.mandateHome, 'run', `channel-web-${process.ppid}.json`);
    const stdin = new PassThrough();
    const err = new PassThrough();
    const logs: string[] = [];
    err.on('data', (b: Buffer) => logs.push(b.toString()));
    const off = serveChannel({ ctx: { ...ctx, env: { ...ctx.env, MANDATE_PUSH: '' } }, endpoint: { base: fake.base, project: 'web', token: TOKEN, consumer: 'c-off' }, io: { stdin, stdout: new PassThrough(), stderr: err }, backoff: () => 20 });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await until(() => logs.join('').includes('channels are not enabled'));
    expect(existsSync(marker)).toBe(false);
    stdin.end();
    await off;

    const on = new PassThrough();
    const run1 = serveChannel({ ctx: { ...ctx, env: { ...ctx.env, MANDATE_PUSH: 'channels' } }, endpoint: { base: fake.base, project: 'web', token: TOKEN, consumer: 'c-on' }, io: { stdin: on, stdout: new PassThrough(), stderr: new PassThrough() }, backoff: () => 20 });
    on.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await until(() => existsSync(marker));
    on.end();
    await run1;
    expect(existsSync(marker)).toBe(false);
  });
});

describe('mandate watch --rewake', () => {
  const ep = () => ({ base: fake.base, project: 'web', token: TOKEN, consumer: 'rewake-t' });

  it('returns the events that were already pending, or the first live event plus those right behind it; empty on timeout', async () => {
    fake.pending.push(ev(1), ev(2));
    expect((await waitForEvents(ep(), { timeoutMs: 2000 })).map((e) => e.seq)).toEqual([1, 2]);
    const before = fake.requests.filter((r) => r.url.startsWith('/p/web/events?')).length;
    const live = waitForEvents(ep(), { timeoutMs: 3000, settleMs: 10 });
    await until(() => fake.requests.filter((r) => r.url.startsWith('/p/web/events?')).length > before);
    await new Promise((r) => setTimeout(r, 50));
    fake.emit(ev(3));
    expect((await live).map((e) => e.seq)).toEqual([3]);
    expect(await waitForEvents(ep(), { timeoutMs: 300, backoffMs: 50 })).toEqual([]);
  });

  it('a wrong token is a quiet no-op (never fails the session)', async () => {
    expect(await waitForEvents({ ...ep(), token: 'nope' }, { timeoutMs: 1000 })).toEqual([]);
  });

  it('cmdWatch: exit 2 with the event text on stderr; exit 0 on timeout; exit 0 without waiting when this session has an active channel', async () => {
    const ctx = tempCtx();
    const env = { ...ctx.env, MANDATE_CHANNEL_TOKEN: TOKEN };
    const c = { ...ctx, env };
    const a = (extra: string[] = []) => parseArgs(['watch', '--rewake', '--project', 'web', '--url', fake.base, ...extra]);
    const input = () => {
      const s = new PassThrough();
      s.end(JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop' }));
      return s;
    };
    fake.pending.push(ev(10));
    const out = capture();
    expect(await cmdWatch(c, a(), out, input())).toBe(2);
    expect(out.text()).toContain('Question ask-0001 answered by ada');
    expect(out.text()).toContain('#10 question_answered');

    expect(await cmdWatch(c, a(['--timeout', '1']), capture(), input())).toBe(0);
    expect(existsSync(path.join(ctx.mandateHome, 'run', 'watch-web-sess-1.lock'))).toBe(false);

    // The channel of this process' parent (the hook's ancestor) is running: no double delivery.
    mkdirSync(path.join(ctx.mandateHome, 'run'), { recursive: true });
    writeFileSync(path.join(ctx.mandateHome, 'run', `channel-web-${process.ppid}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
    fake.pending.push(ev(11));
    expect(await cmdWatch(c, a(), capture(), input())).toBe(0);
    expect(fake.pending).toHaveLength(1); // untouched
    // Not set up (no token): quiet exit 0.
    expect(await cmdWatch(tempCtx(), parseArgs(['watch', '--rewake', '--project', 'web', '--url', fake.base]), capture(), input())).toBe(0);
  });
});

describe('mandate events --pending (SessionStart catch-up)', () => {
  it('prints additionalContext JSON for the claude format, nothing when there is nothing', async () => {
    const ctx = tempCtx();
    const c = { ...ctx, env: { ...ctx.env, MANDATE_CHANNEL_TOKEN: TOKEN } };
    fake.pending.push(ev(20), ev(21, { kind: 'flow_changed', ref: 'mandate://projects/web', summary: 'Mandate flow settings changed' }));
    const out = capture();
    expect(await cmdEvents(c, parseArgs(['events', '--pending', '--format=claude', '--project', 'web', '--url', fake.base]), out)).toBe(0);
    const j = JSON.parse(out.text());
    expect(j.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(j.hookSpecificOutput.additionalContext).toContain('#20 question_answered');
    expect(j.hookSpecificOutput.additionalContext).toContain('#21 flow_changed');
    const empty = capture();
    expect(await cmdEvents(c, parseArgs(['events', '--pending', '--format=claude', '--project', 'web', '--url', fake.base]), empty)).toBe(0);
    expect(empty.text()).toBe('');
    // unreachable / unauthorised never fail the hook
    expect(await cmdEvents({ ...c, env: { ...c.env, MANDATE_CHANNEL_TOKEN: 'bad' } }, parseArgs(['events', '--pending', '--format=claude', '--project', 'web', '--url', fake.base]), capture())).toBe(0);
  });
});

describe('mandate claude (launcher)', () => {
  const fakeClaude = (ctx: ReturnType<typeof tempCtx>) => {
    const bin = path.join(ctx.dir, 'fake-claude.sh');
    const out = path.join(ctx.dir, 'claude-args.txt');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\nprintf 'PUSH=%s\\n' "$MANDATE_PUSH" >> "${out}"\n`);
    chmodSync(bin, 0o755);
    return { bin, out };
  };

  it('starts claude with the development channel flag for the configured channel servers, passing the other args through', async () => {
    const ctx = tempCtx();
    expect(await connect(ctx)).toBe(0);
    const { bin, out } = fakeClaude(ctx);
    const c = { ...ctx, env: { ...ctx.env, MANDATE_CLAUDE_BIN: bin } };
    const a = parseArgs(['claude', '--resume', 'abc', '--model', 'opus']);
    expect(await cmdClaude(c, a, () => undefined)).toBe(0);
    expect(readFileSync(out, 'utf8').split('\n')).toEqual(['--dangerously-load-development-channels', 'server:mandate_events_web', '--resume', 'abc', '--model', 'opus', 'PUSH=channels', '']);
    // --push rewake / off: plain claude
    expect(await cmdClaude(c, parseArgs(['claude', '--push', 'rewake', '-c']), () => undefined)).toBe(0);
    expect(readFileSync(out, 'utf8').split('\n')).toEqual(['-c', 'PUSH=', '']);
  });

  it('without a channel entry it says so and still starts claude', async () => {
    const ctx = tempCtx();
    const { bin, out } = fakeClaude(ctx);
    const errs: string[] = [];
    expect(await cmdClaude({ ...ctx, env: { ...ctx.env, MANDATE_CLAUDE_BIN: bin } }, parseArgs(['claude', '-p', 'hi']), (s) => errs.push(s))).toBe(0);
    expect(errs.join('')).toMatch(/no Mandate event channel is set up/);
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe('-p');
  });
});
