/** Postgres specifics: config validation, URL / TLS / pooler handling, Supabase-style extension schemas, the probe. */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseConfigSchema, poolerOf, redactUrl, resolveDatabase } from '../../src/db/config.js';
import { parseSslFromUrl, PostgresDb, sslConfig } from '../../src/db/postgres.js';
import { probePostgres } from '../../src/db/probe.js';
import { BACKENDS, hasRealPg, pglitePoolConfig, useBackendCleanup } from './backends.js';

useBackendCleanup();

describe('database config', () => {
  it('defaults to SQLite and validates strictly', () => {
    expect(databaseConfigSchema.parse({})).toMatchObject({ driver: 'sqlite', urlEnv: 'MANDATE_DATABASE_URL', schemaPerProject: true });
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', url: 'postgres://u:p@h/db' }).error?.issues[0]?.message).toMatch(/never put the database URL in config.json/);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', password: 'x' }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'mysql' }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', urlEnv: 'not-an-env' }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', path: 'x.sqlite' }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', sslRootCertPath: 'ca.pem' }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', schemaPerProject: 'prefix', pool: { max: 0 } }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ driver: 'postgres', unknown: 1 }).success).toBe(false);
  });

  it('resolves the URL from the named env var only; transaction poolers turn prepared statements off', () => {
    const cfg = databaseConfigSchema.parse({ driver: 'postgres', urlEnv: 'DB_URL' });
    const direct = resolveDatabase(cfg, { DB_URL: 'postgresql://postgres:pw@db.abc.supabase.co:5432/postgres?sslmode=require' }, '/h');
    expect(direct).toMatchObject({ driver: 'postgres', pooler: 'none', prepare: true });
    const pooled = resolveDatabase(cfg, { DB_URL: 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres' }, '/h');
    expect(pooled).toMatchObject({ pooler: 'transaction', prepare: false });
    expect(resolveDatabase({ ...cfg, prepare: true }, { DB_URL: 'postgresql://h:6543/x' }, '/h')).toMatchObject({ prepare: true });
    expect(resolveDatabase(cfg, {}, '/h')).toMatchObject({ url: undefined });
    expect(resolveDatabase(databaseConfigSchema.parse({}), {}, '/h')).toEqual({ driver: 'sqlite', path: '/h/state.sqlite' });
  });

  it('detects poolers, redacts passwords, maps sslmode like libpq', () => {
    expect(poolerOf('postgresql://u@aws-0-x.pooler.supabase.com:5432/db')).toBe('session');
    expect(poolerOf('postgresql://u@host/db?pgbouncer=true')).toBe('transaction');
    expect(poolerOf('postgresql://u@host:5432/db')).toBe('none');
    expect(redactUrl('postgresql://user:s3cret@host:5432/db?password=x')).not.toMatch(/s3cret|=x\b/);
    expect(redactUrl('postgresql://user:s3cret@host:5432/db')).toBe('postgresql://user:***@host:5432/db');
    expect(parseSslFromUrl('postgresql://u:p@h/db?sslmode=require&application_name=a')).toEqual({ url: 'postgresql://u:p@h/db?application_name=a', ssl: 'require' });
    expect(parseSslFromUrl('postgresql://u:p@h/db?sslmode=verify-full').ssl).toBe('verify-full');
    expect(sslConfig('require')).toEqual({ rejectUnauthorized: false });
    expect(sslConfig('verify-full', 'PEM')).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    expect(sslConfig('disable')).toBe(false);
  });
});

const pgBackends = BACKENDS.filter((b) => b.name !== 'sqlite');
for (const b of pgBackends) {
  describe(`postgres specifics [${b.name}]`, () => {
    it('no session state leaks: SET LOCAL timeouts end with the transaction; search_path is never needed', async () => {
      const db = (await b.open()) as PostgresDb;
      const before = (await db.get<{ statement_timeout: string }>('SHOW statement_timeout'))!.statement_timeout;
      expect(await db.tx(async (q) => (await q.get<{ statement_timeout: string }>('SHOW statement_timeout'))!.statement_timeout, { statementTimeoutMs: 2000 })).toBe('2s');
      expect((await db.get<{ statement_timeout: string }>('SHOW statement_timeout'))!.statement_timeout).toBe(before);
      expect((await db.get<{ search_path: string }>('SHOW search_path'))!.search_path).not.toContain(db.schema);
    });

    it.runIf(b.name === 'pglite')('extensions in an `extensions` schema (Supabase): detected and schema-qualified', async () => {
      const db = (await b.open()) as PostgresDb;
      expect(db.extensions).toMatchObject({ vector: 'extensions', pg_trgm: 'extensions' });
      expect(db.caps).toMatchObject({ vector: true, trigram: true });
      const d = db.dialect;
      expect(d.ext('vector')).toBe('"extensions".vector');
      await db.exec(`CREATE SCHEMA ${d.q(db.schema)}`);
      await db.exec(`CREATE TABLE ${d.table('v')} (id TEXT PRIMARY KEY, e ${d.ext('vector')}(3))`);
      await db.run(`INSERT INTO ${d.table('v')} VALUES ('a', ?), ('b', ?)`, ['[1,0,0]', '[0,1,0]']);
      const r = await db.all<{ id: string }>(`SELECT id FROM ${d.table('v')} ORDER BY e ${d.extOp('<=>')} ?::${d.ext('vector')} LIMIT 1`, ['[0.9,0.1,0]']);
      expect(r).toEqual([{ id: 'a' }]);
      const s = await db.get<{ s: number }>(`SELECT ${d.ext('similarity')}(?, ?) AS s`, ['mandate', 'mandat']);
      expect(s!.s).toBeGreaterThan(0.5);
      expect(await db.ensureExtensions(['vector', 'pg_trgm'])).toEqual([]);
    });

    it('Test connection reports version, extensions and pooler', async () => {
      const cfg = b.name === 'pglite' ? await pglitePoolConfig() : b.poolConfig!();
      const r = await probePostgres({ url: b.name === 'pglite' ? 'postgresql://postgres:secret@localhost:5432/postgres' : process.env.MANDATE_TEST_PG_URL!, client: () => new pg.Client(cfg) });
      expect(r.target).not.toContain('secret');
      expect(r.versionNum).toBeGreaterThanOrEqual(140000);
      expect(r.canCreateSchema).toBe(true);
      if (b.name === 'pglite') {
        expect(r).toMatchObject({ ok: true, extensions: { vector: { installed: true, schema: 'extensions' }, pg_trgm: { installed: true, schema: 'extensions' } } });
      } else {
        for (const [name, e] of Object.entries(r.extensions)) if (!e.installed) expect(r.errors.join('\n')).toMatch(name === 'vector' ? /pgvector/ : /pg_trgm/);
      }
    });
  });
}

describe.runIf(hasRealPg)('postgres specifics [postgres, CREATE EXTENSION]', () => {
  it('creates a missing extension in the configured extensions schema and qualifies it', async () => {
    const url = process.env.MANDATE_TEST_PG_URL!;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const had = (await admin.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).rowCount;
    if (had) return void (await admin.end());
    await admin.query('CREATE SCHEMA IF NOT EXISTS t_extensions');
    try {
      const db = await PostgresDb.connect({ connectionString: url, schema: 't_ext_scope', extensionsSchema: 't_extensions' });
      expect(await db.ensureExtensions(['pg_trgm'])).toEqual([]);
      expect(db.extensions.pg_trgm).toBe('t_extensions');
      expect(db.dialect.ext('similarity')).toBe('"t_extensions".similarity');
      expect((await db.get<{ s: number }>(`SELECT ${db.dialect.ext('similarity')}(?, ?) AS s`, ['abc', 'abd']))!.s).toBeGreaterThan(0);
      await db.close();
    } finally {
      await admin.query('DROP EXTENSION IF EXISTS pg_trgm; DROP SCHEMA IF EXISTS t_extensions CASCADE');
      await admin.end();
    }
  });
});
