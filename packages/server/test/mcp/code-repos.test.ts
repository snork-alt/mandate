/**
 * Code repositories and code claims: registered short names (validation, settings, UI routes, unlinked names),
 * project_info.codeRepos, code_context_set (session state, Code-Context trailer on every write, mismatch notes),
 * repo + commit on claims about code (refused with registered repos, a warning when none), dirty claims linked on
 * work_order_complete.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpFixture, type McpFixture } from './fixture.js';
import { checkCodeRepos as validateList, memorySettings, projectSettings, MemoryClientStore } from '../../src/projects/settings.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { registerCodeRepoRoutes } from '../../src/projects/code-repos-routes.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { KeyStore } from '../../src/auth/keys.js';
import { codeRepoProblems, defaultCodeRepoName } from '@mandate/shared';

vi.setConfig({ testTimeout: 60_000 });

const settings = memorySettings({}, 'test', new MemoryClientStore(), { specsRepo: 'acme/product-specs' });
let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture({ settings });
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const AGENT = 'impl@test';
const NO_AGENT = new Set(['code_context_set', 'project_info', 'work_order_get']);
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { ...(NO_AGENT.has(name) ? {} : { agent: AGENT }), ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, { ...(NO_AGENT.has(name) ? {} : { agent: AGENT }), ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; hint?: string };
}
const lastMessage = () => execFileSync('git', ['-C', fx.dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });

async function specWithCriterion() {
  const id = uid('cr');
  await ok('spec_create', {
    id,
    title: id,
    summary: 'Code claims test.',
    sections: [
      { id: 'overview', title: 'Overview', summary: 'What.', body: 'Body.' },
      { id: 'ac-works', title: 'Ac works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'Proven.' },
    ],
  });
  return id;
}
async function claimedWorkOrder(spec: string) {
  const wo = await ok('work_order_create', { spec, sections: ['overview'], kind: 'implement', plan: '1. Do it.' });
  await ok('work_order_claim', { ref: wo.ref });
  return wo.ref as string;
}

describe('code repo lists', () => {
  it('validates short names, uniqueness and the specs repo; default names', () => {
    expect(defaultCodeRepoName('acme/Web_App')).toBe('web-app');
    expect(codeRepoProblems([{ name: 'api', github: 'acme/api' }, { name: 'api', github: 'acme/mobile' }])[0]).toMatchObject({ index: 1, field: 'name', message: 'api is already used by acme/api. Short names must be unique.' });
    expect(codeRepoProblems([{ name: 'Web App', github: 'acme/web' }])[0]?.field).toBe('name');
    expect(codeRepoProblems([{ name: 'specs', github: 'Acme/Product-Specs' }], 'acme/product-specs')[0]?.message).toContain("can't also be a code repository");
    expect(() => validateList([{ name: 'a', github: 'acme/a' }, { name: 'b', github: 'acme/a' }], null)).toThrow(/already linked as a/);
  });
});

describe('code claims with no code repos registered (existing projects)', () => {
  it('accepts claims with a warning; project_info lists none', async () => {
    await settings.setCodeRepos!([]);
    const info = await ok('project_info');
    expect(info.codeRepos).toEqual([]);
    const spec = await specWithCriterion();
    const v = await ok('verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test' });
    expect(v.warnings.join('\n')).toContain('code_repos_unregistered');
    const wo = await claimedWorkOrder(spec);
    const t = await ok('work_order_touch', { ref: wo, files: ['app:src/a.ts#L1-L2'] });
    expect(t.warnings.join('\n')).toMatch(/code_repos_unregistered|code_commit_missing/);
  });
});

describe('code context (session)', () => {
  it('code_context_set stores it per session, project_info returns it, every write is stamped', async () => {
    await settings.setCodeRepos!([{ name: 'web-app', github: 'acme/web-app', defaultBranch: 'main' }]);
    const set = await ok('code_context_set', { repo: 'web-app', commit: 'A1B2C3D4E5', branch: 'main' });
    expect(set.label).toBe('web-app@a1b2c3d');
    const info = await ok('project_info');
    expect(info.codeRepos).toEqual([{ name: 'web-app', github: 'acme/web-app', defaultBranch: 'main' }]);
    expect(info.codeContext).toMatchObject({ repo: 'web-app', commit: 'a1b2c3d4e5', branch: 'main' });
    // An intent statement: no extra input, stamped automatically.
    const spec = await specWithCriterion();
    await ok('feedback_create', { targets: [`mandate://specs/${spec}/sections/overview`], kind: 'bug', body: 'b' });
    expect(lastMessage()).toContain('Code-Context: web-app@a1b2c3d');
    // An unknown repo is refused.
    expect((await fail('code_context_set', { repo: 'nope', commit: 'abcdef1' })).code).toBe('unknown_code_repo');
  });
});

describe('code claims with registered code repos', () => {
  it('refuses unregistered repos (with the short-name hint) and code locations without a commit', async () => {
    await settings.setCodeRepos!([{ name: 'web-app', github: 'acme/web-app' }]);
    const spec = await specWithCriterion();
    const crit = `mandate://specs/${spec}/sections/ac-works`;
    const e = await fail('verification_record', { criterion: crit, code: { repo: 'acme/web-app', commit: 'abcdef1234' }, result: 'pass', method: 'test' });
    expect(e.code).toBe('unknown_code_repo');
    expect(e.hint).toContain("'web-app'");
    expect((await fail('verification_record', { criterion: crit, code: { repo: 'web-app', commit: 'xyz' }, result: 'pass', method: 'test' })).code).toBe('invalid_input');
    await ok('code_context_set', { repo: 'web-app', commit: 'abcdef1234' });
    const v = await ok('verification_record', { criterion: crit, code: { repo: 'web-app', commit: 'abcdef1' }, result: 'pass', method: 'test' });
    expect(v.warnings.filter((w: string) => w.startsWith('code_'))).toEqual([]);
    const other = await ok('verification_record', { criterion: crit, code: { repo: 'web-app', commit: '1234567' }, result: 'pass', method: 'test' });
    expect(other.warnings.join('\n')).toContain('code_context_mismatch');

    const wo = await claimedWorkOrder(spec);
    expect((await fail('work_order_touch', { ref: wo, files: ['web-app:src/a.ts'] })).code).toBe('code_commit_required');
    expect((await fail('work_order_touch', { ref: wo, files: ['app:src/a.ts'], code: { repo: 'web-app', commit: 'abcdef1' } })).code).toBe('unknown_code_repo');
    await ok('work_order_touch', { ref: wo, files: ['web-app:src/a.ts#L1-L3'], code: { repo: 'web-app', commit: 'abcdef1234' } });
    const got = await ok('work_order_get', { ref: wo });
    expect(JSON.stringify(got)).toContain('"commits":["abcdef1234"]');
    expect((await fail('work_order_git_update', { ref: wo, repo: 'app', headCommit: 'abcdef1' })).code).toBe('unknown_code_repo');
    expect((await fail('audit_start', { target: `mandate://specs/${spec}` })).code).toBe('code_commit_required');
  });

  it('work_order_complete needs the implementing commit; dirty claims are linked to it', async () => {
    await settings.setCodeRepos!([{ name: 'web-app', github: 'acme/web-app' }]);
    const spec = await specWithCriterion();
    const wo = await claimedWorkOrder(spec);
    await ok('code_context_set', { repo: 'web-app', commit: 'abcdef1', dirty: true });
    const v = await ok('verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'web-app', commit: 'abcdef1', dirty: true }, result: 'pass', method: 'test' });
    expect(v.verification.code).toMatchObject({ dirty: true });
    await ok('work_order_touch', { ref: wo, files: ['web-app:src/b.ts'], code: { repo: 'web-app', commit: 'abcdef1', dirty: true } });
    expect((await fail('work_order_complete', { ref: wo, outcome: 'Done.' })).code).toBe('code_commit_required');
    const done = await ok('work_order_complete', { ref: wo, outcome: 'Done.', git: [{ repo: 'web-app', headCommit: 'fedcba9876' }] });
    expect(done.codeLinks).toEqual([{ ref: v.ref, repo: 'web-app', base: 'abcdef1', commit: 'fedcba9876' }]);
    const got = await ok('work_order_get', { ref: wo });
    expect(JSON.stringify(got)).toContain('"commits":["fedcba9876"]');
    expect(JSON.stringify(got)).toContain('"codeLinks"');
  });
});

describe('UI: Settings → Code repositories', () => {
  it('lists registered and unlinked names; admins update (validated)', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mandate-cr-'));
    const file = path.join(home, 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'web', name: 'Web', dataDir: home, github: { owner: 'acme', repo: 'product-specs' }, connectedBy: 'admin', createdAt: 'x' }] }));
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    const projects = new ProjectsStore(file);
    const registry = new ProjectRegistry([{ id: 'web', name: 'Web', dataDir: home } as never], async (p) => ({ config: p, storage: fx.storage, git: fx.storage.git, activity: fx.activity }) as never);
    const app = Fastify();
    registerCodeRepoRoutes(app, { auth: { keys: new KeyStore(path.join(home, 'keys.json')), store, isAdmin: (l) => l === 'admin' }, hostOk: () => true, registry, settings: (id) => projectSettings(projects, id, new MemoryClientStore(), (l) => l === 'admin') });
    await app.ready();
    const cookie = async (login: string) => `mandate_session=${await store.createSession({ login, avatarUrl: '', kind: 'github' } as never)}`;
    const req = async (method: 'GET' | 'PUT', url: string, login: string, body?: unknown) =>
      app.inject({ method, url, headers: { host: 'localhost', 'x-mandate-ui': '1', cookie: await cookie(login), ...(method === 'PUT' ? { origin: 'http://localhost', 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });

    const before = (await req('GET', '/ui/code-repos?project=web', 'ada')).json();
    expect(before.admin).toBe(false);
    expect(before.projects[0]).toMatchObject({ id: 'web', specsRepo: 'acme/product-specs', codeRepos: [] });
    // Names used in the data before registration (the seeded data and the tests above use `app` / `web-app`).
    expect(before.projects[0].unlinked.map((u: { name: string }) => u.name)).toContain('app');

    expect((await req('PUT', '/ui/code-repos/web', 'ada', { codeRepos: [{ name: 'app', github: 'acme/app' }] })).statusCode).toBe(403);
    const dup = await req('PUT', '/ui/code-repos/web', 'admin', { codeRepos: [{ name: 'app', github: 'acme/app' }, { name: 'app', github: 'acme/other' }] });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe('invalid_code_repos');
    expect((await req('PUT', '/ui/code-repos/web', 'admin', { codeRepos: [{ name: 'specs', github: 'acme/product-specs' }] })).statusCode).toBe(400);
    const saved = (await req('PUT', '/ui/code-repos/web', 'admin', { codeRepos: [{ name: 'app', github: 'acme/app' }] })).json();
    expect(saved.codeRepos).toEqual([{ name: 'app', github: 'acme/app' }]);
    expect(saved.unlinked.map((u: { name: string }) => u.name)).not.toContain('app');
    // Renaming the GitHub repo keeps the short name (the stable key).
    const renamed = (await req('PUT', '/ui/code-repos/web', 'admin', { codeRepos: [{ name: 'app', github: 'acme/app-renamed' }] })).json();
    expect(renamed.codeRepos).toEqual([{ name: 'app', github: 'acme/app-renamed' }]);
    expect(projects.read().projects[0]!.codeRepos).toEqual([{ name: 'app', github: 'acme/app-renamed' }]);
    await app.close();
  });
});
