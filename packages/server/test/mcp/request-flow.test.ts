/**
 * The request flow: every instruction is a Request (no approval), the old feedback names keep working, the work order
 * carries the full plan (steps, files, tests mapped to criteria, risks), criteria are proved by tests before a work order
 * completes ("Proved by"), and finished sections point at their work order with the code refs copied ("Implemented by").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TOOLS, TOOLS } from '../../src/mcp/server.js';
import { applyCodeToSection, checkPlanTests, coveredCriteria, renderPlan } from '../../src/storage/work-order-plan.js';
import { planProgress } from '@mandate/shared';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
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
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; hint?: string; detail?: Record<string, any> };
}
const read = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
};

/** A spec with two code sections and one acceptance criterion that verifies both. */
async function newSpec() {
  const id = uid('rf');
  await ok('spec_create', {
    id,
    title: `Spec ${id}`,
    summary: 'A test spec.',
    sections: [
      { id: 'overview', title: 'Overview', summary: 'What it does.', body: 'The overview.', verifiedBy: ['ac-works'] },
      { id: 'design', title: 'Design', summary: 'How it works.', body: 'The design.', verifiedBy: ['ac-works'] },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'The feature works.', body: 'A test proves it works.' },
    ],
  });
  return id;
}
const planFor = (sections: string[]) => ({ ...PLAN, tasks: [{ text: 'Write the code', sections }, { text: 'Write the test', proves: ['ac-works'] }] });
const PLAN = { steps: ['Write the code', 'Write the test'], files: ['src/a.ts', 'tests/a.test.ts'], tests: [{ name: 'it works', ref: 'app:tests/a.test.ts#L1-L20', proves: ['ac-works'] }], risks: ['flaky clock'] };

describe('requests (formerly feedback)', () => {
  it('a request needs no approval: it is open, refs say requests, and there is no accept tool', async () => {
    const id = await newSpec();
    const r = await ok('request_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'improvement', body: 'Make it faster.' });
    expect(r.ref).toMatch(/^mandate:\/\/requests\/fb-/);
    expect(r.request).toMatchObject({ status: 'open', body: 'Make it faster.' });
    expect(r.feedback).toBeUndefined();
    expect(TOOLS.some((t) => t.name === 'feedback_accept' || t.name === 'approval_override_confirm')).toBe(false);
    expect((await fx.call('feedback_accept', { ref: r.ref })).isError).toBe(true);
    // open -> closed only (accepted is legacy data).
    expect((await ok('request_close', { ref: r.ref, resolution: 'rejected', resolutionNote: 'later' })).request.status).toBe('closed');
  });

  it('the old names stay callable and hidden; old refs and `of: feedback` still resolve', async () => {
    const id = await newSpec();
    const created = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'bug', body: 'Old name.' });
    const fbId = created.ref.split('/').pop()!;
    expect(created.request.id).toBe(fbId);
    expect(AGENT_TOOLS.map((t) => t.name)).not.toEqual(expect.arrayContaining(['feedback_create']));
    for (const ref of [`mandate://requests/${fbId}`, `mandate://feedback/${fbId}`, fbId]) {
      const got = await read('get', { ref, ...(ref === fbId ? { of: 'requests' } : {}) });
      expect(got.request.id, ref).toBe(fbId);
    }
    expect((await read('get', { of: 'feedback', ref: fbId })).request.id).toBe(fbId);
    const listed = await read('list', { of: 'requests', status: ['open'] });
    expect(listed.items.map((x: { id: string }) => x.id)).toContain(fbId);
    expect((await read('list', { of: 'feedback', status: ['open'] })).items.length).toBe(listed.items.length);
    expect((await read('request_get', { ref: fbId })).request.id).toBe(fbId);
    expect((await read('feedback_get', { ref: fbId })).request.id).toBe(fbId);
    // The lifecycle registry names it a request (feedback still accepted as the kind).
    expect((await read('lifecycle_get', { kind: 'feedback' })).kind).toBe('request');
  });

  it('addresses writes a Request trailer; old Feedback trailers are still read', async () => {
    const id = await newSpec();
    const fb = await ok('request_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'improvement', body: 'Say more.' });
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'More words.', addresses: [fb.ref] });
    const log = (await fx.storage.git.log(3)).map((c) => c.message).join('\n');
    expect(log).toMatch(/^Request: fb-/m);
    expect(log).not.toMatch(/^Feedback: fb-/m);
    // A commit written with the old trailer (an older repository) still links.
    const { buildRef } = await import('@mandate/shared');
    const g = await ok('request_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Old trailer.' });
    await fx.storage.specs.modify(id, (s) => ({ ...s, sections: s.sections.map((x) => (x.id === 'design' ? { ...x, body: 'Changed under the old trailer.' } : x)) }), { agent: AGENT, trailers: { Feedback: g.ref.split('/').pop()! } });
    const resolved = await read('request_get', { ref: g.ref });
    expect(resolved.request.changes.map((c: { uri: string }) => c.uri)).toContain(buildRef({ kind: 'specs', id }));
  });

  it('the request flow tools are listed by default (the former intake set is part of core)', async () => {
    const c = await connect(fx.url, 'default-list');
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['request_create', 'request_update', 'request_close', 'spec_match', 'create', 'section_insert', 'section_link_add', 'work_order_create', 'verification_record', 'question_ask']) expect(names, n).toContain(n);
    expect(names).not.toContain('feedback_create');
    expect(names).not.toContain('feedback_accept');
    await c.close();
  });
});

describe('the work order carries the full plan', () => {
  it('implement / update / fix need a structured plan; fast-path fixes and review / verify do not', async () => {
    const id = await newSpec();
    const base = { spec: id, sections: ['design', 'ac-works'] };
    expect((await fail('work_order_create', { ...base, kind: 'implement' })).code).toBe('plan_required');
    const text = await fail('work_order_create', { ...base, kind: 'update', plan: '1. just text' });
    expect(text.code).toBe('plan_required');
    expect(text.hint).toMatch(/tasks.*files.*tests/);
    expect((await fail('work_order_create', { ...base, kind: 'fix' })).code).toBe('plan_required');
    await ok('work_order_create', { spec: id, sections: ['overview'], kind: 'review', plan: 'Review it.' });
    // Fast path (kind fix, one section) needs none.
    expect((await ok('work_order_create', { spec: id, sections: ['overview'], kind: 'fix', fastPath: true })).ref).toMatch(/^mandate:\/\/work-orders\//);
  });

  it('tests map to the criteria they prove: unknown ids and uncovered criteria are refused with the valid ids', async () => {
    const id = await newSpec();
    const base = { spec: id, sections: ['design'], kind: 'implement' };
    const unknown = await fail('work_order_create', { ...base, plan: { tasks: [{ text: 'x', sections: ['design'] }], tests: [{ name: 't', proves: ['ac-nope'] }] } });
    expect(unknown.code).toBe('plan_invalid');
    expect(unknown.message).toMatch(/ac-nope.*not an acceptance criterion.*ac-works/s);
    const none = await fail('work_order_create', { ...base, plan: { tasks: [{ text: 'x', sections: ['design'] }] } });
    expect(none.message).toMatch(/no planned test proves ac-works/);
    const unlinked = await fail('work_order_create', { ...base, plan: { tasks: ['x'], tests: PLAN.tests } });
    expect(unlinked.code).toBe('plan_invalid');
    expect(unlinked.message).toMatch(/no task covers section design/);
    expect(unlinked.message).toMatch(/no task proves criterion ac-works/);
    const wo = await ok('work_order_create', { ...base, plan: planFor(['design']) });
    const w = await read('work_order_get', { ref: wo.ref });
    expect(w.item.planTests).toEqual(PLAN.tests);
    expect(w.doc.plan).toContain('**Tasks**');
    expect(w.doc.plan).toContain('it works');
    expect(w.doc.plan).toContain('ac-works');
    expect(w.doc.plan).toContain('flaky clock');
  });

  it('the plan helpers: render, criteria coverage, progress counts steps only', () => {
    const steps = PLAN.steps.map((text, i) => ({ id: `s${i + 1}`, text, status: 'pending' as const, updatedAt: 't', by: 'a' }));
    const md = renderPlan({ ...PLAN, steps } as never);
    expect(md).toContain('- [ ] **s1** Write the code');
    expect(planProgress(md)).toMatchObject({ total: 2, done: 0, current: { index: 1 } });
    const spec = { sections: [{ id: 's', type: 'markdown', verifiedBy: ['ac'] }, { id: 'ac', type: 'acceptance', title: 'AC' }, { id: 'old', type: 'acceptance', archived: true, title: 'Old' }] } as never;
    expect(coveredCriteria(spec, ['s']).map((c) => c.id)).toEqual(['ac']);
    expect(coveredCriteria(spec, ['ac']).map((c) => c.id)).toEqual(['ac']);
    expect(coveredCriteria(spec, ['old'])).toEqual([]);
    expect(checkPlanTests([{ name: 't', proves: ['ac'] }], [{ id: 'ac', title: 'AC' }])).toEqual([]);
  });
});

describe('criteria are proved by tests; sections point at their work order', () => {
  it('work_order_complete refuses until each criterion has a passing, test-linked result; then the request closes by itself', async () => {
    const id = await newSpec();
    const fb = await ok('request_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Build the design.' });
    await read('spec_match', { request: 'Build the design.', for: fb.ref });
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'The design, v2.', addresses: [fb.ref] });
    const wo = await ok('work_order_create', { spec: id, sections: ['design', 'ac-works'], kind: 'implement', plan: planFor(['design', 'ac-works']), reason: [fb.ref] });
    const woId = wo.ref.split('/').pop()!;
    await ok('work_order_claim', { ref: wo.ref });
    await ok('work_order_section_done', { ref: wo.ref, sections: ['design', 'ac-works'], codeRefs: ['app:src/a.ts#L3-L9'] });
    const code = { repo: 'app', commit: 'abc1234' };
    const criterion = `mandate://specs/${id}/sections/ac-works`;

    const none = await fail('work_order_complete', { ref: wo.ref, outcome: 'Done.' });
    expect(none.code).toBe('criteria_unproven');
    expect(none.message).toMatch(/ac-works.*no passing result/);
    expect(none.hint).toMatch(/verification_record/);
    expect(none.detail?.missing).toEqual([expect.objectContaining({ criterion, reason: 'no passing result recorded' })]);

    // Passing, but no test named: refused with the reason.
    await ok('verification_record', { criterion, code, result: 'pass', method: 'test' });
    expect((await fail('work_order_complete', { ref: wo.ref, outcome: 'Done.' })).message).toMatch(/names no test/);

    // A failing latest result is not proof either.
    await ok('verification_record', { criterion, code, result: 'fail', method: 'test', evidence: { test: 'tests/a.test.ts' } });
    expect((await fail('work_order_complete', { ref: wo.ref, outcome: 'Done.' })).message).toMatch(/latest result is a failure/);

    const rec = await ok('verification_record', { criterion, code, result: 'pass', method: 'test', evidence: { test: 'app:tests/a.test.ts#L1-L20' }, codeRefs: ['app:tests/a.test.ts#L1-L20'] });
    // The test is stored on the criterion with the work order ("Proved by").
    const spec = await fx.storage.specs.get(id);
    expect(spec.sections.find((s) => s.id === 'ac-works')!.provedBy).toEqual([expect.objectContaining({ test: 'app:tests/a.test.ts#L1-L20', workOrder: woId, verification: rec.verification.id })]);
    expect((await read('get', { ref: criterion })).section.meta.provedBy?.[0]?.workOrder).toBe(woId);

    const done = await ok('work_order_complete', { ref: wo.ref, outcome: 'Delivered.' });
    expect(done.workOrder.item.status).toBe('done');
    // Its request closed by itself (applied).
    const closed = await read('request_get', { ref: fb.ref });
    expect(closed.request).toMatchObject({ status: 'closed', resolution: 'applied' });
    expect(closed.request.resolutionNote).toMatch(/closed automatically/);
  });

  it('review and verify work orders do not need test proof', async () => {
    const id = await newSpec();
    const wo = await ok('work_order_create', { spec: id, sections: ['design'], kind: 'review', plan: 'Review.' });
    await ok('work_order_claim', { ref: wo.ref });
    expect((await ok('work_order_complete', { ref: wo.ref, outcome: 'Reviewed.' })).workOrder.item.status).toBe('done');
  });

  it('section_done copies the code refs into the spec section (same path updates lines, deleted drops, renamed moves) and records implementedBy', async () => {
    const id = await newSpec();
    const sec = async () => (await fx.storage.specs.get(id)).sections.find((s) => s.id === 'design')!;
    const prove = async (woRef: string) => ok('verification_record', { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test', evidence: { test: 'tests/a.test.ts' }, workOrder: woRef });

    const first = await ok('work_order_create', { spec: id, sections: ['design'], kind: 'implement', plan: planFor(['design']) });
    await ok('work_order_claim', { ref: first.ref });
    const sd = await ok('work_order_section_done', { ref: first.ref, sections: ['design'], codeRefs: [{ repo: 'app', path: 'src/a.ts', lines: ['3-9'], symbols: ['doIt'], change: 'added' }, 'app:src/b.ts#L1-L4'] });
    expect(sd.commits.length).toBe(3); // the covering task done + spec (implementedCommit, implementedBy, refs) + work order
    let s = await sec();
    expect(s.implementedBy).toBe(first.ref.split('/').pop());
    expect(s.implementedCommit).toBeTruthy();
    expect(s.refs).toEqual(expect.arrayContaining([expect.objectContaining({ repo: 'app', path: 'src/a.ts', lines: '3-9' }), expect.objectContaining({ repo: 'app', path: 'src/b.ts', lines: '1-4' })]));
    expect(s.symbols).toContain('doIt');
    await prove(first.ref);
    await ok('work_order_complete', { ref: first.ref, outcome: 'v1' });

    // An update work order: a.ts lines move, b.ts is renamed, a symbol is added; deduplicated.
    const upd = await ok('work_order_create', { spec: id, sections: ['design'], kind: 'update', plan: planFor(['design']) });
    await ok('work_order_claim', { ref: upd.ref });
    await ok('work_order_section_done', { ref: upd.ref, sections: ['design'], codeRefs: [{ repo: 'app', path: 'src/a.ts', lines: ['20-30'], symbols: ['doIt', 'again'], change: 'modified' }, { repo: 'app', path: 'src/c.ts', change: 'renamed', from: 'src/b.ts' }] });
    s = await sec();
    expect(s.implementedBy).toBe(upd.ref.split('/').pop());
    const paths = s.refs.map((r) => `${r.path}${r.lines ? `#${r.lines}` : ''}`);
    expect(paths).toContain('src/a.ts#20-30');
    expect(paths).not.toContain('src/a.ts#3-9');
    expect(paths).toContain('src/c.ts#1-4');
    expect(paths.some((p) => p.startsWith('src/b.ts'))).toBe(false);
    expect(s.symbols.filter((x) => x === 'doIt')).toHaveLength(1);
    expect(s.symbols).toContain('again');
    await prove(upd.ref);
    await ok('work_order_complete', { ref: upd.ref, outcome: 'v2' });

    // A fix that deletes a file.
    const fix = await ok('work_order_create', { spec: id, sections: ['design'], kind: 'fix', plan: planFor(['design']) });
    await ok('work_order_claim', { ref: fix.ref });
    await ok('work_order_section_done', { ref: fix.ref, sections: ['design'], codeRefs: [{ repo: 'app', path: 'src/c.ts', change: 'deleted' }] });
    s = await sec();
    expect(s.refs.some((r) => r.path === 'src/c.ts')).toBe(false);
    expect(s.implementedBy).toBe(fix.ref.split('/').pop());
  });

  it('warns (does not refuse) when an implement / update / fix section is done without code refs, and says why', async () => {
    const id = await newSpec();
    const wo = await ok('work_order_create', { spec: id, sections: ['design'], kind: 'implement', plan: planFor(['design']) });
    await ok('work_order_claim', { ref: wo.ref });
    const sd = await ok('work_order_section_done', { ref: wo.ref, sections: ['design'] });
    const w = (sd.warnings as string[]).find((x) => /no code refs/.test(x));
    expect(w).toBeTruthy();
    expect(w).toMatch(/spec section/);
    expect(w).toMatch(/unknown_code_repo|register/);
    expect(w).toMatch(/commit/);
    // The section is still marked implemented by the work order.
    const s = (await fx.storage.specs.get(id)).sections.find((x) => x.id === 'design')!;
    expect(s.implementedBy).toBe(wo.ref.split('/').pop());
    expect(applyCodeToSection({ refs: [], symbols: [] }, [])).toEqual({ refs: [], symbols: [] });
  });
});
