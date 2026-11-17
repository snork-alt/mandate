/**
 * Commit authorship: a write triggered by a signed-in GitHub user (web UI or MCP with per-user auth) is authored by
 * that user (`<name or login> <<id>+<login>@users.noreply.github.com>`) and committed by Mandate (`git.author`);
 * background / system / service-account commits stay authored by Mandate. Trailers and attribution are unchanged.
 * Both git backends.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { CliGitStore } from '../../src/git/CliGitStore.js';
import type { GitStore } from '../../src/git/GitStore.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { setUserDirectory, UserDirectory } from '../../src/auth/users.js';
import type { Principal } from '../../src/auth/http.js';
import { commitAuthor } from '../../src/git/author.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../../data/repo');
const MANDATE = { name: 'Mandate', email: 'mandate@example.com' };

beforeAll(async () => {
  const dir = new UserDirectory(path.join(await tempDir(), 'users.json'));
  dir.record({ login: 'ada', name: 'Ada Lovelace', id: 42 });
  dir.record({ login: 'octocat', name: null, id: 583231 });
  setUserDirectory(dir);
});
afterAll(async () => {
  setUserDirectory(null);
  await cleanupTempDirs();
});

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const spec = (id: string) => ({ title: id, summary: 'Author test.', sections: [{ title: 'Overview', summary: 'What.', body: 'Body.' }] });

describe.each([
  ['embedded', (dir: string) => new EsGitStore({ dir, author: MANDATE })],
  ['cli', (dir: string) => new CliGitStore({ dir, author: MANDATE })],
] as const)('commit author (%s backend)', (_name, make) => {
  let dir: string;
  let git: GitStore;
  let storage: Storage;
  beforeAll(async () => {
    dir = path.join(await tempDir(), 'repo');
    execFileSync('git', ['clone', '-q', SOURCE, dir]);
    git = make(dir);
    await git.open();
    storage = createStorage(git);
  }, 60_000);

  const ctxOf = (principal?: Principal, clientName = 'claude-code'): ToolContext =>
    ({ storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), settings: memorySettings(), clientName, ...(principal ? { principal } : {}) }) as ToolContext;
  const call = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
    const r = await callTool(tool(name), args, ctx);
    const body = r.structuredContent as Record<string, any>;
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
    return body;
  };
  const head = (fmt: string) => execFileSync('git', ['-C', dir, 'log', '-1', `--format=${fmt}`], { encoding: 'utf8' }).trim();

  it('MCP write with per-user auth: authored by the GitHub user, committed by Mandate; trailers + attribution unchanged', async () => {
    const user: Principal = { kind: 'user', login: 'octocat', project: 'test', via: 'oauth', tokenId: 'c1', tokenName: 'claude-code' };
    const id = uid('auth');
    await call(ctxOf(user), 'spec_create', spec(id));
    expect(head('%an <%ae>')).toBe('octocat <583231+octocat@users.noreply.github.com>');
    expect(head('%cn <%ce>')).toBe('Mandate <mandate@example.com>');
    const msg = head('%B');
    expect(msg).toMatch(/^Mandate-User: octocat$/m);
    expect(msg).toMatch(/^Agent-User: octocat$/m);
    expect(msg).toMatch(/^Agent: claude-code$/m);
    expect(msg).toMatch(/^Agent-Key: oauth:claude-code$/m);
    const h = await call(ctxOf(user), 'history_get', { ref: `mandate://specs/${id}` });
    expect(h.entries[0]).toMatchObject({ user: 'octocat', agent: 'claude-code' });
    const meta = await storage.history.meta(`specs/${id}.md`);
    expect(meta.createdBy).toMatchObject({ user: 'octocat', agent: 'claude-code' });
  });

  it('web UI action: authored by the signed-in user (directory name + noreply id)', async () => {
    const s = (await storage.specs.list()).find((x) => x.status !== 'archived' && x.sections.length)!;
    const fb = await call(ctxOf(), 'request_create', { targets: [`mandate://specs/${s.id}/sections/${s.sections[0]!.id}`], kind: 'bug', body: 'author test', agent: 't' });
    // An agent key without a user: Mandate authors.
    expect(head('%an <%ae>')).toBe('Mandate <mandate@example.com>');
    const ui = { ...ctxOf({ kind: 'ui', user: { login: 'ada', avatarUrl: '' } }, 'mandate-web'), access: 'read', uiAccess: 'write' } as ToolContext;
    await call(ui, 'request_close', { ref: fb.ref, resolution: 'rejected', resolutionNote: 'not now' });
    expect(head('%an <%ae>')).toBe('Ada Lovelace <42+ada@users.noreply.github.com>');
    expect(head('%cn <%ce>')).toBe('Mandate <mandate@example.com>');
    expect(head('%B')).toMatch(/^Mandate-User: ada$/m);
    expect(head('%B')).toMatch(/^Agent: mandate-ui$/m);
  });

  it('service-account keys and background commits stay authored by Mandate', async () => {
    const svc: Principal = { kind: 'key', keyId: 'k1', keyName: 'ci', project: 'test', service: true };
    await call(ctxOf(svc), 'spec_create', spec(uid('svc')));
    expect(head('%an <%ae>')).toBe('Mandate <mandate@example.com>');
    expect(head('%B')).toMatch(/^Mandate-User: service:ci$/m);
    // A system commit (sync / migration): no user trailer.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'bg.txt'), 'x');
    await git.commit(['bg.txt'], 'mandate: migrate something\n\nAgent: mandate\n');
    expect(head('%an <%ae>|%cn <%ce>')).toBe('Mandate <mandate@example.com>|Mandate <mandate@example.com>');
  });
});

describe('commitAuthor', () => {
  it('reads the user trailer only from the trailer block; unknown users get the plain noreply address', () => {
    expect(commitAuthor('s\n\nMandate-User: someone\n')).toEqual({ name: 'someone', email: 'someone@users.noreply.github.com' });
    expect(commitAuthor('s\n\nMandate-User: ada\nnot a trailer line')).toBeNull();
    expect(commitAuthor('s\n\nAgent: x\n')).toBeNull();
    expect(commitAuthor('s\n\nMandate-User: service:ci\n')).toBeNull();
    expect(commitAuthor('s\n\nMandate-User: ada\n', { name: 'X', email: 'x@y' })).toEqual({ name: 'X', email: 'x@y' });
  });
});
