import type { z } from 'zod';
import { slugify } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import type { Mutex } from './Mutex.js';

export class NotFoundError extends Error {
  readonly statusCode = 404;
}
export class ConflictError extends Error {
  readonly statusCode = 409;
}
/** A stored file exists but does not parse (e.g. edited by hand). */
export class InvalidFileError extends Error {
  readonly statusCode = 422;
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fields every stored entity has. */
export interface BaseEntity {
  id: string;
  /** Used to derive an id when none is given. */
  title?: string;
}

/** Optional commit metadata for a write: custom subject and `Agent:` / `Branch:` trailers. */
export interface CommitMeta {
  /** Replaces the default subject (`spec: update foo`); may contain a body after a blank line. */
  message?: string;
  agent?: string;
  branch?: string;
  /** Backdate the commit (seed script). */
  date?: Date;
  /** Commit as someone other than the configured author. */
  author?: { name: string; email: string };
  /** Extra git trailers (e.g. `Feedback: fb-0012`). */
  trailers?: Record<string, string>;
  /** Called with the sha of each commit this write makes (MCP write tools report it); not called when nothing changed. */
  onCommit?: (sha: string) => void;
}

export type CreateInput<T extends BaseEntity> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
/** `null` values in a patch remove that (optional) field. */
export type UpdatePatch<T extends BaseEntity> = {
  [K in keyof Omit<T, 'id' | 'createdAt' | 'updatedAt'>]?: T[K] | null;
};

/** CRUD contract the API layer depends on, independent of the file format. */
export interface EntityRepository<T extends BaseEntity> {
  list(): Promise<T[]>;
  get(id: string): Promise<T>;
  create(input: CreateInput<T>, meta?: CommitMeta): Promise<T>;
  update(id: string, patch: UpdatePatch<T>, meta?: CommitMeta): Promise<T>;
  delete(id: string, meta?: CommitMeta): Promise<void>;
}

export interface RepositoryDeps<T> {
  /** Singular label used in errors and commit messages ("spec: create foo"). */
  label: string;
  schema: z.ZodType<T>;
  git: GitStore;
  lock: Mutex;
  /** Store createdAt/updatedAt inside the entity (single-file stores like work orders). */
  stamp?: boolean;
  /** Trailer naming the entity on every commit (e.g. `Work-Order`), so history can be filtered by id. */
  idTrailer?: string;
  /** Called with the final message before every commit; throw to reject it (e.g. closed feedback). */
  beforeCommit?: (message: string) => Promise<void>;
  /**
   * Validate an entity about to be written (`current` is undefined on create); throw to reject.
   * Runs inside the write lock. May return a replacement entity (e.g. with server-set fields stamped).
   */
  beforeWrite?: (next: T, current: T | undefined, ctx: WriteContext) => Promise<T | void>;
  /** Runs after a successful write, outside the lock (cascades that write other entities). */
  afterWrite?: (entity: T, current: T | undefined, meta: CommitMeta) => Promise<void>;
  /** Records are never updated or deleted (409 `append_only`). */
  appendOnly?: boolean;
  /** Entities are never deleted; the message explains the alternative (409 `archive_only`). */
  noDelete?: string;
}

/** What a write is about to commit (for hooks that check trailers or the acting agent). */
export interface WriteContext {
  meta: CommitMeta;
  message: string;
}

/** The acting agent or person of a write: `Agent:` trailer, else the commit author's name. */
export const actorOf = (meta: CommitMeta, fallback = 'local') => meta.agent ?? meta.author?.name ?? fallback;

/** Raised for deletes of archive-only documents. */
export class ArchiveOnlyError extends Error {
  readonly statusCode = 409;
  readonly code = 'archive_only';
}

/** Raised for updates / deletes of append-only records. */
export class AppendOnlyError extends Error {
  readonly statusCode = 409;
  readonly code = 'append_only';
}

/**
 * Shared create/update/delete logic: ids, validation, locking and one git
 * commit per write. File-per-entity stores derive timestamps from git instead
 * of storing them. Subclasses decide how entities map to files.
 */
export abstract class GitBackedRepository<T extends BaseEntity> implements EntityRepository<T> {
  protected readonly label: string;
  protected readonly schema: z.ZodType<T>;
  protected readonly git: GitStore;
  private readonly lock: Mutex;
  private readonly stamp: boolean;
  private readonly idTrailer?: string;
  private readonly beforeCommit?: (message: string) => Promise<void>;
  private readonly beforeWrite?: (next: T, current: T | undefined, ctx: WriteContext) => Promise<T | void>;
  private readonly appendOnly: boolean;
  private readonly noDelete?: string;
  private readonly afterWrite?: (entity: T, current: T | undefined, meta: CommitMeta) => Promise<void>;

  constructor(deps: RepositoryDeps<T>) {
    this.label = deps.label;
    this.schema = deps.schema;
    this.git = deps.git;
    this.lock = deps.lock;
    this.stamp = deps.stamp ?? false;
    this.idTrailer = deps.idTrailer;
    this.beforeCommit = deps.beforeCommit;
    this.beforeWrite = deps.beforeWrite;
    this.appendOnly = deps.appendOnly ?? false;
    this.noDelete = deps.noDelete;
    this.afterWrite = deps.afterWrite;
  }

  abstract list(): Promise<T[]>;
  /** Return the entity or null when it does not exist. */
  protected abstract read(id: string): Promise<T | null>;
  /** Write the entity to the working tree; return repo-relative paths touched. */
  protected abstract persist(entity: T): Promise<string[]>;
  /** Remove the entity from the working tree; return repo-relative paths touched. */
  protected abstract erase(id: string): Promise<string[]>;

  async get(id: string): Promise<T> {
    const entity = await this.read(id);
    if (!entity) throw new NotFoundError(`${this.label} '${id}' not found`);
    return entity;
  }

  async create(input: CreateInput<T>, meta: CommitMeta = {}): Promise<T> {
    const created = await this.lock.run(async () => {
      const id = input.id ?? slugify(input.title ?? '');
      if (!id) throw new ConflictError('Cannot derive an id from the title');
      if (await this.exists(id)) throw new ConflictError(`${this.label} '${id}' already exists`);
      const now = (meta.date ?? new Date()).toISOString();
      let entity = this.schema.parse({ ...input, id, ...(this.stamp ? { createdAt: now, updatedAt: now } : {}) });
      const message = await this.message(`create ${id}`, meta, id);
      entity = (await this.beforeWrite?.(entity, undefined, { meta, message })) ?? entity;
      await this.commit(await this.persist(entity), message, meta);
      return entity;
    });
    await this.afterWrite?.(created, undefined, meta);
    return created;
  }

  update(id: string, patch: UpdatePatch<T>, meta: CommitMeta = {}): Promise<T> {
    if (this.appendOnly) return Promise.reject(new AppendOnlyError(`append_only: ${this.label} records cannot be updated`));
    let before: T | undefined;
    const updated = this.lock.run(async () => {
      const current = await this.get(id);
      before = current;
      const merged: Record<string, unknown> = {
        ...current,
        ...patch,
        id,
        ...(this.stamp ? { updatedAt: (meta.date ?? new Date()).toISOString() } : {}),
      };
      for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
      let entity = this.schema.parse(merged);
      const message = await this.message(`update ${id}`, meta, id);
      entity = (await this.beforeWrite?.(entity, current, { meta, message })) ?? entity;
      await this.commit(await this.persist(entity), message, meta);
      return entity;
    });
    if (!this.afterWrite) return updated;
    return updated.then(async (entity) => {
      await this.afterWrite!(entity, before, meta);
      return entity;
    });
  }

  delete(id: string, meta: CommitMeta = {}): Promise<void> {
    if (this.appendOnly) return Promise.reject(new AppendOnlyError(`append_only: ${this.label} records cannot be deleted`));
    if (this.noDelete) return Promise.reject(new ArchiveOnlyError(`archive_only: ${this.noDelete}`));
    return this.lock.run(async () => {
      if (!(await this.exists(id))) throw new NotFoundError(`${this.label} '${id}' not found`);
      const message = await this.message(`delete ${id}`, meta, id);
      await this.commit(await this.erase(id), message, meta);
    });
  }

  /** True when the entity's file exists, even if it does not parse. */
  protected async exists(id: string): Promise<boolean> {
    return (await this.read(id)) !== null;
  }

  /** Final commit message; the beforeCommit hook runs here, before any file is written. */
  private async message(action: string, meta: CommitMeta, id: string): Promise<string> {
    const trailers = { ...(this.idTrailer ? { [this.idTrailer]: id } : {}), ...meta.trailers };
    const message = commitMessage(meta.message ?? `${this.label}: ${action}`, { ...meta, trailers });
    await this.beforeCommit?.(message);
    return message;
  }

  private async commit(paths: string[], message: string, meta: CommitMeta): Promise<void> {
    const sha = await this.git.commit(paths, message, {
      date: meta.date,
      author: meta.author,
    });
    if (sha) meta.onCommit?.(sha);
  }
}

/** Append `Agent:` / `Branch:` trailers (git trailer convention: last paragraph of `Key: value` lines). */
export function commitMessage(subject: string, meta: Pick<CommitMeta, 'agent' | 'branch' | 'trailers'>): string {
  const trailers = [
    meta.agent && `Agent: ${meta.agent}`,
    meta.branch && `Branch: ${meta.branch}`,
    ...Object.entries(meta.trailers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean);
  return trailers.length ? `${subject.trimEnd()}\n\n${trailers.join('\n')}\n` : subject;
}
