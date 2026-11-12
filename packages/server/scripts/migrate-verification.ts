/** In-place migration: acceptance sections + verification results (see verification-seed.ts). */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { seedVerification } from './verification-seed.js';

const config = loadConfig();
const git = createGitStore(config);
await git.openOrCreate();
const storage = createStorage(git);
const start = Date.now() - 90 * 60_000; // spread commits over the last ~70 minutes (never in the future)
await seedVerification(storage, (m) => new Date(start + m * 30_000));
for (const s of await storage.specs.list()) {
  const v = await storage.verificationService.forSpec(s);
  console.log(`${s.id.padEnd(20)} ${s.status.padEnd(12)} ${v.verified}/${v.total} verified, ${v.failing} failing, ${v.stale} stale`);
}
