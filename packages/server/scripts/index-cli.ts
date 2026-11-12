/**
 * Search index CLI.
 *   npm run index:rebuild -w @mandate/server     full rebuild (replays history; vectors come from the cache)
 *   npm run index:status -w @mandate/server      counts, head, embedding progress
 *   tsx scripts/index-cli.ts <op> '<json input>'  run any service function, e.g.
 *     tsx scripts/index-cli.ts search '{"q":"refresh token rotation"}'
 * Options: --wait (wait for embeddings), --quiet. Uses ~/.mandate/config.json and MANDATE_* env vars.
 */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { IndexService } from '../src/index/service.js';
import { createStorage } from '../src/storage/index.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const [op = 'status', raw] = args;

const config = loadConfig();
const git = createGitStore(config);
await git.open();
const quiet = flags.has('--quiet');
const index = new IndexService({
  git,
  storage: createStorage(git),
  index: config.index,
  embedding: config.embedding,
  log: { info: (m) => !quiet && console.error(m), warn: (m) => console.error(m), error: (m) => console.error(m) },
});

try {
  if (op === 'rebuild') {
    const t = Date.now();
    const r = await index.rebuild();
    console.error(`rebuilt ${r.commitsIndexed} commits, ${r.filesReindexed} files in ${Date.now() - t} ms; embedding...`);
    await index.idle();
    console.log(JSON.stringify(await index.status(), null, 2));
  } else if (op === 'status') {
    await index.sync();
    if (flags.has('--wait')) await index.idle();
    console.log(JSON.stringify(await index.status(), null, 2));
  } else {
    const fn = (index as unknown as Record<string, (input: unknown) => Promise<unknown>>)[op];
    if (typeof fn !== 'function') throw new Error(`unknown op '${op}'`);
    await index.sync();
    if (flags.has('--wait')) await index.idle();
    console.log(JSON.stringify(await fn.call(index, raw ? JSON.parse(raw) : {}), null, 2));
  }
} finally {
  index.close();
}
