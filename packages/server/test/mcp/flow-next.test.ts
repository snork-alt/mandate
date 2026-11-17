/**
 * The driven flow: flow_next walks a request through every stage (spec_match, spec change, work order with the full plan,
 * claim, steps, sections, verification, completion, closed), several requests in flight, questions bound to requests
 * (blocks, waitingOn, release on answer), the same-section conflict, the gates (flow_out_of_order), decisions, and the
 * strict-flow edit guard tool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flowAll, flowFor, type FlowSnapshot } from '../../src/flow/next.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { mcpFixture, recordMatches, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
  fx.finishSteps = false;
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'flow@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
const read = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
};
const next = (request: string) => read('flow_next', { request });
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity }) as unknown as ToolContext;
const uiCtx = () => ({ ...base(), settings: memorySettings(), clientName: 'mandate-web', principal: { kind: 'ui', user: { login: 'ada', avatarUrl: '' } }, access: 'read', uiAccess: 'write' }) as unknown as ToolContext;
const agentCtx = (policy: Parameters<typeof memorySettings>[0] = {}) =>
  ({ ...base(), settings: memorySettings(policy), clientName: 'claude-code', principal: { kind: 'user', login: 'ada', project: 'test', via: 'token', tokenId: 't1', tokenName: 'cli' } }) as unknown as ToolContext;
const run = async (name: string, args: unknown, ctx: ToolContext) => {
  const r = await callTool(tool(name), args, ctx);
  return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
};

async function newSpec(sections = ['overview', 'design']) {
  const id = uid('fn');
  await ok('spec_create', {
    id,
    title: `Spec ${id}`,
    summary: 'A test spec.',
    sections: [
      ...sections.map((s) => ({ id: s, title: s, summary: `${s}.`, body: `The ${s}.`, verifiedBy: ['ac-works'] })),
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'It works.', body: 'A test proves it works.' },
    ],
  });
  return id;
}
const PLAN = (steps = ['Write the code', 'Write the test'], sections = ['design', 'ac-works']) => ({ tasks: steps.map((text, i) => (i === 0 ? { text, sections } : { text, proves: ['ac-works'] })), files: ['src/a.ts'], tests: [{ name: 'it works', ref: 'app:tests/a.test.ts#L1-L20', proves: ['ac-works'] }], risks: ['none'] });
const newRequest = async (body = 'Make it better.') => (await ok('request_create', { kind: 'improvement', body })).request.id as string;

describe('flow_next walks one request through every stage', () => {
  it('matching -> specs -> work_order -> claim -> steps -> sections -> verify -> complete -> done', async () => {
    const spec = await newSpec();
    const rid = await newRequest();
    const ref = `mandate://requests/${rid}`;

    let n = await next(rid);
    expect(n.state).toBe('matching');
    expect(n.next).toMatchObject({ tool: 'spec_match', args: { for: rid } });
    expect(n.done).toBe(false);

    // Out of order: a work order before spec_match and a spec change is refused, with a hint to flow_next.
    const early = await fx.call('work_order_create', { agent: AGENT, spec, kind: 'implement', sections: ['design'], reason: [ref], plan: PLAN() });
    expect(early.isError).toBe(true);
    expect(early.body.error.code).toBe('flow_out_of_order');
    expect(early.body.error.hint).toMatch(/flow_next/);

    const m = await read('spec_match', { request: 'Make the design better', for: rid });
    expect(m.recordedOn).toBe(ref);
    expect((await read('request_get', { ref })).request.specMatch).toMatchObject({ by: expect.any(String), refs: expect.any(Array) });
    n = await next(rid);
    expect(n.state).toBe('specs');
    expect(n.next.tool).toBe('section_update');

    // Still refused: matched but no change addressing it.
    const half = await fx.call('work_order_create', { agent: AGENT, spec, kind: 'implement', sections: ['design'], reason: [ref], plan: PLAN() });
    expect(half.body.error.code).toBe('flow_out_of_order');
    expect(half.body.error.message).toMatch(/spec \/ standard change/);

    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'The design, v2.', addresses: [ref] });
    // The standards and components the request fits come before the work order: matched, then acted on.
    n = await next(rid);
    expect(n).toMatchObject({ state: 'standard_match', next: { tool: 'standard_match', args: { for: rid } } });
    const refusedStd = await fx.call('work_order_create', { agent: AGENT, spec, kind: 'implement', sections: ['design'], reason: [ref], plan: PLAN() });
    expect(refusedStd.body.error.code).toBe('flow_out_of_order');
    expect(refusedStd.body.error.message).toMatch(/standard_match recorded/);
    expect((await read('standard_match', { request: 'Make the design better', files: ['app:src/a.ts'], for: rid })).recordedOn).toBe(ref);
    n = await next(rid);
    if (n.state === 'follows') {
      // A standard in force matched: its rules are inherited through a follows link (here: nothing applies).
      await ok('request_decision_add', { ref: rid, text: 'no matched standard applies: test', reason: 'x' });
      n = await next(rid);
    }
    expect(n).toMatchObject({ state: 'component_match', next: { tool: 'component_match', args: { for: rid } } });
    const cm = await read('component_match', { request: 'Make the design better', files: ['app:src/a.ts'], for: rid });
    expect(cm.recordedOn).toBe(ref);
    expect((await read('request_get', { ref })).request.componentMatch).toMatchObject({ decision: expect.stringMatching(/component$/) });
    n = await next(rid);
    expect(n.state).toBe('component_update');
    const refusedCmp = await fx.call('work_order_create', { agent: AGENT, spec, kind: 'implement', sections: ['design'], reason: [ref], plan: PLAN() });
    expect(refusedCmp.body.error.message).toMatch(/matched component updated|no existing component covers/);
    await ok('request_decision_add', { ref: rid, text: 'no existing component covers this: the sample project has none', reason: 'test' });
    n = await next(rid);
    expect(n.state).toBe('work_order');
    expect(n.next).toMatchObject({ tool: 'work_order_create', args: { kind: 'implement', reason: [ref] } });
    expect(n.next.args.sections).toEqual([`mandate://specs/${spec}/sections/design`]);

    const wo = await ok('work_order_create', { spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [ref], plan: PLAN() });
    n = await next(rid);
    expect(n.state).toBe('claim');
    expect(n.next).toMatchObject({ tool: 'work_order_claim', args: { ref: wo.ref } });

    await ok('work_order_claim', { ref: wo.ref });
    n = await next(rid);
    expect(n).toMatchObject({ state: 'tasks', next: { tool: 'work_order_task_set', args: { task: 't1', status: 'in_progress' } } });
    await ok('work_order_task_set', { ref: wo.ref, task: 't1', status: 'in_progress' });
    n = await next(rid);
    expect(n.next.args).toMatchObject({ task: 't1', status: 'done' });
    await ok('work_order_task_set', { ref: wo.ref, task: 't1', status: 'done', codeRefs: ['app:src/a.ts#L1-L9'] });
    await ok('work_order_task_set', { ref: wo.ref, task: 't2', status: 'done', codeRefs: ['app:tests/a.test.ts#L1-L20'] });

    // The covering tasks are done: the section is recorded by itself (no section step).
    expect((await fx.storage.specs.get(spec)).sections.find((x) => x.id === 'design')?.implementedBy).toBe(wo.ref.split('/').pop());

    n = await next(rid);
    expect(n.state).toBe('verify');
    expect(n.next).toMatchObject({ tool: 'verification_record', args: { criterion: `mandate://specs/${spec}/sections/ac-works`, result: 'pass' } });
    expect(n.next.why).toMatch(/app:tests\/a\.test\.ts/);
    await ok('verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 'app:tests/a.test.ts#L1-L20' } });

    n = await next(rid);
    expect(n).toMatchObject({ state: 'complete', next: { tool: 'work_order_complete' } });
    await ok('work_order_complete', { ref: wo.ref, outcome: 'Delivered.' });

    n = await next(rid);
    expect(n).toMatchObject({ state: 'done', done: true, next: null });
  });
});

describe('several requests in flight', () => {
  it('flow_next without a request lists them; parallel shows the others; mine filters by creator', async () => {
    const a = await newRequest('First thing.');
    const b = await newRequest('Second thing.');
    const all = await read('flow_next', {});
    const ids = all.requests.map((r: any) => r.request);
    expect(ids).toEqual(expect.arrayContaining([`mandate://requests/${a}`, `mandate://requests/${b}`]));
    expect(all.done).toBe(false);
    expect(all.actionable).toBeTruthy();
    const one = await next(a);
    expect(one.parallel.length).toBeGreaterThan(0);
    expect(one.parallel.map((p: any) => p.request)).not.toContain(`mandate://requests/${a}`);
    const mine = await read('flow_next', { mine: true, agent: 'someone-else' });
    expect(mine.requests.map((r: any) => r.request)).not.toContain(`mandate://requests/${a}`);
    expect((await fx.call('flow_next', { request: 'fb-9999' })).body.error.code).toBe('not_found');
  });

  it('two requests on the same section: the second waits for the first work order (and is released when it completes)', async () => {
    const spec = await newSpec(['design']);
    const r1 = await newRequest('Change the design.');
    const r2 = await newRequest('Change the design again.');
    for (const rid of [r1, r2]) {
      await read('spec_match', { request: 'design', for: rid });
      await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: `Design for ${rid}.`, addresses: [`mandate://requests/${rid}`] });
      await recordMatches(fx, AGENT, rid);
    }
    const wo1 = await ok('work_order_create', { spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [`mandate://requests/${r1}`], plan: PLAN() });
    expect((await next(r1)).state).toBe('claim');
    const n2 = await next(r2);
    expect(n2.state).toBe('waiting');
    expect(n2.next).toBeNull();
    expect(n2.waitingOnWorkOrders).toEqual([expect.objectContaining({ workOrder: wo1.ref.split('/').pop(), request: r1 })]);
    // The creation itself is refused by the existing one-open-work-order-per-section rule.
    const clash = await fx.call('work_order_create', { agent: AGENT, spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [`mandate://requests/${r2}`], plan: PLAN() });
    expect(clash.isError).toBe(true);
    // Finish the first one; the second becomes actionable.
    await ok('work_order_claim', { ref: wo1.ref });
    await ok('work_order_task_set', { ref: wo1.ref, tasks: [{ task: 't1', status: 'done' }, { task: 't2', status: 'done' }] });
    await ok('verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 'tests/a.test.ts' } });
    await ok('work_order_complete', { ref: wo1.ref, outcome: 'Done.' });
    expect((await next(r2)).state).toBe('work_order');
  });
});

describe('questions bound to requests', () => {
  const opt = (label: string) => ({ label, description: `${label} option` });
  const q = { header: 'Choice', question: 'Which one should it be?', options: [opt('A'), opt('B')], recommended: 'A' };

  it('request is required inside the flow (not for standard confirmations), validated, and blocks resolve', async () => {
    const rid = await newRequest('Needs a decision.');
    const agent = agentCtx();
    const missing = await run('question_ask', { purpose: 'decision', questions: [q] }, agent);
    expect(missing.body.error.code).toBe('request_required');
    expect((await run('question_ask', { purpose: 'standard_confirmation', questions: [q] }, agent)).isError).toBe(false);
    expect((await run('question_ask', { purpose: 'decision', request: 'fb-9999', questions: [q] }, agent)).body.error.message).toMatch(/does not exist/);
    expect((await run('question_ask', { purpose: 'decision', request: rid, blocks: ['mandate://specs/nope-nope/sections/x'], questions: [q] }, agent)).isError).toBe(true);
    expect((await run('question_ask', { purpose: 'decision', request: rid, blocks: ['not a ref'], questions: [q] }, agent)).isError).toBe(true);
    // Without settings (in-process callers) the request stays optional.
    expect((await fx.call('question_ask', { agent: AGENT, purpose: 'decision', questions: [q] })).isError).toBe(false);
  });

  it('a blocking question puts the request on waitingOn; answering releases it; informational questions block nothing', async () => {
    const rid = await newRequest('Blocked until answered.');
    const agent = agentCtx();
    const info = await run('question_ask', { purpose: 'decision', request: rid, questions: [q] }, agent);
    expect((await next(rid)).waitingOn).toBeUndefined();
    const asked = await run('question_ask', { purpose: 'decision', request: rid, blocks: [`mandate://requests/${rid}`], questions: [q] }, agent);
    expect(asked.body.question).toMatchObject({ request: rid, blocks: [`mandate://requests/${rid}`] });
    const w = await next(rid);
    expect(w).toMatchObject({ state: 'waiting', next: null, waitingOn: [asked.body.question.id] });
    const list = await read('flow_next', {});
    expect(list.waitingOn).toContain(asked.body.question.id);
    await run('question_answer', { id: asked.body.question.id, answers: { q1: 'A' } }, uiCtx());
    expect((await next(rid)).state).toBe('matching');
    void info;
  });

  it('a question on a task blocks only that task (and the section it covers)', async () => {
    const spec = await newSpec(['overview', 'design']);
    const rid = await newRequest('Steps and sections.');
    const ref = `mandate://requests/${rid}`;
    await read('spec_match', { request: 'steps and sections', for: rid });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/overview`, body: 'o2', addresses: [ref] });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'd2', addresses: [ref] });
    await recordMatches(fx, AGENT, rid);
    const wo = await ok('work_order_create', { spec, kind: 'implement', sections: ['overview', 'design', 'ac-works'], reason: [ref], plan: { ...PLAN(['One', 'Two'], ['overview', 'design', 'ac-works']), tasks: [{ text: 'One', sections: ['overview'] }, { text: 'Two', sections: ['design'], proves: ['ac-works'] }] } });
    await ok('work_order_claim', { ref: wo.ref });
    const agent = agentCtx();
    const s1 = await run('question_ask', { purpose: 'decision', request: rid, blocks: [`${wo.ref}/tasks/t1`], questions: [q] }, agent);
    expect(s1.isError, JSON.stringify(s1.body)).toBe(false);
    const n = await next(rid);
    expect(n.next.args.task).toBe('t2'); // t1 is skipped while it waits
    expect(n.waitingOn).toEqual([s1.body.question.id]);
    await ok('work_order_task_set', { ref: wo.ref, tasks: [{ task: 't2', status: 'done' }] });
    // The blocked step does not hold the rest: sections go on while it waits.
    const stuck = await next(rid);
    expect(stuck.state).toBe('waiting'); // the section of the blocked task is not offered on its own
    expect(stuck.waitingOn).toEqual([s1.body.question.id]);
    await run('question_answer', { id: s1.body.question.id, answers: { q1: 'B' } }, uiCtx());
    expect((await next(rid)).next.args).toMatchObject({ task: 't1' });
    await ok('work_order_task_set', { ref: wo.ref, tasks: [{ task: 't1', status: 'done' }] });
    expect((await next(rid)).state).toBe('verify');
  });
});

describe('decisions', () => {
  it('request_decision_add appends what / why / by / at, and a closed request refuses', async () => {
    const rid = await newRequest('Decide on my own.');
    const r = await ok('request_decision_add', { ref: rid, text: 'Remember-me lasts 30 days', reason: 'the session spec uses 30 days' });
    expect(r.decisions).toEqual([expect.objectContaining({ text: 'Remember-me lasts 30 days', reason: 'the session spec uses 30 days', by: AGENT, at: expect.any(String) })]);
    await ok('request_decision_add', { ref: `mandate://requests/${rid}`, text: 'Second', reason: 'because' });
    expect((await read('request_get', { ref: rid })).request.decisions).toHaveLength(2);
    await ok('request_close', { ref: rid, resolution: 'rejected', resolutionNote: 'no longer needed' });
    expect((await fx.call('request_decision_add', { agent: AGENT, ref: rid, text: 'x', reason: 'y' })).body.error.code).toBe('request_closed');
  });
});

describe('gates', () => {
  it('the fast-path fix needs no spec_match or change; verification_record needs the claim of the covering work order', async () => {
    const spec = await newSpec(['design']);
    const rid = await newRequest('A bug.');
    const fix = await ok('work_order_create', { spec, kind: 'fix', sections: ['design'], fastPath: true, reason: [`mandate://requests/${rid}`] });
    expect(fix.ref).toMatch(/^mandate:\/\/work-orders\//);
    const rid2 = await newRequest('Another.');
    await read('spec_match', { request: 'design', for: rid2 });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'v2', addresses: [`mandate://requests/${rid2}`] });
    await recordMatches(fx, AGENT, rid2);
    const wo = await ok('work_order_create', { spec, kind: 'update', sections: ['design', 'ac-works'], reason: [`mandate://requests/${rid2}`], plan: PLAN() });
    const unclaimed = await fx.call('verification_record', { agent: AGENT, criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 't' } });
    expect(unclaimed.body.error.code).toBe('not_claimed');
    await ok('work_order_claim', { ref: wo.ref });
    expect((await fx.call('verification_record', { agent: AGENT, criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 't' } })).isError).toBe(false);
  });
});

describe('flow_edit_allowed (strict flow)', () => {
  it('allows when strict flow is off; refuses without a claimed work order step; allows with one', async () => {
    expect((await run('flow_edit_allowed', {}, agentCtx())).body).toMatchObject({ allowed: true, reason: expect.stringMatching(/strict flow is off/) });
    const strict = agentCtx({ strictFlow: true });
    const none = (await run('flow_edit_allowed', { path: 'src/a.ts' }, strict)).body;
    expect(none.allowed).toBe(false);
    expect(none.reason).toMatch(/flow_next|work_order_task_set/);
    expect((await run('flow_edit_allowed', { repo: 'other/place' }, { ...strict, settings: { ...strict.settings!, codeRepos: () => [{ name: 'app', github: 'acme/app' }] } as never })).body.allowed).toBe(true);
    const spec = await newSpec(['design']);
    const rid = await newRequest('Edit under strict flow.');
    await read('spec_match', { request: 'design', for: rid });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'v2', addresses: [`mandate://requests/${rid}`] });
    await recordMatches(fx, AGENT, rid);
    const wo = await ok('work_order_create', { spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [`mandate://requests/${rid}`], plan: PLAN() });
    await ok('work_order_claim', { ref: wo.ref });
    const claimedOnly = (await run('flow_edit_allowed', { path: 'src/a.ts' }, strict)).body;
    expect(claimedOnly.allowed).toBe(false);
    expect(claimedOnly.reason).toMatch(/no task is in progress/);
    await ok('work_order_task_set', { ref: wo.ref, task: 't1', status: 'in_progress' });
    expect((await run('flow_edit_allowed', { path: 'src/a.ts' }, strict)).body).toMatchObject({ allowed: true, task: 't1', activeWorkOrder: wo.ref });
    expect((await run('flow_edit_allowed', { path: 'src/a.ts', agent: 'someone-else' }, strict)).body.allowed).toBe(false);
  });
});

describe('flowFor (pure)', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const req = (over: Record<string, unknown> = {}) => ({ id: 'fb-1', kind: 'improvement', body: 'x', status: 'open', targets: [], relatedTo: [], changes: [], warnings: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over }) as never;
  const spec = { id: 's', status: 'ready', sections: [{ id: 'a', type: 'markdown', verifiedBy: [] }, { id: 'ac', type: 'acceptance', method: 'test' }] } as never;
  const snap = (over: Partial<FlowSnapshot> = {}): FlowSnapshot => ({ requests: [], workOrders: [], questions: [], specs: new Map([['s', spec]]), verifications: [], now, ...over });
  const changed = { kind: 'specs', id: 's', action: 'modified', sections: [{ id: 'a', action: 'modified' }] };

  it('a changed section without a criterion asks for one before the work order', () => {
    const f = req({ specMatch: { at: 'x', by: 'y', refs: [] }, changes: [changed] });
    const item = flowFor(f, snap({ requests: [f] }));
    expect(item.state).toBe('criteria');
    expect(item.next?.tool).toBe('section_insert');
  });

  it('a stale claim by another agent is taken over; a fresh one is waited for', () => {
    const f = req({ specMatch: { at: 'x', by: 'y', refs: [] }, changes: [changed] });
    const wo = (hb: string) => ({ id: 'wo-1', spec: 's', kind: 'implement', status: 'in_progress', reason: ['fb-1'], sections: [{ id: 'a', status: 'pending' }], hasPlan: true, createdAt: '2026-01-01T00:00:00Z', claim: { agent: 'other', startedAt: hb, heartbeatAt: hb } }) as never;
    expect(flowFor(f, snap({ requests: [f], workOrders: [wo('2026-01-01T11:59:00Z')], agent: 'me' }))).toMatchObject({ state: 'waiting', waitingOnWorkOrders: [expect.objectContaining({ claimedBy: 'other' })] });
    expect(flowFor(f, snap({ requests: [f], workOrders: [wo('2026-01-01T09:00:00Z')], agent: 'me' })).next?.tool).toBe('work_order_claim');
  });

  it('closed requests are done and flowAll skips them', () => {
    const closed = req({ id: 'fb-2', status: 'closed' });
    const open = req();
    expect(flowFor(closed, snap()).done).toBe(true);
    expect(flowAll(snap({ requests: [closed, open] })).map((i) => i.request.id)).toEqual(['fb-1']);
  });

  it('an implemented section the request changed but no task covers asks: editorial, a task, or re-verify', () => {
    const f = req({ specMatch: { at: 'x', by: 'y', refs: [] }, changes: [changed] });
    const wo = (steps: unknown[]) => ({ id: 'wo-1', spec: 's', kind: 'update', status: 'in_progress', reason: ['fb-1'], sections: [{ id: 'b', status: 'pending' }, ...(steps.length ? [{ id: 'a', status: 'pending' }] : [])], planSteps: steps, hasPlan: true, createdAt: '2026-01-01T00:00:00Z', claim: { agent: 'me', startedAt: '2026-01-01T11:59:00Z', heartbeatAt: '2026-01-01T11:59:00Z' } }) as never;
    const outdated = new Map([['s', { a: { implementedBy: 'q-0001', changedBy: 'agent' } }]]);
    const item = flowFor(f, snap({ requests: [f], workOrders: [wo([])], outdated, agent: 'me' }));
    expect(item.state).toBe('outdated');
    expect(item.next?.tool).toBe('section_update');
    expect(item.next?.args).toMatchObject({ ref: 'mandate://specs/s/sections/a', editorial: expect.anything() });
    expect(item.next?.why).toMatch(/editorial.*task.*section_reverify/s);
    // A task covering the section: the usual work order flow goes on.
    const covered = flowFor(f, snap({ requests: [f], workOrders: [wo([{ id: 't1', text: 'x', status: 'pending', sections: ['a'] }])], outdated, agent: 'me' }));
    expect(covered.state).not.toBe('outdated');
  });
});
