/**
 * Section-level writes on specs and standards (insert / update / move / archive, link add / remove), document
 * metadata, and `diffSinceImplemented`. Every change is a whole-document update through the repository, so the
 * write-time rules (DocRules: transitions, identity, links, criteria shrink, done gate) run inside the write lock,
 * and the document is serialized and validated (round trip) before anything is written: never a partial write.
 */
import { diffDocs, IMAGE_EXT, IMAGE_FILE_FIELDS, imageBody, imageBodyProblems, parseImageBody, sectionAdvice, type DocFormat, type ImageMeta, type ImageMime, type Section } from '@mandate/doc';
import { userOfTrailers, buildRef, idFromTitle, parseRef, slugify, touchedFromInput, type TouchedInput, type SectionCreate, type StoredComponent, type StoredSpec, type StoredStandard } from '@mandate/shared';
import { componentCodec, componentFormat, specCodec, specFormat, standardCodec, standardFormat } from './codecs.js';
import { NotFoundError, type CommitMeta } from './GitBackedRepository.js';
import { presetIds } from './preset-ids.js';
import { applyCodeToSection } from './work-order-plan.js';
import type { Storage } from './index.js';
import { UPSTREAM_RELS } from './model.js';

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

/** An uploaded image (validated by the upload route: magic bytes, size, dimensions) for an `image` section. */
export interface ImageUpload {
  data: Buffer;
  mime: ImageMime;
  width?: number;
  height?: number;
  sha256: string;
  /** Required for a new section; a replace keeps the current alt / caption when omitted. */
  alt?: string;
  caption?: string;
}

/** Repo-relative directory of a document's binary assets (`specs/x.md` → `specs/x.assets`). */
export const assetDirOf = (docPath: string) => docPath.replace(/\.md$/, '.assets');

const IMAGE_UPLOAD_HINT = "images are uploaded with curl: PUT /p/<project>/sections/<kind>/<docId>[/<sid>] with -H 'Content-Type: image/png' and ?alt=… (or upload_url_create sectionType image); alt / caption can be edited in the JSON body as long as the file fields stay";

const SECTION_PATCH_KEYS = ['title', 'type', 'summary', 'body', 'refs', 'symbols', 'verifiedBy', 'method', 'threshold', 'level', 'rationale', 'scope', 'check', 'examples', 'provenance', 'confidence'] as const;

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
        ...v.warnings.filter((w) => (w.sectionId ? touched.includes(w.sectionId) : w.code === 'tldr-missing')).map((w) => w.message),
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

  /**
   * Read-modify-write of the sections INSIDE the write lock (no lost updates between concurrent section writes):
   * `edit` gets the current document and returns the new sections plus the touched section ids.
   */
  private async editSections(kind: DocKind, ref: string, edit: (doc: Doc, sectionId: string | undefined) => Promise<{ sections: Section[]; touched: string[]; message: string; result?: string }> | { sections: Section[]; touched: string[]; message: string; result?: string }, meta: CommitMeta, opts: { image?: ImageUpload } = {}): Promise<WriteOutcome<Doc> & { result?: string }> {
    const { id, sectionId } = await this.resolveDoc(kind, ref);
    const files: NonNullable<CommitMeta['files']> = [];
    let warnings: string[] = [];
    let result: string | undefined;
    let msg = '';
    const { value, commits } = await this.write(
      (m) =>
        this.repo(kind).modify(
          id,
          async (current) => {
            const doc = current as Doc;
            const out = await edit(doc, sectionId);
            files.length = 0;
            const sections = this.imageSections(kind, doc, out.sections, files, opts.image ? { sectionId: out.result ?? sectionId!, upload: opts.image } : undefined);
            const next = { ...doc, sections } as Doc;
            warnings = this.check(kind, next, out.touched);
            result = out.result;
            msg = out.message;
            return next as never;
          },
          { ...m, files, get message() { return m.message ?? msg; } } as CommitMeta,
        ) as Promise<Doc>,
      meta,
    );
    return { value, commits, warnings, ...(result ? { result } : {}) };
  }

  /**
   * Image sections: the binary and its facts (file, mime, size, dimensions, sha256) change only through an upload,
   * which writes the file next to the document in the same commit (`files`); alt / caption may be edited in the body.
   * A section leaving the image type (or a replaced file with another extension) removes the old file.
   */
  private imageSections(kind: DocKind, doc: Doc, sections: Section[], files: NonNullable<CommitMeta['files']>, image?: { sectionId: string; upload: ImageUpload }): Section[] {
    const dir = assetDirOf(this.repo(kind).pathOf(doc.id));
    const before = new Map(doc.sections.map((s) => [s.id, s]));
    const prevMeta = (s: Section | undefined) => (s?.type === 'image' ? parseImageBody(s.body) : null);
    const out = sections.map((s) => {
      const prev = before.get(s.id);
      const old = prevMeta(prev);
      if (image && s.id === image.sectionId) {
        if (s.type !== 'image') throw new WriteError('type_mismatch', `section '${s.id}' is a ${s.type} section, not an image`, 415);
        const u = image.upload;
        const alt = u.alt?.trim() || old?.alt;
        if (!alt) throw new WriteError('alt_required', 'an image section needs alt text (what the image shows: agents, search and Ask read it)', 400, 'add &alt=<description> (URL-encoded) to the upload');
        const caption = u.caption !== undefined ? u.caption.trim() || undefined : old?.caption;
        const meta: ImageMeta = { file: `${s.id}.${IMAGE_EXT[u.mime]}`, alt, ...(caption ? { caption } : {}), mime: u.mime, ...(u.width ? { width: u.width } : {}), ...(u.height ? { height: u.height } : {}), bytes: u.data.length, sha256: u.sha256 };
        files.push({ path: `${dir}/${meta.file}`, data: u.data });
        if (old && old.file !== meta.file) files.push({ path: `${dir}/${old.file}`, data: null });
        return { ...s, body: imageBody(meta) };
      }
      if (old && s.type !== 'image') files.push({ path: `${dir}/${old.file}`, data: null });
      if (s.type !== 'image' || (prev && prev.type === 'image' && prev.body === s.body)) return s;
      const problems = imageBodyProblems(s.body);
      const next = parseImageBody(s.body);
      if (!old) throw new WriteError('image_upload_required', `section '${s.id}' cannot become an image section without an upload`, 400, IMAGE_UPLOAD_HINT);
      if (!next) throw new WriteError('validation', problems.join('; '), 400, IMAGE_UPLOAD_HINT);
      const changed = IMAGE_FILE_FIELDS.filter((k) => next[k] !== old[k]);
      if (changed.length) throw new WriteError('image_upload_required', `the image file fields (${changed.join(', ')}) change only by uploading a new image`, 400, IMAGE_UPLOAD_HINT);
      return { ...s, body: imageBody(next) };
    });
    return out;
  }

  /* ---------------------------------------------------------------- documents */

  async create(kind: DocKind, input: Record<string, unknown> & { sections?: SectionCreate[] }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const preset = presetIds();
    let sections = assignSectionIds(input.sections ?? [], new Set()).map((s) => ({ type: 'markdown', body: '', ...s }));
    if (sections.some((s) => s.type === 'image')) throw new WriteError('image_upload_required', 'image sections are added by upload, not inline', 400, `create the ${SINGULAR[kind]} first, then ${IMAGE_UPLOAD_HINT}`);
    if (preset?.sections) sections = sections.map((s, i) => ({ ...s, id: preset.sections![i] ?? s.id }));
    if (preset?.doc) input = { ...input, id: preset.doc };
    const { value, commits } = await this.write((m) => this.repo(kind).create({ ...input, sections } as never, m) as Promise<Doc>, meta);
    return { value, commits, warnings: this.check(kind, value, value.sections.map((s) => s.id)) };
  }

  async updateMeta(kind: DocKind, ref: string, patch: Record<string, unknown>, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const { id } = await this.resolveDoc(kind, ref);
    const { value, commits } = await this.write((m) => this.repo(kind).update(id, patch as never, { ...m, message: m.message ?? `${SINGULAR[kind]}(${id}): update metadata` }) as Promise<Doc>, meta);
    return { value, commits, warnings: this.check(kind, value, []) };
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

  /** Insert a section; Mandate assigns its id (slug of the title, de-duplicated against current and former ids) inside the lock. */
  async sectionInsert(kind: DocKind, docRef: string, section: SectionCreate, place: Placement, meta: CommitMeta, opts: { image?: ImageUpload } = {}): Promise<WriteOutcome<Doc> & { sectionId: string }> {
    const out = await this.editSections(
      kind,
      docRef,
      async (doc) => {
        const ever = await this.storage.docRules.everSectionIds(kind, doc.id);
        const taken = new Set([...ever, ...doc.sections.map((s) => s.id)]);
        let [withId] = assignSectionIds([section], taken);
        const preset = presetIds()?.section;
        if (preset) {
          if (taken.has(preset)) throw new WriteError('id_reused', `section '${preset}' already exists in ${kind}/${doc.id}`, 409);
          withId = { ...withId!, id: preset };
        }
        const sid = (withId as { id: string }).id;
        const created = { type: 'markdown', body: '', refs: [], symbols: [], links: [], verifiedBy: [], ...withId } as Section;
        const sections = [...doc.sections];
        sections.splice(this.index(doc, place, sid), 0, created);
        return { sections, touched: [sid], message: `${label(kind)}(${doc.id}): insert section ${sid}`, result: sid };
      },
      meta,
      opts,
    );
    return { ...out, sectionId: out.result! };
  }

  /** The change summary travels with the edit as a `Change-Summary` commit trailer (one line). */
  private withSummary(meta: CommitMeta, summary?: string): CommitMeta {
    const one = summary?.replace(/\s+/g, ' ').trim();
    return one ? { ...meta, trailers: { ...meta.trailers, 'Change-Summary': one.slice(0, 400) } } : meta;
  }

  /**
   * A section that is implemented, or that other sections depend on (incoming depends_on / extends / follows /
   * deviates_from / affects), is not edited without saying what changed in 1-2 plain sentences (shown on the Outdated /
   * Upstream changed badges of the sections that depend on it).
   */
  private async requireSummary(kind: DocKind, doc: Doc, section: Section, summary?: string): Promise<void> {
    if (summary?.trim()) return;
    const implemented = kind === 'specs' && !!section.implementedCommit;
    let dependents = 0;
    if (!implemented) {
      const links = await this.storage.linkService.forDoc(kind, doc as never).catch(() => null);
      dependents = (links?.sections[section.id]?.backlinks ?? []).filter((b) => UPSTREAM_RELS.has(b.rel)).length;
    }
    if (!implemented && !dependents) return;
    throw new WriteError('change_summary_required', `change_summary_required: ${section.id} is ${implemented ? 'implemented' : `depended on by ${dependents} section(s)`}: say what changed`, 400, 'pass changeSummary: 1-2 plain sentences (no code) on what changed and why, e.g. "Sessions now last 30 days instead of 7."');
  }

  async sectionUpdate(kind: DocKind, ref: string, patch: Partial<Record<(typeof SECTION_PATCH_KEYS)[number], unknown>>, meta0: CommitMeta, opts: { image?: ImageUpload; editorial?: { reason: string }; changeSummary?: string } = {}): Promise<WriteOutcome<Doc>> {
    const editorial = opts.editorial;
    const meta = this.withSummary(meta0, opts.changeSummary);
    let carried: { id: string; commit?: string } | null = null;
    const out = await this.editSections(
      kind,
      ref,
      async (doc, sectionId) => {
        const current = this.section(kind, doc, sectionId!);
        if (current.archived) throw new WriteError('validation', `section '${sectionId}' is archived; archived sections are kept as they were`, 409, 'insert a new section instead');
        // Only edits that change what the section says (not code refs / symbols / links bookkeeping) need a summary.
        if (Object.keys(patch).some((k) => ['title', 'body', 'type', 'method', 'threshold', 'level', 'check', 'scope', 'rationale', 'examples'].includes(k))) await this.requireSummary(kind, doc, current, opts.changeSummary ?? editorial?.reason);
        if (editorial) {
          const behaviour = Object.keys(patch).filter((k) => !['title', 'summary', 'body'].includes(k));
          if (behaviour.length || current.type === 'acceptance' || current.type === 'rule') {
            throw new WriteError('editorial_not_allowed', `editorial is for wording only (title, summary, body of a non-criterion section); this edit ${behaviour.length ? `changes ${behaviour.join(', ')}` : `is on a ${current.type} section (a criterion / rule is behaviour)`}`, 400, 'drop editorial and cover the change with a task of a work order (update), or split the wording edit from the behaviour edit');
          }
        }
        const next: Record<string, unknown> = { ...current };
        for (const k of SECTION_PATCH_KEYS) {
          if (!(k in patch)) continue;
          if (patch[k] === null) delete next[k];
          else next[k] = patch[k];
        }
        carried = editorial && current.implementedCommit ? { id: sectionId! } : null;
        const sections = doc.sections.map((s) => (s.id === sectionId ? (next as Section) : s));
        return { sections, touched: [sectionId!], message: `${label(kind)}(${doc.id}): update section ${sectionId}${editorial ? `\n\nEditorial: ${editorial.reason}` : ''}` };
      },
      meta,
      opts,
    );
    const sha = out.commits.at(-1);
    const marker = carried as { id: string } | null;
    if (editorial && marker && sha) {
      // The implemented marker moves to the edit's own commit: the section is compared with its wording from now on.
      const rid = parseRef(ref);
      const id = rid ? rid.id : ref;
      const note = { kind: 'editorial' as const, commit: sha, reason: editorial.reason, ...(meta.agent ? { by: meta.agent } : {}), at: (meta.date ?? new Date()).toISOString() };
      const moved = await this.write(
        (m) =>
          this.repo(kind).modify(
            id,
            (cur) => {
              const d = cur as Doc;
              return { ...d, sections: d.sections.map((s) => (s.id === marker.id && s.implementedCommit ? ({ ...s, implementedCommit: sha, implementationNotes: [...(s.implementationNotes ?? []), note] } as Section) : s)) } as never;
            },
            { ...m, message: `${label(kind)}(${id}): editorial change of ${marker.id} stays implemented @${sha.slice(0, 7)}\n\nEditorial: ${editorial.reason}` },
          ) as Promise<Doc>,
        meta,
      );
      return { ...out, value: moved.value, commits: [...out.commits, ...moved.commits] };
    }
    return out;
  }

  /**
   * Re-verify an implemented (possibly Outdated) spec section: the code and tests were checked against its CURRENT text.
   * The comparison base moves to the spec's current commit; code refs are merged into the section, the evidence is noted.
   */
  async sectionReverify(ref: string, input: { codeRefs?: TouchedInput[]; verifications?: string[]; note?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const code = (input.codeRefs ?? []).map(touchedFromInput);
    return this.editSections(
      'specs',
      ref,
      async (doc, sectionId) => {
        const current = this.section('specs', doc, sectionId!);
        if (current.archived) throw new WriteError('validation', `section '${sectionId}' is archived`, 409);
        if (!current.implementedCommit) throw new WriteError('not_implemented', `section '${sectionId}' was never implemented: implement it through a work order (flow_next)`, 409, 'section_reverify is for implemented sections (Outdated)');
        const base = (await this.storage.history.meta(this.repo('specs').pathOf(doc.id))).lastCommit;
        if (!base) throw new WriteError('validation', 'the spec has no commit yet', 409);
        const applied = applyCodeToSection(current, code);
        const evidence = [input.note?.trim(), code.length ? `code: ${code.map((c) => `${c.repo}:${c.path}`).join(', ')}` : '', input.verifications?.length ? `verified by: ${input.verifications.join(', ')}` : ''].filter(Boolean).join('; ');
        const note = { kind: 'reverified' as const, commit: base, reason: evidence || 're-verified', ...(meta.agent ? { by: meta.agent } : {}), at: (meta.date ?? new Date()).toISOString() };
        const next = { ...current, implementedCommit: base, refs: applied.refs, symbols: applied.symbols, implementationNotes: [...(current.implementationNotes ?? []), note] } as Section;
        return { sections: doc.sections.map((x) => (x.id === sectionId ? next : x)), touched: [sectionId!], message: `spec(${doc.id}): re-verified ${sectionId} @${base.slice(0, 7)}\n\n${evidence}` };
      },
      meta,
    );
  }

  async sectionMove(kind: DocKind, ref: string, place: Placement, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    return this.editSections(
      kind,
      ref,
      (doc, sectionId) => {
        const s = this.section(kind, doc, sectionId!);
        if (place.after === sectionId || place.before === sectionId) throw new WriteError('validation', 'a section cannot be moved relative to itself', 400);
        const rest = doc.sections.filter((x) => x.id !== sectionId);
        const sections = [...rest];
        sections.splice(this.index({ ...doc, sections: rest } as Doc, place, sectionId!), 0, s);
        return { sections, touched: [sectionId!], message: `${label(kind)}(${doc.id}): move section ${sectionId}` };
      },
      meta,
    );
  }

  /** Archive (sections are never deleted): kept in the document, no longer in force. */
  async sectionArchive(kind: DocKind, ref: string, meta0: CommitMeta, reason?: string, changeSummary?: string): Promise<WriteOutcome<Doc>> {
    const meta = this.withSummary(meta0, changeSummary);
    return this.editSections(
      kind,
      ref,
      async (doc, sectionId) => {
        const s = this.section(kind, doc, sectionId!);
        await this.requireSummary(kind, doc, s, changeSummary ?? reason);
        if (s.archived) throw new WriteError('validation', `section '${sectionId}' is already archived`, 409);
        const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, archived: true } : x));
        return { sections, touched: [], message: `${label(kind)}(${doc.id}): archive section ${sectionId}${reason ? `\n\n${reason}` : ''}` };
      },
      meta,
    );
  }

  /**
   * The user (or an agent) accepts that a section needs no work: an Outdated spec section is wording only (its implemented
   * marker moves to the current text, noted editorial with who and why) and / or the upstream changes of its links have no
   * impact (`seenAt` = the current commit). `outdated: false` acknowledges links only.
   */
  async sectionAccept(kind: DocKind, ref: string, input: { reason?: string; outdated: boolean; to?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const to = input.to ? canonicalTarget(input.to) : null;
    const who = userOfTrailers(meta.trailers) ?? meta.agent;
    return this.editSections(
      kind,
      ref,
      async (doc, sectionId) => {
        const s = this.section(kind, doc, sectionId!);
        const head = await this.storage.git.head();
        let next: Section = s;
        if (input.outdated && kind === 'specs' && s.implementedCommit) {
          const base = (await this.storage.history.meta(this.repo(kind).pathOf(doc.id))).lastCommit;
          if (base) next = { ...next, implementedCommit: base, implementationNotes: [...(s.implementationNotes ?? []), { kind: 'editorial' as const, commit: base, reason: input.reason?.trim() || 'accepted: wording only', ...(who ? { by: who } : {}), at: (meta.date ?? new Date()).toISOString() }] } as Section;
        }
        if (head) next = { ...next, links: next.links.map((l) => (UPSTREAM_RELS.has(l.rel) && (!to || l.to === to) ? { ...l, seenAt: head } : l)) };
        return { sections: doc.sections.map((x) => (x.id === sectionId ? next : x)), touched: [], message: `${label(kind)}(${doc.id}): accept ${sectionId}${input.outdated ? ' (wording only)' : ' (upstream change has no impact)'}${input.reason ? `\n\n${input.reason}` : ''}` };
      },
      meta,
    );
  }

  async linkAdd(kind: DocKind, ref: string, link: { to: string; rel: Section['links'][number]['rel']; note?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const to = canonicalTarget(link.to);
    return this.editSections(
      kind,
      ref,
      (doc, sectionId) => {
        const s = this.section(kind, doc, sectionId!);
        const existing = s.links.find((l) => l.to === to && l.rel === link.rel);
        // A pending waiver (no approval yet) is approved by adding it again with the answered approval question as cause.
        const approving = !!existing && link.rel === 'deviates_from' && !existing.feedback && !!meta.trailers?.['User-Approved'];
        if (existing && !approving) throw new WriteError('validation', `section '${sectionId}' already has ${link.rel} -> ${to}`, 409);
        const added = { to, rel: link.rel, ...(link.note ? { note: link.note } : existing?.note ? { note: existing.note } : {}) };
        const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, links: approving ? x.links.map((l) => (l === existing ? added : l)) : [...x.links, added] } : x));
        return { sections, touched: [sectionId!], message: `${label(kind)}(${doc.id}): link ${sectionId} ${link.rel} ${to.replace('mandate://', '')}` };
      },
      meta,
    );
  }

  async linkRemove(kind: DocKind, ref: string, link: { to: string; rel?: string }, meta: CommitMeta): Promise<WriteOutcome<Doc>> {
    const to = canonicalTarget(link.to);
    return this.editSections(
      kind,
      ref,
      (doc, sectionId) => {
        const s = this.section(kind, doc, sectionId!);
        const keep = s.links.filter((l) => !(l.to === to && (!link.rel || l.rel === link.rel)));
        if (keep.length === s.links.length) throw new WriteError('not_found', `section '${sectionId}' has no ${link.rel ?? ''} link to ${to}`.replace('  ', ' '), 404, `links: ${s.links.map((l) => `${l.rel} ${l.to}`).join(', ') || 'none'}`);
        const sections = doc.sections.map((x) => (x.id === sectionId ? { ...x, links: keep } : x));
        return { sections, touched: [sectionId!], message: `${label(kind)}(${doc.id}): unlink ${sectionId} ${to.replace('mandate://', '')}` };
      },
      meta,
    );
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

/**
 * Section ids for new sections: a slug of the title (max 48 chars), de-duplicated (-2, -3, ...) against `taken` and
 * each other. `verifiedBy` entries naming a sibling by the slug of its title are mapped to the sibling's assigned id.
 */
export function assignSectionIds<S extends { title: string; verifiedBy?: string[] }>(sections: S[], taken: Set<string>): (S & { id: string })[] {
  const used = new Set(taken);
  const bySlug = new Map<string, string>();
  const out = sections.map((s) => {
    const base = idFromTitle(s.title, 'section');
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    if (!bySlug.has(slugify(s.title))) bySlug.set(slugify(s.title), id);
    return { ...s, id };
  });
  return out.map((s) => (s.verifiedBy?.length ? { ...s, verifiedBy: s.verifiedBy.map((v) => bySlug.get(v) ?? v) } : s));
}

/** Link targets are stored canonical (no `@mandate:`, `@sha` or `#L`). */
export function canonicalTarget(to: string): string {
  const r = parseRef(to);
  if (!r) throw new WriteError('validation', `invalid link target '${to}'`, 400);
  return buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId });
}
