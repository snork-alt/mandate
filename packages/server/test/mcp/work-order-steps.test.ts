/**
 * Plan steps as data: stable ids, status (one in_progress, skipped needs a note), links to sections / criteria validated
 * against the work order, plan_set id stability, legacy markdown plans parsed on read, the complete gate, the last-section
 * warning, progress and activity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacySteps, parseStepLines, planProgress, reconcileSteps, stepsPlanProgress } from '@mandate/shared';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
  fx.finishSteps = false;
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'steps@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}, agent = AGENT) {
  const r = await fx.call(name, { agent, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}, agent = AGENT) {
  const r = await fx.call(name, { agent, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; hint?: string; detail?: Record<string, any> };
}
const get = async (ref: string) => (await fx.call('work_order_get', { ref })).body;

async function newSpec() {
  const id = uid('st');
  await ok('spec_create', {
    id,
    title: `Spec ${id}`,
    summary: 'A test spec.',
    sections: [
      { id: 'design', title: 'Design', summary: 'How.', body: 'The design.', verifiedBy: ['ac-works'] },
      { id: 'api', title: 'Api', summary: 'API.', body: 'The api.', verifiedBy: ['ac-works'] },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'A test proves it.' },
    ],
  });
  return id;
}
const TESTS = [{ name: 'it works', ref: 'app:t.test.ts#L1-L9', proves: ['ac-works'] }];

async function newWo(steps: unknown[], extra: Record<string, unknown> = {}) {
  const spec = await newSpec();
  // Plain strings: the first task implements both sections, the last proves the criterion.
  const tasks = steps.map((t, i) => (typeof t !== 'string' ? t : { text: t, ...(i === 0 ? { sections: ['design', 'api'] } : {}), ...(i === steps.length - 1 ? { proves: ['ac-works'] } : {}) }));
  const wo = await ok('work_order_create', { spec, sections: ['design', 'api'], kind: 'implement', plan: { tasks, tests: TESTS }, ...extra });
  return { spec, ref: wo.ref as string, wo };
}
const stepsOf = async (ref: string) => (await get(ref)).item.planSteps as { id: string; text: string; status: string; note?: string; sections?: string[]; proves?: string[]; codeRefs?: { path: string }[]; by: string }[];

describe('creating with tasks', () => {
  it('strings and objects get stable ids; the plan text is rendered from them', async () => {
    const { ref } = await newWo([{ text: 'Write the code', sections: ['design', 'api'] }, { text: 'Write the test', sections: ['design'], proves: ['ac-works'] }]);
    const steps = await stepsOf(ref);
    expect(steps.map((s) => [s.id, s.status])).toEqual([['t1', 'pending'], ['t2', 'pending']]);
    expect(steps[1]).toMatchObject({ sections: ['design'], proves: ['ac-works'], by: AGENT });
    expect((await get(ref)).doc.plan).toContain('- [ ] **t2** Write the test');
  });

  it('links are validated against the work order targets and criteria', async () => {
    const spec = await newSpec();
    const base = { spec, sections: ['design'], kind: 'implement' };
    const badSection = await fail('work_order_create', { ...base, plan: { tasks: [{ text: 'x', sections: ['api'] }], tests: TESTS } });
    expect(badSection.code).toBe('plan_invalid');
    expect(badSection.message).toMatch(/covers api: not a section of this work order/);
    const badProves = await fail('work_order_create', { ...base, plan: { tasks: [{ text: 'x', proves: ['ac-nope'] }], tests: TESTS } });
    expect(badProves.message).toMatch(/proves ac-nope/);
  });
});

describe('work_order_task_set', () => {
  it('needs the claim; sets status with note and codeRefs; one in_progress at a time; skipped needs a note', async () => {
    const { ref } = await newWo(['One', 'Two', 'Three']);
    expect((await fail('work_order_task_set', { ref, task: 't1', status: 'in_progress' })).code).toBe('not_claimed');
    await ok('work_order_claim', { ref });
    await ok('work_order_task_set', { ref, task: 't1', status: 'in_progress' });
    await ok('work_order_task_set', { ref, task: 't2', status: 'in_progress' });
    expect((await stepsOf(ref)).map((s) => s.status)).toEqual(['pending', 'in_progress', 'pending']);
    const done = await ok('work_order_task_set', { ref, task: 't2', status: 'done', note: 'ok', codeRefs: ['app:src/a.ts#L1-5'] });
    const steps = await stepsOf(ref);
    expect(steps[1]).toMatchObject({ status: 'done', note: 'ok', by: AGENT, codeRefs: [expect.objectContaining({ path: 'src/a.ts' })] });
    expect(done.workOrder.item.touched.map((t: { path: string }) => t.path)).toContain('src/a.ts');
    expect((await get(ref)).doc.plan).toMatch(/- \[x\] \*\*t2\*\* Two/);
    // Several in one call, but only one in progress.
    expect((await fail('work_order_task_set', { ref, tasks: [{ task: 't1', status: 'in_progress' }, { task: 't3', status: 'in_progress' }] })).message).toMatch(/only one task/);
    expect((await fail('work_order_task_set', { ref, task: 't1', status: 'done' }, 'other@test')).code).toMatch(/claim/);
    const skip = await fail('work_order_task_set', { ref, task: 't3', status: 'skipped' });
    expect(skip.code).toBe('note_required');
    await ok('work_order_task_set', { ref, tasks: [{ task: 't1', status: 'done' }, { task: 't3', status: 'skipped', note: 'not needed' }] });
    expect((await stepsOf(ref)).map((s) => s.status)).toEqual(['done', 'done', 'skipped']);
    expect((await fail('work_order_task_set', { ref, task: 't9', status: 'done' })).message).toMatch(/unknown task t9.*t1, t2, t3/);
  });

  it('each change is a commit; the activity has a step event', async () => {
    const { ref } = await newWo(['One']);
    await ok('work_order_claim', { ref });
    const r = await ok('work_order_task_set', { ref, task: 't1', status: 'in_progress' });
    expect(r.commit).toBeTruthy();
    const act = await fx.call('activity_list', { limit: 30 });
    const types = (act.body.events as { type: string; summary: string }[]).map((e) => e.type);
    expect(types).toContain('work_order.step_set');
  });
});

describe('work_order_plan_set keeps step ids', () => {
  it('matches by id (renames), by text, adds new ids, never reuses; a done step cannot be removed', async () => {
    const { ref } = await newWo(['One', 'Two', 'Three']);
    await ok('work_order_claim', { ref });
    await ok('work_order_task_set', { ref, task: 't1', status: 'done' });
    const plan = (await get(ref)).doc.plan as string;
    // Rename s1 by id, keep Two by text (no id), drop Three, add Four.
    const edited = plan.replace('**t1** One', '**t1** One (renamed)').replace('- [ ] **t2** Two', '- [ ] Two').replace(/- \[ \] \*\*t3\*\* Three/, '- [ ] Four');
    await ok('work_order_plan_set', { ref, plan: edited });
    let steps = await stepsOf(ref);
    expect(steps.map((s) => [s.id, s.text, s.status])).toEqual([['t1', 'One (renamed)', 'done'], ['t2', 'Two', 'pending'], ['t4', 'Four', 'pending']]);
    // Removing the done step is refused.
    const refuse = await fail('work_order_plan_set', { ref, plan: '**Tasks**\n- [ ] **t2** Two\n- [ ] **t4** Four' });
    expect(refuse.code).toBe('plan_invalid');
    expect(refuse.message).toMatch(/t1 is done.*cannot be removed/);
    // Unknown ids are refused; steps as data with links.
    expect((await fail('work_order_plan_set', { ref, tasks: [{ id: 't7', text: 'ghost' }] })).message).toMatch(/unknown task id t7/);
    await ok('work_order_plan_set', { ref, tasks: [{ id: 't1', text: 'One (renamed)' }, { id: 't2', text: 'Two', sections: ['api'] }, 'Five'] });
    steps = await stepsOf(ref);
    expect(steps.map((s) => s.id)).toEqual(['t1', 't2', 't5']);
    expect(steps[1]!.sections).toEqual(['api']);
    expect((await get(ref)).doc.plan).toContain('**t5** Five');
    expect((await fail('work_order_plan_set', { ref, tasks: [{ id: 't1', text: 'One (renamed)' }, { text: 'bad', sections: ['nope'] }] })).code).toBe('plan_invalid');
  });
});

describe('legacy markdown plans', () => {
  it('checkbox items become steps on read (no rewrite) and step_set works on them', async () => {
    const spec = await newSpec();
    const wo = await ok('work_order_create', { spec, sections: ['design'], kind: 'review', plan: '**Steps**\n- [x] Read the spec\n- [ ] Write the notes\n\nSome prose.' });
    const ref = wo.ref as string;
    expect((await stepsOf(ref)).map((s) => [s.id, s.status])).toEqual([['s1', 'done'], ['s2', 'pending']]);
    await ok('work_order_claim', { ref });
    await ok('work_order_task_set', { ref, task: 's2', status: 'in_progress' });
    const plan = (await get(ref)).doc.plan as string;
    expect(plan).toContain('- [x] **s1** Read the spec');
    expect(plan).toContain('- [~] **s2** Write the notes');
    expect(plan).toContain('Some prose.');
  });

  it('pure parsing', () => {
    expect(parseStepLines('1. a\n- [ ] b\n```\n- [ ] c\n```').map((p) => p.text)).toEqual(['b']);
    expect(legacySteps('- [x] a\n- [ ] b', 't').map((s) => `${s.id}:${s.status}`)).toEqual(['s1:done', 's2:pending']);
    const r = reconcileSteps(legacySteps('- [x] a', 't'), [{ text: 'a' }, { text: 'n' }], 1, { now: 'n', by: 'x' });
    expect(r.steps.map((s) => s.id)).toEqual(['s1', 't2']);
    expect(planProgress('- [~] a\n- [-] b\n- [ ] c')).toEqual({ total: 3, done: 1, current: { index: 1, text: 'a' } });
  });
});

describe('gates and progress', () => {
  it('work_order_complete refuses while a task is pending / in progress; done or skipped (with note) pass; sections follow their tasks', async () => {
    const { ref, spec } = await newWo(['One', 'Two']);
    await ok('work_order_claim', { ref });
    await ok('work_order_task_set', { ref, task: 't1', status: 'in_progress' });
    const refused = await fail('work_order_complete', { ref, outcome: 'Done.' });
    expect(refused.code).toBe('tasks_unfinished');
    expect(refused.message).toMatch(/t1 \(in progress\).*t2 \(pending\)/);
    expect(refused.hint).toMatch(/work_order_task_set/);
    const r = await ok('work_order_task_set', { ref, tasks: [{ task: 't1', status: 'done', codeRefs: ['app:src/a.ts#L1-5'] }, { task: 't2', status: 'skipped', note: 'covered by t1' }] });
    // Every task covering design / api is finished: both sections are recorded by themselves.
    expect(r.workOrder.item.sections.map((x: { status: string }) => x.status)).toEqual(['done', 'done']);
    expect((await fx.storage.specs.get(spec)).sections.find((x) => x.id === 'design')?.implementedBy).toBe(ref.split('/').pop());
    // Criteria are proved separately (existing gate); tasks no longer block.
    const next = await fail('work_order_complete', { ref, outcome: 'Done.' });
    expect(next.code).toBe('criteria_unproven');
    const criterion = `mandate://specs/${spec}/sections/ac-works`;
    await ok('verification_record', { criterion, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 'app:t.test.ts#L1-L9' } });
    expect((await ok('work_order_complete', { ref, outcome: 'Done.' })).workOrder.item.status).toBe('done');
  });

  it('work_order_section_done is a hidden alias: it marks the covering tasks done', async () => {
    const { ref } = await newWo(['One', 'Two']);
    await ok('work_order_claim', { ref });
    const r = await ok('work_order_section_done', { ref, sections: ['design', 'api'], codeRefs: ['app:src/a.ts#L1-5'] });
    expect((await stepsOf(ref)).map((x) => x.status)).toEqual(['done', 'pending']);
    expect(r.workOrder.item.sections.map((x: { status: string }) => x.status)).toEqual(['done', 'done']);
  });

  it('progress: current = the in-progress step, else the first pending', async () => {
    const steps = [
      { id: 't1', text: 'a', status: 'done', updatedAt: 't', by: 'x' },
      { id: 't2', text: 'b', status: 'pending', updatedAt: 't', by: 'x' },
      { id: 't3', text: 'c', status: 'in_progress', updatedAt: 't', by: 'x' },
    ] as never;
    expect(stepsPlanProgress(steps)).toMatchObject({ total: 3, done: 1, current: { index: 3, text: 'c', id: 't3' } });
    expect(stepsPlanProgress([{ id: 't1', text: 'a', status: 'done', updatedAt: 't', by: 'x' }, { id: 't2', text: 'b', status: 'pending', updatedAt: 't', by: 'x' }] as never)?.current).toMatchObject({ index: 2, text: 'b' });
  });

  it('the overview Progress tab uses the structured steps', async () => {
    const { ref } = await newWo(['One', 'Two']);
    await ok('work_order_claim', { ref });
    await ok('work_order_task_set', { ref, task: 't1', status: 'done' });
    await ok('work_order_task_set', { ref, task: 't2', status: 'in_progress' });
    const o = (await fx.call('project_overview', {})).body;
    const row = (o.inProgress as { id: string; plan?: { done?: number; current?: { id: string }; steps?: unknown[] } }[]).find((w) => ref.endsWith(w.id));
    expect(row?.plan).toMatchObject({ total: 2, done: 1, current: { id: 't2' } });
    expect(row?.plan?.steps).toHaveLength(2);
  });
});
