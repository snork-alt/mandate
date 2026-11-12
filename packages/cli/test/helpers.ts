import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, type Ctx } from '../src/context.js';
import type { Out } from '../src/ui.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp HOME (never the real one) with PATH detection off; removed after the test file. */
export function tempCtx(platform: NodeJS.Platform = 'darwin'): Ctx & { dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-cli-'));
  dirs.push(dir);
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, MANDATE_HOME: path.join(home, '.mandate'), MANDATE_NO_PATH_DETECT: '1', MANDATE_NO_BROWSER: '1', SHELL: '/bin/zsh', NO_COLOR: '1', PATH: process.env.PATH };
  return { ...makeCtx(env, dir, platform), dir };
}

export function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Registry with projects (the server's projects.json shape). */
export function registerProjects(ctx: Ctx, ids: string[]): void {
  write(path.join(ctx.mandateHome, 'projects.json'), JSON.stringify({ version: 1, projects: ids.map((id) => ({ id, name: id, dataDir: path.join(ctx.home, 'mandate', id), createdAt: '2026-01-01T00:00:00.000Z' })) }));
}

/** Every file under `dir` (relative path → content). */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export function capture(): Out & { text(): string } {
  const lines: string[] = [];
  return { log: (s = '') => lines.push(s), err: (s) => lines.push(s), text: () => lines.join('\n') };
}
