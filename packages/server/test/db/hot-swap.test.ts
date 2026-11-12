/**
 * Settings → Database applies live: switchServerDatabase opens and verifies the new adapter (query + migrations),
 * drains in-flight work, swaps, closes the old one. Failures leave the old adapter in place (no half swap). Runs on
 * SQLite and PGlite (both directions).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteDb } from '../../src/db/sqlite.js';
import { DatabaseSwapError, SwappableDb, unwrapDb } from '../../src/db/swappable.js';
import { ServerState, switchServerDatabase } from '../../src/db/state.js';
import { projectWriteLock } from '../../src/db/write-lock.js';
import type { Db } from '../../src/db/types.js';
import { BACKENDS, useBackendCleanup } from './backends.js';

useBackendCleanup();
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
});

const sqlite = BACKENDS.find((b) => b.name === 'sqlite')!;
const pglite = BACKENDS.find((b) => b.name === 'pglite')!;

async function stateOn(db: Db): Promise<ServerState> {
  const s = await ServerState.open(new SwappableDb(db));
  closers.push(() => s.close());
  return s;
}

const putSession = (s: ServerState, id: string) =>
  s.db.run(`INSERT INTO ${s.t('sessions')} (id, login, name, avatar_url, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, 'ada', null, '', null, 1, Date.now() + 60_000]);
const sessionIds = async (db: Db) => (await db.all<{ id: string }>(`SELECT id FROM ${db.dialect.table('sessions')} ORDER BY id`)).map((r) => r.id);

for (const [from, to] of [
  [sqlite, pglite],
  [pglite, sqlite],
] as const) {
  describe(`hot database switch ${from.name} → ${to.name}`, () => {
    it('in-flight writes finish on the old database, later ones go to the new one; the old one is closed', async () => {
      const oldDb = await from.open();
      const s = await stateOn(oldDb);
      const db = s.db as SwappableDb;
      await putSession(s, 'before');
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      // A write holding a transaction (and issuing a nested query through the switch) while the swap starts.
      const inflight = db.tx(async (q) => {
        await q.run(`INSERT INTO ${s.t('sessions')} (id, login, name, avatar_url, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['inflight', 'ada', null, '', null, 1, Date.now() + 60_000]);
        await held;
        return (await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${s.t("sessions")}`))!.n;
      });
      let newDb: Db | undefined;
      const swapping = switchServerDatabase(s, async () => (newDb = await to.open()));
      await new Promise((r) => setTimeout(r, 50));
      // New writes wait for the swap (blocked briefly), then land in the new database.
      const later = putSession(s, 'later');
      await new Promise((r) => setTimeout(r, 20));
      expect(unwrapDb(db)).toBe(oldDb);
      release();
      expect(Number(await inflight)).toBeGreaterThanOrEqual(2);
      await swapping;
      // A write that waited for the swap ran its SQL nowhere: built for the old dialect, it is refused (retry).
      await expect(later).rejects.toThrow(/switched from .* while this request waited/);
      await putSession(s, 'later');
      expect(unwrapDb(db)).toBe(newDb);
      expect(db.driver).toBe(to.name === 'sqlite' ? 'sqlite' : 'postgres');
      expect(await sessionIds(db)).toEqual(['later']); // server state is not copied
      // The old database got the in-flight write and was closed afterwards.
      await expect(oldDb.get('SELECT 1')).rejects.toThrow();
    });

    it('a failing open or migration keeps the old database (no half swap)', async () => {
      const oldDb = await from.open();
      const s = await stateOn(oldDb);
      await putSession(s, 'kept');
      await expect(switchServerDatabase(s, async () => Promise.reject(new Error('cannot connect to Postgres (postgres://***@db/x)')))).rejects.toThrow(/cannot connect/);
      expect(unwrapDb(s.db)).toBe(oldDb);
      // Opens, but the migration fails: the new adapter is closed, the old one stays.
      const bad = await to.open();
      let closed = false;
      const badDb: Db = Object.assign(Object.create(bad) as Db, {
        exec: async () => {
          throw new Error('permission denied for schema');
        },
        tx: async () => {
          throw new Error('permission denied for schema');
        },
        close: async () => void (closed = true),
      });
      await expect(switchServerDatabase(s, async () => badDb)).rejects.toThrow(/permission denied/);
      expect(closed).toBe(true);
      expect(unwrapDb(s.db)).toBe(oldDb);
      expect(await sessionIds(s.db)).toEqual(['kept']);
      await putSession(s, 'still-works');
    });
  });
}

describe('SwappableDb', () => {
  it('gives up when in-flight work does not drain, leaving the old adapter', async () => {
    const a = SqliteDb.open(':memory:');
    const b = SqliteDb.open(':memory:');
    closers.push(() => a.close(), () => b.close());
    const db = new SwappableDb(a);
    let release!: () => void;
    const held = db.withLock('k', () => new Promise<void>((r) => (release = r)));
    await expect(db.swap(b, 50)).rejects.toBeInstanceOf(DatabaseSwapError);
    expect(db.current).toBe(a);
    release();
    await held;
    expect(await db.get<{ x: number }>('SELECT 1 AS x')).toEqual({ x: 1 });
    expect(await db.swap(b)).toBe(a);
    expect(db.current).toBe(b);
  });

  it('work inside a held lock never waits for a pending swap (no deadlock)', async () => {
    const a = SqliteDb.open(':memory:');
    const b = SqliteDb.open(':memory:');
    closers.push(() => a.close(), () => b.close());
    const db = new SwappableDb(a);
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let go!: () => void;
    const proceed = new Promise<void>((r) => (go = r));
    const held = db.withLock('k', async () => {
      entered();
      await proceed;
      return db.get<{ x: number }>('SELECT 2 AS x'); // still on a, not blocked by the pending swap's gate
    });
    await inside;
    const swap = db.swap(b, 5_000); // waits for the lock holder to finish
    await new Promise((res) => setTimeout(res, 10));
    go();
    expect(await held).toEqual({ x: 2 });
    expect(await swap).toBe(a);
    await expect(db.swap(a, 10)).resolves.toBe(b);
  });

  it('the project write lock follows the database: the current adapter takes the lock', async () => {
    const a = SqliteDb.open(':memory:');
    const b = SqliteDb.open(':memory:');
    closers.push(() => a.close(), () => b.close());
    const db = new SwappableDb(a);
    const lock = projectWriteLock(db, 'p');
    const used: string[] = [];
    for (const [name, d] of [['a', a], ['b', b]] as const) {
      const orig = d.withLock.bind(d);
      d.withLock = (k, fn) => (used.push(name), orig(k, fn));
    }
    expect(await lock.run(async () => 1)).toBe(1);
    await db.swap(b);
    expect(await lock.run(async () => 2)).toBe(2);
    expect(used).toEqual(['a', 'b']);
  });
});
