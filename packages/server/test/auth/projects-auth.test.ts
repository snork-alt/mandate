/** Per-project MCP endpoints with auth: keys (own project only, hot revoke), the read-only UI session, isolation, 404. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { loggerOptions } from '../../src/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import { FakeProvider } from '../../src/index/embed/index.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, projectOpener } from '../../src/projects/registry.js';
import { embeddingConfigSchema, indexConfigSchema, type ProjectConfig } from '../../src/config.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

export function testProject(root: string, id: string): ProjectConfig {
  return {
    id,
    name: `Project ${id}`,
    dataDir: path.join(root, id, 'repo'),
    branch: 'main',
    author: { name: 'Test', email: 'test@example.com' },
    git: { backend: 'embedded', cliPath: 'git', cliEnv: {} },
    index: indexConfigSchema.parse({ path: path.join(root, id, 'index.sqlite') }),
    idempotencyFile: path.join(root, id, 'idem.json'),
    autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 },
  };
}

let app: FastifyInstance;
let base: string;
let keys: KeyStore;
let store: AuthStore;
let registry: ProjectRegistry;
const logs: string[] = [];
const clients: Client[] = [];

const keyOf = (p: string) => keys.list().find((k) => k.project === p)!.key;

async function client(project: string, key: string | null, name = 'agent-x'): Promise<Client> {
  const c = new Client({ name, version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/p/${project}/mcp`), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined));
  clients.push(c);
  return c;
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } };
async function raw(pathname: string, headers: Record<string, string> = {}, body: unknown = init) {
  const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, sid: res.headers.get('mcp-session-id') };
}

beforeAll(async () => {
  const root = await tempDir();
  keys = new KeyStore(path.join(root, 'keys.json'), { touchIntervalMs: 0, log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  keys.ensureProjectKeys(['alpha', 'beta']);
  store = new AuthStore(root, randomBytes(32), 3600_000);
  const embedding = { ...embeddingConfigSchema.parse({}), dimensions: 64 };
  registry = new ProjectRegistry([testProject(root, 'alpha'), testProject(root, 'beta')], projectOpener({ embedding, ask: { default: null, models: [] } }, { provider: new FakeProvider(64, 'fake:64'), activityPollMs: 0 }));
  app = Fastify({ logger: loggerOptions({ write: (l: string) => logs.push(l) }) });
  registerMcp(app, { projects: registry, auth: { keys, store } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await app.close();
  await registry.close();
  await cleanupTempDirs();
});

const SPEC = { title: 'Only in alpha', summary: 'A spec.', sections: [{ title: 'Overview', summary: 'What.', body: 'Body.' }] };

describe('agent keys', () => {
  it('rejects a missing key, a malformed header and a wrong key with 401 JSON-RPC errors', async () => {
    for (const h of [{} as Record<string, string>, { authorization: 'Basic abc' }, { authorization: `Bearer mnd_alpha_${'x'.repeat(43)}` }]) {
      const r = await raw('/p/alpha/mcp', h);
      expect(r.status).toBe(401);
      expect(JSON.parse(r.text)).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
    }
  });

  it("refuses another project's key", async () => {
    expect((await raw('/p/alpha/mcp', { authorization: `Bearer ${keyOf('beta')}` })).status).toBe(401);
    expect((await raw('/p/beta/mcp', { authorization: `Bearer ${keyOf('beta')}` })).status).toBe(200);
  });

  it('answers 404 for an unknown project', async () => {
    const r = await raw('/p/nope/mcp', { authorization: `Bearer ${keyOf('alpha')}` });
    expect(r.status).toBe(404);
    expect(r.text).toContain("unknown project 'nope'");
  });

  it('reads and writes its own project; the write records the key name, never the key', async () => {
    const c = await client('alpha', keyOf('alpha'));
    const tools = await c.listTools();
    // The default list is the core set; spec_create (a hidden alias of create) is still callable by name.
    expect(tools.tools.some((t) => t.name === 'tools_enable')).toBe(true);
    expect(tools.tools.some((t) => t.name === 'spec_create')).toBe(false);
    const w = await c.callTool({ name: 'spec_create', arguments: SPEC });
    expect(w.isError).toBeFalsy();
    const act = (await c.callTool({ name: 'activity_list', arguments: { limit: 5 } })).structuredContent as { events: { source?: string; agent?: string }[] };
    expect(act.events[0]).toMatchObject({ source: 'default', agent: 'agent-x' });
    expect(JSON.stringify(act)).not.toContain(keyOf('alpha'));
    const rt = await registry.open('alpha');
    const head = (await rt.git.log(1))[0]!;
    expect(head.message).toContain('Agent-Key: default');
    expect(head.message).not.toContain('mnd_');
  });

  it('isolates projects: a write in alpha is invisible in beta; separate indexes', async () => {
    const b = await client('beta', keyOf('beta'));
    const r = await b.callTool({ name: 'doc_list', arguments: { kind: 'specs' } });
    expect((r.structuredContent as { items: unknown[] }).items).toEqual([]);
    const g = await b.callTool({ name: 'spec_get', arguments: { ref: 'mandate://specs/only-in-alpha' } });
    expect(g.isError).toBe(true);
    const [a, bb] = await Promise.all([registry.open('alpha'), registry.open('beta')]);
    expect(a.config.index.path).not.toBe(bb.config.index.path);
    expect(existsSync(a.config.index.path) && existsSync(bb.config.index.path)).toBe(true);
    expect(a.git.dir).not.toBe(bb.git.dir);
  });

  it('stops a revoked key immediately (keys.json hot reload), even mid-session', async () => {
    const extra = keys.create('alpha', 'temp agent');
    const c = await client('alpha', extra.key);
    expect((await c.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).isError).toBeFalsy();
    expect(keys.revoke(extra.id)).toBe(true);
    await expect(c.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).rejects.toThrow(/unauthorized/);
    expect((await raw('/p/alpha/mcp', { authorization: `Bearer ${extra.key}` })).status).toBe(401);
  });

  it('never logs keys', () => {
    const all = logs.join('\n');
    for (const k of keys.list()) expect(all).not.toContain(k.key);
    expect(all).not.toContain('mnd_alpha_');
  });
});

describe('web UI session (GitHub sign-in cookie)', () => {
  const cookieHeaders = async () => ({ cookie: `${SESSION_COOKIE}=${await store.createSession({ login: 'octo', avatarUrl: 'https://x/a.png' })}`, origin: base });

  it('reads any project but can never write', async () => {
    const h = await cookieHeaders();
    const c = new Client({ name: 'mandate-web', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/p/beta/mcp`), { requestInit: { headers: h } }));
    clients.push(c);
    expect((await c.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).isError).toBeFalsy();
    const w = await c.callTool({ name: 'spec_create', arguments: { ...SPEC, title: 'UI write' } });
    expect(w.isError).toBe(true);
    expect(w.structuredContent).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('requires a same-origin Origin on cookie POSTs (CSRF)', async () => {
    const { cookie } = await cookieHeaders();
    expect((await raw('/p/alpha/mcp', { cookie })).status).toBe(403);
    expect((await raw('/p/alpha/mcp', { cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw('/p/alpha/mcp', { cookie, origin: base })).status).toBe(200);
  });

  it('rejects forged, expired and logged-out sessions', async () => {
    const cookie = await store.createSession({ login: 'octo', avatarUrl: 'a' });
    expect((await raw('/p/alpha/mcp', { cookie: `${SESSION_COOKIE}=${cookie}x`, origin: base })).status).toBe(401);
    await store.deleteSession(cookie);
    expect((await raw('/p/alpha/mcp', { cookie: `${SESSION_COOKIE}=${cookie}`, origin: base })).status).toBe(401);
    const old = await store.createSession({ login: 'octo', avatarUrl: 'a' }, -1);
    expect((await raw('/p/alpha/mcp', { cookie: `${SESSION_COOKIE}=${old}`, origin: base })).status).toBe(401);
  });

  it('lists every project on the unscoped endpoint; a key sees only its own', async () => {
    const ui = new Client({ name: 'web', version: '0' });
    await ui.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: await cookieHeaders() } }));
    clients.push(ui);
    const all = (await ui.callTool({ name: 'project_list', arguments: {} })).structuredContent as { items: { id: string; counts: { specs: number } }[]; defaultProject: string };
    expect(all.items.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(all.items[0]!.counts.specs).toBe(1);
    // Card stats: active work orders, items waiting for a human decision, linked code repos.
    expect(all.items[0]).toMatchObject({ counts: { activeWorkOrders: 0 }, codeRepos: [] });
    expect(typeof (all.items[0] as unknown as { openActions: number }).openActions).toBe('number');
    expect((all.items[0] as unknown as { lastActivity: { summary: string } | null }).lastActivity).not.toBeNull();
    expect(all.defaultProject).toBe('alpha');
    const agent = new Client({ name: 'a', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${keyOf('beta')}` } } }));
    clients.push(agent);
    const own = (await agent.callTool({ name: 'project_list', arguments: {} })).structuredContent as { items: { id: string }[] };
    expect(own.items.map((p) => p.id)).toEqual(['beta']);
  });

  it('serves the Connect-agent payload to signed-in users only', async () => {
    const get = (h: Record<string, string>) => fetch(`${base}/ui/p/alpha/connect`, { headers: h });
    expect((await get({ 'x-mandate-ui': '1' })).status).toBe(401);
    expect((await get({ 'x-mandate-ui': '1', authorization: `Bearer ${keyOf('alpha')}` })).status).toBe(403);
    const { cookie } = await cookieHeaders();
    expect((await get({ cookie })).status).toBe(403);
    const ok = await get({ cookie, 'x-mandate-ui': '1' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { mcpPath: string; key: { value: string; masked: string } };
    expect(body.mcpPath).toBe('/p/alpha/mcp');
    expect(body.key.value).toBe(keyOf('alpha'));
    expect(body.key.masked).not.toContain(body.key.value.slice(15, 30));
  });

  it('keeps the Host-header DNS-rebinding check', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/p/alpha/mcp`, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', authorization: `Bearer ${keyOf('alpha')}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
