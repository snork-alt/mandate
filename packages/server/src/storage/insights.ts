import { isClaimStale, OPEN_WORK_ORDER_STATUSES, type SpecDerived, type SpecStatus, type StoredSpec, type VerificationRecord } from '@mandate/shared';
import { derivedDependsOn, dependencyState, finder, specCriteria, approval, type Model } from './model.js';
import { driftReasons, type VerificationService } from './verification.js';

/** Shown status: `in_progress` is derived from a claimed open work order (archived stays archived). */
export function derivedStatus(spec: Pick<StoredSpec, 'id' | 'status'>, m: Pick<Model, 'workOrders'>): SpecStatus {
  if (spec.status === 'archived') return 'archived';
  const claimed = (m.workOrders ?? []).some((w) => w.spec === spec.id && w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status));
  return claimed ? 'in_progress' : spec.status;
}

/** Derived facts of specs: shown status, derived dependsOn / standards, claims via work orders, drift, broken sections. */
export async function deriveSpecs(specs: StoredSpec[], m: Model, verification: VerificationService, records?: VerificationRecord[]): Promise<Record<string, SpecDerived & { status: SpecStatus; storedStatus: StoredSpec['status'] }>> {
  const f = finder(m);
  const recs = records ?? (await verification.list());
  const out: Record<string, SpecDerived & { status: SpecStatus; storedStatus: StoredSpec['status'] }> = {};
  for (const spec of specs) {
    const crit = specCriteria(spec, m);
    const claims = (m.workOrders ?? [])
      .filter((w) => w.spec === spec.id && w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status))
      .map((w) => ({ workOrder: w.id, kind: w.kind, sections: w.sections.filter((s) => s.status === 'pending').map((s) => s.id), claim: w.claim! }));
    const warnings: string[] = [];
    const v = spec.status === 'done' ? await verification.forSpec(spec, recs, m) : null;
    if (v && v.total === 0) warnings.push('Done with zero acceptance criteria.');
    for (const e of spec.exemptFrom ?? []) {
      const st = approval({ feedback: e.feedback, by: e.by }, m);
      if (!st.effective) warnings.push(`Exemption from ${e.standard} is not in effect (${st.reason?.replace('_', ' ')}).`);
    }
    for (const c of claims) if (isClaimStale(c.claim)) warnings.push(`Stale claim by ${c.claim.agent} on ${c.workOrder}.`);
    for (const x of crit.standards) {
      const std = m.standards.find((s) => s.id === x.id);
      if (std?.status === 'deprecated' && !x.exempt) warnings.push(`Follows deprecated standard ${std.title}${std.supersededBy ? `; use ${std.supersededBy} instead` : ''}.`);
    }
    const vv = v ?? (await verification.forSpec(spec, recs, m));
    const should = [...vv.own, ...vv.inherited.flatMap((g) => g.criteria)].filter((c) => c.level === 'should' && !c.upcoming && c.state !== 'verified' && c.state !== 'waived');
    if (should.length) warnings.push(`${should.length} should-level rule(s) not verified: ${should.map((c) => c.title).join(', ')}.`);
    out[spec.id] = {
      status: derivedStatus(spec, m),
      storedStatus: spec.status,
      dependsOn: derivedDependsOn(spec),
      standards: crit.standards,
      claims,
      ...(await (async () => {
        const d = await verification.driftDetail(spec, m, recs);
        return { drift: driftReasons(d), ...(d ? { driftDetail: d } : {}) };
      })()),
      brokenSections: spec.sections.filter((s) => !s.archived && s.links.some((l) => l.rel === 'depends_on' && dependencyState(l.to, f) === 'broken')).map((s) => s.id),
      warnings,
    };
  }
  return out;
}

export { IntegrityService } from './integrity.js';
