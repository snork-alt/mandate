/**
 * Comments on any object, routed to agents: targets (spec / standard / component sections with #Lx-Ly, requests, work
 * orders, steps), mentions and `to`, the responsible agent (claim holder / request's agent), thread conversation
 * routing, asRequest, blocking (WO completion; a request in flow_next), reopen on reply, presence and the picker data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { newsFallback, type NewsService } from '../../src/news/index.js';
import { responsibleFor, routeOf, unansweredFor } from '../../src/comments/route.js';
import { AgentPresence, suggestAgent } from '../../src/agents/presence.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

vi.setConfig({ testTimeout: 60_000 });

let fx: McpFixture;
let news: NewsService;
let bob: Client; // a second agent client: codex
let bobId: string;
let carolId: string;
let carol: Client;
beforeAll(async () => {
  fx = await mcpFixture();
  news = newsFallback('test', fx.activity);
  const key = fx.served.keys.list()[0]!.name;
  bobId = `codex/${key}`;
  carolId = `gemini/${key}`;
  bob = await connect(fx.url, 'codex');
  carol = await connect(fx.url, 'gemini');
  // Both agents make a call: they become known (and online by activity).
  await bob.callTool({ name: 'project_info', arguments: {} });
  await carol.callTool({ name: 'project_info', arguments: {} });
}, 120_000);
afterAll(async () => {
  await bob?.close().catch(() => undefined);
  await carol?.close().catch(() => undefined);
  await fx?.close();
});

const ME = 'impl@test';
const call = async (c: Client | null, name: string, args: Record<string, unknown> = {}) => {
  const r = c ? await c.callTool({ name, arguments: args }) : await fx.call(name, args).then((x) => ({ isError: x.isError, structuredContent: x.body }));
  return { isError: !!r.isError, body: (r.structuredContent ?? {}) as Record<string, any> };
};
const ok = async (c: Client | null, name: string, args: Record<string, unknown> = {}) => {
  const writes = !/^(comments_list|flow_next|agents_presence|project_info)$/.test(name);
  const r = await call(c, name, { ...(writes ? { agent: c ? (c === bob ? 'codex' : 'gemini') : ME } : {}), ...args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body.error)}`);
  return r.body;
};
const items = async (client: string, kind = 'comment_added') => (await news.store.items('test', client)).filter((i) => i.kind === kind);
const SEC = 'mandate://specs/login-sso/sections/auth-flow';

describe('targets', () => {
  it('comments on spec sections (with a line range), standards, components, requests, work orders and steps', async () => {
    const a = await ok(null, 'comment_add', { target: `${SEC}#L2-L4`, body: 'Range remark.' });
    expect(a.comment.target).toBe(`${SEC}#L2-L4`);
    const std = (await fx.storage.standards.list())[0]!;
    await ok(null, 'comment_add', { target: `mandate://standards/${std.id}`, body: 'On a standard.' });
    const comp = (await fx.storage.components.list())[0] as { id: string; sections: { id: string }[] };
    await ok(null, 'comment_add', { target: `mandate://components/${comp.id}/sections/${comp.sections[0]!.id}`, body: 'On a component section.' });
    const req = await ok(null, 'request_create', { kind: 'improvement', body: 'Allow SSO remember-me.' });
    await ok(null, 'comment_add', { target: req.ref, body: 'On a request.' });
    // threads of a section ignore the line range and other sections
    const l = await ok(null, 'comments_list', { target: SEC });
    expect(l.threads.some((t: any) => t.body === 'Range remark.')).toBe(true);
    const bad = await call(null, 'comment_add', { target: 'mandate://specs/login-sso/sections/nope', body: 'x' });
    expect(bad.isError).toBe(true);
    const bad2 = await call(null, 'comment_add', { target: 'mandate://audits/x', body: 'x' });
    expect(bad2.isError).toBe(true);
  });
});

describe('routing', () => {
  it('to / @mention wake that agent; the writer is never woken; unrouted says so', async () => {
    const before = (await items(bobId)).length;
    const r = await ok(null, 'comment_add', { target: SEC, body: 'Please look.', to: 'codex' });
    expect(r.routing).toEqual({ via: 'to', wakes: [bobId] });
    const m = await ok(null, 'comment_add', { target: SEC, body: 'Hey @codex, thoughts?' });
    expect(m.comment.mentions).toContain('codex');
    expect(m.routing).toEqual({ via: 'mention', wakes: [bobId] });
    const got = await items(bobId);
    expect(got.length).toBe(before + 2);
    expect(got[0]!.summary).toContain('thread');
    expect(got[0]!.ref).toMatch(/^mandate:\/\/comments\/c-/);
    const none = await ok(null, 'comment_add', { target: 'mandate://specs/login-sso/sections/callback', body: 'Nobody is responsible.' });
    expect(none.routing.via).toBe('none');
    expect(none.warnings.join()).toContain('not routed');
  });

  it('the responsible agent: claim holder of the work order; the request\'s agent', async () => {
    const spec = `rt-${Date.now().toString(36)}`;
    await ok(null, 'spec_create', { id: spec, title: 'Routing', summary: 's', sections: [{ id: 'a', title: 'A', summary: 's', body: 'b' }] });
    const wo = await ok(bob, 'work_order_create', { spec, sections: ['a'], kind: 'implement', plan: { steps: ['do it'] } });
    await ok(bob, 'work_order_claim', { ref: wo.ref });
    const c = await ok(null, 'comment_add', { target: `${wo.ref}/sections/a`, body: 'On a WO section, no mention.' });
    expect(c.routing).toEqual({ via: 'responsible', wakes: [bobId] });
    const onSpec = await ok(null, 'comment_add', { target: `mandate://specs/${spec}/sections/a`, body: 'On the spec section being implemented.' });
    expect(onSpec.routing.wakes).toEqual([bobId]);
    const step = await ok(null, 'comment_add', { target: `${wo.ref}/steps/s1`, body: 'On a step.' });
    expect(step.routing.via).toBe('responsible');
    // the request's agent
    const req = await ok(carol, 'request_create', { kind: 'improvement', body: 'Carol request.' });
    const onReq = await ok(null, 'comment_add', { target: req.ref, body: 'Remark on the request.' });
    expect(onReq.routing).toEqual({ via: 'responsible', wakes: [carolId] });
  });

  it('a thread is a conversation: a reply without mention goes to the agents in the thread; a reply reopens a resolved thread', async () => {
    const root = await ok(null, 'comment_add', { target: SEC, body: 'Question for @codex.' });
    await ok(bob, 'comment_add', { target: SEC, parent: root.comment.id, body: 'Answer.' });
    await ok(bob, 'comment_resolve', { id: root.comment.id });
    const before = (await items(bobId)).length;
    const reply = await ok(null, 'comment_add', { target: SEC, parent: root.comment.id, body: 'One more thing.' });
    expect(reply.routing).toEqual({ via: 'thread', wakes: [bobId] });
    expect((await items(bobId)).length).toBe(before + 1);
    expect(reply.thread.status).toBe('open'); // reopened
    // the delivered summary carries the thread so far
    expect((await items(bobId))[0]!.summary).toMatch(/Answer\..*One more thing/);
  });

  it('to: any wakes the online agents; asRequest is stored and shown in the event', async () => {
    const r = await ok(null, 'comment_add', { target: 'mandate://specs/login-sso/sections/callback', body: 'Anyone?', to: 'any', asRequest: true });
    expect(r.routing.via).toBe('any');
    expect(r.routing.wakes.sort()).toEqual([bobId, carolId].sort());
    expect(r.comment).toMatchObject({ to: 'any', asRequest: true });
    expect((await items(carolId))[0]!.summary).toContain('make it a request');
  });

  it('flow_next lists unanswered comments routed to the agent, and a reply clears them', async () => {
    const root = await ok(null, 'comment_add', { target: SEC, body: 'Inbox check @gemini' });
    const before = await ok(carol, 'flow_next', {});
    expect(before.comments.unanswered.map((t: any) => t.thread)).toContain(root.comment.id);
    expect(before.commentsNote).toContain('Treating this as a request');
    await ok(carol, 'comment_add', { target: SEC, parent: root.comment.id, body: 'Done.' });
    const after = await ok(carol, 'flow_next', {});
    expect((after.comments?.unanswered ?? []).map((t: any) => t.thread)).not.toContain(root.comment.id);
    // reading the thread marks its event read
    expect((await items(carolId)).filter((i) => i.ref.endsWith(root.comment.id) && !i.readAt)).toHaveLength(0);
  });

  it('a request converted from a comment: source comment, and the inbox asks to resolve the thread when it is closed', async () => {
    const root = await ok(null, 'comment_add', { target: SEC, body: 'Please also support passkeys @gemini' });
    const req = await ok(carol, 'request_create', { kind: 'improvement', body: 'Passkeys', source: 'comment', relatedTo: [SEC, root.uri] });
    expect(req.request?.source ?? req.feedback?.source).toBe('comment');
    await ok(carol, 'request_close', { ref: req.ref, resolution: 'rejected', resolutionNote: 'test' });
    const inbox = await ok(carol, 'flow_next', {});
    expect(inbox.comments.converted.map((t: any) => t.thread)).toContain(root.comment.id);
  });
});

describe('blocking', () => {
  it('a blocking comment on a request stops it in flow_next until resolved', async () => {
    const req = await ok(carol, 'request_create', { kind: 'improvement', body: 'Blocked by a comment.' });
    const c = await ok(null, 'comment_add', { target: req.ref, body: 'Must fix first.', blocking: true });
    const f = await ok(carol, 'flow_next', { request: req.ref });
    expect(f.state).toBe('comments');
    expect(f.next.tool).toBe('comments_list');
    await ok(carol, 'comment_resolve', { id: c.comment.id });
    expect((await ok(carol, 'flow_next', { request: req.ref })).state).not.toBe('comments');
  });

  it('a blocking comment on a step gates work_order_complete', async () => {
    const spec = `bk-${Date.now().toString(36)}`;
    await ok(null, 'spec_create', { id: spec, title: 'Blocking', summary: 's', sections: [{ id: 'a', title: 'A', summary: 's', body: 'b' }] });
    const wo = await ok(null, 'work_order_create', { spec, sections: ['a'], kind: 'implement', plan: { steps: ['one'] } });
    await ok(null, 'work_order_claim', { ref: wo.ref });
    await ok(null, 'comment_add', { target: `${wo.ref}/steps/s1`, body: 'Blocker', blocking: true });
    const r = await call(null, 'work_order_complete', { agent: ME, ref: wo.ref, outcome: 'x' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('open_comments');
  });
});

describe('presence', () => {
  it('lists agents with state and busyWith; suggests an idle agent on the repo, else the least busy; picker when nobody is responsible', async () => {
    const stream = news.presence.open({ id: bobId, label: 'Codex', client: 'codex' });
    const r = await ok(null, 'agents_presence', { ref: 'mandate://specs/login-sso/sections/callback' });
    const b = r.agents.find((a: any) => a.id === bobId);
    expect(['online', 'busy']).toContain(b.state);
    expect(b.handle).toBe('codex');
    expect(r.needsPicker).toBe(true);
    expect(r.suggested).toBeTruthy();
    stream();
  });

  it('presence and suggestion rules (pure)', () => {
    const p = new AgentPresence();
    const a = { id: 'x/claude-code', label: 'Claude Code', client: 'claude-code', user: 'x' };
    const b = { id: 'y/claude-code', label: 'Claude Code', client: 'claude-code', user: 'y' };
    const closeA = p.open(a);
    p.note(b, 'claude-code', 'web');
    expect(p.get(a.id)!.streams).toBe(1);
    const views = p.list([]);
    expect(views.find((v) => v.id === a.id)!.state).toBe('online');
    expect(views.map((v) => v.handle).sort()).toEqual(['x-claude-code', 'y-claude-code']); // not unique: mentionable full handles
    expect(suggestAgent(views, ['web'])).toBe(b.id);
    closeA();
    expect(p.isOnline(a.id, Date.now() + 10 * 60_000)).toBe(false);
    expect(responsibleFor('mandate://specs/s/sections/a', { presence: p, workOrders: [], requests: [] })).toEqual([]);
    const th: any = { id: 'c-1', uri: 'u', target: 'mandate://specs/s', author: { agent: 'mandate-ui', user: 'u' }, body: 'x', status: 'open', events: [], replies: [], createdAt: '' };
    expect(routeOf(th, th, { presence: p, workOrders: [], requests: [] }).via).toBe('none');
    expect(unansweredFor(a.id, [th], { presence: p, workOrders: [], requests: [] })).toEqual([]);
  });
});
