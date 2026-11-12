/**
 * The embedding job table (`embed_jobs`): an outbox written by the indexer in the same transaction as the chunks, and
 * the durable queue the EmbedQueue worker drains.
 *
 * Invariant (per current model): every distinct `chunks.content_hash` either has a vector in the model's vec0 partition
 * or a job row (pending / running / failed). A job is deleted once its vector is stored ('done' is never persisted), so
 * the table only holds outstanding work and counts are cheap index lookups.
 */
import type { DB } from '../db.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/** Where vectors of a model live: the model id (vec0 partition / cache key) and the vec0 table. */
export interface EmbedTarget {
  modelId: string;
  table: string;
}

/** Job priorities: fresh writes through this server first, then other new commits, then backfills and rebuilds. */
export const PRIORITY = { backfill: 0, sync: 5, write: 10 } as const;

export const vecId = (modelId: string, hash: string) => `${modelId}:${hash}`;

/**
 * Make sure each hash gets a vector for the target model. Cached vectors are copied into vec0 right away (no job);
 * the rest become pending jobs (an existing job keeps its state and takes the higher priority).
 * Call inside the transaction that writes the chunks.
 */
export function enqueueHashes(db: DB, target: EmbedTarget, hashes: Iterable<string>, priority: number, now = Date.now()): { enqueued: number; cached: number } {
  const { modelId, table } = target;
  const cache = db.prepare('SELECT vector FROM embedding_cache WHERE content_hash = ? AND model_id = ?');
  const hasVec = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  const insVec = db.prepare(`INSERT OR REPLACE INTO ${table} (id, model_id, embedding) VALUES (?, ?, ?)`);
  const dropJob = db.prepare('DELETE FROM embed_jobs WHERE content_hash = ? AND model_id = ?');
  const upsert = db.prepare(
    `INSERT INTO embed_jobs (content_hash, model_id, status, attempts, next_attempt_at, last_error, enqueued_at, updated_at, priority)
     VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?, ?)
     ON CONFLICT (content_hash, model_id) DO UPDATE SET priority = max(priority, excluded.priority), updated_at = excluded.updated_at`,
  );
  let enqueued = 0;
  let cached = 0;
  for (const h of hashes) {
    const row = cache.get(h, modelId) as { vector: Buffer } | undefined;
    if (row) {
      const id = vecId(modelId, h);
      if (!hasVec.get(id)) insVec.run(id, modelId, row.vector);
      dropJob.run(h, modelId);
      cached++;
    } else {
      upsert.run(h, modelId, now, now, now, priority);
      enqueued++;
    }
  }
  return { enqueued, cached };
}

/** Drop the jobs (any model) of hashes no chunk uses any more. Call after deleting chunks, in the same transaction. */
export function forgetHashes(db: DB, hashes: Iterable<string>): number {
  const del = db.prepare('DELETE FROM embed_jobs WHERE content_hash = ? AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ?)');
  let n = 0;
  for (const h of hashes) n += del.run(h, h).changes;
  return n;
}

/**
 * Bring the job table in line with the chunks for the target model, once: on the first start after the table was added
 * (no queue state) and after a model switch (jobs of other models are dropped). Returns the number of jobs created,
 * or null when the table was already complete for this model.
 */
export function backfill(db: DB, target: EmbedTarget, now = Date.now()): number | null {
  const st = db.prepare('SELECT model_id FROM embed_queue_state WHERE id = 1').get() as { model_id: string } | undefined;
  if (st?.model_id === target.modelId) return null;
  return db.transaction(() => {
    db.prepare('DELETE FROM embed_jobs WHERE model_id != ?').run(target.modelId);
    const hashes = (db.prepare('SELECT DISTINCT content_hash AS h FROM chunks').all() as { h: string }[]).map((r) => r.h);
    const { enqueued } = enqueueHashes(db, target, hashes, PRIORITY.backfill, now);
    db.prepare('INSERT OR REPLACE INTO embed_queue_state (id, model_id, backfilled_at) VALUES (1, ?, ?)').run(target.modelId, now);
    return enqueued;
  })();
}

/** Semantic search disabled: no model is kept complete, so the next configured model backfills from scratch. */
export function resetQueueState(db: DB): void {
  db.transaction(() => {
    db.exec('DELETE FROM embed_jobs; DELETE FROM embed_queue_state;');
  })();
}

/* ---------------------------------------------------------------- visibility */

export type JobCounts = Record<JobStatus, number>;

export function jobCounts(db: DB, modelId: string): JobCounts {
  const out: JobCounts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM embed_jobs WHERE model_id = ? GROUP BY status').all(modelId) as { status: JobStatus; n: number }[]) out[r.status] = r.n;
  return out;
}

/** Outstanding texts (pending + running) for the model: an index range count, never a scan of the chunks. */
export function outstanding(db: DB, modelId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM embed_jobs WHERE model_id = ? AND status IN ('pending', 'running')").get(modelId) as { n: number }).n;
}

export interface JobRef {
  uri: string;
  docUri: string;
}

export interface JobInfo {
  contentHash: string;
  status: JobStatus;
  attempts: number;
  priority: number;
  enqueuedAt: string;
  updatedAt: string;
  /** When a pending job may run next (backoff). */
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Docs / sections using this text (never the text itself). */
  refs: JobRef[];
}

interface JobRow {
  content_hash: string;
  status: JobStatus;
  attempts: number;
  priority: number;
  enqueued_at: number;
  updated_at: number;
  next_attempt_at: number;
  last_error: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Jobs of the model with the given statuses, most urgent first, each with up to 3 refs. */
export function listJobs(db: DB, modelId: string, statuses: JobStatus[], limit: number): JobInfo[] {
  if (!statuses.length) return [];
  const rows = db
    .prepare(
      `SELECT content_hash, status, attempts, priority, enqueued_at, updated_at, next_attempt_at, last_error FROM embed_jobs
       WHERE model_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY priority DESC, enqueued_at ASC LIMIT ?`,
    )
    .all(modelId, ...statuses, limit) as JobRow[];
  const refsOf = db.prepare('SELECT uri, doc_uri FROM chunks WHERE content_hash = ? ORDER BY uri LIMIT 3');
  return rows.map((r) => ({
    contentHash: r.content_hash,
    status: r.status,
    attempts: r.attempts,
    priority: r.priority,
    enqueuedAt: iso(r.enqueued_at),
    updatedAt: iso(r.updated_at),
    nextAttemptAt: r.status === 'pending' ? iso(r.next_attempt_at) : null,
    lastError: r.last_error,
    refs: (refsOf.all(r.content_hash) as { uri: string; doc_uri: string }[]).map((c) => ({ uri: c.uri, docUri: c.doc_uri })),
  }));
}

/** Enqueue time (ms) of the oldest pending job of the model, or null. */
export function oldestPending(db: DB, modelId: string): number | null {
  return (db.prepare("SELECT MIN(enqueued_at) AS t FROM embed_jobs WHERE model_id = ? AND status = 'pending'").get(modelId) as { t: number | null }).t;
}

/** Re-arm failed jobs (all, or the given hashes) as pending with a fresh attempt budget. Returns how many. */
export function retryFailed(db: DB, modelId: string, hashes: string[] | undefined, now = Date.now()): number {
  const sql = "UPDATE embed_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE model_id = ? AND status = 'failed'";
  if (!hashes) return db.prepare(sql).run(now, now, modelId).changes;
  const one = db.prepare(`${sql} AND content_hash = ?`);
  return db.transaction(() => hashes.reduce((n, h) => n + one.run(now, now, modelId, h).changes, 0))();
}
