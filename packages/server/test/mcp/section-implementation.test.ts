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
    await ok('section_update', { ref: sec, body: 'The design, reworded.' });
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
    await ok('section_update', { ref: sec, body: 'Changed outside any task.' });
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
