import { diffDocs, type DocFormat } from '@mandate/doc';
import {
  buildRef,
  FEEDBACK_TRANSITIONS,
  feedbackSchema,
  isVerificationTarget,
  parseNodeUri,
  parseRef,
  type VerificationRecord,
  type CreateFeedbackInput,
  type DocFeedback,
  type Feedback,
  type FeedbackChange,
  type ResolvedFeedback,
  type StoredFeedback,
  type StoredComponent,
  type StoredSpec,
  type StoredStandard,
  type UpdateFeedbackInput,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { actorOf, ConflictError, NotFoundError, type CommitMeta } from './GitBackedRepository.js';
import { newId } from './ids.js';
import type { HistoryService } from './history.js';
import type { JsonlFileRepository } from './JsonlFileRepository.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';

class ValidationError extends Error {
  readonly statusCode = 400;
}
/** Closed feedback is immutable (409 `feedback_closed`). */
export class FeedbackClosedError extends Error {
  readonly statusCode = 409;
  readonly code = 'feedback_closed';
  constructor(id: string, what: string) {
    super(`feedback_closed: ${id} is closed and cannot be ${what}`);
  }
}

type Docs = { specs: MarkdownDirRepository<StoredSpec>; standards: MarkdownDirRepository<StoredStandard>; components?: MarkdownDirRepository<StoredComponent> };
type Kind = 'specs' | 'standards' | 'components';
const DIRS: Kind[] = ['specs', 'standards', 'components'];
/** Docs a feedback item may target (component sections too). */
const FEEDBACK_FILE = 'feedback.jsonl';

/** `Feedback: fb-1, fb-2` trailer lines anywhere in a commit message. */
export function feedbackTrailerIds(message: string): string[] {
  const ids: string[] = [];
  for (const m of message.matchAll(/^Feedback:[ \t]*(.+)$/gim)) ids.push(...m[1]!.split(/[\s,]+/).filter(Boolean));
  return ids;
}

interface Derived {
  changes: FeedbackChange[];
  closedAt?: string;
  closingCommit?: string;
  warnings: string[];
}

/**
 * Feedback rules. Status and resolution are explicit (stored in feedback.jsonl); the resulting
 * changes are derived from git: every commit whose message has a `Feedback: <id>` trailer, up to
 * the commit that closed the item, mapped to the specs/standards files it created, modified,
 * deleted or renamed. Closed items are immutable.
 */
export class FeedbackService {
  private cache?: { head: string | null; map: Map<string, Derived> };
  private authors?: { head: string | null; map: Map<string, string | null> };
  /** Verification records (for `mandate://verifications/<id>` targets; wired by createStorage). */
  verifications?: () => Promise<VerificationRecord[]>;

  constructor(
    private readonly repo: JsonlFileRepository<StoredFeedback>,
    private readonly docs: Docs,
    private readonly git: GitStore,
    private readonly history: HistoryService,
    private readonly formats: Record<Kind, DocFormat<unknown, unknown>>,
  ) {}

  /** Storage hook: reject commits that carry a `Feedback:` trailer for a closed item. */
  async guardCommit(message: string): Promise<void> {
    const ids = feedbackTrailerIds(message);
    if (!ids.length) return;
    const items = await this.repo.list();
    for (const id of ids) {
      const item = items.find((f) => f.id === id);
      if (item?.status === 'closed') throw new FeedbackClosedError(id, 'referenced by new changes');
    }
  }

  private title(text: string | null, kind: Kind): string | null {
    if (!text) return null;
    try {
      return ((this.formats[kind].parse(text).frontmatter as { title?: string }).title ?? null) as string | null;
    } catch {
      return /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    }
  }

  /** Documents changed by one commit, with section-level actions for modified ones. */
  private async commitChanges(commit: string, subject: string, date: string): Promise<FeedbackChange[]> {
    const diff = await this.git.commitDiff(commit, DIRS);
    const out: FeedbackChange[] = [];
    const parse = (p: string) => {
      const [dir, file] = p.split('/') as [Kind, string];
      return { kind: dir, id: file.replace(/\.md$/, '') };
    };
    const read = (c: string | null, p: string) => (c ? this.git.readFileAt(c, p) : Promise.resolve(null));
    const added = diff.files.filter((f) => f.status === 'added');
    const deleted = diff.files.filter((f) => f.status === 'deleted');
    const renamedFrom = new Map<string, string>();
    // Rename = a deleted and an added file of the same kind with the same content or title.
    for (const a of added) {
      const pa = parse(a.path);
      const titleA = this.title(await read(diff.commit, a.path), pa.kind);
      const match = await (async () => {
        for (const d of deleted) {
          if (renamedFrom.has(d.path) || parse(d.path).kind !== pa.kind) continue;
          if (d.before === a.after || (titleA && this.title(await read(diff.parent, d.path), pa.kind) === titleA)) return d;
        }
        return undefined;
      })();
      if (match) renamedFrom.set(match.path, a.path);
    }
    const renamedTo = new Map([...renamedFrom].map(([from, to]) => [to, from]));
    for (const f of diff.files) {
      if (renamedFrom.has(f.path)) continue; // reported on the new path
      const { kind, id } = parse(f.path);
      const uri = buildRef({ kind, id });
      const base = { uri, kind, id, commit: diff.commit, subject, date, sections: [] as FeedbackChange['sections'] };
      if (renamedTo.has(f.path)) {
        const from = parse(renamedTo.get(f.path)!);
        out.push({ ...base, action: 'renamed', from: buildRef(from), docTitle: this.title(await read(diff.commit, f.path), kind) });
      } else if (f.status === 'added') {
        out.push({ ...base, action: 'created', docTitle: this.title(await read(diff.commit, f.path), kind) });
      } else if (f.status === 'deleted') {
        const versions = (await this.git.fileHistory(DIRS)).get(f.path) ?? [];
        const before = versions.find((v, i) => i > 0 && versions[i - 1]!.id === diff.commit) ?? versions.find((v) => v.id !== diff.commit);
        out.push({ ...base, action: 'deleted', docTitle: this.title(await read(diff.parent, f.path), kind), ...(before ? { lastVersion: before.id } : {}) });
      } else {
        const before = await read(diff.parent, f.path);
        const after = await read(diff.commit, f.path);
        let sections: FeedbackChange['sections'] = [];
        try {
          const d = diffDocs(this.formats[kind], before, after);
          sections = d.sections
            .filter((s) => s.status !== 'unchanged')
            .map((s) => ({
              uri: buildRef({ kind, id, sectionId: s.id }),
              id: s.id,
              title: (s.after ?? s.before)!.title,
              action: s.status === 'added' ? 'added' : s.status === 'removed' ? 'removed' : 'modified',
            }));
        } catch {
          // Unparsable version: report the document only.
        }
        out.push({ ...base, action: 'modified', docTitle: this.title(after, kind), sections });
      }
    }
    return out;
  }

  /** The commit that first stored the item as closed (from the `Feedback-Item:` history). */
  private async closing(id: string): Promise<{ commit: string; date: string; line: string } | null> {
    const entries = (await this.history.mentioning(id)).filter((h) => h.trailers['Feedback-Item'] === id).reverse(); // oldest first
    for (const h of entries) {
      const text = await this.git.readFileAt(h.commit, FEEDBACK_FILE).catch(() => null);
      const line = text?.split('\n').find((l) => l.includes(`"id":"${id}"`));
      if (line && JSON.parse(line).status === 'closed') return { commit: h.commit, date: h.date, line };
    }
    return null;
  }

  private async derive(items: StoredFeedback[]): Promise<Map<string, Derived>> {
    const head = await this.git.resolveCommit('HEAD');
    if (this.cache?.head === head) return this.cache.map;
    const log = (await this.git.log(10_000)).reverse(); // oldest first
    const headText = head ? await this.git.readFileAt(head, FEEDBACK_FILE).catch(() => null) : null;
    const map = new Map<string, Derived>();
    for (const item of items) {
      const d: Derived = { changes: [], warnings: [] };
      const closed = item.status === 'closed' ? await this.closing(item.id) : null;
      if (closed) {
        d.closedAt = closed.date;
        d.closingCommit = closed.commit;
        const current = headText?.split('\n').find((l) => l.includes(`"id":"${item.id}"`));
        const strip = (l: string) => JSON.stringify({ ...JSON.parse(l), updatedAt: undefined });
        if (current && strip(current) !== strip(closed.line)) {
          d.warnings.push('Tampered: this item was edited in feedback.jsonl after it was closed.');
        }
      }
      const closingIndex = closed ? log.findIndex((c) => c.id === closed.commit) : -1;
      let ignored = 0;
      for (let i = 0; i < log.length; i++) {
        const c = log[i]!;
        if (!feedbackTrailerIds(c.message).includes(item.id)) continue;
        if (closingIndex >= 0 && i > closingIndex) {
          ignored++;
          continue;
        }
        const subject = c.message.split('\n')[0] ?? '';
        d.changes.push(...(await this.commitChanges(c.id, subject, c.date)));
      }
      if (ignored) d.warnings.push(`${ignored} commit(s) reference this item after it was closed and are ignored.`);
      if (item.resolution === 'applied' && !d.changes.length) {
        d.warnings.push('Resolution is "applied" but no commit carries a "Feedback: ' + item.id + '" trailer.');
      }
      d.changes.reverse(); // newest first
      map.set(item.id, d);
    }
    this.cache = { head, map };
    return map;
  }

  private present(item: StoredFeedback, derived: Map<string, Derived>): Feedback {
    const d = derived.get(item.id);
    return { ...item, changes: d?.changes ?? [], warnings: d?.warnings ?? [], ...(d?.closedAt ? { closedAt: d.closedAt } : {}) };
  }

  async list(): Promise<Feedback[]> {
    const items = await this.repo.list();
    const derived = await this.derive(items);
    return items.map((f) => this.present(f, derived));
  }

  async get(id: string): Promise<Feedback> {
    const items = await this.repo.list();
    const item = items.find((f) => f.id === id);
    if (!item) throw new NotFoundError(`feedback '${id}' not found`);
    return this.present(item, await this.derive(items));
  }

  /** Author of an item: `createdBy`, else the agent / author of the commit that created it (legacy items). */
  async authorOf(id: string): Promise<string | null> {
    const items = await this.repo.list();
    const item = items.find((f) => f.id === id);
    if (item?.createdBy) return item.createdBy;
    const head = await this.git.resolveCommit('HEAD');
    if (this.authors?.head !== head) this.authors = { head, map: new Map() };
    if (!this.authors.map.has(id)) {
      const first = (await this.history.mentioning(id)).filter((h) => h.trailers['Feedback-Item'] === id).pop();
      this.authors.map.set(id, first ? (first.agent ?? first.author) : null);
    }
    return this.authors.map.get(id) ?? null;
  }

  /** Authors of all items (for waiver approval checks). */
  async authors_(): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const f of await this.repo.list()) out.set(f.id, await this.authorOf(f.id));
    return out;
  }

  /** Storage hook (inside the write lock): targets, references and status transitions. */
  async check(next: StoredFeedback, current: StoredFeedback | undefined): Promise<void> {
    if (current?.status === 'closed') throw new FeedbackClosedError(next.id, 'modified');
    if (current && current.status !== next.status && !FEEDBACK_TRANSITIONS[current.status].includes(next.status)) {
      throw new ConflictError(`feedback ${next.id}: ${current.status} -> ${next.status} is not allowed`);
    }
    // Only re-check what changed (targets may legitimately have been archived since).
    const targets = current ? next.targets.filter((t) => !current.targets.includes(t)) : next.targets;
    const rel = current ? next.relatedTo.filter((r) => !current.relatedTo.includes(r)) : next.relatedTo;
    const dup = next.duplicateOf && next.duplicateOf !== current?.duplicateOf ? next.duplicateOf : undefined;
    await this.validate({ targets, duplicateOf: dup, relatedTo: rel }, next.id);
  }

  private async validate(f: Pick<StoredFeedback, 'targets' | 'duplicateOf' | 'relatedTo'>, selfId?: string) {
    for (const t of f.targets) {
      if (isVerificationTarget(t)) {
        const vid = (parseNodeUri(t) as { id: string }).id;
        if (!(await this.verifications?.())?.some((r) => r.id === vid)) throw new ValidationError(`target ${t}: verification '${vid}' does not exist`);
        continue;
      }
      const ref = parseRef(t);
      if (!ref || (ref.kind !== 'specs' && ref.kind !== 'standards' && ref.kind !== 'components')) throw new ValidationError(`invalid target ${t}`);
      const doc = (await this.docs[ref.kind]?.get(ref.id).catch(() => null)) ?? null;
      if (!doc) throw new ValidationError(`target ${t}: ${ref.kind.slice(0, -1)} '${ref.id}' does not exist`);
      if (ref.sectionId && !doc.sections.some((s) => s.id === ref.sectionId)) {
        throw new ValidationError(`target ${t}: section '${ref.sectionId}' does not exist`);
      }
    }
    const ids = new Set((await this.repo.list()).map((x) => x.id));
    for (const other of [...(f.duplicateOf ? [f.duplicateOf] : []), ...(f.relatedTo ?? [])]) {
      if (other === selfId) throw new ValidationError(`feedback cannot reference itself`);
      if (!ids.has(other)) throw new ValidationError(`feedback '${other}' does not exist`);
    }
  }

  /** New items get `fb-<ulid>` ids and `createdBy` from the commit (agent, else author); validation runs inside the lock. */
  async create(input: CreateFeedbackInput, meta: CommitMeta = {}): Promise<Feedback> {
    const id = input.id ?? newId('fb');
    const item = feedbackSchema.parse({ ...input, id, createdBy: input.createdBy ?? actorOf(meta), createdAt: '', updatedAt: '' });
    const { createdAt: _c, updatedAt: _u, ...stored } = item;
    await this.repo.create(stored as never, meta);
    return this.get(id);
  }

  async update(id: string, patch: UpdateFeedbackInput, meta: CommitMeta = {}): Promise<Feedback> {
    const current = await this.repo.get(id);
    if (current.status === 'closed') throw new FeedbackClosedError(id, 'modified');
    await this.repo.update(id, patch as never, meta);
    return this.get(id);
  }

  async delete(id: string, meta: CommitMeta = {}) {
    const current = await this.repo.get(id);
    if (current.status === 'closed') throw new FeedbackClosedError(id, 'deleted');
    return this.repo.delete(id, meta);
  }

  /** Targets resolved at HEAD, or for closed (immutable) items at their closing commit (C3.6). */
  async resolve(id: string): Promise<ResolvedFeedback> {
    const feedback = await this.get(id);
    const items = await this.repo.list();
    const at = feedback.status === 'closed' ? (await this.derive(items)).get(id)?.closingCommit : undefined;
    const targets: ResolvedFeedback['targets'] = [];
    for (const t of feedback.targets) {
      if (isVerificationTarget(t)) {
        const vid = (parseNodeUri(t) as { id: string }).id;
        const record = (await this.verifications?.())?.find((r) => r.id === vid) ?? null;
        targets.push({ ref: t, kind: 'verifications', id: vid, title: record ? `${record.result} · ${record.criterion.replace('mandate://', '')}` : null, verification: record });
        continue;
      }
      const ref = parseRef(t)!;
      const kind = ref.kind as Kind;
      const commit = ref.commit ?? at;
      let doc: StoredSpec | StoredStandard | StoredComponent | null = null;
      if (commit) {
        const raw = await this.git.readFileAt(commit, `${kind}/${ref.id}.md`).catch(() => null);
        try {
          const codecs = await import('./codecs.js');
          doc = raw ? (kind === 'specs' ? codecs.specCodec : kind === 'standards' ? codecs.standardCodec : codecs.componentCodec).decode(raw, ref.id) : null;
        } catch {
          doc = null;
        }
      } else doc = (await this.docs[kind]?.get(ref.id).catch(() => null)) ?? null;
      targets.push({
        ref: t,
        kind,
        id: ref.id,
        title: doc?.title ?? null,
        ...(ref.sectionId ? { sectionId: ref.sectionId, section: doc?.sections.find((s) => s.id === ref.sectionId) ?? null } : {}),
        ...(ref.lines ? { lines: ref.lines } : {}),
        ...(commit ? { at: commit } : {}),
      });
    }
    return { feedback: { ...feedback, author: await this.authorOf(id) }, targets };
  }

  historyOf(id: string) {
    return this.history.mentioning(id);
  }

  /** Feedback targeting one document; badge counts include open and accepted items only. */
  async forDoc(kind: Kind, docId: string): Promise<DocFeedback> {
    const items: DocFeedback['items'] = [];
    const openBySection: Record<string, number> = {};
    for (const f of await this.list()) {
      const refs = f.targets.map((t) => parseRef(t)).filter((r) => r && r.kind === kind && r.id === docId);
      if (!refs.length) continue;
      const sections = [...new Set(refs.map((r) => r!.sectionId ?? ''))];
      items.push({ ...f, sections });
      if (f.status !== 'closed') for (const s of sections) openBySection[s] = (openBySection[s] ?? 0) + 1;
    }
    return { items, openBySection };
  }
}
