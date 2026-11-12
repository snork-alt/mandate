/** In-place: architecture components and affects links (real-time commits, idempotent). */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { applyComponents } from './components-seed.js';

const git = createGitStore(loadConfig());
await git.openOrCreate();
const storage = createStorage(git);
console.log((await applyComponents(storage, () => ({ date: new Date(), author: { name: 'Sofia', email: 'sofia@example.com' } }))).join('\n'));
const { readdir } = await import('node:fs/promises');
for (const kind of ['specs', 'standards', 'components'] as const) {
  const files = (await readdir(`${git.dir}/${kind}`)).filter((f) => f.endsWith('.md'));
  if ((await storage[kind].list()).length !== files.length) throw new Error(`${kind}: a file does not parse after the migration`);
}
const issues = (await storage.integrity.run()).issues;
console.log('integrity issues:', issues.map((i) => `${i.rule}: ${i.message}`));
if (issues.some((i) => i.rule !== 'unowned_code_ref' && i.rule !== 'owns_matches_nothing')) process.exitCode = 1;
