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

/** Hook input (JSON on stdin) within a moment: the session id and whether this Stop hook runs inside a Stop continuation. */
async function hookInput(stdin: Readable): Promise<{ session?: string; stopHookActive: boolean }> {
  if ((stdin as NodeJS.ReadStream).isTTY) return { stopHookActive: false };
  const chunks: Buffer[] = [];
  const done = new Promise<void>((r) => {
    stdin.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stdin.once('end', r);
    stdin.once('error', r);
  });
  await Promise.race([done, sleep(500)]);
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: unknown; stop_hook_active?: unknown };
    const id = j.session_id;
    return { session: typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined, stopHookActive: j.stop_hook_active === true };
  } catch {
    return { stopHookActive: false };
  }
}

/** Per (project, session): the last seq this hook delivered and when it woke the session (loop guard). */
interface WatchState {
  lastSeq: number;
  lastAt: number;
  wakes: number[];
}
export const LOOP_WINDOW_MS = 60_000;
export const LOOP_MAX_WAKES = 3;
const REPUSH_MS = 10 * 60_000;
const readState = (f: string): WatchState => {
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<WatchState>;
    return { lastSeq: Number(j.lastSeq) || 0, lastAt: Number(j.lastAt) || 0, wakes: Array.isArray(j.wakes) ? j.wakes.filter((n) => typeof n === 'number') : [] };
  } catch {
    return { lastSeq: 0, lastAt: 0, wakes: [] };
  }
};

export async function cmdWatch(ctx: Ctx, a: Args, out: Out, stdin: Readable = process.stdin): Promise<number> {
  if (!bool(a, 'rewake')) {
    out.err('usage: mandate watch --rewake --project <id> --url <server> [--timeout <seconds>]');
    return 2;
  }
  const input = await hookInput(stdin);
  const session = input.session ?? 'default';
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
  const stateFile = path.join(runDir(ctx), `watch-state-${r.ep.project}-${session}.json`);
  const state = readState(stateFile);
  const now = Date.now();
  const recent = state.wakes.filter((t) => now - t < LOOP_WINDOW_MS);
  if (recent.length >= LOOP_MAX_WAKES) return 0; // loop guard: it woke this session in a tight loop; let it rest
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => ac.abort());
  try {
    const seconds = Number(str(a, 'timeout')) || 55 * 60;
    const got = await waitForEvents(r.ep, { timeoutMs: seconds * 1000, signal: ac.signal });
    // Delivered is delivered: only what is newer than the last delivery wakes this session (an older item only again after
    // the re-push delay, which the server enforces); inside a Stop continuation only strictly newer items count.
    const settled = Date.now();
    const items = got.filter((i) => i.seq > state.lastSeq || (!input.stopHookActive && settled - state.lastAt >= REPUSH_MS));
    if (!items.length) return 0;
    try {
      writeFileSync(stateFile, JSON.stringify({ lastSeq: Math.max(state.lastSeq, ...items.map((i) => i.seq)), lastAt: settled, wakes: [...recent, settled] } satisfies WatchState), { mode: 0o600 });
    } catch {
      // best effort
    }
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
