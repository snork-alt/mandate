/** No draft mode: criteria gate on work_order_create, status_set ready alias, decision step, stopped agents. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storedSpecStatusSchema, STORED_SPEC_STATUSES, STANDARD_STATUSES } from '@mandate/shared';
import { listDecisions } from '../../src/storage/decisions.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());
const uid = () => `nd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

describe('no draft mode', () => {
  it('specs are active from creation; legacy draft / ready / in_progress read as active; status_set ready is an alias', async () => {
    expect(STORED_SPEC_STATUSES).toEqual(['active', 'done', 'archived']);
    expect(STANDARD_STATUSES).toEqual(['active', 'deprecated']);
    for (const legacy of ['draft', 'ready', 'in_progress']) expect(storedSpecStatusSchema.parse(legacy)).toBe('active');
    const id = uid();
    const c = await fx.call('spec_create', { id, title: 'Alias spec', summary: 's', agent: 't', sections: [{ id: 'one', title: 'One', summary: 'o', body: 'o' }] });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    expect((await fx.storage.specs.get(id)).status).toBe('active');
    const r = await fx.call('spec_status_set', { ref: id, status: 'ready', agent: 't' });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.status).toBe('active');
  });

  it('work_order_create refuses targeted sections without an acceptance criterion (criteria_missing)', async () => {
    const id = uid();
    await fx.call('spec_create', { id, title: 'Gate spec', summary: 's', agent: 't', sections: [{ id: 'one', title: 'One', summary: 'o', body: 'o' }, { id: 'two', title: 'Two', summary: 't', body: 't' }] });
    const plan = { tasks: [{ text: 'build it', sections: ['one'] }, { text: 'test it', proves: ['ac-one'] }], tests: [{ name: 'one works', proves: ['ac-one'] }] };
    const fb = await fx.call('request_create', { kind: 'improvement', body: 'Make one work', agent: 't' });
    const reason = [fb.body.ref as string];
    const bad = await fx.call('work_order_create', { spec: id, sections: ['one'], kind: 'implement', plan, reason, agent: 't' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe('criteria_missing');
    expect(bad.body.error.message).toContain('one');
    const ins = await fx.call('spec_section_insert', { doc: id, section: { id: 'ac-one', title: 'One works', type: 'acceptance', method: 'test', body: 'one works' }, agent: 't' });
    expect(ins.isError, JSON.stringify(ins.body)).toBe(false);
    await fx.call('spec_section_update', { ref: `mandate://specs/${id}/sections/one`, verifiedBy: ['ac-one'], agent: 't' });
    const ok = await fx.call('work_order_create', { spec: id, sections: ['one'], kind: 'implement', plan, reason, agent: 't' });
    // Past the criteria gate (the flow order gate may still ask for the spec / standard matches).
    expect(ok.body?.error?.code ?? 'created').not.toBe('criteria_missing');
  });
});

describe('questions go through Mandate (flow_next decision)', () => {
  it('returns a pre-written question_ask (purpose decision, blocking), then waits on it', async () => {
    const fb = await fx.call('request_create', { kind: 'improvement', body: 'Clean up the legacy module', agent: 't' });
    expect(fb.isError, JSON.stringify(fb.body)).toBe(false);
    const rid = (fb.body.ref as string).split('/').pop()!;
    const n = await fx.call('flow_next', { request: rid, decision: { kind: 'restore_files', detail: 'src/a.ts, src/b.ts' }, agent: 't' });
    expect(n.isError, JSON.stringify(n.body)).toBe(false);
    expect(n.body.state).toBe('decision');
    expect(n.body.next.tool).toBe('question_ask');
    expect(n.body.next.args).toMatchObject({ purpose: 'decision', blocking: true, request: rid });
    expect(n.body.next.why).toMatch(/END YOUR TURN/);
    expect(n.body.next.args.questions[0].question).toContain('src/a.ts');
    const asked = await fx.call('question_ask', { ...n.body.next.args, agent: 't' });
    expect(asked.isError, JSON.stringify(asked.body)).toBe(false);
    const after = await fx.call('flow_next', { request: rid, decision: { kind: 'restore_files', detail: 'src/a.ts, src/b.ts' }, agent: 't' });
    expect(after.body.state).toBe('waiting');
    expect(after.body.waitingOn?.length).toBe(1);
    const t = await fx.call('flow_next', { request: rid, decision: { kind: 'tradeoff', detail: 'Which one?' }, agent: 't' });
    expect(t.isError).toBe(true); // tradeoff needs options
  });
});

describe('stopped agents', () => {
  it('an active claimed work order idle for more than 3 minutes with no open question is agent_stopped', async () => {
    const id = uid();
    await fx.call('spec_create', { id, title: 'Idle spec', summary: 's', agent: 't', sections: [{ id: 'one', title: 'One', summary: 'o', body: 'o', verifiedBy: ['ac'] }, { id: 'ac', title: 'Works', type: 'acceptance', method: 'test', summary: 'w', body: 'w' }] });
    const created = await fx.call('work_order_create', { spec: id, sections: ['one'], kind: 'implement', plan: { tasks: [{ text: 'p', sections: ['one'] }, { text: 'prove', proves: ['ac'] }], tests: [{ name: 'works', proves: ['ac'] }] }, agent: 't' });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const wo = (created.body.ref as string).split('/').pop()!;
    await fx.call('work_order_claim', { ref: wo, agent: 'claude-code' });
    const idle = (min: number) => listDecisions(fx.storage, { kinds: ['agent_stopped'], limit: 200 }, Date.now() + min * 60_000).then((l) => l.items.find((d) => d.ref.endsWith(wo)));
    expect(await idle(1)).toBeUndefined();
    const stopped = await idle(5);
    expect(stopped?.title).toMatch(/claude-code stopped on/);
    expect(stopped?.question).toMatch(/no question open/);
    // An open Mandate question for it: it is waiting for the user, not stopped.
    const q = await fx.call('question_ask', { purpose: 'decision', blocks: [`mandate://work-orders/${wo}`], blocking: true, questions: [{ header: 'Pick', question: 'A or B?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A' }], agent: 'claude-code' });
    expect(q.isError, JSON.stringify(q.body)).toBe(false);
    expect(await idle(5)).toBeUndefined();
  });
});
