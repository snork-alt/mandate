/**
 * Every integrity rule of the registry (INTEGRITY_RULES) has a positive test (it fires on a bad state) and a negative
 * test (it stays silent on the good state next to it). ERROR rules that the generic pre-commit gate guards (scope
 * element / global) are also shown to be rejected by the gate when a write would introduce them.
 */
import { describe, expect, it } from 'vitest';
import { INTEGRITY_RULES, workOrderDocSchema, type StoredWorkOrderDoc } from '@mandate/shared';
import { checkIntegrity, IntegrityService, IntegrityViolationError, withElement, type IntegrityKind } from '../../src/storage/integrity.js';
import type { Model } from '../../src/storage/model.js';
import { audit, baseModel, C, comp, finding, issuesOf, patch, S, SHA, spec, std, T, wo, type Opts } from './fixtures.js';

type State = { m: Model; opts?: Opts };
interface Case {
  rule: string;
  good: () => State;
  bad: () => State;
  /** The write that turns `good` into `bad` (ERROR rules guarded by the gate). */
  write?: () => [Exclude<IntegrityKind, 'audits'>, unknown];
}

const sections = (m: Model, specId: string) => m.specs.find((s) => s.id === specId)!.sections;
const woDoc = (id: string, specId: string, secs: string[], extra: Record<string, unknown> = {}): StoredWorkOrderDoc =>
  workOrderDocSchema.parse({
    id,
    title: id,
    spec: specId,
    specCommit: SHA,
    kind: 'implement',
    status: 'pending',
    reason: [],
    createdAt: '2026-11-12T00:00:00Z',
    updatedAt: '2026-11-12T00:00:00Z',
    sections: secs.map((s) => ({ id: s, title: s, type: 'wo-section', target: S(specId, s), status: 'pending', body: '' })),
    ...extra,
  }) as StoredWorkOrderDoc;
/** The good model with one element written (the state the gate would commit). */
const written = (c: Case): State => {
  const [kind, el] = c.write!();
  return { m: withElement(c.good().m, kind, el) };
};
const good = (): State => ({ m: baseModel() });
const withSpec = (m: Model, s: ReturnType<typeof spec>) => ({ ...m, specs: [...m.specs.filter((x) => x.id !== s.id), s] });
const withStd = (m: Model, s: ReturnType<typeof std>) => ({ ...m, standards: [...m.standards.filter((x) => x.id !== s.id), s] });
const withComp = (m: Model, c: ReturnType<typeof comp>) => ({ ...m, components: [...(m.components ?? []).filter((x) => x.id !== c.id), c] });

const CASES: Case[] = [
  {
    rule: 'dangling_link',
    good,
    bad: () => written(CASES.find((c) => c.rule === 'dangling_link')!),
    write: () => ['specs', spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'other' ? { ...s, links: [{ to: S('missing', 'x'), rel: 'relates_to' }] } : s)))],
  },
  {
    rule: 'dangling_reference',
    good,
    bad: () => written(CASES.find((c) => c.rule === 'dangling_reference')!),
    write: () => ['components', comp('child', [], { parent: 'missing', kind: 'external' })],
  },
  {
    rule: 'invalid_link',
    good,
    bad: () => written(CASES.find((c) => c.rule === 'invalid_link')!),
    write: () => ['specs', spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'flow' ? { ...s, links: [...s.links, ...s.links] } : s)))],
  },
  {
    rule: 'archived_parent',
    good: () => ({ m: withComp(withComp(baseModel(), comp('old', [], { kind: 'external', status: 'archived' })), comp('child', [], { parent: 'old', kind: 'external', status: 'archived' })) }),
    bad: () => written(CASES.find((c) => c.rule === 'archived_parent')!),
    write: () => ['components', comp('child', [], { parent: 'old', kind: 'external' })],
  },
  {
    rule: 'short_sha',
    good: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app').map((s) => ({ ...s, implementedCommit: SHA })))) }),
    bad: () => written(CASES.find((c) => c.rule === 'short_sha')!),
    write: () => ['specs', spec('app', sections(baseModel(), 'app').map((s) => ({ ...s, implementedCommit: 'abc1234' })))],
  },
  {
    rule: 'claim_on_closed',
    good: () => ({ m: { ...baseModel(), workOrders: [wo('q-0001', 'app', ['flow'], { status: 'done' })] } }),
    bad: () => written(CASES.find((c) => c.rule === 'claim_on_closed')!),
    write: () => ['work-orders', woDoc('q-0001', 'app', ['flow'], { status: 'done', claim: { agent: 'a', startedAt: '2026-11-12T00:00:00Z' } })],
  },
  {
    rule: 'depends_on_cycle',
    good: () => ({ m: withSpec(baseModel(), spec('b', [{ id: 'x', title: 'X', body: 'x', links: [{ to: S('app', 'flow'), rel: 'depends_on' }] }])) }),
    bad: () => written(CASES.find((c) => c.rule === 'depends_on_cycle')!),
    write: () => ['specs', spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'flow' ? { ...s, links: [...s.links, { to: S('b', 'x'), rel: 'depends_on' }] } : s)))],
  },
  {
    rule: 'component_cycle',
    good: () => ({ m: withComp(baseModel(), comp('ext', [{ id: 'api', title: 'API', body: 'a', links: [{ to: C('svc'), rel: 'depends_on' }] }], { kind: 'external' })) }),
    bad: () => written(CASES.find((c) => c.rule === 'component_cycle')!),
    write: () => ['components', comp('svc', [{ id: 'resp', title: 'R', body: 'r', links: [{ to: T('std'), rel: 'follows' }, { to: C('ext'), rel: 'depends_on' }] }], { owns: [{ repo: 'app', paths: ['src/**'] }] })],
  },
  {
    rule: 'contains_cycle',
    good: () => ({ m: withComp(baseModel(), comp('ext', [{ id: 'api', title: 'API', body: 'a' }], { kind: 'external', parent: 'svc' })) }),
    bad: () => written(CASES.find((c) => c.rule === 'contains_cycle')!),
    write: () => ['components', comp('svc', [{ id: 'resp', title: 'R', body: 'r', links: [{ to: T('std'), rel: 'follows' }] }], { owns: [{ repo: 'app', paths: ['src/**'] }], parent: 'ext' })],
  },
  {
    rule: 'extends_cycle',
    good: () => ({ m: withStd(baseModel(), std('ext-std', [{ id: 'x', title: 'X', body: 'x', links: [{ to: T('std', 'rules'), rel: 'extends' }] }])) }),
    bad: () => written(CASES.find((c) => c.rule === 'extends_cycle')!),
    write: () => ['standards', std('std', [...baseModel().standards[0]!.sections.map((s) => (s.id === 'rules' ? { ...s, links: [{ to: T('ext-std', 'x'), rel: 'extends' as const }] } : s))])],
  },
  {
    rule: 'supersedes_cycle',
    good: () => ({ m: withSpec(baseModel(), spec('b', [{ id: 'x', title: 'X', body: 'x', links: [{ to: S('app', 'other'), rel: 'supersedes' }] }])) }),
    bad: () => written(CASES.find((c) => c.rule === 'supersedes_cycle')!),
    write: () => ['specs', spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'other' ? { ...s, links: [{ to: S('b', 'x'), rel: 'supersedes' }] } : s)))],
  },
  {
    rule: 'supersedes_successors',
    good: () => ({ m: withSpec(baseModel(), spec('b', [{ id: 'x', title: 'X', body: 'x', links: [{ to: S('app', 'other'), rel: 'supersedes' }] }])) }),
    bad: () => written(CASES.find((c) => c.rule === 'supersedes_successors')!),
    write: () => ['specs', spec('c', [{ id: 'y', title: 'Y', body: 'y', links: [{ to: S('app', 'other'), rel: 'supersedes' }] }])],
  },
  {
    rule: 'duplicate_open_work_order',
    good: () => ({ m: { ...baseModel(), workOrders: [wo('q-0001', 'app', ['flow']), wo('q-0002', 'app', ['flow'], { kind: 'review' })] } }),
    bad: () => written(CASES.find((c) => c.rule === 'duplicate_open_work_order')!),
    write: () => ['work-orders', woDoc('q-0002', 'app', ['flow'], { kind: 'update' })],
  },
  {
    rule: 'feedback_tampered',
    good: () => ({ m: baseModel(), opts: { feedbackWarnings: new Map([['fb-0001', ['Missing author']]]) } }),
    bad: () => ({ m: baseModel(), opts: { feedbackWarnings: new Map([['fb-0001', ['Tampered: closed item edited after it was closed']]]) } }),
  },
  {
    rule: 'component_unreferenced',
    good,
    bad: () => ({ m: withComp(baseModel(), comp('lonely', [], { kind: 'external' })) }),
  },
  {
    rule: 'component_no_standards',
    // External components need no standards (Fable data-fix issue 5): `ext` follows none and is not reported.
    good,
    bad: () => {
      const m = baseModel();
      return { m: { ...withStd(m, std('std', m.standards[0]!.sections.map((s) => (s.id === 'r1' ? { ...s, scope: { paths: ['lib/**'] } } : s)))), components: patch(m.components!, 'svc', (c) => ({ ...c, sections: c.sections.map((s) => ({ ...s, links: [] })) })) } };
    },
  },
  {
    rule: 'component_no_code',
    good,
    bad: () => ({ m: { ...baseModel(), components: patch(baseModel().components!, 'svc', (c) => ({ ...c, owns: [] })) } }),
  },
  {
    rule: 'unowned_code_ref',
    good,
    bad: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'other' ? { ...s, refs: [{ repo: 'api', path: 'src/x.ts' }] } : s)))) }),
  },
  {
    rule: 'owns_matches_nothing',
    good,
    bad: () => ({ m: { ...baseModel(), components: patch(baseModel().components!, 'svc', (c) => ({ ...c, owns: [{ repo: 'app', paths: ['src/**', 'lib/**'] }] })) } }),
  },
  {
    rule: 'spec_ready_without_criteria',
    // Good: the spec is still a draft with an uncovered section; the write moves it to ready.
    good: () => ({ m: withSpec(baseModel(), spec('app', [...sections(baseModel(), 'app'), { id: 'bare', title: 'Bare', body: 'b' }], { status: 'draft' })) }),
    bad: () => ({ ...written(CASES.find((c) => c.rule === 'spec_ready_without_criteria')!), opts: { readyTransitions: new Set(['app']) } }),
    write: () => ['specs', spec('app', [...sections(baseModel(), 'app'), { id: 'bare', title: 'Bare', body: 'b' }], { status: 'ready' })],
  },
  {
    rule: 'spec_section_without_criteria',
    good,
    bad: () => ({ m: withSpec(baseModel(), spec('app', [...sections(baseModel(), 'app'), { id: 'bare', title: 'Bare', body: 'b' }])) }),
  },
  {
    rule: 'self_approved_override',
    good: () => ({ m: { ...baseModel(), feedback: [{ id: 'fb-0001', targets: [S('app', 'flow')], kind: 'question', body: 'b', status: 'accepted', relatedTo: [], createdAt: 'x', updatedAt: 'x', acceptedBy: 'alice' }] as never } }),
    bad: () => ({ m: { ...baseModel(), feedback: [{ id: 'fb-0001', targets: [S('app', 'flow')], kind: 'question', body: 'b', status: 'accepted', relatedTo: [], createdAt: 'x', updatedAt: 'x', acceptedBy: 'alice', approvalOverride: { by: 'alice', reason: 'sole user', at: 'x' } }] as never } }),
  },
  {
    rule: 'spec_done_without_criteria',
    good: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app'), { status: 'done' })) }),
    bad: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app').map((s) => (s.id === 'ac-flow' ? { ...s, archived: true } : s)), { status: 'done' })) }),
  },
  {
    rule: 'standard_successor_loop',
    // Good: the successor supersedes the old standard (the right direction).
    good: () => ({ m: withStd(withStd(baseModel(), std('old', [{ id: 'rules', title: 'Rules', body: 'r' }], { status: 'deprecated', supersededBy: 'std' })), std('std', baseModel().standards[0]!.sections.map((s) => (s.id === 'rules' ? { ...s, links: [{ to: T('old', 'rules'), rel: 'supersedes' as const }] } : s)))) }),
    bad: () => written(CASES.find((c) => c.rule === 'standard_successor_loop')!),
    write: () => ['standards', std('old', [{ id: 'rules', title: 'Rules', body: 'r', links: [{ to: T('std', 'rules'), rel: 'extends' }] }], { status: 'deprecated', supersededBy: 'std' })],
  },
  {
    rule: 'external_follows_internal',
    // Good: an external component may follow a vendor rule that is reviewed, not checked against our code.
    good: () => ({ m: withComp(withStd(baseModel(), std('vendor', [{ id: 'v1', title: 'V1', type: 'rule', level: 'should', rationale: 'r', check: { kind: 'review' }, body: 'v' }])), comp('ext', [{ id: 'api', title: 'API', body: 'a', links: [{ to: T('vendor', 'v1'), rel: 'follows' }] }], { kind: 'external' })) }),
    bad: () => ({ m: withComp(baseModel(), comp('ext', [{ id: 'api', title: 'API', body: 'a', links: [{ to: T('std', 'r1'), rel: 'follows' }] }], { kind: 'external' })) }),
  },
  {
    rule: 'audit_pass_contradicted',
    good: () => ({ m: baseModel(), opts: { audits: [audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'pass' }, { id: 'r1', kind: 'rule', ref: T('std', 'r1'), result: 'fail', findings: [finding('f1', ['app:src/other.ts#L1-L5'], { severity: 'critical' })] }])] } }),
    bad: () => ({ m: baseModel(), opts: { audits: [audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'pass', findings: [finding('f1', [], { severity: 'major' })] }])] } }),
  },
  {
    rule: 'fix_misses_finding_code',
    good: () => ({ m: { ...baseModel(), workOrders: [wo('q-0001', 'app', ['flow'], { kind: 'fix', findings: ['mandate://audits/au/findings/f1'] })] }, opts: { audits: [audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'fail', findings: [finding('f1', ['app:src/flow.ts#L71-L76'])] }])] } }),
    bad: () => ({ m: { ...baseModel(), workOrders: [wo('q-0001', 'app', ['other'], { kind: 'fix', findings: ['mandate://audits/au/findings/f1'] })] }, opts: { audits: [audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'fail', findings: [finding('f1', ['app:src/flow.ts#L71-L76'])] }])] } }),
  },
  {
    rule: 'done_spec_drift',
    good: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app'), { status: 'done' })), opts: { drift: new Map() } }),
    bad: () => ({ m: withSpec(baseModel(), spec('app', sections(baseModel(), 'app'), { status: 'done' })), opts: { drift: new Map([['app', ['1 criteria added since done: R1']]]) } }),
  },
];

describe('integrity rules: one positive and one negative test per registry rule', () => {
  it('the clean base model has no issue at all', () => {
    expect(checkIntegrity(baseModel()).map((i) => `${i.rule} ${i.uri}: ${i.message}`)).toEqual([]);
  });

  it('every rule of INTEGRITY_RULES has a case (and no case names an unknown rule)', () => {
    expect(CASES.map((c) => c.rule).sort()).toEqual(INTEGRITY_RULES.map((r) => r.rule).sort());
  });

  for (const c of CASES) {
    it(`${c.rule}: fires on the bad state`, () => {
      const { m, opts } = c.bad();
      const found = issuesOf(m, c.rule, opts);
      expect(found.length, c.rule).toBeGreaterThan(0);
      const def = INTEGRITY_RULES.find((r) => r.rule === c.rule)!;
      for (const i of found) {
        expect(i.severity).toBe(def.severity);
        expect(i.hint).toBeTruthy();
      }
    });
    it(`${c.rule}: silent on the good state`, () => {
      const { m, opts } = c.good();
      expect(issuesOf(m, c.rule, opts).map((i) => i.message)).toEqual([]);
    });
  }

  const gated = INTEGRITY_RULES.filter((r) => r.severity === 'error' && r.scope !== 'full');
  it('every gated ERROR rule (scope element / global) has a write fixture for the gate', () => {
    for (const r of gated) expect(CASES.find((c) => c.rule === r.rule)?.write, r.rule).toBeDefined();
  });
  for (const r of gated) {
    it(`${r.rule}: the pre-commit gate rejects a write that introduces it`, async () => {
      const c = CASES.find((x) => x.rule === r.rule)!;
      const [kind, el] = c.write!();
      const svc = new IntegrityService({ head: async () => null, resolveCommit: async () => null } as never, async () => c.good().m, { list: async () => [] } as never);
      const err = await svc
        .hook<{ id: string }>(kind)
        .check(el as { id: string }, undefined)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrityViolationError);
      expect((err as IntegrityViolationError).issues.map((i) => i.rule)).toContain(r.rule);
    });
  }
});
