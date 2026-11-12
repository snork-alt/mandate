import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initRepository } from 'es-git';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema, createStandardSchema } from '@mandate/shared';
import { createStorage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir, testBackend } from './helpers.js';

afterEach(cleanupTempDirs);

/** A minimal one-section spec input. */
const spec = (title: string, body: string) =>
  createSpecSchema.parse({ title, sections: [{ id: 'main', title: 'Main', body }] });
const std = (title: string, body: string) =>
  createStandardSchema.parse({ title, sections: [{ id: 'rules', title: 'Rules', body }] });
const bodyOf = (s: { sections: { body: string }[] }) => s.sections[0]?.body;

describe(`EntityRepository + GitStore (${testBackend})`, () => {
  it('commits every create/update/delete', async () => {
    const dir = await tempDir();
    const git = await newStore(path.join(dir, 'repo'));
    const storage = createStorage(git);

    const created = await storage.specs.create(spec('Hello World', 'Hi'));
    expect(created.id).toBe('hello-world');
    const raw = await readFile(path.join(git.dir, 'specs/hello-world.md'), 'utf8');
    expect(raw).toBe(
      '---\ntitle: Hello World\nstatus: draft\nsections:\n  - id: main\n    title: Main\n    type: markdown\n---\n\n<!-- @section main -->\n## Main\n\nHi\n',
    );

    const updated = await storage.specs.update('hello-world', {
      sections: [{ id: 'main', title: 'Main', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: 'changed' }],
      status: 'ready',
    });
    expect(updated).toMatchObject({ status: 'ready', tags: [] });
    expect(bodyOf(await storage.specs.get('hello-world'))).toBe('changed');

    // Documents are archive-only (C3): delete is refused, archiving is a status.
    await expect(storage.specs.delete('hello-world')).rejects.toMatchObject({ statusCode: 409, code: 'archive_only' });
    await storage.specs.update('hello-world', { status: 'archived' });
    expect(existsSync(path.join(git.dir, 'specs/hello-world.md'))).toBe(true);

    const log = await git.log();
    expect(log.map((c) => c.message)).toEqual([
      'spec: update hello-world',
      'spec: update hello-world',
      'spec: create hello-world',
    ]);
    expect((await git.status()).clean).toBe(true);
    expect((await git.status()).branch).toBe('main');
  });

  it('derives times, authors and history from git, including trailers', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    const t0 = new Date('2026-01-01T10:00:00Z');
    const t1 = new Date('2026-01-02T12:00:00Z');
    await storage.specs.create(spec('Timed', 'x'), { date: t0 });
    await storage.standards.create(std('Unrelated', ''), { date: t1 });
    await storage.specs.update('timed', { status: 'ready' }, { date: t1, message: 'spec(timed): start', agent: 'claude@box', branch: 'spec/timed' });

    const file = storage.specs.pathOf('timed');
    expect(await storage.history.meta(file)).toEqual({
      createdAt: t0.toISOString(),
      updatedAt: t1.toISOString(),
      updatedBy: 'claude@box',
      revisions: 2,
      versionCount: 2,
      lastCommit: (await git.log(1))[0]!.id,
    });
    const log = await storage.history.log(file);
    expect(log.map((h) => h.subject)).toEqual(['spec(timed): start', 'spec: create timed']);
    expect(log[0]).toMatchObject({ agent: 'claude@box', branch: 'spec/timed', trailers: { Agent: 'claude@box', Branch: 'spec/timed' }, body: '' });
    expect(log[1]).toMatchObject({ author: 'Test', agent: undefined, trailers: {} });
    expect((await storage.history.meta(storage.standards.pathOf('unrelated'))).revisions).toBe(1);
  });

  it('reads files at past commits and builds versions', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(spec('Versioned', 'one'));
    const c1 = (await git.log(1))[0]!.id;
    await storage.specs.update('versioned', { status: 'ready' });
    const c2 = (await git.log(1))[0]!.id;
    // A hand-made deletion (documents cannot be deleted through the storage API).
    const { rm } = await import('node:fs/promises');
    await rm(path.join(git.dir, 'specs/versioned.md'));
    const c3 = (await git.commit(['specs/versioned.md'], 'spec: delete versioned by hand'))!;
    const file = storage.specs.pathOf('versioned');

    expect(await git.resolveCommit(c1.slice(0, 7))).toBe(c1);
    expect(await git.resolveCommit('nope')).toBeNull();
    expect(await git.readFileAt(c1, file)).toContain('status: draft');
    expect(await git.readFileAt(c2, file)).toContain('status: ready');
    expect(await git.readFileAt(c3, file)).toBeNull();
    expect(await git.readFileAt(c1, 'specs')).toBeNull(); // directory
    await expect(git.readFileAt('deadbeef', file)).rejects.toThrow(/unknown commit/);

    const created = await storage.history.version(file, c1.slice(0, 8));
    expect(created).toMatchObject({ commit: c1, status: 'added', before: null, base: null, older: null, newer: c2, index: 1, total: 3 });
    const modified = await storage.history.version(file, c2);
    expect(modified).toMatchObject({ status: 'modified', base: c1, older: c1, newer: c3, index: 2 });
    expect(modified.before).toContain('draft');
    expect(modified.after).toContain('ready');
    const deleted = await storage.history.version(file, c3);
    expect(deleted).toMatchObject({ status: 'deleted', after: null, newer: null, index: 3 });
    const vsHead = await storage.history.version(file, c1, 'head');
    expect(vsHead).toMatchObject({ against: 'head', base: c1, after: null, status: 'deleted' });
    await expect(storage.history.version('specs/other.md', c1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists the other records when one jsonl line is invalid, with its issues attached', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(createSpecSchema.parse({ id: 's', title: 'S', sections: [{ id: 'a', title: 'A', body: 'x' }] }));
    const { id: first } = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] });
    const { appendFile } = await import('node:fs/promises');
    const file = path.join(git.dir, 'work-orders.jsonl');
    await appendFile(file, '{"id":"q-0009","spec":"s","kind":"nope","status":"pending","sections":[]}\nnot json\n');
    const items = (await storage.workOrders.list()) as (Record<string, unknown> & { id: string })[];
    expect(items.map((i) => i.id)).toEqual([first, 'q-0009']);
    expect(items[0]!.validationIssues).toBeUndefined();
    expect((items[1]!.validationIssues as string[]).join(' ')).toMatch(/kind/);
    // Writes stay strict and never persist the annotation.
    await storage.workOrderService.update(first, { status: 'in_progress' });
    expect(await readFile(file, 'utf8')).not.toContain('validationIssues');
    expect(await readFile(file, 'utf8')).toContain('not json'); // unparsable lines are kept, not dropped
  });

  it('reads legacy queue history: `Queue-Item:` trailers and pre-rename ids', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(createSpecSchema.parse({ id: 's', title: 'S', sections: [{ id: 'a', title: 'A', body: 'x' }] }));
    const { writeFile } = await import('node:fs/promises');
    const line = { id: 'q-0007', spec: 's', specCommit: (await git.log(1))[0]!.id.slice(0, 7), kind: 'implement', status: 'pending', sections: [{ id: 'a', status: 'pending' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeFile(path.join(git.dir, 'work-orders.jsonl'), JSON.stringify(line) + '\n');
    await git.commit(['work-orders.jsonl'], 'queue: create q-0007\n\nQueue-Item: q-0007');
    await storage.workOrderService.update('q-0007', { status: 'in_progress' });
    const history = await storage.workOrderService.historyOf('q-0007');
    expect(history.map((h) => h.trailers)).toEqual([{ 'Work-Order': 'q-0007' }, { 'Queue-Item': 'q-0007' }]);
  });

  it('skips invalid files in list() and reports them on get()', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(spec('Good', 'ok'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(git.dir, 'specs/bad.md'), '# no frontmatter\n');
    expect((await storage.specs.list()).map((s) => s.id)).toEqual(['good']);
    await expect(storage.specs.get('bad')).rejects.toMatchObject({ statusCode: 422 });
    await expect(storage.specs.create(spec('Bad', ''))).rejects.toThrow(/already exists/);
  });

  it('stores work orders as JSON Lines and enforces work-order rules', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    const q = storage.workOrderService;
    await storage.specs.create(
      createSpecSchema.parse({ id: 'login', title: 'Login', sections: [{ id: 'a', title: 'A', body: 'x' }, { id: 'b', title: 'B', body: 'y' }] }),
    );
    const specCommit = (await git.log(1))[0]!.id; // pins are stored as full shas (C4)

    const item = await q.create({ spec: 'login', kind: 'implement', status: 'pending', sections: [{ id: 'a' }, { id: 'b' }] });
    const id = item.id;
    expect(id).toMatch(/^wo-[0-9a-hjkmnp-tv-z]{26}$/);
    expect(item).toMatchObject({ specCommit, status: 'pending', sections: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }] });
    // Validation: unknown spec / sections; one open implement/update per (spec, section) (I6); review is exempt.
    await expect(q.create({ spec: 'nope', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] })).rejects.toThrow(/does not exist|no committed version/);
    await expect(q.create({ spec: 'login', kind: 'review', status: 'pending', sections: [{ id: 'zz' }] })).rejects.toThrow(/zz/);
    await expect(q.create({ spec: 'login', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] })).rejects.toMatchObject({ statusCode: 409 });
    await expect(q.create({ spec: 'login', kind: 'update', status: 'pending', sections: [{ id: 'b' }] })).rejects.toThrow(/already has an open implement/);
    const review = await q.create({ spec: 'login', kind: 'review', status: 'pending', sections: [{ id: 'a' }] });
    await q.update(review.id, { status: 'cancelled' });

    // Done once every section is done.
    const half = await q.update(id, { status: 'in_progress', sections: [{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }] });
    expect(half.status).toBe('in_progress');
    const done = await q.update(id, { sections: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }] });
    expect(done.status).toBe('done');
    // Closed items no longer block a new one.
    const second = (await q.create({ spec: 'login', kind: 'implement', status: 'pending', sections: [{ id: 'b' }] })).id;
    expect(second).toMatch(/^wo-/);
    expect(second).not.toBe(id);

    const lines = (await readFile(path.join(git.dir, 'work-orders.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([id, review.id, second]);
    const history = await q.historyOf(id);
    expect(history.map((h) => h.subject)).toEqual([`work order: update ${id}`, `work order: update ${id}`, `work order: create ${id}`]);
    expect(history[0]!.trailers).toEqual({ 'Work-Order': id });

    // Resolved view flags sections of open work orders changed since specCommit; done ones resolve at their own commit.
    await storage.specs.update('login', { sections: [{ id: 'a', title: 'A', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: 'x' }, { id: 'b', title: 'B', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: 'changed' }] });
    const resolved = await q.resolve(second);
    expect(resolved.spec?.title).toBe('Login');
    expect(resolved.sections.map((s) => [s.id, s.section?.body, s.headChanged, s.latest?.body])).toEqual([['b', 'y', true, 'changed']]);
    expect((await q.resolve(id)).sections.every((s) => !s.headChanged)).toBe(true);
    expect(resolved.specMovedTo).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.status()).clean).toBe(true);
  });

  it('reports per-section implementation state', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(createSpecSchema.parse({ id: 's', title: 'S', sections: [{ id: 'a', title: 'A', body: 'v1' }, { id: 'b', title: 'B', body: 'v1' }] }));
    const c1 = (await git.log(1))[0]!.id.slice(0, 7);
    const sec = (id: string, body: string) => ({ id, title: id.toUpperCase(), type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body, implementedCommit: c1 });
    await storage.specs.update('s', { sections: [sec('a', 'v1'), sec('b', 'v2')] });
    expect(await storage.workOrderService.implementation('s')).toEqual({
      a: { implementedCommit: c1, outdated: false },
      b: { implementedCommit: c1, outdated: true },
    });
  });

  it('syncs between two clones through a bare remote', async () => {
    const root = await tempDir();
    const bare = path.join(root, 'remote.git');
    await initRepository(bare, { bare: true, initialHead: 'main' });
    const remote = { url: bare, branch: 'main' };

    const a = await newStore(path.join(root, 'a'), remote);
    const storageA = createStorage(a);
    await storageA.specs.create(spec('From A', 'a'));
    await a.push();

    const b = await newStore(path.join(root, 'b'), remote); // clones
    const storageB = createStorage(b);
    expect((await storageB.specs.list()).map((s) => s.id)).toEqual(['from-a']);
    await storageB.standards.create(std('From B', 'b'));
    await b.push();

    expect(await a.pull()).toBe(true); // fast-forward
    expect(bodyOf(await storageA.standards.get('from-b'))).toBe('b');
    expect(bodyOf(await storageA.specs.get('from-a'))).toBe('a');
    expect((await a.status()).clean).toBe(true);

    // Diverge: both sides commit, then A pulls (true merge) and pushes.
    await storageA.specs.create(spec('A2', ''));
    await storageB.specs.create(spec('B2', ''));
    await b.push();
    expect(await a.pull()).toBe(true);
    await a.push();
    expect((await a.log())[0]?.message).toBe('Merge origin/main');
    expect(await b.pull()).toBe(true);
    expect((await storageB.specs.list()).map((s) => s.id).sort()).toEqual(['a2', 'b2', 'from-a']);
    expect((await b.status()).clean).toBe(true);
  });
});
