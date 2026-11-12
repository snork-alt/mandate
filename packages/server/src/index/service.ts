import { ZodError } from 'zod';
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
import type { EmbeddingConfig, IndexConfig } from '../config.js';
import type { GitStore } from '../git/GitStore.js';
import { componentFormat, sectionTypes, specFormat, standardFormat } from '../storage/codecs.js';
import type { Storage } from '../storage/index.js';
import { SCHEMA_VERSION, json, openIndexDb, type DB } from './db.js';
import { createProvider, modelIdFor, type EmbeddingProvider } from './embed/index.js';
import { PRIORITY, resetQueueState, retryFailed, type JobInfo, type JobStatus } from './embed/jobs.js';
import { EmbedQueue, type EmbedQueueStatus } from './embed/queue.js';
import type { ExtractContext } from './extract.js';
import * as graph from './graph.js';
import { graphOwnerOf, graphRulesForCode } from './rules.js';
import { CypherError, CypherRunner, graphQuery, graphSchema } from './cypher/index.js';
import { GraphError, pub, resolveRef } from './resolve.js';
import { Indexer, type SyncResult } from './indexer.js';
import * as s from './search.js';

export interface IndexServiceOptions {
  git: GitStore;
  /** For derived metadata (outdated sections). */
  storage?: Storage;
  index: Omit<IndexConfig, 'queryTimeoutMs' | 'embedMaxAttempts'> & { queryTimeoutMs?: number; embedMaxAttempts?: number };
  embedding: EmbeddingConfig & { apiKey?: string };
  /** Override the configured provider (tests: FakeProvider; null disables semantic search). */
  provider?: EmbeddingProvider | null;
  /** Minimum cosine similarity for `similar_to` edges. */
  similarThreshold?: number;
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/**
 * The search index: one SQLite file (better-sqlite3 + sqlite-vec) kept in sync with git.
 * Every search, graph and index operation is a method taking the zod-validated input of
 * `@mandate/shared`, so the MCP tools wrap them 1:1.
 */
export class IndexService {
  readonly db: DB;
  readonly provider: EmbeddingProvider | null;
  readonly queue: EmbedQueue | null;
  private readonly indexer: Indexer;
  private readonly ctx: graph.GraphContext;
  private chain: Promise<unknown> = Promise.resolve();
  private building = false;
  private timer?: NodeJS.Timeout;
  /** Highest embedding priority among the commits waiting for the debounced sync. */
  private scheduled: number | null = null;
  private closed = false;
  private runner?: CypherRunner;

  constructor(private readonly opts: IndexServiceOptions) {
    this.db = openIndexDb(opts.index.path);
    this.provider = opts.provider !== undefined ? opts.provider : createProvider(opts.embedding);
    const formats = { specs: specFormat as DocFormat<unknown, unknown>, standards: standardFormat as DocFormat<unknown, unknown>, components: componentFormat as DocFormat<unknown, unknown> };
    const extract: ExtractContext = {
      formats,
      chunk: { chunkTargetTokens: opts.index.chunkTargetTokens, chunkOverlapTokens: opts.index.chunkOverlapTokens, registry: sectionTypes },
    };
    // The queue first: it creates the vec0 table, recovers jobs a crash left running and backfills on a new model.
    this.queue = this.provider
      ? new EmbedQueue(this.db, this.provider, {
          batchSize: opts.embedding.batchSize,
          documentPrefix: opts.embedding.documentPrefix,
          maxInputTokens: opts.embedding.maxInputTokens,
          maxAttempts: opts.index.embedMaxAttempts ?? 6,
          onDrained: () => this.recomputeSimilar(),
          onError: (e) => opts.log?.warn(`embedding: ${e.message}`),
        })
      : null;
    if (!this.provider) resetQueueState(this.db);
    this.indexer = new Indexer(this.db, opts.git, extract, this.queue?.target ?? null);
    if (this.provider) this.db.prepare('UPDATE index_state SET model_id = ? WHERE id = 1').run(this.provider.modelId);
    const storage = opts.storage;
    this.ctx = {
      db: this.db,
      provider: this.provider,
      queryPrefix: opts.embedding.queryPrefix,
      vecTable: this.queue?.table ?? null,
      pending: () => this.queue?.pending() ?? 0,
      outdatedSections: storage
        ? async (id) =>
            Object.entries(await storage.queueService.implementation(id))
              .filter(([, v]) => v.outdated)
              .map(([k]) => k)
        : undefined,
      git: opts.git,
      formats,
    };
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
    const e = this.opts.embedding;
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
  }

  close(): void {
    this.closed = true;
    void this.runner?.close();
    clearTimeout(this.timer);
    this.queue?.stop();
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
    if (!ref || (ref.kind !== 'specs' && ref.kind !== 'standards' && ref.kind !== 'components')) {
      throw new GraphError(`within must be a spec, standard, component or section (got ${r.node.kind})`, 400, 'invalid_scope');
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
    this.runner ??= new CypherRunner(this.opts.index.path, this.opts.index.queryTimeoutMs ?? 2000);
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
