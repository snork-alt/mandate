/** project_overview: the landing-page aggregate (maturity, attention, in progress, blocked, decisions, coverage). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATURITY_STEPS } from '@mandate/shared';
import { maturities } from '../../src/storage/maturity.js';
import { projectOverview } from '../../src/storage/overview.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());

describe('project_overview', () => {
  it('agrees with the spec list maturity (one state vocabulary)', async () => {
    const { body, isError } = await fx.call('project_overview', {});
    expect(isError).toBe(false);
    const specs = await fx.storage.specs.list();
    const mat = await maturities(fx.storage, specs);
    const live = specs.filter((s) => s.status !== 'archived');
    expect(body.maturity.total).toBe(live.length);
    for (const st of MATURITY_STEPS) expect(body.maturity.steps[st], st).toBe(live.filter((s) => mat[s.id]!.step === st).length);
    for (const o of ['failing', 'drifted', 'blocked', 'stale']) {
      const n = live.filter((s) => mat[s.id]!.overlays.some((x) => x.kind === o)).length;
      expect(body.maturity.overlays[o], o).toBe(n);
      expect(body.attention[o], o).toBe(n);
    }
    // Attention specs: worst first, each with a reason.
    const order = { failing: 0, drifted: 1, blocked: 2, stale: 3 } as Record<string, number>;
    const ranks = body.attention.specs.map((s: any) => order[mat[s.id]!.overlays[0]!.kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(body.attention.specs.every((s: any) => typeof s.reason === 'string' && s.reason.length > 0)).toBe(true);
  });

  it('work in progress, queue and stale claims match the work orders', async () => {
    const { body } = await fx.call('project_overview', {});
    const wos = await fx.storage.workOrderService.list();
    const open = wos.filter((w) => w.status === 'pending' || w.status === 'in_progress');
    expect(body.inProgressTotal).toBe(open.filter((w) => w.claim || w.status === 'in_progress').length);
    expect(body.queued).toBe(open.filter((w) => !w.claim && w.status === 'pending').length);
    for (const w of body.inProgress) {
      expect(w.sections.done).toBeLessThanOrEqual(w.sections.total);
      if (w.claim) expect(typeof w.claim.stale).toBe('boolean');
    }
    expect(body.attention.staleClaims).toBe(body.inProgress.filter((w: any) => w.claim?.stale).length);
  });

  it('blocked items name their blockers; decisions and coverage are consistent', async () => {
    const { body } = await fx.call('project_overview', {});
    for (const b of body.blocked) {
      expect(['section', 'work_order']).toContain(b.kind);
      expect(b.uri).toMatch(/^mandate:\/\//);
    }
    expect(body.blocked.filter((b: any) => b.kind === 'section').every((b: any) => b.blockedBy.length > 0)).toBe(true);
    const c = body.coverage;
    expect(c.criteria.verified).toBeLessThanOrEqual(c.criteria.total);
    expect(c.audits.never + c.audits.stale + c.audits.recent).toBe(c.audits.total);
    expect(c.sections.implemented).toBeLessThanOrEqual(c.sections.total);
    if (c.lineage) expect(c.lineage.withCause).toBeLessThanOrEqual(c.lineage.contentEdits);
    expect(body.decisions).toBeUndefined(); // decisions_list is the one source of pending decisions
    expect(body.attention.integrityWarnings).toBeGreaterThanOrEqual(body.warnings.length);
    // Health: gaps worst first; warnings grouped by rule (counts add up); categories list their specs.
    const score = (g: any) => g.criteria.failing * 4 + g.criteria.stale * 2 + g.criteria.unverified + (!g.audit ? 3 : g.audit.stale ? 1 : 0);
    expect(body.gaps.map(score)).toEqual([...body.gaps.map(score)].sort((a: number, b: number) => b - a));
    expect(body.gaps.every((g: any) => score(g) > 0)).toBe(true);
    expect(body.warningGroups.reduce((n: number, g: any) => n + g.count, 0)).toBe(body.attention.integrityWarnings);
    for (const c of body.byCategory) expect(c.specs.length).toBe(c.total);
  });

  it('caps lists with limit but keeps full counts; strict input', async () => {
    const { body } = await fx.call('project_overview', { limit: 1 });
    expect(body.inProgress.length).toBeLessThanOrEqual(1);
    expect(body.blocked.length).toBeLessThanOrEqual(1);
    expect(body.warnings.length).toBeLessThanOrEqual(1);
    const bad = await fx.call('project_overview', { nope: 1 });
    expect(bad.isError).toBe(true);
    const zero = await fx.call('project_overview', { limit: 0 });
    expect(zero.isError).toBe(true);
  });

  it('In progress tab data: plan step, specs of the work, agent sessions and recently completed work orders', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await fx.call(name, { agent: 'claude-code@ov', ...args });
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body.error)}`);
      return r.body;
    };
    const id = `ov-prog-${Date.now().toString(36)}`;
    await call('spec_create', { id, title: 'Progress spec', summary: 'Overview progress.', sections: [{ id: 'one', title: 'One', summary: 'One.', body: 'Body.' }, { id: 'two', title: 'Two', summary: 'Two.', body: 'Body.' }] });
    const wo = await call('work_order_create', { spec: id, sections: ['one'], kind: 'implement', plan: { steps: ['Read the spec', 'Write the tests', 'Ship it'] } });
    await call('work_order_claim', { ref: wo.ref });
    // The agent sets the steps it has done (steps are data: work_order_step_set).
    await call('work_order_step_set', { ref: wo.ref, step: 's1', status: 'done' });
    const fix = await call('work_order_create', { spec: id, sections: ['two'], kind: 'fix', fastPath: true, title: 'Quick fix' });
    await call('work_order_claim', { ref: fix.ref });
    await call('work_order_complete', { ref: fix.ref, outcome: 'Fixed.' });

    const { body } = await fx.call('project_overview', {});
    const woId = String(wo.ref).split('/').pop();
    const fixId = String(fix.ref).split('/').pop();
    const w = body.inProgress.find((x: any) => x.id === woId);
    expect(w.plan).toMatchObject({ total: 3, done: 1, current: { index: 2, text: 'Write the tests', id: 's2' } });
    expect(w.plan.steps.map((x: any) => x.status)).toEqual(['done', 'pending', 'pending']);
    const ps = body.progressSpecs.find((x: any) => x.id === id);
    expect(ps.title).toBe('Progress spec');
    expect(ps.maturity.sections.total).toBe(2);
    const live = body.sessions.find((s: any) => s.workOrder === woId);
    expect(live).toMatchObject({ agent: 'claude-code@ov', kind: 'implement', stale: false });
    expect(live.heartbeatAt).toBeTruthy();
    const ended = body.sessions.find((s: any) => s.workOrder === fixId);
    expect(ended).toMatchObject({ agent: 'claude-code@ov', ended: 'completed' });
    const done = body.recentlyCompleted.find((x: any) => x.id === fixId);
    expect(done).toMatchObject({ title: 'Quick fix', kind: 'fix', spec: id, agent: 'claude-code@ov' });
    expect(Date.parse(done.completedAt)).toBeGreaterThanOrEqual(Date.parse(done.startedAt));
    expect(body.recentlyCompleted.map((x: any) => x.completedAt)).toEqual([...body.recentlyCompleted.map((x: any) => x.completedAt)].sort().reverse());
  });

  it('is fast (single pass over the cached model)', async () => {
    await projectOverview(fx.storage, {});
    const t = performance.now();
    await projectOverview(fx.storage, {});
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
