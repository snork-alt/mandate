/** Spec maturity (see @mandate/shared maturity.ts): the ladder step plus overlays, from data the services already derive. */
import {
  buildRef,
  MATURITY_LABELS,
  MATURITY_STEPS,
  OPEN_WORK_ORDER_STATUSES,
  OVERLAY_TONE,
  STEP_TONE,
  type CriterionState,
  type LastAudit,
  type MaturityOverlay,
  type MaturityStep,
  type SpecMaturity,
  type SpecVerification,
  type StoredSpec,
  type WorkOrder,
} from '@mandate/shared';
import { isCriterion } from './model.js';
import type { Storage } from './index.js';
import { deriveSpecs } from './insights.js';

export interface MaturityInput {
  spec: StoredSpec;
  verification: SpecVerification;
  workOrders: WorkOrder[];
  lastAudit: LastAudit | null;
  /** Section ids blocked by a depends_on target that is not implemented. */
  blockedSections: string[];
  /** Drift reasons (done specs whose gate no longer holds). */
  drift: string[];
}

const CHANGING = new Set(['implement', 'update', 'fix']);

export function specMaturity(i: MaturityInput): SpecMaturity {
  const { spec } = i;
  const live = spec.sections.filter((s) => !s.archived && !isCriterion(s));
  const mine = i.workOrders.filter((w) => w.spec === spec.id && CHANGING.has(w.kind));
  const doneByWo = new Set(mine.flatMap((w) => w.sections.filter((s) => s.status === 'done').map((s) => s.id)));
  const claimed = new Set(mine.filter((w) => w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status)).flatMap((w) => w.sections.filter((s) => s.status === 'pending').map((s) => s.id)));
  // Done specs passed the gate: every section counts as implemented.
  const implemented = live.filter((s) => spec.status === 'done' || !!s.implementedCommit || doneByWo.has(s.id)).length;
  const inProgress = live.filter((s) => claimed.has(s.id)).length;
  const sections = { implemented, total: live.length, inProgress };

  const all: CriterionState[] = [...i.verification.own, ...i.verification.inherited.flatMap((g) => g.criteria)];
  const gating = all.filter((c) => (c.level ?? 'must') === 'must' && !c.upcoming);
  const criteria = {
    total: gating.length,
    verified: gating.filter((c) => c.state === 'verified' || c.state === 'waived').length,
    waived: gating.filter((c) => c.state === 'waived').length,
    failing: gating.filter((c) => c.state === 'failing').length,
    stale: gating.filter((c) => c.state === 'stale' || c.state === 'unknown').length,
    unverified: gating.filter((c) => c.state === 'unverified').length,
  };

  let step: MaturityStep;
  if (spec.status === 'draft') step = 'draft';
  else if (sections.total > 0 && implemented === 0 && inProgress === 0 && spec.status !== 'done') step = 'specified';
  else if (implemented < sections.total && spec.status !== 'done') step = 'in_progress';
  else step = 'implemented';

  const overlays: MaturityOverlay[] = [];
  const specUri = buildRef({ kind: 'specs', id: spec.id });
  if (spec.status === 'archived') overlays.push({ kind: 'archived', reason: 'The spec is archived (no longer in force).', refs: [specUri] });
  const failing = gating.filter((c) => c.state === 'failing');
  if (failing.length) overlays.push({ kind: 'failing', reason: `${failing.length} must criteri${failing.length === 1 ? 'on' : 'a'} failing (${failing.map((c) => c.title).join(', ')}).`, refs: failing.map((c) => c.uri) });
  if (i.drift.length) overlays.push({ kind: 'drifted', reason: `Done, but the gate no longer holds: ${i.drift.join('; ')}.`, refs: [specUri] });
  if (i.blockedSections.length) overlays.push({ kind: 'blocked', reason: `${i.blockedSections.length} section(s) depend on work that is not implemented: ${i.blockedSections.join(', ')}.`, refs: i.blockedSections.map((s) => buildRef({ kind: 'specs', id: spec.id, sectionId: s })) });
  const staleCrit = gating.filter((c) => c.state === 'stale' || c.state === 'unknown');
  if (staleCrit.length) overlays.push({ kind: 'stale', reason: `${staleCrit.length} verification${staleCrit.length === 1 ? ' is' : 's are'} stale (${staleCrit.map((c) => c.title).join(', ')}).`, refs: staleCrit.map((c) => c.uri) });

  const label = step === 'in_progress' ? `${MATURITY_LABELS[step]} · ${implemented}/${sections.total}` : MATURITY_LABELS[step];
  return {
    step,
    stepIndex: MATURITY_STEPS.indexOf(step) + 1,
    label,
    tone: overlays[0] ? OVERLAY_TONE[overlays[0].kind] : STEP_TONE[step],
    sections,
    criteria,
    audit: i.lastAudit,
    overlays,
    storedStatus: spec.status,
  };
}

/** Maturity of many specs at once (list views): one snapshot, verification, drift, blocked sections and last audits. */
export async function maturities(storage: Storage, specs: StoredSpec[]): Promise<Record<string, SpecMaturity>> {
  const m = await storage.model();
  const recs = await storage.verificationService.list();
  const blocked = await storage.linkService.blockedSections(specs);
  const derived = await deriveSpecs(specs, m, storage.verificationService, recs);
  const audits = await storage.auditService.lastAudits(specs.map((s) => s.id), m);
  const out: Record<string, SpecMaturity> = {};
  for (const spec of specs) {
    out[spec.id] = specMaturity({
      spec,
      verification: await storage.verificationService.forSpec(spec, recs, m),
      workOrders: m.workOrders ?? [],
      lastAudit: audits[spec.id] ?? null,
      blockedSections: blocked[spec.id] ?? [],
      drift: derived[spec.id]?.drift ?? [],
    });
  }
  return out;
}
