/**
 * Projects: each has its own git repo (data dir), SQLite index (FTS, embeddings cache, graph), activity feed, Ask
 * conversations, idempotency store and integrity state. Runtimes are opened lazily on first use and cached.
 */
import type { AppConfig, ProjectConfig, RemoteConfig } from '../config.js';
import { ConversationStore } from '../ask/agent.js';
import type { AskModelOverride } from '../ask/model.js';
import { ActivityBus } from '../events/index.js';
import { createGitStore, SubdirGitStore, type GitStore } from '../git/index.js';
import { AutoPusher, type PushGate } from '../git/autopush.js';
import { IndexService, watchCommits } from '../index/service.js';
import type { EmbeddingProvider } from '../index/embed/index.js';
import type { IdempotencyStore, ToolContext } from '../mcp/define.js';
import { FileIdempotencyStore } from '../mcp/idempotency.js';
import { createStorage, type Storage } from '../storage/index.js';
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
  close(): Promise<void>;
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
    readonly defaultProject: string = projects[0]?.id ?? 'default',
  ) {
    this.byId = new Map(projects.map((p) => [p.id, p]));
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

  async close(): Promise<void> {
    for (const r of await this.opened()) await r.close().catch(() => undefined);
    this.runtimes.clear();
  }
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

export interface OpenerOptions {
  log?: Log;
  askModel?: AskModelOverride;
  /** Override the embedding provider (tests: FakeProvider). */
  provider?: EmbeddingProvider | null;
  /** Activity HEAD poll interval (default 3 s; 0 disables). */
  activityPollMs?: number;
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
}

/** The standard opener: git store, storage, index, activity feed and tool context from the app config. */
export function projectOpener(app: Pick<AppConfig, 'embedding' | 'ask'>, o: OpenerOptions = {}): ProjectOpener {
  return async (p) => {
    const remote = p.remote ?? (p.github ? o.githubRemote?.(p) : undefined);
    const repoGit = createGitStore({ ...p, ...(remote ? { remote } : {}) });
    // A project in a folder of a shared repo: storage paths are relative to the folder.
    const git: GitStore = p.github?.path ? new SubdirGitStore(repoGit, p.github.path) : repoGit;
    try {
      await git.openOrCreate();
    } catch (e) {
      throw new Error(`project '${p.id}': cannot open the data repository ${p.dataDir} (git backend "${p.git.backend}"): ${(e as Error).message}`);
    }
    const storage = createStorage(git);
    let index: IndexService | null = null;
    try {
      index = new IndexService({ git, storage, index: p.index, embedding: app.embedding, ...(o.provider !== undefined ? { provider: o.provider } : {}), ...(o.log ? { log: o.log as never } : {}) });
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
    const idempotency: IdempotencyStore | undefined = p.idempotencyFile ? new FileIdempotencyStore(p.idempotencyFile) : undefined;
    const ctx: ToolContext = {
      project: { id: p.id, name: p.name },
      storage,
      index,
      reads: new DocReadService(storage),
      views: new DocViewService(storage),
      ask: app.ask,
      activity,
      conversations: new ConversationStore(),
      autoPush,
      ...(idempotency ? { idempotency } : {}),
      ...(o.askModel ? { askModel: o.askModel } : {}),
    };
    if (index && o.startIndex !== false) {
      o.log?.info(`project '${p.id}': data dir ${p.dataDir}; index ${p.index.path}`);
      index.start().catch((e: Error) => o.log?.error(`project '${p.id}': index sync failed: ${e.message}`));
    }
    return {
      config: p,
      git,
      storage,
      index,
      activity,
      autoPush,
      ctx,
      async close() {
        autoPush.stop();
        activity.stop();
        index?.close();
      },
    };
  };
}
