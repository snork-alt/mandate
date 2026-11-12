/**
 * Attribution (lineage-brief §7, user decision 2026-11-12): user tracking is SERVER MODE ONLY.
 * - server mode: every write records the user from the authenticated principal (GitHub login, or service:<name> for a
 *   service-account key) as `Mandate-User` (+ legacy `Agent-User`), and the agent; records get createdByUser / byUser;
 *   history, file meta and activity return user and agent separately; shared project keys are refused.
 * - local mode: no user is ever recorded or returned (agent only).
 * - the user is never taken from client input.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { callTool, defineTool, principalUser, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings, uiActor } from '../../src/projects/settings.js';
import { recentWriters } from '../../src/storage/writers.js';
import { agentAuthPolicy, authenticate } from '../../src/auth/http.js';
import { AgentTokens } from '../../src/auth/agent-tokens.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import type { Principal } from '../../src/auth/http.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../../data/repo');
let storage: Storage;
let dir: string;
beforeAll(async () => {
  const root = await tempDir();
  dir = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', SOURCE, dir]);
  const git = new EsGitStore({ dir, author: { name: 'Test', email: 'test@example.com' } });
  await git.open();
  storage = createStorage(git);
}, 60_000);
afterAll(cleanupTempDirs);

const USER: Principal = { kind: 'user', login: 'octocat', project: 'test', via: 'oauth', tokenId: 'c1', tokenName: 'claude-code' };
const ctxOf = (mode: 'local' | 'server', principal?: Principal): ToolContext =>
  ({ storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), settings: memorySettings(mode), clientName: 'claude-code', ...(principal ? { principal } : {}) }) as ToolContext;
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
async function call(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const r = await callTool(tool(name), args, ctx);
  const body = r.structuredContent as Record<string, any>;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}
const lastMessage = () => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const spec = (id: string) => ({
  title: id,
  summary: 'Attribution test.',
  sections: [
    { title: 'Overview', summary: 'What.', body: 'Body.' },
    { title: 'Ac works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'Proven.' },
  ],
});

describe('server mode: user + agent on every write', () => {
  it('records Mandate-User (and Agent-User) from the principal, and returns them in history and file meta', async () => {
    const ctx = ctxOf('server', USER);
    const id = uid('srv');
    await call(ctx, 'spec_create', spec(id));
    const msg = lastMessage();
    expect(msg).toMatch(/^Mandate-User: octocat$/m);
    expect(msg).toMatch(/^Agent-User: octocat$/m);
    expect(msg).toMatch(/^Agent: claude-code$/m);
    const h = await call(ctx, 'history_get', { ref: `mandate://specs/${id}` });
    expect(h.entries[0]).toMatchObject({ user: 'octocat', agent: 'claude-code' });
    const meta = await storage.history.meta(`specs/${id}.md`);
    expect(meta.createdBy).toMatchObject({ user: 'octocat', agent: 'claude-code' });
    expect(meta.lastEditedBy).toMatchObject({ user: 'octocat', agent: 'claude-code' });
    // the "by user" history filter
    expect((await call(ctx, 'history_get', { ref: `mandate://specs/${id}`, user: 'octocat' })).entries).toHaveLength(1);
    expect((await call(ctx, 'history_get', { ref: `mandate://specs/${id}`, user: 'someone-else' })).entries).toHaveLength(0);
  });

  it('stores createdByUser on feedback and byUser on verifications', async () => {
    const ctx = ctxOf('server', USER);
    const id = uid('srvrec');
    await call(ctx, 'spec_create', spec(id));
    const fb = await call(ctx, 'feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'bug', body: 'b' });
    expect((await storage.feedback.get(fb.ref.split('/').pop())).createdByUser).toBe('octocat');
    const v = await call(ctx, 'verification_record', { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test' });
    expect(v.verification.byUser).toBe('octocat');
    expect(v.verification.by).toBe('claude-code');
  });

  it('a service-account key is attributed as service:<name>; a plain shared key has no user', () => {
    const svc: Principal = { kind: 'key', keyId: 'key_1', keyName: 'ci', project: 'test', service: true };
    expect(principalUser({ principal: svc, settings: memorySettings('server') })).toBe('service:ci');
    expect(principalUser({ principal: { kind: 'key', keyId: 'k', keyName: 'default', project: 'test' }, settings: memorySettings('server') })).toBeUndefined();
  });

  it('UI-triggered writes are attributed to the signed-in GitHub user', () => {
    expect(uiActor('server', { kind: 'user', login: 'octocat' })).toEqual({ user: 'octocat', agent: 'mandate-ui' });
  });

  it('writers_recent groups writes by user / agent / credential', async () => {
    const w = await recentWriters(storage.git, 'server', 2000);
    expect(w.writers.some((x) => x.user === 'octocat' && x.agent === 'claude-code')).toBe(true);
    expect(w.unattributed).toBeGreaterThan(0); // the fixture's older commits
  });
});

describe('the user is never taken from client input', () => {
  it('refuses a client-supplied createdByUser / byUser (strict schemas) and keeps the principal user', async () => {
    const ctx = ctxOf('server', USER);
    const id = uid('spoof');
    await call(ctx, 'spec_create', spec(id));
    const r = await callTool(tool('feedback_create'), { targets: [`mandate://specs/${id}/sections/overview`], kind: 'bug', body: 'b', createdByUser: 'mallory' }, ctx);
    expect(r.isError).toBe(true);
    const v = await callTool(tool('verification_record'), { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test', byUser: 'mallory' }, ctx);
    expect(v.isError).toBe(true);
  });

  it('a tool cannot set reserved trailers and agent cannot smuggle a trailer line', async () => {
    let seen: Record<string, string> = {};
    const t = defineTool({
      name: 'spoof_write',
      title: 's',
      kind: 'write',
      description: 's',
      input: z.object({ who: z.string() }).strict(),
      trailers: (a) => ({ 'Mandate-User': a.who, 'Agent-User': a.who, 'Caused-By': 'mandate://feedback/x', Feedback: 'fb-1' }),
      run: async (_a, c) => {
        seen = c.commit!.trailers;
        return {};
      },
    });
    await callTool(t, { who: 'mallory' }, ctxOf('server', USER));
    expect(seen['Mandate-User']).toBe('octocat');
    expect(seen['Agent-User']).toBe('octocat');
    expect(seen['Caused-By']).toBeUndefined();
    expect(seen.Feedback).toBe('fb-1');
    await callTool(t, { who: 'mallory' }, ctxOf('local'));
    expect(seen['Mandate-User']).toBeUndefined();
    const bad = await callTool(t, { who: 'x', agent: 'a\nMandate-User: mallory' }, ctxOf('server', USER));
    expect(bad.isError).toBe(true);
  });
});

describe('local mode: agent only, never a user', () => {
  it('records no user even for a user principal; history, meta and records carry the agent only', async () => {
    const ctx = ctxOf('local', USER);
    const id = uid('loc');
    await call(ctx, 'spec_create', spec(id));
    const msg = lastMessage();
    expect(msg).not.toMatch(/Mandate-User|Agent-User/);
    expect(msg).toMatch(/^Agent: claude-code$/m);
    const h = await call(ctx, 'history_get', { ref: `mandate://specs/${id}` });
    expect(h.entries[0].user).toBeUndefined();
    expect(h.entries[0].agent).toBe('claude-code');
    const meta = await storage.history.meta(`specs/${id}.md`);
    expect(meta.createdBy?.user).toBeUndefined();
    expect(meta.createdBy?.agent).toBe('claude-code');
    const fb = await call(ctx, 'feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'bug', body: 'b' });
    expect((await storage.feedback.get(fb.ref.split('/').pop())).createdByUser).toBeUndefined();
    expect(uiActor('local', { kind: 'user', login: 'matteo' })).toEqual({ agent: 'mandate-ui' });
    const w = await recentWriters(storage.git, 'local', 50);
    expect(w.writers.every((x) => x.user === null)).toBe(true);
    expect(w.unattributed).toBe(0);
  });
});

describe('server mode auth: per-user principals only', () => {
  const req = (key: string) => ({ headers: { authorization: `Bearer ${key}` }, method: 'POST' }) as unknown as FastifyRequest;
  let keys: KeyStore;
  let store: AuthStore;
  let shared: string;
  let service: string;
  beforeAll(async () => {
    const home = await tempDir();
    keys = new KeyStore(path.join(home, 'keys.json'), { touchIntervalMs: 0 });
    shared = keys.create('test', 'default').key;
    service = keys.create('test', 'ci', { service: true }).key;
    store = new AuthStore(home, randomBytes(32), 3600_000);
  });

  it('refuses shared project keys with a clear message, accepts named service accounts', async () => {
    const r = await authenticate(req(shared), 'test', { keys, store, mode: 'server', sharedKeys: false });
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(!r.ok && r.message).toMatch(/use MCP sign-in or a personal token/);
    const s = await authenticate(req(service), 'test', { keys, store, mode: 'server', sharedKeys: false });
    expect(s.ok && s.principal).toMatchObject({ kind: 'key', keyName: 'ci', service: true });
  });

  it('local mode keeps the per-project key (agent-only attribution)', async () => {
    const r = await authenticate(req(shared), 'test', { keys, store, mode: 'local' });
    expect(r.ok && r.principal).toMatchObject({ kind: 'key', keyName: 'default' });
    expect(principalUser({ principal: r.ok ? r.principal : undefined, settings: memorySettings('local') })).toBeUndefined();
  });
});

describe('legacy install (auth.github without server.mode): strict, like server mode', () => {
  const req = (key: string) => ({ headers: { authorization: `Bearer ${key}` }, method: 'POST' }) as unknown as FastifyRequest;
  it('the policy treats it as server mode for agents (repo permissions stay explicit-server only)', () => {
    expect(agentAuthPolicy({ mode: 'server', legacyMode: true })).toEqual({ perUserAgents: true, sharedKeys: false, repoAuth: false });
    expect(agentAuthPolicy({ mode: 'server', legacyMode: false })).toEqual({ perUserAgents: true, sharedKeys: false, repoAuth: true });
    expect(agentAuthPolicy({ mode: 'local', legacyMode: false })).toEqual({ perUserAgents: false, sharedKeys: true, repoAuth: false });
  });

  it('shared key 401 with the sign-in hint; service key and personal token accepted', async () => {
    const home = await tempDir();
    const keys = new KeyStore(path.join(home, 'keys.json'), { touchIntervalMs: 0 });
    const shared = keys.create('test', 'default').key;
    const service = keys.create('test', 'ci', { service: true }).key;
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    await store.saveToken('octocat', 'gho_test', ['repo']);
    const agentTokens = new AgentTokens(home);
    const pat = (await agentTokens.create('octocat', 'test', 'laptop')).token;
    const policy = agentAuthPolicy({ mode: 'server', legacyMode: true });
    const opts = { keys, store, mode: 'server' as const, sharedKeys: policy.sharedKeys, agentTokens };
    const r = await authenticate(req(shared), 'test', opts);
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(!r.ok && r.message).toMatch(/MCP sign-in or a personal token.*--service/);
    expect(await authenticate(req(service), 'test', opts)).toMatchObject({ ok: true, principal: { kind: 'key', service: true } });
    const p = await authenticate(req(pat), 'test', opts);
    expect(p).toMatchObject({ ok: true, principal: { kind: 'user', login: 'octocat', via: 'pat' } });
  });
});
