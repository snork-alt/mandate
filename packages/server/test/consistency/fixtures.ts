/**
 * In-memory models for the data-consistency suite: a clean base (no integrity issue at all) and builders for the bad
 * states the Fable data review found. Pure data: `checkIntegrity` runs on them without a repository.
 */
import { auditSchema, componentSchema, specSchema, standardSchema, workOrderSchema, type StoredAudit, type StoredComponent, type StoredSpec, type StoredStandard, type WorkOrder } from '@mandate/shared';
import { checkIntegrity } from '../../src/storage/integrity.js';
import type { Model } from '../../src/storage/model.js';

export const SHA = 'a'.repeat(40);
export const S = (id: string, sid?: string) => `mandate://specs/${id}${sid ? `/sections/${sid}` : ''}`;
export const T = (id: string, sid?: string) => `mandate://standards/${id}${sid ? `/sections/${sid}` : ''}`;
export const C = (id: string, sid?: string) => `mandate://components/${id}${sid ? `/sections/${sid}` : ''}`;

type In = Record<string, unknown>;
export const spec = (id: string, sections: In[], extra: In = {}): StoredSpec => specSchema.parse({ id, title: id, status: 'ready', sections, ...extra });
export const std = (id: string, sections: In[], extra: In = {}): StoredStandard => standardSchema.parse({ id, title: id, sections, ...extra });
export const comp = (id: string, sections: In[], extra: In = {}): StoredComponent => componentSchema.parse({ id, title: id, kind: 'service', sections, ...extra });
export const wo = (id: string, specId: string, sections: string[], extra: In = {}): WorkOrder =>
  workOrderSchema.parse({ id, spec: specId, specCommit: SHA, kind: 'implement', status: 'pending', sections: sections.map((s) => ({ id: s, status: 'pending' })), createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z', ...extra });
export const audit = (id: string, target: string, items: In[], extra: In = {}): StoredAudit =>
  auditSchema.parse({ id, title: id, target, commit: SHA, auditor: { agent: 'audit-agent' }, status: 'completed', startedAt: '2026-11-12T00:00:00Z', sections: items.map((i) => ({ type: 'audit-item', kind: 'criterion', level: 'must', title: String(i.id), ...i })), ...extra });
export const finding = (id: string, codeRefs: string[], extra: In = {}) => ({ id, title: `finding ${id}`, severity: 'major', classification: 'code_deviates', description: 'wrong', codeRefs, ...extra });

/**
 * The clean base: spec `app` (a done-able shape: an implemented section with code, an acceptance criterion verifying
 * it), standard `std` with a code rule, component `svc` owning the code and following the standard, external `ext`.
 */
export function base(): Model {
  return {
    specs: [
      spec('app', [
        { id: 'flow', title: 'Flow', body: 'f', refs: [{ repo: 'app', path: 'src/flow.ts', lines: '1-80' }], verifiedBy: ['ac-flow'], links: [{ to: C('svc'), rel: 'affects' }] },
        { id: 'other', title: 'Other', body: 'o', refs: [{ repo: 'app', path: 'src/other.ts' }], links: [{ to: T('std', 'r1'), rel: 'follows' }] },
        { id: 'ac-flow', title: 'Flow works', type: 'acceptance', method: 'test', body: 'ok' },
      ]),
    ],
    standards: [std('std', [{ id: 'rules', title: 'Rules', body: 'r', verifiedBy: ['r1'] }, { id: 'r1', title: 'R1', type: 'rule', level: 'must', rationale: 'why', scope: { paths: ['src/**'] }, body: 'r1' }])],
    components: [
      comp('svc', [{ id: 'resp', title: 'R', body: 'r', links: [{ to: T('std'), rel: 'follows' }] }], { owns: [{ repo: 'app', paths: ['src/**'] }] }),
      comp('ext', [{ id: 'api', title: 'API', body: 'a' }], { kind: 'external' }),
    ],
    workOrders: [],
    feedback: [],
  };
}
// `ext` is external: it needs no code and no standards, but must be affected by a spec.
export function baseModel(): Model {
  const m = base();
  m.specs[0]!.sections[1]!.links.push({ to: C('ext'), rel: 'affects' });
  return m;
}

export type Opts = Parameters<typeof checkIntegrity>[1];
/** Issues of one rule. */
export const issuesOf = (m: Model, rule: string, opts: Opts = {}) => checkIntegrity(m, opts).filter((i) => i.rule === rule);
/** Every issue as `rule uri: message`. */
export const allIssues = (m: Model, opts: Opts = {}) => checkIntegrity(m, opts).map((i) => `${i.rule} ${i.uri}: ${i.message}`);

/** Replace one element of a list by id. */
export function patch<T extends { id: string }>(list: T[], id: string, fn: (x: T) => T): T[] {
  return list.map((x) => (x.id === id ? fn(structuredClone(x)) : x));
}
