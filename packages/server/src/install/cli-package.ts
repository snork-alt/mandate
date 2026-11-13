/**
 * The CLI package this server runs from, served as an npm tarball (`GET /getmandate.tgz`) so the installer can
 * `npm install -g` the server's EXACT version without the npm registry (the package need not be published).
 *
 * Source: the installed package (dist/server.js lives in it) or, in the repo, packages/cli (its built dist/). The
 * tarball is made by `npm pack` (same file list and package.json normalisation as a publish: the bundled dist with the
 * workspace packages inlined; only the native dependencies, which come from the public registry, stay external).
 * It is cached under `<MANDATE_HOME>/cache/cli/`, keyed by version + a fingerprint of package.json and dist/ (a rebuilt
 * dist gets a new tarball), written to a temp dir then renamed (atomic: concurrent servers never see half a file),
 * and packed once per process (concurrent requests share the same promise).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliPackage {
  /** Directory holding package.json and dist/. */
  dir: string;
  name: string;
  version: string;
}

export interface CliTarballInfo {
  path: string;
  sha256: string;
  size: number;
  version: string;
}

const isCli = (dir: string): CliPackage | null => {
  const p = path.join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string; bin?: Record<string, string> };
    return j.bin?.mandate && j.name && j.version ? { dir, name: j.name, version: j.version } : null;
  } catch {
    return null;
  }
};

/**
 * The CLI package: `MANDATE_CLI_PACKAGE_DIR`, else the first ancestor of this module that is it (installed package),
 * or holds it at packages/cli (the repo). Null when not found or not built (no dist/cli.js).
 */
export function findCliPackage(env: NodeJS.ProcessEnv = process.env, from = path.dirname(fileURLToPath(import.meta.url))): CliPackage | null {
  const built = (p: CliPackage | null) => (p && existsSync(path.join(p.dir, 'dist', 'cli.js')) ? p : null);
  if (env.MANDATE_CLI_PACKAGE_DIR) return built(isCli(path.resolve(env.MANDATE_CLI_PACKAGE_DIR)));
  let dir = from;
  for (;;) {
    const found = isCli(dir) ?? isCli(path.join(dir, 'packages', 'cli'));
    if (found) return built(found);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Cheap fingerprint of what `npm pack` would ship: package.json bytes + every dist/ file's path, size and mtime. */
function fingerprint(dir: string): string {
  const h = createHash('sha256').update(readFileSync(path.join(dir, 'package.json')));
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const s = statSync(p);
        h.update(`${path.relative(dir, p)}\0${s.size}\0${s.mtimeMs}\n`);
      }
    }
  };
  walk(path.join(dir, 'dist'));
  for (const f of ['README.md', 'LICENSE.md']) if (existsSync(path.join(dir, f))) h.update(`${f}\0${statSync(path.join(dir, f)).mtimeMs}\n`);
  return h.digest('hex').slice(0, 16);
}

const fileSha256 = (p: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (b) => h.update(b))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

export type Packer = (pkgDir: string, dest: string) => Promise<string>;

/** `npm pack --ignore-scripts --pack-destination <dest>`; returns the tarball's file name. */
export const npmPack: Packer = (pkgDir, dest) =>
  new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    execFile(win ? 'npm.cmd' : 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dest], { cwd: pkgDir, shell: win, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`npm pack failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      try {
        const out = JSON.parse(stdout.slice(stdout.indexOf('['))) as { filename: string }[];
        resolve(out[0]!.filename);
      } catch {
        reject(new Error('npm pack: unexpected output'));
      }
    });
  });

/** The tarball of `pkg`, built on first use into `cacheDir` (see the module comment). */
export class CliTarball {
  private inflight: { key: string; p: Promise<CliTarballInfo> } | null = null;

  constructor(
    readonly pkg: CliPackage,
    private readonly cacheDir: string,
    private readonly pack: Packer = npmPack,
  ) {}

  get version(): string {
    return this.pkg.version;
  }

  /** Path + sha256 of the tarball for the current dist (packs it if needed). */
  get(): Promise<CliTarballInfo> {
    const key = `${this.pkg.version}-${fingerprint(this.pkg.dir)}`;
    if (this.inflight?.key !== key) {
      const p = this.build(key);
      this.inflight = { key, p };
      p.catch(() => {
        if (this.inflight?.p === p) this.inflight = null; // retry on the next request
      });
    }
    return this.inflight.p;
  }

  private async build(key: string): Promise<CliTarballInfo> {
    const file = path.join(this.cacheDir, `getmandate-${key}.tgz`);
    if (!existsSync(file)) {
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = await mkdtemp(path.join(this.cacheDir, '.pack-'));
      try {
        const name = await this.pack(this.pkg.dir, tmp);
        await rename(path.join(tmp, name), file);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      // Older tarballs (other versions / builds) are no longer served.
      for (const f of await readdir(this.cacheDir)) {
        if (f.startsWith('getmandate-') && f.endsWith('.tgz') && path.join(this.cacheDir, f) !== file) await rm(path.join(this.cacheDir, f), { force: true });
      }
    }
    return { path: file, sha256: await fileSha256(file), size: (await stat(file)).size, version: this.pkg.version };
  }
}
