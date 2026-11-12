import {
  type DriftCriterion,
  type DriftDetail,
  buildRef,
  OPEN_WORK_ORDER_STATUSES,
  parseRef,
  recordVerificationSchema,
  ruleCheckPlanInputSchema,
  type RuleCheckItem,
  type RuleCheckPlanInput,
  standardUsage,
  verificationRecordSchema,
  type CriterionState,
  type GateSnapshot,
  type RecordVerificationInput,
  type Section,
  type SpecVerification,
  type StandardVerification,
  type StoredSpec,
  type StoredStandard,
  type VerificationRecord,
  type VerificationRollup,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { specCodec, standardCodec } from './codecs.js';
import type { CommitMeta, WriteContext } from './GitBackedRepository.js';
import type { HistoryService } from './history.js';
import { criterionHash, newId } from './ids.js';
import type { JsonlFileRepository } from './JsonlFileRepository.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { dependencyState, finder, isCriterion, levelOf, sectionUri, specCriteria, type Kind, type Model } from './model.js';

/** Only `must` criteria in force gate `done`; `should` warns, `may` informs. */
const gating = (c: CriterionState) => (c.level ?? 'must') === 'must' && !c.upcoming;

class ValidationError extends Error {
  readonly statusCode = 400;
}

/** Moving a spec to `done` while the gate does not pass (409 `done_gate`). */
export class DoneGateError extends Error {
  readonly statusCode = 409;
  readonly code = 'done_gate';
  constructor(
    specId: string,
    readonly details: { uri: string; title: string; state: string; path?: string[] }[],
  ) {
    super(`done_gate: ${specId} cannot be done: ${details.map((d) => `${d.title} (${d.state}${d.path ? ` via ${d.path.join(' -> ')}` : ''})`).join(', ')}`);
  }
}

/** A criterion changed when its statement or verification metadata changed. */
const sameCriterion = (a: Section | undefined, b: Section | undefined) =>
  !!a && !!b && a.title === b.title && a.body === b.body && a.method === b.method && JSON.stringify(a.threshold) === JSON.stringify(b.threshold);
const sameBody = (a: Section | undefined, b: Section | undefined) => !!a && !!b && a.body === b.body;

type Doc = StoredSpec | StoredStandard;

/**
 * Verification results (append-only `verifications.jsonl`, ordered by append position) and the
 * states derived from them: verified, failing, stale (the criterion, a section listing it in
 * verifiedBy, or a following section changed after the result's commit), unverified, waived
 * (approved deviation) or unknown (the result's commit cannot be read). Inherited criteria attach
 * to the spec sections that follow them (or the whole spec via appliesTo), with provenance.
 */
export class VerificationService {
  private atCommit = new Map<string, Doc | null | undefined>();
  /** Full repository snapshot (wired by createStorage). */
  model?: () => Promise<Model>;

  constructor(
    private readonly repo: JsonlFileRepository<VerificationRecord>,
    private readonly specs: MarkdownDirRepository<StoredSpec>,
    private readonly standards: MarkdownDirRepository<StoredStandard>,
    private readonly git: GitStore,
    private readonly history: HistoryService,
  ) {}

  private repoOf(kind: Kind) {
    return kind === 'specs' ? this.specs : this.standards;
  }

  private async snapshot(): Promise<Model> {
    return this.model ? this.model() : { specs: await this.specs.list(), standards: await this.standards.list() };
  }

  /** A document at a commit (cached); `undefined` when the commit cannot be read (pin lost). */
  private async docAt(kind: Kind, id: string, commit: string): Promise<Doc | null | undefined> {
    const key = `${kind}/${id}@${commit}`;
    if (!this.atCommit.has(key)) {
      const full = await this.git.resolveCommit(commit).catch(() => null);
      let doc: Doc | null | undefined;
      if (!full) doc = undefined;
      else {
        const raw = await this.git.readFileAt(full, this.repoOf(kind).pathOf(id)).catch(() => null);
        try {
          doc = raw === null ? null : kind === 'specs' ? specCodec.decode(raw, id) : standardCodec.decode(raw, id);
        } catch {
          doc = null;
        }
      }
      this.atCommit.set(key, doc);
    }
    return this.atCommit.get(key);
  }

  async list(): Promise<VerificationRecord[]> {
    return this.repo.list();
  }

  /** Append a result. `at` and `specCommit` (full sha) are set by the server; validation runs inside the write lock. */
  async record(input: RecordVerificationInput, meta: CommitMeta = {}): Promise<VerificationRecord> {
    const parsed = recordVerificationSchema.parse(input);
    const ref = parseRef(parsed.criterion);
    if (!ref || (ref.kind !== 'specs' && ref.kind !== 'standards') || !ref.sectionId) throw new ValidationError('criterion must be a section URI');
    const appliedTo = ref.kind === 'specs' ? (parsed.appliedTo ?? buildRef({ kind: 'specs', id: ref.id })) : parsed.appliedTo;
    if (!appliedTo) throw new ValidationError('appliedTo (the spec) is required for standard criteria');
    const specCommit = parsed.specCommit ? await this.git.resolveCommit(parsed.specCommit) : await this.git.resolveCommit('HEAD');
    if (!specCommit) throw new ValidationError(parsed.specCommit ? `unknown commit '${parsed.specCommit}'` : 'repository has no commits');
    const record = verificationRecordSchema.parse({
      ...parsed,
      id: parsed.id ?? newId('vr'),
      appliedTo,
      specCommit,
      at: (meta.date ?? new Date()).toISOString(),
    });
    const { createdAt: _c, updatedAt: _u, ...stored } = record;
    return this.repo.create(stored as never, { ...meta, message: meta.message ?? `verification: ${record.result} ${record.criterion.replace('mandate://', '')}` });
  }

  /** Storage hook (inside the write lock): the criterion exists (at specCommit too), applies to the spec, spec not archived. */
  async check(r: VerificationRecord): Promise<void> {
    const ref = parseRef(r.criterion)!;
    const doc = await this.repoOf(ref.kind as Kind).get(ref.id).catch(() => null);
    const section = doc?.sections.find((s) => s.id === ref.sectionId);
    if (!section || !isCriterion(section)) throw new ValidationError(`${r.criterion} is not an acceptance section`);
    const then = await this.docAt(ref.kind as Kind, ref.id, r.specCommit);
    if (!then?.sections.some((s) => s.id === ref.sectionId)) throw new ValidationError(`${r.criterion} does not exist at ${r.specCommit}`);
    const target = parseRef(r.appliedTo);
    if (!target || target.kind !== 'specs') throw new ValidationError('appliedTo must be a spec URI');
    if (ref.kind === 'specs' && target.id !== ref.id) throw new ValidationError(`appliedTo must be ${buildRef({ kind: 'specs', id: ref.id })} for the spec's own criteria`);
    const spec = await this.specs.get(target.id);
    if (spec.status === 'archived') throw new ValidationError(`${spec.id} is archived (read-only)`);
    if (ref.kind === 'standards') {
      const m = await this.snapshot();
      if (!specCriteria(spec, m).inherited.some((c) => c.uri === r.criterion)) throw new ValidationError(`${r.criterion} does not apply to ${spec.id} (not applicable)`);
    }
  }

  /**
   * State of one criterion for one spec. `declaring`: sections (with their document) whose change
   * makes a pass stale: the sections listing it in verifiedBy and, for inherited criteria, the
   * spec sections following it.
   */
  private async state(
    uri: string,
    current: Section,
    spec: string,
    records: VerificationRecord[],
    declaring: { kind: Kind; id: string; section: Section }[],
  ): Promise<CriterionState> {
    // Append order: the last record is the latest (caller-supplied times are never trusted).
    const all = records.filter((r) => r.criterion === uri && r.appliedTo === spec).reverse();
    const history = all.filter((r) => r.result !== 'skipped');
    const base = { uri, sectionId: current.id, title: current.title, method: current.method, level: levelOf(current), type: current.type, last: all[0], history: all };
    const latest = history[0];
    if (!latest) return { ...base, state: 'unverified' };
    if (latest.result === 'fail') return { ...base, state: 'failing' };
    const ref = parseRef(uri)!;
    const then = await this.docAt(ref.kind as Kind, ref.id, latest.specCommit);
    if (then === undefined) return { ...base, state: 'unknown', staleReason: `commit ${latest.specCommit.slice(0, 7)} cannot be read (pin lost)` };
    if (!sameCriterion(then?.sections.find((s) => s.id === current.id), current)) return { ...base, state: 'stale', staleReason: 'the criterion changed after the last pass' };
    for (const d of declaring) {
      const was = (await this.docAt(d.kind, d.id, latest.specCommit))?.sections.find((s) => s.id === d.section.id);
      if (!sameBody(was, d.section)) return { ...base, state: 'stale', staleReason: `section "${d.section.title}" changed after the last pass` };
    }
    return { ...base, state: 'verified' };
  }

  private rollup(all: CriterionState[]): VerificationRollup {
    // `may` rules and rules not in force yet are informational: not counted.
    const states = all.filter((c) => c.level !== 'may' && !c.upcoming);
    return {
      total: states.length,
      verified: states.filter((s) => s.state === 'verified').length,
      failing: states.filter((s) => s.state === 'failing').length,
      stale: states.filter((s) => s.state === 'stale' || s.state === 'unknown').length,
    };
  }

  /** Own + inherited criteria of a spec (pass the spec about to be written to evaluate a change). */
  async forSpec(spec: StoredSpec, records?: VerificationRecord[], model?: Model): Promise<SpecVerification> {
    const recs = records ?? (await this.repo.list());
    const m = model ?? (await this.snapshot());
    const specUri = buildRef({ kind: 'specs', id: spec.id });
    const live = spec.sections.filter((s) => !s.archived);
    const own = await Promise.all(
      live.filter(isCriterion).map((s) =>
        this.state(
          sectionUri('specs', spec.id, s.id),
          s,
          specUri,
          recs,
          live.filter((x) => x.verifiedBy.includes(s.id)).map((section) => ({ kind: 'specs' as const, id: spec.id, section })),
        ),
      ),
    );
    const { inherited: inh, waivers } = specCriteria(spec, m);
    const groups = new Map<string, SpecVerification['inherited'][number]>();
    for (const c of inh) {
      const following = c.sections.map((id) => live.find((s) => s.id === id)).filter((s): s is Section => !!s);
      const listing = c.standard.sections.filter((s) => !s.archived && s.verifiedBy.includes(c.section.id));
      let st = await this.state(c.uri, c.section, specUri, recs, [
        ...following.map((section) => ({ kind: 'specs' as const, id: spec.id, section })),
        ...listing.map((section) => ({ kind: 'standards' as const, id: c.standard.id, section })),
      ]);
      st = { ...st, sections: c.sections, path: c.path, ...(c.upcoming ? { upcoming: true } : {}) };
      const w = waivers.get(c.uri);
      // A waiver covers the criterion when it is spec-wide (appliesTo) or every following section deviates.
      if (w) {
        const covers = c.spec || c.sections.every((sid) => w.effectiveSections.includes(sid));
        const waiver = { section: w.section, note: w.note, ...(w.feedback ? { feedback: w.feedback } : {}), ...w.state };
        st = w.state.effective && covers && st.state !== 'verified' ? { ...st, state: 'waived', waiver } : { ...st, waiver };
      }
      const key = buildRef({ kind: 'standards', id: c.standard.id });
      if (!groups.has(key)) groups.set(key, { standard: key, title: c.standard.title, criteria: [] });
      groups.get(key)!.criteria.push(st);
    }
    const inherited = [...groups.values()];
    return { own, inherited, ...this.rollup([...own, ...inherited.flatMap((i) => i.criteria)]) };
  }

  /** Rollups for many specs at once (list views). */
  async rollups(specs: StoredSpec[]): Promise<Record<string, VerificationRollup>> {
    const recs = await this.repo.list();
    const m = await this.snapshot();
    const out: Record<string, VerificationRollup> = {};
    for (const s of specs) {
      const v = await this.forSpec(s, recs, m);
      out[s.id] = { verified: v.verified, total: v.total, failing: v.failing, stale: v.stale };
    }
    return out;
  }

  /** A standard's checklist and the state of each criterion for every spec using the standard. */
  async forStandard(std: StoredStandard): Promise<StandardVerification> {
    const recs = await this.repo.list();
    const m = await this.snapshot();
    const criteria = std.sections.filter((s) => isCriterion(s) && !s.archived);
    const specs = [];
    for (const spec of m.specs) {
      if (!standardUsage(std, [spec]).length) continue;
      const v = await this.forSpec(spec, recs, m);
      const mine = v.inherited.find((g) => g.standard === buildRef({ kind: 'standards', id: std.id }))?.criteria ?? [];
      const states: Record<string, CriterionState['state']> = {};
      for (const c of mine) states[c.uri] = c.state;
      specs.push({ spec: spec.id, title: spec.title, status: spec.status, states });
    }
    return {
      criteria: criteria.map((c) => ({ uri: sectionUri('standards', std.id, c.id), sectionId: c.id, title: c.title, method: c.method, level: levelOf(c) })),
      specs,
    };
  }

  /** Everything the gate requires, as a list of failures (empty = passes). */
  private async gateFailures(spec: StoredSpec, m: Model): Promise<{ failures: DoneGateError['details']; v: SpecVerification }> {
    const v = await this.forSpec(spec, undefined, m);
    const failures: DoneGateError['details'] = [...v.own, ...v.inherited.flatMap((i) => i.criteria)]
      .filter((c) => gating(c) && c.state !== 'verified' && c.state !== 'waived')
      .map((c) => ({ uri: c.uri, title: c.title, state: c.state, ...(c.path ? { path: c.path } : {}) }));
    const f = finder(m);
    for (const s of spec.sections) {
      if (s.archived) continue;
      for (const l of s.links) {
        if (l.rel !== 'depends_on') continue;
        const st = dependencyState(l.to, f);
        if (st !== 'ok') failures.push({ uri: sectionUri('specs', spec.id, s.id), title: s.title, state: st === 'blocked' ? 'blocked' : 'broken dependency' });
      }
    }
    for (const w of m.workOrders ?? []) {
      if (w.spec === spec.id && (w.kind === 'implement' || w.kind === 'update') && OPEN_WORK_ORDER_STATUSES.includes(w.status)) {
        failures.push({ uri: buildRef({ kind: 'work-orders', id: w.id }), title: `${w.kind} work order ${w.id}`, state: 'open' });
      }
    }
    return { failures, v };
  }

  /**
   * Storage hook for specs (inside the write lock): moving to `done` requires every own and
   * inherited criterion verified or waived (approved), no Blocked / Broken section and no open
   * implement / update work order. Returns the spec with the gate snapshot (C1) recorded.
   */
  async gate(next: StoredSpec, current: StoredSpec | undefined, _ctx?: WriteContext): Promise<StoredSpec> {
    if (next.status !== 'done' || current?.status === 'done') return next;
    const m = await this.snapshot();
    const model = { ...m, specs: [...m.specs.filter((s) => s.id !== next.id), next] };
    const { failures, v } = await this.gateFailures(next, model);
    if (failures.length) throw new DoneGateError(next.id, failures);
    return { ...next, gate: await this.snapshotOf(v) };
  }

  /** The gate snapshot of a verification result set. */
  async snapshotOf(v: SpecVerification): Promise<GateSnapshot> {
    const sections = await this.sectionsByUri([...v.own, ...v.inherited.flatMap((i) => i.criteria)].map((c) => c.uri));
    return {
      commit: (await this.git.resolveCommit('HEAD')) ?? undefined,
      at: new Date().toISOString(),
      criteria: [...v.own, ...v.inherited.flatMap((i) => i.criteria)]
        .filter((c) => !c.upcoming)
        .map((c) => ({
          uri: c.uri,
          hash: criterionHash(sections.get(c.uri) ?? { title: c.title, body: '' }),
          state: c.state,
          ...(c.state === 'verified' && c.history[0] ? { record: c.history.find((r) => r.result === 'pass')?.id } : {}),
          ...(c.state === 'waived' && c.waiver?.feedback ? { feedback: c.waiver.feedback } : {}),
        })),
    };
  }

  private async sectionsByUri(uris: string[]): Promise<Map<string, Section>> {
    const out = new Map<string, Section>();
    for (const u of uris) {
      const r = parseRef(u);
      if (!r?.sectionId) continue;
      const d = await this.repoOf(r.kind as Kind).get(r.id).catch(() => null);
      const s = d?.sections.find((x) => x.id === r.sectionId);
      if (s) out.set(u, s);
    }
    return out;
  }

  /**
   * "Drifted": a done spec whose criteria no longer match its gate snapshot (criteria added, removed
   * or changed), or that would not pass the gate now. Done is never revoked automatically.
   */
  async drift(spec: StoredSpec, m: Model, records?: VerificationRecord[]): Promise<string[]> {
    return driftReasons(await this.driftDetail(spec, m, records));
  }

  /** Structured drift; null when the spec is not drifted. */
  async driftDetail(spec: StoredSpec, m: Model, records?: VerificationRecord[]): Promise<DriftDetail | null> {
    if (spec.status !== 'done') return null;
    const v = await this.forSpec(spec, records, m);
    const now = [...v.own, ...v.inherited.flatMap((i) => i.criteria)];
    const reasons = new Map<string, Set<DriftCriterion['reasons'][number]>>();
    const add = (uri: string, r: DriftCriterion['reasons'][number]) => (reasons.get(uri) ?? reasons.set(uri, new Set()).get(uri)!).add(r);
    let removed = 0;
    if (spec.gate) {
      const snap = new Map(spec.gate.criteria.map((c) => [c.uri, c]));
      const sections = await this.sectionsByUri(now.map((c) => c.uri));
      for (const c of now) {
        if (!snap.has(c.uri)) add(c.uri, 'added');
        else if (sections.get(c.uri) && criterionHash(sections.get(c.uri)!) !== snap.get(c.uri)!.hash) add(c.uri, 'changed');
      }
      removed = spec.gate.criteria.filter((c) => !now.some((x) => x.uri === c.uri)).length;
    }
    for (const c of now) if (gating(c) && c.state !== 'verified' && c.state !== 'waived') add(c.uri, 'unverified');
    const f = finder(m);
    const deps = spec.sections.filter((s) => !s.archived).flatMap((s) => s.links.filter((l) => l.rel === 'depends_on').map((l) => dependencyState(l.to, f)));
    const dependencies = (['broken', 'blocked'] as const).filter((d) => deps.includes(d));
    const order = ['added', 'changed', 'unverified'] as const;
    const criteria: DriftCriterion[] = now
      .filter((c) => reasons.has(c.uri))
      .map((c) => ({ uri: c.uri, title: c.title, state: c.state, reasons: order.filter((r) => reasons.get(c.uri)!.has(r)) }));
    const detail: DriftDetail = { gate: spec.gate ? { at: spec.gate.at, commit: spec.gate.commit } : undefined, noSnapshot: !spec.gate, removed, criteria, dependencies };
    return driftReasons(detail).length ? detail : null;
  }

  /**
   * C1.3: a write that shrinks the criteria set of a done (or claimed) spec needs a `Feedback:`
   * trailer of an accepted item. Returns the removed criteria (empty = no shrink).
   */
  async shrunk(next: StoredSpec, current: StoredSpec, m: Model): Promise<string[]> {
    const before = await this.forSpec(current, [], { ...m, specs: m.specs.map((s) => (s.id === current.id ? current : s)) });
    const after = await this.forSpec(next, [], { ...m, specs: m.specs.map((s) => (s.id === next.id ? next : s)) });
    const now = new Set([...after.own, ...after.inherited.flatMap((i) => i.criteria)].map((c) => c.uri));
    return [...before.own, ...before.inherited.flatMap((i) => i.criteria)].filter((c) => !now.has(c.uri)).map((c) => c.uri);
  }

  /** Automated checks to run for a spec: inherited rules with a lint / test / script check (for agents and CI). */
  async ruleCheckPlan(input: RuleCheckPlanInput): Promise<RuleCheckItem[]> {
    const { spec: ref } = ruleCheckPlanInputSchema.parse(input);
    const id = parseRef(ref)?.id ?? ref;
    const spec = await this.specs.get(id);
    const m = await this.snapshot();
    const v = await this.forSpec(spec, undefined, m);
    const sections = new Map((await Promise.all(m.standards.map(async (s) => s.sections.map((x) => [sectionUri('standards', s.id, x.id), x] as const)))).flat());
    const out: RuleCheckItem[] = [];
    for (const c of v.inherited.flatMap((g) => g.criteria)) {
      const sec = sections.get(c.uri);
      if (!sec?.check || sec.check.kind === 'review' || c.upcoming) continue;
      out.push({ criterion: c.uri, title: c.title, level: c.level ?? 'should', check: sec.check, state: c.state, sections: c.sections ?? [], ...(c.path ? { path: c.path } : {}) });
    }
    const order = { must: 0, should: 1, may: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  historyOf(id: string) {
    return this.history.mentioning(id);
  }
}

/** Drift as sentences (MCP `drift` field, tooltips, the Ask agent). */
export function driftReasons(d: DriftDetail | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  const titles = (r: DriftCriterion['reasons'][number]) => d.criteria.filter((c) => c.reasons.includes(r));
  if (d.noSnapshot) out.push('No gate snapshot (done before snapshots were recorded)');
  const added = titles('added');
  const changed = titles('changed');
  const bad = titles('unverified');
  if (added.length) out.push(`${added.length} criteria added since done: ${added.map((c) => c.title).join(', ')}`);
  if (d.removed) out.push(`${d.removed} criteria removed since done`);
  if (changed.length) out.push(`${changed.length} criteria changed since done: ${changed.map((c) => c.title).join(', ')}`);
  if (bad.length) out.push(`${bad.length} criteria not verified now: ${bad.map((c) => `${c.title} (${c.state})`).join(', ')}`);
  if (d.dependencies.includes('broken')) out.push('A depends_on target is archived or missing');
  if (d.dependencies.includes('blocked')) out.push('A depends_on target is not implemented');
  return out;
}
