/**
 * Document READ service: list / get for specs, standards, sections, work orders, feedback and verifications,
 * plus history and structured diffs. Each method parses its input with the strict schema from `@mandate/shared`
 * (throws ZodError) and throws `ReadError` / `NotFoundError` for domain problems, so the MCP read tools (and REST)
 * wrap it 1:1.
 */
import { maturities } from './maturity.js';
import { diffDocs, sectionLineRange, type DocFormat, type Section } from '@mandate/doc';
import {
  buildRef,
  ownerOf,
  diffGetInputSchema,
  feedbackGetInputSchema,
  feedbackListInputSchema,
  historyGetInputSchema,
  parseRef,
  specGetInputSchema,
  specListInputSchema,
  specSectionGetInputSchema,
  standardGetInputSchema,
  standardListInputSchema,
  standardSectionGetInputSchema,
  standardUsage,
  verificationListInputSchema,
  workOrderGetInputSchema,
  workOrderListInputSchema,
  type CriterionState,
  type DiffGetInput,
  type FeedbackGetInput,
  type FeedbackListInput,
  type HistoryGetInput,
  type MandateRef,
  type SpecGetInput,
  type SpecListInput,
  type SpecSectionGetInput,
  type StandardGetInput,
  type StandardListInput,
  type StandardSectionGetInput,
  type StoredSpec,
  type StoredComponent,
  type StoredStandard,
  type VerificationListInput,
  type VerificationRollup,
  type WorkOrderGetInput,
  type WorkOrderListInput,
} from '@mandate/shared';
import { auditCodec, auditFormat, componentCodec, componentFormat, specCodec, specFormat, standardCodec, standardFormat, workOrderCodec, workOrderFormat } from './codecs.js';
import { deriveComponents } from './components.js';
import { NotFoundError } from './GitBackedRepository.js';
import type { Storage } from './index.js';

type DocKind = 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';
type AnyDoc = StoredSpec | StoredStandard | StoredComponent;
const formatOf = (kind: DocKind) => (kind === 'specs' ? specFormat : kind === 'standards' ? standardFormat : kind === 'audits' ? auditFormat : kind === 'work-orders' ? workOrderFormat : componentFormat) as DocFormat<unknown, unknown>;

/** A domain error with a machine-readable code and a hint for the caller (agents self-correct from it). */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
    readonly path?: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

function paginate<T>(all: T[], limit: number, cursor?: string): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const items = all.slice(start, start + limit);
  const next = start + limit;
  return { items, total: all.length, nextCursor: next < all.length ? String(next) : null };
}

/** A stored doc without section bodies: id, frontmatter fields and the section count. */
function frontmatterOf(d: AnyDoc): Record<string, unknown> & { id: string; sections: number } {
  const { sections, ...rest } = d as AnyDoc & Record<string, unknown>;
  return { ...rest, id: d.id, sections: (sections as unknown[]).length };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `login-sso` or any reference form -> parsed ref of `kind`. */
function toRef(kind: MandateRef['kind'], value: string): MandateRef {
  if (SLUG_RE.test(value)) return { kind, id: value };
  const r = parseRef(value);
  if (!r || r.kind !== kind) throw new ReadError(`expected a ${kind} reference, got '${value}'`, 'invalid_ref', `use an id or mandate://${kind}/<id>`, 'ref');
  return r;
}

const sectionMeta = (s: Section) => {
  const { body: _body, id: _id, title: _title, type: _type, summary: _summary, ...meta } = s as Section & Record<string, unknown>;
  return meta;
};

export class DocReadService {
  constructor(private readonly storage: Storage) {}

  private repo(kind: DocKind) {
    return kind === 'specs' ? this.storage.specs : kind === 'standards' ? this.storage.standards : kind === 'audits' ? this.storage.audits : kind === 'work-orders' ? this.storage.workOrderDocs : this.storage.components;
  }

  /** Full sha of a commit-ish (short shas, HEAD); ReadError when unknown. */
  async commitOf(ref: string, path = 'at'): Promise<string> {
    const full = await this.storage.git.resolveCommit(ref);
    if (!full) throw new ReadError(`unknown commit '${ref}'`, 'unknown_commit', 'give a sha from history_get or history_search (4-40 hex chars)', path, 404);
    return full;
  }

  /** The commit a read pins: `@sha` in the reference and/or `at` (they must agree). Null = working tree / HEAD. */
  private async pin(ref: MandateRef, at?: string): Promise<string | null> {
    const a = ref.commit ? await this.commitOf(ref.commit, 'ref') : null;
    const b = at && at !== 'HEAD' ? await this.commitOf(at) : null;
    if (a && b && a !== b) throw new ReadError(`the reference pins ${a.slice(0, 7)} but at is ${b.slice(0, 7)}`, 'conflicting_versions', 'give the version once: either @sha in the reference or at', 'at');
    return a ?? b;
  }

  /** A spec / standard at HEAD (working tree) or at `commit`, with its raw text. */
  async readDoc(kind: DocKind, id: string, commit: string | null): Promise<{ doc: AnyDoc; raw: string }> {
    const repo = this.repo(kind);
    const raw = commit ? await this.storage.git.readFileAt(commit, repo.pathOf(id)) : await repo.raw(id);
    if (raw === null) {
      throw new NotFoundError(`${kind}/${id} does not exist${commit ? ` at ${commit.slice(0, 7)}` : ''}`);
    }
    const doc = kind === 'specs' ? specCodec.decode(raw, id) : kind === 'standards' ? standardCodec.decode(raw, id) : kind === 'audits' ? (auditCodec.decode(raw, id) as unknown as StoredComponent) : kind === 'work-orders' ? (workOrderCodec.decode(raw, id) as unknown as StoredComponent) : (componentCodec.decode(raw, id) as StoredComponent);
    return { doc, raw };
  }

  private sectionView(kind: DocKind, docId: string, commit: string | null, raw: string, s: Section, body: boolean) {
    const loc = sectionLineRange(raw, s.id);
    return {
      uri: buildRef({ kind, id: docId, sectionId: s.id, ...(commit ? { commit } : {}) }),
      id: s.id,
      title: s.title,
      type: s.type,
      ...(s.summary ? { summary: s.summary } : {}),
      ...(loc ? { lines: { start: loc.start, end: loc.end } } : {}),
      meta: sectionMeta(s),
      ...(body ? { body: s.body } : {}),
    };
  }

  /* ---------------------------------------------------------------- specs & standards */

  async specList(input: SpecListInput) {
    const inp = specListInputSchema.parse(input);
    let specs = await this.storage.specs.list();
    const q = inp.q?.toLowerCase();
    if (q) specs = specs.filter((s) => s.id.includes(q) || s.title.toLowerCase().includes(q));
    if (inp.status) specs = specs.filter((s) => inp.status!.includes(s.status));
    if (inp.category) specs = specs.filter((s) => !!s.category && inp.category!.includes(s.category));
    if (inp.repo) specs = specs.filter((s) => !!s.repo && inp.repo!.includes(s.repo));
    if (inp.tags) specs = specs.filter((s) => s.tags.some((t) => inp.tags!.includes(t)));
    if (inp.standard) {
      const std = await this.storage.standards.get(inp.standard);
      const using = new Set(standardUsage(std, specs).map((u) => u.specId));
      specs = specs.filter((s) => using.has(s.id));
    }
    const blocked = await this.storage.linkService.blockedSections(specs);
    if (inp.blocked !== undefined) specs = specs.filter((s) => (blocked[s.id]?.length ?? 0) > 0 === inp.blocked);
    const rollups = await this.storage.verificationService.rollups(specs);
    if (inp.verification) specs = specs.filter((s) => inp.verification!.some((v) => matchesRollup(rollups[s.id], v)));
    const audits = await this.storage.auditService.lastAudits(specs.map((s) => s.id));
    const mat = await maturities(this.storage, specs);
    if (inp.maturity) specs = specs.filter((s) => inp.maturity!.some((f) => mat[s.id]!.step === f || mat[s.id]!.overlays.some((o) => o.kind === f)));
    if (inp.audit) {
      specs = specs.filter((s) => {
        const a = audits[s.id];
        return inp.audit!.some((f) => (f === 'never' ? !a : !!a && (f === 'stale' ? a.stale : f === 'open_findings' ? a.openFindings > 0 : a.result === f)));
      });
    }
    const metas = await Promise.all(specs.map((s) => this.storage.history.meta(this.storage.specs.pathOf(s.id))));
    const items = specs
      .map((s, i) => ({
        uri: buildRef({ kind: 'specs', id: s.id }),
        // Every frontmatter field as stored (follows the data model; no per-field mapping).
        ...frontmatterOf(s),
        updatedAt: metas[i]!.updatedAt,
        updatedBy: metas[i]!.updatedBy,
        verification: rollups[s.id],
        blockedSections: blocked[s.id] ?? [],
        lastAudit: audits[s.id] ?? null,
        maturity: mat[s.id],
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return paginate(items, inp.limit, inp.cursor);
  }

  async standardList(input: StandardListInput) {
    const inp = standardListInputSchema.parse(input);
    let stds = await this.storage.standards.list();
    const q = inp.q?.toLowerCase();
    if (q) stds = stds.filter((s) => s.id.includes(q) || s.title.toLowerCase().includes(q));
    if (inp.tags) stds = stds.filter((s) => s.tags.some((t) => inp.tags!.includes(t)));
    const specs = (await this.storage.specs.list()).filter((s) => s.status !== 'archived');
    const metas = await Promise.all(stds.map((s) => this.storage.history.meta(this.storage.standards.pathOf(s.id))));
    const audits = await this.storage.auditService.lastAudits(stds.map((s) => s.id), undefined, 'standards');
    const items = stds
      .map((s, i) => ({
        uri: buildRef({ kind: 'standards', id: s.id }),
        ...frontmatterOf(s),
        usedBy: standardUsage(s, specs).length,
        lastAudit: audits[s.id] ?? null,
        updatedAt: metas[i]!.updatedAt,
        updatedBy: metas[i]!.updatedBy,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return paginate(items, inp.limit, inp.cursor);
  }

  specGet(input: SpecGetInput) {
    return this.docGet('specs', specGetInputSchema.parse(input));
  }
  standardGet(input: StandardGetInput) {
    return this.docGet('standards', standardGetInputSchema.parse(input));
  }

  private async docGet(kind: DocKind, inp: { ref: string; at?: string; metadataOnly: boolean; sections?: string[] }) {
    const ref = toRef(kind, inp.ref);
    const commit = await this.pin(ref, inp.at);
    const { doc, raw } = await this.readDoc(kind, ref.id, commit);
    const wanted = inp.sections ?? (ref.sectionId ? [ref.sectionId] : undefined);
    const missing = wanted?.filter((id) => !doc.sections.some((s) => s.id === id)) ?? [];
    if (missing.length) {
      throw new ReadError(`no section ${missing.map((m) => `'${m}'`).join(', ')} in ${kind}/${ref.id}`, 'unknown_section', `sections: ${doc.sections.map((s) => s.id).join(', ')}`, 'sections', 404);
    }
    const { sections, id: _id, ...frontmatter } = doc as AnyDoc & Record<string, unknown>;
    const picked = wanted ? (sections as Section[]).filter((s) => wanted.includes(s.id)) : (sections as Section[]);
    const atHead = commit === null;
    const out: Record<string, unknown> = {
      uri: buildRef({ kind, id: ref.id, ...(commit ? { commit } : {}) }),
      id: ref.id,
      commit,
      frontmatter,
      sections: picked.map((s) => this.sectionView(kind, ref.id, commit, raw, s, !inp.metadataOnly)),
    };
    if (atHead) out.meta = await this.storage.history.meta(this.repo(kind).pathOf(ref.id));
    if (atHead && !inp.metadataOnly) {
      if (kind === 'specs') {
        out.verification = slimVerification(await this.storage.verificationService.forSpec(doc as StoredSpec));
        out.implementation = await this.storage.workOrderService.implementation(ref.id);
        out.maturity = (await maturities(this.storage, [doc as StoredSpec]))[ref.id];
      } else if (kind === 'standards') {
        out.verification = await this.storage.verificationService.forStandard(doc as StoredStandard);
      } else if (kind === 'audits') {
        out.audit = (await this.storage.auditService.get(ref.id)).audit;
      } else if (kind === 'work-orders') {
        out.workOrder = await this.storage.workOrderService.resolve(ref.id);
      } else {
        out.derived = (await this.componentDerived([doc as StoredComponent]))[ref.id];
      }
      if (kind !== 'audits' && kind !== 'work-orders') out.links = await this.storage.linkService.forDoc(kind as 'specs', doc);
    }
    return out;
  }

  specSectionGet(input: SpecSectionGetInput) {
    return this.sectionGet('specs', specSectionGetInputSchema.parse(input));
  }
  standardSectionGet(input: StandardSectionGetInput) {
    return this.sectionGet('standards', standardSectionGetInputSchema.parse(input));
  }

  private async sectionGet(kind: DocKind, inp: { ref?: string; doc?: string; section?: string; at?: string }) {
    const ref: MandateRef = inp.ref ? toRef(kind, inp.ref) : { ...toRef(kind, inp.doc!), sectionId: inp.section! };
    const commit = await this.pin(ref, inp.at);
    const { doc, raw } = await this.readDoc(kind, ref.id, commit);
    const s = doc.sections.find((x) => x.id === ref.sectionId);
    if (!s) {
      throw new ReadError(`no section '${ref.sectionId}' in ${kind}/${ref.id}${commit ? ` at ${commit.slice(0, 7)}` : ''}`, 'unknown_section', `sections: ${doc.sections.map((x) => x.id).join(', ')}`, 'ref', 404);
    }
    const lines = raw.split('\n');
    let excerpt: { lines: { start: number; end: number }; text: string } | undefined;
    if (ref.lines) {
      if (ref.lines.start > lines.length) {
        throw new ReadError(`line ${ref.lines.start} is past the end of the file (${lines.length} lines)`, 'invalid_lines', 'line numbers refer to the stored .md file', 'ref');
      }
      excerpt = { lines: ref.lines, text: lines.slice(ref.lines.start - 1, ref.lines.end).join('\n') };
    }
    return {
      docUri: buildRef({ kind, id: ref.id, ...(commit ? { commit } : {}) }),
      docTitle: doc.title,
      ...(kind !== 'standards' ? { docStatus: (doc as StoredSpec | StoredComponent).status } : {}),
      commit,
      section: this.sectionView(kind, ref.id, commit, raw, s, true),
      ...(excerpt ? { excerpt } : {}),
    };
  }

  /* ---------------------------------------------------------------- components */

  private async componentDerived(comps: StoredComponent[]) {
    return deriveComponents(comps, await this.storage.model(), { verification: this.storage.verificationService, links: this.storage.linkService });
  }

  /** Components (id order) with frontmatter and derived counts; filters kind, status, repo (owns code there), tags, q. */
  async componentList(inp: { kind?: string[]; status?: string[]; repo?: string[]; tags?: string[]; q?: string; limit: number; cursor?: string }) {
    let comps = await this.storage.components.list();
    const q = inp.q?.toLowerCase();
    if (q) comps = comps.filter((c) => c.id.includes(q) || c.title.toLowerCase().includes(q));
    if (inp.kind) comps = comps.filter((c) => inp.kind!.includes(c.kind));
    if (inp.status) comps = comps.filter((c) => inp.status!.includes(c.status));
    if (inp.repo) comps = comps.filter((c) => c.owns.some((o) => inp.repo!.includes(o.repo)));
    if (inp.tags) comps = comps.filter((c) => c.tags.some((t) => inp.tags!.includes(t)));
    const d = await this.componentDerived(comps);
    const items = comps
      .map((c) => ({
        uri: buildRef({ kind: 'components', id: c.id }),
        ...frontmatterOf(c),
        dependsOn: d[c.id]!.dependsOn,
        dependents: d[c.id]!.dependents,
        specs: d[c.id]!.affectedBy.length,
        openWorkOrders: d[c.id]!.workOrders.length,
        openFeedback: d[c.id]!.openFeedback,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return paginate(items, inp.limit, inp.cursor);
  }
  componentGet(inp: { ref: string; at?: string; metadataOnly?: boolean; sections?: string[] }) {
    return this.docGet('components', { ...inp, metadataOnly: inp.metadataOnly ?? false });
  }
  componentSectionGet(inp: { ref?: string; doc?: string; section?: string; at?: string }) {
    return this.sectionGet('components', inp);
  }
  auditDocGet(inp: { ref: string; at?: string; metadataOnly?: boolean; sections?: string[] }) {
    return this.docGet('audits', { ...inp, metadataOnly: inp.metadataOnly ?? false });
  }
  auditSectionGet(inp: { ref?: string; doc?: string; section?: string; at?: string }) {
    return this.sectionGet('audits', inp);
  }
  /** One section of a work order (plan, reconciliation, outcome or a wo-section), at HEAD or a version. */
  workOrderSectionGet(inp: { ref?: string; doc?: string; section?: string; at?: string }) {
    return this.sectionGet('work-orders', inp);
  }
  /** The owning component of a code path (most specific `owns` glob wins; archived components own nothing), or null. */
  async codeOwner(inp: { repo?: string; path: string }) {
    const o = ownerOf(inp.repo, inp.path.replace(/^\.?\//, ''), await this.storage.components.list());
    const c = o?.component;
    // Work orders that changed this file (their touched list), newest first.
    const p = inp.path.replace(/^\.?\//, '');
    const workOrders = (await this.storage.workOrderService.list())
      .flatMap((w) => (w.touched ?? []).filter((t) => (!inp.repo || t.repo === inp.repo) && (t.path === p || t.from === p)).map((t) => ({ uri: buildRef({ kind: 'work-orders', id: w.id }), id: w.id, title: w.title ?? w.id, status: w.status, kind: w.kind, repo: t.repo, change: t.change, ...(t.lines ? { lines: t.lines } : {}), updatedAt: w.updatedAt })))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { repo: inp.repo ?? null, path: inp.path, owner: c ? { uri: buildRef({ kind: 'components', id: c.id }), id: c.id, title: c.title, kind: c.kind, status: c.status, glob: o.glob } : null, workOrders };
  }

  /* ---------------------------------------------------------------- work orders, feedback, verifications */

  async workOrderList(input: WorkOrderListInput) {
    const inp = workOrderListInputSchema.parse(input);
    let items = await this.storage.workOrderService.list();
    if (inp.status) items = items.filter((w) => inp.status!.includes(w.status));
    if (inp.kind) items = items.filter((w) => inp.kind!.includes(w.kind));
    if (inp.spec) {
      const id = toRef('specs', inp.spec).id;
      items = items.filter((w) => w.spec === id);
    }
    return paginate(
      items.map((w) => ({ uri: buildRef({ kind: 'work-orders', id: w.id }), ...w })),
      inp.limit,
      inp.cursor,
    );
  }

  async workOrderGet(input: WorkOrderGetInput) {
    const inp = workOrderGetInputSchema.parse(input);
    const id = toRef('work-orders', inp.ref).id;
    const at = inp.at && inp.at !== 'HEAD' ? await this.commitOf(inp.at) : undefined;
    return { uri: buildRef({ kind: 'work-orders', id }), ...(await this.storage.workOrderService.resolve(id, { at, depth: inp.depth })) };
  }

  async feedbackList(input: FeedbackListInput) {
    const inp = feedbackListInputSchema.parse(input);
    let items = await this.storage.feedbackService.list();
    if (inp.status) items = items.filter((f) => inp.status!.includes(f.status));
    if (inp.kind) items = items.filter((f) => inp.kind!.includes(f.kind));
    if (inp.target) {
      const t = parseRef(inp.target)!;
      items = items.filter((f) =>
        f.targets.some((x) => {
          const r = parseRef(x);
          return !!r && r.kind === t.kind && r.id === t.id && (!t.sectionId || r.sectionId === t.sectionId);
        }),
      );
    }
    return paginate(
      items.map((f) => ({ uri: buildRef({ kind: 'feedback', id: f.id }), ...f })),
      inp.limit,
      inp.cursor,
    );
  }

  async feedbackGet(input: FeedbackGetInput) {
    const inp = feedbackGetInputSchema.parse(input);
    const id = toRef('feedback', inp.ref).id;
    return { uri: buildRef({ kind: 'feedback', id }), ...(await this.storage.feedbackService.resolve(id)) };
  }

  async verificationList(input: VerificationListInput) {
    const inp = verificationListInputSchema.parse(input);
    let criterion: string | undefined;
    if (inp.criterion) {
      const r = parseRef(inp.criterion)!;
      criterion = buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId });
      const { doc } = await this.readDoc(r.kind as DocKind, r.id, null);
      const s = doc.sections.find((x) => x.id === r.sectionId);
      if (!s) throw new ReadError(`no section '${r.sectionId}' in ${r.kind}/${r.id}`, 'unknown_section', undefined, 'criterion', 404);
      if (s.type !== 'acceptance') throw new ReadError(`${criterion} is a ${s.type} section, not an acceptance criterion`, 'not_a_criterion', 'criteria are sections of type acceptance', 'criterion');
    }
    const specId = inp.spec ? toRef('specs', inp.spec).id : undefined;
    const spec = specId ? await this.storage.specs.get(specId) : undefined;
    const specUri = specId ? buildRef({ kind: 'specs', id: specId }) : undefined;
    let records = await this.storage.verificationService.list();
    if (criterion) records = records.filter((r) => r.criterion === criterion);
    if (specUri) records = records.filter((r) => r.appliedTo === specUri);
    if (inp.result) records = records.filter((r) => inp.result!.includes(r.result));
    records = [...records].reverse(); // newest first
    const page = paginate(records, inp.limit, inp.cursor);
    let criteria: (Omit<CriterionState, 'history'> & { spec: string; results: number })[] | undefined;
    if (spec || inp.state) {
      const specs = spec ? [spec] : (await this.storage.specs.list()).filter((s) => s.status !== 'archived');
      criteria = [];
      for (const s of specs) {
        const v = await this.storage.verificationService.forSpec(s);
        for (const c of [...v.own, ...v.inherited.flatMap((i) => i.criteria)]) {
          if (criterion && c.uri !== criterion) continue;
          if (inp.state && !inp.state.includes(c.state)) continue;
          const { history, ...rest } = c;
          criteria.push({ ...rest, spec: buildRef({ kind: 'specs', id: s.id }), results: history.length });
        }
      }
    }
    return { ...page, ...(criteria ? { criteria } : {}) };
  }

  /* ---------------------------------------------------------------- history & diff */

  async historyGet(input: HistoryGetInput) {
    const inp = historyGetInputSchema.parse(input);
    const ref = parseRef(inp.ref)!;
    let entries;
    switch (ref.kind) {
      case 'specs':
      case 'standards': {
        const file = this.repo(ref.kind).pathOf(ref.id);
        entries = await this.storage.history.log(file);
        if (!entries.length) throw new NotFoundError(`${ref.kind}/${ref.id} has no history`);
        break;
      }
      case 'components':
      case 'audits': {
        entries = await this.storage.history.log(this.repo(ref.kind).pathOf(ref.id));
        if (!entries.length) throw new NotFoundError(`${ref.kind}/${ref.id} has no history`);
        break;
      }
      case 'work-orders':
        await this.storage.workOrderService.get(ref.id);
        // Commits mentioning the id (the jsonl era and the document); a section: the document's own commits.
        entries = ref.sectionId ? await this.storage.history.log(this.repo('work-orders').pathOf(ref.id)) : await this.storage.workOrderService.historyOf(ref.id);
        break;
      case 'feedback':
        await this.storage.feedbackService.get(ref.id);
        entries = await this.storage.feedbackService.historyOf(ref.id);
        break;
    }
    // Only the commits a given user triggered (older agent-only commits never match).
    if (inp.user) entries = entries.filter((e) => e.user === inp.user);
    if (ref.sectionId) return this.sectionHistory(ref.kind as DocKind, ref.id, ref.sectionId, entries, inp.limit);
    return { uri: buildRef({ kind: ref.kind, id: ref.id }), total: entries.length, entries: entries.slice(0, inp.limit) };
  }

  /** Commits that changed one section (diffDocs of each document version against the previous one), newest first. */
  private async sectionHistory(kind: DocKind, id: string, sectionId: string, docEntries: Awaited<ReturnType<Storage['history']['log']>>, limit: number) {
    const file = this.repo(kind).pathOf(id);
    const format = formatOf(kind);
    const texts = await Promise.all(docEntries.map((e) => this.storage.git.readFileAt(e.commit, file)));
    const entries = [];
    let seen = false;
    for (let i = 0; i < docEntries.length; i++) {
      let d;
      try {
        d = diffDocs(format, texts[i + 1] ?? null, texts[i] ?? null).sections.find((x) => x.id === sectionId);
      } catch {
        continue; // a version that does not parse (hand edit) cannot be attributed to a section
      }
      if (!d) continue;
      seen = true;
      if (d.status === 'unchanged' && !d.moved) continue;
      const action = d.status === 'unchanged' ? 'moved' : d.status;
      entries.push({
        ...docEntries[i]!,
        section: {
          action,
          title: d.after?.title ?? d.before?.title,
          ...(d.title ? { titleChanged: d.title } : {}),
          ...(d.meta.length ? { metaChanged: d.meta.map((m) => m.key) } : {}),
          ...(d.body ? { bodyChanged: d.body.ops.some((o) => o.op !== 'equal') } : {}),
          moved: d.moved,
        },
      });
    }
    if (!seen) throw new ReadError(`no section '${sectionId}' in the history of ${kind}/${id}`, 'unknown_section', 'list sections with spec_get metadataOnly', 'ref', 404);
    return { uri: buildRef({ kind, id, sectionId }), total: entries.length, entries: entries.slice(0, limit) };
  }

  async diffGet(input: DiffGetInput) {
    const inp = diffGetInputSchema.parse(input);
    const ref = parseRef(inp.ref)!;
    const kind = ref.kind as DocKind;
    const from = await this.commitOf(inp.from, 'from');
    const to = inp.to && inp.to !== 'HEAD' ? await this.commitOf(inp.to, 'to') : null;
    const file = this.repo(kind).pathOf(ref.id);
    const before = await this.storage.git.readFileAt(from, file);
    const after = to ? await this.storage.git.readFileAt(to, file) : await this.repo(kind).raw(ref.id);
    if (before === null && after === null) throw new NotFoundError(`${kind}/${ref.id} exists at neither ${from.slice(0, 7)} nor ${to ? to.slice(0, 7) : 'HEAD'}`);
    const format = formatOf(kind);
    const d = diffDocs(format, before, after);
    const sections = ref.sectionId ? d.sections.filter((s) => s.id === ref.sectionId) : d.sections;
    return {
      uri: buildRef({ kind, id: ref.id, ...(ref.sectionId ? { sectionId: ref.sectionId } : {}) }),
      from,
      to: to ?? (await this.storage.git.head()),
      status: d.status,
      frontmatter: d.frontmatter,
      stats: d.stats,
      sections: inp.full ? sections : sections.filter((s) => s.status !== 'unchanged' || s.moved).map(({ before: _b, after: _a, ...rest }) => rest),
      ...(inp.full ? { before: d.before, after: d.after } : {}),
    };
  }
}

function matchesRollup(r: VerificationRollup | undefined, state: string): boolean {
  if (!r) return state === 'none';
  switch (state) {
    case 'none':
      return r.total === 0;
    case 'verified':
      return r.total > 0 && r.verified === r.total;
    case 'failing':
      return r.failing > 0;
    case 'stale':
      return r.stale > 0;
    case 'unverified':
      return r.verified < r.total;
    default:
      return false;
  }
}

/** Verification detail without per-criterion result histories (they can be long). */
function slimVerification<T extends { own: CriterionState[]; inherited: { criteria: CriterionState[] }[] }>(v: T) {
  const slim = (c: CriterionState) => {
    const { history, ...rest } = c;
    return { ...rest, results: history.length };
  };
  return { ...v, own: v.own.map(slim), inherited: v.inherited.map((i) => ({ ...i, criteria: i.criteria.map(slim) })) };
}
