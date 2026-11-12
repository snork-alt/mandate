/** Database adapter: open the configured backend (SQLite default, Postgres for shared server deployments). */
import { redactUrl, SERVER_SCHEMA, type ResolvedDatabase } from './config.js';
import { PostgresDb } from './postgres.js';
import { SqliteDb } from './sqlite.js';
import type { Db } from './types.js';

export type { Capabilities, Db, Dialect, Driver, Queryable, Row, RunResult, SqlValue, TxOptions } from './types.js';
export { migrate, type Migration, type MigrationResult } from './migrate.js';
export { SqliteDb, KeyedMutex } from './sqlite.js';
export { PostgresDb } from './postgres.js';
export * from './config.js';

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/** The server-state database (SQLite file, or the `mandate_server` schema on Postgres). */
export async function openServerDb(r: ResolvedDatabase): Promise<Db> {
  if (r.driver === 'sqlite') return SqliteDb.open(r.path);
  if (!r.url) throw new DatabaseConfigError(`database.driver is "postgres" but the environment variable ${r.urlEnv} is not set (set it in the environment or ~/.mandate/secrets.env)`);
  try {
    return await PostgresDb.connect({
      connectionString: r.url,
      schema: SERVER_SCHEMA,
      ...(r.ssl ? { ssl: r.ssl } : {}),
      ...(r.sslRootCert ? { sslRootCert: r.sslRootCert } : {}),
      prepare: r.prepare,
      ...(r.extensionsSchema ? { extensionsSchema: r.extensionsSchema } : {}),
      pool: r.pool,
    });
  } catch (e) {
    // Driver errors can echo the URL: never let the password through.
    const msg = String((e as Error).message ?? e).split(r.url).join(redactUrl(r.url));
    throw new DatabaseConfigError(`cannot connect to Postgres (${redactUrl(r.url)}): ${msg}`);
  }
}
