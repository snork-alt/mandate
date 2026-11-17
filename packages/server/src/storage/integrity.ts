/**
 * Integrity (repo lint), always checked:
 * - `checkIntegrity(m, scope)`: the rules of INTEGRITY_RULES (shared lifecycle registry). Element rules run for the
 *   documents in `scope` (all when omitted); global rules always run over the whole model (cheap graph-wide checks);
 *   full-only rules (feedback tampering, from git history) only in full runs.
 * - `IntegrityService.hook(kind)`: inside the write lock, before every commit, the rules run on the model with and
 *   without the written element (scope: the element and its neighbours). A write that would INTRODUCE an ERROR is
 *   rejected (`integrity_violation`, nothing committed); after the commit the cached report is updated incrementally
 *   and the delta (introduced / resolved) is handed to the write tool's result (`collectIntegrity`).
 * - full re-checks: on startup, after pulls / merges / outside commits (`sync`, wired to the commit watchers), and
 *   periodically (`start`). `current()` is the report at HEAD; `onChange` feeds the `integrity.changed` event.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { checkLinks } from '@mandate/doc';
import {
  INTEGRITY_RULE,
  integritySeverity,
  OPEN_WORK_ORDER_STATUSES,
  type IntegrityCounts,
  type IntegrityDelta,
  type IntegrityIssue,
  type IntegrityReport,
  type StoredAudit,
  type StoredComponent,
  type StoredSpec,
  type StoredStandard,
  type StoredWorkOrderDoc,
  type WorkOrder,
} from '@mandate/shared';
import { parseLinkTarget, type Section } from '@mandate/doc';
import { buildFindingRef, buildRef, parseAuditCodeRef, parseRef } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import type { FeedbackService } from './feedback.js';
import { componentGaps, coverage } from './components.js';
import { isFullSha } from './ids.js';
import { ACCEPTANCE, criteriaOf, finder, graphProblems, openChangingOrders, sectionsWithoutCriteria, sectionUri, type Model } from './model.js';
import { projectWorkOrder } from './work-order-docs.js';
import { detached, type Mutex } from './Mutex.js';
import type { IntegrityHook } from './GitBackedRepository.js';

export type IntegrityKind = 'specs' | 'standards' | 'components' | 'work-orders' | 'audits';

/** Inputs of the rules that read more than the model: audits (every check), drift of done specs (full runs only). */
export interface IntegritySources {
  audits?: () => Promise<StoredAudit[]>;
  drift?: (spec: StoredSpec, m: Model) => Promise<string[]>;
}

/** `mandate://<kind>/<id>` of any element URI (sections, findings, ... map to their document). */
export function docOf(uri: string): string {
  const m = /^mandate:\/\/([a-z-]+)\/([^/@#]+)/.exec(uri);
  return m ? `mandate://${m[1]}/${m[2]}` : uri;
}

const issue = (rule: string, uri: string, message: string, hint?: string): IntegrityIssue => {
  const severity = integritySeverity(rule);
  const h = hint ?? INTEGRITY_RULE[rule]?.hint;
  return { rule, uri, message, severity, ...(h ? { hint: h } : {}) };
};

export const issueKey = (i: Pick<IntegrityIssue, 'rule' | 'uri' | 'message'>) => `${i.rule}|${i.uri}|${i.message}`;
const scopeOf = (rule: string) => INTEGRITY_RULE[rule]?.scope ?? 'element';

/** True when the issue is (re)computed by an incremental check over `scope`. */
export function coveredBy(i: IntegrityIssue, scope: Set<string>): boolean {
  const s = scopeOf(i.rule);
  return s === 'global' || (s === 'element' && scope.has(docOf(i.uri)));
}

/**
 * The integrity rules over a model. `scope` (document URIs): element rules only for those documents; global rules
 * always; `tampered` (feedback ids → warnings, full runs only) feeds the full-only feedback rule.
 */
export function checkIntegrity(
  m: Model,
  opts: { scope?: Set<string>; feedbackWarnings?: Map<string, string[]>; audits?: StoredAudit[]; drift?: Map<string, string[]>} = {},
): IntegrityIssue[] {
  const f = finder(m);
  const inScope = (uri: string) => !opts.scope || opts.scope.has(uri);
  const out: IntegrityIssue[] = graphProblems(m).map((p) => issue(p.rule, p.uri, p.message));
  for (const [kind, list] of [['specs', m.specs], ['standards', m.standards], ['components', m.components ?? []]] as const) {
    for (const d of list as (StoredSpec | StoredStandard | StoredComponent)[]) {
      const docUri = `mandate://${kind}/${d.id}`;
      if (!inScope(docUri)) continue;
      for (const p of checkLinks(kind, d.id, d.sections)) out.push(issue('invalid_link', docUri, p));
      if ('implementedCommit' in d && d.implementedCommit && !isFullSha(d.implementedCommit)) out.push(issue('short_sha', docUri, `implementedCommit ${d.implementedCommit} is not a full sha`));
      for (const s of d.sections) {
        const uri = sectionUri(kind, d.id, s.id);
        if (s.implementedCommit && !isFullSha(s.implementedCommit)) out.push(issue('short_sha', uri, `implementedCommit ${s.implementedCommit} is not a full sha`));
        for (const l of s.links) {
          const t = f.target(l.to);
          if (!t?.doc || (t.sectionId && !t.section)) out.push(issue('dangling_link', uri, `${l.rel} ${l.to}: target does not exist`));
        }
      }
      if (kind === 'components') {
        const c = d as StoredComponent;
        if (c.parent) {
          const parent = f.comps.get(c.parent);
          if (!parent) out.push(issue('dangling_reference', docUri, `parent ${c.parent} does not exist`));
          else if (parent.status === 'archived' && c.status !== 'archived') out.push(issue('archived_parent', docUri, `${c.status} component under archived parent ${c.parent}`));
        }
        if (c.kind === 'external' && c.status !== 'archived') {
          for (const s of c.sections) {
            if (s.archived) continue;
            const internal = s.links.filter((l) => l.rel === 'follows').flatMap((l) => criteriaOf(l.to, f).filter((cr) => isCodeRule(cr.section)).map((cr) => `${cr.standard.id}/${cr.section.id}`));
            if (internal.length) out.push(issue('external_follows_internal', sectionUri('components', c.id, s.id), `external ${c.id} follows internal code rules: ${[...new Set(internal)].join(', ')}`));
          }
        }
      } else if (kind === 'standards') {
        const std = d as StoredStandard;
        if (std.supersededBy && !f.stds.has(std.supersededBy)) out.push(issue('dangling_reference', docUri, `supersededBy ${std.supersededBy} does not exist`));
        if (std.supersededBy)
          for (const s of std.sections) {
            if (s.archived) continue;
            for (const l of s.links)
              if ((l.rel === 'extends' || l.rel === 'supersedes') && parseLinkTarget(l.to)?.kind === 'standards' && parseLinkTarget(l.to)?.id === std.supersededBy)
                out.push(issue('standard_successor_loop', sectionUri('standards', std.id, s.id), `${l.rel} ${l.to.replace('mandate://', '')}: a section of its own successor ${std.supersededBy}`));
          }
      } else {
        const spec = d as StoredSpec;
        if (spec.status === 'done' && !spec.sections.some((s) => s.type === ACCEPTANCE && !s.archived)) out.push(issue('spec_done_without_criteria', docUri, `${spec.id} is done without any live acceptance criterion`));
        // Every live section of a done spec has a criterion (work_order_create refuses sections without one; the existing state is a warning).
        if (spec.status === 'done') {
          for (const sid of sectionsWithoutCriteria(spec, m)) out.push(issue('spec_section_without_criteria', sectionUri('specs', spec.id, sid), `section ${sid} of ${spec.status} spec ${spec.id} has no acceptance criterion`));
        }
      }
    }
  }
  for (const [key, orders] of openChangingOrders(m.workOrders ?? [])) {
    if (orders.length > 1) out.push(issue('duplicate_open_work_order', `mandate://specs/${key.split('/')[0]}/sections/${key.split('/')[1]}`, `${orders.length} open implement/update work orders: ${orders.map((o) => o.id).join(', ')}`));
  }
  for (const w of m.workOrders ?? []) {
    const uri = `mandate://work-orders/${w.id}`;
    if (!inScope(uri)) continue;
    if (!isFullSha(w.specCommit)) out.push(issue('short_sha', uri, `specCommit ${w.specCommit} is not a full sha`));
    if (w.claim && !OPEN_WORK_ORDER_STATUSES.includes(w.status)) out.push(issue('claim_on_closed', uri, `${w.status} work order still carries a claim`));
    if (!f.specs.has(w.spec)) out.push(issue('dangling_reference', uri, `spec ${w.spec} does not exist`));
  }
  out.push(...auditIssues(m, opts.audits ?? []));
  for (const [id, reasons] of opts.drift ?? []) if (reasons.length) out.push(issue('done_spec_drift', `mandate://specs/${id}`, `${id} is done but drifted: ${reasons.map((r) => r.split(':')[0]).join('; ')}`));
  const cov = coverage(m, opts.audits ?? []);
  for (const r of cov.unowned) out.push(issue('unowned_code_ref', r.uri, `${r.repo}:${r.path} is not owned by any component; flow_next will ask you to create or update a component owning it`, 'create or update a component owning these paths (component_create with owns globs, tldr, interface sections; or add owns globs with component_update)'));
  for (const g of cov.emptyGlobs) out.push(issue('owns_matches_nothing', `mandate://components/${g.component}`, `${g.component} owns ${g.repo}:${g.glob}, which matches no referenced code`));
  for (const [id, gaps] of componentGaps(m)) for (const g of gaps) out.push(issue(g.rule, `mandate://components/${id}`, g.message, g.hint));
  for (const [id, warnings] of opts.feedbackWarnings ?? []) for (const w of warnings) if (w.startsWith('Tampered')) out.push(issue('feedback_tampered', `mandate://requests/${id}`, w));
  return out;
}

/** A rule about our own code: it has a code scope (paths / languages) or an automated check. */
const isCodeRule = (s: Section) => s.type === 'rule' && (!!s.scope?.paths?.length || !!s.scope?.languages?.length || (!!s.check && s.check.kind !== 'review'));

type Lines = { start: number; end: number } | undefined;
const lineRange = (l: string | undefined): Lines => {
  const m = l ? /^(\d+)(?:-(\d+))?$/.exec(l) : null;
  return m ? { start: Number(m[1]), end: Number(m[2] ?? m[1]) } : undefined;
};
/** Same file, and the line ranges intersect (a ref without lines covers the whole file). */
const overlaps = (a: { repo: string; path: string; lines?: Lines }, b: { repo: string; path: string; lines?: Lines }) =>
  a.repo === b.repo && a.path === b.path && (!a.lines || !b.lines || (a.lines.start <= b.lines.end && b.lines.start <= a.lines.end));
const sectionCode = (s: Section) => (s.refs ?? []).map((r) => ({ repo: r.repo, path: r.path, lines: lineRange(r.lines) }));

/**
 * Audit-backed rules (global, the audits are read on every check):
 * - audit_pass_contradicted: a `pass` item with its own open must / critical finding, or a passing spec criterion whose
 *   verified code (the sections listing it in verifiedBy, and its own refs) has an open must / critical code_deviates
 *   finding of the same audit.
 * - fix_misses_finding_code: an open fix work order none of whose sections owns (by code refs) a finding's code.
 */
function auditIssues(m: Model, audits: StoredAudit[]): IntegrityIssue[] {
  const out: IntegrityIssue[] = [];
  const findingOpen = (f: { resolution?: { status?: string } }) => (f.resolution?.status ?? 'open') === 'open';
  const specs = new Map(m.specs.map((s) => [s.id, s]));
  const live = audits.filter((a) => a.status !== 'abandoned');
  for (const a of live) {
    const items = a.sections.filter((s) => s.type === 'audit-item');
    const strong = items.flatMap((it) => (it.findings ?? []).filter((x) => findingOpen(x) && ((it.level ?? 'must') === 'must' || x.severity === 'critical')).map((x) => ({ item: it, f: x })));
    if (!strong.length) continue;
    const target = parseRef(a.target);
    const spec = target?.kind === 'specs' ? specs.get(target.id) : undefined;
    for (const it of items) {
      if (it.result !== 'pass') continue;
      const uri = buildRef({ kind: 'audits', id: a.id, sectionId: it.id });
      for (const { f: x } of strong.filter((h) => h.item === it)) out.push(issue('audit_pass_contradicted', uri, `${it.id} is pass with its own open ${x.severity} finding ${x.id}`));
      const crit = it.kind !== 'rule' && it.ref ? parseRef(it.ref) : null;
      if (!spec || crit?.kind !== 'specs' || crit.id !== spec.id || !crit.sectionId) continue;
      const verified = spec.sections.filter((s) => !s.archived && (s.id === crit.sectionId || s.verifiedBy.includes(crit.sectionId!)));
      const code = verified.flatMap(sectionCode);
      for (const { item: other, f: x } of strong) {
        if (other === it || x.classification !== 'code_deviates') continue;
        const hit = (x.codeRefs ?? []).find((c) => {
          const r = parseAuditCodeRef(c);
          return r && code.some((k) => overlaps(k, r));
        });
        if (hit) out.push(issue('audit_pass_contradicted', uri, `${it.id} is pass, but open ${x.severity} finding ${x.id} (${other.id}) is on the code it verifies: ${hit}`));
      }
    }
  }
  const findings = new Map<string, { codeRefs?: string[] }>();
  for (const a of live) for (const s of a.sections) for (const x of s.findings ?? []) findings.set(buildFindingRef({ audit: a.id, id: x.id }), x);
  for (const w of m.workOrders ?? []) {
    if (w.kind !== 'fix' || !OPEN_WORK_ORDER_STATUSES.includes(w.status) || !w.findings?.length) continue;
    const spec = specs.get(w.spec);
    if (!spec) continue;
    const targeted = new Set(w.sections.map((s) => s.id));
    for (const fu of w.findings) {
      const missed = new Set<string>();
      for (const c of findings.get(fu)?.codeRefs ?? []) {
        const r = parseAuditCodeRef(c);
        const owners = r ? spec.sections.filter((s) => !s.archived && sectionCode(s).some((k) => overlaps(k, r))).map((s) => s.id) : [];
        if (owners.length && !owners.some((o) => targeted.has(o))) owners.forEach((o) => missed.add(o));
      }
      if (missed.size) out.push(issue('fix_misses_finding_code', `mandate://work-orders/${w.id}`, `${fu.replace('mandate://', '')}: its code is in ${[...missed].join(', ')}, which the work order does not target`));
    }
  }
  return out;
}

/** The model with one element replaced (or added). */
export function withElement(m: Model, kind: Exclude<IntegrityKind, 'audits'>, next: unknown): Model {
  const put = <T extends { id: string }>(list: T[] | undefined, x: T) => [...(list ?? []).filter((e) => e.id !== x.id), x].sort((a, b) => a.id.localeCompare(b.id));
  if (kind === 'specs') return { ...m, specs: put(m.specs, next as StoredSpec) };
  if (kind === 'standards') return { ...m, standards: put(m.standards, next as StoredStandard) };
  if (kind === 'components') return { ...m, components: put(m.components, next as StoredComponent) };
  return { ...m, workOrders: put(m.workOrders, projectWorkOrder(next as StoredWorkOrderDoc) as WorkOrder) };
}

/** The element and its direct neighbours in a model: link sources / targets, parent / children, work orders of a spec. */
export function neighbours(m: Model, uri: string, into: Set<string>): void {
  into.add(uri);
  const [, kind, id] = /^mandate:\/\/([a-z-]+)\/(.+)$/.exec(uri) ?? [];
  for (const [k, list] of [['specs', m.specs], ['standards', m.standards], ['components', m.components ?? []]] as const) {
    for (const d of list as (StoredSpec | StoredStandard | StoredComponent)[]) {
      const self = `mandate://${k}/${d.id}`;
      for (const s of d.sections)
        for (const l of s.links) {
          const t = parseLinkTarget(l.to);
          if (!t) continue;
          const target = `mandate://${t.kind}/${t.id}`;
          if (target === uri) into.add(self);
          if (self === uri) into.add(target);
        }
      if (k === 'components') {
        const c = d as StoredComponent;
        if (c.parent && `mandate://components/${c.parent}` === uri) into.add(self);
        if (self === uri && c.parent) into.add(`mandate://components/${c.parent}`);
      }
    }
  }
  for (const w of m.workOrders ?? []) {
    if (kind === 'specs' && w.spec === id) into.add(`mandate://work-orders/${w.id}`);
    if (kind === 'work-orders' && w.id === id) into.add(`mandate://specs/${w.spec}`);
  }
}

export const countsOf = (issues: IntegrityIssue[]): IntegrityCounts => {
  const errors = issues.filter((i) => (i.severity ?? integritySeverity(i.rule)) === 'error').length;
  return { errors, warnings: issues.length - errors, total: issues.length };
};

export function diffIssues(before: IntegrityIssue[], after: IntegrityIssue[]): IntegrityDelta {
  const b = new Map(before.map((i) => [issueKey(i), i]));
  const a = new Map(after.map((i) => [issueKey(i), i]));
  return { introduced: [...a].filter(([k]) => !b.has(k)).map(([, i]) => i), resolved: [...b].filter(([k]) => !a.has(k)).map(([, i]) => i) };
}

/** Net delta of a sequence of deltas (introduced then resolved within one write cancels out). */
export function mergeDeltas(deltas: IntegrityDelta[]): IntegrityDelta {
  const intro = new Map<string, IntegrityIssue>();
  const res = new Map<string, IntegrityIssue>();
  for (const d of deltas) {
    for (const i of d.introduced) {
      const k = issueKey(i);
      if (res.has(k)) res.delete(k);
      else intro.set(k, i);
    }
    for (const i of d.resolved) {
      const k = issueKey(i);
      if (intro.has(k)) intro.delete(k);
      else res.set(k, i);
    }
  }
  return { introduced: [...intro.values()], resolved: [...res.values()] };
}

/* ---------------------------------------------------------------- per-request collection of deltas */

const collector = new AsyncLocalStorage<IntegrityDelta[]>();

/** Run a write and collect the integrity deltas of every commit it makes (cascades included). */
export async function collectIntegrity<T>(fn: () => Promise<T>): Promise<{ value: T; integrity: IntegrityDelta }> {
  const deltas: IntegrityDelta[] = [];
  const value = await collector.run(deltas, fn);
  return { value, integrity: mergeDeltas(deltas) };
}

/** A write rejected by the integrity gate: it would introduce ERROR-level issues. */
export class IntegrityViolationError extends Error {
  readonly statusCode = 409;
  readonly code = 'integrity_violation';
  constructor(readonly issues: IntegrityIssue[]) {
    super(`integrity_violation: ${issues.map((i) => `${i.rule} at ${i.uri.replace('mandate://', '')}: ${i.message}`).join('; ')}`);
  }
  get detail() {
    return { kind: 'integrity', issues: this.issues };
  }
  get hint() {
    return [...new Set(this.issues.map((i) => i.hint).filter(Boolean))].join('; ') || undefined;
  }
}

interface Token {
  head: string | null;
  scope?: Set<string>;
  before?: IntegrityIssue[];
  after?: IntegrityIssue[];
}

export class IntegrityService {
  private report?: IntegrityReport;
  private version = 0;
  private listeners = new Set<(r: IntegrityReport, counts: IntegrityCounts, delta: IntegrityDelta) => void>();
  private syncing: Promise<unknown> = Promise.resolve();
  private pendingSync = false;
  private timer?: NodeJS.Timeout;
  /** Full runs (for tests and metrics). */
  fullRuns = 0;

  constructor(
    private readonly git: GitStore,
    private readonly model: () => Promise<Model>,
    private readonly feedback: FeedbackService,
    private readonly lock?: Mutex,
    private readonly sources: IntegritySources = {},
  ) {}

  private async audits(): Promise<StoredAudit[]> {
    return this.sources.audits ? await this.sources.audits().catch(() => []) : [];
  }

  /** Drift reasons of the done specs (full runs only: it reads verification records and history). */
  private async drift(m: Model): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!this.sources.drift) return out;
    for (const spec of m.specs) {
      if (spec.status !== 'done') continue;
      const reasons = await this.sources.drift(spec, m).catch(() => []);
      if (reasons.length) out.set(spec.id, reasons);
    }
    return out;
  }

  /** Subscribe to report changes (counts + what changed). */
  onChange(fn: (r: IntegrityReport, counts: IntegrityCounts, delta: IntegrityDelta) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setReport(next: IntegrityReport): void {
    const prev = this.report;
    this.report = next;
    this.version++;
    if (!prev) return;
    const delta = diffIssues(prev.issues, next.issues);
    if (!delta.introduced.length && !delta.resolved.length) return;
    const counts = countsOf(next.issues);
    for (const fn of this.listeners) {
      try {
        fn(next, counts, delta);
      } catch {
        /* a listener never breaks a write */
      }
    }
  }

  /** Full check over the whole repository (no lock; `sync` / the periodic check take it). */
  async run(): Promise<IntegrityReport> {
    const v0 = this.version;
    const head = await this.git.resolveCommit('HEAD').catch(() => null);
    const m = await this.model();
    const feedbackWarnings = new Map((await this.feedback.list()).map((fb) => [fb.id, fb.warnings] as const));
    const report = { head, at: new Date().toISOString(), issues: checkIntegrity(m, { feedbackWarnings, audits: await this.audits(), drift: await this.drift(m) }) };
    this.fullRuns++;
    // An incremental update landed meanwhile: keep the newer report and re-check once more.
    if (this.version !== v0 && this.report && this.report.head !== head) {
      this.scheduleSync();
      return this.report;
    }
    this.setReport(report);
    return report;
  }

  /**
   * A global issue the feedback write that just committed resolved (feedback writes do not re-run the rules: hook(null)),
   * e.g. a confirmed approval override: dropped from the cached report at once (a full run agrees).
   */
  resolveIssue(rule: string, uri: string): void {
    if (!this.report || !this.report.issues.some((i) => i.rule === rule && i.uri === uri)) return;
    this.setReport({ ...this.report, at: new Date().toISOString(), issues: this.report.issues.filter((i) => !(i.rule === rule && i.uri === uri)) });
  }

  /** The last report, re-run when HEAD moved. */
  async current(): Promise<IntegrityReport> {
    const head = await this.git.resolveCommit('HEAD').catch(() => null);
    return this.report && this.report.head === head ? this.report : this.run();
  }

  /** Re-check fully when HEAD moved past the report (outside commits, pulls, merges); serialized, inside the lock. */
  sync(force = false): Promise<IntegrityReport> {
    const next = this.syncing.then(async () => {
      const go = async () => {
        const head = await this.git.resolveCommit('HEAD').catch(() => null);
        return !force && this.report && this.report.head === head ? this.report : this.run();
      };
      return this.lock ? this.lock.run(go) : go();
    });
    this.syncing = next.catch(() => undefined);
    return next;
  }

  /** Debounced background sync (never awaited by a write). */
  scheduleSync(): void {
    if (this.pendingSync) return;
    this.pendingSync = true;
    // Detached from the caller's lock hold (the lock is re-entrant): the sync must queue behind the write, not join it.
    detached(() =>
      setImmediate(() => {
        this.pendingSync = false;
        void this.sync().catch(() => undefined);
      }),
    );
  }

  /** Startup check, then a full re-check every `intervalMs` (default 10 min; 0 disables the timer). */
  start(intervalMs = 10 * 60_000): void {
    void this.sync(true).catch(() => undefined);
    if (intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.sync(true).catch(() => undefined), intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The repository hook of one kind (inside the write lock). `null` kind: writes that no integrity rule reads
   * (verifications, feedback): the report only advances to the new HEAD. Audits: only global (warning) rules read them,
   * so an audit write re-derives those (scope: the audit) and never blocks.
   */
  hook<T extends { id: string }>(kind: IntegrityKind | null): IntegrityHook<T> {
    return {
      check: async (next, current): Promise<Token> => {
        const head = await this.git.head().catch(() => null);
        if (!kind) return { head };
        const m = await this.model();
        const audits = await this.audits();
        const uri = `mandate://${kind}/${next.id}`;
        const scope = new Set<string>([uri]);
        void current;
        let after = m;
        let afterAudits = audits;
        if (kind === 'audits') afterAudits = [...audits.filter((a) => a.id !== next.id), next as unknown as StoredAudit];
        else {
          after = withElement(m, kind, next);
          neighbours(m, uri, scope);
          neighbours(after, uri, scope);
        }
        const before = checkIntegrity(m, { scope, audits });
        const afterIssues = checkIntegrity(after, { scope, audits: afterAudits });
        const d = diffIssues(before, afterIssues);
        const errors = d.introduced.filter((i) => i.severity === 'error');
        if (errors.length) throw new IntegrityViolationError(errors);
        return { head, scope, before, after: afterIssues };
      },
      committed: (token, sha) => {
        const t = token as Token | undefined;
        if (!t || !sha) return;
        if (t.before && t.after) collector.getStore()?.push(diffIssues(t.before, t.after));
        if (!this.report || this.report.head !== t.head) {
          this.scheduleSync();
          return;
        }
        const issues = t.scope ? [...this.report.issues.filter((i) => !coveredBy(i, t.scope!)), ...t.after!] : this.report.issues;
        this.setReport({ head: sha, at: new Date().toISOString(), issues });
      },
    };
  }
}
