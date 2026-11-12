/**
 * GitHub App sign-in (the default for new team setups): user tokens expire and refresh (rotating refresh tokens),
 * repositories are listed through the app's installations ("Install Mandate on more repos"), and the client secret
 * never leaves the token exchange. GitHub is mocked at the HTTP boundary.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthConfigSource, GithubClient, registerAuthRoutes } from '../../src/auth/github.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { KeyStore } from '../../src/auth/keys.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import { loadConfig, projectsPathOf } from '../../src/config.js';
import { registerAdminRoutes } from '../../src/projects/admin.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const SECRET = 'app_client_secret_value_987654';
let refreshCount = 0;
const used = new Set<string>();
const log: string[] = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  log.push(`${method} ${url.pathname}${url.search}`);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '') ?? '';
  if (url.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(String(init?.body)) as { client_secret: string; grant_type?: string; refresh_token?: string; code?: string };
    if (b.client_secret !== SECRET) return json(200, { error: 'incorrect_client_credentials' });
    if (b.grant_type === 'refresh_token') {
      // Rotation: a refresh token works once.
      if (!b.refresh_token?.startsWith('ghr_') || used.has(b.refresh_token)) return json(200, { error: 'bad_refresh_token' });
      used.add(b.refresh_token);
      refreshCount++;
      return json(200, { access_token: `ghu_fresh_${refreshCount}`, expires_in: 28800, refresh_token: `ghr_next_${refreshCount}`, refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer' });
    }
    return json(200, { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first', refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer' });
  }
  if (!auth.startsWith('ghu_')) return json(401, { message: 'Bad credentials' });
  if (url.pathname === '/user') return json(200, { login: 'octo', name: 'Octo', avatar_url: 'https://avatars/octo', id: 7 });
  if (url.pathname === '/user/installations') return json(200, { total_count: 1, installations: [{ id: 11, account: { login: 'acme', type: 'Organization', avatar_url: 'https://avatars/acme' }, repository_selection: 'selected' }] });
  if (url.pathname === '/user/installations/11/repositories') {
    const repo = (name: string, pushed: string) => ({ full_name: `acme/${name}`, name, owner: { login: 'acme', type: 'Organization' }, private: true, default_branch: 'main', pushed_at: pushed, size: 1, permissions: { push: true } });
    return json(200, { total_count: 2, repositories: [repo('specs', '2026-11-01T00:00:00Z'), repo('web', '2026-11-05T00:00:00Z')] });
  }
  return json(404, { message: 'Not Found' });
};

const endpoints = { web: 'https://gh.test', api: 'https://api.gh.test', fetch: mockFetch };
afterAll(cleanupTempDirs);

describe('GitHub App user tokens: expiry and refresh', () => {
  it('refreshes a token about to expire on read (rotating the refresh token), keeps it encrypted, sweeps due tokens', async () => {
    const home = await tempDir();
    let now = 1_000_000;
    const store = new AuthStore(home, randomBytes(32), 3600_000, () => now);
    await store.ready;
    const gh = new GithubClient(endpoints);
    store.refresher = (rt) => gh.refreshUserToken({ clientId: 'Iv23.app', clientSecret: SECRET }, rt);
    await store.saveToken('octo', 'ghu_old', [], { app: true, expiresAt: now + 8 * 3600_000, refreshToken: 'ghr_seed', refreshExpiresAt: now + 180 * 86_400_000 });
    // Fresh: returned as is.
    expect(await store.token('octo')).toMatchObject({ token: 'ghu_old', app: true, refreshToken: 'ghr_seed' });
    // 10 minutes before expiry: refreshed on read; the new refresh token is stored.
    now += 8 * 3600_000 - 10 * 60_000;
    const t = await store.token('octo');
    expect(t).toMatchObject({ token: 'ghu_fresh_1', refreshToken: 'ghr_next_1', app: true });
    expect(store.tokenCached('octo')?.token).toBe('ghu_fresh_1');
    // Concurrent reads near expiry: a single refresh (the refresh token works once).
    now += 8 * 3600_000 - 5 * 60_000;
    const [a, b] = await Promise.all([store.token('octo'), store.token('octo')]);
    expect(a?.token).toBe('ghu_fresh_2');
    expect(b?.token).toBe('ghu_fresh_2');
    // Background sweep refreshes what expires within 30 minutes.
    now += 8 * 3600_000 - 20 * 60_000;
    expect(await store.refreshDue()).toEqual(['octo']);
    expect(store.tokenCached('octo')?.token).toBe('ghu_fresh_3');
    expect(store.tokenStatus('octo')).toBe('ok');
  });

  it('a rejected refresh token marks the token revoked ("Reconnect GitHub")', async () => {
    const home = await tempDir();
    let now = 5_000_000;
    const store = new AuthStore(home, randomBytes(32), 3600_000, () => now);
    await store.ready;
    const gh = new GithubClient(endpoints);
    store.refresher = (rt) => gh.refreshUserToken({ clientId: 'Iv23.app', clientSecret: SECRET }, rt);
    await store.saveToken('octo', 'ghu_x', [], { app: true, expiresAt: now + 60_000, refreshToken: 'not-a-refresh-token' });
    now += 120_000;
    expect(await store.token('octo')).toBeNull();
    expect(store.tokenStatus('octo')).toBe('reconnect');
  });

  it('OAuth App tokens (no expiry) are untouched by the refresher (older rows read as before)', async () => {
    const home = await tempDir();
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    await store.ready;
    store.refresher = async () => {
      throw new Error('must not be called');
    };
    await store.saveToken('octo', 'gho_plain', ['repo']);
    expect(await store.token('octo')).toEqual({ token: 'gho_plain', scopes: ['repo'] });
    expect(await store.refreshDue()).toEqual([]);
  });
});

describe('GitHub App sign-in and the installation-gated repo picker', () => {
  let app: FastifyInstance;
  let store: AuthStore;
  let configPath: string;
  const env: NodeJS.ProcessEnv = {};
  const logs: string[] = [];

  beforeAll(async () => {
    const home = await tempDir();
    configPath = path.join(home, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { users: 'team' },
        projects: [{ id: 'default', name: 'Default', dataDir: path.join(home, 'local') }],
        embedding: { provider: 'none' },
        auth: { github: { clientId: 'Iv23.app', clientSecretEnv: 'GH_APP_SECRET', allowedUsers: ['octo'], app: { id: 42, slug: 'mandate-acme', owner: 'acme', ownerType: 'Organization' } } },
      }),
    );
    Object.assign(env, { HOME: home, MANDATE_CONFIG: configPath, MANDATE_HOME: home, GH_APP_SECRET: SECRET });
    const config = loadConfig(env);
    store = new AuthStore(home, randomBytes(32), 3600_000);
    const keys = new KeyStore(config.keysPath);
    const github = new GithubClient(endpoints);
    const source = new AuthConfigSource(configPath, config.auth, env, undefined, 'http://localhost:4000/auth/github/callback');
    const registry = new ProjectRegistry(config.projects, async () => {
      throw new Error('not opened');
    });
    app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => logs.push(l) } } });
    const auth = { keys, store, users: 'team' as const, sharedKeys: false };
    registerAuthRoutes(app, { auth, source, github, log: app.log });
    registerAdminRoutes(app, { auth, source, hostOk: () => true, registry, keys, store, github, home, projects: new ProjectsStore(projectsPathOf(env)), resolveProject: () => config.projects[0]!, log: app.log });
    await app.ready();
  });
  afterAll(async () => app?.close());

  it('signs in without scopes, stores the refreshable token, and lists only repos where the app is installed', async () => {
    const start = await app.inject({ url: '/auth/github/login', headers: { host: 'localhost:4000' } });
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://gh.test/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Iv23.app');
    expect(loc.searchParams.has('scope')).toBe(false); // GitHub Apps ignore scopes
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    const oauth = ([] as string[]).concat(start.headers['set-cookie'] as string).find((c) => c.startsWith('mandate_oauth='))!.split(';')[0]!;
    const cb = await app.inject({ url: `/auth/github/callback?code=abc&state=${loc.searchParams.get('state')}`, headers: { host: 'localhost:4000', cookie: oauth } });
    const session = ([] as string[]).concat(cb.headers['set-cookie'] as string[]).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
    expect(session).toBeTruthy();
    expect(await store.token('octo')).toMatchObject({ token: 'ghu_first', app: true, refreshToken: 'ghr_first', expiresAt: expect.any(Number) });
    const r = await app.inject({ url: '/ui/github/repos', headers: { host: 'localhost:4000', cookie: session, 'x-mandate-ui': '1' } });
    const body = r.json();
    expect(body.needsScope).toBeNull();
    expect(body.items.map((x: { fullName: string }) => x.fullName)).toEqual(['acme/web', 'acme/specs']);
    expect(body.owners).toEqual([expect.objectContaining({ login: 'acme', type: 'org', selection: 'selected' })]);
    expect(body.app).toMatchObject({ slug: 'mandate-acme', installUrl: 'https://gh.test/apps/mandate-acme/installations/new', installations: [{ account: 'acme', type: 'Organization', selection: 'selected' }] });
    // Never the OAuth App listing endpoints, never the secret in logs.
    expect(log.some((l) => l.startsWith('GET /user/repos'))).toBe(false);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain('ghu_first');
  });
});

describe('first admin: the person who finishes the setup wizard', () => {
  it('a single-use claim from the setup session makes the GitHub-verified login an admin; nothing else can claim it', async () => {
    const { SetupAdminClaim, ConfigFile } = await import('../../src/setup/files.js');
    const { adminClaimHook } = await import('../../src/setup/routes.js');
    const { ADMIN_CLAIM_COOKIE } = await import('../../src/auth/github.js');
    const home = await tempDir();
    const configPath = path.join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ auth: { github: { clientId: 'Iv23.app', app: { id: 1, slug: 'm' } } } }));
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    const hook = adminClaimHook({ home, auth: { keys: new KeyStore(path.join(home, 'keys.json')), store }, config: new ConfigFile(configPath) });
    const req = (cookie?: string) => ({ headers: cookie ? { cookie: `${ADMIN_CLAIM_COOKIE}=${cookie}` } : {} }) as never;
    const admins = () => JSON.parse(readFileSync(configPath, 'utf8')).auth.github.allowedUsers ?? [];
    // No claim issued, no cookie, forged cookie: nothing.
    expect(await hook(req(), 'mallory')).toBe(false);
    const nonce = new SetupAdminClaim(home).issue();
    expect(await hook(req(store.sign({ n: 'guess' })), 'mallory')).toBe(false);
    expect(await hook(req(`${Buffer.from(JSON.stringify({ n: nonce })).toString('base64url')}.bad-signature`), 'mallory')).toBe(false);
    expect(admins()).toEqual([]);
    // The setup session's cookie: the login GitHub returned becomes admin, once.
    expect(await hook(req(store.sign({ n: nonce })), 'octo')).toBe(true);
    expect(admins()).toEqual(['octo']);
    expect(await hook(req(store.sign({ n: nonce })), 'mallory')).toBe(false);
    expect(admins()).toEqual(['octo']);
    // An expired claim does nothing.
    const old = new SetupAdminClaim(home).issue(-1);
    expect(await hook(req(store.sign({ n: old })), 'mallory')).toBe(false);
  });
});
