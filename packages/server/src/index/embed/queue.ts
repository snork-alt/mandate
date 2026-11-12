import { estimateTokens } from '@mandate/doc';
import { ensureVecTable, type DB } from '../db.js';
import { backfill, jobCounts, listJobs, oldestPending, outstanding, vecId, type EmbedTarget, type JobCounts, type JobInfo } from './jobs.js';
import { EmbeddingError, isProviderWide, type EmbeddingProvider } from './types.js';

export { vecId } from './jobs.js';

export interface EmbedQueueOptions {
  batchSize: number;
  documentPrefix: string;
  maxInputTokens: number;
  /** A job failing this many times is marked `failed` (kept for inspection / retry). Default 6. */
  maxAttempts?: number;
  /** Per-job backoff: base * 2^(attempts-1), capped, with ±50% jitter. Defaults 10 s and 1 h. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Clock and randomness (tests). */
  now?: () => number;
  random?: () => number;
  /** Called after the queue drains (e.g. to recompute `similar_to`). */
  onDrained?: () => void;
  /** Called on every error (logging). */
  onError?: (e: Error) => void;
}

/** Queue state for `index_status` (no chunk text, only hashes and refs). */
export interface EmbedQueueStatus {
  counts: JobCounts;
  /** Age of the oldest pending job (ms), null when none. */
  oldestPendingAgeMs: number | null;
  lastError: string | null;
  /** Set while the provider is unreachable / misconfigured: the worker retries then (no attempts are charged). */
  pausedUntil: string | null;
  maxAttempts: number;
  failedExamples: JobInfo[];
}

/** Cut text to roughly `maxTokens` (estimate), on a whitespace boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = Math.floor((maxTokens * 4) / 1.15);
  const cut = text.slice(0, chars);
  const ws = cut.lastIndexOf(' ');
  return ws > chars * 0.8 ? cut.slice(0, ws) : cut;
}

export const float32 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

interface Claimed {
  hash: string;
  attempts: number;
}

/**
 * Background embedding worker over the `embed_jobs` table (see jobs.ts). Each round claims a batch of due pending jobs
 * (highest priority, then oldest) by flipping them to `running` in one UPDATE ... RETURNING, embeds their texts, then
 * stores cache + vec0 and deletes the jobs in one transaction. A failing job gets attempts+1 and an exponential backoff
 * with jitter, and is marked `failed` after `maxAttempts`. A provider-wide failure (connection refused, 429/5xx gateway
 * errors after the provider's own retries, bad key / model) releases the batch untouched and pauses the worker.
 * Jobs left `running` by a crash are re-pended on construction. Writes never wait for this; search works text-only meanwhile.
 */
export class EmbedQueue {
  readonly table: string;
  readonly target: EmbedTarget;
  readonly maxAttempts: number;
  running = false;
  lastError: string | null = null;
  /** Epoch ms until which the worker is paused after a provider-wide failure. */
  pausedUntil: number | null = null;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private failures = 0;
  private drained?: Promise<void>;
  private resolveDrained?: () => void;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly db: DB,
    readonly provider: EmbeddingProvider,
    private readonly opts: EmbedQueueOptions,
  ) {
    this.table = ensureVecTable(db, provider.dimensions);
    this.target = { modelId: provider.modelId, table: this.table };
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.recover();
    backfill(db, this.target, this.now());
  }

  /** Crash recovery: jobs a previous process left `running` become pending again (no attempt charged). */
  recover(): number {
    const t = this.now();
    return this.db.prepare("UPDATE embed_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE model_id = ? AND status = 'running'").run(t, t, this.target.modelId).changes;
  }

  /** Distinct chunk texts still waiting for a vector (pending + running jobs): a cheap indexed count. */
  pending(): number {
    return outstanding(this.db, this.target.modelId);
  }

  embedded(): number {
    return (this.db.prepare(`SELECT COUNT(DISTINCT c.content_hash) AS n FROM chunks c JOIN embedding_cache e ON e.content_hash = c.content_hash AND e.model_id = ?`).get(this.target.modelId) as { n: number }).n;
  }

  status(examples = 5): EmbedQueueStatus {
    const model = this.target.modelId;
    const oldest = oldestPending(this.db, model);
    return {
      counts: jobCounts(this.db, model),
      oldestPendingAgeMs: oldest === null ? null : Math.max(0, this.now() - oldest),
      lastError: this.lastError,
      pausedUntil: this.pausedUntil && this.pausedUntil > this.now() ? new Date(this.pausedUntil).toISOString() : null,
      maxAttempts: this.maxAttempts,
      failedExamples: listJobs(this.db, model, ['failed'], examples),
    };
  }

  /** Start (or continue) embedding in the background. */
  kick(): void {
    if (this.running || this.stopped) return;
    clearTimeout(this.timer);
    this.running = true;
    void this.loop();
  }

  /** Resolves when nothing is due (or the queue paused / gave up for now). For tests and the CLI. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.drained ??= new Promise((r) => (this.resolveDrained = r));
    return this.drained;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private finish() {
    this.running = false;
    this.resolveDrained?.();
    this.drained = undefined;
    this.resolveDrained = undefined;
  }

  /** Atomically move up to `n` due pending jobs to `running`, by priority then age. */
  private claim(n: number): Claimed[] {
    const t = this.now();
    const rows = this.db
      .prepare(
        `UPDATE embed_jobs SET status = 'running', updated_at = ?
         WHERE rowid IN (SELECT rowid FROM embed_jobs WHERE model_id = ? AND status = 'pending' AND next_attempt_at <= ?
                         ORDER BY priority DESC, enqueued_at ASC LIMIT ?)
         RETURNING content_hash, attempts`,
      )
      .all(t, this.target.modelId, t, n) as { content_hash: string; attempts: number }[];
    return rows.map((r) => ({ hash: r.content_hash, attempts: r.attempts }));
  }

  /** Back to pending without charging an attempt (provider outage). */
  private release(jobs: Claimed[]): void {
    const t = this.now();
    const up = this.db.prepare("UPDATE embed_jobs SET status = 'pending', updated_at = ? WHERE content_hash = ? AND model_id = ? AND status = 'running'");
    this.db.transaction(() => {
      for (const j of jobs) up.run(t, j.hash, this.target.modelId);
    })();
  }

  /** Done: cache, vec0, then the job row is deleted (the vector's presence is the record). */
  private complete(jobs: Claimed[], vectors: Float32Array[]): void {
    const { modelId, table } = this.target;
    const insCache = this.db.prepare('INSERT OR REPLACE INTO embedding_cache (content_hash, model_id, dims, vector) VALUES (?, ?, ?, ?)');
    const insVec = this.db.prepare(`INSERT OR REPLACE INTO ${table} (id, model_id, embedding) VALUES (?, ?, ?)`);
    const del = this.db.prepare('DELETE FROM embed_jobs WHERE content_hash = ? AND model_id = ?');
    this.db.transaction(() => {
      jobs.forEach((j, i) => {
        const blob = float32(vectors[i]!);
        insCache.run(j.hash, modelId, this.provider.dimensions, blob);
        insVec.run(vecId(modelId, j.hash), modelId, blob);
        del.run(j.hash, modelId);
      });
    })();
  }

  /** attempts+1; pending again after an exponential backoff with jitter, or `failed` once the budget is spent. */
  private fail(job: Claimed, err: Error): void {
    const attempts = job.attempts + 1;
    const t = this.now();
    const base = this.opts.backoffBaseMs ?? 10_000;
    const cap = this.opts.backoffMaxMs ?? 3_600_000;
    const delay = Math.round(Math.min(cap, base * 2 ** (attempts - 1)) * (0.5 + this.random()));
    const status = attempts >= this.maxAttempts ? 'failed' : 'pending';
    this.db
      .prepare('UPDATE embed_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE content_hash = ? AND model_id = ? AND status = \'running\'')
      .run(status, attempts, t + delay, err.message.slice(0, 500), t, job.hash, this.target.modelId);
    this.lastError = err.message;
    this.opts.onError?.(err);
  }

  /**
   * Inputs for claimed jobs. A job whose text no chunk uses any more is dropped; one whose vector another process
   * cached meanwhile is completed from the cache.
   */
  private prepare(jobs: Claimed[]): { live: Claimed[]; inputs: string[] } {
    const { modelId, table } = this.target;
    const textOf = this.db.prepare('SELECT prefix, text FROM chunks WHERE content_hash = ? LIMIT 1');
    const cached = this.db.prepare('SELECT vector FROM embedding_cache WHERE content_hash = ? AND model_id = ?');
    const insVec = this.db.prepare(`INSERT OR REPLACE INTO ${table} (id, model_id, embedding) VALUES (?, ?, ?)`);
    const del = this.db.prepare('DELETE FROM embed_jobs WHERE content_hash = ? AND model_id = ?');
    const live: Claimed[] = [];
    const inputs: string[] = [];
    this.db.transaction(() => {
      for (const j of jobs) {
        const c = textOf.get(j.hash) as { prefix: string; text: string } | undefined;
        const hit = c && (cached.get(j.hash, modelId) as { vector: Buffer } | undefined);
        if (!c || hit) {
          if (hit) insVec.run(vecId(modelId, j.hash), modelId, hit.vector);
          del.run(j.hash, modelId);
          continue;
        }
        const body = c.text ? `${c.prefix}\n\n${c.text}` : c.prefix;
        live.push(j);
        inputs.push(truncateToTokens(this.opts.documentPrefix + body, this.opts.maxInputTokens));
      }
    })();
    return { live, inputs };
  }

  private async loop(): Promise<void> {
    const { provider } = this;
    try {
      for (;;) {
        if (this.stopped) return this.finish(); // claimed jobs stay `running`: recovered on the next start
        const jobs = this.claim(this.opts.batchSize);
        if (!jobs.length) break;
        const { live, inputs } = this.prepare(jobs);
        if (!live.length) continue;
        let vectors: Float32Array[];
        try {
          vectors = await provider.embed(inputs);
        } catch (e) {
          if (this.stopped) return this.finish();
          if (isProviderWide(e)) {
            this.release(live);
            throw e;
          }
          // One input may poison the batch: retry one by one so only the culprit is charged.
          await this.isolate(live, inputs, toError(e));
          continue;
        }
        if (this.stopped) return this.finish();
        this.complete(live, vectors);
        this.failures = 0;
        this.lastError = null;
        this.pausedUntil = null;
      }
      this.scheduleNextDue();
      this.prune();
      this.finish();
      this.opts.onDrained?.();
    } catch (e) {
      if (this.stopped) return this.finish();
      const err = toError(e);
      this.lastError = err.message;
      this.opts.onError?.(err);
      this.failures++;
      // Paused: quickly for transient outages, slowly for configuration problems. A kick (next sync) retries sooner.
      const retryable = !(err instanceof EmbeddingError) || err.retryable;
      const delay = retryable ? Math.min(300_000, 5_000 * 2 ** Math.min(this.failures, 6)) : 600_000;
      this.pausedUntil = this.now() + delay;
      this.finish();
      if (!this.stopped) this.timer = setTimeout(() => this.kick(), delay).unref();
    }
  }

  private async isolate(live: Claimed[], inputs: string[], batchError: Error): Promise<void> {
    if (live.length === 1) return this.fail(live[0]!, batchError);
    for (let i = 0; i < live.length; i++) {
      if (this.stopped) return;
      try {
        const [v] = await this.provider.embed([inputs[i]!]);
        if (this.stopped) return;
        this.complete([live[i]!], [v!]);
      } catch (e) {
        if (this.stopped) return;
        if (isProviderWide(e)) {
          this.release(live.slice(i));
          throw e;
        }
        this.fail(live[i]!, toError(e));
      }
    }
  }

  /** Jobs waiting out a backoff: wake up when the earliest one is due. */
  private scheduleNextDue(): void {
    const next = (this.db.prepare("SELECT MIN(next_attempt_at) AS t FROM embed_jobs WHERE model_id = ? AND status = 'pending'").get(this.target.modelId) as { t: number | null }).t;
    if (next === null || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kick(), Math.max(50, next - this.now())).unref();
  }

  /** Drop vectors of texts no longer indexed (the cache keeps them for later). */
  prune(): void {
    const model = this.target.modelId;
    const live = new Set((this.db.prepare('SELECT DISTINCT content_hash AS h FROM chunks').all() as { h: string }[]).map((r) => vecId(model, r.h)));
    const ids = this.db.prepare(`SELECT id FROM ${this.table} WHERE model_id = ?`).all(model) as { id: string }[];
    const del = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);
    this.db.transaction(() => {
      for (const { id } of ids) if (!live.has(id)) del.run(id);
    })();
  }

  /** Jobs of the current model (for the `embedding_jobs` tool). */
  jobs(statuses: Parameters<typeof listJobs>[2], limit: number): JobInfo[] {
    return listJobs(this.db, this.target.modelId, statuses, limit);
  }
}

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
