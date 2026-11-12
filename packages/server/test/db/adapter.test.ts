/** The database adapter contract, on every backend: params, types, transactions, upsert / RETURNING, migrations, scopes. */
import { describe, expect, it } from 'vitest';
import { migrate, type Migration } from '../../src/db/migrate.js';
import { toDollarParams } from '../../src/db/sql.js';
import { describeBackends, useBackendCleanup } from './backends.js';

useBackendCleanup();

describe('portable placeholders', () => {
  it('rewrites ? to $n outside literals, identifiers, comments and dollar quotes', () => {
    expect(toDollarParams("SELECT ? , '?' , \"a?\" -- ?\n, ? /* ? */ , $$ ? $$, $t$?$t$, ??")).toBe("SELECT $1 , '?' , \"a?\" -- ?\n, $2 /* ? */ , $$ ? $$, $t$?$t$, ?");
    expect(toDollarParams("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
  });
});

const MIGS: Migration[] = [
  { id: 1, name: 'items', sqlite: (d) => `CREATE TABLE ${d.table('items')} (id TEXT PRIMARY KEY, n ${d.types.bigint} NOT NULL, flag ${d.types.bool} NOT NULL DEFAULT 0, data ${d.types.blob}, note TEXT)`, postgres: (d) => `CREATE TABLE ${d.table('items')} (id TEXT PRIMARY KEY, n ${d.types.bigint} NOT NULL, flag ${d.types.bool} NOT NULL DEFAULT 0, data ${d.types.blob}, note TEXT)` },
  { id: 2, name: 'items index', sqlite: (d) => `CREATE INDEX ${d.index('items_n')} ON ${d.table('items')} (n)`, postgres: (d) => async (q) => q.exec(`CREATE INDEX ${d.index('items_n')} ON ${d.table('items')} (n)`) },
];

describeBackends('adapter', (b) => {
  it('migrates once (idempotent) and records the steps', async () => {
    const db = await b.open();
    expect((await migrate(db, 'test', MIGS)).applied).toEqual([1, 2]);
    expect((await migrate(db, 'test', MIGS)).applied).toEqual([]);
    expect((await migrate(db, 'test', [...MIGS, { id: 3, name: 'col', sqlite: (d) => `ALTER TABLE ${d.table('items')} ADD COLUMN extra TEXT`, postgres: (d) => `ALTER TABLE ${d.table('items')} ADD COLUMN extra TEXT` }])).applied).toEqual([3]);
    const rows = await db.all<{ id: number }>(`SELECT id FROM ${db.dialect.table('mandate_migrations')} WHERE scope = ? ORDER BY id`, ['test']);
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);
    await expect(migrate(db, 'bad', [MIGS[1]!, MIGS[0]!])).rejects.toThrow(/strictly increasing/);
  });

  it('round-trips numbers, epoch ms, booleans, blobs, NULL and literal question marks', async () => {
    const db = await b.open();
    await migrate(db, 'test', MIGS);
    const t = db.dialect.table('items');
    const ms = 1_762_000_000_123;
    await db.run(`INSERT INTO ${t} (id, n, flag, data, note) VALUES (?, ?, ?, ?, '?literal?')`, ['a', ms, true, Buffer.from([0, 1, 255])]);
    await db.run(`INSERT INTO ${t} (id, n, flag, data, note) VALUES (?, ?, ?, ?, ?)`, ['b', 2, false, new Uint8Array([9]), null]);
    const a = await db.get<{ n: number; flag: number; data: Buffer; note: string }>(`SELECT n, flag, data, note FROM ${t} WHERE id = ?`, ['a']);
    expect(a).toMatchObject({ n: ms, note: '?literal?' });
    expect(Number(a!.flag)).toBe(1);
    expect([...a!.data]).toEqual([0, 1, 255]);
    const c = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE flag = ?`, [false]);
    expect(c!.c).toBe(1);
    expect(await db.get(`SELECT * FROM ${t} WHERE id = ?`, ['none'])).toBeUndefined();
  });

  it('upserts, ignores duplicates and returns rows from UPDATE / DELETE … RETURNING', async () => {
    const db = await b.open();
    await migrate(db, 'test', MIGS);
    const d = db.dialect;
    const up = d.upsert('items', ['id', 'n'], ['id'], { n: d.greatest('cur.n', 'excluded.n') });
    await db.run(up, ['x', 5]);
    await db.run(up, ['x', 3]);
    await db.run(up, ['x', 9]);
    expect((await db.get<{ n: number }>(`SELECT n FROM ${d.table('items')} WHERE id = 'x'`))!.n).toBe(9);
    expect((await db.run(d.insertIgnore('items', ['id', 'n']), ['x', 1])).changes).toBe(0);
    const r = await db.all<{ id: string; n: number }>(`UPDATE ${d.table('items')} SET n = n + 1 WHERE id = ? RETURNING id, n`, ['x']);
    expect(r).toEqual([{ id: 'x', n: 10 }]);
    expect(await db.get<{ id: string }>(`DELETE FROM ${d.table('items')} WHERE id = ? RETURNING id`, ['x'])).toEqual({ id: 'x' });
    expect(await db.get<{ id: string }>(`DELETE FROM ${d.table('items')} WHERE id = ? RETURNING id`, ['x'])).toBeUndefined();
  });

  it('commits and rolls back transactions; other callers wait for a running transaction', async () => {
    const db = await b.open();
    await migrate(db, 'test', MIGS);
    const t = db.dialect.table('items');
    await db.tx(async (q) => {
      await q.run(`INSERT INTO ${t} (id, n) VALUES ('t1', 1)`);
    });
    await expect(
      db.tx(async (q) => {
        await q.run(`INSERT INTO ${t} (id, n) VALUES ('t2', 1)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.all(`SELECT id FROM ${t} ORDER BY id`)).map((r) => (r as { id: string }).id)).toEqual(['t1']);
    // Interleaving: a plain write issued while a transaction is open never lands inside it (it survives the rollback).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const tx = db
      .tx(async (q) => {
        await q.run(`INSERT INTO ${t} (id, n) VALUES ('t3', 1)`);
        await held;
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const outside = db.run(`INSERT INTO ${t} (id, n) VALUES ('t4', 1)`);
    release();
    await tx;
    await outside;
    expect((await db.all(`SELECT id FROM ${t} ORDER BY id`)).map((r) => (r as { id: string }).id)).toEqual(['t1', 't4']);
  });

  it('read-only transactions refuse writes', async () => {
    const db = await b.open();
    await migrate(db, 'test', MIGS);
    const t = db.dialect.table('items');
    await expect(db.tx((q) => q.run(`INSERT INTO ${t} (id, n) VALUES ('ro', 1)`), { readOnly: true })).rejects.toThrow(/read-only|readonly|query_only|attempt to write/i);
    expect(await db.tx((q) => q.all(`SELECT * FROM ${t}`), { readOnly: true, statementTimeoutMs: 2000 })).toEqual([]);
    // The connection is writable again afterwards.
    await db.run(`INSERT INTO ${t} (id, n) VALUES ('rw', 1)`);
  });

  it('scopes isolate tables (schema per project / prefix)', async () => {
    const db = await b.open();
    const a = db.scoped(db.driver === 'postgres' ? `${(db as unknown as { schema: string }).schema}_a` : 'a');
    await migrate(a, 'test', MIGS);
    await migrate(db, 'test', MIGS);
    await a.run(`INSERT INTO ${a.dialect.table('items')} (id, n) VALUES ('only-a', 1)`);
    expect(await db.all(`SELECT id FROM ${db.dialect.table('items')}`)).toEqual([]);
    expect(await a.all(`SELECT id FROM ${a.dialect.table('items')}`)).toEqual([{ id: 'only-a' }]);
    if (db.driver === 'postgres') await db.exec(`DROP SCHEMA ${a.dialect.q(a.dialect.schema!)} CASCADE`);
  });

  it('works with named prepared statements off (transaction-mode poolers)', async () => {
    const db = await b.open({ prepare: false });
    await migrate(db, 'test', MIGS);
    await db.run(`INSERT INTO ${db.dialect.table('items')} (id, n) VALUES (?, ?)`, ['p', 1]);
    expect(await db.get(`SELECT id FROM ${db.dialect.table('items')} WHERE n = ?`, [1])).toEqual({ id: 'p' });
  });
});
