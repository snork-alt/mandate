/**
 * Server-side folder browser for the setup wizard / New project, confined to the user's home directory: every path
 * is resolved with realpath (symlinks followed) and must stay inside the real home; entries whose target escapes
 * are hidden. Directory listings only show names and flags; file contents are never read here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class FsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class FolderBrowser {
  readonly home: string;

  constructor(home = os.homedir()) {
    this.home = realpathSync(home);
  }

  private inside(p: string) {
    return p === this.home || p.startsWith(`${this.home}${path.sep}`);
  }

  /** Resolve a user path (absolute, `~/…` or relative to home) to a real path inside home, or throw. */
  resolve(p: string | undefined, mustExist = true): string {
    const raw = !p || p === '~' ? this.home : p.startsWith('~/') ? path.join(this.home, p.slice(2)) : path.resolve(this.home, p);
    if (raw.includes('\0')) throw new FsError(400, 'invalid path');
    if (!existsSync(raw)) {
      if (mustExist) throw new FsError(404, `${raw} does not exist`);
      // A path to create: its nearest existing ancestor must be inside home.
      let a = path.dirname(raw);
      while (!existsSync(a)) a = path.dirname(a);
      const real = path.join(realpathSync(a), path.relative(a, raw));
      if (!this.inside(real)) throw new FsError(403, 'outside your home folder');
      return real;
    }
    const real = realpathSync(raw);
    if (!this.inside(real)) throw new FsError(403, 'outside your home folder');
    return real;
  }

  list(p: string | undefined, o: { files?: boolean; hidden?: boolean } = {}) {
    const dir = this.resolve(p);
    if (!statSync(dir).isDirectory()) throw new FsError(400, 'not a folder');
    const entries: { name: string; path: string; isDir: boolean; isGitRepo: boolean }[] = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!o.hidden && d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      let real: string;
      let st;
      try {
        real = realpathSync(full);
        st = statSync(real);
      } catch {
        continue;
      }
      if (!this.inside(real)) continue; // symlink escaping home
      if (!st.isDirectory() && !(o.files && st.isFile())) continue;
      entries.push({ name: d.name, path: full, isDir: st.isDirectory(), isGitRepo: st.isDirectory() && existsSync(path.join(real, '.git')) });
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: dir, parent: dir === this.home ? null : path.dirname(dir), home: this.home, entries };
  }

  mkdir(p: string): string {
    const target = this.resolve(p, false);
    mkdirSync(target, { recursive: true });
    return target;
  }

  /** Git facts of a folder (repo root?, origin remote, branch, Mandate layout) from `.git` files, no git process. */
  inspect(p: string) {
    const dir = this.resolve(p);
    const gitDir = path.join(dir, '.git');
    const isGitRepo = existsSync(gitDir);
    let remote: string | null = null;
    let branch: string | null = null;
    if (isGitRepo && statSync(gitDir).isDirectory()) {
      try {
        const cfg = readFileSync(path.join(gitDir, 'config'), 'utf8');
        const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
        remote = m ? m[1]!.replace(/\/\/[^/@\s]*@/, '//') : null; // never echo credentials embedded in a URL
      } catch {
        remote = null;
      }
      try {
        branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))?.[1]?.trim() ?? null;
      } catch {
        branch = null;
      }
    }
    // Inside another repository (no .git here but one above): registering it would nest or touch that repo.
    let enclosing: string | null = null;
    if (!isGitRepo) {
      for (let d = path.dirname(dir); d !== path.dirname(d); d = path.dirname(d)) {
        if (existsSync(path.join(d, '.git'))) {
          enclosing = d;
          break;
        }
      }
    }
    return { path: dir, isGitRepo, remote, branch, hasMandateLayout: ['specs', 'standards'].some((x) => existsSync(path.join(dir, x))), enclosingRepo: enclosing };
  }
}
