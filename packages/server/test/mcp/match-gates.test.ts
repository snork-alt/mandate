/**
 * component_match / standard_match: ranked candidates with reasons (by meaning and by the planned files), recorded on the
 * request; work_order_create is refused (flow_out_of_order) until all three matches are recorded and acted on:
 * spec_match -> update the matched spec sections (a new spec needs the decision "no existing spec covers ...") ->
 * standard_match -> follows links -> component_match -> update the component (or the decision "no existing component covers ...").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const A = 'match@test';
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${n++}`;
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: A, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function read(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: A, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string };
}
const PLAN = (sections: string[]) => ({ tasks: [{ text: 'Do it', sections, proves: ['ac-works'] }], files: ['src/zq/a.ts'], tests: [{ name: 't', proves: ['ac-works'] }], risks: ['none'] });

async function setup() {
  const dir = uid('zq');
  const comp = await ok('component_create', { id: dir, title: 'Zebra quota', kind: 'module', tldr: 'Handles zebra quota sessions and limits for users.', owns: [{ repo: 'app', paths: ['src/zq/**'] }], sections: [{ id: 'responsibility', title: 'Responsibility', summary: 'Quota', body: 'Counts zebra quota usage per user.' }] });
  await ok('component_create', { id: uid('other'), title: 'Billing', kind: 'module', tldr: 'Invoices.', owns: [{ repo: 'app', paths: ['src/billing/**'] }], sections: [{ id: 'responsibility', title: 'Responsibility', summary: 'Bills', body: 'Invoices.' }] });
  const std = await ok('standard_create', {
    id: uid('qstd'),
    title: `Quota code ${dir}`,
    tldr: 'Code in the zebra quota module validates input.',
    appliesTo: ['path:src/zq/**'],
    sections: [{ title: 'Validate quota input', type: 'rule', level: 'must', rationale: 'Because.', summary: 'Validate.', body: 'Validate every zebra quota input.', scope: { paths: ['src/zq/**'] } }],
    confirmedByUser: true,
  });
  await ok('standard_status_set', { ref: std.ref, status: 'active', confirmedByUser: true });
  const spec = uid('spec');
  await ok('spec_create', {
    id: spec,
    title: `Spec ${spec}`,
    summary: 'zebra quota',
    sections: [
      { id: 'design', title: 'Design', summary: 'How.', body: 'The design.', verifiedBy: ['ac-works'] },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'A test proves it.' },
    ],
  });
  return { comp: comp.ref as string, std: std.ref as string, spec };
}
const newRequest = async (body = 'Limit the zebra quota per user.') => (await ok('request_create', { kind: 'improvement', body })).request.id as string;

describe('component_match', () => {
  it('ranks by meaning and by the files each component owns, with reasons; records on the request', async () => {
    const { comp } = await setup();
    const rid = await newRequest();
    const r = await read('component_match', { request: 'Limit the zebra quota per user', files: ['app:src/zq/limit.ts', 'app:src/elsewhere/x.ts'], for: rid });
    expect(r.recordedOn).toBe(`mandate://requests/${rid}`);
    expect(r.candidates[0]).toMatchObject({ component: { ref: comp }, files: ['app:src/zq/limit.ts'] });
    expect(r.candidates[0].fit).toBeGreaterThan(0.3);
    expect(r.candidates[0].reasons.join(' ')).toMatch(/owns 1\/2 planned file/);
    expect(r.unownedFiles).toEqual(['app:src/elsewhere/x.ts']);
    expect(r.suggestion).toMatchObject({ decision: 'extend_component', target: comp });
    const f = (await read('request_get', { ref: rid })).request;
    expect(f.componentMatch).toMatchObject({ decision: 'extend_component', refs: expect.arrayContaining([comp]) });
  });

  it('nothing fits: suggests a new component (only with a recorded decision)', async () => {
    await setup();
    const r = await read('component_match', { request: 'quantum telescope calibration', files: ['app:src/nowhere/q.ts'] });
    expect(r.suggestion.decision).toBe('new_component');
    expect(r.suggestion.target).toBeNull();
  });
});

describe('standard_match', () => {
  it('ranks standards by appliesTo for the files and by meaning; records on the request', async () => {
    const { std } = await setup();
    const rid = await newRequest();
    const r = await read('standard_match', { request: 'Limit the zebra quota per user', files: ['app:src/zq/limit.ts'], for: rid });
    expect(r.recordedOn).toBe(`mandate://requests/${rid}`);
    const hit = r.candidates.find((c: { standard: { ref: string } }) => c.standard.ref === std);
    expect(hit).toBeTruthy();
    expect(hit.files).toEqual(['app:src/zq/limit.ts']);
    expect(hit.rules[0]).toMatchObject({ level: 'must' });
    expect(r.suggestion.decision).toBe('follow');
    expect((await read('request_get', { ref: rid })).request.standardMatch).toMatchObject({ decision: 'follow', refs: expect.arrayContaining([std]) });
  });
});

describe('the gate: matches recorded and acted on before work_order_create', () => {
  it('names the missing match; a follows link, the component update and a new-spec decision each close a gap', async () => {
    const { comp, std, spec } = await setup();
    const rid = await newRequest();
    const ref = `mandate://requests/${rid}`;
    const create = () => fx.call('work_order_create', { agent: A, spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [ref], plan: PLAN(['design']) });
    await read('spec_match', { request: 'Limit the zebra quota per user', for: rid });
    await ok('spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'Quota limited per user.', addresses: [ref] });
    expect((await create()).body.error.message).toMatch(/standard_match recorded/);
    await read('standard_match', { request: 'Limit the zebra quota per user', files: ['app:src/zq/limit.ts'], for: rid });
    expect((await create()).body.error.message).toMatch(/follows link from a changed spec section/);
    await ok('section_link_add', { ref: `mandate://specs/${spec}/sections/design`, to: std, rel: 'follows', addresses: [ref] });
    expect((await create()).body.error.message).toMatch(/component_match recorded/);
    await read('component_match', { request: 'Limit the zebra quota per user', files: ['app:src/zq/limit.ts'], for: rid });
    expect((await create()).body.error.message).toMatch(/matched component updated/);
    await ok('update_meta', { ref: comp, tldr: 'Handles zebra quota sessions, limits and per-user caps.', addresses: [ref] });
    // The followed standard's must rule is a criterion of the work order too: the plan has to prove it.
    expect((await create()).body.error.message).toMatch(/validate-quota-input/);
    const inh = `${std.split('/').pop()}/validate-quota-input`;
    const made = await fx.call('work_order_create', { agent: A, spec, kind: 'implement', sections: ['design', 'ac-works'], reason: [ref], plan: { tasks: [{ text: 'Do it', sections: ['design'], proves: ['ac-works', inh] }], files: ['src/zq/a.ts'], tests: [{ name: 't', proves: ['ac-works', inh] }], risks: ['none'] } });
    expect(made.body.error, JSON.stringify(made.body.error)).toBeUndefined();
  });

  it('a new spec needs the decision "no existing spec covers ..."', async () => {
    const rid = await newRequest('Brand new area.');
    const ref = `mandate://requests/${rid}`;
    await read('spec_match', { request: 'Brand new area', for: rid });
    const id = uid('fresh');
    await ok('spec_create', { id, title: 'Fresh', summary: 's', addresses: [ref], sections: [{ id: 'design', title: 'Design', summary: 'd', body: 'b', verifiedBy: ['ac-works'] }, { id: 'ac-works', title: 'Works', type: 'acceptance', method: 'test', summary: 'w', body: 'b' }] });
    const e = await fail('work_order_create', { spec: id, kind: 'implement', sections: ['design', 'ac-works'], reason: [ref], plan: PLAN(['design']) });
    expect(e.code).toBe('flow_out_of_order');
    expect(e.message).toMatch(/no existing spec covers/);
    const next = (await ok('flow_next', { request: rid })).next;
    expect(next).toMatchObject({ tool: 'request_decision_add' });
  });
});
