/**
 * News kinds without a plain event: a claim that went stale (`claim_expired`, swept), a second person confirming a
 * self-approval override (`override_confirmed`, approval_override_confirm), and the outcome of a review / verify work
 * order on the agent's completed work (`review_outcome`: approved / changes requested / findings).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_STALE_AFTER_MS } from '@mandate/shared';
import { callTool, type SessionState, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { MemoryNewsStore, NewsService } from '../../src/news/index.js';
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
const agent = (login: string, session: string) =>
  ({ ...base(), clientName: 'claude-code', principal: { kind: 'user', login, project: 'test', via: 'token', tokenId: `t-${login}`, tokenName: 'cli' }, session: sess(session) }) as unknown as ToolContext;
const ui = (login = 'ada') => ({ ...base(), principal: { kind: 'ui', user: { login, avatarUrl: '' } }, uiAccess: 'write' }) as unknown as ToolContext;

async function call(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
}
async function ok(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  const r = await call(ctx, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body)}`).toBe(false);
  return r.body;
}
const settle = async () => {
  await fx.activity.catchUp().catch(() => undefined);
  await news.idle();
};
const unread = async (login: string, session: string) => (await ok(agent(login, session), 'news_list', { unread: true, limit: 50 })).items as { id: number; kind: string; ref: string; summary: string }[];
const spec = async (ctx: ToolContext, title: string) => {
  const sc = await ok(ctx, 'spec_create', { title, summary: 'S.', sections: [{ title: 'Overview', summary: 'O.', body: 'O.' }] });
  const d = await ok(ctx, 'spec_get', { ref: sc.ref });
  return { ref: sc.ref as string, section: (d.sections ?? d.document?.sections ?? d.outline)[0].id as string };
};

describe('claim_expired', () => {
  it('the claiming session hears once per claim when its claim goes stale; others do not', async () => {
    const a = agent('ada', 'c1');
    const s = await spec(a, 'Stale spec');
    const wo = await ok(a, 'work_order_create', { plan: 'P.', spec: s.ref, sections: [s.section], kind: 'review' });
    await ok(a, 'work_order_claim', { ref: wo.ref });
    const list = () => fx.storage.workOrders.list();
    // Fresh: nothing.
    expect(await news.sweepStaleClaims(list, { force: true })).toBe(0);
    const later = Date.now() + CLAIM_STALE_AFTER_MS + 60_000;
    expect(await news.sweepStaleClaims(list, { force: true, now: later })).toBe(1);
    // Once per claim; throttled without force.
    expect(await news.sweepStaleClaims(list, { force: true, now: later + 1000 })).toBe(0);
    expect(await news.sweepStaleClaims(list, { now: later + 2000 })).toBe(0);
    const items = (await unread('ada', 'c1')).filter((i) => i.kind === 'claim_expired');
    expect(items.map((i) => i.ref)).toEqual([wo.ref]);
    expect(items[0]!.summary).toMatch(/claim on .* expired/);
    expect((await unread('bob', 'b1')).filter((i) => i.kind === 'claim_expired')).toEqual([]);
    // Another session of the same client (the claiming one is alive) does not see it.
    expect((await unread('ada', 'c2')).filter((i) => i.kind === 'claim_expired')).toEqual([]);
    await ok(agent('ada', 'c1'), 'news_ack', { all: true });
  }, 60_000);
});


describe('review_outcome', () => {
  const implemented = async (login: string, session: string, title: string) => {
    const a = agent(login, session);
    const s = await spec(a, title);
    const wo = await ok(a, 'work_order_create', { plan: { steps: ['P.'] }, spec: s.ref, sections: [s.section], kind: 'implement' });
    await ok(a, 'work_order_claim', { ref: wo.ref });
    await ok(a, 'work_order_complete', { ref: wo.ref, outcome: 'Built it.' });
    return s;
  };
  const review = async (s: { ref: string; section: string }, finish: (ctx: ToolContext, ref: string) => Promise<unknown>, kind = 'review') => {
    const r = agent('bob', 'rv');
    const wo = await ok(r, 'work_order_create', { plan: 'Review.', spec: s.ref, sections: [s.section], kind });
    await ok(r, 'work_order_claim', { ref: wo.ref });
    await finish(r, wo.ref);
    await settle();
    return wo.ref as string;
  };

  it('approved, changes requested (failed or blocking comments), findings: one specific item for the implementer', async () => {
    const s1 = await implemented('ada', 'i1', 'Review spec 1');
    const approved = await review(s1, (r, ref) => ok(r, 'work_order_complete', { ref, outcome: 'Looks good, approved.' }));
    const s2 = await implemented('ada', 'i1', 'Review spec 2');
    const failed = await review(s2, (r, ref) => ok(r, 'work_order_fail', { ref, note: 'Changes requested: missing error handling.' }));
    const s3 = await implemented('ada', 'i1', 'Review spec 3');
    const blocking = await review(s3, async (r, ref) => {
      const c = await ok(r, 'comment_add', { target: ref, body: 'Must fix: race in save.', blocking: true });
      await ok(r, 'comment_resolve', { id: c.comment.id });
      await ok(r, 'work_order_complete', { ref, outcome: 'Done.' });
    });
    const s4 = await implemented('ada', 'i1', 'Review spec 4');
    const findings = await review(s4, async (r, ref) => {
      await ok(r, 'comment_add', { target: ref, body: 'Nit: rename the helper.' });
      await ok(r, 'work_order_complete', { ref, outcome: 'OK with one nit.' });
    }, 'verify');
    const items = (await unread('ada', 'i1')).filter((i) => i.kind === 'review_outcome');
    const of = (ref: string) => items.filter((i) => i.ref === ref).map((i) => i.summary);
    expect(of(approved)).toEqual([expect.stringMatching(/^Review .* approved your work: Looks good/)]);
    expect(of(failed)).toEqual([expect.stringMatching(/^Changes requested on your work \(review .*\): Changes requested: missing error handling/)]);
    expect(of(blocking)).toEqual([expect.stringMatching(/^Changes requested on your work .*1 comment, 1 blocking/)]);
    expect(of(findings)).toEqual([expect.stringMatching(/^Findings on your work \(verify .*1 comment/)]);
    // The reviewer gets none of these; the generic "work order changed" is not sent to the implementer for them.
    expect((await unread('bob', 'rv')).filter((i) => i.kind === 'review_outcome')).toEqual([]);
    expect((await unread('ada', 'i1')).filter((i) => i.kind === 'work_order_changed' && [approved, failed, blocking, findings].includes(i.ref))).toEqual([]);
  }, 120_000);
});
