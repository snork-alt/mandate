import { ZodError } from 'zod';
import { blastRadius as blastRadiusOf, codeRules as codeRulesOf, lineage as lineageOf, whereUsed as whereUsedOf } from './lineage.js';
import type { BlastRadiusInput, CodeRulesInput, ContributorsInput, LineageInput, WhereUsedInput } from '@mandate/shared';
import { contributors as contributorsOf } from './contributors.js';
import type { DocFormat } from '@mandate/doc';
import {
  buildArchitectureRef,
  indexRebuildInputSchema,
  indexStatusInputSchema,
  type CodeSearchInput,
  type GraphChangesInput,
  type GraphEvolutionInput,
  type GraphHistoryInput,
  type GraphImpactInput,
  type GraphNeighborsInput,
  type GraphNodeInput,
  type GraphPathInput,
  type GraphSearchInput,
  type HistorySearchInput,
  type IndexStatus,
  type ResolveRefInput,
  type RulesForCodeInput,
  type BatchResult,
  type GraphBatchInput,
  type GraphQueryInput,
  graphBatchInputSchema,
  type ResolvedRef,
  parseNodeUri,
  parseRef,
  resolveRefInputSchema,
  type MetadataQueryInput,
  type RelatedInput,
  type SearchInput,
  type SymbolSearchInput,
  type TextSearchInput,
} from '@mandate/shared';
import type { IndexConfig, ResolvedEmbeddingConfig } from '../config.js';
import type { GitStore } from '../git/GitStore.js';
import { auditFormat, componentFormat, sectionTypes, specFormat, standardFormat, workOrderFormat } from '../storage/codecs.js';
import type { Storage } from '../storage/index.js';
import { SCHEMA_VERSION, ensureVecTable, json, openIndexDb, type DB } from './db.js';
import { createProvider, modelIdFor, type EmbeddingProvider } from './embed/index.js';
import { PRIORITY, resetQueueState, retryFailed, type JobInfo, type JobStatus } from './embed/jobs.js';
import { EmbedQueue, type EmbedQueueStatus } from './embed/queue.js';
import { liveEmbeddingConfig } from './embed/live.js';
import { isCompleted, markCompleted, previousModels, rememberModel, storedConfig } from './embed/models.js';
import type { ExtractContext } from './extract.js';
import * as graph from './graph.js';
import { graphOwnerOf, graphRulesForCode } from './rules.js';
import { CypherError, CypherRunner, graphQuery, graphSchema, type CypherExec } from './cypher/index.js';
import { PgCypherRunner } from './cypher/pg/runner.js';
import { IndexMirror } from '../db/pg-index/mirror.js';
import type { PostgresDb } from '../db/postgres.js';
import { GraphError, pub, resolveRef } from './resolve.js';
import { Indexer, type SyncResult } from './indexer.js';
import * as s from './search.js';

export interface IndexServiceOptions {
  git: GitStore;
  /** For derived metadata (outdated sections). */
  storage?: Storage;
  index: Omit<IndexConfig, 'queryTimeoutMs' | 'embedMaxAttempts'> & { queryTimeoutMs?: number; embedMaxAttempts?: number };
  embedding: ResolvedEmbeddingConfig;
  /** Override the configured provider (tests: FakeProvider; null disables semantic search). Disables hot reload. */
  provider?: EmbeddingProvider | null;
  /** Provider for a config (default createProvider); used on hot reload and for the previous model's queries. */
  providerFor?: (cfg: ResolvedEmbeddingConfig) => EmbeddingProvider | null;
  /** Hot-reload poll of the embedding block (ms, default 3000; 0 disables). Only with a live config `source`. */
  embeddingReloadMs?: number;
  /** Minimum cosine similarity for `similar_to` edges. */
  similarThreshold?: number;
  /**
   * Postgres index (database.driver = postgres): the project's index scope. The SQLite build is published there after
   * every sync / embedding batch (db/pg-index/mirror.ts) and graph_query runs on it.
   */
  postgres?: { db: PostgresDb; projectId: string };
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/**
 * The search index: one SQLite file (better-sqlite3 + sqlite-vec) kept in sync with git.
 * Every search, graph and index operation is a method taking the zod-validated input of
 * `@mandate/shared`, so the MCP tools wrap them 1:1.
 */
/** Which model answers semantic queries: the current one, the previous one while the new one backfills, or none. */
export interface EmbeddingServing {
  mode: 'current' | 'previous' | 'text-only' | 'none';
  modelId: string | null;
  model: string | null;
  /** Why (shown in index_status and the UI) when not the current model. */
  note?: string;
}

interface Serving {
  provider: EmbeddingProvider | null;
  vecTable: string | null;
  queryPrefix: string;
  info: EmbeddingServing;
}

/**
 * The search index: one SQLite file (better-sqlite3 + sqlite-vec) kept in sync with git.
 * Every search, graph and index operation is a method taking the zod-validated input of
 * `@mandate/shared`, so the MCP tools wrap them 1:1.
 */
export class IndexService {
  readonly db: DB;
  private _provider: EmbeddingProvider | null = null;
  private _queue: EmbedQueue | null = null;
  private embedCfg: ResolvedEmbeddingConfig;
  private serving: Serving = { provider: null, vecTable: null, queryPrefix: '', info: { mode: 'none', modelId: null, model: null } };
  private readonly indexer: Indexer;
  private readonly ctx: graph.GraphContext;
  private chain: Promise<unknown> = Promise.resolve();
  private building = false;
  private timer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;
  /** Highest embedding priority among the commits waiting for the debounced sync. */
  private scheduled: number | null = null;
  private closed = false;
  private runner?: CypherExec & { close(): Promise<void> };
  /** Postgres mirror of this index (null: SQLite only). */
  readonly mirror: IndexMirror | null;

  /** Embedding provider of the current model (indexing); null when semantic search is off. */
  get provider(): EmbeddingProvider | null {
    return this._provider;
  }
  get queue(): EmbedQueue | null {
    return this._queue;
  }

  constructor(private readonly opts: IndexServiceOptions) {
    this.db = openIndexDb(opts.index.path);
    this.embedCfg = opts.embedding;
    const formats = { specs: specFormat as DocFormat<unknown, unknown>, standards: standardFormat as DocFormat<unknown, unknown>, components: componentFormat as DocFormat<unknown, unknown>, audits: auditFormat as DocFormat<unknown, unknown>, 'work-orders': workOrderFormat as DocFormat<unknown, unknown> };
    const extract: ExtractContext = {
      formats,
      chunk: { chunkTargetTokens: opts.index.chunkTargetTokens, chunkOverlapTokens: opts.index.chunkOverlapTokens, registry: sectionTypes },
    };
    this.indexer = new Indexer(this.db, opts.git, extract, null);
    this.mirror = opts.postgres ? new IndexMirror(this.db, opts.postgres.db, opts.postgres.projectId) : null;
    const storage = opts.storage;
    this.ctx = {
      db: this.db,
      provider: null,
      queryPrefix: opts.embedding.queryPrefix,
      vecTable: null,
      pending: () => this._queue?.pending() ?? 0,
      unavailable: () => (this.serving.info.mode === 'text-only' ? (this.serving.info.note ?? 'semantic search is paused while re-embedding') : null),
      outdatedSections: storage
        ? async (id) =>
            Object.entries(await storage.queueService.implementation(id))
              .filter(([, v]) => v.outdated)
              .map(([k]) => k)
        : undefined,
      git: opts.git,
      formats,
      ...(storage ? { claimHeartbeat: (id: string, claim: { agent: string; startedAt: string }) => storage.workOrderService.heartbeatOf(id, claim) } : {}),
    };
    // The queue first: it creates the vec0 table, recovers jobs a crash left running and backfills on a new model.
    this.installEmbedding(opts.provider !== undefined ? opts.provider : this.providerFor(opts.embedding), opts.embedding, null);
    const reloadMs = opts.embeddingReloadMs ?? 3000;
    if (opts.provider === undefined && opts.embedding.source && reloadMs > 0) {
      this.reloadTimer = setInterval(() => this.refreshEmbedding(), reloadMs);
      this.reloadTimer.unref?.();
    }
  }

  private providerFor(cfg: ResolvedEmbeddingConfig): EmbeddingProvider | null {
    return (this.opts.providerFor ?? createProvider)(cfg);
  }

  /**
   * Make `provider` the current model: a new queue (backfills when the model changed; vectors of a model seen before
   * come from the cache), the indexer's outbox target, and which model answers queries meanwhile.
   */
  private installEmbedding(provider: EmbeddingProvider | null, cfg: ResolvedEmbeddingConfig, previous: Serving | null): void {
    this._queue?.stop();
    this._provider = provider;
    this._queue = provider
      ? new EmbedQueue(this.db, provider, {
          batchSize: cfg.batchSize,
          documentPrefix: cfg.documentPrefix,
          maxInputTokens: cfg.maxInputTokens,
          maxAttempts: this.opts.index.embedMaxAttempts ?? 6,
          onDrained: () => this.onDrained(),
          onError: (e) => this.opts.log?.warn(`embedding: ${e.message}`),
        })
      : null;
    if (!provider) resetQueueState(this.db);
    this.indexer.setEmbedTarget(this._queue?.target ?? null);
    if (provider) {
      this.db.prepare('UPDATE index_state SET model_id = ? WHERE id = 1').run(provider.modelId);
      rememberModel(this.db, provider.modelId, storedConfig(cfg));
      if (this._queue!.pending() === 0) markCompleted(this.db, provider.modelId);
    }
    this.setServing(this.chooseServing(previous));
  }

  private currentServing(): Serving {
    const p = this._provider;
    if (!p || !this._queue) return { provider: null, vecTable: null, queryPrefix: this.embedCfg.queryPrefix, info: { mode: 'none', modelId: null, model: null } };
    return { provider: p, vecTable: this._queue.table, queryPrefix: this.embedCfg.queryPrefix, info: { mode: 'current', modelId: p.modelId, model: this.embedCfg.model } };
  }

  private hasVectors(table: string, modelId: string): boolean {
    try {
      return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE model_id = ? LIMIT 1`).get(modelId);
    } catch {
      return false;
    }
  }

  /**
   * The current model once its backfill is complete. Before that, after a model switch: the previous completed model
   * (in this process, or recorded in `embed_models` with its config; its key comes from the env), else text-only.
   * The very first build (no previous model) uses the partial vectors of the current model.
   */
  private chooseServing(previous: Serving | null): Serving {
    const cur = this.currentServing();
    if (!cur.provider) return cur;
    const curId = cur.provider.modelId;
    if (isCompleted(this.db, curId)) return cur;
    const pending = this._queue!.pending();
    const note = (from: string) => `answering from the previous model ${from} until the new model ${this.embedCfg.model} finishes re-embedding (${pending} chunk text(s) left)`;
    if (previous?.provider && previous.vecTable && previous.provider.modelId !== curId && isCompleted(this.db, previous.provider.modelId) && this.hasVectors(previous.vecTable, previous.provider.modelId)) {
      return { ...previous, info: { mode: 'previous', modelId: previous.provider.modelId, model: previous.info.model, note: note(previous.info.model ?? previous.provider.modelId) } };
    }
    const prior = previousModels(this.db, curId);
    for (const m of prior) {
      const table = ensureVecTable(this.db, m.config.dimensions);
      if (!this.hasVectors(table, m.modelId)) continue;
      try {
        const apiKey = m.config.apiKeyEnv ? process.env[m.config.apiKeyEnv] : undefined;
        const p = this.providerFor({ ...this.embedCfg, ...m.config, ...(apiKey ? { apiKey } : { apiKey: undefined }) });
        if (!p || p.modelId !== m.modelId) continue;
        return { provider: p, vecTable: table, queryPrefix: m.config.queryPrefix, info: { mode: 'previous', modelId: m.modelId, model: m.config.model, note: note(m.config.model) } };
      } catch {
        continue;
      }
    }
    if (prior.length || previous?.provider) {
      return { provider: null, vecTable: null, queryPrefix: cur.queryPrefix, info: { mode: 'text-only', modelId: null, model: null, note: `semantic search is text-only until the new model ${this.embedCfg.model} finishes re-embedding (${pending} chunk text(s) left)` } };
    }
    return cur;
  }

  private setServing(sv: Serving): void {
    this.serving = sv;
    this.ctx.provider = sv.provider;
    this.ctx.vecTable = sv.vecTable;
    this.ctx.queryPrefix = sv.queryPrefix;
    this.ctx.queryCache?.clear();
  }

  /** Copy the build's changes to the Postgres index (a failure is logged; the next publish copies everything). */
  async publishMirror(): Promise<void> {
    try {
      await this.mirror?.publish();
    } catch (e) {
      this.opts.log?.error(`index: publishing to Postgres failed: ${(e as Error).message}`);
    }
  }

  /** Queue drained: a finished backfill makes the current model the one answering queries. */
  private onDrained(): void {
    this.mirror?.schedule();
    if (this.closed || !this._provider || !this._queue) return;
    if (this._queue.pending() === 0) {
      markCompleted(this.db, this._provider.modelId);
      if (this.serving.info.mode !== 'current') {
        this.opts.log?.info(`embedding: ${this.embedCfg.model} finished re-embedding; semantic search now uses it`);
        this.setServing(this.currentServing());
      }
    }
    this.recomputeSimilar();
  }

  /** Embedding status for index_status / the UI: which model answers queries and why. */
  embeddingServing(): EmbeddingServing {
    return this.serving.info;
  }

  /** Hot reload: re-read the live `embedding` block; apply it when anything that matters changed. */
  refreshEmbedding(): void {
    if (this.closed || this.opts.provider !== undefined || !this.embedCfg.source) return;
    const next = liveEmbeddingConfig(this.embedCfg, this.opts.log ?? { warn: () => undefined });
    if (embeddingSignature(next) === embeddingSignature(this.embedCfg) && next.apiKey === this.embedCfg.apiKey) return;
    void this.reconfigureEmbedding(next).catch((e) => this.opts.log?.warn(`embedding: could not apply the new settings: ${(e as Error).message}`));
  }

  /**
   * Switch to a new embedding config (and optionally an explicit provider, tests). Serialized with syncs. A new model
   * re-embeds everything in the background; queries keep using the previous model until that finishes.
   */
  reconfigureEmbedding(cfg: ResolvedEmbeddingConfig, provider?: EmbeddingProvider | null): Promise<void> {
    const run = this.chain.then(() => {
      if (this.closed) return;
      const before = this._provider?.modelId ?? null;
      const prev = this.serving.info.mode === 'current' ? this.serving : this.serving.info.mode === 'previous' ? this.serving : null;
      const next = provider !== undefined ? provider : this.providerFor(cfg);
      this.embedCfg = cfg;
      this.installEmbedding(next, cfg, prev);
      const after = next?.modelId ?? null;
      if (before !== after) this.opts.log?.info(`embedding: model ${before ?? 'none'} -> ${after ?? 'none'}${this._queue ? ` (${this._queue.pending()} chunk text(s) to embed)` : ''}`);
      this._queue?.kick();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** Initial sync (replays new history) and background embedding. */
  async start(): Promise<SyncResult> {
    const r = await this.sync();
    return r;
  }

  /**
   * Serialized incremental sync; embedding continues in the background. `priority` ranks the embedding jobs of new
   * chunk texts (PRIORITY.write: a write made through this server; default: backfill).
   */
  sync(opts: { priority?: number } = {}): Promise<SyncResult> {
    const run = this.chain.then(async () => {
      this.building = true;
      try {
        const r = await this.indexer.sync(opts);
        if (this.mirror) await this.publishMirror();
        if (r.commitsIndexed) this.opts.log?.info(`index: ${r.commitsIndexed} commit(s), ${r.filesReindexed} file(s) reindexed${r.rebuilt ? ' (full rebuild)' : ''}`);
        for (const e of r.errors.slice(0, 3)) this.opts.log?.warn(`index: ${e}`);
        return r;
      } catch (e) {
        this.db.prepare('UPDATE index_state SET last_error = ? WHERE id = 1').run((e as Error).message);
        this.opts.log?.error(`index sync failed: ${(e as Error).stack ?? e}`);
        throw e;
      } finally {
        this.building = false;
        if (!this.closed) this.queue?.kick();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Debounced sync after a commit (non-blocking). A commit made through this server (an MCP / API write) embeds first;
   * a pull ranks like any other new commit.
   */
  schedule(reason: 'commit' | 'pull' = 'commit'): void {
    this.scheduled = Math.max(this.scheduled ?? 0, reason === 'commit' ? PRIORITY.write : PRIORITY.sync);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync({ priority: this.takeScheduled(PRIORITY.sync) }).catch(() => undefined), 25);
    this.timer.unref?.();
  }

  private takeScheduled(floor: number): number {
    const p = Math.max(floor, this.scheduled ?? 0);
    this.scheduled = null;
    return p;
  }

  /** Sync first if HEAD moved (commits made outside this process are picked up on read). */
  async ensureFresh(): Promise<void> {
    this.refreshEmbedding();
    const head = await this.opts.git.head();
    // A read can beat the debounced sync of a write: keep that write's priority.
    if (head !== this.indexer.state().head) await this.sync({ priority: this.takeScheduled(PRIORITY.sync) });
  }

  /** Full rebuild: replay all of history (vectors come from the embedding cache). */
  async rebuild(input: Record<string, never> = {}): Promise<SyncResult> {
    indexRebuildInputSchema.parse(input);
    const run = this.chain.then(async () => {
      this.building = true;
      try {
        return await this.indexer.rebuild();
      } finally {
        this.building = false;
        if (!this.closed) this.queue?.kick();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async status(input: Record<string, never> = {}): Promise<IndexStatus & { embedding: IndexStatus['embedding'] & { queue: EmbedQueueStatus | null } }> {
    indexStatusInputSchema.parse(input);
    const st = this.indexer.state();
    const count = (t: string, where = '1') => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as { n: number }).n;
    const head = await this.opts.git.head();
    this.refreshEmbedding();
    const e = this.embedCfg;
    return {
      indexPath: this.opts.index.path,
      schemaVersion: SCHEMA_VERSION,
      headCommit: head,
      indexedCommit: st.head,
      upToDate: head === st.head,
      building: this.building,
      docs: count('docs'),
      sections: count('sections'),
      chunks: count('chunks'),
      nodes: count('nodes', 'valid_to IS NULL'),
      edges: count('edges', 'valid_to IS NULL'),
      commits: count('commits'),
      embedding: {
        provider: this.provider ? e.provider : 'none',
        model: e.model,
        modelId: this.provider?.modelId ?? modelIdFor(e),
        dimensions: this.provider?.dimensions ?? e.dimensions,
        embedded: this.queue?.embedded() ?? 0,
        pending: this.queue?.pending() ?? 0,
        running: this.queue?.running ?? false,
        queue: this.queue?.status() ?? null,
        serving: this.serving.info,
      },
      lastSyncAt: st.lastSyncAt,
      lastError: this.queue?.lastError ?? st.lastError,
      historyRewrite: this.indexer.historyRewrite(),
    };
  }

  /** Embedding jobs of the current model by status (default: failed and pending), with their doc / section refs. */
  embeddingJobs(input: { status?: Exclude<JobStatus, 'done'>[]; limit?: number } = {}): { modelId: string | null; items: JobInfo[] } {
    if (!this.queue) return { modelId: null, items: [] };
    return { modelId: this.queue.target.modelId, items: this.queue.jobs(input.status ?? ['failed', 'pending'], input.limit ?? 20) };
  }

  /** Re-arm failed embedding jobs (all, or the given content hashes) and wake the worker. */
  retryEmbeddingJobs(input: { contentHashes?: string[] } = {}): { retried: number } {
    if (!this.queue) return { retried: 0 };
    const retried = retryFailed(this.db, this.queue.target.modelId, input.contentHashes);
    if (retried && !this.closed) this.queue.kick();
    return { retried };
  }

  /** Wait until embedding is idle (CLI, tests). */
  async idle(): Promise<void> {
    await this.chain;
    await this.queue?.idle();
    if (this.mirror && !this.closed) await this.publishMirror();
  }

  close(): void {
    this.closed = true;
    void this.runner?.close();
    clearTimeout(this.timer);
    clearInterval(this.reloadTimer);
    this.queue?.stop();
    void this.mirror?.db.close();
    this.db.close();
  }

  /** `similar_to` edges: each section's top 5 semantic neighbours above the threshold (recomputed when vectors change). */
  recomputeSimilar(): void {
    if (!this.provider || this.closed) return;
    const threshold = this.opts.similarThreshold ?? 0.8;
    const seq = this.indexer.state().seq;
    const sections = (this.db.prepare('SELECT uri FROM sections').all() as { uri: string }[]).map((r) => r.uri);
    const want = new Map<string, { from: string; to: string; score: number }>();
    for (const uri of sections) {
      for (const n of s.nearest(this.ctx, uri, 5, ['section'])) {
        if (n.score < threshold) continue;
        const [a, b] = uri < n.uri ? [uri, n.uri] : [n.uri, uri];
        want.set(`${a}|${b}`, { from: a, to: b, score: n.score });
      }
    }
    const db = this.db;
    db.transaction(() => {
      const open = db.prepare("SELECT id, from_uri, to_uri FROM edges WHERE source = 'similar' AND valid_to IS NULL").all() as { id: number; from_uri: string; to_uri: string }[];
      for (const e of open) {
        const k = `${e.from_uri}|${e.to_uri}`;
        const w = want.get(k);
        if (w) {
          db.prepare('UPDATE edges SET score = ? WHERE id = ?').run(w.score, e.id);
          want.delete(k);
        } else db.prepare('UPDATE edges SET valid_to = ? WHERE id = ?').run(seq, e.id);
      }
      const ins = db.prepare("INSERT INTO edges (from_uri, to_uri, kind, props, score, source, valid_from) VALUES (?, ?, 'similar_to', ?, ?, 'similar', ?)");
      for (const w of want.values()) ins.run(w.from, w.to, json({ model: this.provider!.modelId }), w.score, seq);
    })();
  }

  /* ---------------------------------------------------------------- search */

  async search(input: SearchInput) {
    await this.ensureFresh();
    return s.search(this.ctx, { ...input, within: await this.scope(input.within) });
  }
  async textSearch(input: TextSearchInput) {
    await this.ensureFresh();
    return s.textSearch(this.ctx, { ...input, within: await this.scope(input.within) });
  }

  /** `within`: any copied doc / section reference, resolved to the live node; search covers HEAD only. */
  private async scope(within?: string): Promise<string | undefined> {
    if (within === undefined) return undefined;
    if (typeof within !== 'string' || !parseNodeUri(within)) return within; // let the schema report it
    const r = await resolveRef(this.ctx, within);
    const head = await this.opts.git.head();
    if (r.at && r.at.sha !== head) {
      throw new GraphError('search covers the current version only', 400, 'versioned_scope', 'drop @sha from within, or use graph_node / graph_changes for past versions');
    }
    const live = r.live[0]!;
    const ref = parseRef(live);
    if (!ref || (ref.kind !== 'specs' && ref.kind !== 'standards' && ref.kind !== 'components' && ref.kind !== 'audits' && ref.kind !== 'work-orders')) {
      throw new GraphError(`within must be a spec, standard, component, audit, work order or section (got ${r.node.kind})`, 400, 'invalid_scope');
    }
    return live;
  }

  /** The graph node a copied reference denotes (every reference is a node). */
  async resolveRef(input: ResolveRefInput): Promise<ResolvedRef> {
    const inp = resolveRefInputSchema.parse(input);
    await this.ensureFresh();
    const r = await resolveRef(this.ctx, inp.ref, inp.at);
    return { node: r.node, at: pub(r.at) };
  }
  async symbolSearch(input: SymbolSearchInput) {
    await this.ensureFresh();
    return s.symbolSearch(this.ctx, input);
  }
  async codeSearch(input: CodeSearchInput) {
    await this.ensureFresh();
    return s.codeSearch(this.ctx, input);
  }
  async related(input: RelatedInput) {
    await this.ensureFresh();
    if (typeof input?.uri === 'string' && parseNodeUri(input.uri)) {
      // Vectors exist for the current text: versions and excerpts use their live doc / section.
      const r = await resolveRef(this.ctx, input.uri);
      return s.related(this.ctx, { ...input, uri: r.live[0] ?? r.node.uri });
    }
    return s.related(this.ctx, input);
  }
  async metadataQuery(input: MetadataQueryInput) {
    await this.ensureFresh();
    return s.metadataQuery(this.ctx, input);
  }
  async historySearch(input: HistorySearchInput) {
    await this.ensureFresh();
    return s.historySearch(this.ctx, input);
  }

  /* ---------------------------------------------------------------- graph */

  async graphNode(input: GraphNodeInput) {
    await this.ensureFresh();
    return graph.graphNode(this.ctx, input);
  }
  async graphNeighbors(input: GraphNeighborsInput) {
    await this.ensureFresh();
    return graph.graphNeighbors(this.ctx, input);
  }
  async graphPath(input: GraphPathInput) {
    await this.ensureFresh();
    return graph.graphPath(this.ctx, input);
  }
  async graphImpact(input: GraphImpactInput) {
    await this.ensureFresh();
    return graph.graphImpact(this.ctx, input);
  }
  /** Lineage (why / led to), blast radius, where standards are used, rules of a code location (index/lineage.ts). */
  async lineage(input: LineageInput) {
    await this.ensureFresh();
    return lineageOf(this.ctx, input);
  }
  async blastRadius(input: BlastRadiusInput) {
    await this.ensureFresh();
    return blastRadiusOf(this.ctx, input);
  }
  async whereUsed(input: WhereUsedInput) {
    await this.ensureFresh();
    return whereUsedOf(this.ctx, input);
  }
  async contributors(input: ContributorsInput, opts: { agentsOnly?: boolean } = {}) {
    await this.ensureFresh();
    return contributorsOf(this.ctx, input, opts);
  }
  async codeRules(input: CodeRulesInput) {
    await this.ensureFresh();
    return codeRulesOf(this.ctx, input);
  }
  async graphHistory(input: GraphHistoryInput) {
    await this.ensureFresh();
    return graph.graphHistory(this.ctx, input);
  }
  async graphChanges(input: GraphChangesInput) {
    await this.ensureFresh();
    return graph.graphChanges(this.ctx, input);
  }
  async graphEvolution(input: GraphEvolutionInput) {
    await this.ensureFresh();
    return graph.graphEvolution(this.ctx, input);
  }
  /** Rules for a code range, answered from the graph (governs + inherits_rule); equivalent to storage `rulesForCode`. */
  async graphRulesForCode(input: RulesForCodeInput) {
    await this.ensureFresh();
    return graphRulesForCode(this.db, input);
  }
  /** Owning component of a code path from the graph (owned_by edges; owns globs for unknown files); equals storage `ownerOf`. */
  async graphOwnerOf(input: { repo?: string; path: string }) {
    await this.ensureFresh();
    return graphOwnerOf(this.db, input.repo, input.path);
  }
  /** The architecture view node (`mandate://architecture`) at HEAD or `at`, optionally focused: components + depends_on edges. */
  async graphArchitecture(input: { at?: string; focus?: string } = {}) {
    await this.ensureFresh();
    const r = await resolveRef(this.ctx, buildArchitectureRef(input.focus ? { focus: input.focus } : {}), input.at);
    return { ref: r.node.uri, at: pub(r.at), components: r.node.props.components as string[], edges: r.node.props.edges as { from: string; to: string; section?: string }[] };
  }

  /** Read-only Cypher subset over the temporal graph (see graphSchema()). */
  async graphQuery(input: GraphQueryInput) {
    await this.ensureFresh();
    this.runner ??= this.mirror ? new PgCypherRunner(this.mirror.db, this.opts.index.queryTimeoutMs ?? 2000) : new CypherRunner(this.opts.index.path, this.opts.index.queryTimeoutMs ?? 2000);
    return graphQuery(this.ctx, this.runner, input);
  }
  async graphSchema(input: Record<string, never> = {}) {
    await this.ensureFresh();
    return graphSchema(this.ctx, input);
  }

  /** Several service calls in one request; results in order, per-op errors do not fail the batch. */
  async graphBatch(input: GraphBatchInput): Promise<BatchResult[]> {
    const inp = graphBatchInputSchema.parse(input);
    const out: BatchResult[] = [];
    for (const { op, args } of inp.ops) {
      try {
        const fn = (this as unknown as Record<string, (a: unknown) => Promise<unknown>>)[op]!;
        out.push({ op, ok: true, result: await fn.call(this, args) });
      } catch (e) {
        out.push({ op, ok: false, error: toStructuredError(e) });
      }
    }
    return out;
  }

  async graphSearch(input: GraphSearchInput) {
    await this.ensureFresh();
    return graph.graphSearch(this.ctx, input);
  }
}

/** Re-index after every commit or pull made through this GitStore instance. */
export function watchCommits(git: GitStore, onChange: (reason: 'commit' | 'pull') => void): void {
  const commit = git.commit.bind(git);
  git.commit = async (...args) => {
    const id = await commit(...args);
    if (id) onChange('commit');
    return id;
  };
  const pull = git.pull.bind(git);
  git.pull = async () => {
    const moved = await pull();
    if (moved) onChange('pull');
    return moved;
  };
}

/** `{ code, message, hint?, issues? }` for any error a service function throws. */
export function toStructuredError(e: unknown): { code: string; message: string; hint?: string; issues?: unknown } {
  if (e instanceof ZodError) return { code: 'validation', message: 'invalid input', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  if (e instanceof GraphError) return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  if (e instanceof CypherError) return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.pos ? { issues: { line: e.pos.line, column: e.pos.column } } : {}) };
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

/** Fields whose change needs a new provider / queue (the key is compared separately, never logged). */
function embeddingSignature(c: ResolvedEmbeddingConfig): string {
  return JSON.stringify([c.provider, c.baseUrl, c.model, c.dimensions, c.requestDimensions ?? null, c.documentPrefix, c.queryPrefix, c.batchSize, c.maxInputTokens, c.apiKeyEnv]);
}
