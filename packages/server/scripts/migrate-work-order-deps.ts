/** In-place: the plans tiers -> usage metering link and the extra seed work orders (real-time commits). */
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { seedLinks } from './links-seed.js';
import { WORK_ORDERS } from './seed-data.js';

const config = loadConfig();
const git = createGitStore(config);
await git.openOrCreate();
const storage = createStorage(git);
await seedLinks(storage, () => new Date());
const existing = await storage.workOrders.list();
for (const { hoursAgo: _h, agent, ...item } of WORK_ORDERS.filter((w) => !w.id)) {
  if (existing.some((w) => w.spec === item.spec && w.kind === item.kind && w.status === item.status)) continue;
  const created = await storage.workOrderService.create(item, {
    date: new Date(),
    author: { name: item.createdBy.charAt(0).toUpperCase() + item.createdBy.slice(1), email: `${item.createdBy}@example.com` },
    message: `work order: ${item.kind} ${item.spec} (${item.sections.map((x) => x.id).join(', ')})`,
    ...(agent ? { agent } : {}),
  });
  console.log('created', created.id, item.spec);
}
