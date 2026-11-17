/**
 * Components required (default): plan files owned by no component warn at work_order_create; work_order_complete is
 * refused (components_missing) while touched files are unowned; a component owning them (or the project setting
 * components: optional) lets it through; flow_next asks for the component step first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memorySettings } from '../../src/projects/settings.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
const settings = memorySettings();
beforeAll(async () => {
  fx = await mcpFixture({ settings } as never);
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const A = 'gate@test';
let n = 0;
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { agent: A, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function newWo(files: string[]) {
  const spec = `cg-${Date.now().toString(36)}-${n++}`;
  await ok('spec_create', { id: spec, title: spec, summary: 's', sections: [{ id: 'design', title: 'Design', summary: 'd', body: 'b' }] });
  const wo = await ok('work_order_create', { spec, kind: 'fix', sections: ['design'], fastPath: true, plan: { tasks: [{ text: 'do it', sections: ['design'] }], files, tests: [], risks: [] } });
  await ok('work_order_claim', { ref: wo.ref });
  await ok('work_order_section_done', { ref: wo.ref, sections: ['design'], notes: 'done', codeRefs: [`app:${files[0]}`], code: { repo: 'app', commit: 'abc1234' } });
  return wo.ref as string;
}

describe('components required', () => {
  it('refuses completion while touched files are unowned; a component owning them lets it through', async () => {
    const wo = await newWo(['src/gate/a.ts']);
    const r = await fx.call('work_order_complete', { agent: A, ref: wo, outcome: 'Built.', reconciliation: 'x', git: [{ repo: 'app', headCommit: 'abc1234' }] });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('components_missing');
    expect(r.body.error.message).toContain('app:src/gate/a.ts');
    expect(r.body.error.hint).toMatch(/component_create/);
    await ok('component_create', { id: `gate-${n++}`, title: 'Gate', kind: 'module', owns: [{ repo: 'app', paths: ['src/gate/**'] }], sections: [{ id: 'responsibility', title: 'Responsibility', summary: 'r', body: 'r' }] });
    const done = await ok('work_order_complete', { ref: wo, outcome: 'Built.', reconciliation: 'x', git: [{ repo: 'app', headCommit: 'abc1234' }] });
    expect(done.workOrder.item.status).toBe('done');
  });

  it('plan files without an owner warn at creation', async () => {
    const spec = `cg-${Date.now().toString(36)}-${n++}`;
    await ok('spec_create', { id: spec, title: spec, summary: 's', sections: [{ id: 'design', title: 'Design', summary: 'd', body: 'b' }] });
    const wo = await ok('work_order_create', { spec, kind: 'fix', sections: ['design'], fastPath: true, plan: { tasks: [{ text: 'x', sections: ['design'] }], files: ['app:src/unowned/zzz.ts'], tests: [], risks: [] } });
    expect((wo.warnings as string[]).some((w) => w.startsWith('plan_components_missing') && w.includes('src/unowned/zzz.ts'))).toBe(true);
  });

  it('components optional: completion is not refused', async () => {
    await settings.setPolicy({ components: 'optional' });
    const wo = await newWo(['src/gate-opt/a.ts']);
    const done = await ok('work_order_complete', { ref: wo, outcome: 'Built.', reconciliation: 'x', git: [{ repo: 'app', headCommit: 'abc1234' }] });
    expect(done.workOrder.item.status).toBe('done');
    await settings.setPolicy({ components: 'required' });
  });
});
