import type { GitBackendConfig, RemoteConfig } from '../config.js';
import { CliGitStore } from './CliGitStore.js';
import { EsGitStore } from './EsGitStore.js';
import type { GitStore } from './GitStore.js';

export type { GitStore } from './GitStore.js';
export { CliGitStore } from './CliGitStore.js';
export { EsGitStore } from './EsGitStore.js';
export { checkGitCli } from './cli/exec.js';

/** What `createGitStore` needs: an `AppConfig` fits, as does a minimal `{ dataDir, author }`. */
export interface GitStoreConfig {
  dataDir: string;
  branch?: string;
  remote?: RemoteConfig;
  author: { name: string; email: string };
  git?: Partial<GitBackendConfig>;
}

/** Build the GitStore selected by `git.backend` (`embedded` = es-git/libgit2, default; `cli` = system git). */
export function createGitStore(config: GitStoreConfig): GitStore {
  const opts = { dir: config.dataDir, branch: config.branch, remote: config.remote, author: config.author };
  const backend = config.git?.backend ?? 'embedded';
  switch (backend) {
    case 'embedded':
      return new EsGitStore(opts);
    case 'cli':
      return new CliGitStore({ ...opts, gitPath: config.git?.cliPath, env: config.git?.cliEnv });
    default:
      throw new Error(`unknown git backend '${backend as string}' (expected embedded | cli)`);
  }
}
export { SubdirGitStore } from './SubdirGitStore.js';
