/**
 * Package identity and paths. The npm package name lives ONLY in package.json (`name`); everything else reads it
 * from here, so renaming the package is a one-line change.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageJson(from: string): string {
  let dir = from;
  for (;;) {
    const p = path.join(dir, 'package.json');
    if (existsSync(p) && (JSON.parse(readFileSync(p, 'utf8')) as { bin?: Record<string, string> }).bin?.mandate) return p;
    const up = path.dirname(dir);
    if (up === dir) throw new Error('package.json of the Mandate CLI not found');
    dir = up;
  }
}

/** Root of the installed package (holds package.json and dist/). */
export const PKG_ROOT = path.dirname(findPackageJson(path.dirname(fileURLToPath(import.meta.url))));
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
/** npm package name (`npx <PKG_NAME> install`). */
export const PKG_NAME = pkg.name;
export const PKG_VERSION = pkg.version;
/** The installed command. */
export const BIN = 'mandate';
/** The bundled server entry (dist/server.js); absent when running from source. */
export const SERVER_ENTRY = path.join(PKG_ROOT, 'dist', 'server.js');

/** Everything the CLI touches, derived from one env (tests pass a temp HOME / MANDATE_HOME). */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  /** User home (agent configs live here). */
  home: string;
  /** `~/.mandate` (MANDATE_HOME). */
  mandateHome: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** --force: also write capabilities marked unverified in the adapter registry. */
  force?: boolean;
}

export function makeCtx(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): Ctx {
  const home = env.HOME || os.homedir();
  const mh = env.MANDATE_HOME ? path.resolve(env.MANDATE_HOME.replace(/^~(?=$|\/)/, home)) : path.join(home, '.mandate');
  return { env, home, mandateHome: mh, platform, cwd };
}

export const configFile = (ctx: Ctx) => (ctx.env.MANDATE_CONFIG ? path.resolve(ctx.env.MANDATE_CONFIG) : path.join(ctx.mandateHome, 'config.json'));
export const keysFile = (ctx: Ctx) => (ctx.env.MANDATE_KEYS_FILE ? path.resolve(ctx.env.MANDATE_KEYS_FILE) : path.join(ctx.mandateHome, 'keys.json'));
export const projectsFile = (ctx: Ctx) => (ctx.env.MANDATE_PROJECTS_FILE ? path.resolve(ctx.env.MANDATE_PROJECTS_FILE) : path.join(ctx.mandateHome, 'projects.json'));
export const logFile = (ctx: Ctx) => path.join(ctx.mandateHome, 'logs', 'server.log');
export const envFile = (ctx: Ctx) => path.join(ctx.mandateHome, 'env.sh');
export const manifestFile = (ctx: Ctx) => path.join(ctx.mandateHome, 'wiring.json');
export const expand = (ctx: Ctx, p: string) => (p === '~' ? ctx.home : p.startsWith('~/') ? path.join(ctx.home, p.slice(2)) : path.resolve(p));
