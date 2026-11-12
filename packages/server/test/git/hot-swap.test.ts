/**
 * Settings → Git backend applies live: each project's GitStore is swapped (embedded ↔ cli) under its write lock while
 * reads and writes keep running. No write is lost, in-flight reads finish on the old store, and the next write goes
 * through the new backend. A backend that cannot open the repo leaves every project on its current one.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliGitStore, EsGitStore, type GitStore } from '../../src/git/index.js';
import { SwappableGitStore } from '../../src/git/SwappableGitStore.js';
import { ProjectRegistry, projectOpener } from '../../src/projects/registry.js';
import { embeddingConfigSchema, indexConfigSchema, type GitBackendConfig, type ProjectConfig } from '../../src/config.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';

afterAll(cleanupTempDirs);

const embedding = embeddingConfigSchema.parse({ provider: 'none' });
const CLI: GitBackendConfig = { backend: 'cli', cliPath: 'git', cliEnv: {} };
const EMBEDDED: GitBackendConfig = { backend: 'embedded', cliPath: 'git', cliEnv: {} };

async function openRegistry(): Promise<{ registry: ProjectRegistry; cfg: ProjectConfig }> {
  const root = await tempDir();
  const cfg = testProject(root, 'alpha');
  const registry = new ProjectRegistry([cfg], projectOpener({ embedding, ask: { default: null, models: [] } }, { provider: null, activityPollMs: 0, startIndex: false, integrityIntervalMs: 0 }));
  return { registry, cfg };
}

function testProject(root: string, id: string): ProjectConfig {
  return {
    id,
    name: `Project ${id}`,
    dataDir: path.join(root, id, 'repo'),
    branch: 'main',
    author: { name: 'Test', email: 'test@example.com' },
    git: { ...EMBEDDED },
    index: indexConfigSchema.parse({ path: path.join(root, id, 'index.sqlite') }),
    idempotencyFile: path.join(root, id, 'idem.json'),
    autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 },
  };
}

const inner = (g: GitStore) => (g as SwappableGitStore).current;

describe('SwappableGitStore', () => {
  it('pins each call to the store current when it started; swap waits for the old one to drain, then closes it', async () => {
    const dir = await tempDir();
    const a = await newStore(dir, undefined, 'embedded');
    const b = await newStore(dir, undefined, 'cli');
    const s = new SwappableGitStore(a);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const origHead = a.head.bind(a);
    a.head = async () => (await gate, origHead());
    let closed = false;
    (a as { close?: () => void }).close = () => void (closed = true);
    const slow = s.head(); // in flight on a
    const swapped = s.swap(b);
    expect(s.current).toBe(b); // new calls go to b at once
    expect(s.pending(a)).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false); // a still busy
    release();
    await slow;
    expect(await swapped).toBe(a);
    expect(closed).toBe(true);
  });
});

describe('hot git backend switch (project runtime)', () => {
  it('embedded → cli → embedded under concurrent reads and writes loses no writes; the next write uses the new backend', async () => {
    const { registry, cfg } = await openRegistry();
    const rt = await registry.open('alpha');
    expect(inner(rt.git)).toBeInstanceOf(EsGitStore);
    const lock = rt.storage.lock;
    const write = (i: number) =>
      lock.run(async () => {
        writeFileSync(path.join(cfg.dataDir, `w${i}.md`), `write ${i}\n`);
        return rt.git.commit([`w${i}.md`], `write ${i}`);
      });
    const N = 30;
    let reading = true;
    const readErrors: unknown[] = [];
    const reader = (async () => {
      while (reading) {
        try {
          await Promise.all([rt.git.head(), rt.git.log(5), rt.git.status()]);
        } catch (e) {
          readErrors.push(e);
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const writes: Promise<string | null>[] = [];
    for (let i = 0; i < N; i++) {
      writes.push(write(i));
      if (i === 10) await registry.reconfigureGit([{ ...cfg, git: CLI }]);
      if (i === 20) await registry.reconfigureGit([{ ...cfg, git: EMBEDDED }]);
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 2));
    }
    const ids = await Promise.all(writes);
    reading = false;
    await reader;
    expect(readErrors).toEqual([]);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(N);
    const head = (await rt.git.head())!;
    for (let i = 0; i < N; i++) expect(await rt.git.readFileAt(head, `w${i}.md`)).toBe(`write ${i}\n`);
    expect((await rt.git.firstParentChain(null)).commits.length).toBeGreaterThanOrEqual(N);

    // The next write goes through the new backend.
    await registry.reconfigureGit([{ ...cfg, git: CLI }]);
    const cur = inner(rt.git);
    expect(cur).toBeInstanceOf(CliGitStore);
    let viaCli = 0;
    const commit = cur.commit.bind(cur);
    cur.commit = (...a) => (viaCli++, commit(...a));
    expect(await write(N)).toBeTruthy();
    expect(viaCli).toBe(1);
    expect(rt.config.git.backend).toBe('cli');
    // Projects opened later get the new backend too.
    expect(registry.config('alpha')!.git.backend).toBe('cli');
    // Unchanged settings: nothing to swap.
    expect(await registry.reconfigureGit([{ ...cfg, git: CLI }])).toEqual([]);
    await registry.close();
  });

  it('a backend that cannot open the repository changes nothing', async () => {
    const { registry, cfg } = await openRegistry();
    const rt = await registry.open('alpha');
    const before = inner(rt.git);
    await expect(registry.reconfigureGit([{ ...cfg, git: { backend: 'cli', cliPath: '/nonexistent/bin/git', cliEnv: {} } }])).rejects.toThrow(/cannot open/);
    expect(inner(rt.git)).toBe(before);
    expect(registry.config('alpha')!.git.backend).toBe('embedded');
    writeFileSync(path.join(cfg.dataDir, 'after.md'), 'x\n');
    expect(await rt.storage.lock.run(() => rt.git.commit(['after.md'], 'after'))).toBeTruthy();
    await registry.close();
  });
});
