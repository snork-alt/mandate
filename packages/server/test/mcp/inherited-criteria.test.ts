/**
 * Inherited criteria (must rules of followed standards) gate work orders like own criteria: the plan must prove them,
 * work_order_complete refuses until they are verified, flow_next lists them, and a `follows` link added mid-work adds a task.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { flowFor } from '../../src/flow/next.js';
import { mcpFixture, type McpFixture } from './fixture.js';

vi.setConfig({ testTimeout: 90_000 });
let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'inh@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; detail?: Record<string, any> };
}

async function setup(follow = true) {
  const std = uid('std');
  await ok('standard_create', { id: std, title: `Std ${std}`, sections: [{ id: 'rules', title: 'Rules', summary: 'Rules.', body: 'Be safe.' }, { id: 'r-safe', title: 'Safe', type: 'rule', level: 'must', rationale: 'Incidents are costly.', summary: 'Safe.', body: 'It is safe.' }] });
  const spec = uid('inh');
  await ok('spec_create', { id: spec, title: `Spec ${spec}`, summary: 'S.', sections: [{ id: 'design', title: 'Design', summary: 'D.', body: 'The design.', verifiedBy: ['ac-works'] }, { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'W.', body: 'A test.' }] });
  const link = () => ok('spec_section_link_add', { ref: `mandate://specs/${spec}/sections/design`, to: `mandate://standards/${std}`, rel: 'follows' });
  if (follow) await link();
  return { std, spec, link, inh: `${std}/r-safe`, rule: `mandate://standards/${std}/sections/r-safe` };
}

describe('inherited criteria gate work orders', () => {
  it('plan must prove them; complete refuses until verified; flow_next names the verification', async () => {
    const { spec, inh, rule } = await setup();
    const own = [{ text: 'build', sections: ['design'] }, { text: 'test', proves: ['ac-works'] }];
    const bad = await fail('work_order_create', { spec, sections: ['design', 'ac-works'], kind: 'implement', plan: { tasks: own, tests: [{ name: 't', proves: ['ac-works'] }] } });
    expect(bad.code).toBe('plan_invalid');
    expect(bad.message).toContain(inh);
    const w = await ok('work_order_create', { spec, sections: ['design', 'ac-works'], kind: 'implement', plan: { tasks: [own[0], { text: 'test', proves: ['ac-works', inh] }], tests: [{ name: 't', proves: ['ac-works', inh] }] } });
    const ref = w.ref as string;
    await ok('work_order_claim', { ref });
    for (const t of ['t1', 't2']) await ok('work_order_task_set', { ref, task: t, status: 'done', codeRefs: [`app:src/${spec}.ts#L1-L3`] });
    await ok('verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, appliedTo: `mandate://specs/${spec}`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test', evidence: { test: 'ac-works.test' } });
    const refused = await fail('work_order_complete', { ref, outcome: 'done' });
    expect(refused.code).toBe('criteria_unproven');
    expect(refused.message).toContain('inherited from standard');
    await ok('verification_record', { criterion: rule, appliedTo: `mandate://specs/${spec}`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test', evidence: { test: 'jwt.test' } });
    expect((await fx.call('work_order_complete', { agent: AGENT, ref, outcome: 'done' })).isError).not.toBe(true);
  });

  it('flow_next adds a task for an inherited criterion and then asks for its verification (pure)', () => {
    const f = { id: 'fb-1', kind: 'improvement', body: 'x', status: 'open', targets: [], relatedTo: [], changes: [], warnings: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', specMatch: { at: 'x', by: 'y', refs: [] } } as never;
    const spec = { id: 's', status: 'ready', sections: [{ id: 'a', type: 'markdown', verifiedBy: [] }] } as never;
    const c = { id: 'std/r', uri: 'mandate://standards/std/sections/r', title: 'Use JWT', standard: 'mandate://standards/std', level: 'must', sections: ['a'] };
    const wo = (steps: unknown[], status = 'pending') => ({ id: 'wo-1', spec: 's', kind: 'implement', status: 'in_progress', reason: ['fb-1'], sections: [{ id: 'a', status }], planSteps: steps, hasPlan: true, createdAt: '2026-01-01T00:00:00Z', claim: { agent: 'me', startedAt: '2026-01-01T11:59:00Z', heartbeatAt: '2026-01-01T11:59:00Z' } }) as never;
    const base = { requests: [f], questions: [], specs: new Map([['s', spec]]), verifications: [], inherited: new Map([['s', [c]]]), now: Date.parse('2026-01-01T12:00:00Z'), agent: 'me' };
    const added = flowFor(f, { ...base, workOrders: [wo([{ id: 't1', text: 'x', status: 'pending', sections: ['a'] }])] } as never);
    expect(added.next?.tool).toBe('work_order_plan_set');
    expect(JSON.stringify(added.next?.args)).toContain('std/r');
    const verify = flowFor(f, { ...base, workOrders: [wo([{ id: 't1', text: 'x', status: 'done', sections: ['a'], proves: ['std/r'] }], 'done')] } as never);
    expect(verify.next).toMatchObject({ tool: 'verification_record', args: { criterion: c.uri } });
  });

  it('a follows link added mid-work makes the plan add a task (planSet accepts the inherited id)', async () => {
    const { spec, link, inh } = await setup(false);
    const w = await ok('work_order_create', { spec, sections: ['design', 'ac-works'], kind: 'implement', plan: { tasks: [{ text: 'build', sections: ['design'] }, { text: 'test', proves: ['ac-works'] }], tests: [{ name: 't', proves: ['ac-works'] }] } });
    const ref = w.ref as string;
    await ok('work_order_claim', { ref });
    await link();
    await ok('work_order_plan_set', { ref, tasks: [{ text: 'build', sections: ['design'] }, { text: 'test', proves: ['ac-works'] }, { text: 'Verify the inherited rules', proves: [inh] }] });
  });
});
