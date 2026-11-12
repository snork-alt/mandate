/**
 * The embedding job queue (`embed_jobs`) on the database adapter: claim / release / fail / finish work for any backend.
 * Claims are one `UPDATE … RETURNING` over a subquery of due jobs (priority, then age). On Postgres the subquery takes
 * `FOR UPDATE SKIP LOCKED`, so several server instances (or workers) claim disjoint batches without blocking each other;
 * on SQLite there is a single writer and the subquery selects by rowid (index-only, the queue's hot path).
 *
 * On SQLite the table lives in the project's index file (index/db.ts DDL; the store wraps that handle). On Postgres it
 * lives in the project's schema: EMBED_JOBS_MIGRATIONS creates it (phase 2 moves the rest of the index next to it).
 */
import type { Migration } from './migrate.js';
import type { Dialect, Queryable } from './types.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ClaimedJob {
  hash: string;
  attempts: number;
}

const ddl = (d: Dialect) => `
CREATE TABLE IF NOT EXISTS ${d.table('embed_jobs')} (
  content_hash TEXT NOT NULL, model_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at ${d.types.bigint} NOT NULL DEFAULT 0, last_error TEXT,
  enqueued_at ${d.types.bigint} NOT NULL, updated_at ${d.types.bigint} NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (content_hash, model_id)
);
CREATE INDEX IF NOT EXISTS ${d.index('embed_jobs_due')} ON ${d.table('embed_jobs')} (model_id, status, next_attempt_at, priority);
CREATE INDEX IF NOT EXISTS ${d.index('embed_jobs_order')} ON ${d.table('embed_jobs')} (model_id, status, priority DESC, enqueued_at);
CREATE TABLE IF NOT EXISTS ${d.table('embed_queue_state')} (id INTEGER PRIMARY KEY CHECK (id = 1), model_id TEXT NOT NULL, backfilled_at ${d.types.bigint} NOT NULL);
`;

/** Standalone schema (Postgres project scope; SQLite tests). The SQLite index creates the same tables itself. */
export const EMBED_JOBS_MIGRATIONS: Migration[] = [{ id: 1, name: 'embed jobs', sqlite: ddl, postgres: ddl }];

export class EmbedJobStore {
  private readonly t: string;
  constructor(private readonly q: Queryable) {
    this.t = q.dialect.table('embed_jobs');
  }

  /** Atomically move up to `n` due pending jobs of the model to `running`, by priority then age. */
  async claim(modelId: string, n: number, now: number): Promise<ClaimedJob[]> {
    const d = this.q.dialect;
    const due = `SELECT %COL% FROM ${this.t} WHERE model_id = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY priority DESC, enqueued_at ASC LIMIT ?`;
    const sql =
      d.driver === 'sqlite'
        ? `UPDATE ${this.t} SET status = 'running', updated_at = ? WHERE rowid IN (${due.replace('%COL%', 'rowid')}) RETURNING content_hash, attempts`
        : `UPDATE ${this.t} SET status = 'running', updated_at = ? WHERE model_id = ? AND content_hash IN (${due.replace('%COL%', 'content_hash')}${d.skipLocked}) RETURNING content_hash, attempts`;
    const params = d.driver === 'sqlite' ? [now, modelId, now, n] : [now, modelId, modelId, now, n];
    const rows = await this.q.all<{ content_hash: string; attempts: number }>(sql, params);
    return rows.map((r) => ({ hash: r.content_hash, attempts: Number(r.attempts) }));
  }

  /** Make sure a job exists (an existing one keeps its state and takes the higher priority). */
  async enqueue(modelId: string, hash: string, priority: number, now: number): Promise<void> {
    const d = this.q.dialect;
    await this.q.run(
      `INSERT INTO ${this.t} AS cur (content_hash, model_id, status, attempts, next_attempt_at, last_error, enqueued_at, updated_at, priority)
       VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?, ?)
       ON CONFLICT (content_hash, model_id) DO UPDATE SET priority = ${d.greatest('cur.priority', 'excluded.priority')}, updated_at = excluded.updated_at`,
      [hash, modelId, now, now, now, priority],
    );
  }

  /** Back to pending without charging an attempt (provider outage). */
  async release(modelId: string, hashes: string[], now: number): Promise<void> {
    for (const h of hashes) await this.q.run(`UPDATE ${this.t} SET status = 'pending', updated_at = ? WHERE content_hash = ? AND model_id = ? AND status = 'running'`, [now, h, modelId]);
  }

  /** Charge a failed attempt: pending again at `nextAttemptAt`, or `failed` when the budget is spent. */
  async fail(modelId: string, hash: string, attempts: number, status: 'pending' | 'failed', nextAttemptAt: number, error: string, now: number): Promise<void> {
    await this.q.run(`UPDATE ${this.t} SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE content_hash = ? AND model_id = ? AND status = 'running'`, [status, attempts, nextAttemptAt, error.slice(0, 500), now, hash, modelId]);
  }

  /** Done (the vector is stored): the job row goes away. */
  async finish(modelId: string, hashes: string[]): Promise<void> {
    for (const h of hashes) await this.q.run(`DELETE FROM ${this.t} WHERE content_hash = ? AND model_id = ?`, [h, modelId]);
  }

  /** Crash recovery: jobs left `running` become pending again (no attempt charged). */
  async recover(modelId: string, now: number, olderThan?: number): Promise<number> {
    const extra = olderThan === undefined ? '' : ' AND updated_at < ?';
    return (await this.q.run(`UPDATE ${this.t} SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE model_id = ? AND status = 'running'${extra}`, olderThan === undefined ? [now, now, modelId] : [now, now, modelId, olderThan])).changes;
  }

  async counts(modelId: string): Promise<Record<JobStatus, number>> {
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of await this.q.all<{ status: JobStatus; n: number }>(`SELECT status, COUNT(*) AS n FROM ${this.t} WHERE model_id = ? GROUP BY status`, [modelId])) out[r.status] = Number(r.n);
    return out;
  }

  /** Earliest next_attempt_at of a pending job (backoff wake-up), or null. */
  async nextDue(modelId: string): Promise<number | null> {
    const r = await this.q.get<{ t: number | null }>(`SELECT MIN(next_attempt_at) AS t FROM ${this.t} WHERE model_id = ? AND status = 'pending'`, [modelId]);
    return r?.t === null || r?.t === undefined ? null : Number(r.t);
  }
}
