import { stat } from 'node:fs/promises';
import path from 'node:path';
import { causesOfTrailers, userOfTrailers, type Attribution, type FileMeta, type FileVersion, type HistoryEntry } from '@mandate/shared';
import { NotFoundError } from './GitBackedRepository.js';
import { diffDocs, type DocFormat } from '@mandate/doc';
import type { FileCommit, GitStore } from '../git/GitStore.js';

const TRAILER_RE = /^([A-Za-z][\w-]*):[ \t]*(.+)$/;

/** Split a commit message into subject, body and trailers (last paragraph of `Key: value` lines). */
export function parseCommitMessage(message: string): Pick<HistoryEntry, 'subject' | 'body' | 'trailers'> {
  const lines = message.replace(/\r\n?/g, '\n').trim().split('\n');
  const subject = lines[0] ?? '';
  const paragraphs = lines.slice(1).join('\n').trim().split(/\n\s*\n/).filter((p) => p.trim() !== '');
  const trailers: Record<string, string> = {};
  const last = paragraphs[paragraphs.length - 1];
  if (last && last.split('\n').every((l) => TRAILER_RE.test(l))) {
    for (const l of last.split('\n')) {
      const m = TRAILER_RE.exec(l)!;
      trailers[m[1]!] = m[2]!.trim();
    }
    paragraphs.pop();
  }
  return { subject, body: paragraphs.join('\n\n'), trailers };
}

export function toHistoryEntry(c: FileCommit): HistoryEntry {
  const { subject, body, trailers } = parseCommitMessage(c.message);
  const find = (key: string) => Object.entries(trailers).find(([k]) => k.toLowerCase() === key)?.[1];
  const user = userOfTrailers(trailers);
  const causes = causesOfTrailers(trailers);
  const coAuthors = [...c.message.matchAll(/^Co-authored-by:[ \t]*([^<\n]+?)\s*<[^>\n]*>\s*$/gim)].map((m) => m[1]!.trim());
  return {
    commit: c.id,
    subject,
    body,
    author: c.authorName,
    email: c.authorEmail,
    date: c.date,
    trailers,
    agent: find('agent'),
    branch: find('branch'),
    ...(user ? { user } : {}),
    ...(causes.length ? { causes } : {}),
    ...(coAuthors.length ? { coAuthors } : {}),
  };
}

/** Who made a commit: the user (`Mandate-User` trailer) and the agent (else the commit author). */
export function attributionOf(e: HistoryEntry): Attribution {
  return { ...(e.user ? { user: e.user } : {}), agent: e.agent ?? e.author, at: e.date, commit: e.commit };
}

/** Derives per-file times, last author and history from git (cached per HEAD by the GitStore). */
export class HistoryService {
  /** Change tags per `commit:file` (immutable, so cached forever). */
  private readonly tagCache = new Map<string, HistoryEntry['changes']>();

  constructor(
    private readonly git: GitStore,
    private readonly dirs: string[],
    /** Doc formats by directory, used to tag history entries with what they changed. */
    private readonly formats: Record<string, DocFormat<unknown, unknown>> = {},
  ) {}

  /** Classify a commit's change to a file: section text, status, other metadata. */
  private async tags(file: string, commit: string, older: string | undefined): Promise<HistoryEntry['changes']> {
    const key = `${commit}:${file}`;
    if (this.tagCache.has(key)) return this.tagCache.get(key);
    const format = this.formats[file.split('/')[0]!];
    let tags: HistoryEntry['changes'];
    if (format) {
      try {
        const before = older ? await this.git.readFileAt(older, file) : null;
        const after = await this.git.readFileAt(commit, file);
        const d = diffDocs(format, before, after);
        const out = new Set<'text' | 'status' | 'metadata'>();
        if (!before || !after) {
          this.tagCache.set(key, ['text']);
          return ['text'];
        }
        for (const s of d.sections) {
          if (s.status === 'added' || s.status === 'removed' || s.moved || s.title || s.body) out.add('text');
          else if (s.meta.length) out.add('metadata');
        }
        for (const c of d.frontmatter) out.add(c.key === 'status' ? 'status' : c.key === 'title' || c.key === 'summary' || c.key === 'tldr' ? 'text' : 'metadata');
        tags = [...out];
      } catch {
        tags = undefined;
      }
    }
    this.tagCache.set(key, tags);
    return tags;
  }

  private async commits(file: string): Promise<FileCommit[]> {
    return (await this.git.fileHistory(this.dirs)).get(file) ?? [];
  }

  /** Commits that changed `file` (newest first, first-parent). */
  fileCommits(file: string): Promise<FileCommit[]> {
    return this.commits(file);
  }

  async log(file: string): Promise<HistoryEntry[]> {
    const commits = await this.commits(file);
    return Promise.all(
      commits.map(async (c, i) => ({ ...toHistoryEntry(c), changes: await this.tags(file, c.id, commits[i + 1]?.id) })),
    );
  }

  /** A version of `file` at `ref`, with the content it is compared against. */
  async version(file: string, ref: string, against: 'parent' | 'head' = 'parent', baseRef?: string): Promise<FileVersion> {
    const commit = await this.git.resolveCommit(ref);
    if (!commit) throw new NotFoundError(`unknown commit '${ref}'`);
    const commits = await this.commits(file);
    const idx = commits.findIndex((c) => c.id === commit);
    if (idx < 0) throw new NotFoundError(`commit ${commit.slice(0, 7)} did not change ${file}`);
    const older = commits[idx + 1]?.id ?? null;
    const newer = commits[idx - 1]?.id ?? null;
    let base: string | null;
    let before: string | null;
    let after: string | null;
    if (baseRef) {
      // Explicit comparison base (e.g. a section's implementedCommit).
      const b = await this.git.resolveCommit(baseRef);
      if (!b) throw new NotFoundError(`unknown commit '${baseRef}'`);
      base = b;
      before = await this.git.readFileAt(b, file);
      after = await this.git.readFileAt(commit, file);
    } else if (against === 'head') {
      base = commit;
      before = await this.git.readFileAt(commit, file);
      const head = await this.git.resolveCommit('HEAD');
      after = head ? await this.git.readFileAt(head, file) : null;
    } else {
      base = older;
      before = older ? await this.git.readFileAt(older, file) : null;
      after = await this.git.readFileAt(commit, file);
    }
    const status = before === after ? 'unchanged' : before === null ? 'added' : after === null ? 'deleted' : 'modified';
    return {
      path: file,
      commit,
      base,
      against,
      status,
      before,
      after,
      meta: toHistoryEntry(commits[idx]!),
      older,
      newer,
      index: commits.length - idx,
      total: commits.length,
    };
  }

  /** Commits whose message mentions `id` (e.g. via a `Work-Order:` or legacy `Queue-Item:` trailer), newest first. */
  async mentioning(id: string, limit = 2000): Promise<HistoryEntry[]> {
    const re = new RegExp(`(^|[^a-z0-9-])${id.replace(/[-]/g, '\\-')}($|[^a-z0-9-])`, 'm');
    return (await this.git.log(limit))
      .filter((c) => re.test(c.message))
      .map((c) => {
        const m = /^(.*) <(.*)>$/.exec(c.author);
        return toHistoryEntry({ id: c.id, message: c.message, authorName: m?.[1] ?? c.author, authorEmail: m?.[2] ?? '', date: c.date });
      });
  }

  async meta(file: string): Promise<FileMeta> {
    const commits = await this.commits(file);
    const newest = commits[0];
    const oldest = commits[commits.length - 1];
    let fallback: string | undefined;
    if (!newest) {
      // Not committed yet (e.g. a hand-written file): fall back to the file's mtime.
      fallback = await stat(path.join(this.git.dir, file)).then(
        (s) => s.mtime.toISOString(),
        () => new Date(0).toISOString(),
      );
    }
    const last = newest && toHistoryEntry(newest);
    const first = oldest && toHistoryEntry(oldest);
    return {
      createdAt: oldest?.date ?? fallback!,
      updatedAt: newest?.date ?? fallback!,
      updatedBy: last ? (last.agent ?? last.author) : null,
      revisions: commits.length,
      versionCount: commits.length,
      lastCommit: newest?.id ?? null,
      ...(first ? { createdBy: attributionOf(first) } : {}),
      ...(last ? { lastEditedBy: attributionOf(last) } : {}),
    };
  }
}
