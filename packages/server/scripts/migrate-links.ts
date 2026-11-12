/** In-place: add the seed's cross-document section links (real-time commits). */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { seedLinks } from './links-seed.js';

const config = loadConfig();
const git = createGitStore(config);
await git.openOrCreate();
const storage = createStorage(git);
await seedLinks(storage, () => new Date());
const blocked = await storage.linkService.blockedSections(await storage.specs.list());
console.log('blocked sections:', Object.entries(blocked).filter(([, v]) => v.length));
