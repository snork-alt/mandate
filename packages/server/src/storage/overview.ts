/**
 * Project overview (MCP `project_overview`, the web UI's landing page): one pass over the cached model. Maturity is the
 * user-facing state (computed exactly as the spec list does); recent changes come from the activity feed.
 */
import {
  buildRef,
  allSectionsFinished,
  isClaimStale,
  MATURITY_STEPS,
  OPEN_WORK_ORDER_STATUSES,
  planProgress,
  stepsOf,
  stepsPlanProgress,
  WO_PLAN,
  type OverviewCompleted,
  type OverviewSession,
  type MaturityStep,
  type OverviewBlocked,
  type OverviewBlocker,
  type OverviewOverlay,
  type OverviewSpec,
  type OverviewWorkOrder,
  type ProjectOverview,
  type ProjectOverviewInput,
  type SpecMaturity,
  type StoredSpec,
  type WorkOrder,
  type LastAudit,
  type OverviewMustFinding,
} from '@mandate/shared';
import { parseLinkTarget } from '@mandate/doc';
import { projectOverviewInputSchema } from '@mandate/shared';
import { specMaturity } from './maturity.js';
import { dependencyState, finder, type Model } from './model.js';
import { deriveSpecs } from './insights.js';
import type { Storage } from './index.js';

const OVERLAYS: OverviewOverlay[] = ['failing', 'drifted', 'blocked', 'stale'];
const RANK: Record<string, number> = { failing: 0, drifted: 1, blocked: 2, stale: 3 };

export interface OverviewDeps {
  /** Cause coverage of content edits (needs the index); omitted → null. */
  lineage?: () => { contentEdits: number; contentEditsWithCause: number } | null;
  now?: number;
}

/** The latest audit's open must findings of each listed spec (title, description, checklist item, code). */
async function withMustFindings(storage: Storage, m: Model, list: ProjectOverview['mustFindingSpecs'], audits: Record<string, LastAudit | null>): Promise<ProjectOverview['mustFindingSpecs']> {
  return Promise.all(
    list.map(async (row) => {
      const last = audits[row.id];
      if (!last) return row;
      try {
        const stored = await storage.auditService.stored(last.id);
        const view = await storage.auditService.view(stored, m, { staleness: false });
        const findings: OverviewMustFinding[] = view.items
          .flatMap((i) => i.findings.map((f) => ({ f, i })))
          .filter(({ f }) => f.status === 'open' && f.level === 'must')
          .map(({ f, i }) => ({ uri: f.uri, title: f.title, description: f.description, ref: f.ref, ...(i.sections?.length ? { sections: i.sections } : {}), codeRefs: f.codeRefs }));
        return { ...row, auditTitle: stored.title, auditor: view.auditor, auditAt: view.completedAt ?? view.startedAt, findings };
      } catch {
        return row;
      }
    }),
  );
}

export async function projectOverview(storage: Storage, input: ProjectOverviewInput = {}, deps: OverviewDeps = {}): Promise<ProjectOverview> {
  const { limit } = projectOverviewInputSchema.parse(input);
  const now = deps.now ?? Date.now();
  const m = await storage.model();
  const specs = m.specs;
  const workOrders: WorkOrder[] = await storage.workOrderService.list(); // effective heartbeats
  const recs = await storage.verificationService.list();
  const blockedSections = await storage.linkService.blockedSections(specs);
  const derived = await deriveSpecs(specs, m, storage.verificationService, recs);
  const audits = await storage.auditService.lastAudits(specs.map((s) => s.id), m);
  const integrity = await storage.integrity.current();
  const f = finder(m);
  const specTitle = new Map(specs.map((s) => [s.id, s.title]));

  /* ---- maturity, attention, coverage (one pass over specs) */
  const steps = Object.fromEntries(MATURITY_STEPS.map((s) => [s, 0])) as Record<MaturityStep, number>;
  const overlays = Object.fromEntries(OVERLAYS.map((o) => [o, 0])) as Record<OverviewOverlay, number>;
  const criteria = { total: 0, verified: 0, waived: 0, failing: 0, stale: 0, unverified: 0 };
  const sections = { implemented: 0, total: 0 };
  const auditCov = { total: 0, never: 0, stale: 0, recent: 0 };
  const attentionSpecs: (OverviewSpec & { rank: number })[] = [];
  const mustSpecs: ProjectOverview['mustFindingSpecs'] = [];
  const cats = new Map<string, ProjectOverview['byCategory'][number]>();
  const neverAudited: ProjectOverview['neverAudited'] = [];
  const unverified: ProjectOverview['unverified'] = [];
  const gaps: (ProjectOverview['gaps'][number] & { score: number })[] = [];
  let archived = 0;
  let mustFindings = 0;
  const maturity = new Map<string, SpecMaturity>();
  for (const spec of specs) {
    const verification = await storage.verificationService.forSpec(spec, recs, m);
    const mat = specMaturity({ spec, verification, workOrders, lastAudit: audits[spec.id] ?? null, blockedSections: blockedSections[spec.id] ?? [], drift: derived[spec.id]?.drift ?? [] });
    maturity.set(spec.id, mat);
    if (spec.status === 'archived') {
      archived++;
      continue;
    }
    steps[mat.step]++;
    const ov = mat.overlays.filter((o) => o.kind !== 'archived');
    for (const o of ov) overlays[o.kind as OverviewOverlay]++;
    if (ov[0]) attentionSpecs.push({ id: spec.id, title: spec.title, step: mat.step, label: mat.label, overlay: ov[0].kind as OverviewOverlay, reason: ov[0].reason, rank: RANK[ov[0].kind] ?? 9 });
    mustFindings += mat.audit?.openMust ?? 0;
    if (mat.audit?.openMust) mustSpecs.push({ id: spec.id, title: spec.title, audit: mat.audit.uri, openMust: mat.audit.openMust });
    const cat = spec.category || 'uncategorized';
    const c = cats.get(cat) ?? { category: cat, total: 0, steps: Object.fromEntries(MATURITY_STEPS.map((x) => [x, 0])) as Record<MaturityStep, number>, specs: [] };
    c.specs.push({ id: spec.id, title: spec.title, step: mat.step });
    c.total++;
    c.steps[mat.step]++;
    cats.set(cat, c);
    if (spec.status !== 'draft') {
      for (const k of Object.keys(criteria) as (keyof typeof criteria)[]) criteria[k] += mat.criteria[k];
      {
        const a = audits[spec.id];
        const cr = mat.criteria;
        const score = cr.failing * 4 + cr.stale * 2 + cr.unverified + (!a ? 3 : a.stale ? 1 : 0);
        if (score > 0) gaps.push({ id: spec.id, title: spec.title, criteria: { ...cr }, audit: a ? { at: a.at, stale: a.stale } : null, score });
      }
      if (mat.criteria.unverified + mat.criteria.stale > 0) unverified.push({ id: spec.id, title: spec.title, unverified: mat.criteria.unverified, stale: mat.criteria.stale, total: mat.criteria.total });
      sections.implemented += mat.sections.implemented;
      sections.total += mat.sections.total;
      auditCov.total++;
      const a = audits[spec.id];
      if (!a) {
        auditCov.never++;
        neverAudited.push({ id: spec.id, title: spec.title });
      }
      else if (a.stale) auditCov.stale++;
      else auditCov.recent++;
    }
  }
  attentionSpecs.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));

  /* ---- work orders */
  const open = workOrders.filter((w) => OPEN_WORK_ORDER_STATUSES.includes(w.status));
  const openByTarget = new Map<string, WorkOrder>();
  for (const w of open) for (const s of w.sections) if (s.status === 'pending') openByTarget.set(buildRef({ kind: 'specs', id: w.spec, sectionId: s.id }), w);
  const view = (w: WorkOrder): OverviewWorkOrder => ({
    id: w.id,
    title: w.title || `${w.kind} · ${specTitle.get(w.spec) ?? w.spec}`,
    spec: w.spec,
    specTitle: specTitle.get(w.spec) ?? null,
    kind: w.kind,
    status: w.status,
    ...(w.priority ? { priority: w.priority } : {}),
    sections: { done: w.sections.filter((s) => s.status !== 'pending').length, total: w.sections.length },
    ...(w.claim ? { claim: { agent: w.claim.agent, ...(w.claim.branch ? { branch: w.claim.branch } : {}), startedAt: w.claim.startedAt, heartbeatAt: w.claim.heartbeatAt, stale: !allSectionsFinished(w.sections) && isClaimStale(w.claim, now) } } : {}),
    git: w.git ?? [],
    hasPlan: !!w.hasPlan,
    updatedAt: w.updatedAt,
  });
  const active = open.filter((w) => w.claim || w.status === 'in_progress').map(view);
  active.sort((a, b) => Number(!!a.claim?.stale) - Number(!!b.claim?.stale) || (b.claim?.heartbeatAt ?? b.updatedAt).localeCompare(a.claim?.heartbeatAt ?? a.updatedAt));
  const staleClaims = active.filter((w) => w.claim?.stale).length;
  // Plan steps of the shown work orders (their plan sections; a handful of cached documents).
  for (const v of active.slice(0, limit)) {
    if (!v.hasPlan) continue;
    const d = await storage.workOrderService.doc(v.id).catch(() => null);
    const body = d?.sections.find((x) => x.id === WO_PLAN)?.body ?? '';
    const p = (d ? stepsPlanProgress(stepsOf(d, body)) : null) ?? planProgress(body);
    if (p) v.plan = p;
  }
  const progressSpecs = [...new Set(active.map((w) => w.spec))].map((id) => ({ id, title: specTitle.get(id) ?? id, maturity: maturity.get(id) })).filter((x): x is { id: string; title: string; maturity: SpecMaturity } => !!x.maturity);

  /* ---- agent sessions (claims overlapping the last 24 hours) and recently completed work orders */
  const DAY = 86_400_000;
  const since = new Date(now - DAY).toISOString();
  const sessions: OverviewSession[] = [];
  for (const w of workOrders) {
    const base = { workOrder: w.id, kind: w.kind, title: view(w).title };
    for (const c of w.claims ?? []) if (c.endedAt >= since) sessions.push({ ...base, agent: c.agent, startedAt: c.startedAt, endedAt: c.endedAt, ended: c.ended });
    if (w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status) && w.claim.heartbeatAt >= since) sessions.push({ ...base, agent: w.claim.agent, startedAt: w.claim.startedAt, heartbeatAt: w.claim.heartbeatAt, stale: !allSectionsFinished(w.sections) && isClaimStale(w.claim, now) });
  }
  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const recentlyCompleted: OverviewCompleted[] = workOrders
    .filter((w) => w.status === 'done' && w.completedAt && w.completedAt >= weekAgo)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    .slice(0, limit)
    .map((w) => {
      const last = (w.claims ?? []).filter((c) => c.endedAt <= w.completedAt!).at(-1);
      return { id: w.id, title: view(w).title, kind: w.kind, spec: w.spec, specTitle: specTitle.get(w.spec) ?? null, ...(last ? { agent: last.agent, startedAt: last.startedAt } : {}), completedAt: w.completedAt! };
    });

  /* ---- blocked: spec sections with an unimplemented depends_on target; open work orders on them or after unfinished ones */
  const blockerOf = (to: string): OverviewBlocker | null => {
    const st = dependencyState(to, f);
    if (st === 'ok') return null;
    const t = f.target(to);
    const t2 = parseLinkTarget(to);
    const wo = openByTarget.get(t2?.sectionId ? buildRef({ kind: 'specs', id: t2.id, sectionId: t2.sectionId }) : to);
    return {
      uri: to,
      state: st === 'blocked' ? 'not_implemented' : 'broken',
      title: t?.section?.title ?? t?.doc?.title ?? to,
      ...(t ? { docId: t.id, docTitle: t.doc?.title ?? null } : {}),
      ...(wo ? { workOrder: { id: wo.id, status: wo.status, ...(wo.claim ? { agent: wo.claim.agent } : {}) } } : {}),
    };
  };
  const blocked: OverviewBlocked[] = [];
  const sectionBlockers = new Map<string, OverviewBlocker[]>();
  for (const spec of specs as StoredSpec[]) {
    if (spec.status === 'archived') continue;
    for (const sid of blockedSections[spec.id] ?? []) {
      const sec = spec.sections.find((s) => s.id === sid);
      if (!sec) continue;
      const by = sec.links.filter((l) => l.rel === 'depends_on').map((l) => blockerOf(l.to)).filter((b): b is OverviewBlocker => !!b && b.state === 'not_implemented');
      const uri = buildRef({ kind: 'specs', id: spec.id, sectionId: sid });
      sectionBlockers.set(uri, by);
      blocked.push({ kind: 'section', uri, id: spec.id, title: sec.title, specId: spec.id, specTitle: spec.title, blockedBy: by });
    }
  }
  const byId = new Map(workOrders.map((w) => [w.id, w]));
  for (const w of open) {
    const by: OverviewBlocker[] = [];
    for (const s of w.sections) if (s.status === 'pending') by.push(...(sectionBlockers.get(buildRef({ kind: 'specs', id: w.spec, sectionId: s.id })) ?? []));
    for (const d of w.dependencies ?? []) {
      const dep = byId.get(d);
      if (dep && (dep.status === 'done' || dep.status === 'cancelled')) continue;
      by.push({ uri: buildRef({ kind: 'work-orders', id: d }), state: 'work_order', title: dep?.title || d, ...(dep ? { docId: dep.spec, docTitle: specTitle.get(dep.spec) ?? null, workOrder: { id: dep.id, status: dep.status, ...(dep.claim ? { agent: dep.claim.agent } : {}) } } : {}) });
    }
    if (by.length) blocked.push({ kind: 'work_order', uri: buildRef({ kind: 'work-orders', id: w.id }), id: w.id, title: view(w).title, specId: w.spec, specTitle: specTitle.get(w.spec) ?? null, blockedBy: [...new Map(by.map((b) => [b.uri, b])).values()] });
  }
  // Work orders first (they are what agents wait on), then sections.
  blocked.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'work_order' ? -1 : 1));

  const errorCount = integrity.issues.filter((i) => (i.severity ?? 'warning') === 'error').length;
  const snoozed = await storage.integritySnoozes.active(now);
  const warnings = integrity.issues.filter((i) => (i.severity ?? 'warning') !== 'error');
  const liveWarnings = warnings.filter((i) => !snoozed.has(`${i.rule}|${i.uri}`));

  let lineage: ProjectOverview['coverage']['lineage'] = null;
  try {
    const l = deps.lineage?.();
    if (l) lineage = { contentEdits: l.contentEdits, withCause: l.contentEditsWithCause, ratio: l.contentEdits ? l.contentEditsWithCause / l.contentEdits : null };
  } catch {
    lineage = null;
  }

  return {
    head: (await storage.git.head().catch(() => null)) ?? null,
    at: new Date(now).toISOString(),
    maturity: { total: specs.length - archived, archived, steps, overlays },
    attention: {
      ...overlays,
      mustFindings,
      staleClaims,
      failedWorkOrders: workOrders.filter((w) => w.status === 'failed').length,
      integrityErrors: errorCount,
      integrityWarnings: liveWarnings.length,
      integritySnoozed: warnings.length - liveWarnings.length,
      specs: attentionSpecs.slice(0, limit).map(({ rank: _r, ...s }) => s),
    },
    inProgress: active.slice(0, limit),
    inProgressTotal: active.length,
    progressSpecs,
    sessions,
    recentlyCompleted,
    queued: open.filter((w) => !w.claim && w.status === 'pending').length,
    blocked: blocked.slice(0, limit),
    blockedTotal: blocked.length,
    mustFindingSpecs: await withMustFindings(storage, m, mustSpecs.sort((a, b) => b.openMust - a.openMust).slice(0, limit), audits),
    byCategory: [...cats.values()].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    neverAudited: neverAudited.sort((a, b) => a.title.localeCompare(b.title)).slice(0, limit),
    unverified: unverified.sort((a, b) => b.unverified + b.stale - (a.unverified + a.stale)).slice(0, limit),
    gaps: gaps.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).map(({ score: _s, ...g }) => g),
    warningGroups: [...liveWarnings.reduce((m, i) => m.set(i.rule, [...(m.get(i.rule) ?? []), { uri: i.uri, message: i.message }]), new Map<string, { uri: string; message: string }[]>())]
      .map(([rule, items]) => ({ rule, count: items.length, items: items.slice(0, 50) }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    warnings: liveWarnings.slice(0, limit).map((i) => ({ rule: i.rule, uri: i.uri, message: i.message, ...(i.hint ? { hint: i.hint } : {}) })),
    coverage: { criteria, sections, audits: auditCov, lineage },
  };
}
