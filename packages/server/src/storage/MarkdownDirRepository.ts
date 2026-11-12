import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitBackedRepository, InvalidFileError, type BaseEntity, type RepositoryDeps } from './GitBackedRepository.js';

/** Converts between an entity and its file contents. `decode` throws on invalid files. */
export interface FileCodec<T> {
  decode(raw: string, id: string): T;
  encode(entity: T): string;
}

/** One file per entity at `<dir>/<id>.md`; the codec decides the file format. */
export class MarkdownDirRepository<T extends BaseEntity> extends GitBackedRepository<T> {
  constructor(
    readonly dir: string,
    private readonly codec: FileCodec<T>,
    deps: RepositoryDeps<T>,
  ) {
    super(deps);
  }

  /** Repo-relative path of an entity's file. */
  pathOf(id: string): string {
    return `${this.dir}/${id}.md`;
  }

  private absPath(id: string): string {
    return path.join(this.git.dir, this.pathOf(id));
  }

  /** Every valid entity, sorted by id. Files that fail to parse are skipped (and logged). */
  async list(): Promise<T[]> {
    let files: string[];
    try {
      files = await readdir(path.join(this.git.dir, this.dir));
    } catch {
      return [];
    }
    const items: T[] = [];
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue;
      try {
        const item = await this.read(f.slice(0, -3));
        if (item) items.push(item);
      } catch (err) {
        console.warn(`[mandate] skipping ${this.dir}/${f}: ${(err as Error).message}`);
      }
    }
    return items;
  }

  /** The stored file's text, or null when it does not exist. */
  async raw(id: string): Promise<string | null> {
    try {
      return await readFile(this.absPath(id), 'utf8');
    } catch {
      return null;
    }
  }

  protected override async exists(id: string): Promise<boolean> {
    return (await this.raw(id)) !== null;
  }

  protected async read(id: string): Promise<T | null> {
    const raw = await this.raw(id);
    if (raw === null) return null;
    try {
      return this.codec.decode(raw, id);
    } catch (err) {
      const e = err as Error & { issues?: unknown };
      throw new InvalidFileError(`${this.pathOf(id)} is invalid: ${e.message}`, e.issues);
    }
  }

  protected async persist(entity: T): Promise<string[]> {
    await mkdir(path.join(this.git.dir, this.dir), { recursive: true });
    await writeFile(this.absPath(entity.id), this.codec.encode(entity), 'utf8');
    return [this.pathOf(entity.id)];
  }

  protected async erase(id: string): Promise<string[]> {
    await rm(this.absPath(id));
    return [this.pathOf(id)];
  }
}
