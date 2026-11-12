/**
 * Migrations per backend: each migration has a SQLite and a Postgres body (SQL text built from the dialect, or a
 * function). Applied ones are recorded in `mandate_migrations` (scope, id) inside the scope's schema; pending migrations run
 * in one transaction together with their records, so a crash never leaves a half-applied step. On Postgres the run
 * holds a transaction-scoped advisory lock per scope, so two instances starting together apply each step once.
 * Re-running is a no-op (idempotent).
 */
import type { Db, Dialect, Queryable } from './types.js';

type Body = string | ((q: Queryable, d: Dialect) => Promise<void>);

export interface Migration {
  /** Strictly increasing within a scope; never renumber a shipped migration. */
  id: number;
  name: string;
  sqlite: (d: Dialect) => Body;
  postgres: (d: Dialect) => Body;
}

export interface MigrationResult {
  applied: number[];
  current: number;
}

export async function migrate(db: Db, scope: string, migrations: Migration[]): Promise<MigrationResult> {
  const ids = migrations.map((m) => m.id);
  if (ids.some((id, i) => i > 0 && id <= ids[i - 1]!)) throw new Error(`migrations of '${scope}': ids must be strictly increasing`);
  const d = db.dialect;
  const table = d.table('mandate_migrations');
  const applied: number[] = [];
  const run = async (q: Queryable) => {
    // Inside the (locked) transaction: concurrent CREATE … IF NOT EXISTS can otherwise collide on Postgres.
    if (db.driver === 'postgres' && d.schema) await q.exec(`CREATE SCHEMA IF NOT EXISTS ${d.q(d.schema)}`);
    await q.exec(`CREATE TABLE IF NOT EXISTS ${table} (scope TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL, applied_at ${d.types.bigint} NOT NULL, PRIMARY KEY (scope, id))`);
    const done = new Set((await q.all<{ id: number }>(`SELECT id FROM ${table} WHERE scope = ?`, [scope])).map((r) => Number(r.id)));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      const body = (db.driver === 'postgres' ? m.postgres : m.sqlite)(d);
      if (typeof body === 'string') await q.exec(body);
      else await body(q, d);
      await q.run(`INSERT INTO ${table} (scope, id, name, applied_at) VALUES (?, ?, ?, ?)`, [scope, m.id, m.name, Date.now()]);
      applied.push(m.id);
    }
  };
  if (db.driver === 'postgres') {
    // One transaction under the scope's advisory lock: concurrent starters serialize, the second sees every step done.
    await db.tx(async (q) => {
      await q.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`mandate:migrate:${d.schema ?? ''}:${scope}`]);
      await run(q);
    });
  } else {
    await db.tx(run);
  }
  return { applied, current: ids.length ? ids[ids.length - 1]! : 0 };
}
