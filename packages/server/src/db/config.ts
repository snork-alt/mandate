/**
 * `database` block of config.json. SQLite is the default (one machine, small servers); Postgres is the server option
 * for shared state across instances. The connection URL is NEVER in config: `urlEnv` names the environment variable
 * that holds it (env or `~/.mandate/secrets.env`).
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SslMode } from './postgres.js';

export const DEFAULT_DATABASE_URL_ENV = 'MANDATE_DATABASE_URL';
export const SERVER_SCHEMA = 'mandate_server';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT = /^[a-z_][a-z0-9_]{0,40}$/;

const poolSchema = z
  .object({
    max: z.number().int().min(1).max(200).default(10),
    idleTimeoutMs: z.number().int().min(1000).max(3_600_000).default(30_000),
    connectionTimeoutMs: z.number().int().min(500).max(120_000).default(10_000),
  })
  .strict();

const inner = z
  .object({
    driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
    /** SQLite only: the server-state file (default `<MANDATE_HOME>/state.sqlite`). */
    path: z.string().min(1).optional(),
    /** Postgres only: name of the env var holding the connection URL. */
    urlEnv: z.string().regex(ENV_NAME, 'must be an environment variable name').default(DEFAULT_DATABASE_URL_ENV),
    /** Postgres: one schema per project (`mandate_<projectId>`, default) or `'prefix'` (tables `p_<projectId>_*` in one schema). */
    schemaPerProject: z.union([z.boolean(), z.literal('prefix')]).default(true),
    /** Postgres: publish each project's search index (FTS, trigram, pgvector, temporal graph) and run graph_query there. */
    publishIndex: z.boolean().default(true),
    /** TLS (overrides the URL's `sslmode`): `require` encrypts (Supabase), `verify-full` also checks the certificate. */
    ssl: z.enum(['disable', 'require', 'verify-full']).optional(),
    /** CA certificate file for `verify-full`. */
    sslRootCertPath: z.string().min(1).optional(),
    /** Named prepared statements. Default: on, off when the URL points at a transaction-mode pooler. */
    prepare: z.boolean().optional(),
    /** Schema for extensions Mandate creates (`vector`, `pg_trgm`); default `extensions` when it exists, else `public`. */
    extensionsSchema: z.string().regex(IDENT, 'a lowercase schema name').optional(),
    pool: poolSchema.default({ max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 10_000 }),
  })
  .strict()
  .superRefine((d, c) => {
    if (d.driver === 'postgres' && d.path) c.addIssue({ code: 'custom', path: ['path'], message: 'path is for driver "sqlite" only' });
    if (d.driver === 'sqlite' && d.sslRootCertPath) c.addIssue({ code: 'custom', path: ['sslRootCertPath'], message: 'sslRootCertPath is for driver "postgres" only' });
    if (d.sslRootCertPath && d.ssl !== 'verify-full') c.addIssue({ code: 'custom', path: ['ssl'], message: 'sslRootCertPath needs ssl: "verify-full"' });
  });

/** Refuse inline credentials with a pointer to the right place. */
export const databaseConfigSchema = z.preprocess((raw, ctx) => {
  if (raw && typeof raw === 'object') {
    for (const k of ['url', 'connectionString', 'password', 'uri']) {
      if (k in raw) ctx.addIssue({ code: 'custom', path: [k], message: `never put the database ${k === 'password' ? 'password' : 'URL'} in config.json: set it in the environment or ~/.mandate/secrets.env and name the variable in "urlEnv"` });
    }
  }
  return raw;
}, inner);

export type DatabaseConfig = z.output<typeof inner>;
export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = inner.parse({});

export type ResolvedDatabase =
  | { driver: 'sqlite'; path: string }
  | {
      driver: 'postgres';
      urlEnv: string;
      /** The connection URL (secret: never log it; use redactUrl). Undefined when the env var is unset. */
      url: string | undefined;
      schemaPerProject: boolean | 'prefix';
      publishIndex: boolean;
      ssl?: SslMode;
      sslRootCert?: string;
      prepare: boolean;
      extensionsSchema?: string;
      pool: DatabaseConfig['pool'];
      /** The URL looks like a transaction-mode pooler (Supabase :6543, PgBouncer). */
      pooler: PoolerKind;
    };

export type PoolerKind = 'none' | 'transaction' | 'session' | 'unknown';

/** Guess the pooler mode from the URL: Supabase's pooler host on 6543 = transaction, on 5432 = session. */
export function poolerOf(url: string | undefined): PoolerKind {
  if (!url) return 'none';
  try {
    const u = new URL(url);
    const port = u.port || '5432';
    if (/pgbouncer=true/i.test(u.search)) return 'transaction';
    if (/\.pooler\.supabase\.com$/i.test(u.hostname)) return port === '6543' ? 'transaction' : 'session';
    if (port === '6543') return 'transaction';
    if (/pgbouncer|pooler/i.test(u.hostname)) return 'unknown';
    return 'none';
  } catch {
    return 'none';
  }
}

/** `postgres://user:***@host:port/db?…` (never the password). */
export function redactUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const k of ['password', 'sslpassword']) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return '(unparseable URL)';
  }
}

export function resolveDatabase(cfg: DatabaseConfig, env: NodeJS.ProcessEnv, mandateHome: string): ResolvedDatabase {
  if (cfg.driver === 'sqlite') {
    const home = env.HOME ?? os.homedir();
    const p = cfg.path ? (cfg.path.startsWith('~/') ? path.join(home, cfg.path.slice(2)) : path.resolve(mandateHome, cfg.path)) : path.join(mandateHome, 'state.sqlite');
    return { driver: 'sqlite', path: env.MANDATE_STATE_DB ?? p };
  }
  const url = env[cfg.urlEnv] || undefined;
  const pooler = poolerOf(url);
  let sslRootCert: string | undefined;
  if (cfg.sslRootCertPath) sslRootCert = readFileSync(path.resolve(mandateHome, cfg.sslRootCertPath.replace(/^~\//, `${env.HOME ?? os.homedir()}/`)), 'utf8');
  return {
    driver: 'postgres',
    urlEnv: cfg.urlEnv,
    url,
    schemaPerProject: cfg.schemaPerProject,
    publishIndex: cfg.publishIndex,
    ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
    ...(sslRootCert ? { sslRootCert } : {}),
    prepare: cfg.prepare ?? pooler !== 'transaction',
    ...(cfg.extensionsSchema ? { extensionsSchema: cfg.extensionsSchema } : {}),
    pool: cfg.pool,
    pooler,
  };
}

/** Postgres schema / table prefix of a project's index (phase 2). */
export function projectScope(projectId: string, mode: boolean | 'prefix'): { schema: string; prefix: string } {
  const id = projectId.replace(/-/g, '_');
  return mode === 'prefix' ? { schema: 'mandate', prefix: `p_${id}_` } : { schema: `mandate_${id}`, prefix: '' };
}
