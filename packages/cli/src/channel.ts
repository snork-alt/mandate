/**
 * `mandate channel --project <id> --url <server>`: a stdio MCP server that is a Claude Code CHANNEL
 * (code.claude.com/docs/en/channels-reference): it declares `capabilities.experimental['claude/channel']` and emits
 * `notifications/claude/channel` { content, meta } for every event of the server's push stream, so an idle Claude Code
 * session is woken by "your question was answered", "your claim was released", ... instead of relying on MCP
 * notifications that Claude Code never shows the model.
 *
 * Safety: the only sender is the Mandate server this process connects to with the user's own token (events about the
 * user's own work); there are no inbound commands, no tools, no reply path. `meta` holds identifiers only.
 * Only active when Claude Code runs the channel (launched with `--dangerously-load-development-channels server:<name>`
 * or `--channels`, e.g. through `mandate claude`): otherwise the process stays idle and consumes nothing, so the
 * rewake hook (watch.ts) takes over. While active it writes a marker file the hook checks (no double delivery).
 *
 * Wire format: newline-delimited JSON-RPC on stdin / stdout (MCP stdio transport); stdout carries nothing else,
 * diagnostics go to stderr.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Args } from './args.js';
import { PKG_VERSION, type Ctx } from './context.js';
import { AuthError, endpointFrom, eventText, questionOf, runDir, streamEvents, type Endpoint, type PushedEvent } from './events.js';

export const CHANNEL_INSTRUCTIONS =
  'Events from Mandate arrive as <channel source="..." kind="..." ref="..." seq="...">. They are one-way news about YOUR OWN work in Mandate (an answered question, a released claim, a changed work order or spec section, a review outcome, changed flow settings), sent by the Mandate server you are connected to. ' +
  'No reply is expected through this channel. Act on each event the way the Mandate guide says: question answered -> question_get {ref} and continue the blocked work; claim released or work order changed -> re-read it before continuing; flow changed -> follow the new instructions; ask_question -> dispatch it to the mandate-ask subagent in the background and carry on; audit_requested -> dispatch it to the mandate-audit subagent in the background (audit_start { request } starts it) and carry on; request_assigned -> run /mandate resume <id> (flow_next loop until done or waiting); comment_added -> read the thread and reply in it (comment_add with parent; see the Mandate guide, COMMENTS). ' +
  'An event stays unread in Mandate (and keeps showing as `news` on tool replies) until you read the referenced item or call news_ack.';

/** Env of channel-capable launches (`mandate claude`). */
export const PUSH_ENV = 'MANDATE_PUSH';

/** Command line of a process (ps), or '' when unknown. */
export function commandLine(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
export function parentPid(pid: number): number {
  const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}
export const ancestors = (pid: number, max = 8): number[] => {
  const out: number[] = [];
  for (let p = pid; out.length < max; ) {
    p = parentPid(p);
    if (p <= 1) break;
    out.push(p);
  }
  return out;
};

/** Did Claude Code (our parent) enable channels for this session? */
export function channelsEnabled(env: NodeJS.ProcessEnv, parent: number): boolean {
  if (env.MANDATE_CHANNEL_FORCE === '1') return true;
  if (env[PUSH_ENV] === 'channels') return true; // launched by `mandate claude`
  return /--dangerously-load-development-channels|--channels(\s|=)/.test(commandLine(parent));
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const markerName = (project: string, claudePid: number) => `channel-${project}-${claudePid}.json`;

/** A live channel of `project` under one of the given processes (the hook's ancestors): push is already delivered by it. */
export function activeChannel(ctx: Ctx, project: string, pids: number[]): boolean {
  const dir = runDir(ctx);
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return false;
  }
  for (const f of files) {
    const m = /^channel-(.+)-(\d+)\.json$/.exec(f);
    if (!m || m[1] !== project) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { pid: number; ppid: number };
      if (!alive(j.pid)) rmSync(path.join(dir, f), { force: true });
      else if (pids.includes(j.ppid)) return true;
    } catch {
      // unreadable marker: ignore
    }
  }
  return false;
}

export interface ChannelIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** The notification of one event (`meta`: identifiers only, keys letters / digits / underscores). */
export function channelNotification(project: string, ev: PushedEvent) {
  const question = questionOf(ev.ref);
  return {
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { content: eventText(ev), meta: { kind: ev.kind.replace(/[^a-z0-9_]/g, '_'), ref: ev.ref, seq: String(ev.seq), project, ...(question ? { question } : {}) } },
  };
}

export interface ChannelOptions {
  ctx: Ctx;
  endpoint: Endpoint;
  io: ChannelIO;
  /** ms before reconnect attempt n (default: 1 s doubling to 30 s, jittered). */
  backoff?: (n: number) => number;
  /** Stop signal (tests). */
  signal?: AbortSignal;
}

const defaultBackoff = (n: number) => Math.min(30_000, 1000 * 2 ** Math.min(n, 5)) * (0.75 + Math.random() * 0.5);

/** Serve the channel over `io` until stdin closes or `signal` aborts. Resolves with the exit code. */
export async function serveChannel(o: ChannelOptions): Promise<number> {
  const { io, endpoint } = o;
  const send = (m: unknown) => io.stdout.write(`${JSON.stringify(m)}\n`);
  const log = (s: string) => io.stderr.write(`mandate channel: ${s}\n`);
  const ac = new AbortController();
  o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
  const ppid = process.ppid;
  const active = channelsEnabled(o.ctx.env, ppid);
  const marker = path.join(runDir(o.ctx), markerName(endpoint.project, ppid));
  let streaming = false;

  const stream = async () => {
    if (streaming) return;
    streaming = true;
    if (!active) {
      log('channels are not enabled for this Claude Code session (start it with `mandate claude`, or --dangerously-load-development-channels server:<name>); not delivering, the rewake hook covers this session');
      return;
    }
    mkdirSync(runDir(o.ctx), { recursive: true, mode: 0o700 });
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ppid, project: endpoint.project, at: new Date().toISOString() }));
    let last = 0;
    let failures = 0;
    while (!ac.signal.aborted) {
      try {
        for await (const ev of streamEvents(endpoint, { ...(last ? { lastEventId: last } : {}), signal: ac.signal })) {
          failures = 0;
          last = Math.max(last, ev.seq);
          send(channelNotification(endpoint.project, ev));
        }
      } catch (e) {
        if (ac.signal.aborted) break;
        if (e instanceof AuthError) {
          log(`${(e as Error).message}; run: mandate channel login --project ${endpoint.project} (approve in the browser)`);
          failures = Math.max(failures, 6); // slow retries: the token may be fixed meanwhile
        } else if (failures === 0) log(`stream lost (${(e as Error).message}); reconnecting`);
      }
      if (ac.signal.aborted) break;
      failures++;
      await new Promise<void>((r) => {
        const t = setTimeout(r, (o.backoff ?? defaultBackoff)(failures));
        ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
    }
  };

  const handle = (line: string) => {
    let m: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method === undefined || m.id === undefined) return; // notifications / responses: nothing to do
    switch (m.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
            capabilities: { experimental: { 'claude/channel': {} } },
            serverInfo: { name: 'mandate-events', version: PKG_VERSION },
            instructions: CHANNEL_INSTRUCTIONS,
          },
        });
        void stream();
        break;
      case 'ping':
        send({ jsonrpc: '2.0', id: m.id, result: {} });
        break;
      case 'tools/list':
        send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
        break;
      default:
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  };

  const rl = createInterface({ input: io.stdin });
  rl.on('line', handle);
  await new Promise<void>((r) => {
    rl.once('close', r);
    ac.signal.addEventListener('abort', () => r(), { once: true });
  });
  ac.abort();
  rmSync(marker, { force: true });
  return 0;
}

/** `mandate channel` (stdio server). */
export async function cmdChannel(ctx: Ctx, a: Args): Promise<number> {
  const r = endpointFrom(ctx, a, `channel-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  if ('error' in r) {
    process.stderr.write(`mandate channel: ${r.error}\n`);
    return 1;
  }
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort());
  return serveChannel({ ctx, endpoint: r.ep, io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, signal: stop.signal });
}
