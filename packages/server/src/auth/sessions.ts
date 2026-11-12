/**
 * Web UI sign-in state. The server secret stays a file; sessions and GitHub tokens live in the server-state database
 * (db/state.ts: SQLite `~/.mandate/state.sqlite` or the Postgres `mandate_server` schema):
 * - `~/.mandate/session.secret`: 32 random bytes (or `MANDATE_SESSION_SECRET`); signs cookies and encrypts tokens at rest.
 * - `sessions`: server-side sessions keyed by sha256(sid) with an expiry. The cookie is `<sid>.<hmac>`; logout deletes it.
 * - `github_tokens`: each user's GitHub OAuth access token, AES-256-GCM encrypted, with granted scopes and a `revoked`
 *   flag (set when GitHub answers 401). Used by GitHub-backed projects (`connectedBy`) to pull / push.
 *   Tokens never reach the browser, logs, URLs or argv. A small in-process cache serves the few synchronous readers
 *   (push gate, git credential getter); it is refreshed on every async read / write and every minute on Postgres.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateForHome, type ServerState } from '../db/state.js';

export interface SessionUser {
  login: string;
  name?: string;
  avatarUrl: string;
  /** GitHub numeric user id (user directory: noreply co-author addresses); not stored in the session. */
  githubId?: number;
  /** 'github' (OAuth, server mode) or 'local' (one-time link, local mode); unset = github (older sessions). */
  kind?: 'github' | 'local';
}

interface TokenRow {
  login: string;
  /** base64url(iv | tag | ciphertext). */
  enc: string;
  scopes: string;
  revoked: number;
}

/** Atomic JSON write, mode 0600; the directory is created 0700. */
export function writeSecretJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The server secret: env `MANDATE_SESSION_SECRET` (>= 32 chars) or `<home>/session.secret` (generated, 0600). */
export function loadServerSecret(home: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.MANDATE_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return createHash('sha256').update(fromEnv).digest();
  const file = path.join(home, 'session.secret');
  if (existsSync(file)) {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
    const b = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    if (b.length >= 32) return b;
  }
  const secret = randomBytes(32);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${secret.toString('base64url')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export class AuthStore {
  private readonly macKey: Buffer;
  private readonly encKey: Buffer;
  private readonly state: Promise<ServerState>;
  /** Token rows by lowercased login (synchronous readers); see the header. */
  private readonly cache = new Map<string, TokenRow>();
  /** Resolves once the state is open and the token cache is loaded. */
  readonly ready: Promise<void>;
  private sweep = 0;

  constructor(
    home: string,
    secret: Buffer,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    state?: ServerState | Promise<ServerState>,
  ) {
    this.macKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mandate session mac', 32));
    this.encKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mandate token enc', 32));
    this.state = state ? Promise.resolve(state) : stateForHome(home);
    this.ready = this.state.then(async (st) => {
      await this.loadTokens();
      if (st.db.caps.multiInstance) setInterval(() => void this.loadTokens().catch(() => undefined), 60_000).unref();
    });
    this.ready.catch(() => undefined);
  }

  /* -------------------------------------------------------------- signed values (OAuth state cookie) */

  sign(payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  unsign<T>(value: string | undefined): T | null {
    if (!value) return null;
    const i = value.lastIndexOf('.');
    if (i <= 0) return null;
    const body = value.slice(0, i);
    if (!this.macOk(body, value.slice(i + 1))) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  private mac(s: string) {
    return createHmac('sha256', this.macKey).update(s).digest('base64url');
  }
  private macOk(body: string, sig: string) {
    const a = Buffer.from(this.mac(body));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /* -------------------------------------------------------------- sessions */

  /** New session; returns the cookie value. */
  async createSession(user: SessionUser, ttlMs = this.ttlMs): Promise<string> {
    const st = await this.state;
    const sid = randomBytes(32).toString('base64url');
    const at = this.now();
    await st.db.run(`INSERT INTO ${st.t('sessions')} (id, login, name, avatar_url, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [sha(sid), user.login, user.name ?? null, user.avatarUrl, user.kind ?? null, at, at + ttlMs]);
    // Expired sessions are swept now and then (also by the state's background prune).
    if (++this.sweep % 50 === 1) await st.db.run(`DELETE FROM ${st.t('sessions')} WHERE expires_at <= ?`, [at]);
    return `${sid}.${this.mac(sid)}`;
  }

  /** The signed-in user for a cookie value (null: missing, forged, expired or logged out). */
  async session(cookie: string | undefined): Promise<SessionUser | null> {
    const sid = this.sidOf(cookie);
    if (!sid) return null;
    const st = await this.state;
    const s = await st.db.get<{ login: string; name: string | null; avatar_url: string; kind: string | null }>(`SELECT login, name, avatar_url, kind FROM ${st.t('sessions')} WHERE id = ? AND expires_at > ?`, [sha(sid), this.now()]);
    return s ? { login: s.login, ...(s.name ? { name: s.name } : {}), avatarUrl: s.avatar_url, kind: s.kind === 'local' ? 'local' : 'github' } : null;
  }

  async deleteSession(cookie: string | undefined): Promise<void> {
    const sid = this.sidOf(cookie);
    if (!sid) return;
    const st = await this.state;
    await st.db.run(`DELETE FROM ${st.t('sessions')} WHERE id = ?`, [sha(sid)]);
  }

  private sidOf(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const i = cookie.lastIndexOf('.');
    if (i <= 0) return null;
    const sid = cookie.slice(0, i);
    return this.macOk(sid, cookie.slice(i + 1)) ? sid : null;
  }

  /* -------------------------------------------------------------- GitHub tokens (encrypted at rest) */

  /** (Re)load every token row into the synchronous cache. */
  async loadTokens(): Promise<void> {
    const st = await this.state;
    const rows = await st.db.all<TokenRow & { login_lc: string }>(`SELECT login_lc, login, enc, scopes, revoked FROM ${st.t('github_tokens')}`);
    this.cache.clear();
    for (const r of rows) this.cache.set(r.login_lc, { login: r.login, enc: r.enc, scopes: r.scopes, revoked: Number(r.revoked) });
  }

  private async row(login: string): Promise<TokenRow | undefined> {
    const st = await this.state;
    const lc = login.toLowerCase();
    const r = await st.db.get<TokenRow>(`SELECT login, enc, scopes, revoked FROM ${st.t('github_tokens')} WHERE login_lc = ?`, [lc]);
    if (r) this.cache.set(lc, { ...r, revoked: Number(r.revoked) });
    else this.cache.delete(lc);
    return r ? { ...r, revoked: Number(r.revoked) } : undefined;
  }

  async saveToken(login: string, token: string, scopes: string[]): Promise<void> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, iv);
    c.setAAD(Buffer.from(login.toLowerCase()));
    const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    const enc = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
    const st = await this.state;
    const d = st.db.dialect;
    await st.db.run(d.upsert('github_tokens', ['login_lc', 'login', 'enc', 'scopes', 'updated_at', 'revoked'], ['login_lc'], ['login', 'enc', 'scopes', 'updated_at', 'revoked']), [login.toLowerCase(), login, enc, JSON.stringify(scopes), this.now(), 0]);
    this.cache.set(login.toLowerCase(), { login, enc, scopes: JSON.stringify(scopes), revoked: 0 });
  }

  private decrypt(login: string, t: TokenRow | undefined): { token: string; scopes: string[] } | null {
    if (!t || t.revoked) return null;
    try {
      const b = Buffer.from(t.enc, 'base64url');
      const d = createDecipheriv('aes-256-gcm', this.encKey, b.subarray(0, 12));
      d.setAAD(Buffer.from(login.toLowerCase()));
      d.setAuthTag(b.subarray(12, 28));
      return { token: Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'), scopes: parseScopes(t.scopes) };
    } catch {
      return null;
    }
  }

  /** The user's token (null when none, revoked or undecryptable). */
  async token(login: string): Promise<{ token: string; scopes: string[] } | null> {
    return this.decrypt(login, await this.row(login));
  }

  /** Synchronous variant over the cache (git credential getters, push gates). */
  tokenCached(login: string): { token: string; scopes: string[] } | null {
    return this.decrypt(login, this.cache.get(login.toLowerCase()));
  }

  /** Granted scopes of the user's (non-revoked) token. */
  async scopes(login: string): Promise<string[]> {
    const t = await this.row(login);
    return t && !t.revoked ? parseScopes(t.scopes) : [];
  }

  /** GitHub rejected the token (401): projects connected by this user show "Reconnect GitHub". */
  async markRevoked(login: string): Promise<void> {
    const st = await this.state;
    const lc = login.toLowerCase();
    const c = this.cache.get(lc);
    if (c) c.revoked = 1;
    // Never rejects (callers fire and forget): a failed write is retried by the next 401.
    await st.db.run(`UPDATE ${st.t('github_tokens')} SET revoked = 1, updated_at = ? WHERE login_lc = ? AND revoked = 0`, [this.now(), lc]).catch(() => undefined);
  }

  /** 'ok' | 'reconnect' (no usable token), from the cache (synchronous listings). */
  tokenStatus(login: string): 'ok' | 'reconnect' {
    return this.tokenCached(login) ? 'ok' : 'reconnect';
  }
}

const parseScopes = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
