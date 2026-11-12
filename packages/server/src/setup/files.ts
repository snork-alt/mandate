/**
 * Setup state under `~/.mandate` (every file 0600):
 * - `setup-token`: one-time token for the first-run wizard (`getmandate setup-url`), deleted when setup completes.
 * - `setup.json`: `{ completed: true, completedAt }`.
 * Hashed one-time local sign-in tokens (`getmandate open`, 5 minutes) live in the server-state database (`login_tokens`).
 * Plus the config writer (config.json: atomic, 0600, unknown keys kept, optimistic concurrency) and the
 * secrets.env writer (write-only values; never returned, logged or put in config).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileConfigSchema, migrateLegacyConfig, readRawConfig, type FileConfig } from '../config.js';
import { refreshSecrets } from '../secrets.js';
import { stateForHome, type ServerState } from '../db/state.js';

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

/* ------------------------------------------------------------------ local one-time sign-in tokens */

export class LocalLoginTokens {
  private readonly state: Promise<ServerState>;
  constructor(
    readonly home: string,
    state?: ServerState | Promise<ServerState>,
  ) {
    this.state = state ? Promise.resolve(state) : stateForHome(home);
  }

  /** A new one-time token (5 minutes). */
  async issue(ttlMs = 5 * 60_000): Promise<string> {
    const st = await this.state;
    const t = randomBytes(32).toString('base64url');
    await st.db.run(`DELETE FROM ${st.t('login_tokens')} WHERE exp <= ?`, [Date.now()]);
    await st.db.run(`INSERT INTO ${st.t('login_tokens')} (hash, exp) VALUES (?, ?)`, [sha(t), Date.now() + ttlMs]);
    return t;
  }

  /** Consume: true once per token (an atomic delete, so two instances cannot both accept it). */
  async consume(presented: string | undefined): Promise<boolean> {
    if (!presented) return false;
    const st = await this.state;
    const r = await st.db.get<{ exp: number }>(`DELETE FROM ${st.t('login_tokens')} WHERE hash = ? RETURNING exp`, [sha(presented)]);
    return !!r && Number(r.exp) > Date.now();
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
