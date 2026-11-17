/**
 * News feed: per-client items from the activity events (questions answered, work order cancelled, flow changed),
 * routed by session (owning session, client-wide, adoption of a gone session's items), read rules (reading the ref,
 * news_ack), the `news` notice on replies (agent clients only), news_list history (filters, paging) and its wait.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type SessionState, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { DbNewsStore, MemoryNewsStore, NewsService } from '../../src/news/index.js';
import { describeBackends, useBackendCleanup } from '../db/backends.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let news: NewsService;
const settings = memorySettings();
beforeAll(async () => {
  fx = await mcpFixture();
  news = new NewsService('test', new MemoryNewsStore(), fx.activity);
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const sessions = new Map<string, SessionState>();
const sess = (id: string) => sessions.get(id) ?? (sessions.set(id, { subscription: null, id }), sessions.get(id)!);
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity, settings, news });
/** An agent client (`login/claude-code`) in an MCP session. */
const agent = (login: string, session: string, signal?: AbortSignal) =>
  ({ ...base(), clientName: 'claude-code', principal: { kind: 'user', login, project: 'test', via: 'token', tokenId: `t-${login}`, tokenName: 'cli' }, session: sess(session), ...(signal ? { signal } : {}) }) as unknown as ToolContext;
const ui = (login = 'ada') => ({ ...base(), principal: { kind: 'ui', user: { login, avatarUrl: '' } }, uiAccess: 'write' }) as unknown as ToolContext;

async function call(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
}
const settle = async () => {
  await fx.activity.catchUp().catch(() => undefined);
  await news.idle();
};
const ask = async (ctx: ToolContext, header: string) => {
  const req = await call(ctx, 'request_create', { kind: 'improvement', body: `Request for ${header}` });
  expect(req.isError, JSON.stringify(req.body)).toBe(false);
  const r = await call(ctx, 'question_ask', { purpose: 'decision', request: req.body.request.id, questions: [{ header, question: `${header}?`, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A' }] });
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return r.body.question.id as string;
};
const answer = async (id: string) => expect((await call(ui(), 'question_answer', { id, answers: { q1: 'A' } })).isError).toBe(false);
const kinds = (b: Record<string, any>) => ((b.news?.items ?? []) as { kind: string; ref: string }[]).map((i) => `${i.kind} ${i.ref}`);

describe('news in replies', () => {
  it('an answered question reaches the asking session only, until it reads the question', async () => {
    const q = await ask(agent('ada', 's1'), 'Session');
    await call(agent('ada', 's2'), 'project_info'); // another live session of the same client
    await answer(q);
    await settle();
    const r = await call(agent('ada', 's1'), 'spec_list');
    expect(kinds(r.body)).toEqual([`question_answered mandate://questions/${q}`]);
    expect(r.body.news.message).toMatch(/answered question → get it and continue the blocked work/);
    // Shown is not read: still there on the next reply.
    expect(kinds((await call(agent('ada', 's1'), 'project_info')).body)).toHaveLength(1);
    // Other client, other session of the same client, the web UI: nothing.
    expect((await call(agent('bob', 'b1'), 'project_info')).body.news).toBeUndefined();
    expect((await call(agent('ada', 's2'), 'project_info')).body.news).toBeUndefined();
    expect((await call(ui(), 'spec_list')).body.news).toBeUndefined();
    // Reading the question marks it read.
    const got = await call(agent('ada', 's1'), 'question_get', { id: q });
    expect(got.isError).toBe(false);
    expect((await call(agent('ada', 's1'), 'project_info')).body.news).toBeUndefined();
  });

  it('a claimed work order cancelled by someone else is news for the claiming session', async () => {
    const a = agent('ada', 's1');
    const sc = await call(a, 'spec_create', { title: 'News spec', summary: 'S.', sections: [{ title: 'Overview', summary: 'O.', body: 'O.' }] });
    expect(sc.isError, JSON.stringify(sc.body)).toBe(false);
    const spec = (await call(a, 'spec_get', { ref: sc.body.ref })).body;
    const section = (spec.sections ?? spec.document?.sections ?? spec.outline)[0].id as string;
    const wo = await call(a, 'work_order_create', { plan: 'P.', spec: sc.body.ref, sections: [section], kind: 'review' });
    expect(wo.isError, JSON.stringify(wo.body)).toBe(false);
    expect((await call(a, 'work_order_claim', { ref: wo.body.ref })).isError).toBe(false);
    expect((await call(agent('bob', 'b1'), 'work_order_cancel', { ref: wo.body.ref, note: 'not needed' })).isError).toBe(false);
    await settle();
    const r = await call(agent('ada', 's1'), 'spec_list');
    expect(kinds(r.body)).toContain(`work_order_changed ${wo.body.ref}`);
    expect((await call(agent('bob', 'b1'), 'project_info')).body.news).toBeUndefined();
    // news_ack clears it.
    const ids = (r.body.news.items as { id: number; kind: string }[]).filter((i) => i.kind === 'work_order_changed').map((i) => i.id);
    expect((await call(agent('ada', 's1'), 'news_ack', { ids })).body.acknowledged).toBe(ids.length);
    expect(kinds((await call(agent('ada', 's1'), 'project_info')).body).filter((k) => k.startsWith('work_order'))).toEqual([]);
  });

  it('a flow policy change is client-wide news with the new instructions (every session)', async () => {
    await settings.setPolicy({ flowPolicy: 'off' });
    try {
      const s1 = await call(agent('ada', 's1'), 'project_info');
      const item = (s1.body.news?.items ?? []).find((i: { kind: string }) => i.kind === 'flow_changed');
      expect(item?.summary).toMatch(/New instructions: .*OFF/);
      // Client-wide: the other session of the client sees it too; another client gets its own.
      expect(kinds((await call(agent('ada', 's2'), 'project_info')).body).some((k) => k.startsWith('flow_changed'))).toBe(true);
      expect(kinds((await call(agent('bob', 'b1'), 'project_info')).body).some((k) => k.startsWith('flow_changed'))).toBe(true);
      await call(agent('ada', 's1'), 'news_ack', { all: true });
      expect((await call(agent('ada', 's2'), 'project_info')).body.news).toBeUndefined();
    } finally {
      await settings.setPolicy({ flowPolicy: 'optional' });
      for (const [l, s] of [['ada', 's1'], ['bob', 'b1']]) await call(agent(l!, s!), 'news_ack', { all: true });
    }
  });

  it('a closed session’s unread news moves to the next session of the same client', async () => {
    const q = await ask(agent('ada', 's3'), 'Gone');
    sess('s3').closed = true;
    await answer(q);
    await settle();
    expect(kinds((await call(agent('ada', 's2'), 'project_info')).body)).toEqual([`question_answered mandate://questions/${q}`]);
    // Adopted: routed to s2 from now on, not to s1.
    expect((await call(agent('ada', 's1'), 'project_info')).body.news).toBeUndefined();
    await call(agent('ada', 's2'), 'question_get', { id: q });
  });
});

describe('news on user decisions about what the agent caused', () => {
  const firstSection = async (ctx: ToolContext, ref: string, tool: 'spec_get' | 'standard_get') => {
    const d = (await call(ctx, tool, { ref })).body;
    return `${ref}/sections/${(d.sections ?? d.document?.sections ?? d.outline)[0].id as string}`;
  };

  /** An answered standard_confirmation question (standard writes cite one). */
  const confirmed = async (ctx: ToolContext) => {
    const r = await call(ctx, 'question_ask', { purpose: 'standard_confirmation', questions: [{ header: 'Confirm', question: 'Create it?', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }], recommended: 'Yes' }] });
    await call(ui(), 'question_answer', { id: r.body.question.id, answers: { q1: 'Yes' } });
    await call(ctx, 'question_get', { id: r.body.question.id });
    return r.body.question.uri as string;
  };

  it('draft standard activated, stale claim released by a user', async () => {
    const a = agent('ada', 'd1');
    const sc = await call(a, 'spec_create', { title: 'Waiver spec', summary: 'S.', sections: [{ title: 'Overview', summary: 'O.', body: 'O.' }] });
    // Draft standard: ada creates it, the user activates it.
    const draft = await call(a, 'standard_create', { title: 'Draft std', summary: 'S.', sections: [{ title: 'Rule', summary: 'R.', body: 'R.' }], cause: await confirmed(a) });
    expect(draft.isError, JSON.stringify(draft.body)).toBe(false);
    const act = await call(ui(), 'standard_status_set', { ref: draft.body.ref, status: 'active' });
    // Stale claim: ada claims a work order, the user releases the claim.
    const wo = await call(a, 'work_order_create', { plan: 'P.', spec: sc.body.ref, sections: [(await firstSection(a, sc.body.ref, 'spec_get')).split('/').pop()], kind: 'review' });
    expect((await call(a, 'work_order_claim', { ref: wo.body.ref })).isError).toBe(false);
    // Only a stale claim can be released from the UI (claim_fresh otherwise): the release event it makes.
    await news.ingest({ id: `t-release-${Date.now()}`, commit: 'x', type: 'work_order.released', at: new Date().toISOString(), agent: 'mandate-ui', user: 'carol', refs: [wo.body.ref], summary: `claude-code released ${wo.body.ref.split('/').pop()}` });
    await settle();
    const got = kinds({ news: { items: (await call(agent('ada', 'd1'), 'news_list', { unread: true, limit: 50 })).body.items } });
    expect(got).toContain(`claim_released ${wo.body.ref}`);
    if (!act.isError) expect(got).toContain(`standard_draft_decided ${draft.body.ref}`);
    await call(agent('ada', 'd1'), 'news_ack', { all: true });
  }, 60_000);
});

describe('news_list', () => {
  it('history: read and unread, filters, paging; agents only', async () => {
    const all = await call(agent('ada', 's1'), 'news_list', { all: true, limit: 100 });
    expect(all.isError, JSON.stringify(all.body)).toBe(false);
    const items = all.body.items as { id: number; kind: string; read: boolean; ref: string }[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => i.read)).toBe(true);
    expect(items.map((i) => i.id)).toEqual([...items.map((i) => i.id)].sort((a, b) => b - a));
    const p1 = await call(agent('ada', 's1'), 'news_list', { all: true, limit: 1 });
    expect(p1.body.items).toHaveLength(1);
    const p2 = await call(agent('ada', 's1'), 'news_list', { all: true, limit: 1, cursor: p1.body.next });
    expect(p2.body.items[0].id).toBeLessThan(p1.body.items[0].id);
    expect((await call(agent('ada', 's1'), 'news_list', { all: true, kind: 'question_answered' })).body.items.every((i: { kind: string }) => i.kind === 'question_answered')).toBe(true);
    expect((await call(agent('ada', 's1'), 'news_list', { unread: true })).body.items).toEqual([]);
    expect((await call(agent('ada', 's1'), 'news_list', { all: true, since: '2999-01-01T00:00:00Z' })).body.items).toEqual([]);
    expect((await call(ui(), 'news_list', {})).isError).toBe(true);
  });

  it('wait: returns at once with unread news, wakes on new news, times out empty, abort releases, one per session', async () => {
    // Times out empty.
    const t0 = Date.now();
    const empty = await call(agent('ada', 'w1'), 'news_list', { unread: true, wait: 1 });
    expect(empty.body).toMatchObject({ items: [], waited: 'nothing yet' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // Wakes when the answer arrives.
    const q = await ask(agent('ada', 'w1'), 'Wait');
    const pending = call(agent('ada', 'w1'), 'news_list', { unread: true, wait: 60 });
    await new Promise((r) => setTimeout(r, 50));
    expect(news.waiting()).toBe(1);
    // A second wait in the same session is refused.
    expect((await call(agent('ada', 'w1'), 'news_list', { unread: true, wait: 5 })).body.error.code).toBe('wait_in_progress');
    await answer(q);
    await settle();
    const woke = await pending;
    expect(woke.body.waited).toBe('news arrived');
    expect(woke.body.items.map((i: { ref: string }) => i.ref)).toContain(`mandate://questions/${q}`);
    // Unread news: returns immediately.
    const t1 = Date.now();
    expect((await call(agent('ada', 'w1'), 'news_list', { unread: true, wait: 60 })).body.items.length).toBeGreaterThan(0);
    expect(Date.now() - t1).toBeLessThan(2000);
    await call(agent('ada', 'w1'), 'news_ack', { all: true });
    // Abort releases the wait.
    const ac = new AbortController();
    const held = call(agent('ada', 'w2', ac.signal), 'news_list', { unread: true, wait: 60 });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    expect((await held).body.waited).toBe('nothing yet');
    expect(news.waiting()).toBe(0);
  }, 30_000);
});

useBackendCleanup();
describeBackends('news store', (b) => {
  it('watches, dedup, read marks, adoption, flow signature', async () => {
    const s = new DbNewsStore(await b.open());
    await s.watch('p', { client: 'c', ref: 'mandate://questions/ask-0001', session: 's1', agent: 'a', user: null, role: 'asked' });
    expect(await s.watchers('p', ['mandate://questions/ask-0001'])).toHaveLength(1);
    const it1 = await s.add('p', { client: 'c', session: 's1', eventId: 'e1', kind: 'question_answered', ref: 'mandate://questions/ask-0001', summary: 'x', at: '2026-01-01T00:00:00Z' });
    expect(it1?.seq).toBe(1);
    expect(await s.add('p', { client: 'c', session: 's1', eventId: 'e1', kind: 'question_answered', ref: 'r', summary: 'x', at: 'x' })).toBeNull();
    await s.adopt('p', 'c', 's1', 's2');
    expect((await s.items('p', 'c', { unread: true }))[0]!.session).toBe('s2');
    expect((await s.watchers('p', ['mandate://questions/ask-0001']))[0]!.session).toBe('s2');
    expect(await s.markRead('p', 'c', [1])).toBe(1);
    expect(await s.items('p', 'c', { unread: true })).toEqual([]);
    await s.setFlowSig('p', 'c', 'on|on|mandate');
    expect(await s.flowSig('p', 'c')).toBe('on|on|mandate');
  });
});
