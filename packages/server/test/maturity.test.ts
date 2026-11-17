/** Spec maturity: each ladder step, overlay precedence, waived / stale criteria, the audit interaction, archived sections. */
import type { CriterionState, LastAudit, SpecVerification, StoredSpec, WorkOrder } from '@mandate/shared';
import { describe, expect, it } from 'vitest';
import { specMaturity, type MaturityInput } from '../src/storage/maturity.js';

const sec = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: '', ...extra });
const spec = (status: StoredSpec['status'], sections = [sec('a'), sec('b'), sec('ac-1', { type: 'acceptance', method: 'test' })]): StoredSpec =>
  ({ id: 's', title: 'S', status, tags: [], sections }) as unknown as StoredSpec;
const crit = (state: CriterionState['state'], extra: Partial<CriterionState> = {}): CriterionState => ({ uri: `mandate://specs/s/sections/ac-${state}`, sectionId: 'ac', title: `c-${state}`, state, history: [], level: 'must', ...extra });
const ver = (own: CriterionState[], inherited: CriterionState[] = []): SpecVerification => ({ own, inherited: inherited.length ? [{ standard: 'mandate://standards/x', title: 'X', criteria: inherited }] : [], total: 0, verified: 0, failing: 0, stale: 0 });
const wo = (sections: { id: string; status: 'pending' | 'done' }[], extra: Partial<WorkOrder> = {}): WorkOrder =>
  ({ id: 'wo-1', spec: 's', specCommit: 'a'.repeat(40), kind: 'implement', status: 'pending', sections, reason: [], createdAt: '', updatedAt: '', ...extra }) as WorkOrder;
const audit = (o: Partial<LastAudit> = {}): LastAudit => ({ id: 'au', uri: 'mandate://audits/au', at: '2026-11-12', auditor: { agent: 'x' }, result: 'pass', openFindings: 0, openMust: 0, openShould: 0, stale: false, commitsSince: 0, ...o });
const run = (o: Partial<MaturityInput>) => specMaturity({ spec: spec('ready'), verification: ver([crit('unverified')]), workOrders: [], lastAudit: null, blockedSections: [], drift: [], ...o });

describe('maturity ladder', () => {
  it('draft, specified, in progress (done work-order sections or claims), implemented', () => {
    expect(run({ spec: spec('draft') }).step).toBe('draft');
    const sp = run({});
    expect(sp).toMatchObject({ step: 'specified', stepIndex: 2, label: 'Specified', tone: 'neutral', sections: { implemented: 0, total: 2 } });
    const ip = run({ workOrders: [wo([{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }])] });
    expect(ip).toMatchObject({ step: 'in_progress', label: 'In progress · 1/2', tone: 'lilac' });
    const claimed = run({ workOrders: [wo([{ id: 'a', status: 'pending' }], { status: 'in_progress', claim: { agent: 'x', startedAt: '', heartbeatAt: '' } as never })] });
    expect(claimed).toMatchObject({ step: 'in_progress', label: 'In progress · 0/2', sections: { inProgress: 1 } });
    const impl = run({ spec: spec('ready', [sec('a', { implementedCommit: 'a'.repeat(40) }), sec('b', { implementedCommit: 'b'.repeat(40) })]) });
    expect(impl).toMatchObject({ step: 'implemented', tone: 'blue' });
  });

  it('archived sections are excluded; a review work order does not count', () => {
    const s = spec('ready', [sec('a', { implementedCommit: 'a'.repeat(40) }), sec('old', { archived: true })]);
    expect(run({ spec: s }).sections).toEqual({ implemented: 1, total: 1, inProgress: 0 });
    expect(run({ workOrders: [wo([{ id: 'a', status: 'done' }], { kind: 'review' })] }).step).toBe('specified');
  });

  it('there is no verified step: a done spec is implemented, criteria only drive the counts and the stale overlay', () => {
    const done = spec('done');
    expect(run({ spec: done, verification: ver([crit('verified')], [crit('waived'), crit('unverified', { level: 'should' }), crit('unverified', { upcoming: true })]) })).toMatchObject({ step: 'implemented', tone: 'blue', criteria: { total: 2, verified: 2, waived: 1 } });
    const stale = run({ spec: done, verification: ver([crit('verified'), crit('stale')]) });
    expect(stale).toMatchObject({ step: 'implemented', tone: 'orange', criteria: { stale: 1 } });
    expect(stale.overlays.map((o) => o.kind)).toEqual(['outdated']);
    expect(run({ spec: done, verification: ver([]) }).step).toBe('implemented');
  });

  it('there is no audited step: the audit does not change the step or the overlays', () => {
    const base = { spec: spec('done'), verification: ver([crit('verified')]) };
    expect(run({ ...base, lastAudit: audit() })).toMatchObject({ step: 'implemented', stepIndex: 4, tone: 'blue' });
    const st = run({ ...base, lastAudit: audit({ stale: true, commitsSince: 4, openMust: 1, result: 'fail' }) });
    expect(st.step).toBe('implemented');
    expect(st.overlays).toEqual([]);
  });

  it('overlay precedence: archived > failing > outdated > blocked; stale tests, drift and the audit are not separate overlays', () => {
    const m = run({
      spec: spec('archived'),
      verification: ver([crit('failing'), crit('stale')]),
      lastAudit: audit({ openMust: 2, result: 'fail', stale: true }),
      blockedSections: ['a'],
      drift: ['1 criteria changed since done'],
    });
    expect(m.overlays.map((o) => o.kind)).toEqual(['archived', 'failing', 'outdated', 'blocked'])
    expect(m.overlays[2]!.reason).toMatch(/out of date.*done gate no longer holds/);
    expect(m.audit).toMatchObject({ openMust: 2 });
    expect(m.tone).toBe('grey');
    const f = run({ spec: spec('done'), verification: ver([crit('failing')]), blockedSections: ['a'] });
    expect(f).toMatchObject({ step: 'implemented', tone: 'red' });
    expect(f.overlays.map((o) => o.kind)).toEqual(['failing', 'blocked']);
    const o = run({ spec: spec('done'), verification: ver([crit('verified')]), changes: { outdated: ['a'], upstream: ['b'] } });
    expect(o.overlays[0]).toMatchObject({ kind: 'outdated', refs: [expect.stringContaining('sections/a'), expect.stringContaining('sections/b')] });
    expect(f.overlays[0]!.reason).toMatch(/1 must criterion failing/);
    expect(run({ blockedSections: ['b'] })).toMatchObject({ step: 'specified', tone: 'orange' });
  });
});
