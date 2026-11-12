/** Setup wizard API: token, modes, write-only secrets, config concurrency, provider tests (mocked HTTP), folder browser, local projects, git access. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { loggerOptions } from '../../src/app.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { AuthConfigSource, GithubClient, registerAuthRoutes } from '../../src/auth/github.js';
import { authenticate, SESSION_COOKIE } from '../../src/auth/http.js';
import { loadConfig, projectsPathOf } from '../../src/config.js';
import { ProjectRegistry, projectOpener } from '../../src/projects/registry.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { ConfigFile, SetupState } from '../../src/setup/files.js';
import { FolderBrowser } from '../../src/setup/fs.js';
import * as probes from '../../src/setup/probes.js';
import { registerSetupRoutes, setupStatus, SETUP_COOKIE } from '../../src/setup/routes.js';
import { loadSecrets, SecretsFile } from '../../src/secrets.js';
import { main as cli } from '../../scripts/mandate.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

afterAll(async () => {
  delete process.env.MANDATE_SECRETS_FILE;
  await cleanupTempDirs();
});

const SECRET_VALUE = 'sk-test-SUPERSECRET-value-1234567890';
const APP_SECRETS = { client: 'app-client-secret-SHOULD-NOT-LEAK', webhook: 'app-webhook-secret-SHOULD-NOT-LEAK', pem: '-----BEGIN RSA PRIVATE KEY-----\nPEM-SHOULD-NOT-LEAK\n-----END RSA PRIVATE KEY-----' };

/** A mocked provider / GitHub / Ollama HTTP boundary. */
const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
const mockFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {}, ...(init?.body ? { body: String(init.body) } : {}) });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const h = (init?.headers as Record<string, string>) ?? {};
  if (url.includes('/applications/')) return json(h.Authorization === `Basic ${Buffer.from('Iv1.ok:good-secret').toString('base64')}` ? 404 : 401, { message: 'x' });
  if (url === 'https://api.anthropic.com/v1/models') return h['x-api-key'] === SECRET_VALUE ? json(200, { data: [{ id: 'claude-haiku-4' }, { id: 'claude-sonnet-5' }] }) : json(401, {});
  if (url === 'https://api.anthropic.com/v1/messages') return h['x-api-key'] === SECRET_VALUE ? json(200, { content: [{ text: 'OK' }] }) : json(401, { error: `bad key ${h['x-api-key']}` });
  if (url.startsWith('https://api.cheaperinference.com/v1/')) {
    if (h.authorization !== `Bearer ${SECRET_VALUE}`) return json(401, { error: { message: 'bad key' } });
    if (url.endsWith('/models')) return json(200, { data: [{ id: 'gpt-6-luna', type: 'chat' }, { id: 'text-embedding-3-small', type: 'embedding', pricing: { input_per_million: '0.017' } }, { id: 'qwen3-embedding-8b', type: 'embedding' }] });
    if (url.endsWith('/embeddings')) {
      const b = JSON.parse(String(init?.body)) as { dimensions?: number };
      return json(200, { data: [{ index: 0, embedding: Array.from({ length: b.dimensions ?? 1536 }, () => 0.1) }] });
    }
  }
  if (url === 'https://api.gh.test/app-manifests/good-code/conversions' && init?.method === 'POST') {
    return json(201, { id: 4242, slug: 'mandate-test', name: 'Mandate test', client_id: 'Iv23.manifest', client_secret: APP_SECRETS.client, webhook_secret: APP_SECRETS.webhook, pem: APP_SECRETS.pem, html_url: 'https://gh.test/apps/mandate-test', owner: { login: 'matteo', type: 'User' } });
  }
  if (url === 'https://api.gh.test/app-manifests/old-code/conversions') return json(404, { message: 'Not Found' });
  if (url === 'http://localhost:11434/v1/models') return json(200, { data: [{ id: 'llama3.1' }, { id: 'nomic-embed-text' }] });
  if (url === 'http://localhost:11434/api/tags') return json(200, { models: [{ name: 'nomic-embed-text:latest' }] });
  if (url === 'http://localhost:11434/v1/embeddings') return json(200, { data: [{ embedding: Array.from({ length: 768 }, () => 0.1) }] });
  return json(404, {});
};

interface Harness {
  app: FastifyInstance;
  home: string;
  env: NodeJS.ProcessEnv;
  setup: SetupState;
  store: AuthStore;
  registry: ProjectRegistry;
  logs: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject: (o: { method?: 'GET' | 'POST' | 'PUT'; url: string; cookie?: string; body?: unknown; headers?: Record<string, string>; remoteAddress?: string }) => Promise<{ statusCode: number; headers: Record<string, unknown>; payload: string; json(): any }>;
}

async function harness(mode: 'computer' | 'server', extra: Record<string, unknown> = {}, more?: (h: { registry: ProjectRegistry; env: NodeJS.ProcessEnv }) => Record<string, unknown>): Promise<Harness> {
  const home = await tempDir();
  const mh = path.join(home, '.mandate');
  mkdirSync(mh, { recursive: true });
  const configPath = path.join(mh, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { ...(mode === 'server' ? { publicUrl: 'https://mandate.example.com', trustProxy: true } : {}) },
      embedding: { provider: 'none' },
      local: { baseDir: path.join(home, 'mandate') },
      index: { chunkTargetTokens: 400 },
      ...extra,
    }),
  );
  const env: NodeJS.ProcessEnv = { HOME: home, MANDATE_HOME: mh, MANDATE_CONFIG: configPath };
  // The server loads secrets.env into process.env at startup; do the same for this harness's file.
  process.env.MANDATE_SECRETS_FILE = path.join(mh, 'secrets.env');
  loadSecrets(process.env, { warn: () => undefined });
  const local = path.join(home, 'seed-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  writeFileSync(projectsPathOf(env), JSON.stringify({ version: 1, projects: [{ id: 'default', name: 'Default', dataDir: local, createdAt: 'x' }] }), { mode: 0o600 });
  const config = loadConfig(env);
  const keys = new KeyStore(config.keysPath);
  keys.ensureProjectKeys(['default']);
  const store = new AuthStore(mh, randomBytes(32), 3600_000);
  const source = new AuthConfigSource(configPath, config.auth, env, undefined, `${config.publicUrl}/auth/github/callback`);
  const auth = { keys, store };
  const registry = new ProjectRegistry(config.projects, projectOpener(config, { provider: null, activityPollMs: 0, startIndex: false }));
  const setup = new SetupState(mh, () => false);
  setup.token();
  const logs: string[] = [];
  const app = Fastify({ logger: loggerOptions({ write: (l: string) => logs.push(l) }) });
  const deps = {
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    port: config.port,
    home: mh,
    localBaseDir: config.localBaseDir,
    auth,
    source,
    setup,
    config: new ConfigFile(configPath),
    secretsFile: path.join(mh, 'secrets.env'),
    browser: new FolderBrowser(home),
    hostOk: () => true,
    local: { registry },
    fetch: mockFetch,
    log: app.log,
    ...(more?.({ registry, env }) ?? {}),
  };
  registerAuthRoutes(app, { auth, source, statusExtra: setupStatus(deps) });
  registerSetupRoutes(app, deps);
  await app.ready();
  const host = mode === 'server' ? 'mandate.example.com' : 'localhost:4000';
  const origin = mode === 'server' ? 'https://mandate.example.com' : 'http://localhost:4000';
  const inject: Harness['inject'] = (o) =>
    app.inject({
      method: o.method ?? 'GET',
      url: o.url,
      remoteAddress: o.remoteAddress ?? '127.0.0.1',
      headers: { host, 'x-mandate-ui': '1', ...(o.method && o.method !== 'GET' ? { origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
      ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
  return { app, home, env, setup, store, registry, logs, inject };
}

const cookieOf = (r: { headers: Record<string, unknown> }, name: string) => ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function setupCookie(h: Harness, headers: Record<string, string> = {}, remoteAddress?: string) {
  const r = await h.inject({ url: `/auth/setup?token=${h.setup.token()}`, headers, ...(remoteAddress ? { remoteAddress } : {}) });
  return { r, cookie: cookieOf(r, SETUP_COOKIE) };
}

describe('setup token', () => {
  it('is one-time, loopback-only, and invalidated when setup completes', async () => {
    const h = await harness('computer');
    expect((await h.inject({ url: '/auth/status' })).json()).toMatchObject({ setup: { complete: false, inSetupMode: true }, setupAccess: false, configured: false });
    expect((await h.inject({ url: `/auth/setup?token=${h.setup.token()}`, remoteAddress: '10.0.0.7' })).statusCode).toBe(403);
    // A proxy in front without trustProxy never counts as local.
    expect((await h.inject({ url: `/auth/setup?token=${h.setup.token()}`, headers: { 'x-forwarded-for': '127.0.0.1' } })).statusCode).toBe(403);
    expect((await h.inject({ url: '/auth/setup?token=wrong' })).headers.location).toBe('/setup?error=invalid_token');
    const { r, cookie } = await setupCookie(h);
    expect(r.headers.location).toBe('/setup');
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await h.inject({ url: '/auth/status', cookie })).json()).toMatchObject({ setupAccess: true, isAdmin: true });
    expect((await h.inject({ url: '/ui/setup/state', cookie })).statusCode).toBe(200);
    expect((await h.inject({ url: '/ui/setup/state' })).statusCode).toBe(401);
    const done = await h.inject({ method: 'POST', url: '/ui/setup/complete', cookie, body: {} });
    expect(done.json()).toEqual({ next: 'github', restarting: false });
    expect(cookieOf(done, SESSION_COOKIE)).toBeUndefined(); // sign-in is GitHub only
    // The setup-link holder gets the single-use first-admin claim for their GitHub sign-in.
    expect(String(done.headers['set-cookie'])).toMatch(/mandate_admin_claim=.+; HttpOnly; SameSite=Lax; Path=\/auth\/github/);
    expect(existsSync(path.join(h.env.MANDATE_HOME!, 'admin-claim'))).toBe(true);
    expect(existsSync(path.join(h.env.MANDATE_HOME!, 'setup-token'))).toBe(false);
    expect((await h.inject({ url: '/ui/setup/state', cookie })).statusCode).toBe(401);
    expect((await h.inject({ url: '/auth/setup?token=anything' })).headers.location).toBe('/setup?error=already_complete');
    expect(h.setup.token()).toBeNull();
  });

  it('on a server: remote use only over HTTPS (trusted proxy); plain http refused', async () => {
    const h = await harness('server');
    const remote = { 'x-forwarded-for': '203.0.113.9' };
    expect((await h.inject({ url: `/auth/setup?token=${h.setup.token()}`, headers: { ...remote, 'x-forwarded-proto': 'http' }, remoteAddress: '127.0.0.1' })).statusCode).toBe(403);
    const ok = await setupCookie(h, { ...remote, 'x-forwarded-proto': 'https' });
    expect(ok.r.headers.location).toBe('/setup');
    expect(String(ok.r.headers['set-cookie'])).toMatch(/Secure/);
  });
});

describe('GitHub sign-in only', () => {
  it('on this computer too: GitHub sign-in routes exist, no one-time-link route, GitHub settings saved by the wizard', async () => {
    const h = await harness('computer');
    expect((await h.inject({ url: '/auth/github/login' })).headers.location).toBe('/login?error=not_configured');
    expect((await h.inject({ url: '/auth/local?token=x' })).statusCode).toBe(404);
    const { cookie } = await setupCookie(h);
    const st = (await h.inject({ url: '/ui/setup/state', cookie })).json();
    expect(st.config.github).toMatchObject({ kind: null, clientId: null });
    expect(st.config.server).toMatchObject({ publicUrl: null, bind: '127.0.0.1' });
    expect(st.config.local).toBeUndefined();
    expect((await h.inject({ method: 'POST', url: '/ui/projects/local', cookie, body: { name: 'x', mode: 'new' } })).statusCode).toBe(404);
  });

  it('refuses one-time-link sessions of older installs, requires an allow-list (older OAuth App) and builds the callback from publicUrl', async () => {
    const h = await harness('server');
    expect((await h.inject({ url: '/auth/local?token=x' })).statusCode).toBe(404);
    const local = await h.store.createSession({ login: 'me', avatarUrl: '', kind: 'local' });
    const fakeReq = { method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${local}` } } as never;
    expect(await authenticate(fakeReq, null, { keys: new KeyStore(path.join(h.home, 'k.json')), store: h.store })).toMatchObject({ ok: false });
    expect((await h.inject({ url: '/auth/status', cookie: `${SESSION_COOKIE}=${local}` })).json().authenticated).toBe(false);
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    const st = (await h.inject({ url: '/ui/setup/state', cookie })).json();
    expect(st.config.github.suggested).toEqual({ name: 'Mandate', homepageUrl: 'https://mandate.example.com', callbackUrl: 'https://mandate.example.com/auth/github/callback' });
    const empty = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: st.configVersion, patch: { github: { clientId: 'Iv1.ok', allowedUsers: [], allowedOrgs: [] } } } });
    expect(empty.json().error).toMatchObject({ code: 'invalid_input', path: 'allowedUsers' });
    const ok = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: st.configVersion, patch: { github: { clientId: 'Iv1.ok', allowedUsers: ['octo'] } } } });
    expect(ok.statusCode).toBe(200);
    const status = (await h.inject({ url: '/auth/status' })).json();
    expect(status.callbackUrl).toBe('https://mandate.example.com/auth/github/callback');
    expect(status.publicUrl).toBe('https://mandate.example.com');
    expect((await h.inject({ method: 'POST', url: '/ui/setup/test/github', cookie, body: { clientId: 'Iv1.ok', clientSecret: 'good-secret' } })).json()).toMatchObject({ ok: true });
    const bad = (await h.inject({ method: 'POST', url: '/ui/setup/test/github', cookie, body: { clientId: 'Iv1.ok', clientSecret: 'nope' } })).json();
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).not.toContain('nope');
  });
});

describe('secrets and config', () => {
  it('secrets are write-only: never returned by any API, never logged; stored 0600', async () => {
    const h = await harness('computer');
    const { cookie } = await setupCookie(h);
    const set = await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'ANTHROPIC_TEST_KEY', value: SECRET_VALUE } });
    expect(set.json()).toEqual({ name: 'ANTHROPIC_TEST_KEY', set: true });
    const file = path.join(h.env.MANDATE_HOME!, 'secrets.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(SECRET_VALUE);
    const st = await h.inject({ url: '/ui/setup/state', cookie });
    const models = await h.inject({ method: 'POST', url: '/ui/setup/ask/models', cookie, body: { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_TEST_KEY' } });
    expect(models.json()).toMatchObject({ ok: true, models: ['claude-haiku-4', 'claude-sonnet-5'], suggested: 'claude-sonnet-5' });
    const test = await h.inject({ method: 'POST', url: '/ui/setup/ask/test', cookie, body: { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_TEST_KEY', model: 'claude-sonnet-5' } });
    expect(test.json()).toMatchObject({ ok: true });
    const badKey = await h.inject({ method: 'POST', url: '/ui/setup/ask/test', cookie, body: { provider: 'anthropic', apiKey: 'sk-wrong-key-123456789', model: 'claude-sonnet-5' } });
    expect(badKey.json().ok).toBe(false);
    expect(badKey.payload).not.toContain('sk-wrong-key-123456789');
    for (const r of [set, st, models, test]) expect(r.payload).not.toContain(SECRET_VALUE);
    expect(h.logs.join('\n')).not.toContain(SECRET_VALUE);
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'ANTHROPIC_TEST_KEY', value: null } })).json()).toEqual({ name: 'ANTHROPIC_TEST_KEY', set: false });
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET_VALUE);
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'bad name', value: 'x' } })).statusCode).toBe(400);
    delete process.env.ANTHROPIC_TEST_KEY;
  });

  it('remote embeddings: reuse the Ask key, list embedding models, test with a shortened size, save; key write-only', async () => {
    const h = await harness('computer', {
      ask: { default: 'luna', models: [{ id: 'luna', provider: 'openai-compatible', model: 'gpt-6-luna', baseUrl: 'https://api.cheaperinference.com/v1', apiKeyEnv: 'CI_EMBED_TEST_KEY' }] },
    });
    const { cookie } = await setupCookie(h);
    const set = await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'CI_EMBED_TEST_KEY', value: SECRET_VALUE } });
    const baseUrl = 'https://api.cheaperinference.com/v1';
    const keys = await h.inject({ method: 'POST', url: '/ui/setup/embedding/keys', cookie, body: { baseUrl } });
    expect(keys.json()).toEqual({ candidates: [{ askModelId: 'luna', label: 'gpt-6-luna', apiKeyEnv: 'CI_EMBED_TEST_KEY', apiKeySet: true }] });
    const models = await h.inject({ method: 'POST', url: '/ui/setup/embedding/models', cookie, body: { baseUrl, preset: 'cheaperinference', apiKeyEnv: 'CI_EMBED_TEST_KEY' } });
    expect(models.json()).toMatchObject({ ok: true, suggested: 'text-embedding-3-small', models: [{ id: 'qwen3-embedding-8b' }, { id: 'text-embedding-3-small', pricePerMTok: 0.017 }] });
    const test = await h.inject({ method: 'POST', url: '/ui/setup/embedding/test', cookie, body: { baseUrl, apiKeyEnv: 'CI_EMBED_TEST_KEY', model: 'text-embedding-3-small', requestDimensions: 512 } });
    expect(test.json()).toMatchObject({ ok: true, dimensions: 512, preset: { documentPrefix: '', queryPrefix: '' } });
    const noKey = await h.inject({ method: 'POST', url: '/ui/setup/embedding/test', cookie, body: { baseUrl, model: 'text-embedding-3-small' } });
    expect(noKey.json()).toMatchObject({ ok: false, errorKind: 'auth' });
    const v = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    const embedding = { provider: 'openai-compatible', preset: 'cheaperinference', baseUrl, model: 'text-embedding-3-small', apiKeyEnv: 'CI_EMBED_TEST_KEY', dimensions: 512, requestDimensions: 512, documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 128 };
    const saved = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v, patch: { embedding } } });
    expect(saved.json()).toMatchObject({ restartRequired: false }); // hot reload
    const file = readFileSync(h.env.MANDATE_CONFIG!, 'utf8');
    expect(JSON.parse(file).embedding).toMatchObject(embedding);
    expect(file).not.toContain(SECRET_VALUE);
    const st = await h.inject({ url: '/ui/setup/state', cookie });
    expect(st.json().config.embedding).toMatchObject({ preset: 'cheaperinference', requestDimensions: 512, apiKeyEnv: 'CI_EMBED_TEST_KEY', apiKeySet: true, remote: true });
    const est = await h.inject({ method: 'POST', url: '/ui/setup/embedding/estimate', cookie, body: { model: 'text-embedding-3-large' } });
    expect(est.json()).toMatchObject({ pricePerMTok: 0.13 });
    // Clearing the shortened size removes the field; unknown embedding keys are refused (strict schema).
    const v2 = st.json().configVersion;
    const cleared = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v2, patch: { embedding: { requestDimensions: null, dimensions: 1536 } } } });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).embedding).not.toHaveProperty('requestDimensions');
    const bad = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: cleared.json().configVersion, patch: { embedding: { apiKey: SECRET_VALUE } } } });
    expect(bad.statusCode).toBe(400);
    expect(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).not.toContain(SECRET_VALUE);
    for (const r of [set, keys, models, test, noKey, saved, st, est, bad]) expect(r.payload).not.toContain(SECRET_VALUE);
    expect(h.logs.join('\n')).not.toContain(SECRET_VALUE);
    delete process.env.CI_EMBED_TEST_KEY;
  });

  it('config writes: optimistic concurrency, unknown keys kept, 0600, never secrets', async () => {
    const h = await harness('computer');
    const { cookie } = await setupCookie(h);
    const v1 = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    const ok = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v1, patch: { git: { backend: 'cli', autoPush: { intervalSeconds: 600 } }, ask: { default: 'local', models: [{ id: 'local', provider: 'openai-compatible', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' }] } } } });
    expect(ok.statusCode).toBe(200);
    const file = JSON.parse(readFileSync(h.env.MANDATE_CONFIG!, 'utf8'));
    expect(file).toMatchObject({ index: { chunkTargetTokens: 400 }, git: { backend: 'cli', autoPush: { intervalSeconds: 600 } }, ask: { default: 'local' } });
    expect(statSync(h.env.MANDATE_CONFIG!).mode & 0o777).toBe(0o600);
    const stale = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v1, patch: { git: { cliPath: 'git2' } } } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('config_changed');
    // A hand edit also bumps the version.
    const v2 = ok.json().configVersion;
    writeFileSync(h.env.MANDATE_CONFIG!, JSON.stringify({ ...file, index: { chunkTargetTokens: 500 } }));
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v2, patch: { git: { cliPath: 'git3' } } } })).statusCode).toBe(409);
    // The projects folder is no longer a setting (GitHub projects only).
    const v3 = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v3, patch: { local: { baseDir: '~/x' } } } })).statusCode).toBe(400);
    // Invalid values never reach the file.
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v3, patch: { git: { autoPush: { intervalSeconds: 1 } } } } })).statusCode).toBe(400);
  });

  it('secrets.env written by Settings is picked up (fills only unset vars)', async () => {
    const dir = await tempDir();
    const f = path.join(dir, 'secrets.env');
    writeFileSync(f, 'A_KEY="x"\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    new SecretsFile(f, env).refresh();
    expect(env.A_KEY).toBe('x');
  });
});

describe('probes (mocked HTTP)', () => {
  it('lists Ollama models, detects nomic-embed-text and tests one embedding', async () => {
    expect(await probes.listModels({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }, mockFetch)).toMatchObject({ ok: true, models: ['llama3.1', 'nomic-embed-text'], suggested: 'llama3.1' });
    expect(await probes.detectOllama(mockFetch)).toMatchObject({ ollama: true, hasNomic: true });
    expect(await probes.testEmbedding('http://localhost:11434/v1', 'nomic-embed-text', mockFetch)).toMatchObject({ ok: true, dimensions: 768 });
    const off = await probes.detectOllama(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(off).toMatchObject({ ollama: false, hasNomic: false });
    expect(off.install.join('\n')).toContain('ollama pull nomic-embed-text');
  });

  it('server checks: reachable public URL over HTTPS, SSE unbuffered', async () => {
    const sse: typeof fetch = async (u) =>
      String(u).endsWith('/health/sse')
        ? new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('event: ping\n\n')) }), { status: 200 })
        : new Response('{}', { status: 200 });
    const checks = await probes.serverChecks('https://mandate.example.com', sse);
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ['publicUrl', true],
      ['https', true],
      ['sse', true],
    ]);
    const http = await probes.serverChecks('http://mandate.example.com', sse);
    expect(http.find((c) => c.id === 'https')).toMatchObject({ ok: false, level: 'error' });
  });
});

describe('folder browser', () => {
  it('is confined to home: no traversal, symlinks escaping home hidden and refused', async () => {
    const home = await tempDir();
    const outside = await tempDir();
    mkdirSync(path.join(home, 'code', 'repo', '.git'), { recursive: true });
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    symlinkSync(outside, path.join(home, 'escape'));
    symlinkSync(path.join(home, 'code'), path.join(home, 'code-link'));
    const b = new FolderBrowser(home);
    const l = b.list(undefined);
    expect(l.entries.map((e) => e.name)).toEqual(['code', 'code-link']);
    expect(b.list(undefined, { hidden: true }).entries.map((e) => e.name)).toContain('.ssh');
    expect(b.list('code').entries).toEqual([{ name: 'repo', path: path.join(b.home, 'code', 'repo'), isDir: true, isGitRepo: true }]);
    expect(() => b.resolve('../..')).toThrow(/outside/);
    expect(() => b.resolve('escape')).toThrow(/outside/);
    expect(() => b.resolve(outside)).toThrow(/outside/);
    expect(() => b.mkdir('escape/new')).toThrow(/outside/);
    expect(() => b.mkdir('/tmp/x-mandate')).toThrow(/outside/);
    expect(b.mkdir('~/new/deep')).toBe(path.join(b.home, 'new', 'deep'));
    expect(b.inspect('code/repo')).toMatchObject({ isGitRepo: true, enclosingRepo: null });
    mkdirSync(path.join(home, 'code', 'repo', 'docs'));
    expect(b.inspect('code/repo/docs')).toMatchObject({ isGitRepo: false, enclosingRepo: path.join(b.home, 'code', 'repo') });
  });
});

describe('git step', () => {
  it('system git test uses no prompts (BatchMode, GIT_TERMINAL_PROMPT=0); embedded test over file://', async () => {
    const dir = await tempDir();
    const bare = path.join(dir, 'r.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const sys = await probes.testGitSystem(`file://${bare}`);
    expect(sys.ok).toBe(true);
    expect(sys.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
    expect(sys.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(sys.args).toContain('ls-remote');
    expect((await probes.testGitSystem(`file://${dir}/missing.git`)).ok).toBe(false);
    expect(await probes.testGitEmbedded(bare, undefined)).toMatchObject({ ok: true });
  });

  it('shows only the public key and its fingerprint (never the private key); backend persisted', async () => {
    const h = await harness('computer');
    const { cookie } = await setupCookie(h);
    const ssh = path.join(h.home, '.ssh');
    mkdirSync(ssh, { recursive: true });
    const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-MARKER-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n';
    writeFileSync(path.join(ssh, 'id_ed25519'), PRIVATE, { mode: 0o600 });
    writeFileSync(path.join(ssh, 'id_ed25519.pub'), `ssh-ed25519 ${Buffer.from('fake-key-blob').toString('base64')} me@host\n`);
    const r = await h.inject({ url: `/ui/setup/git/pubkey?path=${encodeURIComponent('~/.ssh/id_ed25519')}`, cookie });
    expect(r.json()).toMatchObject({ fingerprint: expect.stringMatching(/^SHA256:/), publicKey: expect.stringMatching(/^ssh-ed25519 /) });
    const st = await h.inject({ url: '/ui/setup/state', cookie });
    const list = await h.inject({ url: `/ui/fs/list?path=${encodeURIComponent('~/.ssh')}&files=1&hidden=1`, cookie });
    for (const x of [r, st, list]) expect(x.payload).not.toContain('PRIVATE-MARKER');
    const v = st.json().configVersion;
    const put = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v, patch: { git: { backend: 'embedded', author: { name: 'Me', email: 'me@x' }, auth: { sshKeyPath: '~/.ssh/id_ed25519', sshPassphraseEnv: 'MANDATE_SSH_PASSPHRASE' } } } } });
    expect(put.json()).toMatchObject({ restartRequired: true });
    const after = (await h.inject({ url: '/ui/setup/state', cookie })).json().config.git;
    expect(after).toMatchObject({ backend: 'embedded', author: { name: 'Me' }, auth: { sshKeyPath: '~/.ssh/id_ed25519', sshPassphraseEnv: 'MANDATE_SSH_PASSPHRASE', passphraseSet: false } });
    await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'MANDATE_SSH_PASSPHRASE', value: 'pass-phrase-secret' } });
    const withPass = await h.inject({ url: '/ui/setup/state', cookie });
    expect(withPass.json().config.git.auth.passphraseSet).toBe(true);
    expect(withPass.payload).not.toContain('pass-phrase-secret');
    expect(h.logs.join('\n')).not.toMatch(/PRIVATE-MARKER|pass-phrase-secret/);
    delete process.env.MANDATE_SSH_PASSPHRASE;
  });
});

describe('CLI', () => {
  it('setup-url prints the one-time link; open prints the UI address (sign-in is GitHub)', async () => {
    const h = await harness('computer');
    const out: string[] = [];
    expect(await cli(['setup-url'], { ...h.env, MANDATE_UI_URL: 'http://localhost:5173' }, (s) => out.push(s))).toBe(0);
    expect(out[0]).toBe(`http://localhost:5173/auth/setup?token=${h.setup.token()}`);
    out.length = 0;
    const s = await harness('server');
    expect(await cli(['open'], s.env, (x) => out.push(x))).toBe(0);
    expect(out[0]).toBe('https://mandate.example.com');
  });
});

describe('database settings (Advanced)', () => {
  it('stores the URL only as a secret, validates the block strictly and tests the connection without leaking it', async () => {
    const h = await harness('server');
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    const st = (await h.inject({ url: '/ui/setup/state', cookie })).json();
    expect(st.config.database).toMatchObject({ driver: 'sqlite', urlEnv: 'MANDATE_DATABASE_URL', active: 'sqlite' });
    const version = st.configVersion as string;
    // Inline URLs are refused; unknown keys too (strict).
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: version, patch: { database: { driver: 'postgres', url: 'postgres://u:p@h/db' } } } })).statusCode).toBe(400);
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: version, patch: { database: { driver: 'postgres', bogus: 1 } } } })).statusCode).toBe(400);
    // No URL yet: the test says so.
    expect((await h.inject({ method: 'POST', url: '/ui/setup/database/test', cookie, body: {} })).json()).toMatchObject({ ok: false, message: expect.stringMatching(/set the connection URL/) });
    const secret = 'postgresql://mandate:pw-should-not-leak@127.0.0.1:1/mandate?sslmode=disable';
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'MANDATE_DATABASE_URL', value: secret } })).json()).toEqual({ name: 'MANDATE_DATABASE_URL', set: true });
    const t = await h.inject({ method: 'POST', url: '/ui/setup/database/test', cookie, body: {} });
    expect(t.json()).toMatchObject({ ok: false, message: expect.stringMatching(/cannot connect/) });
    expect(t.payload).not.toContain('pw-should-not-leak');
    const put = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: version, patch: { database: { driver: 'postgres', ssl: 'require', pool: { max: 5 } } } } });
    expect(put.json()).toMatchObject({ restartRequired: true });
    const after = (await h.inject({ url: '/ui/setup/state', cookie })).json();
    expect(after.config.database).toMatchObject({ driver: 'postgres', urlSet: true, ssl: 'require', pool: { max: 5 }, active: 'sqlite' });
    expect(JSON.stringify(after)).not.toContain('pw-should-not-leak');
    expect(readFileSync(path.join(h.env.MANDATE_HOME!, 'config.json'), 'utf8')).not.toContain('postgresql://');
    delete process.env.MANDATE_DATABASE_URL;
  });

  it('is the same setting on this computer', async () => {
    const h = await harness('computer');
    const { cookie } = await setupCookie(h);
    const version = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: version, patch: { database: { driver: 'postgres' } } } })).json()).toMatchObject({ restartRequired: true });
  });
});

describe('hot-applied settings (no restart)', () => {
  it('git backend: switched live for opened projects; one that cannot open is rolled back (config and server)', async () => {
    const h = await harness('computer', {}, ({ registry, env }) => ({ apply: { git: () => registry.reconfigureGit(loadConfig(env).projects) } }));
    const { cookie } = await setupCookie(h);
    const rt = await h.registry.open('default');
    const st = (await h.inject({ url: '/ui/setup/state', cookie })).json();
    const ok = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: st.configVersion, patch: { git: { backend: 'cli' } } } });
    expect(ok.json()).toMatchObject({ applied: ['git'], restartRequired: false });
    expect(rt.config.git.backend).toBe('cli');
    const v2 = ok.json().configVersion as string;
    const bad = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v2, patch: { git: { backend: 'cli', cliPath: '/nonexistent/bin/git' } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'apply_failed', message: expect.stringMatching(/git backend setting could not be applied, so nothing changed/) });
    // Rolled back: the file is as before (same version) and the project keeps its backend.
    expect((await h.inject({ url: '/ui/setup/state', cookie })).json()).toMatchObject({ configVersion: v2, config: { git: { backend: 'cli', cliPath: 'git' } } });
    expect(rt.config.git).toMatchObject({ backend: 'cli', cliPath: 'git' });
    await h.registry.close();
  });

  it('database: applied live; a failure rolls back config.json; a new URL secret is applied (and restored on failure)', async () => {
    let fail: Error | null = new Error('cannot connect to Postgres (postgres://***@db/x): ECONNREFUSED');
    const applied: string[] = [];
    const h = await harness('server', {}, () => ({
      apply: {
        database: async () => {
          if (fail) throw fail;
          applied.push('db');
        },
        databaseUrlEnv: () => 'MANDATE_DATABASE_URL',
      },
    }));
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    const v = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion as string;
    const before = readFileSync(h.env.MANDATE_CONFIG!, 'utf8');
    const bad = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v, patch: { database: { driver: 'postgres' } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'apply_failed', path: 'database', message: expect.stringMatching(/database setting could not be applied, so nothing changed: cannot connect/) });
    expect(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).toBe(before);
    fail = null;
    const ok = await h.inject({ method: 'PUT', url: '/ui/setup/config', cookie, body: { configVersion: v, patch: { database: { driver: 'postgres' } } } });
    expect(ok.json()).toMatchObject({ applied: ['database'], restartRequired: false });
    expect(applied).toEqual(['db']);
    // The running database's URL secret: applied on save; a URL that does not work is restored.
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'MANDATE_DATABASE_URL', value: 'postgresql://a:pw-one@h/db' } })).json()).toEqual({ name: 'MANDATE_DATABASE_URL', set: true, applied: ['database'] });
    fail = new Error('password authentication failed');
    const badUrl = await h.inject({ method: 'PUT', url: '/ui/setup/secret', cookie, body: { name: 'MANDATE_DATABASE_URL', value: 'postgresql://a:pw-two@h/db' } });
    expect(badUrl.json().error).toMatchObject({ code: 'apply_failed' });
    expect(badUrl.payload).not.toContain('pw-two');
    expect(process.env.MANDATE_DATABASE_URL).toBe('postgresql://a:pw-one@h/db');
    expect(readFileSync(path.join(h.env.MANDATE_HOME!, 'secrets.env'), 'utf8')).not.toContain('pw-two');
    delete process.env.MANDATE_DATABASE_URL;
  });
});

describe('self-restart (where Mandate runs)', () => {
  const restarter = (kind: 'supervised' | 'dev' | 'manual') => {
    const r = { triggered: 0, kind: () => kind, command: () => (kind === 'dev' ? 'stop and start npm run dev' : 'mandate restart'), trigger: () => (kind === 'manual' ? false : (r.triggered++, true)) };
    return r;
  };

  it('POST /ui/setup/restart: admin / setup session only, same-origin only; supervised restarts, manual returns the command', async () => {
    const r = restarter('supervised');
    const h = await harness('computer', {}, () => ({ restarter: r }));
    expect((await h.inject({ method: 'POST', url: '/ui/setup/restart', body: {} })).statusCode).toBe(401);
    const { cookie } = await setupCookie(h);
    expect((await h.inject({ method: 'POST', url: '/ui/setup/restart', cookie, body: {}, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/ui/setup/restart', cookie, body: {}, headers: { 'x-mandate-ui': '' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/ui/setup/restart', cookie, body: {}, headers: { authorization: 'Bearer k' } })).statusCode).toBe(403);
    expect(r.triggered).toBe(0);
    expect((await h.inject({ method: 'POST', url: '/ui/setup/restart', cookie, body: {} })).json()).toEqual({ restarting: true, kind: 'supervised', command: 'mandate restart' });
    expect(r.triggered).toBe(1);
    const m = await harness('computer', {}, () => ({ restarter: restarter('manual') }));
    const mc = (await setupCookie(m)).cookie;
    expect((await m.inject({ method: 'POST', url: '/ui/setup/restart', cookie: mc, body: {} })).json()).toEqual({ restarting: false, kind: 'manual', command: 'mandate restart' });
  });

  it('PUT /ui/setup/server: the address people and agents use; bind and proxy trust follow from it; says how it restarts', async () => {
    const h = await harness('computer', { server: { users: 'me', mode: 'local' } }, ({ env }) => ({ restarter: restarter('dev'), nextPublicUrl: () => loadConfig(env).publicUrl }));
    const { cookie } = await setupCookie(h);
    let v = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    const put = await h.inject({ method: 'PUT', url: '/ui/setup/server', cookie, body: { configVersion: v, publicUrl: 'https://mandate.example.com' } });
    expect(put.json()).toMatchObject({ restartRequired: true, url: 'https://mandate.example.com', restart: { kind: 'dev', command: 'stop and start npm run dev' } });
    let server = JSON.parse(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).server;
    expect(server).toMatchObject({ publicUrl: 'https://mandate.example.com', bind: '127.0.0.1', trustProxy: true }); // behind a reverse proxy
    expect(server.users).toBeUndefined(); // the old settings are dropped on the first save
    expect(server.mode).toBeUndefined();
    v = put.json().configVersion;
    const local = await h.inject({ method: 'PUT', url: '/ui/setup/server', cookie, body: { configVersion: v, publicUrl: 'http://localhost:4500' } });
    expect(local.json()).toMatchObject({ url: 'http://localhost:4500' });
    server = JSON.parse(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).server;
    expect(server).toMatchObject({ publicUrl: 'http://localhost:4500', bind: '127.0.0.1', trustProxy: false });
    // Advanced: explicit bind / proxy trust; a path is refused.
    v = local.json().configVersion;
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/server', cookie, body: { configVersion: v, publicUrl: 'https://m.example.com', bind: '0.0.0.0', trustProxy: false } })).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(h.env.MANDATE_CONFIG!, 'utf8')).server).toMatchObject({ bind: '0.0.0.0', trustProxy: false });
    v = (await h.inject({ url: '/ui/setup/state', cookie })).json().configVersion;
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/server', cookie, body: { configVersion: v, publicUrl: 'https://m.example.com/x' } })).json().error.path).toBe('publicUrl');
    expect((await h.inject({ method: 'PUT', url: '/ui/setup/users', cookie, body: {} })).statusCode).toBe(404);
  });
});

describe('one-click GitHub App (manifest flow)', () => {
  const gh = () => ({ github: new GithubClient({ web: 'https://gh.test', api: 'https://api.gh.test', fetch: mockFetch }) });

  it('builds the manifest for a personal account or an organization', async () => {
    const h = await harness('server', {}, gh);
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    const r = await h.inject({ method: 'POST', url: '/ui/setup/github/manifest', cookie, body: { owner: 'user' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } });
    const b = r.json();
    expect(b.action).toBe(`https://gh.test/settings/apps/new?state=${b.state}`);
    const m = JSON.parse(b.manifest);
    expect(m).toMatchObject({ url: 'https://mandate.example.com', redirect_url: 'https://mandate.example.com/auth/github/app/created', public: true, default_permissions: { contents: 'write', metadata: 'read' } });
    expect(m.callback_urls).toContain('https://mandate.example.com/auth/github/callback');
    expect(m.default_permissions.members).toBeUndefined();
    expect(m.name.length).toBeLessThanOrEqual(34);
    expect(String(r.headers['set-cookie'])).toMatch(/mandate_ghapp=.*HttpOnly; SameSite=Lax; Path=\/auth\/github\/app/);
    const org = (await h.inject({ method: 'POST', url: '/ui/setup/github/manifest', cookie, body: { owner: 'acme' } })).json();
    expect(org.action).toMatch(/^https:\/\/gh\.test\/organizations\/acme\/settings\/apps\/new\?state=/);
    expect(JSON.parse(org.manifest)).toMatchObject({ public: false, default_permissions: { contents: 'write', metadata: 'read', members: 'read' } });
    expect((await h.inject({ method: 'POST', url: '/ui/setup/github/manifest', body: { owner: 'user' } })).statusCode).toBe(401);
  });

  it('exchanges the code: secrets to secrets.env and a 0600 key file, ids to config, nothing logged or returned', async () => {
    const h = await harness('server', {}, gh);
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    const start = await h.inject({ method: 'POST', url: '/ui/setup/github/manifest', cookie, body: { owner: 'user' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } });
    const appCookie = cookieOf(start, 'mandate_ghapp')!;
    const state = start.json().state as string;
    // Wrong state or no state cookie: refused.
    expect((await h.inject({ url: `/auth/github/app/created?code=good-code&state=nope`, cookie: appCookie })).headers.location).toMatch(/github=state_mismatch/);
    expect((await h.inject({ url: `/auth/github/app/created?code=good-code&state=${state}` })).headers.location).toMatch(/github=state_mismatch/);
    expect((await h.inject({ url: `/auth/github/app/created?code=old-code&state=${state}`, cookie: appCookie })).headers.location).toMatch(/github=expired/);
    const done = await h.inject({ url: `/auth/github/app/created?code=good-code&state=${state}`, cookie: appCookie });
    expect(done.headers.location).toBe('/setup?github=created&app=mandate-test&owner=matteo');
    const mh = h.env.MANDATE_HOME!;
    const secrets = path.join(mh, 'secrets.env');
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(readFileSync(secrets, 'utf8')).toContain(APP_SECRETS.client);
    expect(readFileSync(secrets, 'utf8')).toContain(APP_SECRETS.webhook);
    const key = path.join(mh, 'github-app.pem');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(key, 'utf8')).toContain('PEM-SHOULD-NOT-LEAK');
    const cfg = readFileSync(h.env.MANDATE_CONFIG!, 'utf8');
    expect(JSON.parse(cfg).auth.github).toMatchObject({ clientId: 'Iv23.manifest', clientSecretEnv: 'MANDATE_GITHUB_CLIENT_SECRET', app: { id: 4242, slug: 'mandate-test', owner: 'matteo', ownerType: 'User', privateKeyPath: key, webhookSecretEnv: 'MANDATE_GITHUB_WEBHOOK_SECRET' } });
    // The address the wizard was opened on is saved as the server address (behind an HTTPS proxy).
    expect(JSON.parse(cfg).server).toMatchObject({ publicUrl: 'https://mandate.example.com', bind: '127.0.0.1', trustProxy: true });
    const st = await h.inject({ url: '/ui/setup/state', cookie });
    expect(st.json().config.github).toMatchObject({ kind: 'app', clientSecretSet: true, app: { slug: 'mandate-test', installUrl: 'https://gh.test/apps/mandate-test/installations/new', privateKeySet: true } });
    for (const v of Object.values(APP_SECRETS).map((x) => x.split('\n')[1] ?? x)) {
      expect(cfg).not.toContain(v);
      expect(st.payload).not.toContain(v);
      expect(done.payload).not.toContain(v);
      expect(h.logs.join('\n')).not.toContain(v);
    }
    delete process.env.MANDATE_GITHUB_CLIENT_SECRET;
    delete process.env.MANDATE_GITHUB_WEBHOOK_SECRET;
  });

  it('an existing OAuth App stays supported (kind oauth, no app block)', async () => {
    const h = await harness('server', { auth: { github: { clientId: 'Ov23.legacy', clientSecretEnv: 'LEGACY_GH_SECRET', allowedUsers: ['octo'] } } });
    const { cookie } = await setupCookie(h, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' });
    expect((await h.inject({ url: '/ui/setup/state', cookie })).json().config.github).toMatchObject({ kind: 'oauth', clientId: 'Ov23.legacy', app: null });
  });
});
