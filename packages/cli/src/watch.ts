/**
 * `mandate watch --rewake --project <id> --url <server>`: the asyncRewake fallback for Claude Code sessions without the
 * channel. A command hook registered with `asyncRewake: true` (SessionStart, Stop, UserPromptSubmit) runs this in the
 * background: it blocks on the event stream and, when an event arrives, prints it on stderr and exits 2, which wakes
 * Claude with that text as a system reminder. On timeout (default 55 min) or when it cannot reach the server it exits 0
 * silently, and the next hook event re-arms it.
 *
 * One watcher per (project, session): a lock file with the pid (hook input `session_id`) stops the re-arming events from
 * piling up processes. It exits 0 at once when the channel of THIS Claude Code process is active (marker written by
 * channel.ts, found through the hook's ancestor processes), so an event is never delivered twice.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { bool, str, type Args } from './args.js';
import { activeChannel, alive, ancestors } from './channel.js';
import type { Ctx } from './context.js';
import { AuthError, endpointFrom, eventsText, fetchPending, runDir, streamEvents, type Endpoint, type PushedEvent } from './events.js';
import type { Out } from './ui.js';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/** Block until events arrive (all that are available right away), or `timeoutMs` / abort pass (empty). */
export async function waitForEvents(ep: Endpoint, o: { timeoutMs: number; signal?: AbortSignal; settleMs?: number; backoffMs?: number }): Promise<PushedEvent[]> {
  const deadline = Date.now() + o.timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    while (!ac.signal.aborted && Date.now() < deadline) {
      try {
        const missed = await fetchPending(ep, { signal: ac.signal });
        if (missed.length) return missed;
        for await (const first of streamEvents(ep, { signal: ac.signal })) {
          // Events that followed right behind it.
          await sleep(o.settleMs ?? 300, ac.signal);
          const more = await fetchPending(ep, { since: first.seq, signal: ac.signal }).catch(() => []);
          return [first, ...more];
        }
      } catch (e) {
        if (ac.signal.aborted || e instanceof AuthError) return [];
      }
      await sleep(o.backoffMs ?? 5000, ac.signal);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The hook input (JSON on stdin) session id, when there is one within a moment. */
async function sessionId(stdin: Readable): Promise<string | undefined> {
  if ((stdin as NodeJS.ReadStream).isTTY) return undefined;
  const chunks: Buffer[] = [];
  const done = new Promise<void>((r) => {
    stdin.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stdin.once('end', r);
    stdin.once('error', r);
  });
  await Promise.race([done, sleep(500)]);
  try {
    const id = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: unknown }).session_id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function cmdWatch(ctx: Ctx, a: Args, out: Out, stdin: Readable = process.stdin): Promise<number> {
  if (!bool(a, 'rewake')) {
    out.err('usage: mandate watch --rewake --project <id> --url <server> [--timeout <seconds>]');
    return 2;
  }
  const session = (await sessionId(stdin)) ?? 'default';
  const r = endpointFrom(ctx, a, `rewake-${session}`);
  if ('error' in r) return 0; // not set up (yet): never an error for the session
  if (activeChannel(ctx, r.ep.project, ancestors(process.pid))) return 0; // the channel delivers

  const lock = path.join(runDir(ctx), `watch-${r.ep.project}-${session}.lock`);
  try {
    const other = Number(readFileSync(lock, 'utf8'));
    if (other && other !== process.pid && alive(other)) return 0; // already armed
  } catch {
    // no lock
  }
  mkdirSync(runDir(ctx), { recursive: true, mode: 0o700 });
  writeFileSync(lock, String(process.pid));
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => ac.abort());
  try {
    const seconds = Number(str(a, 'timeout')) || 55 * 60;
    const items = await waitForEvents(r.ep, { timeoutMs: seconds * 1000, signal: ac.signal });
    if (!items.length) return 0;
    out.err(eventsText(items, `Mandate events for your work (${items.length}); they stay unread until you read the referenced item or news_ack them:`));
    return 2;
  } finally {
    if (readFileSafe(lock) === String(process.pid)) rmSync(lock, { force: true });
  }
}

const readFileSafe = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
