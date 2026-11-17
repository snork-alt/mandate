/**
 * MCP write tools over Streamable HTTP: a happy path per tool, every error code, transition tables, the done gate
 * (own and inherited criteria), claim races, idempotency, read-your-write (read tools + incremental index) and a
 * full agent workflow. Each test creates its own documents on a clone of the seeded data.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPEC_TRANSITIONS, STORED_SPEC_STATUSES } from '@mandate/shared';
import { connect, mcpFixture, type McpFixture } from './fixture.js';
import { FileIdempotencyStore } from '../../src/mcp/idempotency.js';
import { toWriteError } from '../../src/mcp/errors.js';
import { AppendOnlyError } from '../../src/storage/index.js';
import { tempDir } from '../helpers.js';
import { writeTools } from '../../src/mcp/tools/write.js';
import { inputJsonSchema } from '../../src/mcp/define.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'writer@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
/** Read tools take no agent. */
async function read(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; hint?: string; detail?: Record<string, unknown> };
}
const git = (...args: string[]) => execFileSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8' }).trim();
const head = () => git('rev-parse', 'HEAD');

/** A fresh spec with a few sections (and an acceptance criterion unless `criteria: false`). */
async function newSpec(opts: { criteria?: boolean; title?: string } = {}) {
  const id = uid('spec');
  await ok('spec_create', {
    id,
    title: opts.title ?? `Spec ${id}`,
    summary: 'A test spec.',
    sections: [
      // Ready gate: every section has a criterion (verifiedBy the acceptance section).
      { id: 'overview', title: 'Overview', summary: 'What it does.', body: 'The overview.', ...(opts.criteria === false ? {} : { verifiedBy: ['ac-works'] }) },
      { id: 'design', title: 'Design', summary: 'How it works.', body: 'The design.', ...(opts.criteria === false ? {} : { verifiedBy: ['ac-works'] }) },
      ...(opts.criteria === false ? [] : [{ id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'The feature works.', body: 'A test proves it works.' }]),
    ],
  });
  return id;
}

describe('tools/list', () => {
  it('registers every write tool with guidance, schema and annotations', async () => {
    const client = await connect(new URL(`${fx.url.href}?tools=all`));
    const { tools } = await client.listTools();
    await client.close();
    const names = tools.map((t) => t.name);
    // Per-type document writes are merged (create, status_set, section_insert, ...); their old names stay callable.
    const expected = [
      'create', 'update_meta', 'archive', 'status_set',
      'section_insert', 'section_update', 'section_move', 'section_link_add', 'section_link_remove',
      'work_order_create', 'work_order_claim', 'work_order_heartbeat', 'work_order_release', 'work_order_section_done', 'work_order_complete', 'work_order_fail', 'work_order_cancel', 'work_order_next',
      'feedback_create', 'feedback_update', 'feedback_accept', 'feedback_close', 'verification_record', 'spec_diff_since_implemented',
    ];
    expect(names).toEqual(expect.arrayContaining(expected));
    // The section guide lives on spec_section_insert; the others point at it (prompts review 4.1).
    expect(names.filter((n) => /^(spec|standard|component)_(create|update_meta|archive|status_set|section_(insert|update|move|archive|link_add|link_remove))$/.test(n))).toEqual([]);
    expect(tools.find((x) => x.name === 'section_insert')!.description).toContain('one concept each');
    expect(tools.find((x) => x.name === 'section_update')!.description).toContain('Section guide: section_insert');
    for (const n of ['section_insert', 'section_update', 'create']) {
      const t = tools.find((x) => x.name === n)!;
      if (n === 'section_insert') expect(t.description).toMatch(/summary/);
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['agent', 'branch', 'idempotencyKey']));
    }
  });
});

describe('schema checks per write tool', () => {
  it('every write tool rejects unknown keys and wrong types with invalid_input (nothing written)', async () => {
    const h = head();
    // Every per-type write tool (listed or a hidden alias of a merged tool): called by name.
    const tools = writeTools.map((w) => ({ name: w.name, inputSchema: inputJsonSchema(w.input) }));
    for (const t of tools) {
      const unknown = await fx.call(t.name, { agent: AGENT, bogus: 1 });
      expect(unknown.body.error?.code, t.name).toBe('invalid_input');
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties).filter((k) => !['agent', 'branch', 'idempotencyKey'].includes(k));
      const wrong = await fx.call(t.name, { agent: AGENT, [props[0]!]: { not: 'valid' } });
      expect(wrong.body.error?.code, t.name).toBe('invalid_input');
    }
    expect(head()).toBe(h);
  });
});

describe('specs and standards', () => {
  it('create, insert, update, move, link, unlink, archive, update meta, status: refs, commit, warnings, section', async () => {
    const id = await newSpec();
    const other = await newSpec({ criteria: false });
    const before = head();
    const ins = await ok('spec_section_insert', { doc: `mandate://specs/${id}`, section: { id: 'api', title: 'API', body: 'GET /things' }, after: 'overview' });
    expect(ins.ref).toBe(`mandate://specs/${id}/sections/api`);
    expect(ins.commit).toBe(head());
    expect(ins.commit).not.toBe(before);
    expect(ins.uri).toBe(`mandate://specs/${id}@${ins.commit}/sections/api`);
    expect(ins.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no summary/)]));
    expect(ins.section).toMatchObject({ id: 'api', title: 'API' });
    expect(git('log', '-1', '--format=%B')).toMatch(/Agent: writer@test/);
    // Section order.
    const doc = await read('spec_get', { ref: id, metadataOnly: true });
    expect(doc.sections.map((s: { id: string }) => s.id)).toEqual(['overview', 'api', 'design', 'ac-works']);

    const upd = await ok('spec_section_update', { ref: ins.uri, summary: 'The HTTP API.', body: 'GET /things returns things.', branch: 'feat/api', addresses: [] });
    expect(upd.warnings).toEqual([]);
    expect(upd.section.body).toBe('GET /things returns things.');
    expect(git('log', '-1', '--format=%B')).toMatch(/Branch: feat\/api/);
    // A stale @sha is rejected (optimistic concurrency).
    expect((await fail('spec_section_update', { ref: ins.uri, body: 'x' })).code).toBe('stale_version');

    await ok('spec_section_move', { ref: `mandate://specs/${id}/sections/api`, position: 'last' });
    expect((await read('spec_get', { ref: id, metadataOnly: true })).sections.map((s: { id: string }) => s.id).at(-1)).toBe('api');

    const link = await ok('spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, to: `@mandate:mandate://specs/${other}/sections/overview`, rel: 'depends_on' });
    expect(link.section.links).toEqual(expect.arrayContaining([expect.objectContaining({ to: `mandate://specs/${other}/sections/overview`, rel: 'depends_on' })]));
    await ok('spec_section_link_remove', { ref: `mandate://specs/${id}/sections/design`, to: `mandate://specs/${other}/sections/overview` });

    const arch = await ok('spec_section_archive', { ref: `mandate://specs/${id}/sections/api`, reason: 'merged into design' });
    expect(arch.section.archived).toBe(true);
    expect((await fail('spec_section_update', { ref: `mandate://specs/${id}/sections/api`, body: 'y' })).code).toBe('validation');

    const meta = await ok('spec_update_meta', { ref: id, tags: ['api'], priority: 'p1', category: null });
    expect(meta.document).toMatchObject({ tags: ['api'], priority: 'p1' });
    expect((await ok('spec_status_set', { ref: id, status: 'ready' })).status).toBe('ready');
    expect((await ok('spec_archive', { ref: id, reason: 'superseded' })).status).toBe('archived');
  }, 60_000);

  it('standards: create, sections, links, metadata', async () => {
    const a = uid('std');
    const b = uid('std');
    const ca = await ok('standard_create', { id: a, title: `Std ${a}`, appliesTo: ['tag:zz-none'], sections: [{ id: 'rules', title: 'Rules', summary: 'The rules.', body: 'Do it right.' }] });
    expect(ca.ref).toBe(`mandate://standards/${a}`);
    await ok('standard_create', { id: b, title: `Std ${b}`, sections: [{ id: 'base', title: 'Base', summary: 'Base rules.', body: 'Base.' }] });
    await ok('standard_section_insert', { doc: a, section: { id: 'r-ok', title: 'Rule holds', type: 'rule', level: 'must', rationale: 'Safety first.', summary: 'Reviewed.', body: 'A reviewer checks it.' } });
    await ok('standard_section_update', { ref: `mandate://standards/${a}/sections/rules`, body: 'Do it right, always.' });
    await ok('standard_section_move', { ref: `mandate://standards/${a}/sections/r-ok`, position: 'first' });
    await ok('standard_section_update', { ref: `mandate://standards/${a}/sections/r-ok`, level: 'should', check: { kind: 'lint', command: 'eslint .' } });
    await ok('standard_section_link_add', { ref: `mandate://standards/${a}/sections/rules`, to: `mandate://standards/${b}/sections/base`, rel: 'extends' });
    await ok('standard_section_link_remove', { ref: `mandate://standards/${a}/sections/rules`, to: `mandate://standards/${b}/sections/base`, rel: 'extends' });
    await ok('standard_section_archive', { ref: `mandate://standards/${b}/sections/base` });
    expect((await ok('standard_update_meta', { ref: a, appliesTo: ['tag:zz-other'], effectiveFrom: '2026-01-01' })).document.appliesTo).toEqual(['tag:zz-other']);
    // Lifecycle: deprecating needs a successor; transitions follow the table.
    expect((await fail('standard_status_set', { ref: b, status: 'deprecated' })).code).toMatch(/validation|transition_not_allowed|invalid/);
    expect((await ok('standard_status_set', { ref: b, status: 'deprecated', supersededBy: a })).supersededBy).toBe(`mandate://standards/${a}`);
  }, 60_000);
});

describe('tldr', () => {
  const TLDR = 'Lets people sign in once.\n\n- Works across apps\n- Sessions end after a day';
  it('spec, standard and component: create, update, clear, read back; warns only while a non-draft doc has none', async () => {
    const sid = uid('spec');
    const c = await ok('spec_create', { id: sid, title: `Spec ${sid}`, tldr: TLDR, sections: [{ id: 'a', title: 'A', summary: 'Part a.', body: 'Body a.' }] });
    expect(c.document.tldr).toBe(TLDR);
    expect(JSON.stringify(await read('get', { ref: `mandate://specs/${sid}` }))).toContain('Lets people sign in once');
    expect(c.warnings.join(' ')).not.toMatch(/no tldr/); // drafts never warn
    const cleared = await ok('spec_update_meta', { ref: sid, tldr: null });
    expect(cleared.document.tldr).toBeUndefined();
    expect(cleared.warnings.join(' ')).not.toMatch(/no tldr/); // still a draft
    const again = await ok('spec_update_meta', { ref: sid, tldr: 'Back again.' });
    expect(again.document.tldr).toBe('Back again.');
    expect((await fail('spec_update_meta', { ref: sid, tldr: 'x'.repeat(1201) })).code).toMatch(/invalid_input|validation/);

    const stdId = uid('std');
    const s = await ok('standard_create', { id: stdId, title: `Std ${stdId}`, sections: [{ id: 'r', title: 'R', summary: 'Rule.', body: 'Rule.' }] });
    expect(s.warnings.join(' ')).toMatch(/no tldr/); // active by default, no tldr
    expect((await ok('standard_update_meta', { ref: stdId, tldr: TLDR })).warnings.join(' ')).not.toMatch(/no tldr/);

    const cid = uid('cmp');
    const k = await ok('component_create', { id: cid, title: 'Thing', kind: 'module', tldr: TLDR, sections: [{ id: 'responsibility', title: 'Responsibility', summary: 'Does it.', body: 'Does it.' }] });
    expect(k.document.tldr).toBe(TLDR);
    expect(k.warnings.join(' ')).not.toMatch(/no tldr/);
  }, 60_000);
});

describe('error codes', () => {
  it('transition_not_allowed (spec and work order)', async () => {
    const id = await newSpec({ criteria: false });
    expect((await fail('spec_status_set', { ref: id, status: 'done' })).code).toBe('transition_not_allowed');
    const wo = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['overview'], kind: 'review' });
    await ok('work_order_cancel', { ref: wo.ref, note: 'not needed' });
    expect((await fail('work_order_claim', { ref: wo.ref })).code).toBe('transition_not_allowed');
    expect((await fail('work_order_fail', { ref: wo.ref, note: 'x' })).code).toBe('transition_not_allowed');
  });

  it('claim_conflict and stale_claim', async () => {
    const id = await newSpec({ criteria: false });
    const wo = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['overview'], kind: 'implement' });
    await ok('work_order_claim', { ref: wo.ref, agent: 'agent-a' });
    expect((await fail('work_order_claim', { ref: wo.ref, agent: 'agent-b' })).code).toBe('claim_conflict');
    expect((await fail('work_order_section_done', { ref: wo.ref, sections: ['overview'], agent: 'agent-b' })).code).toBe('claim_conflict');
    expect((await fail('work_order_heartbeat', { ref: wo.ref, agent: 'agent-b' })).code).toBe('claim_conflict');
    // Make agent-a's claim stale (as if it stopped heartbeating an hour ago).
    const woId = wo.ref.split('/').pop();
    // Heartbeats are runtime state: an old claim, an old heartbeat and a server that started long ago.
    const old = new Date(Date.now() - 3600_000).toISOString();
    await fx.storage.workOrderDocs.modify(woId, (d) => ({ ...d, claim: { ...d.claim!, startedAt: old } }), { agent: 'agent-a' });
    fx.storage.heartbeats.set(woId, 'agent-a', old);
    const hb = fx.storage.heartbeats as { startedAt: number };
    const started = hb.startedAt;
    hb.startedAt = 0;
    expect((await fail('work_order_complete', { ref: wo.ref, agent: 'agent-b', outcome: 'x' })).code).toBe('stale_claim');
    hb.startedAt = started;
    fx.storage.heartbeats.set(woId, 'agent-a', old);
    hb.startedAt = 0;
    // Claiming takes the stale claim over.
    expect((await ok('work_order_claim', { ref: wo.ref, agent: 'agent-b' })).workOrder.item.claim.agent).toBe('agent-b');
    hb.startedAt = started;
  });

  it('cycle and superseded_target', async () => {
    const a = await newSpec({ criteria: false });
    const b = await newSpec({ criteria: false });
    await ok('spec_section_link_add', { ref: `mandate://specs/${a}/sections/design`, to: `mandate://specs/${b}/sections/design`, rel: 'depends_on' });
    const c = await fail('spec_section_link_add', { ref: `mandate://specs/${b}/sections/design`, to: `mandate://specs/${a}/sections/design`, rel: 'depends_on' });
    expect(c.code).toBe('cycle');
    expect(c.detail?.kind).toBe('links');
    // b/overview supersedes a/overview: new links to a/overview are refused, the error names the successor.
    await ok('spec_section_link_add', { ref: `mandate://specs/${b}/sections/overview`, to: `mandate://specs/${a}/sections/overview`, rel: 'supersedes' });
    const x = await newSpec({ criteria: false });
    const s = await fail('spec_section_link_add', { ref: `mandate://specs/${x}/sections/design`, to: `mandate://specs/${a}/sections/overview`, rel: 'depends_on' });
    expect(s.code).toBe('superseded_target');
    expect(s.message).toContain(`${b}`);
  });

  it('feedback_closed, not_found, validation, append_only, section_referenced', async () => {
    const id = await newSpec({ criteria: false });
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/overview#L1-L2`], kind: 'question', body: 'Why?' });
    await ok('feedback_close', { ref: fb.ref, resolution: 'rejected', resolutionNote: 'by design' });
    expect((await fail('feedback_update', { ref: fb.ref, body: 'changed' })).code).toBe('feedback_closed');
    expect((await fail('feedback_accept', { ref: fb.ref })).code).toBe('feedback_closed');
    expect((await fail('spec_section_update', { ref: `mandate://specs/${id}/sections/nope`, body: 'x' })).code).toBe('not_found');
    expect((await fail('work_order_claim', { ref: 'wo-doesnotexist' })).code).toBe('not_found');
    expect((await fail('spec_section_insert', { doc: id, section: { id: 'overview', title: 'Again' } })).code).toBe('id_reused'); // registry: id_reused (Fable drift fix)
    expect((await fail('feedback_close', { ref: (await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'b' })).ref, resolution: 'rejected' })).code).toBe('validation');
    const v = await fail('spec_section_move', { ref: `mandate://specs/${id}/sections/design`, after: 'overview', before: 'overview' });
    expect(v.code).toBe('validation');
    // append_only (no tool can update a result; the storage error maps to append_only).
    expect(toWriteError(new AppendOnlyError('append_only: verification records cannot be updated')).code).toBe('append_only');
    // A referenced section cannot vanish; archiving is the way.
    const wo = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['design'], kind: 'implement' });
    expect(wo.ref).toMatch(/^mandate:\/\/work-orders\//);
    const spec = await fx.storage.specs.get(id);
    await expect(fx.storage.specs.update(id, { sections: spec.sections.filter((s) => s.id !== 'design') } as never, { agent: AGENT })).rejects.toMatchObject({ code: 'section_referenced' });
  });

  it('never a partial write: HEAD and the working tree are unchanged after rejected calls', async () => {
    const id = await newSpec();
    const h = head();
    for (const [name, args] of [
      ['spec_status_set', { ref: id, status: 'done' }],
      ['spec_section_insert', { doc: id, section: { id: 'overview', title: 'dup' } }],
      ['spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, to: `mandate://specs/${id}/sections/overview`, rel: 'depends_on' }],
      ['feedback_create', { targets: [`mandate://specs/${id}/sections/nope`], kind: 'bug', body: 'x' }],
      ['verification_record', { criterion: `mandate://specs/${id}/sections/design`, code: { repo: 'app', commit: 'abcdef1' }, result: 'pass', method: 'test' }],
    ] as const) {
      await fail(name, args as never);
      expect(head(), name).toBe(h);
      expect(git('status', '--porcelain'), name).toBe('');
    }
  });
});

describe('transition tables', () => {
  it('spec: every allowed transition succeeds, every other one is transition_not_allowed', async () => {
    // Every section has a criterion (ready gate); the criterion is verified before done (done gate).
    let checked = 0;
    const pass = (id: string) => ok('verification_record', { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abc1234' }, result: 'pass', method: 'test' });
    for (const from of STORED_SPEC_STATUSES) {
      for (const to of STORED_SPEC_STATUSES) {
        if (from === to) continue;
        const id = await newSpec();
        await pass(id);
        const path: Record<string, string[]> = { draft: [], ready: ['ready'], done: ['ready', 'done'], archived: ['archived'] };
        for (const s of path[from]!) await ok('spec_status_set', { ref: id, status: s });
        const r = await fx.call('spec_status_set', { agent: AGENT, ref: id, status: to });
        if (SPEC_TRANSITIONS[from].includes(to)) expect(r.isError, `${from} -> ${to}: ${JSON.stringify(r.body.error)}`).toBe(false);
        else expect(r.body.error?.code, `${from} -> ${to}`).toBe('transition_not_allowed');
        checked++;
      }
    }
    expect(checked).toBe(12);
  }, 120_000);

  it('work orders and feedback through their tools', async () => {
    const id = await newSpec({ criteria: false });
    const wo = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['overview', 'design'], kind: 'review', priority: 'p1' });
    expect(wo.workOrder.item.status).toBe('pending');
    expect((await ok('work_order_claim', { ref: wo.ref })).workOrder.item.status).toBe('in_progress');
    expect((await ok('work_order_heartbeat', { ref: wo.ref })).workOrder.item.claim.agent).toBe(AGENT);
    expect((await ok('work_order_release', { ref: wo.ref })).workOrder.item).toMatchObject({ status: 'pending' });
    expect((await ok('work_order_fail', { ref: wo.ref, note: 'flaky env' })).workOrder.item.status).toBe('failed');
    expect((await ok('work_order_claim', { ref: wo.ref })).workOrder.item.status).toBe('in_progress');
    expect((await ok('work_order_section_done', { ref: wo.ref, sections: ['overview'] })).workOrder.item.sections[0].status).toBe('done');
    const done = await ok('work_order_complete', { ref: wo.ref, outcome: 'Delivered.' });
    expect(done.workOrder.item.status).toBe('done');
    expect(done.workOrder.item.claim).toBeUndefined();
    expect((await fail('work_order_cancel', { ref: wo.ref })).code).toBe('transition_not_allowed');
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'improvement', body: 'Better.' });
    expect((await ok('feedback_accept', { ref: fb.ref })).feedback.status).toBe('accepted');
    expect((await ok('feedback_update', { ref: fb.ref, body: 'Much better.' })).feedback.body).toBe('Much better.');
    // DF-12: applied needs a linked change (here: the edit that addresses it).
    expect((await fail('feedback_close', { ref: fb.ref, resolution: 'applied' })).code).toBe('applied_without_changes');
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'Better overview.', addresses: [fb.ref] });
    expect((await ok('feedback_close', { ref: fb.ref, resolution: 'applied' })).feedback).toMatchObject({ status: 'closed', resolution: 'applied' });
  });
});

describe('done gate', () => {
  it('own and inherited criteria (followed standard) must be verified; the gate snapshot is recorded', async () => {
    const std = uid('std');
    await ok('standard_create', { id: std, title: `Std ${std}`, sections: [{ id: 'rules', title: 'Rules', summary: 'Rules.', body: 'Be safe.' }, { id: 'r-safe', title: 'Safe', type: 'rule', level: 'must', rationale: 'Incidents are costly.', summary: 'Safe.', body: 'It is safe.' }] });
    const id = await newSpec();
    await ok('spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, to: `mandate://standards/${std}`, rel: 'follows' });
    await ok('spec_status_set', { ref: id, status: 'ready' });
    const g = await fail('spec_status_set', { ref: id, status: 'done' });
    expect(g.code).toBe('done_gate');
    const failures = g.detail!.failures as { uri: string; path?: string[] }[];
    expect(failures.map((f) => f.uri)).toEqual(expect.arrayContaining([`mandate://specs/${id}/sections/ac-works`, `mandate://standards/${std}/sections/r-safe`]));
    expect(failures.find((f) => f.uri.includes(std))!.path?.length).toBeGreaterThan(0);
    const v1 = await ok('verification_record', { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test' });
    expect(v1.ref).toMatch(/^mandate:\/\/verifications\/vr-/);
    expect(git('log', '-1', '--format=%B')).toMatch(/Verification: vr-/);
    expect((await fail('spec_status_set', { ref: id, status: 'done' })).code).toBe('done_gate');
    await ok('verification_record', { criterion: `mandate://standards/${std}/sections/r-safe`, appliedTo: id, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'review' });
    const done = await ok('spec_status_set', { ref: id, status: 'done' });
    expect(done.status).toBe('done');
    expect(done.gate.criteria.length).toBe(2);
  });
});

describe('claims and work_order_next', () => {
  it('two clients race for the only eligible work order: exactly one wins', async () => {
    const id = await newSpec({ criteria: false });
    await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['overview'], kind: 'implement', priority: 'p0' });
    const c2 = await connect(fx.url, 'racer-2');
    const call = async (client: typeof fx.client, agent: string) =>
      (await client.callTool({ name: 'work_order_next', arguments: { agent, spec: id } })).structuredContent as Record<string, any>;
    const [a, b] = await Promise.all([call(fx.client, 'racer-1'), call(c2, 'racer-2')]);
    const winners = [a, b].filter((r) => r.workOrder);
    expect(winners).toHaveLength(1);
    expect([a, b].filter((r) => r.workOrder === null)).toHaveLength(1);
    expect(['racer-1', 'racer-2']).toContain(winners[0]!.workOrder.item.claim.agent);
    await c2.close();
  });

  it('skips blocked work orders and orders by priority', async () => {
    const up = await newSpec({ criteria: false });
    const id = await newSpec({ criteria: false });
    await ok('spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, to: `mandate://specs/${up}/sections/design`, rel: 'depends_on' });
    const blocked = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['design'], kind: 'implement', priority: 'p0' });
    const low = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['overview'], kind: 'implement', priority: 'p3' });
    const r = await ok('work_order_next', { spec: id, agent: 'picker' });
    expect(r.ref).toBe(low.ref);
    expect(r.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ id: blocked.ref.split('/').pop(), reason: expect.stringMatching(/blocked/) })]));
    expect((await ok('work_order_next', { spec: id, agent: 'picker-2' })).workOrder).toBeNull();
  });
});

describe('idempotency', () => {
  it('a repeated key replays the result without a new commit; other args conflict; keys persist', async () => {
    const id = await newSpec({ criteria: false });
    const key = `idem-${uid('k')}`;
    const r1 = await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'Once.', idempotencyKey: key });
    const h = head();
    const r2 = await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'Once.', idempotencyKey: key });
    expect(r2).toEqual(r1);
    expect(head()).toBe(h);
    expect((await fail('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'Twice.', idempotencyKey: key })).code).toBe('idempotency_conflict');
    // Durable store: a new instance (e.g. after a restart) still has the result.
    const file = path.join(await tempDir(), 'idem.json');
    const s1 = new FileIdempotencyStore(file);
    s1.set('k1', { args: '{}', at: Date.now(), result: { content: [], structuredContent: { ok: 1 } } });
    expect(new FileIdempotencyStore(file).get('k1')?.result.structuredContent).toEqual({ ok: 1 });
    s1.set('old', { args: '{}', at: Date.now() - 25 * 3600_000, result: { content: [] } });
    expect(new FileIdempotencyStore(file).get('old')).toBeUndefined();
  });
});

describe('read-your-write', () => {
  it('read tools, resources and the incremental index see a write immediately', async () => {
    const id = await newSpec({ criteria: false });
    const other = await newSpec({ criteria: false });
    const marker = `zebracorn${Date.now()}`;
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: `The design uses a ${marker}.` });
    await ok('spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, to: `mandate://specs/${other}/sections/design`, rel: 'depends_on' });
    expect((await read('spec_section_get', { ref: `mandate://specs/${id}/sections/design` })).section.body).toContain(marker);
    const res = await fx.client.readResource({ uri: `mandate://specs/${id}/sections/design` });
    expect(JSON.stringify(res.contents)).toContain(marker);
    const hits = await read('text_search', { q: marker });
    expect(hits.matches[0].uri).toMatch(new RegExp(`^mandate://specs/${id}/sections/design#L`));
    const n = await read('graph_neighbors', { uri: `mandate://specs/${id}/sections/design`, direction: 'out', kinds: ['depends_on'] });
    expect(n.nodes.map((x: { uri: string }) => x.uri)).toContain(`mandate://specs/${other}/sections/design`);
    const deps = await read('graph_neighbors', { uri: `mandate://specs/${id}`, direction: 'out', kinds: ['spec_depends_on'] });
    expect(deps.nodes.map((x: { uri: string }) => x.uri)).toContain(`mandate://specs/${other}`);
  });
});

describe('full agent workflow', () => {
  it('next -> claim -> read -> edit -> verify -> section_done -> complete, with feedback filed and closed', async () => {
    const id = await newSpec();
    const wo = await ok('work_order_create', { plan: 'The plan.', spec: id, sections: ['design', 'ac-works'], kind: 'implement', priority: 'p0', note: 'build it' });
    const agent = 'workflow-agent@ci';
    const next = await ok('work_order_next', { agent, spec: id, branch: 'feat/flow' });
    expect(next.ref).toBe(wo.ref);
    expect(next.workOrder.item.claim).toMatchObject({ agent, branch: 'feat/flow' });
    // Read what to build.
    const got = await read('work_order_get', { ref: wo.ref });
    expect(got.sections.map((s: { id: string }) => s.id)).toEqual(['design', 'ac-works']);
    const design = await read('spec_section_get', { ref: `mandate://specs/${id}/sections/design` });
    expect(design.section.body).toBe('The design.');
    // The agent finds the design ambiguous: files feedback, the owner accepts, the agent clarifies the section.
    const fb = await ok('feedback_create', { agent, targets: [`mandate://specs/${id}/sections/design`], kind: 'ambiguity', body: 'Which storage?', quote: 'The design.' });
    await ok('feedback_accept', { ref: fb.ref, agent: 'owner' });
    const edit = await ok('spec_section_update', { agent, ref: `mandate://specs/${id}/sections/design`, body: 'The design stores things in Postgres.', addresses: [fb.ref], workOrder: wo.ref });
    expect(git('log', '-1', '--format=%B')).toMatch(new RegExp(`Feedback: ${fb.ref.split('/').pop()}[\\s\\S]*Work-Order: ${wo.ref.split('/').pop()}`));
    expect(edit.section.body).toContain('Postgres');
    await ok('work_order_heartbeat', { agent, ref: wo.ref });
    // Verify, finish the sections, complete.
    await ok('verification_record', { agent, criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'feedc0de12', branch: 'feat/flow' }, result: 'pass', method: 'test', evidence: { test: 'tests/works.spec.ts' } });
    const sd = await ok('work_order_section_done', { agent, ref: wo.ref, sections: ['design'] });
    expect(sd.commits.length).toBe(2); // spec (implementedCommit) + work order
    expect(git('log', '-2', '--format=%B')).toMatch(/Work-Order:/);
    const complete = await ok('work_order_complete', { agent, ref: wo.ref, outcome: 'Delivered.' });
    expect(complete.workOrder.item.status).toBe('done');
    await ok('feedback_close', { agent: 'owner', ref: fb.ref, resolution: 'applied' });
    const closed = await read('feedback_get', { ref: fb.ref });
    expect(closed.feedback.status).toBe('closed');
    expect(edit.section.derived).toMatchObject({ blocked: false, broken: false });
    expect(closed.feedback.changes.map((c: { uri: string }) => c.uri)).toContain(`mandate://specs/${id}`);
    // What changed since implemented: nothing (just implemented).
    const diff = await read('spec_diff_since_implemented', { workOrder: wo.ref });
    expect(diff.sections.map((s: { section: string }) => s.section)).toEqual(['design', 'ac-works']);
    // The section was clarified after the work order pinned it: implemented at the pin, so it reads as modified since.
    const since = await read('spec_diff_since_implemented', { sections: [`mandate://specs/${id}/sections/design`] });
    expect(since.sections[0]).toMatchObject({ status: 'modified', section: 'design' });
    expect(JSON.stringify(since.sections[0].body)).toContain('Postgres');
    // The activity feed and history show the agent's commits.
    const hist = await read('history_search', { agent });
    expect(hist.total).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
