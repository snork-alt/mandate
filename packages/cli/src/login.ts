/**
 * `mandate channel login [--project <id>] [--url <server>]`: get the personal token the event stream uses
 * (~/.mandate/channel/<id>.token, 0600).
 *
 * Default: browser approval (device-authorization style). The CLI asks the server to start a login (`POST /auth/cli/start`),
 * prints the code and opens the approval page; you are signed in there with GitHub, check the code and press Approve; the
 * CLI polls (`POST /auth/cli/poll`) and receives ONE personal token scoped to you and the project, labelled
 * "channel @ <host>" (revocable under Connect agent -> Personal tokens). `--paste`: paste a token from the web UI instead
 * (also `--token`, MANDATE_CHANNEL_TOKEN).
 */
import os from 'node:os';
import { bool, str, type Args } from './args.js';
import { BIN, type Ctx } from './context.js';
import { saveToken } from './events.js';
import { openBrowser } from './commands.js';
import type { Runtime } from './install.js';
import { c, fail, info, ok } from './ui.js';
import { readManifest } from './wiring.js';

/** Test seams: the HTTP client, the browser opener, the clock. */
export interface LoginDeps {
  fetch?: typeof fetch;
  open?: (url: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  hostname?: () => string;
  /** Is a person watching this terminal (browser approval can be started)? Default: stdout is a TTY and not CI. */
  tty?: boolean;
}

export const ttyAvailable = (rt: Runtime): boolean => rt.login?.tty ?? (!!process.stdout.isTTY && !rt.ctx.env.CI);

/** The server of a project this machine connected to (`mandate connect` manifest), for `channel login` without --url. */
export function knownUrl(ctx: Ctx, project: string): string | undefined {
  const e = readManifest(ctx).repos.find((r) => r.project === project && r.repo.startsWith('user:'));
  return e?.repo.slice('user:'.length);
}

export type BrowserLogin = { ok: true; token: string; login?: string } | { ok: false; reason: 'denied' | 'expired' | 'unreachable' | 'error'; message: string };

/** The device-authorization round trip. Prints the code and the page; resolves when approved / denied / expired. */
export async function browserLogin(rt: Runtime, o: { project: string; base: string; timeoutMs?: number }): Promise<BrowserLogin> {
  const { ctx, out } = rt;
  const d = rt.login ?? {};
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.base.replace(/\/+$/, '');
  const call = async (p: string, body: unknown) => {
    const r = await f(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `${BIN}-login` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  let start: { status: number; json: Record<string, unknown> };
  try {
    start = await call('/auth/cli/start', { project: o.project, hostname: (d.hostname ?? os.hostname)() });
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `cannot reach ${base} (${(e as Error).message})` };
  }
  if (start.status !== 201) return { ok: false, reason: 'error', message: String((start.json.error as { message?: string } | undefined)?.message ?? `HTTP ${start.status}`) };
  const { deviceCode, userCode, verificationPath, interval = 2, expiresIn = 600 } = start.json as { deviceCode: string; userCode: string; verificationPath: string; interval?: number; expiresIn?: number };
  const page = `${base}${verificationPath}`;
  out.log(`\n${c.bold('Authorize this computer')} (event channel for ${c.bold(o.project)}): confirm code ${c.bold(userCode)} in your browser`);
  const opener = d.open ?? ((u: string) => openBrowser(ctx, u));
  if (opener(page)) out.log(info(`opened ${page}`));
  else out.log(info(`open this page in your browser: ${page}`));
  out.log(c.dim(`  waiting for approval (${Math.round(expiresIn / 60)} min)...`));
  const deadline = Date.now() + (o.timeoutMs ?? expiresIn * 1000);
  for (;;) {
    await sleep(interval * 1000);
    let r;
    try {
      r = await call('/auth/cli/poll', { deviceCode });
    } catch {
      if (Date.now() > deadline) return { ok: false, reason: 'expired', message: 'timed out waiting for approval' };
      continue;
    }
    const st = r.json.status;
    if (st === 'approved' && typeof r.json.token === 'string') return { ok: true, token: r.json.token, ...(typeof r.json.login === 'string' ? { login: r.json.login } : {}) };
    if (st === 'denied') return { ok: false, reason: 'denied', message: 'the login was denied in the browser' };
    if (st === 'expired' || r.status === 429 && Date.now() > deadline || Date.now() > deadline) return { ok: false, reason: 'expired', message: 'the code expired before it was approved' };
  }
}

/** Store the token and say what to do next. */
export function finishLogin(rt: Runtime, project: string, token: string, how = 'stored'): void {
  const file = saveToken(rt.ctx, project, token);
  rt.out.log(ok(`token ${how} in ${file} (0600); it is sent only to your Mandate server, as the event stream's Bearer token`));
  rt.out.log(info(`start Claude Code with ${c.cyan(`${BIN} claude`)} (wakes the agent for requests, questions and comments)`));
}

export async function cmdChannelLogin(rt: Runtime, a: Args): Promise<number> {
  const { ctx, out } = rt;
  const project = str(a, 'project') ?? ctx.env.MANDATE_PROJECT;
  if (!project || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) {
    out.err(fail(`usage: ${BIN} channel login --project <id> [--url <server>] [--paste | --token <personal token>]`));
    return 2;
  }
  const given = (ctx.env.MANDATE_CHANNEL_TOKEN || str(a, 'token') || '').trim();
  const paste = bool(a, 'paste') || !!given;
  if (!paste) {
    const base = str(a, 'url') ?? ctx.env.MANDATE_URL ?? knownUrl(ctx, project);
    if (!base) {
      out.err(fail(`which Mandate? add --url <server> (or use --paste to paste a personal token)`));
      return 2;
    }
    const r = await browserLogin(rt, { project, base });
    if (r.ok) {
      finishLogin(rt, project, r.token, `stored${r.login ? ` for ${r.login}` : ''}`);
      return 0;
    }
    out.err(fail(`${r.message}`));
    out.log(info(`fallback: ${c.cyan(`${BIN} channel login --project ${project} --paste`)} (token from the web UI: Connect agent -> Personal tokens)`));
    return 1;
  }
  const token = (given || (rt.prompt.interactive ? await rt.prompt.input(`Personal token for '${project}' (web UI → Connect agent → Personal tokens):`, '') : '')).trim();
  if (!/^mndp_\S{8,}$/.test(token)) {
    out.err(fail('expected a personal token (mndp_…): create one in the web UI under Connect agent → Personal tokens'));
    return 2;
  }
  finishLogin(rt, project, token);
  return 0;
}
