/**
 * Questions through Mandate: question_ask validation (AskUserQuestion shape + recommended), the answer flow from a UI
 * session (uiAllowed), the notification to the asking session and polling (questions_list mine / answered), frozen
 * questions, answered questions as proof (standard writes, feedback approvals and overrides), decisions_list
 * inclusion, activity events, graph nodes and the per-client `questions` flow setting.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalRef, parseNodeUri } from '@mandate/shared';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { QUESTION_ANSWERED_NOTIFICATION } from '../../src/mcp/tools/questions.js';
import { memorySettings } from '../../src/projects/settings.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity }) as unknown as ToolContext;
const ui = (mode: 'local' | 'server' = 'server', uiAccess: 'read' | 'write' = 'write', login = 'ada') =>
  ({ ...base(), settings: memorySettings(mode), clientName: 'mandate-web', principal: { kind: 'ui', user: { login, avatarUrl: '' } }, access: 'read', uiAccess }) as ToolContext;
const agent = (mode: 'local' | 'server' = 'server', clientName = 'agent-x') => ({ ...base(), settings: memorySettings(mode), clientName }) as ToolContext;
const run = async (name: string, args: unknown, ctx: ToolContext) => {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
};
const lastCommit = () => execFileSync('git', ['log', '-1', '--format=%B'], { cwd: fx.dir, encoding: 'utf8' });

const opt = (label: string) => ({ label, description: `${label} option` });
const q1 = (over: Record<string, unknown> = {}) => ({ header: 'Session', question: 'How long should remember-me last?', options: [opt('30 days'), opt('7 days')], recommended: '30 days', ...over });
const ask = (over: Record<string, unknown> = {}, ctx: ToolContext = agent()) => run('question_ask', { purpose: 'decision', questions: [q1()], agent: 'asker', ...over }, ctx);

describe('question_ask validation', () => {
  it('accepts the AskUserQuestion shape with recommended, and assigns ask-NNNN', async () => {
    const r = await ask({ context: ['mandate://specs/login-sso'], blocking: true });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.question.id).toMatch(/^ask-\d{4}$/);
    expect(r.body.ref).toBe(`mandate://questions/${r.body.question.id}`);
    expect(r.body.question).toMatchObject({ status: 'open', blocking: true, purpose: 'decision', context: ['mandate://specs/login-sso'], questions: [{ id: 'q1', multiSelect: false }] });
    expect(r.body.next).toMatch(/does not depend on the answer/);
  });

  it.each([
    ['no questions', { questions: [] }],
    ['five questions', { questions: [q1(), q1(), q1(), q1(), q1()] }],
    ['one option', { questions: [q1({ options: [opt('A')], recommended: 'A' })] }],
    ['five options', { questions: [q1({ options: ['A', 'B', 'C', 'D', 'E'].map(opt), recommended: 'A' })] }],
    ['recommended not an option', { questions: [q1({ recommended: '90 days' })] }],
    ['header over 12 chars', { questions: [q1({ header: 'Thirteen char' })] }],
    ['a recommended list without multiSelect', { questions: [q1({ recommended: ['30 days'] })] }],
    ['duplicate labels', { questions: [q1({ options: [opt('A'), opt('a')], recommended: 'A' })] }],
    ['an option without description', { questions: [q1({ options: [{ label: 'A' }, opt('B')], recommended: 'A' })] }],
    ['an unknown purpose', { purpose: 'poll' }],
    ['an unknown key', { extra: 1 }],
    ['a context that is not a ref', { context: ['login-sso'] }],
    ['a context that does not exist', { context: ['mandate://specs/nope-nope'] }],
  ])('rejects %s', async (_n, over) => {
    const r = await ask(over);
    expect(r.isError).toBe(true);
    expect(['validation', 'invalid_input']).toContain(r.body.error.code);
  });

  it('multiSelect takes a list of recommended labels', async () => {
    const r = await ask({ questions: [q1({ multiSelect: true, recommended: ['30 days', '7 days'] })] });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
  });

  it('the web UI cannot ask', async () => {
    expect((await run('question_ask', { purpose: 'decision', questions: [q1()] }, ui())).body.error.code).toBe('forbidden');
  });
});

describe('answer flow', () => {
  it('a UI session answers through uiAllowed (server mode: attributed to the user); then the question is frozen', async () => {
    const id = (await ask()).body.question.id;
    expect(tool('question_answer').uiAllowed).toBe(true);
    // Read-only users cannot answer.
    expect((await run('question_answer', { id, answers: { q1: '30 days' } }, ui('server', 'read'))).body.error.code).toBe('forbidden');
    // Every question needs an answer; multiSelect lists only where allowed.
    expect((await run('question_answer', { id, answers: {} }, ui())).body.error.code).toBe('validation');
    expect((await run('question_answer', { id, answers: { q1: ['30 days'] } }, ui())).body.error.code).toBe('validation');
    expect((await run('question_answer', { id, answers: { q9: 'x' } }, ui())).body.error.code).toBe('validation');
    const r = await run('question_answer', { id: `mandate://questions/${id}`, answers: { q1: '30 days' }, notes: 'fine' }, ui());
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.question).toMatchObject({ status: 'answered', answer: { by: { agent: 'mandate-ui', user: 'ada' }, answers: { q1: '30 days' }, notes: 'fine', via: 'ui' } });
    expect(lastCommit()).toMatch(/Question: ask-/);
    // Frozen: no second answer, no cancel.
    expect((await run('question_answer', { id, answers: { q1: '7 days' } }, ui())).body.error.code).toBe('question_frozen');
    expect((await run('question_cancel', { id, reason: 'late', agent: 'asker' }, agent())).body.error.code).toBe('question_frozen');
    expect((await run('question_get', { id }, agent())).body.question.answer.answers.q1).toBe('30 days');
  });

  it('free text answers a single-choice question ("Other")', async () => {
    const id = (await ask()).body.question.id;
    const r = await run('question_answer', { id, answers: { q1: '14 days, as in the contract' } }, ui());
    expect(r.body.question.answer.answers.q1).toBe('14 days, as in the contract');
  });

  it('agents may relay a chat answer in local mode only', async () => {
    const id = (await ask({}, agent('local'))).body.question.id;
    expect((await run('question_answer', { id, answers: { q1: '7 days' }, agent: 'asker' }, agent('server'))).body.error.code).toBe('forbidden');
    const r = await run('question_answer', { id, answers: { q1: '7 days' }, agent: 'asker' }, agent('local'));
    expect(r.body.question.answer).toMatchObject({ via: 'chat', by: { agent: 'asker' } });
  });

  it('cancel and supersede close an open question', async () => {
    const a = (await ask()).body.question.id;
    expect((await run('question_cancel', { id: a, reason: 'no longer needed', agent: 'asker' }, agent())).body.question).toMatchObject({ status: 'cancelled', cancelled: { reason: 'no longer needed' } });
    const b = (await ask()).body.question.id;
    const c = await ask({ supersedes: b });
    expect((await run('question_get', { id: b }, agent())).body.question).toMatchObject({ status: 'superseded', supersededBy: c.body.question.id });
    expect((await ask({ supersedes: b })).body.error.code).toBe('question_frozen');
  });

  it('expired questions are frozen', async () => {
    const id = (await ask({ expiresInHours: 1 })).body.question.id;
    const later = (await fx.storage.questionService.list(Date.now() + 2 * 3_600_000)).find((q) => q.id === id)!;
    expect(later.status).toBe('expired');
  });
});

describe('notification and polling', () => {
  it('the asking session is notified when its question is answered; questions_list mine / answered polls it', async () => {
    const client = await connect(fx.url, 'notify-agent');
    const got: { method: string; params: any }[] = [];
    client.fallbackNotificationHandler = async (n) => void got.push(n as never);
    const other = await connect(fx.url, 'other-agent');
    try {
      const r = await client.callTool({ name: 'question_ask', arguments: { purpose: 'clarification', questions: [q1()], context: ['mandate://specs/login-sso'] } });
      const id = (r.structuredContent as any).question.id as string;
      const before = new Date(Date.now() - 1).toISOString();
      await run('question_answer', { id, answers: { q1: '7 days' } }, ui());
      let n: { params: any } | undefined;
      for (let t = 0; t < 3000 && !n; t += 25) {
        n = got.find((x) => x.method === QUESTION_ANSWERED_NOTIFICATION);
        if (!n) await new Promise((res) => setTimeout(res, 25));
      }
      expect(n?.params).toMatchObject({ id, ref: `mandate://questions/${id}`, answers: { q1: '7 days' } });
      const mine = (await client.callTool({ name: 'questions_list', arguments: { mine: true, status: 'answered', since: before } })).structuredContent as any;
      expect(mine.items.map((q: any) => q.id)).toEqual([id]);
      const theirs = (await other.callTool({ name: 'questions_list', arguments: { mine: true, status: 'answered' } })).structuredContent as any;
      expect(theirs.items.map((q: any) => q.id)).not.toContain(id);
      const about = (await other.callTool({ name: 'questions_list', arguments: { status: 'all', context: 'mandate://specs/login-sso' } })).structuredContent as any;
      expect(about.items.map((q: any) => q.id)).toContain(id);
      // Activity: asked and answered events reference the question and its context.
      const act = await fx.call('activity_list', { ref: `mandate://questions/${id}`, limit: 10 });
      expect(act.body.events.map((e: any) => e.type).sort()).toEqual(['question.answered', 'question.asked']);
    } finally {
      await client.close();
      await other.close();
    }
  });
});

describe('decisions_list and graph', () => {
  it('open questions are decision items with the full question', async () => {
    const id = (await ask({ blocking: true, context: ['mandate://specs/login-sso'] })).body.question.id;
    const r = await fx.call('decisions_list', { kinds: ['question'], limit: 200 });
    const d = r.body.items.find((x: any) => x.ref === `mandate://questions/${id}`);
    expect(d).toMatchObject({ kind: 'question', title: 'Session', suggested: '30 days', subject: 'mandate://specs/login-sso', ask: { id, blocking: true } });
    expect(d.options.map((o: any) => o.id)).toEqual(['30 days', '7 days']);
    // Answered questions leave the list.
    await run('question_answer', { id, answers: { q1: '30 days' } }, ui());
    const after = await fx.call('decisions_list', { kinds: ['question'], limit: 200 });
    expect(after.body.items.some((x: any) => x.ref === `mandate://questions/${id}`)).toBe(false);
  });

  it('a question is a graph node that concerns its context', async () => {
    const id = (await ask({ context: ['mandate://specs/login-sso'] })).body.question.id;
    const uri = `mandate://questions/${id}`;
    expect(parseNodeUri(uri)).toEqual({ kind: 'questions', id });
    expect(canonicalRef(`@mandate:${uri}`)).toBe(uri);
    await fx.index.idle();
    const nb = await fx.call('graph_neighbors', { uri, direction: 'out' });
    expect(nb.isError, JSON.stringify(nb.body)).toBe(false);
    expect(nb.body.edges.map((e: any) => `${e.kind}:${e.to}`)).toContain('concerns:mandate://specs/login-sso');
  });
});

describe('answers as proof', () => {
  const ruleRef = async () => {
    const std = await fx.storage.standards.get('api-conventions');
    return `mandate://standards/api-conventions/sections/${std.sections.find((s) => s.type === 'rule')!.id}`;
  };
  const confirm = async (mode: 'local' | 'server' = 'server', answer: 'ui' | 'chat' | null = 'ui', purpose = 'standard_confirmation') => {
    const id = (await ask({ purpose, questions: [q1({ header: 'Rule', question: 'Change the rule text?', options: [opt('Approve'), opt('Skip')], recommended: 'Approve' })] }, agent(mode))).body.question.id;
    if (answer === 'ui') await run('question_answer', { id, answers: { q1: 'Approve' } }, ui(mode));
    if (answer === 'chat') await run('question_answer', { id, answers: { q1: 'Approve' }, agent: 'asker' }, agent('local'));
    return id as string;
  };

  it('a standard write citing an answered standard_confirmation records User-Confirmed: <id> and who confirmed', async () => {
    const id = await confirm();
    const r = await run('standard_section_update', { ref: await ruleRef(), summary: 'Confirmed through a Mandate question.', cause: `mandate://questions/${id}`, agent: 'asker' }, agent());
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const msg = lastCommit();
    expect(msg).toContain(`User-Confirmed: ${id}`);
    expect(msg).toContain('Confirmed-By: ada');
    expect(msg).toContain(`Caused-By: mandate://questions/${id}`);
    // Lineage: the write is caused by the question.
    await fx.index.idle();
    const nb = await fx.call('graph_neighbors', { uri: `mandate://questions/${id}`, direction: 'in' });
    expect(nb.body.edges.some((e: any) => e.kind === 'caused_by')).toBe(true);
  });

  it('rejects an unanswered confirmation, and one answered by an ineligible principal', async () => {
    const open = await confirm('server', null);
    const r = await run('standard_section_update', { ref: await ruleRef(), summary: 'Not confirmed yet, must be refused.', cause: `mandate://questions/${open}`, agent: 'asker' }, agent());
    expect(r.body.error.code).toBe('question_not_answered');
    // Answered by an agent relaying chat (no signed-in user): not proof in server mode.
    const chat = await confirm('local', 'chat');
    const s = await run('standard_section_update', { ref: await ruleRef(), summary: 'Relayed answer, refused in server mode.', cause: `mandate://questions/${chat}`, agent: 'asker' }, agent('server'));
    expect(s.body.error.code).toBe('question_ineligible');
    // Local mode: the same answer is proof.
    const l = await run('standard_section_update', { ref: await ruleRef(), summary: 'Relayed answer, accepted in local mode.', cause: `mandate://questions/${chat}`, agent: 'asker' }, agent('local'));
    expect(l.isError, JSON.stringify(l.body)).toBe(false);
    expect(lastCommit()).toContain(`User-Confirmed: ${chat}`);
  });

  it('feedback_accept citing an answered approval question records the approver; override eligibility is the approver\'s', async () => {
    const spec = (await fx.storage.specs.list()).find((x) => x.status !== 'archived' && x.sections.length)!;
    const target = `mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`;
    const fb = await run('feedback_create', { targets: [target], kind: 'improvement', body: 'Approve me through a question.', agent: 'asker' }, agent());
    const unanswered = await confirm('server', null, 'approval');
    expect((await run('feedback_accept', { ref: fb.body.ref, cause: `mandate://questions/${unanswered}`, agent: 'asker' }, agent())).body.error.code).toBe('question_not_answered');
    // Without a question, an agent without a user cannot self-approve in server mode.
    expect((await run('feedback_accept', { ref: fb.body.ref, override: true, overrideReason: 'sole maintainer', agent: 'asker' }, agent())).body.error.code).toBe('override_not_allowed');
    const id = await confirm('server', 'ui', 'approval');
    const r = await run('feedback_accept', { ref: fb.body.ref, override: true, overrideReason: 'sole maintainer', cause: `mandate://questions/${id}`, agent: 'asker' }, agent());
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const msg = lastCommit();
    expect(msg).toContain(`User-Approved: ${id}`);
    expect(msg).toContain('Approved-By: ada');
    expect(msg).toContain('Approval-Override: sole maintainer');
    expect((await fx.storage.feedback.get(fb.body.ref.split('/').pop())).acceptedBy).toBe('ada');
  });
});

describe('flow setting: questions via mandate | chat', () => {
  it('defaults to mandate; flow_set questions chat changes project_info.effective', async () => {
    const ctx = agent('local', 'flow-agent');
    expect((await run('project_info', {}, ctx)).body.effective.questions).toBe('mandate');
    const set = await run('flow_set', { questions: 'chat', agent: 'flow-agent' }, ctx);
    expect(set.isError, JSON.stringify(set.body)).toBe(false);
    expect(set.body.changed).toEqual(['questions via chat for flow-agent']);
    const info = await run('project_info', {}, ctx);
    expect(info.body.effective.questions).toBe('chat');
    expect(info.body.reason).toMatch(/questions via chat/);
    expect((await run('flow_set', { questions: 'email', agent: 'flow-agent' }, ctx)).isError).toBe(true);
  });
});
