/** Server mode: GitHub repo permissions per project, personal agent tokens, MCP OAuth (metadata, DCR, PKCE, audience, refresh, revocation). */
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
  registerMcp(app, { projects: registry, auth, perms, publicUrl: base });
  registerMcpOAuth(app, { publicUrl: base, auth, projects: registry, perms, oauth });
  await app.listen({ port, host: '127.0.0.1' });
}, 60_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await app.close();
  await cleanupTempDirs();
});

describe('GitHub repo permissions', () => {
  it('maps permissions: pull/triage → read, push/maintain/admin → write', () => {
    expect(accessOf({ pull: true })).toBe('read');
    expect(accessOf({ triage: true })).toBe('read');
    expect(accessOf({ pull: true, maintain: true })).toBe('write');
    expect(accessOf({ admin: true })).toBe('write');
    expect(accessOf({})).toBe('none');
    expect(accessOf(undefined)).toBe('none');
  });

  it('caches per (user, project) for the TTL; a revoked token means no access at once', async () => {
    let now = 1_000_000;
    const p = new RepoPermissions(store, new GithubClient({ web: '', api: 'https://api.gh.test', fetch: mockFetch }), 5 * 60_000, () => now);
    const project = { id: 'specs', github: { repo: 'acme/specs', connectedBy: 'octo' } } as ProjectConfig;
    const before = ghCalls;
    expect(await p.access('reader', project)).toBe('read');
    PERMS.reader!['acme/specs'] = { pull: true, push: true };
    expect(await p.access('reader', project)).toBe('read'); // cached
    expect(ghCalls - before).toBe(1);
    now += 5 * 60_000 + 1;
    expect(await p.access('reader', project)).toBe('write');
    PERMS.reader!['acme/specs'] = { pull: true, triage: true, push: false };
    p.forget('reader');
    expect(await p.access('reader', project)).toBe('read');
    // GitHub answers 401: the token is marked revoked → none, and stays none.
    revokedAtGithub.add('teamy');
    expect(await p.access('teamy', project)).toBe('none');
    expect(await store.token('teamy')).toBeNull();
    revokedAtGithub.delete('teamy');
    await store.saveToken('teamy', tokenOf('teamy'), ['repo']);
  });
});

describe('personal agent tokens', () => {
  let readerToken: string;
  let octoToken: string;

  it('are created by a signed-in user, shown once, stored hashed', async () => {
    const create = async (login: string, project = 'specs', name = 'laptop') =>
      app.inject({ method: 'POST', url: `/ui/p/${project}/tokens`, headers: { host: new URL(base).host, origin: base, 'x-mandate-ui': '1', 'content-type': 'application/json', cookie: await sessionCookie(login) }, payload: { name } });
    const r = await create('reader');
    expect(r.statusCode).toBe(201);
    readerToken = r.json().token;
    expect(readerToken).toMatch(/^mndp_specs_/);
    expect(r.json()).toMatchObject({ access: 'read', record: { login: 'reader', project: 'specs', name: 'laptop' } });
    octoToken = (await create('octo')).json().token;
    const list = await app.inject({ url: '/ui/p/specs/tokens', headers: { host: new URL(base).host, 'x-mandate-ui': '1', cookie: await sessionCookie('reader') } });
    expect(list.json().items).toHaveLength(1);
    expect(list.payload).not.toContain(readerToken);
    expect(list.payload).not.toContain('hash');
    // Stored hashed in the server-state database (never the token itself).
    const db = path.join(path.dirname(keys.file), 'state.sqlite');
    const file = [db, `${db}-wal`].map((f) => (existsSync(f) ? readFileSync(f).toString('latin1') : '')).join('');
    expect(file).not.toContain(readerToken);
    expect(file).toContain(createHash('sha256').update(readerToken).digest('hex'));
    // No access to the project: 404 (existence is not revealed).
    expect((await create('stranger')).statusCode).toBe(404);
  });

  it('a pull-only user reads but gets forbidden on writes; a push user writes (recorded as the user)', async () => {
    const r = await mcp('specs', bearer(readerToken));
    expect((await r.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).isError).toBeFalsy();
    const w = await r.callTool({ name: 'spec_create', arguments: SPEC('by-reader') });
    expect(w.isError).toBe(true);
    expect(w.structuredContent).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/push/) } });
    const o = await mcp('specs', bearer(octoToken), 'claude-code');
    expect((await o.callTool({ name: 'spec_create', arguments: SPEC('by-octo') })).isError).toBeFalsy();
    const act = (await o.callTool({ name: 'activity_list', arguments: { limit: 1 } })).structuredContent as { events: { user?: string; source?: string; agent?: string }[] };
    expect(act.events[0]).toMatchObject({ user: 'octo', source: 'token:laptop', agent: 'claude-code' });
  });

  it('team / org grants count (maintain → write); tokens are bound to their project; revocation is immediate', async () => {
    const t = (await tokens.create('teamy', 'specs', 'ci')).token;
    const c = await mcp('specs', bearer(t));
    expect((await c.callTool({ name: 'spec_create', arguments: SPEC('by-teamy') })).isError).toBeFalsy();
    await expect(mcp('other', bearer(t))).rejects.toThrow(/401|unauthorized/);
    const id = (await tokens.list('teamy', 'specs'))[0]!.id;
    expect(await tokens.revoke('teamy', id)).toBe(true);
    await expect(c.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).rejects.toThrow(/unauthorized/);
  });

  it('no access: the project is invisible (404 on the endpoint, hidden on the home list); shared keys are refused', async () => {
    const res = await fetch(`${base}/p/specs/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: await sessionCookie('stranger'), origin: base }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }) });
    expect(res.status).toBe(404);
    const list = async (login: string) => ((await (await mcp(null, { cookie: await sessionCookie(login), origin: base })).callTool({ name: 'project_list', arguments: {} })).structuredContent as { items: { id: string; access: string }[] }).items;
    expect(await list('stranger')).toEqual([]);
    expect((await list('reader')).map((p) => [p.id, p.access])).toEqual([['specs', 'read']]);
    expect((await list('octo')).map((p) => [p.id, p.access])).toEqual([
      ['specs', 'write'],
      ['other', 'write'],
    ]);
    await expect(mcp('specs', bearer(keys.list()[0]!.key))).rejects.toThrow(/per-user access/);
  });
});

describe('MCP OAuth', () => {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'http://127.0.0.1:33418/callback';
  let clientId: string;

  it('advertises protected-resource and authorization-server metadata; 401s point at them', async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/p/specs/mcp`)).json();
    expect(pr).toMatchObject({ resource: `${base}/p/specs/mcp`, authorization_servers: [base] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: base, code_challenge_methods_supported: ['S256'], registration_endpoint: `${base}/oauth/register` });
    const r = await fetch(`${base}/p/specs/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/p/specs/mcp"`);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/p/nope/mcp`)).status).toBe(404);
  });

  it('registers clients dynamically (redirect URIs validated)', async () => {
    expect(redirectUriOk('http://localhost:5555/cb')).toBe(true);
    expect(redirectUriOk('http://evil.example/cb')).toBe(false);
    expect(redirectUriOk('com.example.app:/cb')).toBe(true);
    const bad = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude Code' }) });
    expect(ok.status).toBe(201);
    clientId = (await ok.json()).client_id;
  });

  async function authorize(login: string | null, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', resource: `${base}/p/specs/mcp`, ...extra });
    const cookie = login ? await sessionCookie(login) : undefined;
    const r = await app.inject({ url: `/oauth/authorize?${q}`, headers: { host: new URL(base).host, ...(cookie ? { cookie } : {}) } });
    return { r, cookie };
  }

  async function approve(login: string) {
    const { r, cookie } = await authorize(login);
    const tx = /name="tx" value="([^"]+)"/.exec(r.payload)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const d = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { host: new URL(base).host, origin: base, cookie: cookie!, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ tx, decision: 'allow' }).toString() });
    return new URL(d.headers.location as string);
  }

  const token = (body: Record<string, string>) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  it('authorization code + PKCE → audience-bound tokens acting as the user; refresh rotates', async () => {
    const anon = await authorize(null);
    expect(anon.r.headers.location).toMatch(/^\/auth\/github\/login\?returnTo=%2Foauth%2Fauthorize/);
    const consent = await authorize('reader');
    expect(consent.r.payload).toContain('read only');
    expect((await authorize('stranger')).r.headers.location).toContain('error=invalid_target');
    expect((await authorize('reader', { code_challenge_method: 'plain' })).r.headers.location).toContain('error=invalid_request');
    expect((await authorize('reader', { resource: 'https://elsewhere.example/p/specs/mcp' })).r.headers.location).toContain('error=invalid_target');
    const back = await approve('reader');
    expect(back.searchParams.get('state')).toBe('st1');
    expect(back.searchParams.get('iss')).toBe(base);
    const code = back.searchParams.get('code')!;
    expect((await (await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-123' })).json()).error).toBe('invalid_grant');
    // A failed exchange burns the code (one-time).
    const code2 = (await approve('reader')).searchParams.get('code')!;
    const t = await (await token({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource: `${base}/p/specs/mcp` })).json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, access_token: expect.stringMatching(/^mat_/), refresh_token: expect.stringMatching(/^mrt_/) });
    expect((await (await token({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: redirect, code_verifier: verifier })).json()).error).toBe('invalid_grant');
    const c = await mcp('specs', bearer(t.access_token));
    expect((await c.callTool({ name: 'doc_list', arguments: { kind: 'specs' } })).isError).toBeFalsy();
    expect((await c.callTool({ name: 'spec_create', arguments: SPEC('oauth-reader') })).structuredContent).toMatchObject({ error: { code: 'forbidden' } });
    // Audience: the token is for /p/specs/mcp only.
    await expect(mcp('other', bearer(t.access_token))).rejects.toThrow(/401|unauthorized/);
    const r2 = await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).json();
    expect(r2.access_token).toMatch(/^mat_/);
    expect(r2.refresh_token).not.toBe(t.refresh_token);
    expect((await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).json()).error).toBe('invalid_grant');
    // GitHub authorization revoked: access tokens and refresh stop working.
    await store.markRevoked('reader');
    await expect(mcp('specs', bearer(r2.access_token))).rejects.toThrow(/401|unauthorized/);
    expect((await (await token({ grant_type: 'refresh_token', refresh_token: r2.refresh_token, client_id: clientId })).json()).error).toBe('invalid_grant');
    await store.saveToken('reader', tokenOf('reader'), ['repo']);
  });

  it('a push user connected through OAuth can write', async () => {
    const code = (await approve('octo')).searchParams.get('code')!;
    const t = await (await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier })).json();
    const c = await mcp('specs', bearer(t.access_token), 'codex');
    expect((await c.callTool({ name: 'spec_create', arguments: SPEC('oauth-octo') })).isError).toBeFalsy();
    const act = (await c.callTool({ name: 'activity_list', arguments: { limit: 1 } })).structuredContent as { events: { user?: string; source?: string }[] };
    expect(act.events[0]).toMatchObject({ user: 'octo', source: 'oauth:Claude Code' });
  });
});
