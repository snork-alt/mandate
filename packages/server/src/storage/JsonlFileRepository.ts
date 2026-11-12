import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GitBackedRepository,
  type BaseEntity,
  type RepositoryDeps,
} from './GitBackedRepository.js';

/**
 * All entities in a single JSON Lines file (e.g. `work-orders.jsonl` at the repo
 * root): one compact JSON object per line, in insertion order, so git
 * diffs and merges stay per item.
 */
export class JsonlFileRepository<T extends BaseEntity> extends GitBackedRepository<T> {
  constructor(
    private readonly file: string,
    deps: RepositoryDeps<T>,
  ) {
    super(deps);
  }

  private get absPath(): string {
    return path.join(this.git.dir, this.file);
  }

  private static logged = new Set<string>();
  /** Unparsable lines from the last read, kept verbatim on the next write (never drop data). */
  private garbage: string[] = [];

  /**
   * Lenient read: strict validation happens on write only. A line that no longer matches the
   * schema (e.g. after a rule change, or a hand edit) is still returned with `validationIssues`
   * so one bad record never breaks the whole list; unparsable lines are skipped. Issues are logged once.
   */
  private async readAll(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.absPath, 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    this.garbage = [];
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .forEach((line, i) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch (err) {
          this.logOnce(`${this.file}#${i + 1}`, `unparsable line skipped: ${(err as Error).message}`);
          this.garbage.push(line);
          return;
        }
        const r = this.schema.safeParse(json);
        if (r.success) {
          out.push(r.data);
          return;
        }
        const obj = json as Record<string, unknown>;
        if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') {
          this.logOnce(`${this.file}#${i + 1}`, 'record without id skipped');
          this.garbage.push(line);
          return;
        }
        const issues = r.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`);
        this.logOnce(`${this.file}#${obj.id}`, issues.join('; '));
        out.push({ ...obj, validationIssues: issues } as unknown as T);
      });
    return out;
  }

  private logOnce(key: string, message: string): void {
    const k = `${this.git.dir}:${key}:${message}`;
    if (JsonlFileRepository.logged.has(k)) return;
    JsonlFileRepository.logged.add(k);
    console.warn(`[mandate] ${this.file}: ${key.split('#')[1]}: ${message}`);
  }

  private async writeAll(items: T[]): Promise<string[]> {
    await mkdir(path.dirname(this.absPath), { recursive: true });
    // `validationIssues` is a read-time annotation, never stored.
    const lines = items.map((x) => {
      const { validationIssues: _v, ...rest } = x as T & { validationIssues?: unknown };
      return JSON.stringify(rest) + '\n';
    });
    await writeFile(this.absPath, lines.join('') + this.garbage.map((l) => `${l}\n`).join(''), 'utf8');
    return [this.file];
  }

  /** Items in file order. */
  async list(): Promise<T[]> {
    return this.readAll();
  }

  protected async read(id: string): Promise<T | null> {
    return (await this.readAll()).find((x) => x.id === id) ?? null;
  }

  protected async persist(entity: T): Promise<string[]> {
    const items = await this.readAll();
    const i = items.findIndex((x) => x.id === entity.id);
    if (i >= 0) items[i] = entity;
    else items.push(entity);
    return this.writeAll(items);
  }

  protected async erase(id: string): Promise<string[]> {
    return this.writeAll((await this.readAll()).filter((x) => x.id !== id));
  }
}
