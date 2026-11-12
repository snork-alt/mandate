import type { RemoteAuth } from '../config.js';
import { redact } from './cli/exec.js';

/** Static credentials for one network operation (a GitHub App token is minted / taken from the cache here). */
export type StaticRemoteAuth = Exclude<RemoteAuth, { type: 'github-app' }>;

export async function resolveRemoteAuth(auth: RemoteAuth | undefined): Promise<StaticRemoteAuth | undefined> {
  if (auth?.type !== 'github-app') return auth;
  return { type: 'https', username: 'x-access-token', token: await auth.token() };
}

/** Same error with every literal secret (and `Authorization:` / `token=` shapes) masked; the stack is dropped. */
export function scrubbed(e: unknown, secrets: readonly (string | undefined)[]): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = redact(err.message, secrets);
  if (msg === err.message && !secrets.some((s) => s && err.stack?.includes(s))) return err;
  const out = new Error(msg);
  out.name = err.name;
  return out;
}

/** A remote auth failure: drop a cached App token so the next attempt mints a fresh one. */
export function onAuthFailure(auth: RemoteAuth | undefined, e: unknown): void {
  if (auth?.type === 'github-app' && /\b(401|403)\b|auth|credential/i.test(String((e as Error)?.message ?? e))) auth.invalidate?.();
}
