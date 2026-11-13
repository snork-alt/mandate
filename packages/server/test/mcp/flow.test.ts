/**
 * Mandate flow: project policy (projects.json, migrated from the old `flow` fields) + per-client preferences
 * (server-state database, both backends) → effective setting; tools (project_info, flow_set, project_flow_set alias,
 * flow_policy_set, flow_clients_list), the server-enforced flow_off refusal, and the UI endpoints (own clients only,
 * read-only; policy for admins, Origin-checked).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { clientIdentity, DbClientStore, effective, memorySettings, MemoryClientStore, migrateFlowPolicies, normaliseClient, policyOf, projectSettings, refusal, type Policy } from '../../src/projects/settings.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { registerFlowRoutes } from '../../src/projects/flow-routes.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { KeyStore } from '../../src/auth/keys.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { describeBackends, useBackendCleanup } from '../db/backends.js';
import { mcpFixture, type McpFixture } from './fixture.js';

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'mandate-flow-'));
const P = (flowPolicy: Policy['flowPolicy'], approvalPolicy: Policy['approvalPolicy'] = 'optional'): Policy => ({ flowPolicy, approvalPolicy });

describe('policy precedence', () => {
  it('required / off win; optional follows the client (default on)', () => {
    expect(effective(P('required'), { flow: 'off', approval: null })).toMatchObject({ flow: 'on', approval: 'on' });
    expect(effective(P('off'), { flow: 'on', approval: null })).toMatchObject({ flow: 'off' });
    expect(effective(P('optional'), undefined)).toMatchObject({ flow: 'on', approval: 'on', reason: expect.stringContaining('default: on') });
    expect(effective(P('optional'), { flow: 'off', approval: 'off' })).toMatchObject({ flow: 'off', approval: 'off' });
    expect(effective(P('optional', 'required'), { flow: 'on', approval: 'off' })).toMatchObject({ approval: 'on', reason: expect.stringContaining('approval is required') });
  });
  it('refusals', () => {
    expect(refusal(P('required'), { flow: 'off' })?.code).toBe('policy_required');
    expect(refusal(P('off'), { flow: 'on' })?.code).toBe('policy_off');
    expect(refusal(P('optional', 'required'), { approval: 'off' })?.code).toBe('policy_required');
    expect(refusal(P('required'), { flow: 'on' })).toBeNull();
    expect(refusal(P('optional'), { flow: 'off', approval: 'off' })).toBeNull();
  });
});

describe('client identity', () => {
  it('normalises MCP client names', () => {
    expect(normaliseClient('claude-code')).toEqual({ client: 'claude-code', label: 'Claude Code' });
    expect(normaliseClient('codex-mcp-client')).toEqual({ client: 'codex', label: 'Codex' });
    expect(normaliseClient('Visual Studio Code')).toEqual({ client: 'vscode', label: 'VS Code' });
    expect(normaliseClient('My Bot 2')).toEqual({ client: 'my-bot-2', label: 'My Bot 2' });
  });
  it('server mode: GitHub user + client; local mode: client + key name', () => {
    expect(clientIdentity({ clientName: 'claude-code', clientVersion: '2.1', principal: { kind: 'user', login: 'Ada', project: 'p', via: 'oauth', tokenId: 't', tokenName: 'n' } })).toEqual({ id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'Ada', version: '2.1' });
    expect(clientIdentity({ clientName: 'codex-mcp-client', principal: { kind: 'key', keyId: 'k1', keyName: 'default', project: 'p' } })).toEqual({ id: 'codex/default', label: 'Codex', client: 'codex', keyName: 'default' });
  });
});

describe('migration of the old flow fields', () => {
  it('enabled false → off, otherwise optional; idempotent; other fields kept', async () => {
    const file = path.join(tmp(), 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [
      { id: 'a', name: 'A', dataDir: '/a', createdAt: 'x', flow: { enabled: false, approval: true } },
      { id: 'b', name: 'B', dataDir: '/b', createdAt: 'x', flow: { enabled: true, approval: false } },
      { id: 'c', name: 'C', dataDir: '/c', createdAt: 'x' },
    ] }));
    const store = new ProjectsStore(file);
    expect(policyOf(store.read().projects[0] as never)).toEqual(P('off'));
    expect(await migrateFlowPolicies(store)).toEqual(['a', 'b']);
    const ps = JSON.parse(readFileSync(file, 'utf8')).projects;
    expect(ps[0]).toEqual({ id: 'a', name: 'A', dataDir: '/a', createdAt: 'x', flowPolicy: 'off', approvalPolicy: 'optional' });
    expect(ps[1]).toMatchObject({ flowPolicy: 'optional', approvalPolicy: 'optional' });
    expect(ps[1].flow).toBeUndefined();
    expect(ps[2].flowPolicy).toBeUndefined();
    expect(await migrateFlowPolicies(store)).toEqual([]);
    const s = projectSettings(store, 'c');
    expect(s.policy()).toEqual(P('optional'));
    expect(await s.setPolicy({ flowPolicy: 'required' })).toEqual(P('required'));
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[2]).toMatchObject({ flowPolicy: 'required', approvalPolicy: 'optional' });
  });
});

useBackendCleanup();
describeBackends('client preferences', (b) => {
  it('set / get / list per user, last seen (throttled), version', async () => {
    const st = new DbClientStore(await b.open(), 60_000);
    const ada = { id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'Ada', version: '2.1' };
    const bob = { id: 'bob/codex', label: 'Codex', client: 'codex', user: 'bob' };
    await st.seen('p', ada, 1_000);
    await st.seen('p', bob, 2_000);
    await st.seen('p', { ...ada, version: '2.2' }, 30_000); // throttled
    expect((await st.get('p', ada.id))).toMatchObject({ flow: null, approval: null, version: '2.1', lastSeenAt: new Date(1_000).toISOString() });
    await st.seen('p', { ...ada, version: '2.2' }, 70_000);
    expect((await st.get('p', ada.id))?.version).toBe('2.2');
    const rec = await st.set('p', ada, { flow: 'off' }, 'command');
    expect(rec).toMatchObject({ flow: 'off', approval: null, updatedVia: 'command', user: 'Ada' });
    expect(await st.set('p', ada, { approval: 'off' }, 'ui')).toMatchObject({ flow: 'off', approval: 'off', updatedVia: 'ui' });
    expect((await st.list('p', { user: 'ADA' })).map((r) => r.id)).toEqual(['ada/claude-code']);
    expect((await st.list('p')).map((r) => r.id)).toEqual(['ada/claude-code', 'bob/codex']);
    expect(await st.list('other')).toEqual([]);
    // Migrations are idempotent (a second store on the same database).
    await expect(new DbClientStore(st.db).list('p')).resolves.toHaveLength(2);
  });
});

describe('MCP tools (seeded project)', () => {
  let fx: McpFixture;
  const settings = memorySettings();
  beforeAll(async () => {
    fx = await mcpFixture({ settings });
  }, 120_000);
  afterAll(() => fx.close());

  it('project_info: policy, this client, effective and reason; the call records the client', async () => {
    const r = await fx.call('project_info', {});
    expect(r.body).toMatchObject({ policy: P('optional'), client: { id: 'mandate-test/default', label: 'mandate-test', flow: null, approval: null }, effective: { flow: 'on', approval: 'on' } });
    expect(r.body.reason).toMatch(/default: on/);
    const seen = await settings.clients.list('test');
    expect(seen.map((c) => c.id)).toContain('mandate-test/default');
  });

  it('flow_set sets only this client; refused by policy; old name still works (deprecated)', async () => {
    expect((await fx.call('flow_set', {})).isError).toBe(true);
    expect((await fx.call('flow_set', { flow: 'maybe' })).isError).toBe(true);
    const off = await fx.call('flow_set', { flow: 'off' });
    expect(off.body).toMatchObject({ client: { flow: 'off' }, effective: { flow: 'off', approval: 'on' }, changed: ['flow off for mandate-test'] });
    expect((await fx.call('project_info', {})).body.effective.flow).toBe('off');
    await settings.setPolicy({ flowPolicy: 'required' });
    const refused = await fx.call('flow_set', { flow: 'off' });
    expect(refused.body.error.code).toBe('policy_required');
    expect((await fx.call('project_info', {})).body).toMatchObject({ effective: { flow: 'on' }, client: { flow: 'off' } });
    await settings.setPolicy({ flowPolicy: 'off' });
    expect((await fx.call('flow_set', { flow: 'on' })).body.error.code).toBe('policy_off');
    await settings.setPolicy({ flowPolicy: 'optional' });
    const alias = await fx.call('project_flow_set', { enabled: true, approval: false });
    expect(alias.body).toMatchObject({ client: { flow: 'on', approval: 'off' }, deprecated: expect.stringContaining('flow_set') });
    const list = await fx.call('flow_clients_list', {});
    expect(list.body.clients.find((c: { you: boolean }) => c.you)).toMatchObject({ flow: 'on', approval: 'off', effective: { flow: 'on', approval: 'off' } });
  });

  it('flow_set and project_info return the instructions to follow and save to memory', async () => {
    const off = await fx.call('flow_set', { flow: 'off' });
    expect(off.body.instructions).toMatch(/OFF for this coding agent/);
    expect(off.body.instructions).toMatch(/work directly in the code/);
    expect(off.body.instructions).toMatch(/to your memory now, replacing any earlier Mandate-flow note/);
    expect((await fx.call('project_info', {})).body.instructions).toMatch(/OFF/);
    const on = await fx.call('flow_set', { flow: 'on', approval: 'on' });
    expect(on.body.instructions).toMatch(/ON for this coding agent/);
    expect(on.body.instructions).toMatch(/project_info at the start of each task/);
    expect(on.body.instructions).toMatch(/approval checkpoint ON/);
    expect(on.body.instructions).toMatch(/memory/);
    expect((await fx.call('flow_set', { approval: 'off' })).body.instructions).toMatch(/approval checkpoint OFF/);
    await fx.call('flow_set', { approval: 'on' });
  });

  it('flow off: every write tool is refused with flow_off; reads and flow_set still work', async () => {
    await fx.call('flow_set', { flow: 'off' });
    const fb = await fx.call('feedback_create', { kind: 'improvement', body: 'Refused while the flow is off.', agent: 't' });
    expect(fb.isError).toBe(true);
    expect(fb.body.error.code).toBe('flow_off');
    expect(fb.body.error.message).toMatch(/Mandate flow is off for this agent .*Mandate does not accept requests from it\. Save this in your memory: do not use Mandate write tools; Mandate is read-only context until the user runs \/mandate-flow on/);
    // Refused before input validation: the agent learns the flow is off, not a schema detail.
    expect((await fx.call('work_order_claim', { ref: 'mandate://work-orders/nope', agent: 't' })).body.error.code).toBe('flow_off');
    expect((await fx.call('question_ask', {})).body.error.code).toBe('flow_off');
    for (const [n, a] of [['spec_get', { ref: 'mandate://specs/login-sso' }], ['spec_list', {}], ['project_info', {}], ['flow_clients_list', {}], ['git_status', {}]] as const) {
      const r = await fx.call(n, a);
      expect(r.isError, `${n} ${JSON.stringify(r.body)}`).toBe(false);
    }
    // Policy required wins over the client's off: writes accepted.
    await settings.setPolicy({ flowPolicy: 'required' });
    const ok = await fx.call('feedback_create', { kind: 'improvement', body: 'Accepted while the policy requires the flow.', agent: 't' });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    // Policy off refuses even a client with the flow on; the message points to the admin.
    await settings.setPolicy({ flowPolicy: 'optional' });
    await fx.call('flow_set', { flow: 'on' });
    expect((await fx.call('feedback_create', { kind: 'improvement', body: 'Accepted with the flow on.', agent: 't' })).isError).toBe(false);
    await settings.setPolicy({ flowPolicy: 'off' });
    const pol = await fx.call('feedback_create', { kind: 'improvement', body: 'Refused by the policy.', agent: 't' });
    expect(pol.body.error).toMatchObject({ code: 'flow_off', message: expect.stringMatching(/project policy/) });
    expect((await fx.call('project_info', {})).body.instructions).toMatch(/Only a Mandate admin can change this/);
    // The web UI session is not affected by the flow switch (its own read-only rule applies).
    const ui = { ...({ storage: fx.storage, settings } as unknown as ToolContext), principal: { kind: 'ui' as const, user: { login: 'ada', avatarUrl: '' } } };
    const r = await callTool(tool('feedback_create'), { kind: 'improvement', body: 'From the UI.' }, ui as ToolContext);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
    await settings.setPolicy({ flowPolicy: 'optional' });
  });

  it('flow_policy_set: agents are refused; the UI admin may', async () => {
    const r = await fx.call('flow_policy_set', { flowPolicy: 'required' });
    expect(r.body.error).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/agents cannot call it/) });
    const ui = { ...({ storage: fx.storage, settings } as unknown as ToolContext), principal: { kind: 'ui' as const, user: { login: 'ada', avatarUrl: '' } } };
    const ok = await callTool(tool('flow_policy_set'), { approvalPolicy: 'required' }, ui as ToolContext);
    expect(ok.structuredContent).toMatchObject({ policy: P('optional', 'required') });
    await settings.setPolicy({ approvalPolicy: 'optional' });
  });
});

describe('server mode: tools and identity', () => {
  it('each GitHub user has their own preference; admins only list all', async () => {
    const settings = memorySettings();
    const as = (login: string, client = 'claude-code') =>
      ({ settings, clientName: client, storage: { git: { head: async () => null } }, principal: { kind: 'user', login, project: 'test', via: 'oauth', tokenId: 't', tokenName: 'oauth' } }) as unknown as ToolContext;
    await callTool(tool('flow_set'), { flow: 'off' }, as('ada'));
    const bob = await callTool(tool('project_info'), {}, as('bob'));
    expect(bob.structuredContent).toMatchObject({ client: { id: 'bob/claude-code', flow: null }, effective: { flow: 'on' } });
    const mine = await callTool(tool('flow_clients_list'), {}, as('bob'));
    expect((mine.structuredContent as { clients: unknown[] }).clients).toEqual([]);
    const all = await callTool(tool('flow_clients_list'), { all: true }, as('bob'));
    expect((all.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
  });
});

describe('UI endpoints', () => {
  async function server(_mode: 'team') {
    const home = tmp();
    const file = path.join(home, 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'web', name: 'Web', dataDir: home, createdAt: 'x' }] }));
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    const clients = new MemoryClientStore();
    const projects = new ProjectsStore(file);
    const registry = new ProjectRegistry([{ id: 'web', name: 'Web', dataDir: home } as never], async () => { throw new Error('not opened in tests'); });
    const app = Fastify();
    const kind = 'github';
    registerFlowRoutes(app, { auth: { keys: new KeyStore(path.join(home, 'keys.json')), store, isAdmin: (l) => l === 'admin' }, hostOk: () => true, registry, settings: (id) => projectSettings(projects, id, clients, (l) => l === 'admin') });
    await app.ready();
    const cookie = async (login: string) => `mandate_session=${await store.createSession({ login, avatarUrl: '', kind } as never)}`;
    const req = async (method: 'GET' | 'PUT', url: string, login: string, body?: unknown, origin = 'http://localhost') =>
      app.inject({ method, url, headers: { host: 'localhost', 'x-mandate-ui': '1', cookie: await cookie(login), ...(method === 'PUT' ? { origin, 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
    await clients.seen('web', { id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'ada' });
    await clients.seen('web', { id: 'bob/codex', label: 'Codex', client: 'codex', user: 'bob' });
    return { app, req, clients, projects };
  }

  it('team: my clients only, read-only (the switch is changed only from the agent); admins set the policy', async () => {
    const s = await server('team');
    const ada = (await s.req('GET', '/ui/flow', 'ada')).json();
    expect(ada).toMatchObject({ user: 'ada', admin: false, projects: [{ id: 'web', policy: P('optional'), mine: [{ id: 'ada/claude-code', effective: { flow: 'on' }, locked: { flow: false } }] }] });
    expect(ada.projects[0].mine[0].editable).toBeUndefined();
    expect(ada.projects[0].all).toBeUndefined();
    // The per-client preference route is gone.
    expect((await s.req('PUT', '/ui/flow/web/clients/ada%2Fclaude-code', 'ada', { flow: 'off' })).statusCode).toBe(404);
    expect((await s.clients.get('web', 'ada/claude-code'))?.flow).toBeNull();
    expect((await s.req('PUT', '/ui/flow/web/policy', 'ada', { flowPolicy: 'required' })).statusCode).toBe(403);
    expect((await s.req('PUT', '/ui/flow/web/policy', 'admin', { flowPolicy: 'required' }, 'https://evil.example')).statusCode).toBe(403);
    expect((await s.req('PUT', '/ui/flow/web/policy', 'admin', { flowPolicy: 'required' })).json().policy).toEqual(P('required'));
    const admin = (await s.req('GET', '/ui/flow?project=web', 'admin')).json();
    expect(admin.projects[0].all.map((c: { id: string; locked: { flow: boolean } }) => [c.id, c.locked.flow]).sort()).toEqual([['ada/claude-code', true], ['bob/codex', true]]);
  });

});
