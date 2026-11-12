/**
 * Web UI sign-in state under `~/.mandate` (every file mode 0600):
 * - `session.secret`: 32 random bytes (or `MANDATE_SESSION_SECRET`); signs cookies and encrypts tokens at rest.
 * - `sessions.json`: server-side sessions `{ id: sha256(sid), login, name?, avatarUrl, createdAt, expiresAt }`.
 *   The cookie is `<sid>.<hmac>`; logout deletes the session.
 * - `github-tokens.json`: each user's GitHub OAuth access token, AES-256-GCM encrypted, with granted scopes and a
 *   `revoked` flag (set when GitHub answers 401). Used by GitHub-backed projects (`connectedBy`) to pull / push.
 *   Tokens never reach the browser, logs, URLs or argv.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SessionUser {
  login: string;
  name?: string;
  avatarUrl: string;
}

interface StoredSession extends SessionUser {
  id: string;
  createdAt: string;
  expiresAt: string;
}

interface StoredToken {
  login: string;
  /** base64url(iv | tag | ciphertext). */
  enc: string;
  scopes: string[];
  updatedAt: string;
  revoked?: boolean;
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

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
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
  private readonly sessionsFile: string;
  private readonly tokensFile: string;

  constructor(
    home: string,
    secret: Buffer,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.macKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mandate session mac', 32));
    this.encKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mandate token enc', 32));
    this.sessionsFile = path.join(home, 'sessions.json');
    this.tokensFile = path.join(home, 'github-tokens.json');
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

  private sessions(): StoredSession[] {
    const now = this.now();
    return readJson<{ sessions?: StoredSession[] }>(this.sessionsFile, {}).sessions?.filter((s) => Date.parse(s.expiresAt) > now) ?? [];
  }

  /** New session; returns the cookie value. */
  createSession(user: SessionUser, ttlMs = this.ttlMs): string {
    const sid = randomBytes(32).toString('base64url');
    const at = this.now();
    const s: StoredSession = { id: sha(sid), login: user.login, ...(user.name ? { name: user.name } : {}), avatarUrl: user.avatarUrl, createdAt: new Date(at).toISOString(), expiresAt: new Date(at + ttlMs).toISOString() };
    writeSecretJson(this.sessionsFile, { sessions: [...this.sessions(), s] });
    return `${sid}.${this.mac(sid)}`;
  }

  /** The signed-in user for a cookie value (null: missing, forged, expired or logged out). */
  session(cookie: string | undefined): SessionUser | null {
    const sid = this.sidOf(cookie);
    if (!sid) return null;
    const id = sha(sid);
    const s = this.sessions().find((x) => x.id === id);
    return s ? { login: s.login, ...(s.name ? { name: s.name } : {}), avatarUrl: s.avatarUrl } : null;
  }

  deleteSession(cookie: string | undefined): void {
    const sid = this.sidOf(cookie);
    if (!sid) return;
    const id = sha(sid);
    writeSecretJson(this.sessionsFile, { sessions: this.sessions().filter((s) => s.id !== id) });
  }

  private sidOf(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const i = cookie.lastIndexOf('.');
    if (i <= 0) return null;
    const sid = cookie.slice(0, i);
    return this.macOk(sid, cookie.slice(i + 1)) ? sid : null;
  }

  /* -------------------------------------------------------------- GitHub tokens (encrypted at rest) */

  private tokens(): StoredToken[] {
    return readJson<{ tokens?: StoredToken[] }>(this.tokensFile, {}).tokens ?? [];
  }

  saveToken(login: string, token: string, scopes: string[]): void {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, iv);
    c.setAAD(Buffer.from(login.toLowerCase()));
    const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    const enc = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
    const rest = this.tokens().filter((t) => t.login.toLowerCase() !== login.toLowerCase());
    writeSecretJson(this.tokensFile, { tokens: [...rest, { login, enc, scopes, updatedAt: new Date(this.now()).toISOString() }] });
  }

  /** The user's token (null when none, revoked or undecryptable). */
  token(login: string): { token: string; scopes: string[] } | null {
    const t = this.tokens().find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!t || t.revoked) return null;
    try {
      const b = Buffer.from(t.enc, 'base64url');
      const d = createDecipheriv('aes-256-gcm', this.encKey, b.subarray(0, 12));
      d.setAAD(Buffer.from(login.toLowerCase()));
      d.setAuthTag(b.subarray(12, 28));
      return { token: Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'), scopes: t.scopes };
    } catch {
      return null;
    }
  }

  /** Granted scopes of the user's (non-revoked) token. */
  scopes(login: string): string[] {
    const t = this.tokens().find((x) => x.login.toLowerCase() === login.toLowerCase());
    return t && !t.revoked ? t.scopes : [];
  }

  /** GitHub rejected the token (401): projects connected by this user show "Reconnect GitHub". */
  markRevoked(login: string): void {
    const all = this.tokens();
    const t = all.find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!t || t.revoked) return;
    t.revoked = true;
    writeSecretJson(this.tokensFile, { tokens: all });
  }

  /** 'ok' | 'reconnect' (no usable token). */
  tokenStatus(login: string): 'ok' | 'reconnect' {
    return this.token(login) ? 'ok' : 'reconnect';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
