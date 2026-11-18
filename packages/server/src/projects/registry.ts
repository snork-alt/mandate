/**
 * Projects: each has its own git repo (data dir), SQLite index (FTS, embeddings cache, graph), activity feed, Ask
 * conversations, idempotency store and integrity state. Runtimes are opened lazily on first use and cached.
 */
import type { ProjectSettings } from './settings.js';
import { mandateHome, type AppConfig, type GitBackendConfig, type ProjectConfig, type RemoteConfig } from '../config.js';
import { catchUpAssigned } from '../flow/assign.js';
import { AskService, DbAskStore, MemoryAskStore } from '../agent-ask/service.js';
import { ActivityBus } from '../events/index.js';
import { DbNewsStore, MemoryNewsStore, NewsService } from '../news/index.js';
import { createGitStore, SubdirGitStore, type GitStore } from '../git/index.js';
import { SwappableGitStore } from '../git/SwappableGitStore.js';
import { AutoPusher, type PushGate } from '../git/autopush.js';
import { IndexService, watchCommits } from '../index/service.js';
import type { EmbeddingProvider } from '../index/embed/index.js';
import type { IdempotencyStore, ToolContext } from '../mcp/define.js';
import { FileIdempotencyStore } from '../mcp/idempotency.js';
import { DbIdempotencyStore } from '../db/idempotency.js';
import type { ServerState } from '../db/state.js';
import { projectWriteLock } from '../db/write-lock.js';
import { indexDb } from '../db/pg-index/mirror.js';
import type { PostgresDb } from '../db/postgres.js';
import { unwrapDb } from '../db/swappable.js';
import { createStorage, MemoryHeartbeats, migrateWorkOrders, SqliteHeartbeats, type HeartbeatStore, type Storage } from '../storage/index.js';
import { wiringResolver } from '../storage/code-repos.js';
import { DocReadService } from '../storage/read.js';
import { DocViewService } from '../storage/views.js';

export interface ProjectRuntime {
  config: ProjectConfig;
  git: GitStore;
  storage: Storage;
  /** Null when the index failed to open (search / graph tools then report `index_unavailable`). */
  index: IndexService | null;
  activity: ActivityBus;
  /** Background push of this project's commits. */
  autoPush?: AutoPusher;
  /** Base tool context of this project (sessions add their own state and principal). */
  ctx: ToolContext;
  /**
   * Prepare another git backend for this project (Settings → Git backend): the new store is created and opened now;
   * `commit` swaps it in under the project's write lock (in-flight reads finish on the old store, which is then
   * closed). Null when the backend settings did not change.
   */
  prepareGit?(next: GitBackendConfig): Promise<PreparedSwap | null>;
  close(): Promise<void>;
}

export interface PreparedSwap {
  commit(): Promise<void>;
  abort(): void;
}

/** Public summary of a project (no secrets: the remote URL is shown without credentials). */
export interface ProjectInfo {
  id: string;
  name: string;
  description?: string;
  dataDir: string;
  branch: string;
  remote: string | null;
  mcpPath: string;
  /** GitHub storage and whether its token still works ('reconnect': sign in again; the project keeps working locally). */
  github: { repo: string; path: string | null; connectedBy: string; status: 'ok' | 'reconnect' } | null;
}

export type ProjectOpener = (p: ProjectConfig) => Promise<ProjectRuntime>;

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class ProjectRegistry {
  private readonly byId: Map<string, ProjectConfig>;
  private readonly runtimes = new Map<string, Promise<ProjectRuntime>>();
  private readonly openedHooks = new Set<(r: ProjectRuntime) => void>();
  /** Token state of a GitHub login (set by the server; default: ok). */
  tokenStatus: (login: string) => 'ok' | 'reconnect' = () => 'ok';
  /** Re-validate GitHub tokens of connected projects before listing (set by the server). */
  refreshTokens: (logins: string[]) => Promise<void> = async () => undefined;

  constructor(
    projects: ProjectConfig[],
    private readonly opener: ProjectOpener,
    private readonly configuredDefault: string = projects[0]?.id ?? '',
  ) {
    this.byId = new Map(projects.map((p) => [p.id, p]));
  }

  /** The default project (legacy URLs): the configured one while registered, else the first project, '' with none. */
  get defaultProject(): string {
    return this.byId.has(this.configuredDefault) ? this.configuredDefault : ([...this.byId.keys()][0] ?? '');
  }

  list(): ProjectConfig[] {
    return [...this.byId.values()];
  }

  config(id: string): ProjectConfig | undefined {
    return this.byId.get(id);
  }

  info(id: string): ProjectInfo | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    return {
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      dataDir: p.dataDir,
      branch: p.branch,
      remote: p.remote ? redactUrl(p.remote.url) : null,
      mcpPath: `/p/${p.id}/mcp`,
      github: p.github ? { repo: p.github.repo, path: p.github.path ?? null, connectedBy: p.github.connectedBy, status: this.tokenStatus(p.github.connectedBy) } : null,
    };
  }

  /** Register a project at runtime (UI project creation). */
  add(p: ProjectConfig): void {
    if (this.byId.has(p.id)) throw new Error(`project '${p.id}' already exists`);
    this.byId.set(p.id, p);
  }

  /**
   * Apply a re-read registry (projects.json edited outside the server): new projects are added, removed ones closed
   * (data untouched), changed ones reopen on next use.
   */
  async sync(next: ProjectConfig[]): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const out = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
    const ids = new Set(next.map((p) => p.id));
    for (const id of [...this.byId.keys()]) {
      if (!ids.has(id)) {
        await this.remove(id);
        out.removed.push(id);
        // Deleted from the registry: derived per-project state (the Postgres index schema) goes too.
        await this.onProjectRemoved?.(id).catch(() => undefined);
      }
    }
    for (const p of next) {
      const cur = this.byId.get(p.id);
      if (!cur) {
        this.byId.set(p.id, p);
        out.added.push(p.id);
      } else if (JSON.stringify({ ...cur, remote: undefined }) !== JSON.stringify({ ...p, remote: undefined })) {
        await this.remove(p.id);
        this.byId.set(p.id, p);
        out.changed.push(p.id);
      }
    }
    return out;
  }

  /** A project was deleted from the registry (not merely changed): drop derived state such as its Postgres index. */
  onProjectRemoved?: (id: string) => Promise<void>;

  /** Unregister (closes its runtime; never deletes data). */
  async remove(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    this.runtimes.delete(id);
    this.byId.delete(id);
    if (rt) await rt.then((r) => r.close()).catch(() => undefined);
  }

  /** Called once per runtime when it is first opened (the MCP hub subscribes to its activity feed). */
  onOpened(fn: (r: ProjectRuntime) => void): () => void {
    this.openedHooks.add(fn);
    return () => this.openedHooks.delete(fn);
  }

  /** The project's runtime (opened on first use; a failed open is retried on the next call). */
  open(id: string): Promise<ProjectRuntime> {
    const cfg = this.byId.get(id);
    if (!cfg) return Promise.reject(new Error(`unknown project '${id}'`));
    let p = this.runtimes.get(id);
    if (!p) {
      p = this.opener(cfg).then((r) => {
        for (const fn of this.openedHooks) fn(r);
        return r;
      });
      p.catch(() => this.runtimes.delete(id));
      this.runtimes.set(id, p);
    }
    return p;
  }

  /** Runtimes opened so far. */
  async opened(): Promise<ProjectRuntime[]> {
    const all = await Promise.allSettled(this.runtimes.values());
    return all.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  }

  /**
   * Apply new git backend settings (config.json `git.backend` / `git.cliPath`) to every project without a restart.
   * All-or-nothing: every opened project's new store is prepared (opened) first; any failure keeps every project on its
   * current backend and throws. Projects opened later use the new settings. Returns the ids that switched.
   */
  async reconfigureGit(next: ProjectConfig[]): Promise<string[]> {
    const byNext = new Map(next.map((p) => [p.id, p]));
    const before = new Map(this.byId);
    for (const [id, cfg] of this.byId) {
      const n = byNext.get(id);
      if (n) this.byId.set(id, { ...cfg, git: n.git });
    }
    const prepared: { id: string; swap: PreparedSwap }[] = [];
    try {
      for (const rt of await this.opened()) {
        const n = byNext.get(rt.config.id);
        const swap = n && rt.prepareGit ? await rt.prepareGit(n.git) : null;
        if (swap) prepared.push({ id: rt.config.id, swap });
      }
    } catch (e) {
      for (const p of prepared) p.swap.abort();
      for (const [id, cfg] of before) if (this.byId.has(id)) this.byId.set(id, cfg);
      throw e;
    }
    for (const p of prepared) await p.swap.commit();
    return prepared.map((p) => p.id);
  }

  /** Close every opened runtime and open it again (after the server-state database switched). */
  async reopen(): Promise<string[]> {
    const ids = [...this.runtimes.keys()];
    for (const id of ids) {
      const rt = this.runtimes.get(id);
      this.runtimes.delete(id);
      await rt?.then((r) => r.close()).catch(() => undefined);
    }
    await Promise.allSettled(ids.filter((id) => this.byId.has(id)).map((id) => this.open(id)));
    return ids;
  }

  async close(): Promise<void> {
    for (const r of await this.opened()) await r.close().catch(() => undefined);
    this.runtimes.clear();
  }
}

const gitSignature = (g: GitBackendConfig) => JSON.stringify([g.backend, g.cliPath ?? null, g.cliEnv ?? null]);

export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

export interface OpenerOptions {
  log?: Log;
  /** Override the embedding provider (tests: FakeProvider). */
  provider?: EmbeddingProvider | null;
  /** Activity HEAD poll interval (default 3 s; 0 disables). */
  activityPollMs?: number;
  /** Full integrity re-check interval (default 10 min, MANDATE_INTEGRITY_INTERVAL_MS; 0 disables the timer). */
  integrityIntervalMs?: number;
  /** Start the index sync in the background after opening (default true). */
  startIndex?: boolean;
  /** Remote of a GitHub-backed project (HTTPS URL + token getter from the token store). */
  githubRemote?: (p: ProjectConfig) => RemoteConfig | undefined;
  /** Extra auto-push conditions per project (GitHub token revoked → reconnect). */
  pushGate?: (p: ProjectConfig) => ReturnType<PushGate>;
  /** The remote rejected a push's credentials. */
  onPushAuthError?: (p: ProjectConfig) => void;
  /** Test overrides for the auto-push timers (ms). */
  autoPushTimers?: { debounceMs?: number; intervalMs?: number };
  /** Per-project agent settings (projects.json `flow`). */
  settings?: (p: ProjectConfig) => ProjectSettings;
  /** Server-state database: durable idempotency results live there (else a JSON file next to the index). */
  serverState?: ServerState;
  /**
   * Postgres: publish each project's index to its schema (`mandate_<id>`, or prefixed tables) and query it there. A
   * function is read at every open (the database can switch at runtime).
   */
  pgIndex?: { schemaPerProject: boolean | 'prefix' } | (() => { schemaPerProject: boolean | 'prefix' } | undefined);
}

/** The standard opener: git store, storage, index, activity feed and tool context from the app config. */
export function projectOpener(app: Pick<AppConfig, 'embedding'> & { publicUrl?: string }, o: OpenerOptions = {}): ProjectOpener {
  return async (p) => {
    const remote = p.remote ?? (p.github ? o.githubRemote?.(p) : undefined);
    // Behind a switch so the backend can change at runtime (prepareGit).
    const repoGit = new SwappableGitStore(createGitStore({ ...p, ...(remote ? { remote } : {}) }));
    // A project in a folder of a shared repo: storage paths are relative to the folder.
    const git: GitStore = p.github?.path ? new SubdirGitStore(repoGit, p.github.path) : repoGit;
    try {
      await git.openOrCreate();
    } catch (e) {
      throw new Error(`project '${p.id}': cannot open the data repository ${p.dataDir} (git backend "${p.git.backend}"): ${(e as Error).message}`);
    }
    // Claim heartbeats: runtime state next to the index (never committed); in memory with an in-memory index.
    let heartbeats: HeartbeatStore = new MemoryHeartbeats();
    if (p.index.path && p.index.path !== ':memory:') {
      try {
        heartbeats = new SqliteHeartbeats(`${p.index.path}.runtime.sqlite`);
      } catch (e) {
        o.log?.error(`project '${p.id}': runtime state (claim heartbeats) in memory: ${(e as Error).message}`);
      }
    }
    // Shared database (Postgres): the write lock is an advisory lock, so instances sharing the data repo serialize.
    const storage = createStorage(git, { heartbeats, lock: projectWriteLock(o.serverState?.db, p.id) });
    // One-time, idempotent: work-orders.jsonl -> work-orders/<id>.md (one commit). A failure keeps the jsonl readable.
    try {
      await migrateWorkOrders({ git, lock: storage.lock, history: storage.history, heartbeats, log: (m) => o.log?.info(`project '${p.id}': ${m}`) });
    } catch (e) {
      o.log?.error(`project '${p.id}': work order migration failed (work orders stay read-only in work-orders.jsonl): ${(e as Error).message}`);
    }
    let index: IndexService | null = null;
    try {
      const pgIndex = typeof o.pgIndex === 'function' ? o.pgIndex() : o.pgIndex;
      const pgDb = pgIndex && o.serverState?.db.driver === 'postgres' ? indexDb(unwrapDb(o.serverState.db) as PostgresDb, p.id, pgIndex.schemaPerProject) : null;
      index = new IndexService({ git, storage, index: p.index, embedding: app.embedding, ...(pgDb ? { postgres: { db: pgDb, projectId: p.id } } : {}), ...(o.provider !== undefined ? { provider: o.provider } : {}), ...(o.log ? { log: o.log as never } : {}) });
      const idx = index;
      watchCommits(git, (why) => idx.schedule(why));
    } catch (e) {
      o.log?.error(`project '${p.id}': search index disabled: ${(e as Error).message}`);
    }
    const activity = new ActivityBus(git, { ...(o.log ? { log: o.log } : {}), ...(o.activityPollMs !== undefined ? { pollMs: o.activityPollMs } : {}) });
    // Background push after commits (debounced) + periodic sweep; never force; only inside this project's own repo.
    const autoPush = new AutoPusher({
      git,
      lock: storage.lock,
      config: p.autoPush,
      gate: () => o.pushGate?.(p) ?? null,
      emit: (e) => activity.emit(e),
      onAuthError: () => o.onPushAuthError?.(p),
      ...(o.log ? { log: o.log } : {}),
      ...(o.autoPushTimers ?? {}),
    });
    await activity.start();
    autoPush.start();
    // Integrity, always checked: startup + periodic full re-checks; after outside commits / pulls / merges (HEAD moved
    // past the report: incremental updates of our own writes keep it current); changes go out as integrity.changed.
    const integrity = storage.integrity;
    integrity.onChange((r, counts, delta) =>
      activity.emit({
        id: `${r.head ?? 'none'}:integrity:${Date.now()}`,
        commit: r.head ?? '',
        type: 'integrity.changed',
        at: r.at,
        refs: [...new Set([...delta.introduced, ...delta.resolved].map((i) => i.uri))].slice(0, 50),
        summary: `Integrity: ${counts.errors} error${counts.errors === 1 ? '' : 's'}, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} (+${delta.introduced.length} / -${delta.resolved.length})`,
        details: { ...counts, introduced: delta.introduced.length, resolved: delta.resolved.length },
      }),
    );
    watchCommits(git, () => integrity.scheduleSync());
    // Outside commits (found by the activity HEAD poll) and pulls: re-check when HEAD moved past the report.
    activity.subscribe((e) => {
      if (e.type !== 'integrity.changed' && e.type !== 'git.pushed' && e.type !== 'git.push_failed') integrity.scheduleSync();
    });
    const envMs = Number(process.env.MANDATE_INTEGRITY_INTERVAL_MS);
    integrity.start(o.integrityIntervalMs ?? (Number.isFinite(envMs) && process.env.MANDATE_INTEGRITY_INTERVAL_MS ? envMs : 10 * 60_000));
    const idempotency: IdempotencyStore | undefined = !p.idempotencyFile ? undefined : o.serverState ? new DbIdempotencyStore(o.serverState, p.id, p.idempotencyFile) : new FileIdempotencyStore(p.idempotencyFile);
    const news = new NewsService(p.id, o.serverState ? new DbNewsStore(o.serverState.db) : new MemoryNewsStore(), activity);
    // Requests assigned to an agent (from the web UI): an agent that connects is caught up on what waits for it.
    news.presence.onConnect((client) => void catchUpAssigned(news, client, () => storage.feedbackService.list()).catch((e) => console.error('request catch-up failed', e)));
    const ctx: ToolContext = {
      project: { id: p.id, name: p.name },
      storage,
      index,
      reads: new DocReadService(storage),
      views: new DocViewService(storage),
      activity,
      // Per-client news (server-state database), fed by this project's activity events.
      news,
      // Ask threads: answered by the user's coding agents (no model on the server).
      asks: new AskService(p.id, o.serverState ? new DbAskStore(o.serverState.db) : new MemoryAskStore(), news),
      autoPush,
      ...(idempotency ? { idempotency } : {}),
      ...(o.settings ? { settings: o.settings(p) } : {}),
      // Mandate on this computer only (a loopback URL): code repos wired with `mandate connect` (work_order_touch_from_commits).
      ...(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(app.publicUrl ?? 'http://localhost') ? { codeRepos: wiringResolver(mandateHome(), p.id) } : {}),
    };
    if (index && o.startIndex !== false) {
      o.log?.info(`project '${p.id}': data dir ${p.dataDir}; index ${p.index.path}`);
      index.start().catch((e: Error) => o.log?.error(`project '${p.id}': index sync failed: ${e.message}`));
    }
    const rt: ProjectRuntime = {
      config: p,
      git,
      storage,
      index,
      activity,
      autoPush,
      ctx,
      async prepareGit(nextGit) {
        if (gitSignature(nextGit) === gitSignature(rt.config.git)) return null;
        const store = createGitStore({ ...rt.config, git: nextGit, ...(remote ? { remote } : {}) });
        const closeStore = () => (store as { close?: () => void }).close?.();
        try {
          await store.open();
          await store.head();
        } catch (e) {
          closeStore();
          throw new Error(`project '${p.id}': the git backend "${nextGit.backend}"${nextGit.backend === 'cli' ? ` (${nextGit.cliPath ?? 'git'})` : ''} cannot open ${p.dataDir}: ${(e as Error).message}`);
        }
        return {
          abort: closeStore,
          async commit() {
            // The write lock drains in-flight writes; reads already running finish on the old store (closed after).
            await storage.lock.run(async () => {
              void repoGit.swap(store);
            });
            rt.config = { ...rt.config, git: nextGit };
            o.log?.info(`project '${p.id}': git backend now ${nextGit.backend}`);
            integrity.scheduleSync();
          },
        };
      },
      async close() {
        autoPush.stop();
        storage.integrity.stop();
        activity.stop();
        index?.close();
        heartbeats.close?.();
      },
    };
    return rt;
  };
}
