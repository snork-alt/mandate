/**
 * Audits: written reports (`audits/<id>.md`) by a coding agent on whether the code conforms to a spec (its acceptance
 * criteria plus every applicable rule) or to a standard (its rules). Mandate never reads the code: it computes the
 * checklist (`plan`), stores the report, validates the write rules and derives state (outcome, staleness, links).
 *
 * Write rules (inside the write lock): while `in_progress` items can be added or edited; `completed` / `abandoned`
 * reports are frozen except finding `resolution` and `rechecks` (409 `audit_frozen`); audits are never deleted.
 */
import {
  AUDIT_TRANSITIONS,
  FINDING_TRANSITIONS,
  type Audit,
  type AuditCode,
  type AuditFinding,
  type AuditItem,
  type AuditItemResult,
  type AuditLevel,
  type AuditOutcome,
  type AuditOverview,
  type AuditPlan,
  type AuditPlanItem,
  type AuditProgress,
  type AuditStaleness,
  type AuditSummary,
  type ComponentAuditStatus,
  type FindingInput,
  type FindingStatus,
  type LastAudit,
  type LevelCounts,
  type Section,
  type SpecAudits,
  type StandardAudits,
  type StoredAudit,
  type StoredFeedback,
  type StoredSpec,
  type StoredStandard,
  type WorkOrder,
  AUDIT_LEVELS,
  buildCodeRef,
  buildFindingRef,
  buildRef,
  findingInputSchema,
  findingSeverity,
  nextFindingId,
  OPEN_WORK_ORDER_STATUSES,
  parseAuditCodeRef,
  parseNodeUri,
  parseRef,
  standardUsage,
} from '@mandate/shared';
import type { AuditFindingMeta } from '@mandate/doc';
import type { GitStore } from '../git/GitStore.js';
import { specCodec, standardCodec } from './codecs.js';
import { ConflictError, NotFoundError, type CommitMeta, type WriteContext } from './GitBackedRepository.js';
import { criterionHash } from './ids.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import type { Mutex } from './Mutex.js';
import { isCriterion, levelOf, sectionUri, specComponents, standardInForce, type Model } from './model.js';
import type { VerificationService } from './verification.js';
import type { WorkOrderService } from './work-orders.js';

/** Structured audit errors (`audit_incomplete`, `audit_frozen`, `audit_not_in_progress`, ...). */
export class AuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: { kind: string; [k: string]: unknown },
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
const invalid = (msg: string) => new AuditError('validation', msg, undefined, 400);

type Item = Section & { type: 'audit-item' };
const isItem = (s: Section): s is Item => s.type === 'audit-item';
const OVERVIEW = 'overview';
const LEVEL_ORDER: Record<AuditLevel, number> = { must: 0, should: 1, may: 2 };
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, info: 3 } as const;

/** Drop empty arrays / undefined so the stored YAML stays canonical (the doc format prunes them). */
function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out as T;
}
const cleanFinding = (f: AuditFindingMeta): AuditFindingMeta => clean({ ...f, ...(f.resolution ? { resolution: clean(f.resolution) } : {}), ...(f.rechecks ? { rechecks: f.rechecks.map((r) => clean(r)) } : {}) }) as AuditFindingMeta;
const cleanSection = (s: Section): Section => clean({ ...s, ...(s.findings ? { findings: s.findings.map(cleanFinding) } : {}) }) as Section;

/** A copy of the report without the parts that may change after completion (resolution, re-checks, counts). */
function frozenView(a: StoredAudit): string {
  const { counts: _c, ...rest } = a;
  return JSON.stringify({
    ...rest,
    sections: a.sections.map(({ itemRechecks: _i, ...s }) => ({ ...s, findings: s.findings?.map(({ resolution: _r, rechecks: _k, ...f }) => f) })),
  });
}

function emptyCounts(): Record<AuditLevel, LevelCounts> {
  const z = (): LevelCounts => ({ pass: 0, fail: 0, partial: 0, n_a: 0, pending: 0 });
  return { must: z(), should: z(), may: z() };
}

const findingStatus = (f: AuditFindingMeta): FindingStatus => f.resolution?.status ?? 'open';
const itemFailing = (s: Item) => (s.result === 'fail' || s.result === 'partial') && (!(s.findings ?? []).length || (s.findings ?? []).some((f) => findingStatus(f) === 'open'));

/** Item counts per level and finding counts per status (stored as `counts` in the frontmatter). */
export function auditCounts(a: Pick<StoredAudit, 'sections'>) {
  const counts = emptyCounts();
  const findings = { open: 0, resolved: 0, wont_fix: 0 };
  for (const s of a.sections.filter(isItem)) {
    counts[s.level ?? 'must'][(s.result ?? 'pending') as AuditItemResult | 'pending']++;
    for (const f of s.findings ?? []) findings[findingStatus(f)]++;
  }
  return { ...counts, findings };
}

/** pass / warn (should) / fail (must): failing items without a resolution of all their findings, or open findings. */
export function auditOutcome(a: Pick<StoredAudit, 'status' | 'sections'>): AuditOutcome {
  if (a.status === 'in_progress' || a.status === 'requested') return 'in_progress';
  if (a.status === 'abandoned') return 'abandoned';
  const items = a.sections.filter(isItem);
  const bad = (lvl: AuditLevel) => items.some((s) => s.level === lvl && (itemFailing(s) || (s.findings ?? []).some((f) => findingStatus(f) === 'open')));
  return bad('must') ? 'fail' : bad('should') ? 'warn' : 'pass';
}

export interface AuditDeps {
  specs: MarkdownDirRepository<StoredSpec>;
  standards: MarkdownDirRepository<StoredStandard>;
  git: GitStore;
  verification: VerificationService;
  workOrders: WorkOrderService;
  model: () => Promise<Model>;
  /** The project's write lock (multi-document writes hold it across their repository writes; it is re-entrant). */
  lock?: Mutex;
}

export class AuditService {
  private atCommit = new Map<string, StoredSpec | StoredStandard | null | undefined>();
  private chainCache = new Map<string, Set<string>>();
  private fileCommits: { head: string | null; map: Map<string, Set<string>> } | null = null;

  constructor(
    readonly repo: MarkdownDirRepository<StoredAudit>,
    private readonly deps: AuditDeps,
  ) {}

  /* ---------------------------------------------------------------- write rules (storage hook) */

  /** Inside the write lock: structure, status transitions, the freeze after completion; stamps `counts`. */
  async beforeWrite(next: StoredAudit, current: StoredAudit | undefined, _ctx: WriteContext): Promise<StoredAudit> {
    const target = parseRef(next.target);
    if (!target || (target.kind !== 'specs' && target.kind !== 'standards')) throw invalid('target must be a spec or standard');
    if (!next.sections.some((s) => s.id === OVERVIEW && s.type === 'markdown')) throw invalid(`an audit needs an "${OVERVIEW}" markdown section`);
    const bad = next.sections.find((s) => s.type !== 'markdown' && s.type !== 'audit-item');
    if (bad) throw invalid(`audit sections are markdown or audit-item; "${bad.id}" is ${bad.type}`);
    const refs = next.sections.filter(isItem).map((s) => s.ref);
    const dupRef = refs.find((r, i) => refs.indexOf(r) !== i);
    if (dupRef) throw invalid(`${dupRef} is listed twice`);
    const fids = next.sections.flatMap((s) => (s.findings ?? []).map((f) => f.id));
    const dupF = fids.find((f, i) => fids.indexOf(f) !== i);
    if (dupF) throw invalid(`finding id ${dupF} is used twice`);
    if (current) {
      if (current.target !== next.target || current.commit !== next.commit || current.startedAt !== next.startedAt) throw new AuditError('audit_frozen', 'target, commit and startedAt of an audit never change');
      if (current.status !== next.status && !AUDIT_TRANSITIONS[current.status].includes(next.status)) throw new AuditError('audit_frozen', `audit ${next.id}: ${current.status} -> ${next.status} is not allowed (start a new audit to re-audit)`);
      if (current.status === 'completed' || current.status === 'abandoned') {
        if (frozenView({ ...next }) !== frozenView({ ...current })) {
          throw new AuditError('audit_frozen', `audit ${next.id} is ${current.status}: only finding resolutions and re-checks can change (start a new audit to re-audit)`);
        }
      } else if (next.status === 'in_progress' && (next.completedAt || next.abandonedAt)) throw invalid('an audit in progress has no completedAt / abandonedAt');
      // Findings, once recorded and linked, are never dropped silently (links point at them).
      for (const s of current.sections.filter(isItem)) {
        for (const f of s.findings ?? []) {
          if (!f.resolution?.workOrder && !f.resolution?.feedback) continue;
          if (!next.sections.some((x) => (x.findings ?? []).some((g) => g.id === f.id))) throw new AuditError('audit_frozen', `finding ${f.id} is linked to a work order / feedback and cannot be removed`);
        }
      }
    } else if (next.status !== 'in_progress' && next.status !== 'requested') throw invalid('audits start requested or in_progress');
    return { ...next, sections: next.sections.map(cleanSection), counts: auditCounts(next) };
  }

  /* ---------------------------------------------------------------- reads */

  async list(): Promise<StoredAudit[]> {
    return this.repo.list();
  }

  async stored(id: string): Promise<StoredAudit> {
    return this.repo.get(id);
  }

  /** Spec or standard behind a target reference. */
  private async targetDoc(target: string, m?: Model): Promise<{ kind: 'spec' | 'standard'; spec?: StoredSpec; std?: StoredStandard; uri: string }> {
    const r = parseRef(target);
    if (!r || (r.kind !== 'specs' && r.kind !== 'standards')) throw invalid('target must be mandate://specs/<id> or mandate://standards/<id>');
    const uri = buildRef({ kind: r.kind, id: r.id });
    if (r.kind === 'specs') {
      const spec = m ? m.specs.find((s) => s.id === r.id) : await this.deps.specs.get(r.id).catch(() => undefined);
      if (!spec) throw new NotFoundError(`spec '${r.id}' not found`);
      return { kind: 'spec', spec, uri };
    }
    const std = m ? m.standards.find((s) => s.id === r.id) : await this.deps.standards.get(r.id).catch(() => undefined);
    if (!std) throw new NotFoundError(`standard '${r.id}' not found`);
    return { kind: 'standard', std, uri };
  }

  /** The checklist of a target (criteria + applicable rules), the code to inspect, prior open findings, the last audit. */
  async plan(target: string, model?: Model): Promise<AuditPlan> {
    const m = model ?? (await this.deps.model());
    const core = await this.planCore(target, m);
    const audits = (await this.list()).filter((a) => a.target === core.target);
    const views = await Promise.all(audits.map((a) => this.view(a, m, { staleness: false })));
    const completed = views.filter((a) => a.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    const prog = views.find((a) => a.status === 'in_progress' || a.status === 'requested');
    const last = completed[0] ? { ...completed[0], staleness: await this.staleness(audits.find((a) => a.id === completed[0]!.id)!, m) } : null;
    return {
      ...core,
      commit: await this.deps.git.resolveCommit('HEAD'),
      priorOpenFindings: completed.flatMap((a) => a.items.flatMap((i) => i.findings.filter((f) => f.status === 'open'))),
      lastAudit: last ? this.summaryOf(last) : null,
      inProgress: prog ? this.summaryOf(prog) : null,
    };
  }

  /** The checklist and the code to inspect (no audit state). */
  private async planCore(target: string, m: Model): Promise<Pick<AuditPlan, 'target' | 'targetKind' | 'title' | 'items' | 'code' | 'specs'>> {
    const t = await this.targetDoc(target, m);
    const items: AuditPlanItem[] = [];
    const code: AuditPlan['code'] = { refs: [], components: [], globs: [], languages: [] };
    const sectionOf = (uri: string): Section | undefined => {
      const r = parseRef(uri);
      const doc = r?.kind === 'specs' ? m.specs.find((s) => s.id === r.id) : m.standards.find((s) => s.id === r?.id);
      return doc?.sections.find((s) => s.id === r?.sectionId);
    };
    const ruleGlobs = (sec: Section | undefined, ref: string) => {
      for (const g of sec?.scope?.paths ?? []) code.globs.push({ glob: g, source: ref });
      for (const l of sec?.scope?.languages ?? []) if (!code.languages.includes(l)) code.languages.push(l);
    };
    let specs: AuditPlan['specs'];
    if (t.spec) {
      const spec = t.spec;
      const v = await this.deps.verification.forSpec(spec, undefined, m);
      for (const c of v.own) {
        const sec = sectionOf(c.uri);
        items.push({ ref: c.uri, kind: 'criterion', level: 'must', title: c.title, body: sec?.body, method: c.method, verification: c.state, required: true });
      }
      for (const g of v.inherited) {
        for (const c of g.criteria) {
          if (c.upcoming) continue;
          const sec = sectionOf(c.uri);
          const level = (c.level ?? 'should') as AuditLevel;
          items.push({
            ref: c.uri,
            kind: sec?.type === 'rule' ? 'rule' : 'criterion',
            level,
            title: c.title,
            body: sec?.body,
            standard: g.standard,
            method: c.method,
            ...(sec?.check ? { check: sec.check } : {}),
            ...(sec?.rationale ? { rationale: sec.rationale } : {}),
            sections: c.sections ?? [],
            ...(c.path ? { path: c.path } : {}),
            verification: c.state,
            required: level === 'must',
          });
          ruleGlobs(sec, c.uri);
        }
      }
      for (const s of spec.sections) {
        if (s.archived) continue;
        for (const r of s.refs) code.refs.push({ repo: r.repo, path: r.path, ...(r.lines ? { lines: r.lines } : {}), uri: buildCodeRef(r), section: s.id });
      }
      for (const c of specComponents(spec, m)) {
        const comp = (m.components ?? []).find((x) => x.id === c.id);
        if (!comp) continue;
        for (const o of comp.owns) code.components.push({ id: comp.id, title: comp.title, repo: o.repo, paths: o.paths, via: c.via });
      }
    } else {
      const std = t.std!;
      for (const s of std.sections) {
        if (s.archived || !isCriterion(s)) continue;
        const ref = sectionUri('standards', std.id, s.id);
        const level = levelOf(s);
        items.push({ ref, kind: s.type === 'rule' ? 'rule' : 'criterion', level, title: s.title, body: s.body, standard: buildRef({ kind: 'standards', id: std.id }), method: s.method, ...(s.check ? { check: s.check } : {}), ...(s.rationale ? { rationale: s.rationale } : {}), required: level === 'must' && standardInForce(std) });
        ruleGlobs(s, ref);
      }
      const using = standardUsage(std, m.specs.filter((s) => s.status !== 'archived'));
      specs = using.map((u) => ({ id: u.specId, title: u.title, status: u.status }));
      for (const u of using) {
        const spec = m.specs.find((s) => s.id === u.specId)!;
        for (const s of spec.sections) if (!s.archived) for (const r of s.refs) code.refs.push({ repo: r.repo, path: r.path, ...(r.lines ? { lines: r.lines } : {}), uri: buildCodeRef(r), section: s.id, spec: spec.id });
      }
      for (const a of std.appliesTo ?? []) {
        const [k, v] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)];
        if (k === 'path') code.globs.push({ glob: v, source: `appliesTo ${a}` });
        else if (k === 'lang' && !code.languages.includes(v)) code.languages.push(v);
        else if (k === 'component' || k === 'componentKind') {
          for (const comp of (m.components ?? []).filter((c) => c.status !== 'archived' && (k === 'component' ? c.id === v : c.kind === v))) {
            for (const o of comp.owns) code.components.push({ id: comp.id, title: comp.title, repo: o.repo, paths: o.paths, via: [`appliesTo ${a}`] });
          }
        }
      }
    }
    items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    return { target: t.uri, targetKind: t.kind, title: (t.spec ?? t.std)!.title, items, code, ...(specs ? { specs } : {}) };
  }

  /* ---------------------------------------------------------------- derived view */

  private async docAt(kind: 'specs' | 'standards', id: string, commit: string): Promise<StoredSpec | StoredStandard | null | undefined> {
    const key = `${kind}/${id}@${commit}`;
    if (!this.atCommit.has(key)) {
      let doc: StoredSpec | StoredStandard | null | undefined;
      const raw = await this.deps.git.readFileAt(commit, `${kind}/${id}.md`).catch(() => undefined);
      if (raw === undefined) doc = undefined;
      else if (raw === null) doc = null;
      else {
        try {
          doc = kind === 'specs' ? specCodec.decode(raw, id) : standardCodec.decode(raw, id);
        } catch {
          doc = null;
        }
      }
      this.atCommit.set(key, doc);
    }
    return this.atCommit.get(key);
  }

  /** Commits since `commit` (first-parent chain from HEAD) that changed one of `files`. */
  private async commitsSince(commit: string, files: string[]): Promise<number> {
    const head = await this.deps.git.head();
    if (!head || head === commit) return 0;
    const key = `${head}:${commit}`;
    if (!this.chainCache.has(key)) {
      const { commits } = await this.deps.git.firstParentChain(commit);
      this.chainCache.set(key, new Set(commits));
    }
    if (this.fileCommits?.head !== head) {
      const hist = await this.deps.git.fileHistory(['specs', 'standards']);
      this.fileCommits = { head, map: new Map([...hist].map(([p, cs]) => [p, new Set(cs.map((c) => c.id))])) };
    }
    const chain = this.chainCache.get(key)!;
    const hits = new Set<string>();
    for (const f of files) for (const c of this.fileCommits.map.get(f) ?? []) if (chain.has(c)) hits.add(c);
    return hits.size;
  }

  /** Stale when the criteria / rules or the audited code changed after the audit's commit (as far as Mandate can tell). */
  async staleness(a: StoredAudit, m: Model): Promise<AuditStaleness> {
    const reasons: string[] = [];
    const items = a.sections.filter(isItem);
    const files = new Set<string>();
    const t = parseRef(a.target)!;
    files.add(`${t.kind}/${t.id}.md`);
    for (const s of items) {
      const r = parseRef(s.ref ?? '');
      if (!r?.sectionId) continue;
      files.add(`${r.kind}/${r.id}.md`);
      const doc = r.kind === 'specs' ? m.specs.find((x) => x.id === r.id) : m.standards.find((x) => x.id === r.id);
      const now = doc?.sections.find((x) => x.id === r.sectionId);
      if (!now || now.archived) reasons.push(`"${s.title}" no longer exists`);
      else if (s.hash && criterionHash(now) !== s.hash) reasons.push(`"${s.title}" changed since the audit`);
    }
    // Criteria / rules that apply now but were not checked.
    const plan = await this.planCore(a.target, m).catch(() => null);
    if (plan) {
      const had = new Set(items.map((s) => s.ref));
      const added = plan.items.filter((i) => !had.has(i.ref));
      if (added.length) reasons.push(`${added.length} ${added.length === 1 ? 'criterion / rule' : 'criteria / rules'} added since the audit: ${added.map((i) => i.title).join(', ')}`);
    }
    // The audited code, as Mandate sees it: code refs and implementation of the spec sections, completed work orders.
    const since = a.completedAt ?? a.startedAt;
    const specIds = t.kind === 'specs' ? [t.id] : (plan?.specs ?? []).map((s) => s.id);
    if (t.kind === 'specs') {
      const then = (await this.docAt('specs', t.id, a.commit)) as StoredSpec | null | undefined;
      const now = m.specs.find((s) => s.id === t.id);
      if (then && now) {
        for (const s of now.sections) {
          const was = then.sections.find((x) => x.id === s.id);
          if (s.archived) continue;
          if (!was && s.refs.length) reasons.push(`section "${s.title}" (with code refs) added since the audit`);
          else if (was && JSON.stringify(was.refs) !== JSON.stringify(s.refs)) reasons.push(`code refs of "${s.title}" changed since the audit`);
          else if (was && (was.implementedCommit ?? null) !== (s.implementedCommit ?? null)) reasons.push(`"${s.title}" was re-implemented since the audit`);
        }
      }
    }
    for (const w of m.workOrders ?? []) {
      if (!specIds.includes(w.spec) || w.status !== 'done' || w.updatedAt <= since) continue;
      if (w.kind === 'implement' || w.kind === 'update' || w.kind === 'fix') reasons.push(`${w.kind} work order ${w.id} on ${w.spec} completed since the audit`);
    }
    return { stale: reasons.length > 0, reasons: [...new Set(reasons)], commitsSince: await this.commitsSince(a.commit, [...files]) };
  }

  /** The derived view of an audit: items with findings (joined with fix work orders / feedback), counts, outcome, staleness. */
  async view(a: StoredAudit, m?: Model, opts: { staleness?: boolean } = {}): Promise<Audit> {
    const model = m ?? (await this.deps.model());
    const docUri = buildRef({ kind: 'audits', id: a.id });
    const wos = model.workOrders ?? [];
    const fbs = model.feedback ?? [];
    const t = parseRef(a.target)!;
    const targetDoc = t.kind === 'specs' ? model.specs.find((s) => s.id === t.id) : model.standards.find((s) => s.id === t.id);
    const items: AuditItem[] = a.sections.filter(isItem).map((s) => {
      const findings: AuditFinding[] = (s.findings ?? []).map((f) => {
        const uri = buildFindingRef({ audit: a.id, id: f.id });
        const wo = wos.find((w) => w.id === f.resolution?.workOrder) ?? wos.find((w) => (w.findings ?? []).includes(uri));
        const fb = fbs.find((x) => x.id === f.resolution?.feedback) ?? fbs.find((x) => x.fromFinding === uri);
        return {
          ...f,
          codeRefs: f.codeRefs ?? [],
          uri,
          audit: a.id,
          ref: s.ref!,
          section: s.id,
          itemTitle: s.title,
          kind: s.kind ?? 'criterion',
          level: s.level ?? 'must',
          status: findingStatus(f),
          resolution: { ...(f.resolution ?? { status: 'open' }), ...(wo ? { workOrder: wo.id, workOrderStatus: wo.status } : {}), ...(fb ? { feedback: fb.id, feedbackStatus: fb.status } : {}) },
          rechecks: f.rechecks ?? [],
        };
      });
      return {
        sectionId: s.id,
        uri: buildRef({ kind: 'audits', id: a.id, sectionId: s.id }),
        ref: s.ref!,
        kind: s.kind ?? 'criterion',
        level: s.level ?? 'must',
        title: s.title,
        ...(s.result && s.result !== 'pending' ? { result: s.result as AuditItemResult } : {}),
        ...(s.body ? { notes: s.body } : {}),
        findings,
      };
    });
    const c = auditCounts(a);
    const all = items.flatMap((i) => i.findings);
    const openAt = (l: AuditLevel) => all.filter((f) => f.status === 'open' && f.level === l).length;
    return {
      id: a.id,
      uri: docUri,
      target: a.target,
      targetKind: t.kind === 'specs' ? 'spec' : 'standard',
      ...(targetDoc ? { targetTitle: targetDoc.title } : {}),
      commit: a.commit,
      ...(a.code ? { code: a.code as AuditCode } : {}),
      auditor: a.auditor,
      startedAt: a.startedAt,
      ...(a.completedAt ? { completedAt: a.completedAt } : {}),
      ...(a.abandonedAt ? { abandonedAt: a.abandonedAt } : {}),
      status: a.status,
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.abandonReason ? { reason: a.abandonReason } : {}),
      ...(a.assignee ? { assignee: a.assignee } : {}),
      ...(a.requestedBy ? { requestedBy: a.requestedBy } : {}),
      ...(a.requestedAt ? { requestedAt: a.requestedAt } : {}),
      ...(a.trigger ? { trigger: a.trigger } : {}),
      progress: this.progressOf(a, targetDoc as StoredSpec | StoredStandard | undefined),
      items,
      counts: { must: c.must, should: c.should, may: c.may },
      findings: { ...c.findings, total: all.length, openMust: openAt('must'), openShould: openAt('should'), openMay: openAt('may') },
      outcome: auditOutcome(a),
      ...(opts.staleness === false ? {} : { staleness: await this.staleness(a, model) }),
    };
  }

  /** Items recorded / total, and (spec audits) the sections of the scope whose own items are all recorded. */
  private progressOf(a: StoredAudit, doc: StoredSpec | StoredStandard | undefined): AuditProgress {
    const items = a.sections.filter(isItem);
    const done = items.filter((s) => (s.result ?? 'pending') !== 'pending');
    const recorded = new Set(done.map((s) => s.ref));
    const out: AuditProgress = { items: { done: done.length, total: items.length }, sections: { done: 0, total: 0 } };
    const t = parseRef(a.target);
    if (t?.kind !== 'specs' || !doc) return out;
    const spec = doc as StoredSpec;
    for (const s of spec.sections) {
      if (s.archived || isCriterion(s)) continue;
      const mine = items.filter((i) => i.ref === sectionUri('specs', spec.id, s.id) || s.verifiedBy.some((v) => i.ref === sectionUri('specs', spec.id, v)) );
      if (!mine.length) continue;
      out.sections.total++;
      if (mine.every((i) => recorded.has(i.ref))) out.sections.done++;
    }
    return out;
  }

  summaryOf(a: Audit): AuditSummary {
    return {
      id: a.id,
      uri: a.uri,
      target: a.target,
      targetKind: a.targetKind,
      ...(a.targetTitle ? { targetTitle: a.targetTitle } : {}),
      status: a.status,
      at: a.completedAt ?? a.abandonedAt ?? a.startedAt,
      startedAt: a.startedAt,
      ...(a.completedAt ? { completedAt: a.completedAt } : {}),
      auditor: a.auditor,
      commit: a.commit,
      ...(a.code ? { code: a.code } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      outcome: a.outcome,
      counts: a.counts,
      findings: a.findings,
      ...(a.assignee ? { assignee: a.assignee } : {}),
      progress: a.progress,
      stale: a.staleness?.stale ?? false,
      staleReasons: a.staleness?.reasons ?? [],
      commitsSince: a.staleness?.commitsSince ?? 0,
    };
  }

  private lastOf(a: Audit): LastAudit {
    return {
      id: a.id,
      uri: a.uri,
      at: a.completedAt ?? a.startedAt,
      auditor: a.auditor,
      result: a.outcome,
      openFindings: a.findings.open,
      openMust: a.findings.openMust,
      openShould: a.findings.openShould,
      stale: a.staleness?.stale ?? false,
      commitsSince: a.staleness?.commitsSince ?? 0,
    };
  }

  /** Every audit as a derived view (newest first). */
  async views(m?: Model): Promise<Audit[]> {
    const model = m ?? (await this.deps.model());
    const out = await Promise.all((await this.list()).map((a) => this.view(a, model)));
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<{ audit: Audit; doc: StoredAudit }> {
    const doc = await this.repo.get(id);
    return { audit: await this.view(doc), doc };
  }

  async listSummaries(f: { target?: string; status?: string[]; stale?: boolean; limit?: number } = {}): Promise<{ audits: AuditSummary[]; total: number }> {
    const target = f.target ? (await this.targetDoc(f.target)).uri : undefined;
    let all = (await this.views()).map((a) => this.summaryOf(a));
    if (target) all = all.filter((a) => a.target === target);
    if (f.status?.length) all = all.filter((a) => f.status!.includes(a.status));
    if (f.stale !== undefined) all = all.filter((a) => a.stale === f.stale);
    return { audits: all.slice(0, f.limit ?? 50), total: all.length };
  }

  async findings(f: { target?: string; status?: string[]; classification?: string[]; severity?: string[]; limit?: number } = {}): Promise<{ findings: AuditFinding[]; total: number }> {
    const target = f.target ? (await this.targetDoc(f.target)).uri : undefined;
    const out: AuditFinding[] = [];
    for (const a of await this.views()) {
      if (target && a.target !== target) continue;
      for (const i of a.items) for (const x of i.findings) out.push({ ...x, target: a.target });
    }
    const hit = out.filter(
      (x) => (!f.status?.length || f.status.includes(x.status)) && (!f.classification?.length || f.classification.includes(x.classification)) && (!f.severity?.length || f.severity.includes(x.severity)),
    );
    hit.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return { findings: hit.slice(0, f.limit ?? 100), total: hit.length };
  }

  /** Latest completed audit per target (by completion time). */
  private latestByTarget(views: Audit[]): Map<string, Audit> {
    const out = new Map<string, Audit>();
    for (const a of views) {
      if (a.status !== 'completed') continue;
      const cur = out.get(a.target);
      if (!cur || (a.completedAt ?? '') > (cur.completedAt ?? '')) out.set(a.target, a);
    }
    return out;
  }

  /** `lastAudit` per spec id (spec_list / doc_list rows). */
  async lastAudits(specIds?: string[], m?: Model, kind: 'specs' | 'standards' = 'specs'): Promise<Record<string, LastAudit | null>> {
    const model = m ?? (await this.deps.model());
    const latest = this.latestByTarget(await this.views(model));
    const out: Record<string, LastAudit | null> = {};
    for (const id of specIds ?? (kind === 'specs' ? model.specs : model.standards).map((s) => s.id)) {
      const a = latest.get(buildRef({ kind, id }));
      out[id] = a ? this.lastOf(a) : null;
    }
    return out;
  }

  async specAudits(specId: string): Promise<SpecAudits & { lastAudit: LastAudit | null }> {
    const uri = buildRef({ kind: 'specs', id: specId });
    const views = (await this.views()).filter((a) => a.target === uri);
    const latest = this.latestByTarget(views).get(uri) ?? null;
    return {
      latest: latest ? this.summaryOf(latest) : null,
      history: views.map((a) => this.summaryOf(a)),
      findings: views.flatMap((a) => a.items.flatMap((i) => i.findings)),
      lastAudit: latest ? this.lastOf(latest) : null,
    };
  }

  async standardAudits(std: StoredStandard): Promise<StandardAudits & { lastAudit: LastAudit | null }> {
    const uri = buildRef({ kind: 'standards', id: std.id });
    const all = await this.views();
    const own = all.filter((a) => a.target === uri);
    const latest = this.latestByTarget(own).get(uri) ?? null;
    const rules = std.sections.filter((s) => !s.archived && isCriterion(s)).map((s) => ({ ref: sectionUri('standards', std.id, s.id), title: s.title, level: levelOf(s) }));
    const refs = new Set(rules.map((r) => r.ref));
    const rows: StandardAudits['compliance']['rows'] = [];
    for (const a of this.latestByTarget(all).values()) {
      const mine = a.items.filter((i) => refs.has(i.ref));
      if (!mine.length) continue;
      const results: Record<string, AuditItemResult> = {};
      const openFindings: Record<string, number> = {};
      for (const i of mine) {
        if (i.result) results[i.ref] = i.result;
        const n = i.findings.filter((f) => f.status === 'open').length;
        if (n) openFindings[i.ref] = n;
      }
      rows.push({ subject: a.target, kind: a.targetKind, title: a.targetTitle ?? a.target, audit: this.summaryOf(a), results, openFindings });
    }
    rows.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'standard' ? -1 : 1));
    return { latest: latest ? this.summaryOf(latest) : null, history: own.map((a) => this.summaryOf(a)), findings: own.flatMap((a) => a.items.flatMap((i) => i.findings)), compliance: { rules, rows }, lastAudit: latest ? this.lastOf(latest) : null };
  }

  /** Per spec its last audit; per component the worst state of the audited specs affecting it. */
  async overview(): Promise<AuditOverview> {
    const m = await this.deps.model();
    const specs = await this.lastAudits(undefined, m);
    const components: Record<string, ComponentAuditStatus> = {};
    const rank = { none: 0, pass: 1, stale: 2, warn: 3, fail: 4 } as const;
    for (const c of m.components ?? []) components[c.id] = { status: 'none', openMust: 0, openShould: 0, specs: [] };
    for (const spec of m.specs) {
      const la = specs[spec.id];
      if (!la || spec.status === 'archived') continue;
      const st: ComponentAuditStatus['status'] = la.result === 'fail' ? 'fail' : la.result === 'warn' ? 'warn' : la.stale ? 'stale' : 'pass';
      for (const c of specComponents(spec, m)) {
        const e = components[c.id];
        if (!e) continue;
        e.specs.push(spec.id);
        e.openMust += la.openMust;
        e.openShould += la.openShould;
        if (rank[st] > rank[e.status]) e.status = st;
      }
    }
    return { specs, components };
  }

  /** A finding by reference (feedback `fromFinding`, work-order links). */
  async requireFinding(uri: string): Promise<AuditFinding> {
    const n = parseNodeUri(uri);
    if (n?.kind !== 'findings') throw invalid(`${uri} is not a finding reference (mandate://audits/<id>/findings/<fid>)`);
    const a = await this.repo.get(n.audit).catch(() => null);
    if (!a) throw new NotFoundError(`audit '${n.audit}' not found`);
    const f = (await this.view(a, undefined, { staleness: false })).items.flatMap((i) => i.findings).find((x) => x.id === n.id);
    if (!f) throw new NotFoundError(`finding ${n.id} not found in audit ${n.audit}`);
    return f;
  }

  /* ---------------------------------------------------------------- writes */

  /** Readable, sortable ids: `<yyyy-mm-dd>-<target id>`, `-2`, `-3`, ... on collision (ids are never reused). */
  private async newId(targetId: string, now: Date): Promise<string> {
    const base = `${now.toISOString().slice(0, 10)}-${targetId}`.slice(0, 110).replace(/-+$/, '');
    const used = new Set([...(await this.list()).map((a) => a.id), ...[...(await this.deps.git.fileHistory(['audits'])).keys()].map((p) => p.replace(/^audits\//, '').replace(/\.md$/, ''))]);
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  async start(input: { target: string; commit?: string; code?: AuditCode; overview?: string }, who: { agent: string; user?: string }, meta: CommitMeta = {}, req?: { assignee: string; requestedBy?: string; trigger?: string }): Promise<StoredAudit> {
    const m = await this.deps.model();
    const t = await this.targetDoc(input.target, m);
    if (t.spec?.status === 'archived') throw invalid(`${t.uri} is archived`);
    if (t.std?.status === 'draft') throw invalid(`${t.uri} is a proposed standard (it applies nowhere until confirmed)`);
    const commit = await this.deps.git.resolveCommit(input.commit ?? 'HEAD');
    if (!commit) throw invalid(input.commit ? `unknown commit '${input.commit}'` : 'the repository has no commits');
    const plan = await this.plan(t.uri, m);
    if (!plan.items.length) throw invalid(`${t.uri} has no criteria or rules to audit`);
    const now = meta.date ?? new Date();
    const id = await this.newId(parseRef(t.uri)!.id, now);
    const used = new Set<string>([OVERVIEW]);
    const sectionId = (ref: string) => {
      const r = parseRef(ref)!;
      let sid = (r.kind === 'specs' && t.kind === 'spec') || t.kind === 'standard' ? r.sectionId! : `${r.id}-${r.sectionId}`;
      sid = sid.slice(0, 100).replace(/-+$/, '');
      let out = sid;
      for (let i = 2; used.has(out); i++) out = `${sid}-${i}`;
      used.add(out);
      return out;
    };
    const sections: Section[] = [
      { id: OVERVIEW, title: 'Overview', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: input.overview?.trim() ?? '' },
      ...plan.items.map((i) => {
        const sec = this.sectionOfModel(i.ref, m)!;
        return {
          id: sectionId(i.ref),
          title: i.title,
          type: 'audit-item',
          summary: `${i.level} ${i.kind}: ${i.title}`.replace(/[\r\n]+/g, ' ').slice(0, 300),
          ref: i.ref,
          kind: i.kind,
          level: i.level,
          result: 'pending' as const,
          hash: criterionHash(sec),
          refs: [],
          symbols: [],
          links: [],
          verifiedBy: [],
          body: '',
        } as Section;
      }),
    ];
    const doc = {
      id,
      title: `Audit of ${plan.title}`,
      target: t.uri,
      commit,
      ...(input.code ? { code: input.code } : {}),
      auditor: { agent: who.agent, ...(who.user ? { user: who.user } : {}) },
      status: req ? ('requested' as const) : ('in_progress' as const),
      startedAt: now.toISOString(),
      ...(req ? { assignee: req.assignee, ...(req.requestedBy ? { requestedBy: req.requestedBy } : {}), requestedAt: now.toISOString(), ...(req.trigger ? { trigger: req.trigger } : {}) } : {}),
      sections,
    };
    return this.repo.create(doc as never, { ...meta, message: meta.message ?? `audit: ${req ? 'request' : 'start'} ${id} (${t.uri.replace('mandate://', '')})`, trailers: { ...meta.trailers, Audit: id } });
  }

  /**
   * The assigned agent starts the audit it was asked to do (audit_start { request }): requested -> in_progress, the
   * auditor and the audited code are recorded. Exclusive: only the assignee (client id `me` or one of its handles) may.
   */
  async begin(input: { auditId: string; code?: AuditCode }, who: { agent: string; user?: string }, me: { id: string; handles?: string[] }, meta: CommitMeta = {}): Promise<StoredAudit> {
    return this.repo.modify(
      input.auditId,
      (a) => {
        if (a.status === 'in_progress' && a.assignee && a.assignee !== me.id) throw new AuditError('already_taken', `audit ${a.id} was already started by ${a.auditor.agent}`);
        if (a.status !== 'requested' && a.status !== 'in_progress') throw new AuditError('audit_frozen', `audit ${a.id} is ${a.status}`);
        if (a.assignee && a.assignee !== me.id && !(me.handles ?? []).includes(a.assignee)) throw new AuditError('not_assigned', `audit ${a.id} is assigned to ${a.assignee}`);
        return { ...a, status: 'in_progress', auditor: { agent: who.agent, ...(who.user ? { user: who.user } : {}) }, ...(input.code ? { code: input.code } : {}), assignee: me.id } as StoredAudit;
      },
      { ...meta, message: meta.message ?? `audit: start ${input.auditId}`, trailers: { ...meta.trailers, Audit: input.auditId } },
    );
  }

  private sectionOfModel(uri: string, m: Model): Section | undefined {
    const r = parseRef(uri);
    const doc = r?.kind === 'specs' ? m.specs.find((s) => s.id === r.id) : m.standards.find((s) => s.id === r?.id);
    return doc?.sections.find((s) => s.id === r?.sectionId);
  }

  private async inProgress(id: string): Promise<StoredAudit> {
    return this.requireInProgress(await this.repo.get(id));
  }

  /** Recording against a requested audit starts it (the agent that was asked to do it). */
  private requireInProgress(a: StoredAudit): StoredAudit {
    if (a.status === 'requested') return { ...a, status: 'in_progress' };
    if (a.status !== 'in_progress') throw new AuditError('audit_frozen', `audit ${a.id} is ${a.status}: items can only be recorded while in progress (re-check findings with audit_recheck, or start a new audit)`);
    return a;
  }

  /** The audit-item section for a reference: the criterion / rule URI or the audit section URI (prefix, @sha, #L ignored). */
  private itemFor(a: StoredAudit, ref: string): Item {
    const r = parseRef(ref);
    const items = a.sections.filter(isItem);
    let hit: Item | undefined;
    if (r?.kind === 'audits' && r.id === a.id && r.sectionId) hit = items.find((s) => s.id === r.sectionId);
    else if (r && (r.kind === 'specs' || r.kind === 'standards') && r.sectionId) hit = items.find((s) => s.ref === buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId }));
    else hit = items.find((s) => s.id === ref.trim());
    if (!hit) {
      throw new AuditError('not_in_plan', `${ref} is not an item of audit ${a.id}`, { kind: 'audit_plan', items: items.map((s) => s.ref) }, 400);
    }
    return hit;
  }

  async recordItem(input: { auditId: string; ref: string; result: AuditItemResult; notes?: string; findings?: FindingInput[] }, meta: CommitMeta = {}): Promise<{ audit: StoredAudit; item: Item }> {
    this.itemFor(await this.inProgress(input.auditId), input.ref); // fail fast; re-checked inside the lock
    const notes = input.notes?.trim() ?? '';
    const findings = (input.findings ?? []).map((f) => findingInputSchema.parse(f));
    if ((input.result === 'fail' || input.result === 'partial') && !notes) {
      throw new AuditError('notes_required', `a ${input.result} result needs notes: explain in prose how the code was checked and why it ${input.result === 'fail' ? 'fails' : 'only partly passes'}`, undefined, 400);
    }
    if ((input.result === 'pass' || input.result === 'n_a') && findings.length) throw invalid(`findings belong to fail or partial results (got ${input.result}); record the item as partial or fail`);
    let itemId = '';
    // MW-1: read-modify-write inside the write lock (concurrent item writes on one audit never undo each other).
    const audit = await this.repo.modify(
      input.auditId,
      (a) => {
        const cur = this.requireInProgress(a);
        const item = this.itemFor(a, input.ref);
        itemId = item.id;
        const used = a.sections.flatMap((s) => (s.findings ?? []).map((f) => f.id)).filter((id) => !(item.findings ?? []).some((f) => f.id === id));
        const stored: AuditFindingMeta[] = [];
        for (const f of findings) {
          const id = nextFindingId([...used, ...stored.map((x) => x.id), ...(item.findings ?? []).map((x) => x.id)]);
          stored.push(
            clean({
              id,
              title: f.title,
              severity: findingSeverity(item.level ?? 'must', f.severity),
              classification: f.classification,
              description: f.description,
              suggestedFix: f.suggestedFix,
              evidence: f.evidence,
              codeRefs: f.codeRefs ?? [],
            }) as AuditFindingMeta,
          );
        }
        const next: Item = { ...item, result: input.result, body: notes, findings: stored };
        return { ...cur, sections: a.sections.map((s) => (s.id === item.id ? next : s)) };
      },
      { ...meta, get message() { return meta.message ?? `audit: ${input.result} ${itemId} in ${input.auditId}`; }, trailers: { ...meta.trailers, Audit: input.auditId } } as CommitMeta,
    );
    return { audit, item: audit.sections.find((s) => s.id === itemId) as Item };
  }

  async complete(input: { auditId: string; summary: string; overview?: string }, meta: CommitMeta = {}): Promise<StoredAudit> {
    // MW-1 / MW-15: the completeness checks run on the current audit inside the write lock.
    return this.repo.modify(input.auditId, (cur) => this.completed(this.requireInProgress(cur), input, meta), { ...meta, message: meta.message ?? `audit: complete ${input.auditId}`, trailers: { ...meta.trailers, Audit: input.auditId } });
  }

  private completed(a: StoredAudit, input: { summary: string; overview?: string }, meta: CommitMeta): StoredAudit {
    const overview = (input.overview ?? a.sections.find((s) => s.id === OVERVIEW)?.body ?? '').trim();
    const items = a.sections.filter(isItem);
    const missing = items.filter((s) => s.level === 'must' && (s.result ?? 'pending') === 'pending').map((s) => ({ ref: s.ref, section: s.id, title: s.title }));
    const noNotes = items.filter((s) => (s.result === 'fail' || s.result === 'partial') && !s.body.trim()).map((s) => ({ ref: s.ref, section: s.id, title: s.title }));
    if (missing.length || noNotes.length || !overview) {
      const parts = [
        missing.length ? `${missing.length} must item(s) not recorded: ${missing.map((x) => x.title).join(', ')}` : '',
        noNotes.length ? `${noNotes.length} fail / partial item(s) without notes` : '',
        !overview ? 'the overview is empty (write the narrative: scope, what was inspected, assessment, risks, recommendations)' : '',
      ].filter(Boolean);
      throw new AuditError('audit_incomplete', `audit ${a.id} is incomplete: ${parts.join('; ')}`, { kind: 'audit_incomplete', missing, withoutNotes: noNotes, overview: !!overview });
    }
    const sections = a.sections.map((s) => (s.id === OVERVIEW ? { ...s, body: overview } : s));
    const now = (meta.date ?? new Date()).toISOString();
    return { ...a, status: 'completed', completedAt: now, summary: input.summary.replace(/[\r\n]+/g, ' ').trim(), sections } as StoredAudit;
  }

  async abandon(input: { auditId: string; reason?: string }, meta: CommitMeta = {}): Promise<StoredAudit> {
    return this.repo.modify(input.auditId, (a) => ({ ...this.requireInProgress(a), status: 'abandoned', abandonedAt: (meta.date ?? new Date()).toISOString(), ...(input.reason ? { abandonReason: input.reason } : {}) }) as StoredAudit, {
      ...meta,
      message: meta.message ?? `audit: abandon ${input.auditId}`,
      trailers: { ...meta.trailers, Audit: input.auditId },
    });
  }

  /** Change one finding (resolution / re-checks) with a function; frozen audits allow exactly this. */
  /** MW-1: `fn` runs on the current finding inside the write lock (no lost updates between concurrent finding writes). */
  private async patchFinding(auditId: string, fid: string, fn: (f: AuditFindingMeta, a: StoredAudit) => AuditFindingMeta, meta: CommitMeta, subject: string): Promise<StoredAudit> {
    return this.repo.modify(
      auditId,
      (a) => {
        let found = false;
        const sections = a.sections.map((s) => {
          if (!(s.findings ?? []).some((f) => f.id === fid)) return s;
          found = true;
          return { ...s, findings: s.findings!.map((f) => (f.id === fid ? fn(f, a) : f)) };
        });
        if (!found) throw new NotFoundError(`finding ${fid} not found in audit ${auditId}`);
        return { ...a, sections };
      },
      { ...meta, message: meta.message ?? subject, trailers: { ...meta.trailers, Audit: auditId } },
    );
  }

  /** Re-check a finding on the same audit: pass resolves it (with the code commit), wont_fix accepts it, fail keeps it open. */
  async recheck(input: { auditId: string; findingId: string; result: 'pass' | 'fail' | 'wont_fix'; notes?: string; commit?: string }, who: string, meta: CommitMeta = {}): Promise<{ audit: StoredAudit; warnings: string[] }> {
    if (input.result === 'wont_fix' && !input.notes?.trim()) throw invalid("wont_fix needs notes (why it is accepted as is)");
    const a = await this.repo.get(input.auditId);
    if (a.status === 'abandoned') throw new AuditError('audit_frozen', `audit ${a.id} was abandoned`);
    const f = a.sections.flatMap((s) => s.findings ?? []).find((x) => x.id === input.findingId);
    if (!f) throw new NotFoundError(`finding ${input.findingId} not found in audit ${a.id}`);
    if (!FINDING_TRANSITIONS[findingStatus(f)].length) throw new AuditError('finding_closed', `finding ${f.id} is already ${findingStatus(f)}`);
    const warnings: string[] = [];
    const m = await this.deps.model();
    const wo = (m.workOrders ?? []).find((w) => w.id === f.resolution?.workOrder);
    if (input.result === 'pass' && wo && OPEN_WORK_ORDER_STATUSES.includes(wo.status)) warnings.push(`fix work order ${wo.id} is still ${wo.status}`);
    const at = (meta.date ?? new Date()).toISOString();
    const audit = await this.patchFinding(
      a.id,
      f.id,
      (x, cur) => {
        if (cur.status === 'abandoned') throw new AuditError('audit_frozen', `audit ${cur.id} was abandoned`);
        if (!FINDING_TRANSITIONS[findingStatus(x)].length) throw new AuditError('finding_closed', `finding ${x.id} is already ${findingStatus(x)}`);
        return {
        ...x,
        rechecks: [...(x.rechecks ?? []), clean({ at, by: who, result: input.result, notes: input.notes, commit: input.commit })],
        resolution:
          input.result === 'fail'
            ? { ...(x.resolution ?? {}), status: 'open' as const }
            : clean({ ...(x.resolution ?? {}), status: input.result === 'pass' ? ('resolved' as const) : ('wont_fix' as const), commit: input.commit, at, by: who, notes: input.notes }),
        };
      },
      meta,
      `audit: re-check ${f.id} ${input.result} in ${a.id}`,
    );
    return { audit, warnings };
  }

  /**
   * DF-2: point a finding at a replacement fix work order (the linked one was cancelled or failed). Allowed on completed
   * (frozen) audits: only the finding's resolution changes. The work order also lists the finding (`findings`).
   */
  async relinkFinding(input: { auditId: string; findingId: string; workOrder: string }, who: string, meta: CommitMeta = {}): Promise<{ audit: StoredAudit; previous: string | null }> {
    const run = async () => {
      const a = await this.repo.get(input.auditId);
      if (a.status === 'abandoned') throw new AuditError('audit_frozen', `audit ${a.id} was abandoned`);
      const f = a.sections.flatMap((s) => s.findings ?? []).find((x) => x.id === input.findingId);
      if (!f) throw new NotFoundError(`finding ${input.findingId} not found in audit ${a.id}`);
      if (findingStatus(f) !== 'open') throw new AuditError('finding_closed', `finding ${f.id} is already ${findingStatus(f)}`);
      const wo = await this.deps.workOrders.get(input.workOrder).catch(() => null);
      if (!wo) throw new NotFoundError(`work order '${input.workOrder}' not found`);
      if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status) && wo.status !== 'done') throw invalid(`work order ${wo.id} is ${wo.status}; link a live work order`);
      const previous = f.resolution?.workOrder ?? null;
      if (previous === wo.id) return { audit: a, previous };
      if (previous) {
        const prev = await this.deps.workOrders.get(previous).catch(() => null);
        if (prev && prev.status !== 'cancelled' && prev.status !== 'failed') throw new AuditError('finding_linked', `finding ${f.id} is linked to work order ${prev.id} (${prev.status}); cancel it first`);
      }
      const uri = buildFindingRef({ audit: a.id, id: f.id });
      if (OPEN_WORK_ORDER_STATUSES.includes(wo.status) && !(wo.findings ?? []).includes(uri)) {
        await this.deps.workOrders.docs.modify(wo.id, (d) => ({ ...d, findings: [...(d.findings ?? []), uri] }), { ...meta, message: `work order: ${wo.id} fixes ${f.id} of audit ${a.id}`, trailers: { ...meta.trailers, Audit: a.id } });
      }
      const at = (meta.date ?? new Date()).toISOString();
      const audit = await this.patchFinding(a.id, f.id, (x) => ({ ...x, resolution: clean({ ...(x.resolution ?? {}), status: 'open' as const, workOrder: wo.id, at, by: who }) }), { ...meta, trailers: { ...meta.trailers, 'Fix-Work-Order': wo.id } }, `audit: relink ${f.id} of ${a.id} -> work order ${wo.id}${previous ? ` (was ${previous})` : ''}`);
      return { audit, previous };
    };
    return this.deps.lock ? this.deps.lock.run(run) : run();
  }

  /**
   * DF-9: re-check a whole audit item on a completed audit (pass | fail | partial | n_a, notes required): appended to the
   * item's `itemRechecks`; the original result stays as recorded.
   */
  async recheckItem(input: { auditId: string; item: string; result: 'pass' | 'fail' | 'partial' | 'n_a'; notes: string; commit?: string }, who: string, meta: CommitMeta = {}): Promise<{ audit: StoredAudit; item: Item }> {
    if (!input.notes?.trim()) throw invalid('an item re-check needs notes (how the code was checked)');
    const at = (meta.date ?? new Date()).toISOString();
    let itemId = '';
    const audit = await this.repo.modify(
      input.auditId,
      (a) => {
        if (a.status !== 'completed') throw new AuditError('audit_not_completed', `audit ${a.id} is ${a.status}: ${a.status === 'in_progress' ? 'record the item (audit_record_item)' : 'start a new audit'}`);
        const item = this.itemFor(a, input.item);
        itemId = item.id;
        const entry = clean({ at, by: who, result: input.result, notes: input.notes.trim(), commit: input.commit });
        return { ...a, sections: a.sections.map((s) => (s.id === item.id ? { ...s, itemRechecks: [...((s as Item).itemRechecks ?? []), entry] } : s)) } as StoredAudit;
      },
      { ...meta, get message() { return meta.message ?? `audit: re-check item ${itemId} ${input.result} in ${input.auditId}`; }, trailers: { ...meta.trailers, Audit: input.auditId } } as CommitMeta,
    );
    return { audit, item: audit.sections.find((s) => s.id === itemId) as Item };
  }

  /** Record the feedback filed from a finding (request_create with fromFinding). */
  async linkFeedback(uri: string, feedbackId: string, who: string, meta: CommitMeta = {}): Promise<void> {
    const n = parseNodeUri(uri);
    if (n?.kind !== 'findings') return;
    const at = (meta.date ?? new Date()).toISOString();
    await this.patchFinding(n.audit, n.id, (f) => ({ ...f, resolution: clean({ ...(f.resolution ?? { status: 'open' as const }), feedback: feedbackId, at: f.resolution?.at ?? at, by: f.resolution?.by ?? who }) }), meta, `audit: ${n.id} reported in feedback ${feedbackId}`);
  }

  /**
   * One fix work order per spec for the open code_deviates findings at must / should level (may never; should
   * optional); its sections are the violated spec sections, its note lists the violations, it links the findings.
   * spec_wrong / ambiguous findings are returned for feedback instead.
   */
  async findingsToWorkOrders(
    input: { auditId: string; findingIds?: string[]; includeShould?: boolean },
    who: string,
    meta: CommitMeta = {},
  ): Promise<{
    workOrders: { id: string; ref: string; spec: string; sections: string[]; findings: string[]; priority: string }[];
    feedbackNeeded: AuditFinding[];
    skipped: { finding: string; reason: string }[];
    unassigned: AuditFinding[];
  }> {
    // MW-19: the whole conversion holds the (re-entrant) write lock, so eligibility (`resolution.workOrder`) is read
    // and claimed atomically: concurrent calls never create duplicate fix work orders.
    return this.deps.lock ? this.deps.lock.run(() => this.findingsToWorkOrdersLocked(input, who, meta)) : this.findingsToWorkOrdersLocked(input, who, meta);
  }

  private async findingsToWorkOrdersLocked(
    input: { auditId: string; findingIds?: string[]; includeShould?: boolean },
    who: string,
    meta: CommitMeta,
  ): Promise<{
    workOrders: { id: string; ref: string; spec: string; sections: string[]; findings: string[]; priority: string }[];
    feedbackNeeded: AuditFinding[];
    skipped: { finding: string; reason: string }[];
    unassigned: AuditFinding[];
  }> {
    const stored = await this.repo.get(input.auditId);
    if (stored.status !== 'completed') throw new AuditError('audit_not_completed', `audit ${stored.id} is ${stored.status}: complete it (audit_complete) before creating work orders`);
    const m = await this.deps.model();
    const a = await this.view(stored, m, { staleness: false });
    const all = a.items.flatMap((i) => i.findings);
    const wanted = input.findingIds?.length ? all.filter((f) => input.findingIds!.includes(f.id)) : all;
    const skipped: { finding: string; reason: string }[] = [];
    for (const id of input.findingIds ?? []) if (!all.some((f) => f.id === id)) skipped.push({ finding: id, reason: 'not a finding of this audit' });
    const live = (w?: string) => {
      const wo = (m.workOrders ?? []).find((x) => x.id === w);
      return !!wo && wo.status !== 'cancelled' && wo.status !== 'failed';
    };
    const eligible: AuditFinding[] = [];
    const feedbackNeeded: AuditFinding[] = [];
    for (const f of wanted) {
      if (f.status !== 'open') skipped.push({ finding: f.id, reason: `already ${f.status}` });
      else if (f.classification !== 'code_deviates') {
        if (f.resolution.feedback) skipped.push({ finding: f.id, reason: `${f.classification}: reported in feedback ${f.resolution.feedback}` });
        else feedbackNeeded.push(f);
      } else if (f.level === 'may') skipped.push({ finding: f.id, reason: 'may-level findings are never turned into work orders' });
      else if (f.level === 'should' && input.includeShould === false) skipped.push({ finding: f.id, reason: 'should-level findings excluded (includeShould: false)' });
      else if (live(f.resolution.workOrder)) skipped.push({ finding: f.id, reason: `already linked to work order ${f.resolution.workOrder}` });
      else eligible.push(f);
    }
    // Group per spec.
    const t = parseRef(a.target)!;
    const groups = new Map<string, AuditFinding[]>();
    const unassigned: AuditFinding[] = [];
    if (t.kind === 'specs') {
      if (eligible.length) groups.set(t.id, eligible);
    } else {
      const std = m.standards.find((s) => s.id === t.id);
      const using = std ? standardUsage(std, m.specs.filter((s) => s.status !== 'archived')).map((u) => m.specs.find((s) => s.id === u.specId)!) : [];
      for (const f of eligible) {
        const code = f.codeRefs.map(parseAuditCodeRef).filter((x): x is NonNullable<typeof x> => !!x);
        const spec = using.find((s) => s.sections.some((sec) => !sec.archived && sec.refs.some((r) => code.some((c) => c.repo === r.repo && c.path === r.path))));
        if (!spec) unassigned.push(f);
        else groups.set(spec.id, [...(groups.get(spec.id) ?? []), f]);
      }
    }
    const created: { id: string; ref: string; spec: string; sections: string[]; findings: string[]; priority: string }[] = [];
    for (const [specId, fs] of groups) {
      const spec = m.specs.find((s) => s.id === specId);
      if (!spec) {
        unassigned.push(...fs);
        continue;
      }
      const v = await this.deps.verification.forSpec(spec, undefined, m);
      const inherited = new Map(v.inherited.flatMap((g) => g.criteria).map((c) => [c.uri, c.sections ?? []]));
      const live = spec.sections.filter((s) => !s.archived);
      const sections = new Set<string>();
      const mapped: AuditFinding[] = [];
      for (const f of fs) {
        const r = parseRef(f.ref)!;
        if (r.kind === 'specs' && r.id === spec.id && live.some((s) => s.id === r.sectionId)) {
          sections.add(r.sectionId!);
          mapped.push(f);
          continue;
        }
        // DF-1: the section owning the finding's code comes first; the sections following the rule only when the
        // finding names no code that a section of this spec references.
        const code = f.codeRefs.map(parseAuditCodeRef).filter((x): x is NonNullable<typeof x> => !!x);
        const byCode = live.filter((s) => s.refs.some((r) => code.some((c) => c.repo === r.repo && c.path === r.path)));
        if (byCode.length) {
          byCode.forEach((s) => sections.add(s.id));
          mapped.push(f);
          continue;
        }
        const following = (inherited.get(f.ref) ?? []).filter((sid) => live.some((s) => s.id === sid));
        if (following.length) {
          following.forEach((sid) => sections.add(sid));
          mapped.push(f);
          continue;
        }
        // MW-20: never guess a section; the finding is reported as unassigned.
        unassigned.push(f);
      }
      if (!mapped.length) continue;
      fs.splice(0, fs.length, ...mapped);
      const uris = fs.map((f) => f.uri);
      const lines = fs.map((f) => `- [${f.level} · ${f.severity}] ${f.itemTitle} (${f.ref.replace('mandate://', '')}): ${f.title}${f.codeRefs.length ? ` — ${f.codeRefs.join(', ')}` : ''}`);
      const note = [
        `Fix the code to conform to ${spec.title}: audit ${a.uri} found ${fs.length} deviation(s).`,
        '',
        ...lines,
        '',
        `Findings: ${uris.join(' ')}`,
        'When done, re-check each finding on the same audit (audit_recheck); findings are not resolved automatically.',
      ].join('\n');
      const priority = fs.some((f) => f.level === 'must') ? 'p1' : 'p2';
      // A plan stub from the findings (the implementing agent refines it with work_order_plan_set before claiming).
      const plan = [
        `Plan stub from audit ${a.uri}: fix the code so it conforms again; refine this plan before claiming.`,
        '',
        ...fs.flatMap((f, i) => [
          `${i + 1}. **${f.title}** (${f.level} · ${f.severity}; ${f.uri})`,
          `   - Item: ${f.itemTitle} (${f.ref})`,
          ...(f.codeRefs.length ? [`   - Code: ${f.codeRefs.join(', ')}`] : []),
          `   - Problem: ${f.description.replace(/\s+/g, ' ').slice(0, 600)}`,
          ...(f.suggestedFix ? [`   - Fix: ${f.suggestedFix.replace(/\s+/g, ' ').slice(0, 600)}`] : []),
        ]),
        '',
        `${fs.length + 1}. Record the touched code (work_order_touch), then re-check each finding on the audit (audit_recheck).`,
      ].join('\n');
      const wo: WorkOrder = await this.deps.workOrders.create(
        { spec: spec.id, kind: 'fix', status: 'pending', priority, note, plan, sections: [...sections].map((id) => ({ id })), findings: uris, createdBy: who } as never,
        { ...meta, message: `work-order: fix ${spec.id} from audit ${a.id}`, trailers: { ...meta.trailers, Audit: a.id } },
      );
      const at = (meta.date ?? new Date()).toISOString();
      const ids = new Set(fs.map((f) => f.id));
      const cur = await this.repo.get(a.id);
      const nextSections = cur.sections.map((s) =>
        (s.findings ?? []).some((f) => ids.has(f.id))
          ? { ...s, findings: s.findings!.map((f) => (ids.has(f.id) ? { ...f, resolution: clean({ ...(f.resolution ?? {}), status: 'open' as const, workOrder: wo.id, at, by: who }) } : f)) }
          : s,
      );
      // MW-21: the backlink names the work order with a non-cause trailer (a `Work-Order:` trailer would record the
      // audit as caused by its own fix work order, the reverse of the work order's `Audit:` cause).
      await this.repo.update(a.id, { sections: nextSections } as never, { ...meta, message: `audit: ${fs.length} finding(s) of ${a.id} -> work order ${wo.id}`, trailers: { ...meta.trailers, Audit: a.id, 'Fix-Work-Order': wo.id } });
      created.push({ id: wo.id, ref: buildRef({ kind: 'work-orders', id: wo.id }), spec: spec.id, sections: [...sections], findings: uris, priority });
    }
    return { workOrders: created, feedbackNeeded, skipped, unassigned };
  }
}

export type { StoredFeedback };
export { AUDIT_LEVELS, ConflictError };
