import { isClaimStale, OPEN_WORK_ORDER_STATUSES, type IntegrityIssue, type IntegrityReport, type SpecDerived, type SpecStatus, type StoredSpec, type VerificationRecord } from '@mandate/shared';
import { checkLinks } from '@mandate/doc';
import type { GitStore } from '../git/GitStore.js';
import type { FeedbackService } from './feedback.js';
import { coverage } from './components.js';
import { isFullSha } from './ids.js';
import { derivedDependsOn, dependencyState, finder, graphProblems, openChangingOrders, sectionUri, specCriteria, approval, type Model } from './model.js';
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

/**
 * Repo lint (I7): the domain rules that only hold per write, re-checked over the whole repository after
 * pulls / merges and on startup. Violations are reported, never auto-fixed; derived states tolerate them.
 */
export class IntegrityService {
  private report?: IntegrityReport;

  constructor(
    private readonly git: GitStore,
    private readonly model: () => Promise<Model>,
    private readonly feedback: FeedbackService,
  ) {}

  async run(): Promise<IntegrityReport> {
    const head = await this.git.resolveCommit('HEAD').catch(() => null);
    const m = await this.model();
    const f = finder(m);
    const issues: IntegrityIssue[] = graphProblems(m).map((p) => ({ rule: p.rule, uri: p.uri, message: p.message }));
    for (const [kind, list] of [['specs', m.specs], ['standards', m.standards]] as const) {
      for (const d of list) {
        for (const p of checkLinks(kind, d.id, d.sections)) issues.push({ rule: 'invalid_link', uri: `mandate://${kind}/${d.id}`, message: p });
        if ('implementedCommit' in d && d.implementedCommit && !isFullSha(d.implementedCommit)) issues.push({ rule: 'short_sha', uri: `mandate://${kind}/${d.id}`, message: `implementedCommit ${d.implementedCommit} is not a full sha` });
        for (const s of d.sections) {
          const uri = sectionUri(kind, d.id, s.id);
          if (s.implementedCommit && !isFullSha(s.implementedCommit)) issues.push({ rule: 'short_sha', uri, message: `implementedCommit ${s.implementedCommit} is not a full sha` });
          for (const l of s.links) {
            const t = f.target(l.to);
            if (!t?.doc || (t.sectionId && !t.section)) issues.push({ rule: 'dangling_link', uri, message: `${l.rel} ${l.to}: target does not exist` });
          }
        }
      }
    }
    for (const [key, orders] of openChangingOrders(m.workOrders ?? [])) {
      if (orders.length > 1) issues.push({ rule: 'duplicate_open_work_order', uri: `mandate://specs/${key.split('/')[0]}/sections/${key.split('/')[1]}`, message: `${orders.length} open implement/update work orders: ${orders.map((o) => o.id).join(', ')}` });
    }
    for (const w of m.workOrders ?? []) {
      const uri = `mandate://work-orders/${w.id}`;
      if (!isFullSha(w.specCommit)) issues.push({ rule: 'short_sha', uri, message: `specCommit ${w.specCommit} is not a full sha` });
      if (w.claim && !OPEN_WORK_ORDER_STATUSES.includes(w.status)) issues.push({ rule: 'claim_on_closed', uri, message: `${w.status} work order still carries a claim` });
    }
    // Coverage: code refs no component owns, owns globs that match no known code ref.
    const cov = coverage(m);
    for (const r of cov.unowned) issues.push({ rule: 'unowned_code_ref', uri: r.uri, message: `${r.repo}:${r.path} is not owned by any component` });
    for (const g of cov.emptyGlobs) issues.push({ rule: 'owns_matches_nothing', uri: `mandate://components/${g.component}`, message: `${g.component} owns ${g.repo}:${g.glob}, which matches no referenced code` });
    for (const fb of await this.feedback.list()) {
      for (const w of fb.warnings) if (w.startsWith('Tampered')) issues.push({ rule: 'feedback_tampered', uri: `mandate://feedback/${fb.id}`, message: w });
    }
    this.report = { head, at: new Date().toISOString(), issues };
    return this.report;
  }

  /** The last report, re-run when HEAD moved. */
  async current(): Promise<IntegrityReport> {
    const head = await this.git.resolveCommit('HEAD').catch(() => null);
    return this.report && this.report.head === head ? this.report : this.run();
  }
}
