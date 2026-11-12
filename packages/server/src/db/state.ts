/**
 * Server state on the database adapter: sessions, GitHub tokens (encrypted), personal agent tokens, MCP OAuth clients /
 * tokens / codes, local one-time sign-in tokens and durable idempotency results. SQLite: `<MANDATE_HOME>/state.sqlite`;
 * Postgres: the `mandate_server` schema (shared by every server instance).
 *
 * Stays as files (bootstrap / secrets, needed before the database is reachable): `keys.json`, `secrets.env`,
 * `session.secret`, `setup-token`, `setup.json`, `config.json`, `projects.json`.
 *
 * Legacy JSON files (`sessions.json`, `github-tokens.json`, `agent-tokens.json`, `oauth.json`, `login-tokens.json`) are
 * imported once per database (recorded in `state_meta`) and left in place untouched.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedDatabase } from './config.js';
import { openServerDb } from './index.js';
import { migrate, type Migration } from './migrate.js';
import { SqliteDb } from './sqlite.js';
import type { Db, Dialect, Queryable } from './types.js';

const schemaV1 = (d: Dialect) => {
  const { bigint: B, bool: BOOL } = d.types;
  const t = d.table;
  const ix = d.index;
  return `
CREATE TABLE IF NOT EXISTS ${t('state_meta')} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${t('sessions')} (
  id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT NOT NULL, kind TEXT,
  created_at ${B} NOT NULL, expires_at ${B} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix('sessions_expires')} ON ${t('sessions')} (expires_at);
CREATE TABLE IF NOT EXISTS ${t('github_tokens')} (
  login_lc TEXT PRIMARY KEY, login TEXT NOT NULL, enc TEXT NOT NULL, scopes TEXT NOT NULL, updated_at ${B} NOT NULL,
  revoked ${BOOL} NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${t('agent_tokens')} (
  id TEXT PRIMARY KEY, login TEXT NOT NULL, login_lc TEXT NOT NULL, project TEXT NOT NULL, name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at ${B} NOT NULL, last_used_at ${B}
);
CREATE INDEX IF NOT EXISTS ${ix('agent_tokens_owner')} ON ${t('agent_tokens')} (login_lc, project);
CREATE TABLE IF NOT EXISTS ${t('oauth_clients')} (
  client_id TEXT PRIMARY KEY, client_name TEXT, redirect_uris TEXT NOT NULL, issued_at ${B} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix('oauth_clients_issued')} ON ${t('oauth_clients')} (issued_at);
CREATE TABLE IF NOT EXISTS ${t('oauth_tokens')} (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), client_id TEXT NOT NULL,
  login TEXT NOT NULL, login_lc TEXT NOT NULL, project TEXT NOT NULL, exp ${B} NOT NULL, family TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix('oauth_tokens_family')} ON ${t('oauth_tokens')} (family);
CREATE INDEX IF NOT EXISTS ${ix('oauth_tokens_login')} ON ${t('oauth_tokens')} (login_lc);
CREATE INDEX IF NOT EXISTS ${ix('oauth_tokens_exp')} ON ${t('oauth_tokens')} (exp);
CREATE TABLE IF NOT EXISTS ${t('oauth_codes')} (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  login TEXT NOT NULL, project TEXT NOT NULL, exp ${B} NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t('login_tokens')} (hash TEXT PRIMARY KEY, exp ${B} NOT NULL);
CREATE TABLE IF NOT EXISTS ${t('idempotency')} (
  project TEXT NOT NULL, key TEXT NOT NULL, args TEXT NOT NULL, at ${B} NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (project, key)
);
CREATE INDEX IF NOT EXISTS ${ix('idempotency_at')} ON ${t('idempotency')} (at);
`;
};

export const SERVER_MIGRATIONS: Migration[] = [{ id: 1, name: 'server state', sqlite: schemaV1, postgres: schemaV1 }];

export class ServerState {
  private timers: NodeJS.Timeout[] = [];
  private constructor(readonly db: Db) {}

  /** Migrate (idempotent) and, given the Mandate home, import legacy JSON state once. */
  static async open(db: Db, opts: { home?: string } = {}): Promise<ServerState> {
    await migrate(db, 'server', SERVER_MIGRATIONS);
    const s = new ServerState(db);
    if (opts.home) await importLegacyJson(s, opts.home);
    return s;
  }

  t(name: string): string {
    return this.db.dialect.table(name);
  }

  async meta(key: string): Promise<string | undefined> {
    return (await this.db.get<{ value: string }>(`SELECT value FROM ${this.t('state_meta')} WHERE key = ?`, [key]))?.value;
  }
  async setMeta(key: string, value: string, q: Queryable = this.db): Promise<void> {
    await q.run(this.db.dialect.upsert('state_meta', ['key', 'value'], ['key'], ['value']), [key, value]);
  }

  /** Delete expired rows (sessions, OAuth tokens and codes, login tokens, idempotency results older than 24 h). */
  async prune(now = Date.now()): Promise<void> {
    const t = (n: string) => this.t(n);
    await this.db.run(`DELETE FROM ${t('sessions')} WHERE expires_at <= ?`, [now]);
    await this.db.run(`DELETE FROM ${t('oauth_tokens')} WHERE exp <= ?`, [Math.floor(now / 1000)]);
    await this.db.run(`DELETE FROM ${t('oauth_codes')} WHERE exp <= ?`, [now]);
    await this.db.run(`DELETE FROM ${t('login_tokens')} WHERE exp <= ?`, [now]);
    await this.db.run(`DELETE FROM ${t('idempotency')} WHERE at <= ?`, [now - 24 * 3600_000]);
  }

  /** Prune every `ms` in the background (unref'd). */
  startPruning(ms = 10 * 60_000): void {
    const timer = setInterval(() => void this.prune().catch(() => undefined), ms);
    timer.unref();
    this.timers.push(timer);
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.db.close();
  }
}

/* ---------------------------------------------------------------- per-home SQLite fallback */

const shared = new Map<string, Promise<ServerState>>();

/**
 * The process-wide state for a Mandate home: the configured one when `useServerState` registered it (server startup,
 * CLI), else `<home>/state.sqlite` opened once. Stores constructed with only a home path (tests, scripts) use this.
 */
export function stateForHome(home: string): Promise<ServerState> {
  const key = path.resolve(home);
  let p = shared.get(key);
  if (!p) {
    p = ServerState.open(SqliteDb.open(path.join(key, 'state.sqlite')), { home: key });
    shared.set(key, p);
  }
  return p;
}

/** Register the configured state for a home (so every store built from that home shares it). */
export function useServerState(home: string, state: ServerState | Promise<ServerState>): void {
  shared.set(path.resolve(home), Promise.resolve(state));
}

/**
 * Open the configured server state (server startup, CLI): migrate and import legacy JSON once. The caller passes it to
 * the stores and closes it (a Postgres pool keeps the process alive).
 */
export async function openConfiguredState(database: ResolvedDatabase, home: string): Promise<ServerState> {
  const db = await openServerDb(database);
  try {
    return await ServerState.open(db, { home });
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
}

/** Close and forget every per-home state (tests). */
export async function closeSharedStates(): Promise<void> {
  const all = [...shared.values()];
  shared.clear();
  await Promise.all(all.map(async (p) => (await p.catch(() => null))?.close()));
}

/* ---------------------------------------------------------------- legacy JSON import */

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** One-time import of the pre-database JSON stores (each file once per database; files are left untouched). */
export async function importLegacyJson(s: ServerState, home: string): Promise<string[]> {
  const imported: string[] = [];
  const d = s.db.dialect;
  const once = async (file: string, body: (q: Queryable, j: Record<string, unknown>) => Promise<void>) => {
    const key = `import:${file}`;
    if (await s.meta(key)) return;
    const j = readJson(path.join(home, file));
    await s.db.tx(async (q) => {
      if (j && typeof j === 'object') await body(q, j as Record<string, unknown>);
      await s.setMeta(key, new Date().toISOString(), q);
    });
    if (j) imported.push(file);
  };
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const now = Date.now();

  await once('sessions.json', async (q, j) => {
    const sql = d.insertIgnore('sessions', ['id', 'login', 'name', 'avatar_url', 'kind', 'created_at', 'expires_at']);
    for (const r of arr(j.sessions)) {
      const exp = ms(r.expiresAt);
      if (!(exp > now) || typeof r.id !== 'string' || typeof r.login !== 'string') continue;
      await q.run(sql, [r.id, r.login, (r.name as string) ?? null, String(r.avatarUrl ?? ''), (r.kind as string) ?? null, ms(r.createdAt) || now, exp]);
    }
  });
  await once('github-tokens.json', async (q, j) => {
    const sql = d.insertIgnore('github_tokens', ['login_lc', 'login', 'enc', 'scopes', 'updated_at', 'revoked']);
    for (const r of arr(j.tokens)) {
      if (typeof r.login !== 'string' || typeof r.enc !== 'string') continue;
      await q.run(sql, [r.login.toLowerCase(), r.login, r.enc, JSON.stringify(r.scopes ?? []), ms(r.updatedAt) || now, r.revoked ? 1 : 0]);
    }
  });
  await once('agent-tokens.json', async (q, j) => {
    const sql = d.insertIgnore('agent_tokens', ['id', 'login', 'login_lc', 'project', 'name', 'hash', 'created_at', 'last_used_at']);
    for (const r of arr(j.tokens)) {
      if (typeof r.id !== 'string' || typeof r.login !== 'string' || typeof r.hash !== 'string') continue;
      await q.run(sql, [r.id, r.login, r.login.toLowerCase(), String(r.project), String(r.name), r.hash, ms(r.createdAt) || now, ms(r.lastUsedAt) || null]);
    }
  });
  await once('oauth.json', async (q, j) => {
    const cs = d.insertIgnore('oauth_clients', ['client_id', 'client_name', 'redirect_uris', 'issued_at']);
    for (const r of arr(j.clients)) {
      if (typeof r.client_id !== 'string') continue;
      await q.run(cs, [r.client_id, (r.client_name as string) ?? null, JSON.stringify(r.redirect_uris ?? []), Number(r.client_id_issued_at) || Math.floor(now / 1000)]);
    }
    const ts = d.insertIgnore('oauth_tokens', ['hash', 'kind', 'client_id', 'login', 'login_lc', 'project', 'exp', 'family']);
    for (const r of arr(j.tokens)) {
      if (typeof r.hash !== 'string' || typeof r.login !== 'string' || !(Number(r.exp) > now / 1000)) continue;
      await q.run(ts, [r.hash, String(r.kind), String(r.clientId), r.login, r.login.toLowerCase(), String(r.project), Number(r.exp), String(r.family)]);
    }
  });
  await once('login-tokens.json', async (q, j) => {
    const sql = d.insertIgnore('login_tokens', ['hash', 'exp']);
    for (const r of arr(j.tokens)) if (typeof r.hash === 'string' && Number(r.exp) > now) await q.run(sql, [r.hash, Number(r.exp)]);
  });
  return imported;
}
