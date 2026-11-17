/**
 * Agent audits requested from the web UI: audit_request (queued, assigned, event audit_requested, exclusive start),
 * live progress, findings feeding the flow (requests for code deviations, questions for spec_wrong / ambiguous), the
 * auditAfterWorkOrder setting and the maturity ladder staying free of an Audited step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueAuditAfterWorkOrder } from '../../src/flow/audit-flow.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { newsFallback } from '../../src/news/index.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity }) as unknown as ToolContext;
const ui = () => ({ ...base(), settings: memorySettings(), clientName: 'mandate-web', principal: { kind: 'ui', user: { login: 'ada', avatarUrl: '' } }, access: 'read', uiAccess: 'write' }) as unknown as ToolContext;
const agent = (login: string, settings = memorySettings()) => ({ ...base(), settings, clientName: 'claude-code', principal: { kind: 'user', login, project: 'test', via: 'token', tokenId: `t-${login}`, tokenName: 'cli' } }) as unknown as ToolContext;
const run = async (name: string, args: unknown, ctx: ToolContext) => {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
};
const news = () => newsFallback('test', fx.activity);
const unread = async (login: string, kind: string) => (await run('news_list', { unread: true, limit: 50 }, agent(login))).body.items.filter((i: any) => i.kind === kind) as { ref: string; summary: string }[];

async function spec() {
  const id = uid('ar');
  const r = await fx.call('spec_create', {
    agent: 'author@test',
    id,
    title: `Spec ${id}`,
    summary: 'A spec.',
    sections: [
      { id: 'design', title: 'Design', summary: 'How.', body: 'The design.', verifiedBy: ['ac-works'] },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'A test proves it.' },
    ],
  });
  if (r.isError) throw new Error(JSON.stringify(r.body));
  return { id, uri: `mandate://specs/${id}` };
}

describe('audit_request', () => {
  it('queues a requested audit for an agent, tells it, keeps the start exclusive and shows live progress', async () => {
    const s = await spec();
    const r = await run('audit_request', { target: s.uri, assignee: 'ada/claude-code' }, ui());
    expect(r.isError).toBe(false);
    const id = r.body.audit.id as string;
    expect(r.body.audit).toMatchObject({ status: 'requested', assignee: 'ada/claude-code', requestedBy: 'ada', progress: { items: { done: 0, total: 1 } } });
    expect(r.body.queued).toBe(true);
    // Offline assignee: the event waits as a news item.
    const ev = (await unread('ada', 'audit_requested')).find((i) => i.ref === `mandate://audits/${id}`);
    expect(ev?.summary).toMatch(/mandate-audit subagent/);
    // Agents may not claim someone else's audit.
    news().presence.note({ id: 'bob/claude-code', label: 'Claude Code', client: 'claude-code', user: 'bob' });
    const bob = await run('audit_start', { request: id }, agent('bob'));
    expect(bob.isError).toBe(true);
    expect(bob.body.error.code).toBe('not_assigned');
    const start = await run('audit_start', { request: id, code: { repo: 'app', commit: 'abcdef1' } }, agent('ada'));
    expect(start.isError).toBe(false);
    expect(start.body.audit.status).toBe('in_progress');
    const rec = await run('audit_record_item', { auditId: id, ref: `${s.uri}/sections/ac-works`, result: 'pass', notes: 'The test covers it.' }, agent('ada'));
    expect(rec.isError).toBe(false);
    expect(rec.body.audit.progress).toEqual({ items: { done: 1, total: 1 }, sections: { done: 1, total: 1 } });
    const done = await run('audit_complete', { auditId: id, summary: 'ok', overview: 'Checked everything.' }, agent('ada'));
    expect(done.isError).toBe(false);
    expect(done.body.flow.requests).toEqual([]);
  });

  it('findings feed the flow: code_deviates becomes a request for the auditing agent, spec_wrong a question for the user', async () => {
    const s = await spec();
    const id = (await run('audit_request', { target: s.uri, assignee: 'ada/claude-code' }, ui())).body.audit.id as string;
    await run('audit_start', { request: id }, agent('ada'));
    const f = (classification: string, title: string) => ({ title, description: `${title} description`, suggestedFix: 'Fix it.', classification });
    const rec = await run('audit_record_item', { auditId: id, ref: `${s.uri}/sections/ac-works`, result: 'fail', notes: 'It does not work.', findings: [f('code_deviates', 'Handler broken'), f('spec_wrong', 'Spec contradicts API')] }, agent('ada'));
    expect(rec.isError).toBe(false);
    const done = await run('audit_complete', { auditId: id, summary: 'findings', overview: 'See findings.' }, agent('ada'));
    expect(done.isError).toBe(false);
    expect(done.body.flow.requests).toHaveLength(1);
    expect(done.body.flow.questions).toHaveLength(1);
    expect((await unread('ada', 'request_assigned')).some((i) => i.ref === `mandate://requests/${done.body.flow.requests[0]}`)).toBe(true);
    const req = (await run('get', { ref: `mandate://requests/${done.body.flow.requests[0]}` }, agent('ada'))).body;
    expect(JSON.stringify(req)).toMatch(/"source":"audit"/);
    expect(JSON.stringify(req)).toMatch(/"assignee":"ada\/claude-code"/);
    const q = (await run('question_get', { id: done.body.flow.questions[0] }, agent('ada'))).body.question;
    expect(q.status).toBe('open');
    expect(q.questions[0].options.map((o: any) => o.label)).toEqual(['Update the spec', 'Fix the code', 'Leave as is']);
  });

  it('auditAfterWorkOrder: off queues nothing, on queues a full audit for the same agent', async () => {
    const s = await spec();
    const wo = await fx.storage.workOrderService.create({ spec: s.id, kind: 'update', status: 'pending', sections: [{ id: 'design' }], createdBy: 'x' } as never, {});
    expect(await queueAuditAfterWorkOrder(agent('ada', memorySettings({ flowPolicy: 'optional' })), wo.id, {})).toBeNull();
    const id = await queueAuditAfterWorkOrder(agent('ada', memorySettings({ auditAfterWorkOrder: 'on' })), wo.id, {});
    expect(id).toBeTruthy();
    const a = (await run('audit_get', { auditId: id }, agent('ada'))).body.audit;
    expect(a).toMatchObject({ status: 'requested', assignee: 'ada/claude-code', trigger: `work-order:${wo.id}` });
    // Not queued twice while one is open.
    expect(await queueAuditAfterWorkOrder(agent('ada', memorySettings({ auditAfterWorkOrder: 'on' })), wo.id, {})).toBeNull();
  });
});
