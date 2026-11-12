/**
 * "Test connection" for the Database settings step: version, required extensions (installed / available / schema),
 * privileges, pooler mode and TLS, with guidance for what is missing. Read-only unless `createExtensions` is set.
 * Never returns or logs the URL's password.
 */
import pg from 'pg';
import { poolerOf, redactUrl, type PoolerKind } from './config.js';
import { parseSslFromUrl, sslConfig, type SslMode } from './postgres.js';

export const REQUIRED_EXTENSIONS = ['vector', 'pg_trgm'] as const;
export const MIN_PG_VERSION = 140000;

export interface ExtensionStatus {
  installed: boolean;
  /** Schema it is installed in (`extensions` on Supabase). */
  schema: string | null;
  version: string | null;
  /** Can be installed on this server (listed in pg_available_extensions). */
  available: boolean;
}

export interface ProbeResult {
  ok: boolean;
  /** Redacted URL. */
  target: string;
  version?: string;
  versionNum?: number;
  pooler: PoolerKind;
  ssl: boolean;
  extensions: Record<string, ExtensionStatus>;
  canCreateSchema?: boolean;
  /** Blocking problems. */
  errors: string[];
  /** Non-blocking advice. */
  warnings: string[];
}

export interface ProbeOptions {
  url: string;
  ssl?: SslMode;
  sslRootCert?: string;
  /** Try `CREATE EXTENSION IF NOT EXISTS … WITH SCHEMA <extensionsSchema>` for missing extensions. */
  createExtensions?: boolean;
  extensionsSchema?: string;
  timeoutMs?: number;
  /** Test seam: a client factory (PGlite shim). */
  client?: () => pg.Client;
}

const GUIDE: Record<string, string> = {
  vector: 'pgvector (`vector`) is needed for semantic search: on Supabase enable it under Database → Extensions (schema "extensions"); elsewhere install pgvector and run CREATE EXTENSION vector;',
  pg_trgm: '`pg_trgm` is needed for typo-tolerant symbol search: on Supabase enable it under Database → Extensions; elsewhere run CREATE EXTENSION pg_trgm; (it ships with PostgreSQL contrib)',
};

export async function probePostgres(o: ProbeOptions): Promise<ProbeResult> {
  const { url, ssl: urlSsl } = parseSslFromUrl(o.url);
  const mode = o.ssl ?? urlSsl;
  const res: ProbeResult = { ok: false, target: redactUrl(o.url), pooler: poolerOf(o.url), ssl: !!mode && mode !== 'disable', extensions: {}, errors: [], warnings: [] };
  const scrub = (m: string) => m.split(o.url).join(res.target).split(url).join(res.target);
  const client = o.client?.() ?? new pg.Client({ connectionString: url, ssl: sslConfig(mode, o.sslRootCert), connectionTimeoutMillis: o.timeoutMs ?? 10_000, statement_timeout: o.timeoutMs ?? 10_000, application_name: 'mandate-probe' });
  try {
    await client.connect();
    const v = await client.query<{ v: string; n: string }>("SELECT version() AS v, current_setting('server_version_num') AS n");
    res.version = v.rows[0]!.v;
    res.versionNum = Number(v.rows[0]!.n);
    if (res.versionNum < MIN_PG_VERSION) res.errors.push(`PostgreSQL ${Math.floor(res.versionNum / 10000)} is too old: Mandate needs 14 or newer`);
    if (o.createExtensions) {
      const target = o.extensionsSchema ?? ((await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'extensions'")).rowCount ? 'extensions' : 'public');
      for (const name of REQUIRED_EXTENSIONS) {
        try {
          await client.query(`CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA "${target.replace(/"/g, '""')}"`);
        } catch (e) {
          res.warnings.push(`could not create extension ${name}: ${scrub((e as Error).message)}`);
        }
      }
    }
    const inst = await client.query<{ extname: string; nspname: string; extversion: string }>('SELECT e.extname, n.nspname, e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace');
    const avail = new Set((await client.query<{ name: string }>('SELECT name FROM pg_available_extensions').catch(() => ({ rows: [] as { name: string }[] }))).rows.map((r) => r.name));
    for (const name of REQUIRED_EXTENSIONS) {
      const i = inst.rows.find((r) => r.extname === name);
      res.extensions[name] = { installed: !!i, schema: i?.nspname ?? null, version: i?.extversion ?? null, available: !!i || avail.has(name) };
      if (!i) res.errors.push(`${avail.has(name) ? 'extension not enabled' : 'extension not available on this server'}: ${GUIDE[name]}`);
    }
    const priv = await client.query<{ ok: boolean }>("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok");
    res.canCreateSchema = !!priv.rows[0]?.ok;
    if (!res.canCreateSchema) res.errors.push('the database user cannot create schemas (Mandate creates mandate_server and mandate_<project>): GRANT CREATE ON DATABASE <db> TO <user>');
  } catch (e) {
    res.errors.push(`cannot connect: ${scrub((e as Error).message)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  if (res.pooler === 'transaction') res.warnings.push('this URL points at a transaction-mode pooler (port 6543): use the direct connection (5432) or the session pooler for Mandate. It works with prepared statements off, but per-project write locks and long index transactions are better on a direct/session connection.');
  if (res.pooler === 'unknown') res.warnings.push('this looks like a connection pooler: Mandate needs session semantics or a direct connection (5432); in transaction mode set database.prepare to false');
  if (!res.ssl && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(o.url)) res.warnings.push('the connection is not encrypted: add ?sslmode=require (Supabase requires TLS) or set database.ssl');
  res.ok = res.errors.length === 0;
  return res;
}
