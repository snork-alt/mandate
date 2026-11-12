/**
 * Talking to the local server. The contract with the server (packages/server/src/setup):
 * - `~/.mandate/setup-token` (SetupState) → `<url>/auth/setup?token=…`: the one-time setup wizard link.
 * - LocalLoginTokens (server-state database, `~/.mandate/state.sqlite` in local mode) → `<url>/auth/local?token=…`: local mode one-time sign-in.
 * - `POST /ui/projects/local` (local mode, UI session): create / register a project folder.
 * Both links must be opened on this machine (loopback) or, in server mode, over HTTPS or an SSH tunnel.
 */
import { readFileSync } from 'node:fs';
import { LocalLoginTokens, SetupState } from '../../server/src/setup/files.js';
import { configFile, type Ctx } from './context.js';
import type { CurrentSettings } from './settings.js';

export interface Health {
  ok: boolean;
  version?: string;
}

export async function health(url: string, timeoutMs = 1500): Promise<Health | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as Health;
  } catch {
    return null;
  }
}

export async function waitHealthy(url: string, timeoutMs = 30_000): Promise<Health | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await health(url);
    if (h?.ok) return h;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Same rule as the server: legacy GitHub configs and configured server mode count as set up. */
function preconfigured(ctx: Ctx): boolean {
  try {
    const j = JSON.parse(readFileSync(configFile(ctx), 'utf8')) as { server?: { mode?: string }; auth?: { github?: { clientId?: string } } };
    const legacy = !j.server?.mode && !!j.auth?.github;
    return legacy || (j.server?.mode === 'server' && !!j.auth?.github?.clientId);
  } catch {
    return false;
  }
}

export const setupState = (ctx: Ctx) => new SetupState(ctx.mandateHome, () => preconfigured(ctx));

/** The setup wizard link (null when setup is complete). Always a loopback URL: open it here or through a tunnel. */
export function setupUrl(ctx: Ctx, s: CurrentSettings): string | null {
  const t = setupState(ctx).token();
  return t ? `http://localhost:${s.port}/auth/setup?token=${encodeURIComponent(t)}` : null;
}

/** Local mode one-time sign-in link (5 minutes). */
export async function localSignInUrl(ctx: Ctx, s: CurrentSettings): Promise<string> {
  const t = await new LocalLoginTokens(ctx.mandateHome).issue();
  return `http://localhost:${s.port}/auth/local?token=${encodeURIComponent(t)}`;
}

/** A UI session cookie for this machine's user (local mode): consumes a one-time sign-in token. */
export async function localSession(ctx: Ctx, s: CurrentSettings): Promise<string> {
  const t = await new LocalLoginTokens(ctx.mandateHome).issue();
  const r = await fetch(`http://localhost:${s.port}/auth/local?token=${encodeURIComponent(t)}`, { redirect: 'manual' });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('mandate_session='));
  if (!cookie) throw new Error(`local sign-in failed (HTTP ${r.status}); is the server in local mode?`);
  return cookie.split(';')[0]!;
}

export interface CreatedProject {
  id: string;
  name: string;
}

/** Create (`new`, in the projects folder) or register (`existing` folder) a local project through the server. */
export async function createLocalProject(ctx: Ctx, s: CurrentSettings, input: { name: string; mode: 'new' | 'existing'; path?: string }): Promise<CreatedProject> {
  const cookie = await localSession(ctx, s);
  const origin = `http://localhost:${s.port}`;
  const r = await fetch(`${origin}/ui/projects/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin, 'x-mandate-ui': '1' },
    body: JSON.stringify(input),
  });
  const body = (await r.json().catch(() => ({}))) as { project?: CreatedProject; error?: { message?: string; hint?: string } | string; message?: string };
  if (!r.ok || !body.project) {
    const e = typeof body.error === 'object' ? body.error : { message: body.message ?? body.error };
    throw new Error(`could not create the project: ${e?.message ?? `HTTP ${r.status}`}${e && 'hint' in e && e.hint ? ` (${e.hint})` : ''}`);
  }
  return body.project;
}
