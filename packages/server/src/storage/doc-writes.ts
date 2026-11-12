/**
 * Section-level writes on specs and standards (insert / update / move / archive, link add / remove), document
 * metadata, and `diffSinceImplemented`. Every change is a whole-document update through the repository, so the
 * write-time rules (DocRules: transitions, identity, links, criteria shrink, done gate) run inside the write lock,
 * and the document is serialized and validated (round trip) before anything is written: never a partial write.
 */
import { diffDocs, sectionAdvice, type DocFormat, type Section } from '@mandate/doc';
import { buildRef, parseRef, type SectionCreate, type StoredComponent, type StoredSpec, type StoredStandard } from '@mandate/shared';
import { componentCodec, componentFormat, specCodec, specFormat, standardCodec, standardFormat } from './codecs.js';
import { NotFoundError, type CommitMeta } from './GitBackedRepository.js';
import type { Storage } from './index.js';

export type DocKind = 'specs' | 'standards' | 'components';
type Doc = StoredSpec | StoredStandard | StoredComponent;
const SINGULAR: Record<DocKind, string> = { specs: 'spec', standards: 'standard', components: 'component' };

/** A domain error with an agent-actionable code. */
export class WriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

export interface Placement {
  after?: string;
  before?: string;
  position?: 'first' | 'last';
}

export interface WriteOutcome<T> {
  value: T;
  /** Commits made by this write (cascades included), oldest first. */
  commits: string[];
  /** Non-blocking advice (summary missing / stale, section over the soft limit, ...). */
  warnings: string[];
}

const SECTION_PATCH_KEYS = ['title', 'type', 'summary', 'body', 'refs', 'symbols', 'verifiedBy', 'method', 'threshold', 'level', 'rationale', 'scope', 'check', 'examples'] as const;

export class DocWriteService {
  constructor(
    private readonly storage: Storage,
    private readonly opts: { sectionSoftLimitTokens?: number } = {},
  ) {}

  private repo(kind: DocKind) {
    return kind === 'specs' ? this.storage.specs : kind === 'standards' ? this.storage.standards : this.storage.components;
  }
  private format(kind: DocKind) {
    return (kind === 'specs' ? specFormat : kind === 'standards' ? standardFormat : componentFormat) as DocFormat<unknown, unknown>;
  }

  /** A document id from an id or reference; a pinned `@sha` must be the document's current version (optimistic check). */
  async resolveDoc(kind: DocKind, refOrId: string): Promise<{ id: string; sectionId?: string; doc: Doc }> {
    const r = parseRef(refOrId);
    const id = r ? r.id : refOrId;
    if (r && r.kind !== kind) throw new WriteError('validation', `expected a ${kind} reference, got ${r.kind}`, 400);
    const doc = (await this.repo(kind).get(id)) as Doc;
    if (r?.commit) {
      const pinned = await this.storage.git.resolveCommit(r.commit);
      const current = (await this.storage.history.meta(this.repo(kind).pathOf(id))).lastCommit;
      if (!pinned) throw new WriteError('not_found', `unknown commit '${r.commit}'`, 404);
      if (current && pinned !== current) {
        throw new WriteError('stale_version', `${kind}/${id} changed since ${r.commit.slice(0, 7)} (now ${current.slice(0, 7)})`, 409, 're-read the document and retry with the current reference (or drop @sha)');
      }
    }
    return { id, sectionId: r?.sectionId, doc };
  }

  private section(kind: DocKind, doc: Doc, sectionId: string): Section {
    const s = doc.sections.find((x) => x.id === sectionId);
    if (!s) throw new NotFoundError(`no section '${sectionId}' in ${kind}/${doc.id} (sections: ${doc.sections.map((x) => x.id).join(', ')})`);
    return s;
  }

  /** Serialize + validate the whole document (round trip) and collect advice for the touched sections. */
  private check(kind: DocKind, next: Doc, touched: string[]): string[] {
    const codec = kind === 'specs' ? specCodec : kind === 'standards' ? standardCodec : componentCodec;
    const md = codec.encode(next as never); // throws DocError when the document would not round-trip
    const v = this.format(kind).validate(md);
    if (!v.ok) throw new WriteError('validation', v.issues.map((i) => i.message).join('; '), 400);
    const sections = next.sections.filter((s) => touched.includes(s.id));
    return [
      ...new Set([
        ...sectionAdvice(sections, { sectionSoftLimitTokens: this.opts.sectionSoftLimitTokens ?? 600 }).map((w) => w.message),
        ...v.warnings.filter((w) => w.sectionId && touched.includes(w.sectionId)).map((w) => w.message),
      ]),
    ];
  }

  private async write<T>(fn: (meta: CommitMeta) => Promise<T>, meta: CommitMeta): Promise<{ value: T; commits: string[] }> {
    const commits: string[] = [];
    const value = await fn({
      ...meta,
      onCommit: (sha) => {
        commits.push(sha);
        meta.onCommit?.(sha);
      },
    });
    return { value, commits };
  }

  private async saveSections(kind: DocKind, doc: Doc, sections: Section[], touched: string[], meta: CommitMeta, message: string): Promise<WriteOutcome<Doc>> {
    const next = { ...doc, sections } as Doc;
    const warnings = this.check(kind, next, touched);
    const { value, commits } = await this.write((m) => this.repo(kind).update(doc.id, { sections } as never, { ...m, message: m.message ?? message }) as Promise<Doc>, meta);
    return { value, commits, warnings };
  }

  /* ---------------------------------------------------------------- documents */

  async create(kind: DocKind, input: Record<string, unknown> & { sections?: SectionCreate[] }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const sections = (input.sections ?? []).map((s) => ({ type: 'markdown', body: '', ...s }));
    const { value, commits } = await this.write((m) => this.repo(kind).create({ ...input, sections } as never, m) as Promise<Doc>, meta);
    return { value, commits, warnings: this.check(kind, value, value.sections.map((s) => s.id)) };
  }

  async updateMeta(kind: DocKind, ref: string, patch: Record<string, unknown>, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { id } = await this.resolveDoc(kind, ref);
    const { value, commits } = await this.write((m) => this.repo(kind).update(id, patch as never, { ...m, message: m.message ?? `${SINGULAR[kind]}(${id}): update metadata` }) as Promise<Doc>, meta);
    return { value, commits, warnings: [] };
  }

  /** Spec status through the transition table; `done` passes the done gate (409 `done_gate` with the failing criteria). */
  async setStatus(ref: string, status: StoredSpec['status'], meta: CommitMeta, reason?: string): Promise<WriteOutcome<Doc>> {
    const { id } = await this.resolveDoc('specs', ref);
    const msg = `spec(${id}): ${status}${reason ? `\n\n${reason}` : ''}`;
    const { value, commits } = await this.write((m) => this.storage.specs.update(id, { status } as never, { ...m, message: m.message ?? msg }) as Promise<Doc>, meta);
    return { value, commits, warnings: [] };
  }

  /** Standard lifecycle through STANDARD_TRANSITIONS (deprecated needs supersededBy). */
  async setStandardStatus(ref: string, status: StoredStandard['status'], supersededBy: string | undefined, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { id } = await this.resolveDoc('standards', ref);
    const patch = { status, ...(supersededBy ? { supersededBy: parseRef(supersededBy)?.id ?? supersededBy } : {}) };
    const { value, commits } = await this.write((m) => this.storage.standards.update(id, patch as never, { ...m, message: m.message ?? `standard(${id}): ${status}` }) as Promise<Doc>, meta);
    return { value, commits, warnings: [] };
  }

  /** Component lifecycle through COMPONENT_TRANSITIONS (components are never deleted; deprecate instead). */
  async setComponentStatus(ref: string, status: StoredComponent['status'], meta: CommitMeta, reason?: string): Promise<WriteOutcome<Doc>> {
    const { id } = await this.resolveDoc('components', ref);
    const msg = `component(${id}): ${status}${reason ? `\n\n${reason}` : ''}`;
    const { value, commits } = await this.write((m) => this.storage.components.update(id, { status } as never, { ...m, message: m.message ?? msg }) as Promise<Doc>, meta);
    return { value, commits, warnings: [] };
  }

  /* ---------------------------------------------------------------- sections */

  async sectionInsert(kind: DocKind, docRef: string, section: SectionCreate, place: Placement, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { doc } = await this.resolveDoc(kind, docRef);
    if (doc.sections.some((s) => s.id === section.id)) throw new WriteError('validation', `section '${section.id}' already exists in ${kind}/${doc.id}`, 409, 'pick another id (ids are never reused)');
    const created = { type: 'markdown', body: '', refs: [], symbols: [], links: [], verifiedBy: [], ...section } as Section;
    const sections = [...doc.sections];
    sections.splice(this.index(doc, place, section.id), 0, created);
    return this.saveSections(kind, doc, sections, [section.id], meta, `${label(kind)}(${doc.id}): insert section ${section.id}`);
  }

  async sectionUpdate(kind: DocKind, ref: string, patch: Partial<Record<(typeof SECTION_PATCH_KEYS)[number], unknown>>, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { doc, sectionId } = await this.resolveDoc(kind, ref);
    const current = this.section(kind, doc, sectionId!);
    if (current.archived) throw new WriteError('validation', `section '${sectionId}' is archived; archived sections are kept as they were`, 409, 'insert a new section instead');
    const next: Record<string, unknown> = { ...current };
    for (const k of SECTION_PATCH_KEYS) {
      if (!(k in patch)) continue;
      if (patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    const sections = doc.sections.map((s) => (s.id === sectionId ? (next as Section) : s));
    return this.saveSections(kind, doc, sections, [sectionId!], meta, `${label(kind)}(${doc.id}): update section ${sectionId}`);
  }

  async sectionMove(kind: DocKind, ref: string, place: Placement, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { doc, sectionId } = await this.resolveDoc(kind, ref);
    const s = this.section(kind, doc, sectionId!);
    if (place.after === sectionId || place.before === sectionId) throw new WriteError('validation', 'a section cannot be moved relative to itself', 400);
    const rest = doc.sections.filter((x) => x.id !== sectionId);
    const sections = [...rest];
    sections.splice(this.index({ ...doc, sections: rest } as Doc, place, sectionId!), 0, s);
    return this.saveSections(kind, doc, sections, [sectionId!], meta, `${label(kind)}(${doc.id}): move section ${sectionId}`);
  }

  /** Archive (sections are never deleted): kept in the document, no longer in force. */
  async sectionArchive(kind: DocKind, ref: string, meta: CommitMeta, reason?: string): Promise<WriteOutcome<Doc>> {
    const { doc, sectionId } = await this.resolveDoc(kind, ref);
    const s = this.section(kind, doc, sectionId!);
    if (s.archived) throw new WriteError('validation', `section '${sectionId}' is already archived`, 409);
    const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, archived: true } : x));
    return this.saveSections(kind, doc, sections, [], meta, `${label(kind)}(${doc.id}): archive section ${sectionId}${reason ? `\n\n${reason}` : ''}`);
  }

  async linkAdd(kind: DocKind, ref: string, link: { to: string; rel: Section['links'][number]['rel']; note?: string; feedback?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { doc, sectionId } = await this.resolveDoc(kind, ref);
    const s = this.section(kind, doc, sectionId!);
    const to = canonicalTarget(link.to);
    if (s.links.some((l) => l.to === to && l.rel === link.rel)) throw new WriteError('validation', `section '${sectionId}' already has ${link.rel} -> ${to}`, 409);
    const added = { to, rel: link.rel, ...(link.note ? { note: link.note } : {}), ...(link.feedback ? { feedback: link.feedback } : {}) };
    const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, links: [...x.links, added] } : x));
    return this.saveSections(kind, doc, sections, [sectionId!], meta, `${label(kind)}(${doc.id}): link ${sectionId} ${link.rel} ${to.replace('mandate://', '')}`);
  }

  async linkRemove(kind: DocKind, ref: string, link: { to: string; rel?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { doc, sectionId } = await this.resolveDoc(kind, ref);
    const s = this.section(kind, doc, sectionId!);
    const to = canonicalTarget(link.to);
    const keep = s.links.filter((l) => !(l.to === to && (!link.rel || l.rel === link.rel)));
    if (keep.length === s.links.length) throw new WriteError('not_found', `section '${sectionId}' has no ${link.rel ?? ''} link to ${to}`.replace('  ', ' '), 404, `links: ${s.links.map((l) => `${l.rel} ${l.to}`).join(', ') || 'none'}`);
    const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, links: keep } : x));
    return this.saveSections(kind, doc, sections, [sectionId!], meta, `${label(kind)}(${doc.id}): unlink ${sectionId} ${to.replace('mandate://', '')}`);
  }

  private index(doc: Doc, place: Placement, self: string): number {
    const at = (sid: string) => {
      const i = doc.sections.findIndex((s) => s.id === sid);
      if (i < 0) throw new WriteError('not_found', `no section '${sid}' in ${doc.id}`, 404, `sections: ${doc.sections.map((s) => s.id).join(', ')}`);
      return i;
    };
    if (place.after) return at(place.after) + 1;
    if (place.before) return at(place.before);
    if (place.position === 'first') return 0;
    void self;
    return doc.sections.length;
  }

  /* ---------------------------------------------------------------- diffs */

  /**
   * What changed in spec sections since they were implemented: a work order's sections between its pinned
   * `specCommit` and HEAD, or given sections each since their own `implementedCommit` (else the spec's).
   */
  async diffSinceImplemented(input: { workOrder?: string; sections?: string[] }) {
    const git = this.storage.git;
    const head = await git.head();
    type Item = { uri: string; section: string; from: string | null; to: string | null; status: string; title?: { before: string; after: string }; body?: unknown; meta?: unknown };
    const diffAt = async (specId: string, from: string, ids: string[]): Promise<Item[]> => {
      const path = this.storage.specs.pathOf(specId);
      const full = await git.resolveCommit(from).catch(() => null);
      const before = full ? await git.readFileAt(full, path).catch(() => null) : null;
      const after = await this.storage.specs.raw(specId);
      if (!full) return ids.map((sid) => ({ uri: buildRef({ kind: 'specs', id: specId, sectionId: sid }), section: sid, from, to: head, status: 'pin_lost' }));
      const d = diffDocs(specFormat as DocFormat<unknown, unknown>, before, after);
      return ids.map((sid) => {
        const s = d.sections.find((x) => x.id === sid);
        const base = { uri: buildRef({ kind: 'specs', id: specId, sectionId: sid }), section: sid, from: full, to: head };
        if (!s) return { ...base, status: 'missing' };
        return { ...base, status: s.status, ...(s.title ? { title: s.title } : {}), ...(s.body && s.status !== 'unchanged' ? { body: s.body } : {}), ...(s.meta.length ? { meta: s.meta } : {}) };
      });
    };
    if (input.workOrder) {
      const r = parseRef(input.workOrder);
      const wo = await this.storage.workOrders.get(r ? r.id : input.workOrder);
      return { workOrder: buildRef({ kind: 'work-orders', id: wo.id }), spec: buildRef({ kind: 'specs', id: wo.spec }), from: wo.specCommit, to: head, sections: await diffAt(wo.spec, wo.specCommit, wo.sections.map((s) => s.id)) };
    }
    const out: Item[] = [];
    for (const ref of input.sections ?? []) {
      const r = parseRef(ref)!;
      const spec = await this.storage.specs.get(r.id);
      const s = this.section('specs', spec, r.sectionId!);
      const pin = s.implementedCommit ?? spec.implementedCommit;
      if (!pin) out.push({ uri: buildRef({ kind: 'specs', id: spec.id, sectionId: s.id }), section: s.id, from: null, to: head, status: 'never_implemented' });
      else out.push(...(await diffAt(spec.id, pin, [s.id])));
    }
    return { sections: out };
  }
}

const label = (kind: DocKind) => SINGULAR[kind];

/** Link targets are stored canonical (no `@mandate:`, `@sha` or `#L`). */
export function canonicalTarget(to: string): string {
  const r = parseRef(to);
  if (!r) throw new WriteError('validation', `invalid link target '${to}'`, 400);
  return buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId });
}
