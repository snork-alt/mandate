/** Browser login of the CLI (`mandate channel login`): start, approve in the UI, poll for a personal token; single use, expiry, rate limits, CSRF. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { GithubClient } from '../../src/auth/github.js';
import { accessOf, RepoPermissions } from '../../src/auth/github-perms.js';
import { CliLogins } from '../../src/auth/cli-login.js';
import { AgentTokens } from '../../src/auth/agent-tokens.js';
import { OAuthStore, redirectUriOk, registerMcpOAuth } from '../../src/auth/mcp-oauth.js';
import { SESSION_COOKIE, type AuthOptions } from '../../src/auth/http.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, type ProjectRuntime } from '../../src/projects/registry.js';
import { createStorage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { ActivityBus } from '../../src/events/index.js';
import type { ProjectConfig } from '../../src/config.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';

/** Repo permissions per (token user, repo). */
const PERMS: Record<string, Record<string, Record<string, boolean>>> = {
  octo: { 'acme/specs': { pull: true, push: true, admin: true }, 'acme/other': { pull: true, push: true } },
  reader: { 'acme/specs': { pull: true, triage: true, push: false } },
  teamy: { 'acme/specs': { pull: true, push: false, maintain: true } }, // write via a team grant (maintain)
  stranger: {},
};
const tokenOf = (login: string) => `gho_${login}_token_000000000000`;
let ghCalls = 0;
const mockFetch: typeof fetch = async (input, init) => {
  ghCalls++;
  const url = new URL(String(input));
  const auth = ((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
  const login = Object.keys(PERMS).find((l) => tokenOf(l) === auth);
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (!login || revokedAtGithub.has(login)) return json(401, { message: 'Bad credentials' });
  const m = /^\/repos\/([\w-]+\/[\w.-]+)$/.exec(url.pathname);
  if (m) {
    const p = PERMS[login]![m[1]!];
    return p ? json(200, { full_name: m[1], permissions: p }) : json(404, { message: 'Not Found' });
  }
  return json(404, {});
};
const revokedAtGithub = new Set<string>();

let clock = Date.now();
let app: FastifyInstance;
let base: string;
let store: AuthStore;
let tokens: AgentTokens;
let perms: RepoPermissions;
let auth: AuthOptions;
let keys: KeyStore;
const clients: Client[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sessionCookie = async (login: string) => `${SESSION_COOKIE}=${await store.createSession({ login, avatarUrl: '', kind: 'github' })}`;

async function mcp(project: string | null, headers: Record<string, string>, name = 'agent') {
  const c = new Client({ name, version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(project ? `${base}/p/${project}/mcp` : `${base}/mcp`), { requestInit: { headers } }));
  clients.push(c);
  return c;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const SPEC = (id: string) => ({ title: id, summary: 's', sections: [{ title: 'Overview', summary: 'x', body: 'y' }] });

beforeAll(async () => {
  const home = await tempDir();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  store = new AuthStore(home, randomBytes(32), 3600_000);
  for (const l of Object.keys(PERMS)) await store.saveToken(l, tokenOf(l), ['repo', 'read:org']);
  tokens = new AgentTokens(home);
  keys = new KeyStore(path.join(home, 'keys.json'));
  keys.ensureProjectKeys(['specs', 'other']);
  const oauth = new OAuthStore(home);
  auth = { keys, store, sharedKeys: false, agentTokens: tokens, oauth, isAdmin: (l) => l === 'octo' };
  perms = new RepoPermissions(store, new GithubClient({ web: 'https://gh.test', api: 'https://api.gh.test', fetch: mockFetch }));
  const cfg = (id: string, repo: string): ProjectConfig => ({ id, name: id, dataDir: path.join(home, id), branch: 'main', author: { name: 'T', email: 't@x' }, git: { backend: 'embedded', cliPath: 'git', cliEnv: {} }, index: {} as ProjectConfig['index'], idempotencyFile: '', autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 }, github: { repo, connectedBy: 'octo' } });
  const configs = [cfg('specs', 'acme/specs'), cfg('other', 'acme/other')];
  const registry = new ProjectRegistry(configs, async (p) => {
    const git = await newStore(p.dataDir);
    const storage = createStorage(git);
    const activity = new ActivityBus(git, { pollMs: 0 });
    await activity.start();
    return { config: p, git, storage, index: null, activity, ctx: { project: { id: p.id, name: p.name }, storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), activity }, close: async () => activity.stop() } as ProjectRuntime;
  });
  app = Fastify({ logger: false });
  registerMcp(app, { projects: registry, auth, perms, publicUrl: base, cliLogins: new CliLogins(tokens, () => clock) });
  registerMcpOAuth(app, { publicUrl: base, auth, projects: registry, perms, oauth });
  await app.listen({ port, host: '127.0.0.1' });
}, 60_000);

const H = () => ({ host: new URL(base).host, origin: base, 'x-mandate-ui': '1', 'content-type': 'application/json' });
const start = (project = 'specs', hostname = 'my-laptop.local') => app.inject({ method: 'POST', url: '/auth/cli/start', headers: { host: new URL(base).host, 'content-type': 'application/json' }, payload: { project, hostname } });
const poll = (deviceCode: string) => app.inject({ method: 'POST', url: '/auth/cli/poll', headers: { host: new URL(base).host, 'content-type': 'application/json' }, payload: { deviceCode } });

describe('CLI browser login', () => {
  it('start -> approve in the UI -> one personal token, single use, listed and revocable', async () => {
    const s = await start();
    expect(s.statusCode).toBe(201);
    const { deviceCode, userCode, verificationPath, verificationUrl } = s.json();
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(verificationPath).toBe(`/cli-login?code=${userCode}`);
    expect(verificationUrl).toBe(`${base}${verificationPath}`);
    expect((await poll(deviceCode)).json()).toEqual({ status: 'pending' });

    // The page data: needs a signed-in user with access to the project.
    expect((await app.inject({ url: `/ui/cli-login/${userCode}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1' } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/ui/cli-login/${userCode}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('stranger') } })).statusCode).toBe(404);
    const info = await app.inject({ url: `/ui/cli-login/${userCode.toLowerCase()}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } });
    expect(info.json()).toMatchObject({ code: userCode, project: { id: 'specs' }, hostname: 'my-laptop.local', user: 'reader', status: 'pending' });

    // CSRF: approving needs a same-origin Origin.
    const bad = await app.inject({ method: 'POST', url: `/ui/cli-login/${userCode}/approve`, headers: { ...H(), origin: 'https://evil.example', cookie: await sessionCookie('reader') }, payload: {} });
    expect(bad.statusCode).toBe(403);
    expect((await poll(deviceCode)).json()).toEqual({ status: 'pending' });

    const ok = await app.inject({ method: 'POST', url: `/ui/cli-login/${userCode}/approve`, headers: { ...H(), cookie: await sessionCookie('reader') }, payload: {} });
    expect(ok.statusCode).toBe(200);
    const done = (await poll(deviceCode)).json();
    expect(done).toMatchObject({ status: 'approved', project: 'specs', login: 'reader' });
    expect(done.token).toMatch(/^mndp_specs_/);
    // Single use: the code is gone.
    expect((await poll(deviceCode)).json()).toEqual({ status: 'expired' });
    expect((await app.inject({ url: `/ui/cli-login/${userCode}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } })).statusCode).toBe(404);

    // The token works as the user and shows in Personal tokens with its label; revoking it kills it.
    const mine = (await app.inject({ url: '/ui/p/specs/tokens', headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } })).json().items as { id: string; name: string }[];
    const rec = mine.find((t) => t.name === 'channel @ my-laptop.local')!;
    expect(rec).toBeTruthy();
    const c = await mcp('specs', bearer(done.token));
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);
    const del = await app.inject({ method: 'DELETE', url: `/ui/p/specs/tokens/${rec.id}`, headers: { host: new URL(base).host, origin: base, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: '/p/specs/events/pending', headers: { host: new URL(base).host, authorization: `Bearer ${done.token}` } })).statusCode).toBe(401);
  });

  it('deny, expiry, unknown project, hostname cleaning', async () => {
    const d = (await start()).json();
    const deny = await app.inject({ method: 'POST', url: `/ui/cli-login/${d.userCode}/deny`, headers: { ...H(), cookie: await sessionCookie('reader') }, payload: {} });
    expect(deny.json().status).toBe('denied');
    expect((await poll(d.deviceCode)).json()).toEqual({ status: 'denied' });
    expect((await poll(d.deviceCode)).json()).toEqual({ status: 'expired' });

    const e = (await start()).json();
    clock += 11 * 60_000;
    expect((await poll(e.deviceCode)).json()).toEqual({ status: 'expired' });
    expect((await app.inject({ url: `/ui/cli-login/${e.userCode}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } })).statusCode).toBe(404);

    expect((await start('nope')).statusCode).toBe(404);
    const h = (await start('specs', '<script>evil</script> host')).json();
    const info = await app.inject({ url: `/ui/cli-login/${h.userCode}`, headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } });
    expect(info.json().hostname).toBe('scriptevilscripthost');
  });

  it('rate limits start per client address', async () => {
    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await start()).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
