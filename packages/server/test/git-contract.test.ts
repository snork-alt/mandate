import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { initRepository } from 'es-git';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type GitBackend, type RemoteConfig } from '../src/config.js';
import { CliGitStore } from '../src/git/CliGitStore.js';
import { checkGitCli, parseGitVersion, redact } from '../src/git/cli/exec.js';
import type { GitStore } from '../src/git/index.js';
import { cleanupTempDirs, makeStore, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
/** CLI suites are skipped automatically when no `git` binary is installed. */
const BACKENDS: GitBackend[] = hasGit ? ['embedded', 'cli'] : ['embedded'];

const DIRS = ['specs', 'standards'];
const at = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 60_000);
const BIG = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'); // ~3 MB
const UNICODE = 'specs/ünïcødé 文字 🚀.md';
const SPACED = 'specs/with  spaces .md';

async function put(git: GitStore, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(git.dir, rel)), { recursive: true });
  await writeFile(path.join(git.dir, rel), content);
}
const del = (git: GitStore, rel: string) => rm(path.join(git.dir, rel), { force: true });

/** A deterministic history (fixed dates) touching every interesting case. Returns the commit ids. */
async function buildHistory(git: GitStore): Promise<string[]> {
  const ids: string[] = [];
  const commit = async (paths: string[], msg: string) => {
    const id = await git.commit(paths, msg, { date: at(ids.length + 1) });
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    ids.push(id!);
  };
  await put(git, 'specs/a.md', 'alpha v1\n');
  await put(git, 'specs/b.md', 'bravo\n');
  await put(git, 'standards/s.md', 'standard\n');
  await put(git, 'README.md', 'readme\n');
  await put(git, UNICODE, 'unicode ✓\n');
  await put(git, SPACED, 'spaces\n');
  await commit(['specs/a.md', 'specs/b.md', 'standards/s.md', 'README.md', UNICODE, SPACED], 'spec: create a\n\nWork-Order: wo-0001\nSigned-off-by: T <t@e.com>');
  await put(git, 'specs/a.md', 'alpha v2\n');
  await commit(['specs/a.md'], 'spec: update a');
  await rename(path.join(git.dir, 'specs/b.md'), path.join(git.dir, 'specs/b2.md'));
  await commit(['specs/b.md', 'specs/b2.md'], 'spec: rename b -> b2');
  await del(git, 'specs/a.md');
  await commit(['specs/a.md'], 'spec: delete a\n\nWork-Order: wo-0002');
  await put(git, 'specs/big.md', BIG);
  await put(git, 'specs/sub/nested.md', 'nested\n');
  await commit(['specs/big.md', 'specs/sub/nested.md'], 'spec: big + nested');
  await put(git, UNICODE, 'unicode ✓ v2\n');
  await commit([UNICODE], 'no trailing newline, "quotes" & ünïcode');
  return ids;
}

/** Everything the read API returns for a history, in plain data (for cross-backend comparison). */
async function dump(git: GitStore, ids: string[]) {
  const files = ['specs/a.md', 'specs/b.md', 'specs/b2.md', 'README.md', UNICODE, SPACED, 'specs', 'specs/sub/nested.md', 'nope.md'];
  const readAll: Record<string, (string | null)[]> = {};
  for (const f of files) readAll[f] = await Promise.all(ids.map((c) => git.readFileAt(c, f).then((t) => (t && t.length > 1000 ? `len:${t.length}` : t))));
  const history = await git.fileHistory(DIRS);
  return {
    head: await git.head(),
    log: await git.log(),
    log2: await git.log(2),
    chain: await git.firstParentChain(),
    chainStop: await git.firstParentChain(ids[2]),
    chainMissing: await git.firstParentChain('0'.repeat(40)),
    history: [...history.entries()].map(([k, v]) => [k, v.map((c) => c.id)]),
    historyInfo: history.get('specs/a.md'),
    diffs: await Promise.all(ids.map((c) => git.commitDiff(c, DIRS))),
    blobs: await Promise.all(ids.map(async (c) => [...(await git.blobsAt(c, DIRS, ['README.md', 'missing', 'specs/sub/nested.md'])).entries()])),
    reachable: await git.reachable(ids.at(-1)!, ids[1]!),
    reachableAll: await git.reachable(ids.at(-1)!, null),
    info: await Promise.all(ids.map((c) => git.commitInfo(c))),
    resolve: await Promise.all([ids[0]!.slice(0, 7), 'HEAD', 'HEAD~1', 'main', 'nope', '-n', '--all', 'a b', ''].map((r) => git.resolveCommit(r))),
    readAll,
  };
}

describe.each(BACKENDS)('GitStore contract (%s)', (backend) => {
  it('init + empty repository', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'), undefined, backend);
    expect(existsSync(path.join(git.dir, '.git'))).toBe(true);
    expect(await git.head()).toBeNull();
    expect(await git.log()).toEqual([]);
    expect(await git.firstParentChain()).toEqual({ commits: [], reachedStop: true });
    expect(await git.firstParentChain('abc')).toEqual({ commits: [], reachedStop: false });
    expect((await git.fileHistory(DIRS)).size).toBe(0);
    expect(await git.resolveCommit('HEAD')).toBeNull();
    expect(await git.status()).toEqual({ branch: 'main', head: null, clean: true, files: [], remote: null });
    // Both backends always create the first commit, even when it is empty.
    const first = await git.commit([], 'nothing', { date: at(0) });
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.commit([], 'still nothing')).toBeNull();
    expect(git.hasRemote()).toBe(false);
    expect(await git.pull()).toBe(false);
    await git.push(); // no remote: no-op
  });

  it('open: existing repo, refuses a non-repo dir', async () => {
    const root = await tempDir();
    const a = await newStore(path.join(root, 'repo'), undefined, backend);
    await put(a, 'specs/x.md', 'x');
    const id = await a.commit(['specs/x.md'], 'x');
    const b = makeStore(path.join(root, 'repo'), undefined, backend);
    await b.open();
    expect(await b.head()).toBe(id);
    await expect(makeStore(path.join(root, 'missing'), undefined, backend).open()).rejects.toThrow();
  });

  it('commit, status, log, readFileAt, diffs, history (renames, deletes, unicode, spaces, large file)', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'), undefined, backend);
    const ids = await buildHistory(git);
    const [c1, c2, c3, c4, c5, c6] = ids as [string, string, string, string, string, string];

    // commit: unchanged paths -> null; trailers kept byte-for-byte
    expect(await git.commit(['specs/b2.md'], 'noop')).toBeNull();
    expect((await git.commitInfo(c1)).message).toBe('spec: create a\n\nWork-Order: wo-0001\nSigned-off-by: T <t@e.com>');
    expect(await git.commitInfo(c1)).toMatchObject({ id: c1, authorName: 'Test', authorEmail: 'test@example.com', date: at(1).toISOString() });

    // log
    const log = await git.log();
    expect(log.map((c) => c.id)).toEqual([...ids].reverse());
    expect(log[0]).toEqual({ id: c6, message: 'no trailing newline, "quotes" & ünïcode', author: 'Test <test@example.com>', date: at(6).toISOString() });
    expect(await git.log(2)).toHaveLength(2);
    expect(await git.log(0)).toEqual([]);

    // readFileAt: present, modified, deleted, renamed, directory, unicode, spaces, large, unknown commit
    expect(await git.readFileAt(c1, 'specs/a.md')).toBe('alpha v1\n');
    expect(await git.readFileAt(c2, 'specs/a.md')).toBe('alpha v2\n');
    expect(await git.readFileAt(c4, 'specs/a.md')).toBeNull();
    expect(await git.readFileAt(c3, 'specs/b.md')).toBeNull();
    expect(await git.readFileAt(c3, 'specs/b2.md')).toBe('bravo\n');
    expect(await git.readFileAt(c1, 'specs')).toBeNull();
    expect(await git.readFileAt(c6, UNICODE)).toBe('unicode ✓ v2\n');
    expect(await git.readFileAt(c1, SPACED)).toBe('spaces\n');
    expect(await git.readFileAt(c5, 'specs/big.md')).toBe(BIG);
    expect(await git.readFileAt('HEAD', 'specs/sub/nested.md')).toBe('nested\n');
    await expect(git.readFileAt('deadbeef', 'specs/a.md')).rejects.toThrow(/unknown commit/);

    // commitDiff: rename = delete + add with the same blob
    const d3 = await git.commitDiff(c3, DIRS);
    expect(d3.parent).toBe(c2);
    expect(d3.files.map((f) => [f.path, f.status])).toEqual([
      ['specs/b.md', 'deleted'],
      ['specs/b2.md', 'added'],
    ]);
    expect(d3.files[0]!.before).toBe(d3.files[1]!.after);
    const d1 = await git.commitDiff(c1, DIRS);
    expect(d1.parent).toBeNull();
    expect(d1.files.map((f) => f.path)).toEqual(['specs/a.md', 'specs/b.md', SPACED, UNICODE, 'standards/s.md'].sort((x, y) => x.localeCompare(y)));
    expect((await git.commitDiff(c5, DIRS)).files.map((f) => [f.path, f.status])).toEqual([
      ['specs/big.md', 'added'],
      ['specs/sub', 'added'],
    ]);
    await expect(git.commitDiff('nope', DIRS)).rejects.toThrow(/unknown commit/);

    // fileHistory (first parent, newest first)
    const h = await git.fileHistory(DIRS);
    expect(h.get('specs/a.md')!.map((c) => c.id)).toEqual([c4, c2, c1]);
    expect(h.get('specs/b.md')!.map((c) => c.id)).toEqual([c3, c1]);
    expect(h.get('specs/b2.md')!.map((c) => c.id)).toEqual([c3]);
    expect(h.get(UNICODE)!.map((c) => c.id)).toEqual([c6, c1]);
    expect(h.has('README.md')).toBe(false);
    expect(h.get('specs/a.md')![0]!.message).toBe('spec: delete a\n\nWork-Order: wo-0002');

    // chains, reachability, blobs, resolve
    expect(await git.firstParentChain()).toEqual({ commits: [...ids].reverse(), reachedStop: true });
    expect(await git.firstParentChain(c3)).toEqual({ commits: [c6, c5, c4], reachedStop: true });
    expect(await git.reachable(c6, c4)).toEqual([c6, c5]);
    const blobs = await git.blobsAt(c1, DIRS, ['README.md', 'missing.md']);
    expect([...blobs.keys()].sort()).toEqual(['README.md', 'specs/a.md', 'specs/b.md', SPACED, UNICODE, 'standards/s.md'].sort());
    expect(await git.resolveCommit(c1.slice(0, 7))).toBe(c1);
    expect(await git.resolveCommit('HEAD~1')).toBe(c5);
    expect(await git.resolveCommit('nope')).toBeNull();

    // status: modified, deleted, untracked (unicode + spaces), then clean after commit
    await put(git, 'specs/b2.md', 'changed');
    await del(git, SPACED);
    await put(git, 'specs/new file ✓.md', 'n');
    const st = await git.status();
    expect(st).toMatchObject({ branch: 'main', head: c6, clean: false, remote: null });
    expect(st.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'specs/b2.md', status: 'modified' },
      { path: 'specs/new file ✓.md', status: 'new' },
      { path: SPACED, status: 'deleted' },
    ].sort((a, b) => a.path.localeCompare(b.path)));
    expect(await git.commit(['specs/b2.md', SPACED, 'specs/new file ✓.md'], 'all')).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.status()).clean).toBe(true);
  }, 60_000);

  it('commits on top of external resets and external commits (index and HEAD re-read from disk)', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'), undefined, backend);
    const sh = (...args: string[]) => execFileSync('git', ['-C', git.dir, '-c', 'user.name=Ext', '-c', 'user.email=ext@e', ...args]).toString().trim();
    await put(git, 'specs/a.md', 'a1');
    const c1 = await git.commit(['specs/a.md'], 'c1');
    await put(git, 'specs/a.md', 'a2');
    await put(git, 'specs/b.md', 'b');
    await git.commit(['specs/a.md', 'specs/b.md'], 'c2');
    // External reset --hard to c1, then a Mandate commit of a new path.
    sh('reset', '-q', '--hard', c1!);
    await put(git, 'specs/new.md', 'new');
    const c3 = await git.commit(['specs/new.md'], 'c3');
    expect((await git.firstParentChain()).commits).toEqual([c3, c1]);
    expect([...(await git.blobsAt(c3!, ['specs'])).keys()].sort()).toEqual(['specs/a.md', 'specs/new.md']);
    expect(await git.readFileAt(c3!, 'specs/a.md')).toBe('a1');
    expect((await git.status()).clean).toBe(true);
    // External commit between two Mandate commits is kept, not reverted.
    writeFileSync(path.join(git.dir, 'specs/ext.md'), 'ext');
    sh('add', 'specs/ext.md');
    sh('commit', '-q', '-m', 'external');
    const ext = sh('rev-parse', 'HEAD');
    await put(git, 'specs/new.md', 'new2');
    const c4 = await git.commit(['specs/new.md'], 'c4');
    expect((await git.firstParentChain()).commits).toEqual([c4, ext, c3, c1]);
    expect(await git.readFileAt(c4!, 'specs/ext.md')).toBe('ext');
    expect(await git.readFileAt(c4!, 'specs/new.md')).toBe('new2');
    expect((await git.status()).clean).toBe(true);
  });

  describe('remote sync', () => {
    async function remoteSetup() {
      const root = await tempDir();
      const bare = path.join(root, 'remote.git');
      await initRepository(bare, { bare: true, initialHead: 'main' });
      const remote: RemoteConfig = { url: bare, branch: 'main' };
      return { root, bare, remote };
    }
    const remoteHead = (bare: string) => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main']).toString().trim();

    it('clone (empty + non-empty), push, fetch, fast-forward and merge pull', async () => {
      const { root, bare, remote } = await remoteSetup();
      const a = await newStore(path.join(root, 'a'), remote, backend); // clones the empty remote
      expect(await a.status()).toMatchObject({ branch: 'main', head: null, clean: true, remote: bare });
      expect(await a.pull()).toBe(false); // remote branch does not exist yet
      await a.push(); // unborn: no-op
      await put(a, 'specs/a.md', 'a');
      const a1 = await a.commit(['specs/a.md'], 'a1', { date: at(1) });
      await a.push();
      if (hasGit) expect(remoteHead(bare)).toBe(a1);

      const b = await newStore(path.join(root, 'b'), remote, backend); // clones
      expect(await b.head()).toBe(a1);
      expect(await b.readFileAt('HEAD', 'specs/a.md')).toBe('a');
      await put(b, 'specs/b.md', 'b');
      const b1 = await b.commit(['specs/b.md'], 'b1', { date: at(2) });
      await b.push();

      await a.fetch();
      expect(await a.resolveCommit('origin/main')).toBe(b1);
      expect(await a.head()).toBe(a1); // fetch does not move HEAD
      expect(await a.pull()).toBe(true); // fast-forward
      expect(await a.head()).toBe(b1);
      expect(await a.readFileAt('HEAD', 'specs/b.md')).toBe('b');
      expect(existsSync(path.join(a.dir, 'specs/b.md'))).toBe(true);
      expect(await a.pull()).toBe(false); // up to date

      // Diverge: true merge
      await put(a, 'specs/a2.md', 'a2');
      const a2 = await a.commit(['specs/a2.md'], 'a2', { date: at(3) });
      await put(b, 'specs/b2.md', 'b2');
      const b2 = await b.commit(['specs/b2.md'], 'b2', { date: at(4) });
      await b.push();
      expect(await a.pull()).toBe(true);
      const merge = (await a.log(1))[0]!;
      expect(merge.message).toBe('Merge origin/main');
      expect((await a.commitInfo(merge.id)).message).toBe('Merge origin/main');
      expect(await a.firstParentChain(b1)).toEqual({ commits: [merge.id, a2!], reachedStop: true });
      expect(await a.reachable(merge.id, a2!)).toEqual([merge.id, b2]);
      expect((await a.commitDiff(merge.id, DIRS)).files.map((f) => f.path)).toEqual(['specs/b2.md']);
      expect((await a.status()).clean).toBe(true);
      await a.push();
      expect(await b.pull()).toBe(true); // fast-forward to the merge
      expect(await b.head()).toBe(merge.id);
      expect(await b.pull()).toBe(false); // remote is behind/equal: nothing to do
    }, 60_000);

    it('conflicting pull aborts and throws; rejected push throws (no force)', async () => {
      const { root, bare, remote } = await remoteSetup();
      const a = await newStore(path.join(root, 'a'), remote, backend);
      await put(a, 'specs/x.md', 'base\n');
      await a.commit(['specs/x.md'], 'base');
      await a.push();
      const b = await newStore(path.join(root, 'b'), remote, backend);
      await put(a, 'specs/x.md', 'from a\n');
      const a1 = await a.commit(['specs/x.md'], 'a edit');
      await put(b, 'specs/x.md', 'from b\n');
      const b1 = await b.commit(['specs/x.md'], 'b edit');
      await b.push();

      // embedded: libgit2's NotFastForward error; cli: `Push rejected: refs/heads/main: ...`
      await expect(a.push()).rejects.toThrow(/Push rejected|cannot push/);
      if (hasGit) expect(remoteHead(bare)).toBe(b1); // remote untouched

      await expect(a.pull()).rejects.toThrow(/Merge conflict while pulling/);
      expect(await a.head()).toBe(a1);
      expect(await a.status()).toMatchObject({ clean: true, branch: 'main' });
      expect(readFileSync(path.join(a.dir, 'specs/x.md'), 'utf8')).toBe('from a\n');
      expect(existsSync(path.join(a.dir, '.git/MERGE_HEAD'))).toBe(false);
    }, 60_000);
  });
});

describe.skipIf(!hasGit)('embedded and cli backends agree', () => {
  it('identical commit ids and identical read results for the same history', async () => {
    const root = await tempDir();
    const e = await newStore(path.join(root, 'e'), undefined, 'embedded');
    const c = await newStore(path.join(root, 'c'), undefined, 'cli');
    const ids = await buildHistory(e);
    expect(await buildHistory(c)).toEqual(ids); // byte-identical commits (tree, message, author, dates)
    // Each backend reads both repositories the same way.
    const viaCli = makeStore(e.dir, undefined, 'cli');
    await viaCli.open();
    const expected = await dump(e, ids);
    expect(await dump(c, ids)).toEqual(expected);
    expect(await dump(viaCli, ids)).toEqual(expected);
    await put(e, 'specs/b2.md', 'changed');
    await put(e, 'specs/zz new.md', 'n');
    await del(e, SPACED);
    expect(await viaCli.status()).toEqual(await e.status());
  }, 60_000);

  it('a merge history walks in the same order', async () => {
    const root = await tempDir();
    const bare = path.join(root, 'remote.git');
    await initRepository(bare, { bare: true, initialHead: 'main' });
    const remote = { url: bare, branch: 'main' };
    const a = await newStore(path.join(root, 'a'), remote, 'embedded');
    const b = await newStore(path.join(root, 'b'), remote, 'cli');
    let n = 0;
    const edit = async (s: GitStore, f: string) => {
      await put(s, f, `${f} ${n}`);
      await s.commit([f], `edit ${f}`, { date: at(Math.floor(n++ / 2)) }); // equal timestamps on purpose
    };
    await edit(a, 'specs/base.md');
    await a.push();
    await b.pull();
    for (let round = 0; round < 3; round++) {
      await edit(a, 'specs/a.md');
      await edit(a, 'specs/a2.md');
      await edit(b, 'specs/b.md');
      await edit(b, 'specs/b2.md');
      await b.push();
      await a.pull(); // embedded merge
      await a.push();
      await b.pull(); // cli fast-forward
    }
    await edit(b, 'specs/c.md');
    await edit(a, 'specs/d.md');
    await a.push();
    await b.pull(); // cli merge
    const viaEmbedded = makeStore(b.dir, undefined, 'embedded');
    await viaEmbedded.open();
    const head = (await b.head())!;
    expect(await b.log(100)).toEqual(await viaEmbedded.log(100));
    expect(await b.firstParentChain()).toEqual(await viaEmbedded.firstParentChain());
    const first = (await b.firstParentChain()).commits;
    for (let i = 0; i + 1 < first.length; i++) expect(await b.reachable(first[i]!, first[i + 1]!)).toEqual(await viaEmbedded.reachable(first[i]!, first[i + 1]!));
    expect([...(await b.fileHistory(DIRS)).entries()]).toEqual([...(await viaEmbedded.fileHistory(DIRS)).entries()]);
    expect(await b.reachable(head, null)).toEqual(await viaEmbedded.reachable(head, null));
  }, 60_000);
});

describe.skipIf(!hasGit)('CliGitStore process safety', () => {
  const NASTY = [
    'specs/-n.md',
    'specs/--output=pwned.md',
    `specs/quo'te"s.md`,
    'specs/$(touch PWNED).md',
    'specs/`touch PWNED`.md',
    'specs/semi;touch PWNED.md',
    'specs/*.md',
    'specs/:(glob)x.md',
    'specs/new\nline.md',
    'specs/tab\there.md',
  ];
  const MESSAGES = [
    '-m evil',
    '--amend',
    '# looks like a comment\n\nbody',
    `$(touch PWNED) \`touch PWNED\` 'single' "double"\n\nWork-Order: wo-1`,
    '\n\nleading newlines',
    '',
  ];

  it('paths and messages are data, never options, globs or shell', async () => {
    const root = await tempDir();
    const cli = await newStore(path.join(root, 'cli'), undefined, 'cli');
    const emb = await newStore(path.join(root, 'emb'), undefined, 'embedded');
    for (const s of [cli, emb]) {
      for (const [i, f] of NASTY.entries()) await put(s, f, `content ${i}`);
      await put(s, 'specs/other.md', 'not staged');
    }
    // `specs/*.md` must be literal: other.md stays uncommitted.
    const ids = [];
    for (const s of [cli, emb]) {
      ids.push(await s.commit(NASTY, MESSAGES[3]!, { date: at(1) }));
      expect((await s.status()).files).toEqual([{ path: 'specs/other.md', status: 'new' }]);
    }
    expect(ids[0]).toBe(ids[1]);
    for (const [i, f] of NASTY.entries()) expect(await cli.readFileAt('HEAD', f)).toBe(`content ${i}`);
    expect([...(await cli.fileHistory(['specs'])).keys()].sort()).toEqual([...NASTY].sort());
    for (const [i, m] of MESSAGES.entries()) {
      for (const s of [cli, emb]) {
        await put(s, 'specs/other.md', `v${i}`);
        await s.commit(['specs/other.md'], m, { date: at(i + 2) });
      }
      expect(await cli.head()).toBe(await emb.head());
      expect((await cli.commitInfo((await cli.head())!)).message).toBe((await emb.commitInfo((await emb.head())!)).message);
    }
    expect((await cli.log(1))[0]!.message).toBe('');
    for (const ref of ['--output=/tmp/x', '-h', '--all', '-n1', 'HEAD;id', '$(id)', 'HEAD\nHEAD']) {
      expect(await cli.resolveCommit(ref)).toBeNull();
      await expect(cli.readFileAt(ref, 'specs/-n.md')).rejects.toThrow(/unknown commit/);
    }
    await expect(cli.reachable('--all', null)).rejects.toThrow(/invalid commit id/);
    expect(execFileSync('find', [root, '-name', 'PWNED*']).toString()).toBe('');
    expect(existsSync(path.join(cli.dir, 'pwned.md'))).toBe(false);
  }, 60_000);

  it('ignores GIT_DIR / GIT_AUTHOR_* from the server environment and never walks up to a parent repo', async () => {
    const root = await tempDir();
    const outer = await newStore(path.join(root, 'outer'), undefined, 'cli');
    await put(outer, 'x.md', 'x');
    const outerHead = await outer.commit(['x.md'], 'outer');
    const saved = { ...process.env };
    try {
      process.env.GIT_DIR = path.join(outer.dir, '.git');
      process.env.GIT_AUTHOR_NAME = 'Intruder';
      const inner = await newStore(path.join(outer.dir, 'data', 'repo'), undefined, 'cli');
      expect(await inner.head()).toBeNull(); // its own fresh repo, not outer's
      await put(inner, 'specs/a.md', 'a');
      const id = await inner.commit(['specs/a.md'], 'inner');
      expect((await inner.commitInfo(id!)).authorName).toBe('Test');
      mkdirSync(path.join(outer.dir, 'sub'));
      await expect(makeStore(path.join(outer.dir, 'sub'), undefined, 'cli').open()).rejects.toThrow(/Not a git repository/);
    } finally {
      process.env = saved;
    }
    expect(await outer.head()).toBe(outerHead);
  });

  it('redacts credentials from errors', async () => {
    expect(redact('fatal: unable to access https://me:ghp_abc123@github.com/x.git/: 403', [])).toBe('fatal: unable to access https://***@github.com/x.git/: 403');
    expect(redact('password=hunter22\nAuthorization: Bearer abc.def', [])).toBe('password=***\nAuthorization: ***');
    expect(redact('echo tok-SECRET-1 here', ['tok-SECRET-1'])).toBe('echo *** here');

    const root = await tempDir();
    const token = 'tok-SECRET-123456';
    const store = new CliGitStore({
      dir: path.join(root, 'r'),
      remote: { url: 'https://user:url-SECRET-pw@127.0.0.1:1/x.git', branch: 'main', auth: { type: 'https', username: 'u', token } },
      author: { name: 'T', email: 't@e' },
    });
    const err = await store.clone().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/git clone/);
    expect(err!.message).not.toContain(token);
    expect(err!.message).not.toContain('url-SECRET-pw');
  });

  it('authenticates HTTPS with the token through the inline credential helper (never in the URL)', async () => {
    const root = await tempDir();
    // A dumb-HTTP git server behind basic auth.
    const src = await newStore(path.join(root, 'src'), undefined, 'cli');
    await put(src, 'specs/a.md', 'served');
    const id = await src.commit(['specs/a.md'], 'served');
    const served = path.join(root, 'served.git');
    execFileSync('git', ['clone', '-q', '--bare', src.dir, served]);
    execFileSync('git', ['--git-dir', served, 'update-server-info']);
    const token = 'tok-HTTP-987654';
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.headers.authorization !== `Basic ${Buffer.from(`bob:${token}`).toString('base64')}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
        return;
      }
      const file = path.join(served, decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\/repo\.git/, '')));
      if (!file.startsWith(served) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200).end(readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
    try {
      const ok = new CliGitStore({ dir: path.join(root, 'ok'), remote: { url, branch: 'main', auth: { type: 'https', username: 'bob', token } }, author: { name: 'T', email: 't@e' } });
      await ok.clone();
      expect(await ok.head()).toBe(id);
      expect(execFileSync('git', ['-C', ok.dir, 'config', '--get', 'remote.origin.url']).toString().trim()).toBe(url);
      expect(readFileSync(path.join(ok.dir, '.git/config'), 'utf8')).not.toContain(token);
      const bad = new CliGitStore({ dir: path.join(root, 'bad'), remote: { url, branch: 'main', auth: { type: 'https', username: 'bob', token: 'wrong-TOKEN-1' } }, author: { name: 'T', email: 't@e' } });
      const err = await bad.clone().then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/git clone/);
      expect(err?.message).not.toContain('wrong-TOKEN-1');
      expect(seen.some((u) => u.includes(token))).toBe(false);
    } finally {
      server.close();
    }
  }, 30_000);

  it('checks the git binary and version', async () => {
    expect(parseGitVersion('git version 2.46.0\n')).toEqual([2, 46, 0]);
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39, 3]);
    expect(parseGitVersion('nope')).toBeNull();
    await expect(checkGitCli('/nonexistent/bin/git')).rejects.toThrow(/not found/);
    const dir = await tempDir();
    const fake = path.join(dir, 'oldgit');
    writeFileSync(fake, '#!/bin/sh\necho "git version 2.20.1"\n');
    chmodSync(fake, 0o755);
    await expect(checkGitCli(fake)).rejects.toThrow(/needs git >= 2\.30.*2\.20\.1/);
    await expect(checkGitCli('git')).resolves.toMatch(/^\d+\.\d+\.\d+$/);
    const store = new CliGitStore({ dir: path.join(dir, 'r'), author: { name: 'T', email: 't@e' }, gitPath: fake });
    await expect(store.init()).rejects.toThrow(/needs git >= 2\.30/);
  });
});

describe('git backend config', () => {
  afterAll(cleanupTempDirs);
  it('defaults to embedded; file and MANDATE_GIT_BACKEND select cli', async () => {
    const home = await tempDir();
    const cfg = loadConfig({ HOME: home, INIT_CWD: home });
    expect(cfg.git).toEqual({ backend: 'embedded', cliPath: 'git', cliEnv: {} });
    const file = JSON.parse(readFileSync(cfg.configPath, 'utf8'));
    expect(file.git).toMatchObject({ backend: 'embedded', cliPath: 'git', cliEnv: {} });
    file.git = { ...file.git, backend: 'cli', cliPath: '/usr/bin/git', cliEnv: { HTTPS_PROXY: 'http://proxy:3128' } };
    writeFileSync(cfg.configPath, JSON.stringify(file));
    expect(loadConfig({ HOME: home, INIT_CWD: home }).git).toEqual({ backend: 'cli', cliPath: '/usr/bin/git', cliEnv: { HTTPS_PROXY: 'http://proxy:3128' } });
    expect(loadConfig({ HOME: home, INIT_CWD: home, MANDATE_GIT_BACKEND: 'embedded' }).git.backend).toBe('embedded');
    expect(() => loadConfig({ HOME: home, INIT_CWD: home, MANDATE_GIT_BACKEND: 'svn' })).toThrow(ConfigError);
    file.git.backend = 'svn';
    writeFileSync(cfg.configPath, JSON.stringify(file));
    expect(() => loadConfig({ HOME: home, INIT_CWD: home })).toThrow(/git\.backend/);
    mkdirSync(path.join(home, 'unused'), { recursive: true });
  });
});
