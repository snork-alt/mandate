/** Read-only integrity lint of a project's data repository, for `mandate doctor` (no server needed). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IntegrityReport } from '@mandate/shared';
import { createGitStore, SubdirGitStore, type GitStore, type GitStoreConfig } from '../git/index.js';
import { createStorage } from './index.js';

export async function projectIntegrity(p: Omit<GitStoreConfig, 'author'> & { github?: { path?: string } }): Promise<IntegrityReport | null> {
  if (!existsSync(path.join(p.dataDir, '.git'))) return null;
  const repo = createGitStore({ ...p, author: { name: 'Mandate doctor', email: 'doctor@mandate.invalid' } });
  const git: GitStore = p.github?.path ? new SubdirGitStore(repo, p.github.path) : repo;
  await git.open();
  return createStorage(git).integrity.run();
}
