/**
 * Requests filed in the web UI: source "ui", assignee (client / any), exclusive start, offline queue + catch-up on
 * connect, plan-only (plan_ready, approve), reassign, and the @-references of the body as context.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catchUpAssigned } from '../../src/flow/assign.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { newsFallback } from '../../src/news/index.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
  fx.finishSteps = false;
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity }) as unknown as ToolContext;
const ui = () => ({ ...base(), settings: memorySettings(), clientName: 'mandate-web', principal: { kind: 'ui', user: { login: 'ada', avatarUrl: '' } }, access: 'read', uiAccess: 'write' }) as unknown as ToolContext;
const agent = (login: string) => ({ ...base(), settings: memorySettings(), clientName: 'claude-code', principal: { kind: 'user', login, project: 'test', via: 'token', tokenId: `t-${login}`, tokenName: 'cli' } }) as unknown as ToolContext;
const run = async (name: string, args: unknown, ctx: ToolContext) => {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
};
const news = () => newsFallback('test', fx.activity);
const online = (login: string) => news().presence.note({ id: `${login}/claude-code`, label: 'Claude Code', client: 'claude-code', user: login });
const unread = async (login: string) => (await run('news_list', { unread: true, limit: 50 }, agent(login))).body.items.filter((i: any) => i.kind === 'request_assigned') as { ref: string; summary: string }[];
const AGENT = 'flow@test';
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
const read = async (name: string, args: Record<string, unknown>) => (await fx.call(name, args)).body;
const create = async (args: Record<string, unknown>) => {
  const r = await run('request_create', { kind: 'improvement', body: 'Add SSO login', ...args }, ui());
  if (r.isError) throw new Error(JSON.stringify(r.body));
  return r.body;
};

describe('request_create from the web UI', () => {
  it('is callable by the UI principal, source ui, with assignee / priority / planOnly and @-reference context', async () => {
    const spec = uid('ra-ctx');
    await ok('spec_create', { id: spec, title: 'Ctx', summary: 's', sections: [{ id: 'overview', title: 'Overview', summary: 's', body: 'b' }] });
    const r = await create({ assignee: 'nobody/claude-code', priority: 'high', planOnly: true, body: `Change mandate://specs/${spec}/sections/overview please.` });
    expect(r.request).toMatchObject({ source: 'ui', createdByUser: 'ada', priority: 'high', planOnly: true, assignee: 'nobody/claude-code', context: [`mandate://specs/${spec}/sections/overview`] });
    expect(r.queued).toBe(true);
  });
  it('agents cannot claim source ui', async () => {
    const r = await run('request_create', { kind: 'improvement', body: 'x', source: 'ui' }, agent('bob'));
    expect(r.isError).toBe(true);
  });
});

describe('assignment', () => {
  it('an offline assignee stays queued and is told when it connects; others cannot take it', async () => {
    const r = await create({ assignee: 'ada/claude-code' });
    const id = r.request.id as string;
    expect(r.queued).toBe(true);
    const items = await unread('ada');
    expect(items.some((i) => i.ref === `mandate://requests/${id}` && /\/mandate resume/.test(i.summary))).toBe(true);
    // Not on bob's list, and bob cannot start it.
    online('bob');
    const list = await run('flow_next', {}, agent('bob'));
    expect(list.body.requests.map((x: any) => x.request)).not.toContain(`mandate://requests/${id}`);
    const bob = await run('flow_next', { request: id }, agent('bob'));
    expect(bob.isError).toBe(true);
    expect(bob.body.error.code).toBe('already_taken');
    // ada lists it as queued, starting takes it.
    const mine = await run('flow_next', {}, agent('ada'));
    expect(mine.body.requests.find((x: any) => x.request === `mandate://requests/${id}`)).toMatchObject({ queued: true, assignee: 'ada/claude-code' });
    const start = await run('flow_next', { request: id }, agent('ada'));
    expect(start.isError).toBe(false);
    expect((await read('request_get', { ref: id })).request.startedBy).toBe('ada/claude-code');
  });

  it('any agent: online agents are told, the first to start takes it, the other gets already_taken', async () => {
    online('ada');
    online('bob');
    const r = await create({ assignee: 'any' });
    const id = r.request.id as string;
    expect(r.delivered.sort()).toEqual(expect.arrayContaining(['ada/claude-code', 'bob/claude-code']));
    expect((await unread('bob')).some((i) => i.ref === `mandate://requests/${id}`)).toBe(true);
    expect((await run('flow_next', { request: id }, agent('bob'))).isError).toBe(false);
    const late = await run('flow_next', { request: id }, agent('ada'));
    expect(late.isError).toBe(true);
    expect(late.body.error.code).toBe('already_taken');
    // The taker keeps driving it.
    expect((await run('flow_next', { request: id }, agent('bob'))).isError).toBe(false);
  });

  it('catch-up on connect: an any-request is delivered once to an agent that connects later', async () => {
    const r = await create({ assignee: 'any' });
    const id = r.request.id as string;
    const n = news();
    const list = () => fx.storage.feedbackService.list();
    expect(await catchUpAssigned(n, 'late/claude-code', list)).toBeGreaterThanOrEqual(1);
    expect(await catchUpAssigned(n, 'late/claude-code', list)).toBe(0);
    const items = await n.store.items(n.project, 'late/claude-code');
    expect(items.filter((i) => i.ref === `mandate://requests/${id}`)).toHaveLength(1);
  });

  it('reassign while not started (UI), refused once started; agents may not skip the picker rules', async () => {
    const r = await create({ assignee: 'ada/claude-code' });
    const id = r.request.id as string;
    const re = await run('request_assign', { ref: id, assignee: 'bob/claude-code' }, ui());
    expect(re.isError).toBe(false);
    expect((await unread('bob')).some((i) => i.ref === `mandate://requests/${id}`)).toBe(true);
    expect((await run('flow_next', { request: id }, agent('ada'))).body.error?.code).toBe('already_taken');
    expect((await run('flow_next', { request: id }, agent('bob'))).isError).toBe(false);
    const late = await run('request_assign', { ref: id, assignee: 'ada/claude-code' }, ui());
    expect(late.isError).toBe(true);
    expect(late.body.error.code).toBe('already_started');
  });
});

describe('plan only', () => {
  it('stops at plan_ready after the work order, no claim, approve re-notifies and continues', async () => {
    const spec = uid('ra-plan');
    await ok('spec_create', {
      id: spec, title: 'Plan', summary: 's',
      sections: [{ id: 'design', title: 'design', summary: 's', body: 'b', verifiedBy: ['ac-works'] }, { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 's', body: 'A test proves it.' }],
    });
    const r = await create({ assignee: 'ada/claude-code', planOnly: true });
    const id = r.request.id as string;
    const ref = `mandate://requests/${id}`;
    await run('flow_next', { request: id }, agent('ada'));
    await read('spec_match', { request: 'Add SSO login', for: id });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'v2', addresses: [ref] });
    expect((await run('flow_next', { request: id }, agent('ada'))).body.state).toBe('work_order');
    const wo = await ok('work_order_create', { spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [ref], plan: { tasks: [{ text: 'a', sections: ['design', 'ac-works'], proves: ['ac-works'] }], files: ['src/a.ts'], tests: [{ name: 't', ref: 'app:t.test.ts#L1-L2', proves: ['ac-works'] }], risks: ['none'] } });
    const n = await run('flow_next', { request: id }, agent('ada'));
    expect(n.body).toMatchObject({ state: 'plan_ready', next: null, done: true, progress: { workOrder: wo.ref.split('/').pop(), tasks: [{ id: 't1', status: 'pending' }], criteria: { total: 1, proved: 0 } } });
    // The UI reads the same state without taking the request.
    expect((await run('flow_next', { request: id }, ui())).body.state).toBe('plan_ready');
    const claim = await fx.call('work_order_claim', { agent: AGENT, ref: wo.ref });
    expect(claim.isError).toBe(true);
    expect(claim.body.error.code).toBe('plan_not_approved');
    // work_order_next does not take it either (consistent reason), and nothing got claimed.
    const nxt = await fx.call('work_order_next', { agent: AGENT, spec });
    expect(nxt.isError).toBe(false);
    expect(nxt.body.workOrder).toBeNull();
    expect(nxt.body.skipped).toEqual([{ id: wo.ref.split('/').pop(), reason: expect.stringContaining('plan_not_approved') }]);
    expect((await read('work_order_get', { ref: wo.ref })).claim ?? null).toBeNull();
    // Only the UI approves.
    expect((await run('request_plan_approve', { ref: id }, agent('ada'))).isError).toBe(true);
    const before = (await unread('ada')).length;
    const ap = await run('request_plan_approve', { ref: id }, ui());
    expect(ap.isError).toBe(false);
    expect((await unread('ada')).length).toBe(before + 1);
    expect((await read('request_get', { ref: id })).request).toMatchObject({ planOnly: false, planApprovedBy: 'ada' });
    expect((await run('flow_next', { request: id }, agent('ada'))).body.state).toBe('claim');
    expect((await fx.call('work_order_claim', { agent: AGENT, ref: wo.ref })).isError).toBe(false);
    // Not plan-only anymore: approving again is refused.
    expect((await run('request_plan_approve', { ref: id }, ui())).body.error.code).toBe('not_plan_only');
  });
});

describe('presence: MCP-only agents', () => {
  it('an agent that only made an MCP call is online but not wakeable; a stream makes it wakeable; "any" requests reach it as news and flow_next {}', async () => {
    const p = news().presence;
    const c = { id: 'mia/claude-code', label: 'Claude Code', client: 'claude-code', user: 'mia' };
    p.note(c);
    expect(p.isOnline(c.id)).toBe(true);
    expect(p.isWakeable(c.id)).toBe(false);
    expect(p.isOnline(c.id, Date.now() + 4 * 60_000)).toBe(true); // 5 minute window
    expect(p.isOnline(c.id, Date.now() + 6 * 60_000)).toBe(false);
    expect(p.list([]).find((v) => v.id === c.id)).toMatchObject({ state: 'online', wakeable: false });
    const r = await create({ assignee: 'any', body: 'Anyone: add a logout button' });
    expect(r.wakeable).toBe(false);
    expect(r.delivered).toContain(c.id);
    expect((await unread('mia')).some((i) => i.ref === `mandate://requests/${r.request.id}`)).toBe(true);
    const list = await run('flow_next', {}, agent('mia'));
    expect(list.body.requests.find((x: any) => x.request === `mandate://requests/${r.request.id}`)).toMatchObject({ queued: true, assignee: 'any' });
    const close = p.open(c);
    expect(p.list([]).find((v) => v.id === c.id)).toMatchObject({ wakeable: true });
    const r2 = await create({ assignee: 'any', body: 'Anyone: add a login button' });
    expect(r2.wakeable).toBe(true);
    close();
    expect(p.isWakeable(c.id)).toBe(true); // re-arm grace
    expect(p.isWakeable(c.id, Date.now() + 3 * 60_000)).toBe(false);
  });
});
