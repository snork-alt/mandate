/**
 * GitHub sign-in (OAuth + PKCE, allow-lists, sessions, logout, setup state hot reload) and UI project creation
 * (repo listing, clone / init / push / register / key, shared repo folders, overlap, token never in argv or URLs,
 * revoked token → reconnect). GitHub is mocked at the HTTP boundary; a local bare repo is the "remote".
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { loggerOptions } from '../../src/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore, loadServerSecret } from '../../src/auth/sessions.js';
import { AuthConfigSource, GithubClient, registerAuthRoutes, uiOriginOf, type GithubEndpoints } from '../../src/auth/github.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import { FakeProvider } from '../../src/index/embed/index.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, projectOpener } from '../../src/projects/registry.js';
import { githubRemote, registerAdminRoutes, TokenChecker } from '../../src/projects/admin.js';
import { loadConfig, projectsPathOf } from '../../src/config.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const SECRET = 'cs_super_secret_value_123456';
const TOKENS: Record<string, { login: string; scope: string }> = {
  gho_octo_token_aaaaaaaaaaaa: { login: 'octo', scope: 'repo' },
  gho_orgy_token_bbbbbbbbbbbb: { login: 'orgy', scope: 'read:org' },
  gho_nope_token_cccccccccccc: { login: 'stranger', scope: '' },
};
const revoked = new Set<string>();
let remotes: string;
const fetchLog: string[] = [];

/** GitHub at the HTTP boundary. */
const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '') ?? '';
  fetchLog.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (url.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(String(init?.body)) as { code: string; client_secret: string; code_verifier: string };
    if (b.client_secret !== SECRET || !b.code_verifier) return json(200, { error: 'bad_verification_code' });
    const token = Object.keys(TOKENS).find((k) => k.startsWith(`gho_${b.code}_`));
    return token ? json(200, { access_token: token, scope: TOKENS[token]!.scope, token_type: 'bearer' }) : json(200, { error: 'bad_verification_code' });
  }
  const t = TOKENS[auth];
  if (!t || revoked.has(auth)) return json(401, { message: 'Bad credentials' });
  const scopes = { 'x-oauth-scopes': t.scope };
  if (url.pathname === '/user') return json(200, { login: t.login, name: t.login.toUpperCase(), avatar_url: `https://avatars/${t.login}` }, scopes);
  if (url.pathname === '/user/memberships/orgs/acme') return t.login === 'orgy' ? json(200, { state: 'active' }) : json(404, { message: 'Not Found' });
  const repo = (name: string, owner = 'acme') => ({ full_name: `${owner}/${name}`, name, owner: { login: owner, avatar_url: `https://avatars/${owner}`, type: owner === 'acme' ? 'Organization' : 'User' }, private: owner === 'acme', default_branch: 'main', pushed_at: owner === 'acme' ? '2026-11-01T00:00:00Z' : '2026-10-01T00:00:00Z', size: 0, description: `the ${name} repo`, permissions: { push: true } });
  const method = init?.method ?? 'GET';
  if (url.pathname === '/user/repos' && method === 'GET') {
    // Two pages (Link header pagination); acme repos page 1, the personal repo page 2.
    if (url.searchParams.get('page') === '2') return json(200, [repo('notes', 'octo')], scopes);
    return json(200, [repo('specs'), repo('other')], { ...scopes, link: '<https://api.gh.test/user/repos?per_page=100&page=2>; rel="next", <https://api.gh.test/user/repos?per_page=100&page=2>; rel="last"' });
  }
  if (url.pathname === '/user/orgs') return json(200, [{ login: 'acme', avatar_url: 'https://avatars/acme' }, { login: 'locked', avatar_url: 'https://avatars/locked' }], scopes);
  if (url.pathname === '/user/memberships/orgs') return json(200, [{ organization: { login: 'acme' }, role: 'admin', state: 'active' }, { organization: { login: 'locked' }, role: 'member', state: 'active' }]);
  if (url.pathname === '/orgs/acme') return json(200, { login: 'acme', name: 'Acme Inc', members_can_create_repositories: true });
  if (url.pathname === '/orgs/locked') return json(200, { login: 'locked', name: 'Locked Corp', members_can_create_repositories: true });
  const restrictedMsg = { message: 'Although you appear to have the correct authorization credentials, the `locked` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.' };
  if (url.pathname.startsWith('/orgs/locked/')) return json(403, restrictedMsg);
  if (url.pathname === '/orgs/acme/repos' && method === 'GET') return json(200, [repo('specs'), repo('other')]);
  if (url.pathname === '/user/repos' || url.pathname === '/orgs/acme/repos') {
    const owner = url.pathname === '/user/repos' ? 'octo' : 'acme';
    const b = JSON.parse(String(init?.body)) as { name: string };
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(remotes, owner, `${b.name}.git`)]);
    return json(201, repo(b.name, owner));
  }
  const m = /^\/repos\/(acme|octo)\/([\w.-]+)$/.exec(url.pathname);
  if (m) return existsSync(path.join(remotes, m[1]!, `${m[2]}.git`)) ? json(200, repo(m[2]!, m[1]), scopes) : json(404, { message: 'Not Found' });
  return json(404, { message: 'Not Found' });
};

let app: FastifyInstance;
let home: string;
let configPath: string;
let store: AuthStore;
let keys: KeyStore;
let registry: ProjectRegistry;
let gitArgsLog: string;
const logs: string[] = [];
const env: NodeJS.ProcessEnv = {};

const inject = (o: { method?: 'GET' | 'POST'; url: string; cookie?: string; headers?: Record<string, string>; body?: unknown }) =>
  app.inject({
    method: o.method ?? 'GET',
    url: o.url,
    headers: { host: 'localhost:5173', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.method === 'POST' ? { origin: 'http://localhost:5173' } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-mandate-ui': '1', ...o.headers },
    ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
  });

const setCookies = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers['set-cookie'] as string | string[] | undefined) ?? []);
const cookieValue = (r: { headers: Record<string, unknown> }, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

/** Full OAuth round trip for `code` (the mock maps it to a token / user). */
async function signIn(code: string, returnTo = '/p/default/specs') {
  const start = await inject({ url: `/auth/github/login?returnTo=${encodeURIComponent(returnTo)}` });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get('state')!;
  const oauth = cookieValue(start, 'mandate_oauth')!;
  const cb = await inject({ url: `/auth/github/callback?code=${code}&state=${state}`, cookie: oauth });
  return { start, loc, cb, session: cookieValue(cb, SESSION_COOKIE) };
}

beforeAll(async () => {
  home = await tempDir();
  remotes = path.join(home, 'remotes');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(remotes, 'acme', 'specs.git')]);
  // `git` spy for the CLI backend: records argv (asserted: the token never appears there).
  gitArgsLog = path.join(home, 'git-args.log');
  const spy = path.join(home, 'git-spy.sh');
  writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitArgsLog}'\nexec git "$@"\n`);
  chmodSync(spy, 0o755);
  const local = path.join(home, 'local');
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  configPath = path.join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify({ projects: [{ id: 'default', name: 'Default', dataDir: local }], git: { backend: 'cli', cliPath: spy }, embedding: { provider: 'none' }, index: { path: path.join(home, 'idx', '{projectId}.sqlite') } }));
  Object.assign(env, { HOME: home, MANDATE_CONFIG: configPath, MANDATE_HOME: home, GH_SECRET: SECRET });
  const config = loadConfig(env);
  keys = new KeyStore(config.keysPath);
  keys.ensureProjectKeys(config.projects.map((p) => p.id));
  store = new AuthStore(home, loadServerSecret(home, env), 3600_000);
  const endpoints: GithubEndpoints = { web: 'https://gh.test', api: 'https://api.gh.test', fetch: mockFetch };
  const github = new GithubClient(endpoints);
  const source = new AuthConfigSource(configPath, config.auth, env);
  registry = new ProjectRegistry(config.projects, projectOpener(config, { provider: new FakeProvider(8, 'f'), activityPollMs: 0, githubRemote: githubRemote(store, (r) => path.join(remotes, `${r}.git`)) }));
  const checker = new TokenChecker(store, github);
  registry.tokenStatus = (l) => store.tokenStatus(l);
  registry.refreshTokens = (l) => checker.check(l);
  app = Fastify({ logger: loggerOptions({ write: (l: string) => logs.push(l) }) });
  const auth = { keys, store };
  registerMcp(app, { projects: registry, auth });
  registerAuthRoutes(app, { auth, source, github, log: app.log });
  registerAdminRoutes(app, {
    auth,
    source,
    hostOk: () => true,
    registry,
    keys,
    store,
    github,
    home,
    projects: new ProjectsStore(projectsPathOf(env)),
    resolveProject: (id) => loadConfig(env).projects.find((p) => p.id === id)!,
    log: app.log,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await registry.close();
  await cleanupTempDirs();
});

const setAuth = (auth: unknown) => {
  const j = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...j, auth }));
  const t = new Date(Date.now() + Math.random() * 10_000 + 1000);
  utimesSync(configPath, t, t);
};

describe('first-run setup', () => {
  it('names the missing fields, then hot-reloads config.json', async () => {
    const s = (await inject({ url: '/auth/status' })).json();
    expect(s).toMatchObject({ configured: false, authenticated: false, callbackUrl: 'http://localhost:5173/auth/github/callback' });
    expect(s.missing).toEqual(['auth.github', 'auth.github.clientId', 'env MANDATE_GITHUB_CLIENT_SECRET (auth.github.clientSecretEnv) is not set', 'auth.github.allowedUsers or auth.github.allowedOrgs (at least one)']);
    expect((await inject({ url: '/auth/github/login' })).headers.location).toBe('/login?error=not_configured');
    setAuth({ github: { clientId: 'Iv1.test', clientSecretEnv: 'GH_SECRET', allowedUsers: ['octo'], allowedOrgs: ['acme'] } });
    expect((await inject({ url: '/auth/status' })).json()).toMatchObject({ configured: true, missing: [] });
  });

  it('keeps agent keys working while sign-in is not configured', async () => {
    const r = await app.inject({ method: 'POST', url: '/p/default/mcp', headers: { host: 'localhost', authorization: `Bearer ${keys.list()[0]!.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } } });
    expect(r.statusCode).toBe(200);
  });
});

describe('GitHub sign-in', () => {
  it('redirects to GitHub with state, PKCE S256 and minimal scopes', async () => {
    const { loc } = await signIn('octo');
    expect(loc.origin + loc.pathname).toBe('https://gh.test/login/oauth/authorize');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(loc.searchParams.get('scope')).toBe('read:org');
    expect(loc.searchParams.get('client_id')).toBe('Iv1.test');
    expect(loc.href).not.toContain(SECRET);
    const up = new URL((await inject({ url: '/auth/github/login?scope=repo' })).headers.location as string);
    expect(up.searchParams.get('scope')).toBe('read:org repo');
  });

  it('rejects a state mismatch and a missing state cookie', async () => {
    const start = await inject({ url: '/auth/github/login' });
    const oauth = cookieValue(start, 'mandate_oauth')!;
    expect((await inject({ url: '/auth/github/callback?code=octo&state=forged', cookie: oauth })).headers.location).toBe('/login?error=state_mismatch');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    expect((await inject({ url: `/auth/github/callback?code=octo&state=${state}` })).headers.location).toBe('/login?error=state_mismatch');
  });

  it('refuses users outside allowedUsers / allowedOrgs', async () => {
    const { cb, session } = await signIn('nope');
    expect(cb.headers.location).toBe('/login?error=not_allowed');
    expect(session).toBeUndefined();
  });

  it('signs in an allowed user (HttpOnly Lax cookie, safe returnTo) and an allowed org member', async () => {
    const { cb, session } = await signIn('octo', '/p/default/specs?x=1');
    expect(cb.headers.location).toBe('/p/default/specs?x=1');
    const raw = setCookies(cb).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect((await inject({ url: '/auth/status', cookie: session })).json()).toMatchObject({ authenticated: true, user: { login: 'octo', avatarUrl: 'https://avatars/octo' } });
    const org = await signIn('orgy', '//evil.example/x');
    expect(org.cb.headers.location).toBe('/');
    expect((await inject({ url: '/auth/status', cookie: org.session })).json().user.login).toBe('orgy');
  });

  it('sends the user back to the UI origin when the callback is registered on the API origin (:4000)', async () => {
    const before = JSON.parse(readFileSync(configPath, 'utf8')).auth;
    setAuth({ ...before, github: { ...before.github, callbackUrl: 'http://localhost:4000/auth/github/callback' } });
    const { loc, cb } = await signIn('octo', '/p/default/specs');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:4000/auth/github/callback');
    expect(cb.headers.location).toBe('http://localhost:5173/p/default/specs');
    expect(uiOriginOf({ headers: { host: 'evil.example:5173' } } as never, 'http://localhost:4000/auth/github/callback', [])).toBe('');
    expect(uiOriginOf({ headers: { host: '127.0.0.1:5173' } } as never, 'http://localhost:4000/cb', [])).toBe('http://127.0.0.1:5173');
    setAuth(before);
  });

  it('logs out (Origin-checked) and expires sessions', async () => {
    const { session } = await signIn('octo');
    expect((await inject({ method: 'POST', url: '/auth/logout', cookie: session, headers: { origin: 'http://evil.example' } })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: '/auth/logout', cookie: session })).statusCode).toBe(204);
    expect((await inject({ url: '/auth/status', cookie: session })).json().authenticated).toBe(false);
    const expired = await store.createSession({ login: 'octo', avatarUrl: 'a' }, -1000);
    expect((await inject({ url: '/auth/status', cookie: `${SESSION_COOKIE}=${expired}` })).json().authenticated).toBe(false);
  });

  it('keeps the GitHub token server-side, encrypted at rest', async () => {
    const db = path.join(home, 'state.sqlite');
    const file = [db, `${db}-wal`].map((f) => (existsSync(f) ? readFileSync(f).toString('latin1') : '')).join('');
    expect(file).toContain('octo');
    expect(file).not.toContain('gho_octo_token');
    expect((await store.token('octo'))?.token).toBe('gho_octo_token_aaaaaaaaaaaa');
  });
});

describe('New project (GitHub storage)', () => {
  let session: string;
  let configBefore: { projects: unknown[] };
  beforeAll(async () => {
    session = (await signIn('octo')).session!;
    configBefore = JSON.parse(readFileSync(configPath, 'utf8'));
  });

  it('lists the user’s repos with scope info', async () => {
    const r = (await inject({ url: '/ui/github/repos?q=spec', cookie: session })).json();
    expect(r.needsScope).toBeNull();
    expect(r.items).toEqual([expect.objectContaining({ fullName: 'acme/specs', private: true, empty: true, defaultBranch: 'main' })]);
    const orgy = (await signIn('orgy')).session!;
    expect((await inject({ url: '/ui/github/repos', cookie: orgy })).json()).toMatchObject({ needsScope: 'repo', upgradeUrl: expect.stringContaining('scope=repo') });
  });

  it('lists orgs as owners (pagination, roles) and flags OAuth-App-restricted orgs with a grant link', async () => {
    const r = (await inject({ url: '/ui/github/repos', cookie: session })).json();
    expect(r.owners).toEqual([
      expect.objectContaining({ login: 'octo', type: 'user', canCreateRepos: true, restricted: false }),
      expect.objectContaining({ login: 'acme', name: 'Acme Inc', type: 'org', role: 'admin', canCreateRepos: true, restricted: false, avatarUrl: 'https://avatars/acme' }),
      expect.objectContaining({ login: 'locked', type: 'org', restricted: true, canCreateRepos: false }),
    ]);
    expect(r.items.map((x: { fullName: string }) => x.fullName)).toEqual(['acme/specs', 'acme/other', 'octo/notes']);
    expect(r.grantUrl).toBe('https://github.com/settings/connections/applications/Iv1.test');
    expect(r.reauthUrl).toContain('/auth/github/login?scope=repo');
    const acme = (await inject({ url: '/ui/github/repos?owner=acme&q=spec', cookie: session })).json();
    expect(acme.items.map((x: { fullName: string }) => x.fullName)).toEqual(['acme/specs']);
    const mine = (await inject({ url: '/ui/github/repos?owner=octo', cookie: session })).json();
    expect(mine.items.map((x: { fullName: string }) => x.fullName)).toEqual(['octo/notes']);
    const locked = (await inject({ url: '/ui/github/repos?owner=locked', cookie: session })).json();
    expect(locked.items).toEqual([]);
    expect(locked.owners.find((o: { login: string }) => o.login === 'locked').restricted).toBe(true);
    const create = await inject({ method: 'POST', url: '/ui/github/repos', cookie: session, body: { name: 'nope', owner: 'locked' } });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toMatchObject({ code: 'github_error', path: 'owner' });
    // New project scope upgrades always include read:org.
    expect(new URL((await inject({ url: '/auth/github/login?scope=public_repo' })).headers.location as string).searchParams.get('scope')).toBe('read:org public_repo');
  });

  it('creates a personal repo and a project in it', async () => {
    const repo = await inject({ method: 'POST', url: '/ui/github/repos', cookie: session, body: { name: 'mine' } });
    expect(repo.json().repo).toMatchObject({ fullName: 'octo/mine', private: false });
    const r = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Mine', repo: 'octo/mine' } });
    expect(r.statusCode).toBe(201);
  });

  it('creates a project with code repositories (short names validated, not the specs repo, stored in projects.json)', async () => {
    await inject({ method: 'POST', url: '/ui/github/repos', cookie: session, body: { name: 'mine-code' } });
    const self = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Mine code', repo: 'octo/mine-code', codeRepos: [{ name: 'self', github: 'octo/mine-code' }] } });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toMatchObject({ code: 'invalid_code_repos', path: 'codeRepos' });
    const dup = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Mine code', repo: 'octo/mine-code', codeRepos: [{ name: 'app', github: 'acme/specs' }, { name: 'app', github: 'octo/mine' }] } });
    expect(dup.json().error).toMatchObject({ code: 'invalid_code_repos', message: 'app is already used by acme/specs. Short names must be unique.' });
    const r = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Mine code', repo: 'octo/mine-code', codeRepos: [{ name: 'specs-app', github: 'acme/specs' }] } });
    expect(r.statusCode).toBe(201);
    const reg = JSON.parse(readFileSync(projectsPathOf(env), 'utf8'));
    expect(reg.projects.find((x: { id: string }) => x.id === 'mine-code').codeRepos).toEqual([{ name: 'specs-app', github: 'acme/specs', defaultBranch: 'main' }]);
  });

  it('refuses bearer keys and cross-origin POSTs on admin routes', async () => {
    expect((await inject({ method: 'POST', url: '/ui/projects', headers: { authorization: `Bearer ${keys.list()[0]!.key}` }, body: {} })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: '/ui/projects', cookie: session, headers: { origin: 'http://evil.example' }, body: {} })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { id: 'Bad Id', name: 'x', repo: 'acme/specs' } })).json().error).toMatchObject({ code: 'invalid_input', path: 'id', message: expect.stringMatching(/ids are assigned by Mandate/) });
  });

  it('creates a project: clone, init layout, commit + push, register, key, open', async () => {
    const r = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Team A', description: 'A team', repo: 'acme/specs', path: 'team-a' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().project).toMatchObject({ id: 'team-a', mcpPath: '/p/team-a/mcp', github: { repo: 'acme/specs', path: 'team-a', connectedBy: 'octo', status: 'ok' }, counts: { specs: 0 } });
    const files = execFileSync('git', ['--git-dir', path.join(remotes, 'acme/specs.git'), 'ls-tree', '-r', '--name-only', 'main']).toString();
    expect(files).toContain('team-a/specs/.gitkeep');
    expect(files).toContain('team-a/work-orders.jsonl');
    const reg = JSON.parse(readFileSync(projectsPathOf(env), 'utf8'));
    expect(reg.projects.find((x: { id: string }) => x.id === 'team-a')).toMatchObject({ id: 'team-a', github: { owner: 'acme', repo: 'specs', path: 'team-a', branch: 'main' }, connectedBy: 'octo', dataDir: path.join(home, 'projects', 'team-a', 'repo') });
    expect(statSync(projectsPathOf(env)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).projects).toEqual(configBefore.projects); // config.json never written
    expect(keys.list().some((k) => k.project === 'team-a')).toBe(true);
    // The new project's MCP endpoint works with its key and writes inside its folder.
    const key = keys.list().find((k) => k.project === 'team-a')!.key;
    const init = await app.inject({ method: 'POST', url: '/p/team-a/mcp', headers: { host: 'localhost', authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } } });
    expect(init.statusCode).toBe(200);
  });

  it('shares one repo across projects in separate folders and rejects overlaps', async () => {
    const b = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Team B', repo: 'acme/specs', path: 'team-b' } });
    expect(b.statusCode).toBe(201);
    for (const p of ['team-a/nested', '', 'team-b']) {
      const r = await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'X', repo: 'acme/specs', ...(p ? { path: p } : {}) } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({ code: 'folder_overlap', path: 'path' });
    }
    // Ids are assigned from the name: a second "Team A" gets team-a-2 (an explicit id is refused).
    expect((await inject({ method: 'POST', url: '/ui/projects', cookie: session, body: { name: 'Team A', repo: 'acme/specs', path: 'team-c' } })).json().project).toMatchObject({ id: 'team-a-2' });
    const files = execFileSync('git', ['--git-dir', path.join(remotes, 'acme/specs.git'), 'ls-tree', '-r', '--name-only', 'main']).toString();
    expect(files).toContain('team-a/specs/.gitkeep');
    expect(files).toContain('team-b/specs/.gitkeep');
  });

  it('creates a repo (private by default) and stores a project at its root, streaming progress', async () => {
    const repo = await inject({ method: 'POST', url: '/ui/github/repos', cookie: session, body: { name: 'fresh', owner: 'acme' } });
    expect(repo.json().repo).toMatchObject({ fullName: 'acme/fresh', private: true, ownerAvatarUrl: 'https://avatars/acme' });
    const r = await inject({ method: 'POST', url: '/ui/projects', cookie: session, headers: { accept: 'application/x-ndjson' }, body: { name: 'Fresh', repo: 'acme/fresh' } });
    const lines = r.payload.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.slice(0, -1).map((l) => `${l.step}:${l.status}`)).toEqual(['clone:start', 'clone:done', 'init:start', 'init:done', 'push:start', 'push:done', 'key:start', 'key:done']);
    expect(lines.at(-1).project).toMatchObject({ id: 'fresh' });
    const bad = await inject({ method: 'POST', url: '/ui/projects', cookie: session, headers: { accept: 'application/x-ndjson' }, body: { name: 'Fresh', repo: 'acme/fresh' } });
    expect(JSON.parse(bad.payload.trim()).error.code).toBe('folder_overlap');
  });

  it('never puts the token in git argv, remote URLs, config, logs or activity', async () => {
    const token = 'gho_octo_token_aaaaaaaaaaaa';
    const argv = readFileSync(gitArgsLog, 'utf8');
    expect(argv).toContain('clone');
    expect(argv).toContain('push');
    expect(argv).not.toContain(token);
    const remote = execFileSync('git', ['-C', path.join(home, 'projects', 'team-a', 'repo'), 'config', '--get', 'remote.origin.url']).toString().trim();
    expect(remote).toBe(path.join(remotes, 'acme/specs.git'));
    expect(readFileSync(configPath, 'utf8')).not.toContain(token);
    expect(readFileSync(projectsPathOf(env), 'utf8')).not.toContain(token);
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/code=octo/);
  });

  it('shows "reconnect" when GitHub revokes the token; the project keeps working locally', async () => {
    revoked.add('gho_octo_token_aaaaaaaaaaaa');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = new Client({ name: 'web', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { cookie: session, origin: base } } }));
    const list = (await c.callTool({ name: 'project_list', arguments: {} })).structuredContent as { items: { id: string; github: { status: string } | null }[] };
    expect(list.items.find((p) => p.id === 'team-a')!.github!.status).toBe('reconnect');
    expect(list.items.find((p) => p.id === 'default')!.github).toBeNull();
    const pc = new Client({ name: 'web', version: '0' });
    await pc.connect(new StreamableHTTPClientTransport(new URL(`${base}/p/team-a/mcp`), { requestInit: { headers: { cookie: session, origin: base } } }));
    expect((await pc.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).isError).toBeFalsy();
    await c.close();
    await pc.close();
    // Signing in again stores a fresh token and clears the state.
    revoked.delete('gho_octo_token_aaaaaaaaaaaa');
    await signIn('octo');
    expect(store.tokenStatus('octo')).toBe('ok');
  });
});

