/**
 * Writes to `~/.mandate/projects.json` (the server-owned registry): serialized in-process, read-modify-write with
 * validation, atomic (temp + rename), mode 0600. config.json is never written.
 * `watchProjectsFile` polls the file so external edits are picked up (an invalid edit keeps the last good registry).
 */
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';
import { parseProjectsFile, projectEntrySchema, writeProjectsFile, type ProjectEntry, type ProjectsFile } from '../config.js';

export class ProjectsStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  read(): ProjectsFile {
    return existsSync(this.file) ? parseProjectsFile(this.file, readFileSync(this.file, 'utf8')) : { version: 1, projects: [] };
  }

  /** Serialized read-modify-write. */
  mutate<T>(fn: (reg: ProjectsFile) => T): Promise<T> {
    const run = this.chain.then(() => {
      const reg = this.read();
      const out = fn(reg);
      writeProjectsFile(this.file, reg);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  add(entry: ProjectEntry): Promise<void> {
    const e = projectEntrySchema.parse(entry);
    return this.mutate((reg) => {
      if (reg.projects.some((p) => p.id === e.id)) throw new Error(`project '${e.id}' already exists`);
      reg.projects.push(e);
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate((reg) => {
      const n = reg.projects.length;
      reg.projects = reg.projects.filter((p) => p.id !== id);
      return reg.projects.length !== n;
    });
  }
}

/** Call `onChange` when the file changes (mtime / size), polling every `intervalMs`. Returns the stop function. */
export function watchProjectsFile(file: string, onChange: () => void, intervalMs = 1000): () => void {
  const listener = (cur: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange();
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

/**
 * Re-read the registry and apply it; an invalid file keeps the last good registry (the error is logged and
 * returned). `load` is `() => loadConfig().projects`.
 */
export async function reloadProjects(
  registry: { sync(next: import('../config.js').ProjectConfig[]): Promise<{ added: string[]; removed: string[]; changed: string[] }> },
  load: () => import('../config.js').ProjectConfig[],
  log?: { info(m: string): void; error(m: string): void },
  onLoaded?: (ids: string[]) => void,
): Promise<{ ok: true; added: string[]; removed: string[]; changed: string[] } | { ok: false; error: string }> {
  let next;
  try {
    next = load();
  } catch (e) {
    const error = (e as Error).message;
    log?.error(`projects.json is invalid; keeping the last good registry: ${error}`);
    return { ok: false, error };
  }
  const r = await registry.sync(next);
  onLoaded?.(next.map((p) => p.id));
  if (r.added.length || r.removed.length || r.changed.length) log?.info(`projects.json reloaded: +${r.added.join(',') || '-'} -${r.removed.join(',') || '-'} ~${r.changed.join(',') || '-'}`);
  return { ok: true, ...r };
}
