/** In-place: richer standards (rule sections, lifecycle, draft standard); real-time commits, idempotent. */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { applyRichStandards } from './rules-seed.js';

const git = createGitStore(loadConfig());
await git.openOrCreate();
const storage = createStorage(git);
const mapping = await applyRichStandards(storage, () => ({ date: new Date(), author: { name: 'Giulia', email: 'giulia@example.com' } }));
for (const [std, lines] of Object.entries(mapping)) console.log(std, '\n ', lines.join('\n  '));
const { readdir } = await import('node:fs/promises');
const files = (await readdir(`${git.dir}/standards`)).filter((f) => f.endsWith('.md'));
if ((await storage.standards.list()).length !== files.length) throw new Error('a standard does not parse after the migration');
const issues = (await storage.integrity.run()).issues;
console.log('integrity issues:', issues.map((i) => i.message));
if (issues.length) process.exitCode = 1;
