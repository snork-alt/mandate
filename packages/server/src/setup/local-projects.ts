/**
 * Local mode: create a project in the projects folder (`git init`, or clone when a remote is given) or register an
 * existing folder / repo (git-inited when it is not a repository; refused when it sits inside another repository).
 * The optional remote is pushed with the user's own git credentials (auto-push). Registered in projects.json.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type ProjectConfig } from '../config.js';
import { createGitStore } from '../git/index.js';
import type { KeyStore } from '../auth/keys.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { ProjectsStore } from '../projects/store.js';
import { AdminError, assignProjectId, LAYOUT_DIRS, LAYOUT_FILES, parseProjectInput } from '../projects/admin.js';
import { projectSummary } from '../mcp/http.js';
import type { FolderBrowser } from './fs.js';

/** https / ssh / scp-like / file remotes, never with credentials in the URL. */
const remoteSchema = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|\/)[^\s]+$|^[\w.-]+@[\w.-]+:[^\s]+$/.test(u), 'a git remote URL (https://…, ssh://…, git@host:owner/repo.git or a path)')
  .refine((u) => !/^[a-z]+:\/\/[^/@\s]*:[^/@\s]*@/i.test(u), 'no credentials in the URL (use your git credential helper or SSH key)');

export const localProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    mode: z.enum(['new', 'existing']),
    /** existing: the folder (inside your home). */
    path: z.string().min(1).max(1000).optional(),
    remote: remoteSchema.optional(),
    branch: z.string().trim().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/, 'a branch name').optional(),
  })
  .strict()
  .refine((x) => x.mode === 'new' || !!x.path, { message: 'pick the folder to add', path: ['path'] });

export interface LocalProjectDeps {
  registry: ProjectRegistry;
  projects: ProjectsStore;
  keys: KeyStore;
  browser: FolderBrowser;
  baseDir: string;
  resolveProject: (id: string) => ProjectConfig;
  log?: { info(m: string): void };
}

const nested = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);

function addOrigin(dir: string, url: string) {
  appendFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

export async function createLocalProject(d: LocalProjectDeps, raw: unknown, progress: (step: 'init' | 'register' | 'key', status: 'start' | 'done') => void = () => undefined) {
  const data = parseProjectInput(localProjectInputSchema, raw);
  const known = new Set(d.projects.read().projects.map((p) => p.id));
  const id = await assignProjectId(data.name, (c) => known.has(c) || !!d.registry.config(c) || (data.mode === 'new' && existsSync(path.join(d.baseDir, c))));
  const input = { ...data, id };
  if (d.registry.config(input.id)) throw new AdminError(409, 'project_exists', `a project '${input.id}' already exists`, 'id', 'pick another id');

  let dir: string;
  let created = false;
  let info: ReturnType<FolderBrowser['inspect']> | null = null;
  try {
    if (input.mode === 'new') {
      dir = d.browser.resolve(path.join(d.baseDir, input.id), false);
      if (existsSync(dir)) throw new AdminError(409, 'project_exists', `${dir} already exists`, 'id', 'pick another id, or use "Add an existing repo"');
    } else {
      dir = d.browser.resolve(input.path);
      info = d.browser.inspect(dir);
      if (!info.isGitRepo && info.enclosingRepo) throw new AdminError(400, 'invalid_input', `${dir} is inside the git repository ${info.enclosingRepo}`, 'path', 'pick the repository root, or a folder that is not inside another repository');
    }
  } catch (e) {
    if (e instanceof AdminError) throw e;
    throw new AdminError((e as { status?: number }).status ?? 400, 'invalid_input', (e as Error).message, 'path');
  }
  for (const p of d.registry.list()) {
    if (nested(dir, p.dataDir)) throw new AdminError(409, 'folder_overlap', `project '${p.id}' already uses ${p.dataDir}`, 'path', 'pick a folder that is not inside (or around) another project');
  }
  const remote = input.remote ?? info?.remote ?? undefined;
  const branch = input.branch ?? info?.branch ?? 'main';

  progress('init', 'start');
  try {
    if (input.mode === 'new' && !remote) {
      mkdirSync(dir, { recursive: true });
      created = true;
      await createGitStore({ dataDir: dir, branch, author: { name: 'Mandate', email: 'mandate@localhost' } }).init();
    } else if (input.mode === 'existing' && !info!.isGitRepo) {
      await createGitStore({ dataDir: dir, branch, author: { name: 'Mandate', email: 'mandate@localhost' } }).init();
      if (remote) addOrigin(dir, remote);
    } else if (input.mode === 'existing' && remote && !info!.remote) {
      addOrigin(dir, remote);
    } else if (input.mode === 'new') {
      created = true; // cloned by the opener (remote given)
    }
  } catch (e) {
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new AdminError(500, 'init_failed', `git init failed: ${(e as Error).message}`, 'path');
  }
  progress('init', 'done');

  progress('register', 'start');
  try {
    await d.projects.mutate((reg) => {
      if (reg.projects.some((p) => p.id === input.id)) throw new AdminError(409, 'project_exists', `a project '${input.id}' already exists`, 'id');
      reg.projects.push({
        id: input.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        dataDir: dir,
        createdAt: new Date().toISOString(),
        git: { branch, ...(remote ? { remote } : {}) },
      });
    });
  } catch (e) {
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e instanceof AdminError ? e : new AdminError(500, 'invalid_input', (e as Error).message);
  }
  const rollback = async () => {
    await d.registry.remove(input.id).catch(() => undefined);
    await d.projects.remove(input.id).catch(() => undefined);
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  let rt;
  try {
    if (!d.registry.config(input.id)) d.registry.add(d.resolveProject(input.id));
    rt = await d.registry.open(input.id); // clones when a new project has a remote
    const added: string[] = [];
    for (const x of LAYOUT_DIRS) {
      if (!existsSync(path.join(dir, x))) {
        mkdirSync(path.join(dir, x), { recursive: true });
        writeFileSync(path.join(dir, x, '.gitkeep'), '');
        added.push(`${x}/.gitkeep`);
      }
    }
    for (const f of LAYOUT_FILES) {
      if (!existsSync(path.join(dir, f))) {
        writeFileSync(path.join(dir, f), '');
        added.push(f);
      }
    }
    if (added.length) await rt.storage.lock.run(() => rt!.git.commit(added, `mandate: initialize project ${input.id}\n\nAgent: mandate-setup\n`));
  } catch (e) {
    await rollback();
    throw new AdminError(500, 'init_failed', `opening the project failed: ${(e as Error).message}`, input.mode === 'existing' ? 'path' : 'remote');
  }
  progress('register', 'done');
  progress('key', 'start');
  d.keys.ensureProjectKeys([input.id]);
  progress('key', 'done');
  d.log?.info(`local project '${input.id}' at ${dir}${remote ? ` (remote ${remote})` : ''}`);
  return projectSummary(rt, d.registry.info(input.id)!);
}
