/**
 * Talking to the local server. The contract with the server (packages/server/src/setup):
 * - `~/.mandate/setup-token` (SetupState) → `<url>/auth/setup?token=…`: the one-time setup wizard link.
 * The link must be opened on this machine (loopback), or over HTTPS / an SSH tunnel. Sign-in itself is always GitHub.
 */
import { readFileSync } from 'node:fs';
import { SetupState } from '../../server/src/setup/files.js';
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

/** Same rule as the server: GitHub sign-in with a client id counts as set up. */
function preconfigured(ctx: Ctx): boolean {
  try {
    const j = JSON.parse(readFileSync(configFile(ctx), 'utf8')) as { auth?: { github?: { clientId?: string } } };
    return !!j.auth?.github?.clientId;
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
