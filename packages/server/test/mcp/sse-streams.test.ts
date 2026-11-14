/** Standalone SSE streams: keep-alive pings, prompt release on client disconnect, tool calls never wait behind a stream. */
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { randomBytes } from 'node:crypto';
import { FakeProvider } from '../../src/index/embed/index.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, projectOpener } from '../../src/projects/registry.js';
import { embeddingConfigSchema, indexConfigSchema, type ProjectConfig } from '../../src/config.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const project = (root: string, id: string): ProjectConfig => ({
  id,
  name: `Project ${id}`,
  dataDir: path.join(root, id, 'repo'),
  branch: 'main',
  author: { name: 'Test', email: 'test@example.com' },
  git: { backend: 'embedded', cliPath: 'git', cliEnv: {} },
  index: indexConfigSchema.parse({ path: path.join(root, id, 'index.sqlite') }),
  idempotencyFile: path.join(root, id, 'idem.json'),
  autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 },
});

let app: FastifyInstance;
let base: string;
let key: string;
let registry: ProjectRegistry;
const PV = '2025-06-18';

beforeAll(async () => {
  const root = await tempDir();
  const keys = new KeyStore(path.join(root, 'keys.json'), { touchIntervalMs: 0, log: { warn: () => undefined, error: () => undefined } });
  keys.ensureProjectKeys(['alpha']);
  key = keys.list().find((k) => k.project === 'alpha')!.key;
  const embedding = { ...embeddingConfigSchema.parse({}), dimensions: 64 };
  registry = new ProjectRegistry([project(root, 'alpha')], projectOpener({ embedding, ask: { default: null, models: [] } }, { provider: new FakeProvider(64, 'fake:64'), activityPollMs: 0 }));
  app = Fastify({ logger: false });
  registerMcp(app, { projects: registry, auth: { keys, store: new AuthStore(root, randomBytes(32), 3600_000) }, sseKeepAliveMs: 100 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await app.close();
  await registry.close();
  await cleanupTempDirs();
});

const headers = (sid?: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PV, ...(sid ? { 'mcp-session-id': sid } : {}) });

async function session(): Promise<string> {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PV, capabilities: {}, clientInfo: { name: 'raw', version: '0' } } };
  const r = await fetch(`${base}/p/alpha/mcp`, { method: 'POST', headers: headers(), body: JSON.stringify(init) });
  await r.text();
  const sid = r.headers.get('mcp-session-id')!;
  await (await fetch(`${base}/p/alpha/mcp`, { method: 'POST', headers: headers(sid), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).text();
  return sid;
}

const openStream = (sid: string, signal: AbortSignal) => fetch(`${base}/p/alpha/mcp`, { method: 'GET', headers: { ...headers(sid), accept: 'text/event-stream' }, signal });

async function readUntil(res: Response, pred: (text: string) => boolean, ms = 2_000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!pred(text) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), deadline - Date.now()))]);
    if (!r || r.done) break;
    text += dec.decode(r.value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

describe('standalone SSE stream', () => {
  it('sends keep-alive comments', async () => {
    const sid = await session();
    const ac = new AbortController();
    const res = await openStream(sid, ac.signal);
    expect(res.status).toBe(200);
    expect(await readUntil(res, (t) => /^:/m.test(t))).toMatch(/^:/m);
    ac.abort();
  });

  it('releases the stream as soon as the client disconnects (a reopened tab is not refused)', async () => {
    const sid = await session();
    const ac = new AbortController();
    expect((await openStream(sid, ac.signal)).status).toBe(200);
    const dup = await openStream(sid, new AbortController().signal);
    expect(dup.status).toBe(409); // one stream per session
    await dup.text();
    ac.abort();
    let status = 0;
    for (let i = 0; i < 40 && status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const again = new AbortController();
      const r = await openStream(sid, again.signal);
      status = r.status;
      if (status === 200) again.abort();
      else await r.text();
    }
    expect(status).toBe(200);
  });

  it('tool calls never wait behind an open stream', async () => {
    const sid = await session();
    const ac = new AbortController();
    expect((await openStream(sid, ac.signal)).status).toBe(200);
    const t0 = Date.now();
    const r = await fetch(`${base}/p/alpha/mcp`, { method: 'POST', headers: headers(sid), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('"tools"');
    expect(Date.now() - t0).toBeLessThan(2_000);
    ac.abort();
  });
});
