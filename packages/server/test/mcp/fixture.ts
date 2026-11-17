/** MCP test fixture: a clone of the seeded data, a fresh index (fake embeddings), Fastify with /mcp and an SDK client over Streamable HTTP. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { FakeProvider } from '../../src/index/embed/index.js';
import { IndexService } from '../../src/index/service.js';
import { registerMcp, type McpHub } from '../../src/mcp/index.js';
import type { ToolContext } from '../../src/mcp/define.js';
import type { UploadService } from '../../src/mcp/uploads.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { ProjectRegistry, type ProjectRuntime } from '../../src/projects/registry.js';
import type { ProjectConfig } from '../../src/config.js';
import { randomBytes } from 'node:crypto';
import { ActivityBus } from '../../src/events/index.js';
import { createStorage, migrateWorkOrders, type Storage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { stepsOf } from '@mandate/shared';
import { sectionBody } from '../../src/storage/work-order-docs.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../../data/repo');

export interface McpFixture {
  dir: string;
  git: EsGitStore;
  storage: Storage;
  index: IndexService;
  reads: DocReadService;
  app: FastifyInstance;
  hub: McpHub;
  activity: ActivityBus;
  served: ServedProjects;
  url: URL;
  client: Client;
  /** Older tests complete work orders without caring about plan steps: finish them first (work-order-steps.test.ts turns this off). */
  finishSteps: boolean;
  /** Full sha of HEAD and of an older commit that changed specs/login-sso.md. */
  head: string;
  older: string;
  /** Call a tool; returns { isError, body } (body = structuredContent). */
  call(name: string, args?: unknown): Promise<{ isError: boolean; body: Record<string, any> }>;
  close(): Promise<void>;
}

/** Bearer key per endpoint URL (set by `serveProjects`), so `connect(url)` authenticates like an agent. */
const keyByUrl = new Map<string, string>();

export async function connect(url: URL, name = 'mandate-test', key: string | null | undefined = keyByUrl.get(url.href) ?? keyByUrl.get(`${url.origin}${url.pathname}`)): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined));
  return client;
}

export interface ServedProjects {
  app: FastifyInstance;
  hub: McpHub;
  registry: ProjectRegistry;
  keys: KeyStore;
  store: AuthStore;
  home: string;
  url(id: string): URL;
  key(id: string): string;
  close(): Promise<void>;
}

/** Fastify with per-project MCP endpoints over prebuilt tool contexts; one agent key per project in a temp keys.json. */
export async function serveProjects(contexts: Record<string, ToolContext>, opts: { app?: FastifyInstance; uploads?: UploadService } = {}): Promise<ServedProjects> {
  const home = await tempDir();
  const keys = new KeyStore(path.join(home, 'keys.json'), { touchIntervalMs: 0 });
  keys.ensureProjectKeys(Object.keys(contexts));
  const store = new AuthStore(home, randomBytes(32), 3600_000);
  const configs: ProjectConfig[] = Object.keys(contexts).map((id) => ({ id, name: id, dataDir: contexts[id]!.storage.git.dir, branch: 'main', author: { name: 'T', email: 't@x' }, git: { backend: 'embedded', cliPath: 'git', cliEnv: {} }, index: {} as ProjectConfig['index'], idempotencyFile: '', autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 } }));
  const registry = new ProjectRegistry(configs, async (p) => {
    const ctx = contexts[p.id]!;
    return { config: p, git: ctx.storage.git, storage: ctx.storage, index: ctx.index, activity: ctx.activity!, ctx: { presetIds: true, ...ctx, project: { id: p.id, name: p.name } }, close: async () => undefined } as ProjectRuntime;
  });
  const app = opts.app ?? Fastify({ logger: false });
  const hub = registerMcp(app, { projects: registry, auth: { keys, store }, ...(opts.uploads ? { uploads: opts.uploads } : {}) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const url = (id: string) => new URL(`http://127.0.0.1:${port}/p/${id}/mcp`);
  const key = (id: string) => keys.list().find((k) => k.project === id)!.key;
  for (const id of Object.keys(contexts)) keyByUrl.set(url(id).href, key(id));
  return { app, hub, registry, keys, store, home, url, key, close: () => app.close() };
}

export async function mcpFixture(extra: Partial<ToolContext> = {}): Promise<McpFixture> {
  const root = await tempDir();
  const dir = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', SOURCE, dir]);
  const git = new EsGitStore({ dir, author: { name: 'Test', email: 'test@example.com' } });
  await git.open();
  const storage = createStorage(git);
  // As on server startup: work-orders.jsonl -> work-orders/<id>.md (no-op once the data repo is migrated).
  await migrateWorkOrders({ git, lock: storage.lock, history: storage.history, heartbeats: storage.heartbeats });
  const index = new IndexService({
    git,
    storage,
    index: { path: path.join(root, 'index.sqlite'), chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 },
    embedding: {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1/v1',
      model: 'fake',
      apiKeyEnv: null,
      dimensions: 64,
      maxInputTokens: 2048,
      batchSize: 64,
      documentPrefix: '',
      queryPrefix: '',
    },
    provider: new FakeProvider(64, 'fake:64'),
  });
  await index.start();
  await index.idle();
  const activity = new ActivityBus(git, { pollMs: 0 });
  await activity.start();
  const served = await serveProjects({ test: { storage, index, activity, reads: new DocReadService(storage), views: new DocViewService(storage), ...extra } });
  const { app, hub } = served;
  const url = served.url('test');
  const client = await connect(url);
  const history = await storage.history.log('specs/login-sso.md');
  const head = (await git.head())!;
  const older = history[Math.min(2, history.length - 1)]!.commit;
  const fixture: McpFixture = {
    dir,
    git,
    storage,
    index,
    reads: new DocReadService(storage),
    app,
    hub,
    activity,
    served,
    url,
    client,
    head,
    older,
    finishSteps: true,
    async call(name, args) {
      if (name === 'work_order_complete' && fixture.finishSteps) await finishAllSteps(storage, String((args as { ref?: string }).ref ?? ''), (args as { agent?: string }).agent);
      const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
      return { isError: !!r.isError, body: (r.structuredContent ?? {}) as Record<string, any> };
    },
    async close() {
      await client.close().catch(() => undefined);
      await app.close();
      activity.stop();
      index.close();
      await cleanupTempDirs();
    },
  };
  return fixture;
}

/** Older tests complete work orders without caring about plan steps: set the unfinished ones done (as the claim holder). */
export async function finishAllSteps(storage: Storage, ref: string, agent?: string): Promise<void> {
  const id = ref.split('/').pop()!;
  const doc = await storage.workOrderService.doc(id).catch(() => null);
  const open = doc ? stepsOf(doc, sectionBody(doc, 'plan')).filter((x) => x.status === 'pending' || x.status === 'in_progress') : [];
  if (doc && open.length) await storage.workOrderService.stepSet(id, doc.claim?.agent ?? agent ?? 'agent', open.map((x) => ({ step: x.id, status: 'done' as const })), {}, { sync: false }).catch(() => undefined);
}
