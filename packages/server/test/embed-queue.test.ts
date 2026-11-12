/** The SQLite embedding job queue: outbox writes, worker (claim, backoff, failed, outage pause, recovery), priority, backfill. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSpecSchema } from '@mandate/shared';
import { openIndexDb, type DB } from '../src/index/db.js';
import { FakeProvider, type EmbeddingProvider } from '../src/index/embed/index.js';
import { enqueueHashes, outstanding, PRIORITY, retryFailed, vecId } from '../src/index/embed/jobs.js';
import { EmbedQueue, float32 } from '../src/index/embed/queue.js';
import { EmbeddingError } from '../src/index/embed/types.js';
import { IndexService, watchCommits } from '../src/index/service.js';
import { callTool, type ToolContext } from '../src/mcp/define.js';
import { TOOLS } from '../src/mcp/index.js';
import { createStorage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const embedding = {
  provider: 'openai-compatible' as const,
  baseUrl: 'http://localhost:1/v1',
  model: 'fake',
  apiKeyEnv: null,
  dimensions: 16,
  maxInputTokens: 2048,
  batchSize: 16,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};
const indexCfg = (file: string) => ({ path: file, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 });
const spec = (title: string, body: string) => createSpecSchema.parse({ title, sections: [{ id: 'overview', title: 'Overview', body, summary: 'What it is.' }] });

/** FakeProvider whose calls wait for `open()` (to observe the queue before the worker finishes). */
class GatedProvider extends FakeProvider {
  private gate!: Promise<void>;
  private release!: () => void;
  constructor(dims = 16, id = `gated:${dims}`) {
    super(dims, id);
    this.close();
  }
  close() {
    this.gate = new Promise((r) => (this.release = r));
  }
  open() {
    this.release();
  }
  override async embed(texts: string[]) {
    await this.gate;
    return super.embed(texts);
  }
}

/** Fails the texts containing `poison` (or everything while `down`), records every input. */
class ScriptedProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  readonly inputs: string[][] = [];
  down: Error | null = null;
  private readonly fake = new FakeProvider(8);
  constructor(
    readonly modelId = 'scripted:8',
    private readonly poison = 'POISON',
  ) {}
  async embed(texts: string[]) {
    this.inputs.push(texts);
    if (this.down) throw this.down;
    if (texts.some((t) => t.includes(this.poison))) throw new EmbeddingError('embeddings request failed: HTTP 400 input rejected', false);
    return this.fake.embed(texts);
  }
}

const addChunk = (db: DB, hash: string, text: string, uri = `mandate://specs/s-${hash}/sections/overview`) =>
  db
    .prepare("INSERT INTO chunks (uri, doc_uri, chunk_index, kind, line_start, line_end, content_hash, text, prefix, source) VALUES (?, ?, 0, 'section', 1, 2, ?, ?, 'Spec > Overview', ?)")
    .run(uri, uri.replace(/\/sections\/.*/, ''), hash, text, `specs/s-${hash}.md`);
const jobs = (db: DB) => db.prepare('SELECT content_hash AS hash, model_id AS model, status, attempts, priority, next_attempt_at AS next, last_error AS err FROM embed_jobs ORDER BY content_hash').all() as {
  hash: string;
  model: string;
  status: string;
  attempts: number;
  priority: number;
  next: number;
  err: string | null;
}[];
const hasVec = (q: EmbedQueue, db: DB, hash: string) => !!db.prepare(`SELECT 1 FROM ${q.table} WHERE id = ?`).get(vecId(q.target.modelId, hash));

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('embedding queue (unit)', () => {
  it('a cached vector skips the job and is copied into vec0', () => {
    const db = openIndexDb(':memory:');
    const p = new FakeProvider(8, 'fake:8');
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 });
    addChunk(db, 'h1', 'cached text');
    addChunk(db, 'h2', 'new text');
    db.prepare('INSERT INTO embedding_cache (content_hash, model_id, dims, vector) VALUES (?, ?, ?, ?)').run('h1', 'fake:8', 8, float32(new Float32Array(8).fill(0.5)));
    const r = enqueueHashes(db, q.target, ['h1', 'h2'], PRIORITY.write);
    expect(r).toEqual({ enqueued: 1, cached: 1 });
    expect(jobs(db).map((j) => j.hash)).toEqual(['h2']);
    expect(hasVec(q, db, 'h1')).toBe(true);
    expect(q.pending()).toBe(1);
    db.close();
  });

  it('claims by priority, then enqueue order', async () => {
    const db = openIndexDb(':memory:');
    const c = clock();
    const p = new ScriptedProvider();
    const q = new EmbedQueue(db, p, { batchSize: 1, documentPrefix: '', maxInputTokens: 512, now: c.now });
    for (const [h, prio] of [['a', PRIORITY.backfill], ['b', PRIORITY.write], ['c', PRIORITY.backfill], ['d', PRIORITY.sync]] as const) {
      addChunk(db, h, `text ${h}`);
      enqueueHashes(db, q.target, [h], prio, c.t++);
    }
    q.kick();
    await q.idle();
    expect(p.inputs.map((i) => i[0]!.match(/text (\w)/)![1])).toEqual(['b', 'd', 'a', 'c']);
    expect(jobs(db)).toEqual([]);
    for (const h of 'abcd') expect(hasVec(q, db, h)).toBe(true);
    db.close();
  });

  it('a failing text gets attempts+1 with jittered exponential backoff, failed after maxAttempts; retry re-arms it', async () => {
    const db = openIndexDb(':memory:');
    const c = clock();
    const p = new ScriptedProvider();
    const errors: string[] = [];
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512, maxAttempts: 3, backoffBaseMs: 1000, now: c.now, random: () => 0.5, onError: (e) => errors.push(e.message) });
    addChunk(db, 'ok', 'fine text');
    addChunk(db, 'bad', 'POISON text');
    enqueueHashes(db, q.target, ['ok', 'bad'], 0, c.t);
    q.kick();
    await q.idle();
    // The batch failed, so each text was retried alone: only the poisoned one is charged.
    expect(hasVec(q, db, 'ok')).toBe(true);
    let [j] = jobs(db);
    expect(j).toMatchObject({ hash: 'bad', status: 'pending', attempts: 1, next: c.t + 1000 });
    expect(j!.err).toMatch(/HTTP 400/);
    // Not due yet: nothing happens.
    q.kick();
    await q.idle();
    expect(jobs(db)[0]!.attempts).toBe(1);
    c.t += 1000;
    q.kick();
    await q.idle();
    [j] = jobs(db);
    expect(j).toMatchObject({ status: 'pending', attempts: 2, next: c.t + 2000 });
    c.t += 2000;
    q.kick();
    await q.idle();
    expect(jobs(db)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(q.pending()).toBe(0);
    const st = q.status();
    expect(st.counts).toMatchObject({ pending: 0, running: 0, failed: 1 });
    expect(st.failedExamples).toEqual([expect.objectContaining({ contentHash: 'bad', attempts: 3, refs: [{ uri: 'mandate://specs/s-bad/sections/overview', docUri: 'mandate://specs/s-bad' }] })]);
    expect(JSON.stringify(st)).not.toContain('POISON text');
    // Jitter: random() in [0, 1) scales the delay by 0.5..1.5.
    const q2 = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512, maxAttempts: 3, backoffBaseMs: 1000, now: c.now, random: () => 0 });
    expect(retryFailed(db, q2.target.modelId, ['bad'], c.t)).toBe(1);
    expect(jobs(db)[0]).toMatchObject({ status: 'pending', attempts: 0 });
    q2.kick();
    await q2.idle();
    expect(jobs(db)[0]).toMatchObject({ attempts: 1, next: c.t + 500 });
    db.close();
  });

  it('a provider outage pauses the worker without charging attempts', async () => {
    const db = openIndexDb(':memory:');
    const c = clock();
    const p = new ScriptedProvider();
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512, maxAttempts: 2, now: c.now });
    for (const h of ['x', 'y']) addChunk(db, h, `text ${h}`);
    enqueueHashes(db, q.target, ['x', 'y'], 0, c.t);
    p.down = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });
    for (let i = 0; i < 4; i++) {
      q.kick();
      await q.idle();
    }
    expect(jobs(db).map((j) => [j.status, j.attempts])).toEqual([['pending', 0], ['pending', 0]]);
    expect(q.status().pausedUntil).not.toBeNull();
    expect(q.lastError).toMatch(/fetch failed/);
    // A provider-wide EmbeddingError (rate limit / gateway after retries, bad key) pauses too.
    p.down = new EmbeddingError('embeddings unavailable at http://x: HTTP 503', true, true);
    q.kick();
    await q.idle();
    expect(jobs(db).every((j) => j.attempts === 0 && j.status === 'pending')).toBe(true);
    p.down = null;
    q.kick();
    await q.idle();
    expect(jobs(db)).toEqual([]);
    expect(q.status().pausedUntil).toBeNull();
    q.stop();
    db.close();
  });

  it('re-pends jobs left running by a crash', () => {
    const db = openIndexDb(':memory:');
    const p = new FakeProvider(8, 'fake:8');
    new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 }).stop();
    addChunk(db, 'r', 'running text');
    db.prepare("INSERT INTO embed_jobs (content_hash, model_id, status, attempts, next_attempt_at, enqueued_at, updated_at, priority) VALUES ('r', 'fake:8', 'running', 2, 0, 0, 0, 0)").run();
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 });
    expect(jobs(db)).toEqual([expect.objectContaining({ hash: 'r', status: 'pending', attempts: 2 })]);
    q.stop();
    db.close();
  });

  it('backfills jobs from existing chunks on the first start after the migration, and on a model switch', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'old.sqlite');
    // An index from before the job table: chunks, one cached vector, no embed_jobs / queue state.
    let db = openIndexDb(file);
    for (const h of ['m1', 'm2', 'm3']) addChunk(db, h, `text ${h}`);
    addChunk(db, 'm1', 'text m1', 'mandate://specs/other/sections/overview'); // same text twice: one job
    db.prepare('INSERT INTO embedding_cache (content_hash, model_id, dims, vector) VALUES (?, ?, ?, ?)').run('m3', 'fake:8', 8, float32(new Float32Array(8).fill(0.1)));
    db.exec('DROP TABLE embed_jobs; DELETE FROM embed_queue_state;');
    db.close();

    db = openIndexDb(file);
    const p = new FakeProvider(8, 'fake:8');
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 });
    expect(jobs(db).map((j) => [j.hash, j.status, j.priority])).toEqual([['m1', 'pending', 0], ['m2', 'pending', 0]]);
    expect(hasVec(q, db, 'm3')).toBe(true);
    q.kick();
    await q.idle();
    expect(p.embedded).toBe(2);
    expect(jobs(db)).toEqual([]);
    // Restart with the same model: nothing to backfill.
    new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 }).stop();
    expect(jobs(db)).toEqual([]);
    // New model: every text is enqueued for it (no vector of the old model is reused) and old-model jobs are dropped.
    db.prepare("INSERT INTO embed_jobs (content_hash, model_id, status, enqueued_at, updated_at) VALUES ('m2', 'fake:8', 'failed', 0, 0)").run();
    const p2 = new FakeProvider(8, 'fake:8:v2');
    const q2 = new EmbedQueue(db, p2, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 });
    expect(jobs(db).map((j) => `${j.hash}@${j.model}`)).toEqual(['m1@fake:8:v2', 'm2@fake:8:v2', 'm3@fake:8:v2']);
    q2.kick();
    await q2.idle();
    expect(p2.embedded).toBe(3);
    db.close();
  });

  it('pending() is an index lookup, not a scan of chunks or jobs', () => {
    const db = openIndexDb(':memory:');
    const p = new FakeProvider(8, 'fake:8');
    const q = new EmbedQueue(db, p, { batchSize: 8, documentPrefix: '', maxInputTokens: 512 });
    const ins = db.prepare("INSERT INTO embed_jobs (content_hash, model_id, status, enqueued_at, updated_at) VALUES (?, ?, ?, 0, 0)");
    db.transaction(() => {
      for (let i = 0; i < 100_000; i++) ins.run(`h${i}`, i % 2 ? 'fake:8' : 'other:8', i % 10 === 0 ? 'pending' : 'failed');
    })();
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ');
    const count = plan("SELECT COUNT(*) AS n FROM embed_jobs WHERE model_id = ? AND status IN ('pending', 'running')", 'fake:8');
    expect(count).toMatch(/USING (COVERING )?INDEX embed_jobs_(due|order)/);
    expect(count).not.toMatch(/SCAN|chunks/);
    const claim = plan("SELECT rowid FROM embed_jobs WHERE model_id = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY priority DESC, enqueued_at ASC LIMIT 8", 'fake:8', 0);
    expect(claim).toMatch(/USING (COVERING )?INDEX embed_jobs_/);
    expect(claim).not.toMatch(/^SCAN embed_jobs$/);
    const t = performance.now();
    for (let i = 0; i < 50; i++) q.pending();
    expect(q.pending()).toBe(0); // the model's jobs are all failed (odd i, i % 10 never 0)
    expect((performance.now() - t) / 50).toBeLessThan(20);
    db.close();
  });
});

describe('embedding outbox (indexer)', () => {
  it('enqueues jobs in the chunk-write transaction, drops jobs of vanished texts, ranks fresh writes first', async () => {
    const dir = await tempDir();
    const git = await newStore(dir);
    const storage = createStorage(git);
    await storage.specs.create(spec('Ledger', 'Entries are double booked.'));
    const provider = new GatedProvider(16);
    const index = new IndexService({ git, storage, index: indexCfg(path.join(dir, '..', `${path.basename(dir)}-q.sqlite`)), embedding, provider });
    watchCommits(git, (why) => index.schedule(why));
    const db = index.db;
    const chunkHashes = () => new Set((db.prepare('SELECT DISTINCT content_hash AS h FROM chunks').all() as { h: string }[]).map((r) => r.h));
    await index.start();
    // Every chunk text has a job (the worker is blocked on the provider), at backfill priority for the initial sync.
    expect(new Set(jobs(db).map((j) => j.hash))).toEqual(chunkHashes());
    expect(jobs(db).every((j) => j.priority === PRIORITY.backfill)).toBe(true);
    expect((await index.search({ q: 'double booked', mode: 'text' })).semantic.pending).toBe(chunkHashes().size);

    // Same transaction: a failing job insert rolls the chunk writes back.
    db.exec("CREATE TEMP TRIGGER no_jobs BEFORE INSERT ON embed_jobs BEGIN SELECT RAISE(ABORT, 'outbox down'); END");
    await storage.specs.create(spec('Audit', 'Auditors read the trail.'));
    await expect(index.sync()).rejects.toThrow(/outbox down/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_uri = 'mandate://specs/audit'").get() as { n: number }).n).toBe(0);
    db.exec('DROP TRIGGER no_jobs');

    // A write through this server: its new texts get write priority; the replaced text's job disappears.
    const before = new Set(jobs(db).map((j) => j.hash));
    const ledgerOld = new Set((db.prepare("SELECT content_hash AS h FROM chunks WHERE doc_uri = 'mandate://specs/ledger'").all() as { h: string }[]).map((r) => r.h));
    await storage.specs.update('ledger', { sections: [{ id: 'overview', title: 'Overview', body: 'Entries are booked once, then reconciled.', summary: 'What it is.' }] as never });
    await new Promise((r) => setTimeout(r, 80));
    await index.ensureFresh();
    const now = jobs(db);
    expect(new Set(now.map((j) => j.hash))).toEqual(chunkHashes());
    const added = now.filter((j) => !before.has(j.hash));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((j) => j.priority === PRIORITY.write)).toBe(true);
    const gone = [...ledgerOld].filter((h) => !chunkHashes().has(h));
    expect(gone.length).toBeGreaterThan(0);
    for (const h of gone) expect(now.find((j) => j.hash === h)).toBeUndefined();
    // Deleting a doc (specs are archive-only through storage: remove the file with git) drops its jobs (no orphans).
    const auditHashes = (db.prepare("SELECT DISTINCT content_hash AS h FROM chunks WHERE doc_uri = 'mandate://specs/audit'").all() as { h: string }[]).map((r) => r.h);
    expect(auditHashes.length).toBeGreaterThan(0);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'rm', '-q', 'specs/audit.md']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'drop audit']);
    await index.ensureFresh();
    expect(chunkHashes().has(auditHashes[0]!)).toBe(false);
    for (const h of auditHashes) expect(jobs(db).find((j) => j.hash === h)).toBeUndefined();
    expect(new Set(jobs(db).map((j) => j.hash))).toEqual(chunkHashes());

    provider.open();
    await index.idle();
    const st = await index.status();
    expect(st.embedding.pending).toBe(0);
    expect(st.embedding.queue).toMatchObject({ counts: { pending: 0, running: 0, failed: 0 }, oldestPendingAgeMs: null, failedExamples: [] });
    expect(outstanding(db, provider.modelId)).toBe(0);
    expect(index.embeddingJobs().items).toEqual([]);
    expect(index.retryEmbeddingJobs()).toEqual({ retried: 0 });
    index.close();
  });
});

describe('embedding job tools', () => {
  it('embedding_jobs_retry is ops and refused for the web UI session', async () => {
    const def = TOOLS.find((t) => t.name === 'embedding_jobs_retry')!;
    expect(def.kind).toBe('ops');
    expect(TOOLS.find((t) => t.name === 'embedding_jobs')!.kind).toBe('read');
    const r = await callTool(def, {}, { principal: { kind: 'ui', user: { login: 'u' } } } as unknown as ToolContext);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('forbidden');
  });
});
