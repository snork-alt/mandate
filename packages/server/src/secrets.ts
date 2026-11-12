/**
 * `~/.mandate/secrets.env` (`MANDATE_SECRETS_FILE` overrides): dotenv-style `KEY=value` lines that fill environment
 * variables which are NOT already set (the real environment always wins). The config names env vars
 * (`apiKeyEnv`, `tokenEnv`, ...); this file is one place to keep their values outside the shell profile.
 * - Loaded at startup before the config is resolved; re-read when it changes (`refreshSecrets()` is called before
 *   values are used: Ask, git auth), so new keys apply without a restart.
 * - Refused (with a warning) when group- or world-accessible. Values are never logged.
 */
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse dotenv text: `KEY=value`, `export KEY=value`, `#` comments, single / double quotes (`\n` escapes in double quotes). */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) {
      v = v.slice(1, v.indexOf(q, 1));
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out.set(m[1]!, v);
  }
  return out;
}

export interface SecretsLog {
  warn(msg: string): void;
}

export class SecretsFile {
  private stamp = '';
  /** Variables this file set (it may update or remove them later; anything else in the env is never touched). */
  private readonly owned = new Map<string, string>();
  /** Last refusal / error (null when loaded or absent). */
  problem: string | null = null;

  constructor(
    readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: SecretsLog = { warn: (m) => console.warn(m) },
  ) {}

  /** Names this file provides right now (never values). */
  names(): string[] {
    return [...this.owned.keys()];
  }

  refresh(): void {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.file);
    } catch {
      if (this.stamp !== 'missing') this.apply(new Map());
      this.stamp = 'missing';
      this.problem = null;
      return;
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    if ((st.mode & 0o077) !== 0) {
      this.problem = `permissions ${(st.mode & 0o777).toString(8)} are too open (group/world readable); run: chmod 600 ${this.file}`;
      this.log.warn(`mandate: NOT loading secrets from ${this.file}: ${this.problem}`);
      this.apply(new Map());
      return;
    }
    try {
      this.apply(parseDotenv(readFileSync(this.file, 'utf8')));
      this.problem = null;
    } catch (e) {
      this.problem = (e as NodeJS.ErrnoException).code ?? 'unreadable';
      this.log.warn(`mandate: cannot read secrets file ${this.file} (${this.problem})`);
    }
  }

  private apply(values: Map<string, string>): void {
    // Drop values this file set earlier and no longer provides (unless something else changed them since).
    for (const [k, v] of this.owned) {
      if (!values.has(k) && this.env[k] === v) delete this.env[k];
    }
    for (const k of [...this.owned.keys()]) if (!values.has(k)) this.owned.delete(k);
    for (const [k, v] of values) {
      if (!NAME_RE.test(k)) continue;
      const mine = this.owned.has(k) && this.env[k] === this.owned.get(k);
      if (this.env[k] !== undefined && this.env[k] !== '' && !mine) continue; // the real environment wins
      this.env[k] = v;
      this.owned.set(k, v);
    }
  }
}

let active: SecretsFile | null = null;

/** The secrets file path for an environment. */
export function secretsPathOf(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  const p = env.MANDATE_SECRETS_FILE || path.join(env.MANDATE_HOME || path.join(home, '.mandate'), 'secrets.env');
  return path.resolve(p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
}

/** Load the secrets file into `process.env` (startup) and remember it for `refreshSecrets`. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env, log?: SecretsLog): SecretsFile {
  active = new SecretsFile(secretsPathOf(env), env, log);
  active.refresh();
  return active;
}

/** Pick up changes to the secrets file (cheap stat; no-op when none was loaded). */
export function refreshSecrets(): void {
  active?.refresh();
}
