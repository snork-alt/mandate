/**
 * Browser login for the CLI (device-authorization style), used by `mandate channel login`:
 *  1. the CLI `POST /auth/cli/start { project, hostname }` and gets a secret `deviceCode` (polled) plus a short
 *     `userCode` and the page to open (`/cli-login?code=<userCode>`);
 *  2. the user, signed in to the web UI, sees "Authorize Mandate CLI on <host> for project X" with the code and approves
 *     (`POST /ui/cli-login/<userCode>/approve`, same-origin Origin + UI header, like every other UI write);
 *  3. the CLI polls `POST /auth/cli/poll { deviceCode }` and receives ONE personal token (`mndp_…`) scoped to that user and
 *     project, named `channel @ <host>`; it shows in the Personal tokens list and can be revoked there.
 * Codes live 10 minutes in memory, are single use (the session is deleted when the token is handed out or on deny) and
 * every endpoint is rate limited per client address. The token is minted at the first poll after approval, never stored.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentTokens } from './agent-tokens.js';

export const CLI_LOGIN_TTL_MS = 10 * 60_000;
export const CLI_LOGIN_INTERVAL_S = 2;
const MAX_SESSIONS = 500;
/** Unambiguous characters (no 0/O/1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type CliLoginStatus = 'pending' | 'approved' | 'denied';
interface Session {
  deviceCode: string;
  userCode: string;
  project: string;
  hostname: string;
  expiresAt: number;
  status: CliLoginStatus;
  login?: string;
}

/** `ABCD-EFGH`, 8 characters of a 31-letter alphabet (about 40 bits; guessing is rate limited and codes are short-lived). */
export function newUserCode(): string {
  const b = randomBytes(8);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normaliseUserCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

/** A hostname safe to show and to put in a token name. */
export const cleanHostname = (h: unknown): string => String(h ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown-host';

/** Fixed-window counter per key. */
export class RateLimit {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** True when the call is allowed (and counted). */
  take(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      return true;
    }
    return ++h.n <= this.max;
  }
}

export type PollResult = { status: 'pending' } | { status: 'denied' | 'expired' } | { status: 'approved'; token: string; project: string; login: string };

export class CliLogins {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly tokens: AgentTokens, private readonly now: () => number = Date.now) {}

  private sweep() {
    const t = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(k);
  }

  start(project: string, hostname: string): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | null {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) return null;
    let userCode = newUserCode();
    while (this.byUserCode(userCode)) userCode = newUserCode();
    const s: Session = { deviceCode: randomBytes(32).toString('base64url'), userCode, project, hostname: cleanHostname(hostname), expiresAt: this.now() + CLI_LOGIN_TTL_MS, status: 'pending' };
    this.sessions.set(s.deviceCode, s);
    return { deviceCode: s.deviceCode, userCode, expiresIn: CLI_LOGIN_TTL_MS / 1000, interval: CLI_LOGIN_INTERVAL_S };
  }

  byUserCode(code: string): Session | null {
    this.sweep();
    const c = normaliseUserCode(code);
    for (const s of this.sessions.values()) if (s.userCode === c) return s;
    return null;
  }

  /** The signed-in user approves (or denies) the pending login. */
  decide(code: string, login: string, approve: boolean): Session | null {
    const s = this.byUserCode(code);
    if (!s || s.status !== 'pending') return null;
    s.status = approve ? 'approved' : 'denied';
    if (approve) s.login = login;
    return s;
  }

  async poll(deviceCode: string): Promise<PollResult> {
    this.sweep();
    const s = [...this.sessions.values()].find((x) => x.deviceCode.length === deviceCode.length && timingSafeEqual(Buffer.from(x.deviceCode), Buffer.from(deviceCode)));
    if (!s) return { status: 'expired' };
    if (s.status === 'pending') return { status: 'pending' };
    this.sessions.delete(s.deviceCode); // single use
    if (s.status === 'denied') return { status: 'denied' };
    const t = await this.tokens.create(s.login!, s.project, `channel @ ${s.hostname}`);
    return { status: 'approved', token: t.token, project: s.project, login: s.login! };
  }
}
