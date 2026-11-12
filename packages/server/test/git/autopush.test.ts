/** Background auto-push against a local bare remote, both git backends. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@mandate/shared';
import { AutoPusher, cleanError, ownRepoProblem } from '../../src/git/autopush.js';
import { createGitStore, type GitStore } from '../../src/git/index.js';
import { Mutex } from '../../src/storage/Mutex.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

afterAll(cleanupTempDirs);

const TOKEN = 'gho_autopush_secret_token_123456';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await wait(25);
  }
}
const remoteLog = (bare: string) => execFileSync('git', ['--git-dir', bare, 'log', '--format=%s', 'main']).toString().trim().split('\n').filter(Boolean);

for (const backend of ['embedded', 'cli'] as const) {
  describe(`auto-push (${backend})`, () => {
    let argvLog = '';

    /** A bare remote with one commit, a clone opened through Mandate's store, and an AutoPusher on it. */
    async function setup(opts: { debounceMs?: number; intervalMs?: number; remote?: boolean; gate?: () => null | { state: 'reconnect'; message: string } } = {}) {
      const root = await tempDir();
      const bare = path.join(root, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      const seed = path.join(root, 'seed');
      execFileSync('git', ['clone', '-q', bare, seed]);
      writeFileSync(path.join(seed, 'shared.md'), 'base\n');
      execFileSync('git', ['-C', seed, '-c', 'user.name=s', '-c', 'user.email=s@x', 'add', '.']);
      execFileSync('git', ['-C', seed, '-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-qm', 'seed']);
      execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
      // CLI backend: a git wrapper that records argv (asserted: no --force, no token).
      argvLog = path.join(root, 'argv.log');
      const spy = path.join(root, 'git-spy.sh');
      writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec git "$@"\n`);
      chmodSync(spy, 0o755);
      const dir = path.join(root, 'work');
      const git = createGitStore({
        dataDir: dir,
        author: { name: 'Mandate', email: 'm@x' },
        ...(opts.remote === false ? {} : { remote: { url: bare, branch: 'main', auth: { type: 'https' as const, username: 'x-access-token', token: TOKEN } } }),
        git: { backend, cliPath: spy },
      });
      await git.openOrCreate();
      const lock = new Mutex();
      const lockLog: string[] = [];
      const events: ActivityEvent[] = [];
      let pushes = 0;
      const push = git.push.bind(git);
      git.push = async () => {
        pushes++;
        return push();
      };
      const pull = git.pull.bind(git);
      git.pull = async () => {
        lockLog.push(`pull locked=${(lock as unknown as { locked?: boolean }).locked ?? inLock}`);
        return pull();
      };
      let inLock = false;
      const lk = {
        run: <T>(fn: () => Promise<T>) =>
          lock.run(async () => {
            inLock = true;
            try {
              return await fn();
            } finally {
              inLock = false;
            }
          }),
      };
      const ap = new AutoPusher({ git, lock: lk, config: { enabled: true, debounceSeconds: 10, intervalSeconds: 300 }, emit: (e) => events.push(e), gate: opts.gate, debounceMs: opts.debounceMs ?? 150, intervalMs: opts.intervalMs ?? 3_600_000 });
      ap.start();
      const write = async (file: string, text: string, msg = `write ${file}`) => {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
        return lk.run(() => git.commit([file], msg));
      };
      /** Another clone pushes `file` to the remote (the remote moves). */
      const other = (file: string, text: string) => {
        const o = path.join(root, `other-${Math.random().toString(36).slice(2)}`);
        execFileSync('git', ['clone', '-q', bare, o]);
        writeFileSync(path.join(o, file), text);
        execFileSync('git', ['-C', o, '-c', 'user.name=o', '-c', 'user.email=o@x', 'add', '.']);
        execFileSync('git', ['-C', o, '-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '-qm', `other ${file}`]);
        execFileSync('git', ['-C', o, 'push', '-q', 'origin', 'main']);
      };
      return { root, bare, dir, git: git as GitStore, ap, events, write, other, lockLog, pushes: () => pushes, close: () => ap.stop() };
    }

    it('coalesces a burst of commits into one debounced push (git.pushed event with the range)', async () => {
      const s = await setup();
      await wait(500); // let the startup catch-up run finish
      const before = s.pushes();
      for (let i = 0; i < 3; i++) await s.write(`specs/a${i}.md`, `a${i}\n`);
      expect((await s.ap.status()).ahead).toBe(3);
      await until(() => s.events.some((e) => e.type === 'git.pushed'));
      expect(s.pushes() - before).toBe(1);
      const ev = s.events.find((e) => e.type === 'git.pushed')!;
      expect(ev.details?.commits).toHaveLength(3);
      expect(ev.details?.range?.to).toBe(await s.git.head());
      expect(remoteLog(s.bare).slice(0, 3)).toEqual(['write specs/a2.md', 'write specs/a1.md', 'write specs/a0.md']);
      await until(async () => (await s.ap.status()).state === 'ok');
      const st = await s.ap.status();
      expect(st).toMatchObject({ state: 'ok', ahead: 0, lastResult: 'ok', lastError: null });
      expect(st.lastPushAt).toBeTruthy();
      s.close();
    });

    it('pushes from the periodic sweep (no debounce in time)', async () => {
      const s = await setup({ debounceMs: 60_000, intervalMs: 200 });
      await s.write('specs/sweep.md', 'x\n');
      expect((await s.ap.status()).nextPushAt).toBeTruthy();
      await until(() => remoteLog(s.bare)[0] === 'write specs/sweep.md');
      s.close();
    });

    it('integrates a moved remote (fetch + merge, inside the write lock) and pushes again', async () => {
      const s = await setup({ debounceMs: 60_000 });
      s.other('remote-only.md', 'theirs\n');
      await s.write('specs/mine.md', 'mine\n');
      const st = await s.ap.pushNow('manual');
      expect(st.state).toBe('ok');
      expect(s.lockLog.length).toBeGreaterThan(0);
      expect(s.lockLog.every((l) => l.endsWith('true'))).toBe(true);
      const files = execFileSync('git', ['--git-dir', s.bare, 'ls-tree', '-r', '--name-only', 'main']).toString();
      expect(files).toContain('remote-only.md');
      expect(files).toContain('specs/mine.md');
      expect(readFileSync(path.join(s.dir, 'remote-only.md'), 'utf8')).toBe('theirs\n');
      s.close();
    });

    it('stops on a conflict with an error state, keeping local commits (never force)', async () => {
      const s = await setup({ debounceMs: 60_000 });
      s.other('shared.md', 'theirs\n');
      await s.write('shared.md', 'mine\n', 'local edit');
      const head = await s.git.head();
      const st = await s.ap.pushNow('manual');
      expect(st.state).toBe('error');
      expect(st.message).toMatch(/conflict/i);
      expect(st.nextPushAt).toBeNull();
      expect(await s.git.head()).toBe(head);
      expect(readFileSync(path.join(s.dir, 'shared.md'), 'utf8')).toBe('mine\n');
      expect(remoteLog(s.bare)[0]).toBe('other shared.md');
      expect(s.events.some((e) => e.type === 'git.push_failed' && !JSON.stringify(e).includes(TOKEN))).toBe(true);
      s.close();
    });

    it('never force-pushes and never puts the token in argv or the remote URL', async () => {
      const s = await setup();
      await s.write('specs/b.md', 'b\n');
      await until(() => s.events.some((e) => e.type === 'git.pushed'));
      const remote = execFileSync('git', ['-C', s.dir, 'config', '--get', 'remote.origin.url']).toString().trim();
      expect(remote).toBe(s.bare);
      if (backend === 'cli') {
        const argv = readFileSync(argvLog, 'utf8');
        expect(argv).toMatch(/(^|\s)push(\s|$)/m);
        const pushes = argv.split('\n').filter((l) => /(^|\s)push(\s|$)/.test(l));
        expect(pushes.length).toBeGreaterThan(0);
        for (const l of pushes) expect(l).not.toMatch(/--force|--force-with-lease|\s-f(\s|$)|\s\+\S/);
        expect(argv).not.toContain(TOKEN);
      }
      expect(JSON.stringify(await s.ap.status())).not.toContain(TOKEN);
      s.close();
    });

    it('a commit made while a push is in flight is not blocked and is pushed right after', async () => {
      const s = await setup({ debounceMs: 100 });
      const push = s.git.push.bind(s.git);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      s.git.push = async () => {
        await gate;
        return push();
      };
      await s.write('specs/c1.md', 'c1\n');
      const inflight = s.ap.pushNow('manual');
      const t = Date.now();
      await s.write('specs/c2.md', 'c2\n'); // the write lock is free during the network push
      expect(Date.now() - t).toBeLessThan(1000);
      release();
      await inflight;
      await until(() => remoteLog(s.bare)[0] === 'write specs/c2.md');
      s.close();
    });

    it('skips pushing with a clear status when the token is revoked or there is no remote', async () => {
      const r = await setup({ gate: () => ({ state: 'reconnect', message: 'Reconnect GitHub' }) });
      await r.write('specs/d.md', 'd\n');
      const st = await r.ap.pushNow('manual');
      expect(st).toMatchObject({ state: 'reconnect', message: 'Reconnect GitHub' });
      expect(r.pushes()).toBe(0);
      r.close();
      const n = await setup({ remote: false });
      await n.write('specs/e.md', 'e\n');
      expect(await n.ap.pushNow('manual')).toMatchObject({ state: 'no_remote', ahead: null });
      expect(n.pushes()).toBe(0);
      n.close();
    });

    it('refuses a data dir that is not the root of its own repository', async () => {
      const s = await setup({ debounceMs: 60_000 });
      const sub = path.join(s.dir, 'nested');
      mkdirSync(sub, { recursive: true });
      const fake = Object.create(s.git, { dir: { value: sub } }) as GitStore;
      expect(ownRepoProblem(fake)).toMatch(/not the root of its own git repository/);
      const ap = new AutoPusher({ git: fake, lock: { run: (f) => f() }, config: { enabled: true, debounceSeconds: 10, intervalSeconds: 300 } });
      const before = s.pushes();
      expect(await ap.pushNow('manual')).toMatchObject({ state: 'refused' });
      expect(s.pushes()).toBe(before);
      expect(ownRepoProblem(s.git)).toBeNull();
      s.close();
    });
  });
}

it('cleans credentials out of git errors', () => {
  expect(cleanError('fatal: unable to access https://x-access-token:gho_abcdefghijklmnop@github.com/a/b.git/: 403')).not.toContain('gho_');
  expect(cleanError('token=abc password: def')).toBe('token=*** password: ***');
});
