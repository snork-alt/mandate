/**
 * Client side of the server's push event stream (`GET /p/<id>/events`, `/events/pending`): credentials, SSE parsing,
 * event text, and `mandate events --pending` (the SessionStart catch-up hook). Shared by `mandate channel` (Claude Code
 * channel) and `mandate watch --rewake` (asyncRewake hook).
 *
 * Credentials: the stream needs a bearer token the server accepts for the project, and Claude Code's MCP sign-in (OAuth)
 * keeps its token to itself. So the channel uses a PERSONAL AGENT TOKEN (web UI -> Connect agent -> Personal tokens):
 * `MANDATE_CHANNEL_TOKEN`, `MANDATE_KEY_<PROJECT>` (env, or ~/.mandate/env.sh), or the file `~/.mandate/channel/<project>.token`
 * written (0600) by `mandate channel login`. It is only ever sent to the Mandate server URL in the entry, as a Bearer header.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bool, str, type Args } from './args.js';
import { envVarFor } from './agents.js';
import { PUSH_ENV } from './channel.js';
import { BIN, type Ctx } from './context.js';
import { readEnvKeys } from './wiring.js';
import type { Out } from './ui.js';

export const tokenFile = (ctx: Ctx, project: string) => path.join(ctx.mandateHome, 'channel', `${project}.token`);
export const runDir = (ctx: Ctx) => path.join(ctx.mandateHome, 'run');

export function resolveToken(ctx: Ctx, project: string): string | undefined {
  const fromEnv = ctx.env.MANDATE_CHANNEL_TOKEN || ctx.env[envVarFor(project)];
  if (fromEnv) return fromEnv.trim();
  try {
    const t = readFileSync(tokenFile(ctx, project), 'utf8').trim();
    if (t) return t;
  } catch {
    // none
  }
  return readEnvKeys(ctx).get(envVarFor(project))?.trim() || undefined;
}

export function saveToken(ctx: Ctx, project: string, token: string): string {
  const f = tokenFile(ctx, project);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

export interface PushedEvent {
  seq: number;
  kind: string;
  ref: string;
  summary: string;
  at: string;
}

export interface Endpoint {
  /** Server origin, e.g. https://mandate.example.com. */
  base: string;
  project: string;
  token: string;
  /** Receiver id (claims are per consumer). */
  consumer: string;
  client?: string;
}

const url = (e: Endpoint, p: string, q: Record<string, string | undefined> = {}) => {
  const u = new URL(`${e.base.replace(/\/+$/, '')}/p/${e.project}${p}`);
  for (const [k, v] of Object.entries({ consumer: e.consumer, client: e.client ?? 'claude-code', ...q })) if (v !== undefined) u.searchParams.set(k, v);
  return u;
};
const headers = (e: Endpoint, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${e.token}`, 'user-agent': `${BIN}-events`, ...extra });

export class AuthError extends Error {}
const rejected = (e: Endpoint, status: number) => new AuthError(`events: HTTP ${status} (token for project '${e.project}' rejected, or no such project)`);

/** Items missed so far (claimed for this consumer unless `peek`). */
export async function fetchPending(e: Endpoint, o: { since?: number; peek?: boolean; signal?: AbortSignal } = {}): Promise<PushedEvent[]> {
  const r = await fetch(url(e, '/events/pending', { since: o.since ? String(o.since) : undefined, peek: o.peek ? '1' : undefined }), { headers: headers(e), ...(o.signal ? { signal: o.signal } : {}) });
  if (r.status === 401 || r.status === 403 || r.status === 404) throw rejected(e, r.status);
  if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
  return ((await r.json()) as { items: PushedEvent[] }).items;
}

/** Parse a Server-Sent Events body into { id, event, data } blocks. */
export async function* sseBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data?: string }> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const b: { id?: string; event?: string; data?: string } = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = /^(id|event|data):? ?(.*)$/.exec(line);
        if (!m) continue;
        const k = m[1] as 'id' | 'event' | 'data';
        b[k] = k === 'data' && b.data !== undefined ? `${b.data}\n${m[2]}` : m[2]!;
      }
      yield b;
    }
  }
}

/** Open the event stream and yield its events (AuthError on 401/403/404, Error otherwise). Ends when the stream does. */
export async function* streamEvents(e: Endpoint, o: { lastEventId?: number; signal?: AbortSignal } = {}): AsyncGenerator<PushedEvent> {
  const r = await fetch(url(e, '/events'), { headers: headers(e, { accept: 'text/event-stream', ...(o.lastEventId ? { 'last-event-id': String(o.lastEventId) } : {}) }), ...(o.signal ? { signal: o.signal } : {}) });
  if (r.status === 401 || r.status === 403 || r.status === 404) throw rejected(e, r.status);
  if (!r.ok || !r.body) throw new Error(`events: HTTP ${r.status}`);
  for await (const b of sseBlocks(r.body)) {
    if (b.event !== 'news' || !b.data) continue;
    try {
      yield JSON.parse(b.data) as PushedEvent;
    } catch {
      // ignore a malformed block
    }
  }
}

/* ------------------------------------------------------------------ text */

/** One line, no control characters, bounded (summaries can carry text other people wrote). */
export const clean = (s: string, max = 400) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const HINTS: Record<string, string> = {
  question_answered: 'Get the answer (question_get) and continue the work it blocked.',
  question_closed: 'The question was closed without an answer; do not wait for it.',
  claim_released: 'Your claim was released; claim the work order again or stop that work.',
  claim_expired: 'Your claim expired; claim the work order again (work_order_claim) or release it.',
  work_order_changed: 'Re-read the work order (work_order_get) before continuing.',
  flow_changed: 'Follow the new flow instructions and update your memory.',
  review_outcome: 'Address the review outcome on your work.',
  drift: 'A section you work on changed; re-read it.',
  comment: 'Read the comment and respond.',
  ask_question: 'A question from the Mandate Ask panel: hand it to the mandate-ask subagent in the background (Agent tool, subagent_type mandate-ask, run_in_background, with the Ask id, the question and the context refs) and keep working; the subagent answers with ask_answer. Do not answer it yourself in this conversation.',
  request_assigned: 'A request was assigned to you (filed in the web UI, or its plan was approved): run /mandate resume <id> (flow_next { request } loop until done or waiting). Another agent may have taken it already (already_taken): then leave it. Plan-only requests stop at plan_ready: no claim, no code until the user approves.',
  comment_added: 'A comment was routed to you: read the thread (comments_list on its target; the summary shows the latest messages) and reply IN the thread (comment_add with parent). A question or remark: answer it. A change: request_create with source comment, then reply with the request link, and one final reply plus comment_resolve when it is done (flow_next { comments } lists what waits for you).',
};

export const questionOf = (ref: string): string | undefined => /^mandate:\/\/questions\/([A-Za-z0-9-]+)/.exec(ref)?.[1];

/** The text of one event as the agent sees it (channel message body). */
export function eventText(ev: PushedEvent): string {
  return `${clean(ev.summary)} (${clean(ev.ref, 200)}). ${HINTS[ev.kind] ?? 'Read it in Mandate (news_list) and act on it.'}`;
}

/** Several events as plain lines (rewake stderr, catch-up context). */
export function eventsText(items: PushedEvent[], intro: string): string {
  return [intro, ...items.map((i) => `- #${i.seq} ${i.kind}: ${eventText(i)}`)].join('\n');
}

/* ------------------------------------------------------------------ mandate events --pending */

export function endpointFrom(ctx: Ctx, a: Args, consumer: string): { ep: Endpoint } | { error: string } {
  const project = str(a, 'project') ?? ctx.env.MANDATE_PROJECT;
  const base = str(a, 'url') ?? ctx.env.MANDATE_URL;
  if (!project || !base) return { error: 'needs --project <id> and --url <server>' };
  const token = resolveToken(ctx, project);
  if (!token) return { error: `no token for project '${project}': run ${BIN} channel login --project ${project}` };
  return { ep: { base, project, token, consumer, client: str(a, 'client') ?? 'claude-code' } };
}

/** One line for a plain `claude` session while the project is wired for channels. */
export const CHANNELS_OFF_NOTICE = `Mandate: channels are off in this session (not started with \`${BIN} claude\`); requests, comments and questions reach you through the rewake fallback hook (it wakes you when you are idle) instead. Start with \`${BIN} claude\` for instant push.`;

/**
 * `mandate events --pending [--format claude|text|json] [--peek] [--since N]`: the events missed while the agent was not
 * running. `claude`: the SessionStart hook JSON (additionalContext); prints nothing when there is nothing, and never
 * fails the hook (errors go to stderr, exit 0).
 */
export async function cmdEvents(ctx: Ctx, a: Args, out: Out): Promise<number> {
  if (!bool(a, 'pending')) {
    out.err(`usage: ${BIN} events --pending [--format claude|text|json] --project <id> --url <server>`);
    return 2;
  }
  const format = str(a, 'format') ?? 'text';
  // Channels are set up (--channels) but this session was not started by `mandate claude`: say so, once, at the start.
  const notice = format === 'claude' && bool(a, 'channels') && ctx.env[PUSH_ENV] !== 'channels' ? CHANNELS_OFF_NOTICE : '';
  const say = (extra = '') => {
    const additionalContext = [notice, extra].filter(Boolean).join('\n');
    if (additionalContext) out.log(JSON.stringify({ ...(notice ? { systemMessage: notice } : {}), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  };
  const r = endpointFrom(ctx, a, str(a, 'consumer') ?? 'catchup');
  if ('error' in r) {
    if (notice) say();
    out.err(`${BIN} events: ${r.error}`);
    return format === 'claude' ? 0 : 1;
  }
  let items: PushedEvent[];
  try {
    const since = Number(str(a, 'since'));
    items = await fetchPending(r.ep, { ...(since > 0 ? { since } : {}), peek: bool(a, 'peek'), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    out.err(`${BIN} events: ${(e as Error).message}`);
    if (notice) say();
    return format === 'claude' ? 0 : 1;
  }
  if (format === 'json') out.log(JSON.stringify({ items }));
  else if (items.length && format === 'claude') {
    const additionalContext = eventsText(items, `Mandate events for your work that arrived while no session was running (${items.length}); they stay unread until you read the referenced item or news_ack them:`);
    say(additionalContext);
  } else if (notice) say();
  else if (items.length) out.log(eventsText(items, `Mandate events (${items.length}):`));
  return 0;
}
