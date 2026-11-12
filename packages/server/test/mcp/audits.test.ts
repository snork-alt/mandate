/**
 * Audits over MCP: the plan (criteria + applicable rules), the report document (audit-item sections), validation
 * (not_in_plan, notes_required, audit_incomplete), the freeze after completion, fix work orders per spec (must /
 * should / may and classification rules), feedback from findings, re-checks, staleness, graph keys and permissions.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFormat } from '../../src/storage/codecs.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'auditor@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}, agent = AGENT) {
  const r = await fx.call(name, { agent, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function read(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; detail?: Record<string, any> };
}
const git = (...args: string[]) => execFileSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8' }).trim();

/** A standard with a must, a should and a may rule (appliesTo a fresh tag) and a spec using it with one criterion. */
async function setup() {
  const tag = uid('t');
  const std = uid('std');
  await ok('standard_create', {
    id: std,
    title: `Standard ${std}`,
    appliesTo: [`tag:${tag}`],
    confirmedByUser: true,
    sections: [
      { id: 'r-must', title: 'Inputs are validated', type: 'rule', level: 'must', rationale: 'Safety.', summary: 'Validate inputs.', body: 'Validate every request body.' },
      { id: 'r-should', title: 'Errors are logged', type: 'rule', level: 'should', rationale: 'Debuggability.', summary: 'Log errors.', body: 'Log errors with context.' },
      { id: 'r-may', title: 'Use short names', type: 'rule', level: 'may', rationale: 'Style.', summary: 'Short names.', body: 'Prefer short names.' },
    ],
  });
  await ok('standard_status_set', { ref: std, status: 'active', confirmedByUser: true });
  const spec = uid('spec');
  await ok('spec_create', {
    id: spec,
    title: `Spec ${spec}`,
    summary: 'A test spec.',
    tags: [tag],
    sections: [
      { id: 'design', title: 'Design', summary: 'How it works.', body: 'The design.', refs: [{ repo: 'app', path: 'src/feature/handler.ts', lines: '1-40' }] },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'The feature works.', body: 'A test proves it works.' },
    ],
  });
  return { std, spec, specUri: `mandate://specs/${spec}`, stdUri: `mandate://standards/${std}` };
}

const finding = (classification: string, title = 'Problem') => ({
  title,
  description: `${title}: the handler does not do what the rule says.`,
  suggestedFix: 'Add the missing check.',
  codeRefs: ['app:src/feature/handler.ts#L10-L20'],
  classification,
});

describe('audits', () => {
  it('plans, records, completes and freezes a report; findings become fix work orders; re-checks resolve them', async () => {
    const { spec, specUri, std } = await setup();
    const plan = await read('audit_plan', { target: specUri });
    const refs = plan.items.map((i: { ref: string }) => i.ref);
    expect(refs).toContain(`${specUri}/sections/ac-works`);
    expect(refs).toEqual(expect.arrayContaining([`mandate://standards/${std}/sections/r-must`, `mandate://standards/${std}/sections/r-should`, `mandate://standards/${std}/sections/r-may`]));
    expect(plan.items.find((i: { ref: string }) => i.ref.endsWith('r-may')).required).toBe(false);
    expect(plan.code.refs.some((r: { path: string }) => r.path === 'src/feature/handler.ts')).toBe(true);
    expect(plan.lastAudit).toBeNull();

    const before = Number(git('rev-list', '--count', 'HEAD'));
    const started = await ok('audit_start', { target: specUri, code: { repo: 'app', commit: 'abcdef1' }, overview: 'Scope: the feature handler.' });
    const id = started.audit.id as string;
    expect(id).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${spec}$`));
    expect(started.ref).toBe(`mandate://audits/${id}`);
    expect(Number(git('rev-list', '--count', 'HEAD'))).toBe(before + 1);
    expect(git('log', '-1', '--format=%B')).toMatch(new RegExp(`Audit: ${id}`));
    // A markdown report with an overview and one audit-item per checklist item.
    const raw = (await read('doc_raw', { kind: 'audits', id })).text as string;
    const parsed = auditFormat.parse(raw);
    expect(parsed.sections[0]!.id).toBe('overview');
    expect(parsed.sections.filter((s) => s.type === 'audit-item')).toHaveLength(plan.items.length);

    expect((await fail('audit_record_item', { auditId: id, ref: 'mandate://specs/login-sso/sections/auth-flow', result: 'pass' })).code).toBe('not_in_plan');
    expect((await fail('audit_record_item', { auditId: id, ref: `${specUri}/sections/ac-works`, result: 'fail' })).code).toBe('notes_required');
    await ok('audit_record_item', { auditId: id, ref: `@mandate:${specUri}/sections/ac-works`, result: 'pass', notes: 'Ran the feature test; it covers the happy path.' });
    const inc = await fail('audit_complete', { auditId: id, summary: 'Done.' });
    expect(inc.code).toBe('audit_incomplete');
    expect(inc.detail!.missing.map((m: { ref: string }) => m.ref)).toEqual([`mandate://standards/${std}/sections/r-must`]);

    const rec = await ok('audit_record_item', {
      auditId: id,
      ref: `mandate://standards/${std}/sections/r-must`,
      result: 'fail',
      notes: 'The handler reads the body without a schema (src/feature/handler.ts#L10-L20).',
      findings: [finding('code_deviates', 'No validation'), finding('spec_wrong', 'Rule contradicts the API'), { ...finding('code_deviates', 'Critical'), severity: 'critical' }],
    });
    expect(rec.findings).toEqual([`mandate://audits/${id}/findings/f1`, `mandate://audits/${id}/findings/f2`, `mandate://audits/${id}/findings/f3`]);
    await ok('audit_record_item', { auditId: id, ref: `mandate://standards/${std}/sections/r-should`, result: 'partial', notes: 'Some errors are logged.', findings: [{ ...finding('code_deviates', 'Missing log'), severity: 'critical' }] });
    await ok('audit_record_item', { auditId: id, ref: `mandate://standards/${std}/sections/r-may`, result: 'fail', notes: 'Long names.', findings: [{ ...finding('code_deviates', 'Long names'), severity: 'major' }] });
    const got = (await read('audit_get', { auditId: id })).audit;
    const sev = Object.fromEntries(got.items.flatMap((i: any) => i.findings).map((f: any) => [f.title, f.severity]));
    // Severity derives from the level and is capped: should never exceeds major, may never exceeds info.
    expect(sev).toMatchObject({ 'No validation': 'major', Critical: 'critical', 'Missing log': 'major', 'Long names': 'info' });

    const empty = await fail('audit_complete', { auditId: id, summary: 'x', overview: '   ' });
    expect(empty.code).toBe('audit_incomplete');
    expect(empty.detail!.overview).toBe(false);
    const done = await ok('audit_complete', { auditId: id, summary: 'Validation missing in the handler.', overview: 'Scope: the feature handler.\n\nAssessment: validation is missing; logging is partial.' });
    expect(done.audit.status).toBe('completed');
    expect(done.audit.outcome).toBe('fail');
    // Frozen: no more item records.
    expect((await fail('audit_record_item', { auditId: id, ref: `${specUri}/sections/ac-works`, result: 'n_a' })).code).toBe('audit_frozen');
    expect((await fail('audit_complete', { auditId: id, summary: 'again' })).code).toBe('audit_frozen');

    // Work orders: one fix WO for the spec with the must + should code_deviates findings; may never; spec_wrong -> feedback.
    const wo = await ok('audit_findings_to_work_orders', { auditId: id });
    expect(wo.workOrders).toHaveLength(1);
    expect(wo.workOrders[0].findings.map((f: string) => f.split('/').pop()).sort()).toEqual(['f1', 'f3', 'f4']);
    expect(wo.workOrders[0].sections).toEqual(['design']);
    expect(wo.feedbackNeeded.map((f: any) => f.id)).toEqual(['f2']);
    expect(wo.skipped).toEqual(expect.arrayContaining([{ finding: 'f5', reason: expect.stringMatching(/may-level/) }]));
    const woId = wo.workOrders[0].id;
    const woGet = await read('work_order_get', { ref: woId });
    expect(woGet.item.kind).toBe('fix');
    expect(woGet.item.findings).toHaveLength(3);
    // Idempotent: a second call creates nothing.
    const again = await ok('audit_findings_to_work_orders', { auditId: id });
    expect(again.workOrders).toEqual([]);

    // spec_wrong -> feedback with fromFinding: recorded on the finding.
    const fb = await ok('feedback_create', { targets: [`mandate://standards/${std}/sections/r-must`], kind: 'conflict', body: 'The rule contradicts the API.', fromFinding: `mandate://audits/${id}/findings/f2` });
    expect(fb.feedback.fromFinding).toBe(`mandate://audits/${id}/findings/f2`);
    expect((await fail('feedback_create', { targets: [`mandate://standards/${std}/sections/r-must`], kind: 'conflict', body: 'x', fromFinding: `mandate://audits/${id}/findings/f99` })).code).toBe('not_found');

    // Completing the fix work order does not resolve findings; a re-check does.
    let f1 = (await read('audit_findings', { target: specUri })).findings.find((f: any) => f.id === 'f1');
    expect(f1.resolution).toMatchObject({ status: 'open', workOrder: woId });
    expect(f1.resolution.feedback).toBeUndefined();
    const f2 = (await read('audit_findings', { target: specUri })).findings.find((f: any) => f.id === 'f2');
    expect(f2.resolution.feedback).toBe(fb.feedback.id);
    await ok('work_order_claim', { ref: woId });
    await ok('work_order_complete', { ref: woId, outcome: 'Fixed the deviations.' });
    f1 = (await read('audit_findings', { target: specUri, status: ['open'] })).findings.find((f: any) => f.id === 'f1');
    expect(f1.status).toBe('open');
    const re = await ok('audit_recheck', { auditId: id, findingId: `mandate://audits/${id}/findings/f1`, result: 'pass', commit: 'abcdef2', notes: 'Validation added.' });
    const f1now = re.audit.items.flatMap((i: any) => i.findings).find((f: any) => f.id === 'f1');
    expect(f1now.status).toBe('resolved');
    expect(f1now.resolution).toMatchObject({ status: 'resolved', commit: 'abcdef2', workOrder: woId, by: AGENT });
    expect(f1now.rechecks).toHaveLength(1);
    // The original result stays visible.
    expect(re.audit.items.find((i: any) => i.ref.endsWith('r-must')).result).toBe('fail');
    expect((await fail('audit_recheck', { auditId: id, findingId: 'f1', result: 'pass' })).code).toBe('finding_closed');
    expect((await fail('audit_recheck', { auditId: id, findingId: 'f3', result: 'wont_fix' })).code).toBe('validation');
    await ok('audit_recheck', { auditId: id, findingId: 'f3', result: 'fail', notes: 'Still missing.' });
    await ok('audit_recheck', { auditId: id, findingId: 'f3', result: 'wont_fix', notes: 'Accepted for now.' });

    // Spec views: lastAudit on lists, audits on detail.
    const list = await read('spec_list', { q: spec });
    expect(list.items[0].lastAudit).toMatchObject({ id, openFindings: expect.any(Number) });
    // Maturity is derived on lists and spec_get, with the last audit folded in.
    expect(list.items[0].maturity).toMatchObject({ step: expect.any(String), audit: { id } });
    const spg = await read('spec_get', { ref: spec });
    expect(spg.maturity.storedStatus).toBe('draft');
    expect((await read('spec_list', { maturity: ['failing', 'in_progress', 'implemented', 'specified'], q: spec })).items).toHaveLength(1);
    const never = await read('spec_list', { audit: ['never'], q: 'login-sso' });
    expect(never.items.every((s: any) => s.lastAudit === null)).toBe(true);
    const detail = await read('doc_get', { kind: 'specs', id: spec });
    expect(detail.audits.latest.id).toBe(id);
    const stdDetail = await read('doc_get', { kind: 'standards', id: std });
    expect(stdDetail.audits.compliance.rows[0]).toMatchObject({ subject: specUri, results: { [`mandate://standards/${std}/sections/r-must`]: 'fail' } });

    // Staleness: editing a rule after the audit makes it stale, with commits since.
    expect((await read('audit_get', { auditId: id })).audit.staleness.stale).toBe(true); // the fix work order completed since
    await ok('standard_section_update', { ref: `mandate://standards/${std}/sections/r-should`, body: 'Log every error with a request id.', confirmedByUser: true });
    const st = (await read('audit_get', { auditId: id })).audit.staleness;
    expect(st.reasons.some((r: string) => /Errors are logged.*changed/.test(r))).toBe(true);
    expect(st.commitsSince).toBeGreaterThan(0);
    expect((await read('audit_list', { target: specUri, stale: true })).total).toBe(1);

    // Graph keys: the audit, its sections and findings resolve; edges to target, work order and feedback.
    await fx.index.idle();
    const node = await read('graph_node', { uri: `mandate://audits/${id}` });
    expect(node.node.kind).toBe('audit');
    const fnode = await read('graph_node', { uri: `@mandate:mandate://audits/${id}/findings/f1` });
    expect(fnode.node.kind).toBe('finding');
    const sec = await read('graph_node', { uri: `mandate://audits/${id}/sections/ac-works` });
    expect(sec.node.kind).toBe('section');
    const nb = await read('graph_neighbors', { uri: `mandate://audits/${id}/findings/f1`, depth: 1, limit: 50 });
    const text = JSON.stringify(nb);
    expect(text).toContain(`mandate://work-orders/${woId}`);
    expect(text).toContain(`mandate://standards/${std}/sections/r-must`);
    expect(text).toContain('mandate://code/app/src/feature/handler.ts#L10-L20');
    const s = await read('search', { q: 'validation missing handler', kinds: ['audit'], limit: 5 });
    expect(JSON.stringify(s)).toContain(`mandate://audits/${id}`);
    // Activity: audit events.
    const act = await read('activity_list', { types: ['audit.*'], limit: 50 });
    const types = new Set(act.events.filter((e: any) => e.refs[0].includes(id)).map((e: any) => e.type));
    for (const t of ['audit.started', 'audit.item_recorded', 'audit.completed', 'audit.finding_resolved']) expect(types).toContain(t);
  }, 120_000);

  it('standard audits group findings per spec by code; abandon; ids get a suffix on collision', async () => {
    const { stdUri, spec, std } = await setup();
    const a = (await ok('audit_start', { target: stdUri })).audit.id as string;
    const b = (await ok('audit_start', { target: stdUri })).audit.id as string;
    expect(b).toBe(`${a}-2`);
    await ok('audit_abandon', { auditId: b, reason: 'duplicate' });
    expect((await fail('audit_record_item', { auditId: b, ref: `${stdUri}/sections/r-must`, result: 'pass' })).code).toBe('audit_frozen');
    await ok('audit_record_item', { auditId: a, ref: `${stdUri}/sections/r-must`, result: 'fail', notes: 'Unvalidated bodies in two places.', findings: [finding('code_deviates', 'In the spec code'), { ...finding('code_deviates', 'Elsewhere'), codeRefs: ['app:src/other.ts#L1'] }] });
    await ok('audit_record_item', { auditId: a, ref: `${stdUri}/sections/r-should`, result: 'pass', notes: 'Errors are logged.' });
    expect((await fail('audit_findings_to_work_orders', { auditId: a })).code).toBe('audit_not_completed');
    await ok('audit_complete', { auditId: a, summary: 'One deviation.', overview: 'Scope: all code the standard covers.' });
    const out = await ok('audit_findings_to_work_orders', { auditId: a, includeShould: false });
    expect(out.workOrders).toHaveLength(1);
    expect(out.workOrders[0].spec).toBe(spec);
    expect(out.unassigned.map((f: any) => f.title)).toEqual(['Elsewhere']);
    const stdList = await read('standard_list', { q: std });
    expect(stdList.items[0].lastAudit).toMatchObject({ id: a, result: 'fail' });
    const stdDoc = await read('doc_get', { kind: 'standards', id: std });
    expect(stdDoc.lastAudit.id).toBe(a);
    expect(stdDoc.audits.findings.length).toBe(2);
    const ov = await read('audit_overview');
    expect(ov.specs[spec]).toBeNull(); // standard audits do not count as the spec's audit
    const comp = await read('doc_get', { kind: 'standards', id: std });
    expect(comp.audits.compliance.rows.find((r: any) => r.kind === 'standard').results[`${stdUri}/sections/r-must`]).toBe('fail');
  }, 60_000);

  it('the stored report cannot be edited after completion except resolutions (storage rule)', async () => {
    const { specUri } = await setup();
    const id = (await ok('audit_start', { target: specUri })).audit.id as string;
    const plan = (await read('audit_get', { auditId: id })).audit.items as { ref: string; level: string }[];
    for (const i of plan) await ok('audit_record_item', { auditId: id, ref: i.ref, result: 'pass', notes: 'Checked.' });
    await ok('audit_complete', { auditId: id, summary: 'All good.', overview: 'Everything passes.' });
    const doc = await fx.storage.audits.get(id);
    await expect(fx.storage.audits.update(id, { summary: 'changed' } as never)).rejects.toMatchObject({ code: 'audit_frozen' });
    await expect(fx.storage.audits.update(id, { sections: doc.sections.map((s) => (s.id === 'overview' ? { ...s, body: 'rewritten' } : s)) } as never)).rejects.toMatchObject({ code: 'audit_frozen' });
    await expect(fx.storage.audits.delete(id)).rejects.toMatchObject({ code: 'archive_only' });
    const got = (await read('audit_get', { auditId: id })).audit;
    expect(got.outcome).toBe('pass');
  }, 60_000);

  it('write tools need write access; read tools work read-only', async () => {
    const { specUri } = await setup();
    const { callTool } = await import('../../src/mcp/define.js');
    const { TOOLS } = await import('../../src/mcp/server.js');
    const def = TOOLS.find((t) => t.name === 'audit_start')!;
    const base = { storage: fx.storage, index: fx.index, reads: fx.reads } as never;
    const ui = await callTool(def, { target: specUri, agent: 'x' }, { ...(base as object), principal: { kind: 'ui', user: { login: 'u' } } } as never);
    expect((ui.structuredContent as any).error.code).toBe('forbidden');
    const ro = await callTool(def, { target: specUri, agent: 'x' }, { ...(base as object), access: 'read' } as never);
    expect((ro.structuredContent as any).error.code).toBe('forbidden');
    const planDef = TOOLS.find((t) => t.name === 'audit_plan')!;
    const p = await callTool(planDef, { target: specUri }, { ...(base as object), access: 'read' } as never);
    expect(p.isError).toBeFalsy();
  });
});
