/** Job claiming (SKIP LOCKED on Postgres) and the per-project write lock, on every backend. */
import { expect, it } from 'vitest';
import { EMBED_JOBS_MIGRATIONS, EmbedJobStore } from '../../src/db/embed-jobs.js';
import { migrate } from '../../src/db/migrate.js';
import type { PostgresDb } from '../../src/db/postgres.js';
import type { Db } from '../../src/db/types.js';
import { ProjectWriteLock, projectWriteLock } from '../../src/db/write-lock.js';
import { describeBackends, useBackendCleanup } from './backends.js';

useBackendCleanup();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeBackends('embed jobs', (b) => {
  const setup = async () => {
    const db = await b.open();
    await migrate(db, 'embed', EMBED_JOBS_MIGRATIONS);
    const s = new EmbedJobStore(db);
    for (let i = 0; i < 40; i++) await s.enqueue('m', `h${String(i).padStart(2, '0')}`, i % 3 === 0 ? 10 : 0, 1000 + i);
    return { db, s };
  };

  it('claims by priority then age; enqueue keeps the higher priority; fail / release / finish / recover', async () => {
    const { s } = await setup();
    await s.enqueue('m', 'h01', 5, 5000); // raises priority 0 → 5, keeps state
    const first = await s.claim('m', 3, 10_000);
    expect(first.map((j) => j.hash)).toEqual(['h00', 'h03', 'h06']);
    await s.fail('m', 'h00', 1, 'pending', 20_000, 'x'.repeat(600), 10_000);
    await s.release('m', ['h03'], 10_000);
    await s.finish('m', ['h06']);
    expect(await s.counts('m')).toEqual({ pending: 39, running: 0, done: 0, failed: 0 });
    expect((await s.claim('m', 14, 10_000)).map((j) => j.hash)).toContain('h01'); // priority 5 after the 10s
    expect(await s.recover('m', 11_000)).toBe(14);
    expect(await s.nextDue('m')).toBeLessThanOrEqual(11_000);
  });

  it('concurrent claimers get disjoint batches', async () => {
    const { db, s } = await setup();
    const sib = await b.sibling(db);
    const stores = [s, new EmbedJobStore(sib ?? db), new EmbedJobStore(db), new EmbedJobStore(sib ?? db)];
    const batches = await Promise.all(stores.map((x) => x.claim('m', 8, 10_000)));
    const all = batches.flat().map((j) => j.hash);
    expect(all).toHaveLength(32);
    expect(new Set(all).size).toBe(32);
    expect((await s.counts('m')).running).toBe(32);
  });

  it.runIf(b.name === 'postgres')('SKIP LOCKED: a claimer never waits on rows another transaction holds', async () => {
    const { db } = await setup();
    const sib = (await b.sibling(db))!;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    // Instance A claims inside a long transaction (rows stay locked until it commits).
    const a = db.tx(async (q) => {
      const got = await new EmbedJobStore(q).claim('m', 5, 10_000);
      await hold;
      return got;
    });
    await sleep(100);
    const t0 = Date.now();
    const bJobs = await new EmbedJobStore(sib).claim('m', 5, 10_000);
    expect(Date.now() - t0).toBeLessThan(1000);
    release();
    const aJobs = await a;
    expect(new Set([...aJobs, ...bJobs].map((j) => j.hash)).size).toBe(10);
  });
});

describeBackends('write lock', (b) => {
  it('serializes writers of one project; other projects proceed', async () => {
    const db = await b.open();
    const sib = (await b.sibling(db)) ?? db;
    const l1 = new ProjectWriteLock(db, 'p');
    const l2 = new ProjectWriteLock(sib, 'p');
    const other = new ProjectWriteLock(sib, 'q');
    const log: string[] = [];
    const work = (l: ProjectWriteLock, name: string, ms: number) =>
      l.run(async () => {
        log.push(`${name}+`);
        await sleep(ms);
        log.push(`${name}-`);
      });
    await Promise.all([work(l1, 'a', 120), (async () => (await sleep(20), work(l2, 'b', 10)))(), (async () => (await sleep(40), work(other, 'q', 10)))()]);
    // b waited for a; q (another project) ran inside a's critical section (PGlite: one session, so it queues too).
    expect(log.indexOf('b+')).toBeGreaterThan(log.indexOf('a-'));
    if (!db.caps.singleSession || db.driver === 'sqlite') expect(log.indexOf('q+')).toBeLessThan(log.indexOf('a-'));
  });

  it('tryWithLock reports a held key; the lock is released when the holder throws', async () => {
    const db = await b.open();
    const sib = (await b.sibling(db)) ?? db;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const holder = db.withLock('k', async () => {
      await hold;
      throw new Error('boom');
    });
    await sleep(50);
    expect((await sib.tryWithLock('k', async () => 1)).acquired).toBe(false);
    release();
    await expect(holder).rejects.toThrow('boom');
    expect(await sib.tryWithLock('k', async () => 2)).toEqual({ acquired: true, value: 2 });
  });

  it.runIf(b.name !== 'sqlite')('advisory locks are transaction-scoped (nothing left on the session; pooler-safe)', async () => {
    const db = (await b.open()) as PostgresDb;
    await db.withLock('xact', async (q) => {
      const n = await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()");
      expect(n!.n).toBeGreaterThan(0);
    });
    const after = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(?, 0)", ['mandate:xact']);
    expect(after!.n).toBe(0);
  });

  it('projectWriteLock is shared only when the database is shared between instances', async () => {
    const db: Db = await b.open();
    const l = projectWriteLock(db, 'p');
    expect(l instanceof ProjectWriteLock).toBe(b.name === 'postgres');
    expect(projectWriteLock(undefined, 'p') instanceof ProjectWriteLock).toBe(false);
    expect(await l.run(async () => 42)).toBe(42);
  });
});
