/**
 * Test harness: run a suite against every database backend.
 * - sqlite: better-sqlite3 in memory (always).
 * - pglite: embedded Postgres (WASM) with pgvector + pg_trgm installed Supabase-style in an `extensions` schema
 *   (always; no Docker). Single session: no real cross-connection concurrency (see `caps.singleSession`).
 * - postgres: a real server when MANDATE_TEST_PG_URL is set (concurrency, SKIP LOCKED, advisory locks across instances).
 * Every Postgres scope gets a unique schema (dropped afterwards), so runs never collide.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import type pg from 'pg';
import { PostgresDb } from '../../src/db/postgres.js';
import { SqliteDb } from '../../src/db/sqlite.js';
import type { Db } from '../../src/db/types.js';

export type BackendName = 'sqlite' | 'pglite' | 'postgres';

export interface Backend {
  name: BackendName;
  /** A fresh database scope (new in-memory SQLite / a new schema on Postgres). */
  open(opts?: { prepare?: boolean }): Promise<Db>;
  /** A second "instance" on the same scope (separate pool) — real Postgres only (null elsewhere). */
  sibling(db: Db): Promise<Db | null>;
  /** Raw pool config of the server (probe tests). */
  poolConfig?(): pg.PoolConfig;
}

const PG_URL = process.env.MANDATE_TEST_PG_URL || '';
export const hasRealPg = !!PG_URL;

const uniq = () => `t_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;

type PGliteT = import('@electric-sql/pglite').PGlite;
let pglite: Promise<PGliteT> | null = null;
/** One PGlite per test file (module instance), with extensions in an `extensions` schema (as on Supabase). */
export function sharedPglite(): Promise<PGliteT> {
  pglite ??= (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const db = await PGlite.create({ extensions: { vector, pg_trgm } });
    await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;');
    return db;
  })();
  return pglite;
}
export async function pglitePoolConfig(): Promise<pg.PoolConfig> {
  const { createPgConfig } = await import('@electric-sql/pglite/node-postgres');
  return createPgConfig(await sharedPglite()) as unknown as pg.PoolConfig;
}

const opened: { db: Db; drop?: () => Promise<void> }[] = [];

async function pgOpen(kind: 'pglite' | 'postgres', schema: string, prepare?: boolean): Promise<PostgresDb> {
  return kind === 'pglite'
    ? PostgresDb.connect({ poolConfig: await pglitePoolConfig(), embedded: true, schema, ...(prepare !== undefined ? { prepare } : {}) })
    : PostgresDb.connect({ connectionString: PG_URL, schema, pool: { max: 8 }, ...(prepare !== undefined ? { prepare } : {}) });
}

export const BACKENDS: Backend[] = [
  {
    name: 'sqlite',
    async open() {
      const db = SqliteDb.open(':memory:');
      opened.push({ db });
      return db;
    },
    async sibling() {
      return null;
    },
  },
  {
    name: 'pglite',
    async open(o = {}) {
      const db = await pgOpen('pglite', uniq(), o.prepare);
      opened.push({ db, drop: () => db.exec(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`) });
      return db;
    },
    async sibling() {
      return null;
    },
    poolConfig: undefined,
  },
  ...(hasRealPg
    ? [
        {
          name: 'postgres' as const,
          async open(o: { prepare?: boolean } = {}) {
            const db = await pgOpen('postgres', uniq(), o.prepare);
            opened.push({ db, drop: () => db.exec(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`) });
            return db;
          },
          async sibling(db: Db) {
            const s = await pgOpen('postgres', (db as PostgresDb).schema);
            opened.push({ db: s });
            return s;
          },
          poolConfig: () => ({ connectionString: PG_URL }),
        },
      ]
    : []),
];

/** describe() once per backend. */
export function describeBackends(name: string, fn: (b: Backend) => void): void {
  for (const b of BACKENDS) describe(`${name} [${b.name}]`, () => fn(b));
}

/** Close every database opened through the harness (and drop its schema). Call once per file. */
export function useBackendCleanup(): void {
  // WASM start-up is slow when several files start PGlite at once: warm it up outside the per-test timeout.
  beforeAll(async () => {
    await sharedPglite();
  }, 120_000);
  afterAll(async () => {
    for (const o of opened.splice(0).reverse()) {
      await o.drop?.().catch(() => undefined);
      await o.db.close().catch(() => undefined);
    }
    if (pglite) await (await pglite).close().catch(() => undefined);
    pglite = null;
  });
}
