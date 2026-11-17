/**
 * Implemented sections and "Outdated": an editorial (wording only) edit keeps a section implemented, behaviour edits and
 * criteria cannot be editorial, section_reverify moves the base forward with evidence, leftovers show up in
 * flow_next {} and in decisions (Project health), and spec_implementation says who changed it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpFixture, type McpFixture } from './fixture.js';

vi.setConfig({ testTimeout: 90_000 });
let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'impl@test';
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
  return r.body.error as { code: string; message: string };
}

/** A spec whose `design` section is implemented through a work order. */
async function implemented() {
  const spec = uid('impl');
  await ok('spec_create', {
    id: spec,
    title: `Spec ${spec}`,
    summary: 'A test spec.',
    sections: [
      { id: 'design', title: 'Design', summary: 'How it works.', body: 'The design.' },
      { id: 'ac-works', title: 'It works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'A test proves it.' },
    ],
  });
  const w = await ok('work_order_create', { spec, sections: ['design'], kind: 'implement', plan: { tasks: [{ text: 'build', sections: ['design'] }] } });
  const ref = w.ref as string;
  await ok('work_order_claim', { ref });
  await ok('work_order_section_done', { ref, sections: [`${ref}/sections/design`], codeRefs: [`app:src/${spec}.ts#L1-L5`] });
  return { spec, sec: `mandate://specs/${spec}/sections/design`, wo: ref.split('/').pop()! };
}
const state = async (spec: string) => (await fx.call('spec_implementation', { id: spec })).body.sections.design;

describe('editorial edits and re-verification', () => {
  it('a wording edit without editorial is Outdated (with who changed it); editorial keeps it implemented', async () => {
    const { spec, sec } = await implemented();
    expect((await state(spec)).outdated).toBe(false);
    await ok('section_update', { ref: sec, body: 'The design, reworded.', changeSummary: 'Reworded the design for clarity.' });
    const s = await state(spec);
    expect(s).toMatchObject({ outdated: true });
    expect(s.changedCommit).toBeTruthy();

    const specB = await implemented();
    await ok('section_update', { ref: specB.sec, body: 'Reworded only.', editorial: { reason: 'clearer wording' } });
    const e = await state(specB.spec);
    expect(e.outdated).toBe(false);
    expect(e.implementedBy).toBe(specB.wo);
    const doc = await fx.call('spec_get', { ref: specB.spec });
    expect(doc.body.sections.find((x: any) => x.id === 'design').meta.implementationNotes).toEqual([expect.objectContaining({ kind: 'editorial', reason: 'clearer wording', by: AGENT })]);
  });

  it('editorial is refused for criteria and for behaviour fields', async () => {
    const { sec, spec } = await implemented();
    expect((await fail('section_update', { ref: `mandate://specs/${spec}/sections/ac-works`, body: 'x', editorial: { reason: 'wording' } })).code).toBe('editorial_not_allowed');
    expect((await fail('section_update', { ref: sec, body: 'x', verifiedBy: ['ac-works'], editorial: { reason: 'wording' } })).code).toBe('editorial_not_allowed');
  });

  it('section_reverify moves the base forward; leftovers are listed by flow_next {} and decisions_list', async () => {
    const { spec, sec } = await implemented();
    await ok('section_update', { ref: sec, body: 'Changed outside any task.', changeSummary: 'Changed outside any task.' });
    const next = await fx.call('flow_next', {});
    expect(next.body.outdatedSections.map((x: any) => x.section)).toContain(sec);
    expect(next.body.done).toBe(false);
    const dec = await fx.call('decisions_list', { kinds: ['section_outdated'] });
    expect(dec.body.items.map((x: any) => x.ref)).toContain(sec);
    await fail('section_reverify', { ref: sec });
    await ok('section_reverify', { ref: sec, codeRefs: [`app:src/${spec}.ts#L1-L9`], verifications: ['the create test'] });
    expect((await state(spec)).outdated).toBe(false);
    const after = await fx.call('decisions_list', { kinds: ['section_outdated'] });
    expect(after.body.items.map((x: any) => x.ref)).not.toContain(sec);
  });
});

describe('comments carry the UI context', () => {
  it('stores the displayed state (Outdated, implemented commit, badges) and the selected text; pasted mentions become bare refs', async () => {
    const { spec, sec } = await implemented();
    await ok('section_update', { ref: sec, body: 'Changed outside any task.', changeSummary: 'Changed outside any task.' });
    const added = await ok('comment_add', { target: sec, body: `why is it outdated? @mandate:${sec}`, selectedText: 'The design.' });
    expect(added.comment.body).toBe(`why is it outdated? ${sec}`);
    expect(added.comment.view).toMatchObject({ object: expect.stringContaining('section'), implementation: { state: 'outdated', implementedBy: expect.any(String) }, selectedText: 'The design.' });
    expect(added.comment.view.badges[0].label).toBe('Outdated');
    expect(added.comment.view.badges[0].meaning).toMatch(/editorial/);
    const listed = await fx.call('comments_list', { target: sec });
    expect(JSON.stringify(listed.body)).toContain('"state":"outdated"');
    const ok2 = await fx.call('spec_implementation', { id: spec });
    expect(ok2.body.sections.design.outdated).toBe(true);
  });

  it('a request body with a pasted mention is stored as a bare reference', async () => {
    const { sec } = await implemented();
    const r = await ok('request_create', { kind: 'improvement', body: `Look at @mandate:${sec} please` });
    expect(r.request.body).toBe(`Look at ${sec} please`);
  });
});

describe('change summaries and accepting changes', () => {
  it('an implemented section needs a changeSummary; it is stored per edit and shown with who / when', async () => {
    const { spec, sec } = await implemented();
    const r = await fx.call('section_update', { agent: AGENT, ref: sec, body: 'The design v2.' });
    expect(r.isError).toBe(true);
    expect((r.body.error as { code: string }).code).toBe('change_summary_required');
    // refs / symbols bookkeeping is not a content change
    await ok('section_update', { ref: sec, symbols: [] });
    await ok('section_update', { ref: sec, body: 'The design v2.', changeSummary: 'Sessions now last 30 days.' });
    await ok('section_update', { ref: sec, body: 'The design v3.' , changeSummary: 'Added the refresh rule.' });
    const s = await state(spec);
    expect(s.outdated).toBe(true);
    expect(s.changes.map((c: { summary: string; by: string }) => c.summary)).toEqual(['Sessions now last 30 days.', 'Added the refresh rule.']);
    expect(s.changes[0].by).toBeTruthy();
  });

  it('a depended-on section needs a changeSummary too; legacy edits show no summary', async () => {
    const up = uid('up');
    await ok('spec_create', { id: up, title: 'Upstream', summary: 's', sections: [{ id: 'core', title: 'Core', summary: 's', body: 'v1' }] });
    const down = uid('down');
    await ok('spec_create', { id: down, title: 'Down', summary: 's', sections: [{ id: 'use', title: 'Use', summary: 's', body: 'b' }] });
    await ok('spec_section_link_add', { ref: `mandate://specs/${down}/sections/use`, to: `mandate://specs/${up}/sections/core`, rel: 'depends_on' });
    const miss = await fail('spec_section_update', { ref: `mandate://specs/${up}/sections/core`, body: 'v2' });
    expect(miss.code).toBe('change_summary_required');
    await ok('spec_section_update', { ref: `mandate://specs/${up}/sections/core`, body: 'v2', changeSummary: 'Core now says v2.' });
  });

  it('section_accept: wording only moves the implemented marker (who / why); section_link_ack sets seenAt', async () => {
    const { spec, sec } = await implemented();
    await ok('section_update', { ref: sec, body: 'Reworded.', changeSummary: 'Reworded.' });
    expect((await state(spec)).outdated).toBe(true);
    await ok('section_accept', { ref: sec, reason: 'only wording' });
    const e = await state(spec);
    expect(e.outdated).toBe(false);
    const doc = await fx.call('spec_get', { ref: spec });
    expect(doc.body.sections.find((x: any) => x.id === 'design').meta.implementationNotes.at(-1)).toMatchObject({ kind: 'editorial', reason: 'only wording' });
    // upstream link ack
    const up = uid('up');
    await ok('spec_create', { id: up, title: 'Upstream', summary: 's', sections: [{ id: 'core', title: 'Core', summary: 's', body: 'v1' }] });
    await ok('spec_section_link_add', { ref: sec, to: `mandate://specs/${up}/sections/core`, rel: 'depends_on' });
    await ok('section_link_ack', { ref: sec, to: `mandate://specs/${up}/sections/core` });
    const g = await fx.call('spec_get', { ref: spec });
    expect(g.body.sections.find((x: any) => x.id === 'design').meta.links[0].seenAt).toMatch(/^[0-9a-f]{40}$/);
  });
});
