/**
 * Setup state under `~/.mandate` (every file 0600):
 * - `setup-token`: one-time token for the first-run wizard (`getmandate setup-url`), deleted when setup completes.
 * - `setup.json`: `{ completed: true, completedAt }`.
 * Plus the config writer (config.json: atomic, 0600, unknown keys kept, optimistic concurrency) and the
 * secrets.env writer (write-only values; never returned, logged or put in config).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileConfigSchema, migrateLegacyConfig, readRawConfig, type FileConfig } from '../config.js';
import { refreshSecrets } from '../secrets.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function writePrivate(file: string, text: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return timingSafeEqual(x, y);
};

/* ------------------------------------------------------------------ setup state */

/** The config already counts as set up: GitHub sign-in has a client id (an older OAuth App install, or the App). */
export const preconfigured = (c: { auth: { github?: { clientId?: string | undefined } | undefined } }) => !!c.auth.github?.clientId;

export class SetupState {
  constructor(
    readonly home: string,
    /** True when the config already counts as set up (legacy GitHub config, existing projects in use, ...). */
    private readonly preconfigured: () => boolean,
  ) {}

  private get tokenFile() {
    return path.join(this.home, 'setup-token');
  }
  private get stateFile() {
    return path.join(this.home, 'setup.json');
  }

  complete(): boolean {
    if (this.preconfigured()) return true;
    try {
      return (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { completed?: boolean }).completed === true;
    } catch {
      return false;
    }
  }

  /** The setup token (created when missing, only while setup is incomplete). */
  token(): string | null {
    if (this.complete()) return null;
    if (existsSync(this.tokenFile)) return readFileSync(this.tokenFile, 'utf8').trim();
    const t = randomBytes(32).toString('base64url');
    writePrivate(this.tokenFile, `${t}\n`);
    return t;
  }

  /** Constant-time check against the current token (false once setup is complete). */
  checkToken(presented: string | undefined): boolean {
    if (!presented || this.complete() || !existsSync(this.tokenFile)) return false;
    return safeEq(readFileSync(this.tokenFile, 'utf8').trim(), presented);
  }

  /** Hash of the current token: the setup cookie carries it, so completing setup (token deleted) invalidates it. */
  tokenHash(): string | null {
    if (this.complete() || !existsSync(this.tokenFile)) return null;
    return sha(readFileSync(this.tokenFile, 'utf8').trim());
  }

  markComplete(): void {
    writePrivate(this.stateFile, `${JSON.stringify({ completed: true, completedAt: new Date().toISOString() })}\n`);
    rmSync(this.tokenFile, { force: true });
  }
}

/* ------------------------------------------------------------------ first-admin claim */

/**
 * The first admin is whoever finishes the setup wizard and then signs in with GitHub: the wizard (setup-link holder
 * only) issues a single-use nonce (`admin-claim`, hashed, 1 hour), set as an HttpOnly cookie; the GitHub callback
 * consumes it after GitHub verified the identity and adds that login to `auth.github.allowedUsers`. Nobody else can
 * claim it: no setup link, no nonce; and a nonce works once.
 */
export class SetupAdminClaim {
  constructor(readonly home: string) {}
  private get file() {
    return path.join(this.home, 'admin-claim');
  }

  /** A new claim (replaces any earlier one). */
  issue(ttlMs = 3600_000): string {
    const nonce = randomBytes(32).toString('base64url');
    writePrivate(this.file, `${JSON.stringify({ h: sha(nonce), exp: Date.now() + ttlMs })}\n`);
    return nonce;
  }

  /** Consume: true once for the current, unexpired nonce (the file is removed first, so it never works twice). */
  consume(nonce: string | undefined): boolean {
    if (!nonce || !existsSync(this.file)) return false;
    let saved: { h?: string; exp?: number };
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as { h?: string; exp?: number };
    } catch {
      return false;
    }
    if (!saved.h || saved.h.length !== sha(nonce).length || !timingSafeEqual(Buffer.from(saved.h), Buffer.from(sha(nonce)))) return false;
    rmSync(this.file, { force: true });
    return (saved.exp ?? 0) > Date.now();
  }

  pending(): boolean {
    return existsSync(this.file);
  }
}

/* ------------------------------------------------------------------ config.json writer */

export class ConfigConflictError extends Error {
  constructor() {
    super('the config was edited outside Mandate; reload');
    this.name = 'ConfigConflictError';
  }
}

/** config.json with a version (content hash). Writes are atomic, 0600, keep unknown keys, and refuse stale versions. */
export class ConfigFile {
  constructor(readonly file: string) {}

  text(): string | null {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
  }

  version(): string {
    const t = this.text();
    return t === null ? 'missing' : sha(t).slice(0, 16);
  }

  raw(): Record<string, unknown> {
    return existsSync(this.file) ? readRawConfig(this.file) : {};
  }

  /** Parsed (legacy shapes migrated in memory). */
  parsed(): FileConfig {
    const raw = this.raw();
    return fileConfigSchema.parse(migrateLegacyConfig(raw) ?? raw);
  }

  /**
   * Apply `mutate` to the raw JSON if the file is still at `expectedVersion`; validates the result strictly.
   * Returns the new version. Throws ConfigConflictError (stale) or the zod error (invalid).
   */
  patch(expectedVersion: string, mutate: (json: Record<string, unknown>) => void): string {
    if (this.version() !== expectedVersion) throw new ConfigConflictError();
    const json = structuredClone(this.raw());
    mutate(json);
    fileConfigSchema.parse(migrateLegacyConfig(json) ?? json);
    writePrivate(this.file, `${JSON.stringify(json, null, 2)}\n`);
    return this.version();
  }

  /** Put back an earlier `text()` (a saved change that could not be applied); null (no file before) leaves it. */
  restore(text: string | null): void {
    if (text !== null) writePrivate(this.file, text);
  }
}

/* ------------------------------------------------------------------ secrets.env writer */

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Set (value) or remove (null) one variable in secrets.env, keeping other lines and comments. Never logs values. */
export function setSecret(file: string, name: string, value: string | null): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error('secret name: an environment variable name like MY_API_KEY');
  if (value !== null && (!value.length || /[\r\n\0]/.test(value) || value.length > 4096)) throw new Error('secret value: 1-4096 characters, single line');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : ['# Mandate secrets (mode 0600). Values fill unset environment variables.'];
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (value !== null) kept.push(`${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  writePrivate(file, `${kept.join('\n')}\n`);
  refreshSecrets();
}
