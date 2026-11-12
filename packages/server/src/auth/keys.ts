/**
 * Agent keys (`~/.mandate/keys.json`, mode 0600): `{ keys: [{ id, project, name, key, createdAt, lastUsedAt? }] }`.
 * A key is `mnd_<project>_<43 chars of base64url (32 random bytes)>` and is valid ONLY for its own project.
 * The file is re-read when it changes (stat on every check), so a revoked key stops working without a restart.
 * Keys are never logged, put in URLs / argv, or written anywhere else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ID_RE } from '../config.js';

export const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@:-]{0,59}$/;

const keySchema = z
  .object({
    id: z.string().regex(/^key_[a-z0-9]{6,32}$/),
    project: z.string().regex(PROJECT_ID_RE),
    name: z.string().regex(KEY_NAME_RE),
    key: z.string().regex(/^mnd_[a-z0-9-]+_[A-Za-z0-9_-]{43,}$/),
    createdAt: z.string(),
    lastUsedAt: z.string().optional(),
    /** Named service account (CI): accepted by a team, writes attributed to `service:<name>`. */
    service: z.boolean().optional(),
  })
  .strict();
const fileSchema = z.object({ keys: z.array(keySchema) }).strict();

export type AgentKey = z.infer<typeof keySchema>;

export class KeysFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'KeysFileError';
  }
}

/** `mnd_<project>_<random>`: 32 random bytes, base64url. */
export function generateKey(project: string): string {
  return `mnd_${project}_${randomBytes(32).toString('base64url')}`;
}

/** `mnd_proj_AbCd…wxyz` (first 4 / last 4 random chars) for listings. */
export function maskKey(key: string): string {
  const m = /^(mnd_[a-z0-9-]+_)(.+)$/.exec(key);
  if (!m) return '••••';
  return `${m[1]}${m[2]!.slice(0, 4)}…${m[2]!.slice(-4)}`;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Group- or world-accessible keys file (any of 0o077 set). */
export function insecureMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

export interface KeyStoreOptions {
  log?: { warn(msg: string): void; error(msg: string): void };
  /** Minimum interval between `lastUsedAt` writes per key (default 60 s; 0 = always). */
  touchIntervalMs?: number;
}

export class KeyStore {
  private keys: AgentKey[] = [];
  private stamp = '';
  /** Why bearer auth is refused right now (bad permissions, invalid file); null when the file is usable. */
  private problem: string | null = null;
  private readonly touched = new Map<string, number>();

  constructor(
    readonly file: string,
    private readonly opts: KeyStoreOptions = {},
  ) {}

  /** Re-read the file when its (inode, size, mtime) changed. Never throws; problems refuse every key. */
  refresh(): void {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.file);
    } catch {
      this.keys = [];
      this.stamp = 'missing';
      this.problem = null;
      return;
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    if (insecureMode(st.mode)) {
      this.keys = [];
      this.problem = `permissions ${(st.mode & 0o777).toString(8)} are too open (group/world readable); run: chmod 600 ${this.file}`;
      this.opts.log?.error(`mandate: REFUSING agent keys: ${this.file} ${this.problem}`);
      return;
    }
    try {
      this.keys = this.parse(readFileSync(this.file, 'utf8'));
      this.problem = null;
    } catch (e) {
      this.keys = [];
      this.problem = (e as Error).message;
      this.opts.log?.error(`mandate: REFUSING agent keys: ${this.problem}`);
    }
  }

  private parse(text: string): AgentKey[] {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new KeysFileError(this.file, `not valid JSON (${(e as Error).message.replace(/mnd_[A-Za-z0-9_-]+/g, '***')})`);
    }
    const r = fileSchema.safeParse(json);
    if (!r.success) throw new KeysFileError(this.file, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return r.data.keys;
  }

  /** Why keys are refused (null when fine). */
  status(): string | null {
    this.refresh();
    return this.problem;
  }

  list(): AgentKey[] {
    this.refresh();
    return this.keys.map((k) => ({ ...k }));
  }

  /**
   * The key record when `presented` is a valid key of `project` (null otherwise). Every stored key is compared
   * (constant-time on SHA-256 digests), so timing reveals neither which key nor which project matched.
   */
  verify(project: string | null, presented: string): AgentKey | null {
    this.refresh();
    if (this.problem || !presented) return null;
    const d = digest(presented);
    let hit: AgentKey | null = null;
    for (const k of this.keys) {
      if (timingSafeEqual(d, digest(k.key)) && (project === null || k.project === project)) hit = k;
    }
    if (hit) this.touch(hit.id);
    return hit;
  }

  /** Record `lastUsedAt` (throttled; re-reads the file first so concurrent CLI edits are kept). */
  private touch(id: string): void {
    const now = Date.now();
    const every = this.opts.touchIntervalMs ?? 60_000;
    if (now - (this.touched.get(id) ?? 0) < every) return;
    this.touched.set(id, now);
    try {
      const keys = this.parse(readFileSync(this.file, 'utf8'));
      const k = keys.find((x) => x.id === id);
      if (!k) return;
      k.lastUsedAt = new Date(now).toISOString();
      this.write(keys);
    } catch (e) {
      this.opts.log?.warn(`mandate: could not record key use: ${(e as Error).message}`);
    }
  }

  /** Atomic write, mode 0600 (the directory is created 0700 when missing). */
  private write(keys: AgentKey[]): void {
    const dir = path.dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ keys }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.stamp = '';
    this.refresh();
  }

  /** Read-modify-write the file (refuses when it is insecure or invalid, so a bad file is never overwritten). */
  private mutate(fn: (keys: AgentKey[]) => void): void {
    let keys: AgentKey[] = [];
    if (existsSync(this.file)) {
      const st = statSync(this.file);
      if (insecureMode(st.mode)) throw new KeysFileError(this.file, `permissions ${(st.mode & 0o777).toString(8)} are too open; run: chmod 600 ${this.file}`);
      keys = this.parse(readFileSync(this.file, 'utf8'));
    }
    fn(keys);
    this.write(keys);
  }

  /** Create a key for `project`; returns the full record (the caller shows the key once). */
  create(project: string, name: string, opts: { service?: boolean } = {}): AgentKey {
    if (!PROJECT_ID_RE.test(project)) throw new KeysFileError(this.file, `invalid project id '${project}'`);
    if (!KEY_NAME_RE.test(name)) throw new KeysFileError(this.file, 'key name: 1-60 chars of letters, digits, space . _ @ : - (starting with a letter or digit)');
    const rec: AgentKey = { id: `key_${randomBytes(6).toString('hex')}`, project, name, key: generateKey(project), createdAt: new Date().toISOString(), ...(opts.service ? { service: true } : {}) };
    this.mutate((keys) => keys.push(rec));
    return rec;
  }

  /** Remove a key by id; false when there is none. */
  revoke(id: string): boolean {
    let found = false;
    this.mutate((keys) => {
      const i = keys.findIndex((k) => k.id === id);
      if (i >= 0) {
        keys.splice(i, 1);
        found = true;
      }
    });
    return found;
  }

  /** One key per project that has none (first run, new projects). Returns the projects that got a key. */
  ensureProjectKeys(projects: string[], name = 'default'): string[] {
    this.refresh();
    if (this.problem) return [];
    const missing = projects.filter((p) => !this.keys.some((k) => k.project === p));
    if (!missing.length) return [];
    const now = new Date().toISOString();
    this.mutate((keys) => {
      for (const p of missing) if (!keys.some((k) => k.project === p)) keys.push({ id: `key_${randomBytes(6).toString('hex')}`, project: p, name, key: generateKey(p), createdAt: now });
    });
    return missing;
  }
}
