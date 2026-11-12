import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteConfig } from '../src/config.js';
import type { GitBackend } from '../src/config.js';
import { createGitStore, type GitStore } from '../src/git/index.js';

const dirs: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mandate-test-'));
  dirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Backend under test: `MANDATE_GIT_BACKEND=cli npm test` runs every suite against the git CLI store. */
export const testBackend = (process.env.MANDATE_GIT_BACKEND ?? 'embedded') as GitBackend;

/** A GitStore (of `testBackend` unless given) for `dir`, not opened yet. */
export function makeStore(dir: string, remote?: RemoteConfig, backend: GitBackend = testBackend): GitStore {
  return createGitStore({ dataDir: dir, remote, author: { name: 'Test', email: 'test@example.com' }, git: { backend } });
}

export async function newStore(dir: string, remote?: RemoteConfig, backend: GitBackend = testBackend): Promise<GitStore> {
  const store = makeStore(dir, remote, backend);
  await store.openOrCreate();
  return store;
}
