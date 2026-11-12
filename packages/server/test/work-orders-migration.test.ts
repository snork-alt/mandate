/**
 * The one-time migration work-orders.jsonl -> work-orders/<id>.md, on a COPY of data/repo (never on data/repo itself):
 * ids, status, claims, timestamps and sections kept, a history section, one commit, jsonl removed, idempotent, the
 * index and the activity feed stay consistent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EsGitStore } from '../src/git/EsGitStore.js';
import { deriveCommitEvents } from '../src/events/derive.js';
import { createStorage, MemoryHeartbeats, migrateWorkOrders } from '../src/storage/index.js';
import { parseLegacyLines } from '../src/storage/work-order-docs.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../data/repo');
const sh = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

afterAll(cleanupTempDirs);

/** A clone of data/repo as it was before the migration (resets to the migration commit's parent if needed). */
async function preMigrationCopy() {
  const dir = path.join(await tempDir(), 'repo');
  execFileSync('git', ['clone', '-q', SOURCE, dir]);
  if (!existsSync(path.join(dir, 'work-orders.jsonl'))) {
    const mig = sh(dir, 'log', '--format=%H', '--grep=Mandate-Migration: work-orders-md', '-n', '1');
    expect(mig, 'data/repo has neither work-orders.jsonl nor a migration commit').not.toBe('');
    sh(dir, 'reset', '-q', '--hard', `${mig}^`);
  }
  const git = new EsGitStore({ dir, author: { name: 'Test', email: 'test@example.com' } });
  await git.open();
  return { dir, git };
}

describe('work-orders.jsonl -> markdown documents', () => {
  it('converts every line in one commit, keeps ids / status / claims / timestamps, and is idempotent', async () => {
    const { dir, git } = await preMigrationCopy();
    const legacy = parseLegacyLines(readFileSync(path.join(dir, 'work-orders.jsonl'), 'utf8')).items;
    expect(legacy.length).toBeGreaterThan(0);
    const heartbeats = new MemoryHeartbeats();
    const storage = createStorage(git, { heartbeats });
    const count = () => Number(sh(dir, 'rev-list', '--count', 'HEAD'));
    const before = count();
    const r = await migrateWorkOrders({ git, lock: storage.lock, history: storage.history, heartbeats });
    expect(r.migrated.sort()).toEqual(legacy.map((w) => w.id).sort());
    expect(r.unmigrated).toBe(0);
    expect(count()).toBe(before + 1);
    expect(existsSync(path.join(dir, 'work-orders.jsonl'))).toBe(false);
    expect(sh(dir, 'log', '-1', '--format=%B')).toMatch(/^work-orders: migrate work-orders\.jsonl to markdown documents/);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
    const now = await storage.workOrders.list();
    for (const l of legacy) {
      const w = now.find((x) => x.id === l.id)!;
      expect(w, l.id).toBeDefined();
      expect(w).toMatchObject({ spec: l.spec, kind: l.kind, status: l.status, createdAt: l.createdAt, updatedAt: l.updatedAt, sections: l.sections.map((s) => ({ id: s.id, status: s.status })) });
      expect(w.specCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(w.specCommit.startsWith(l.specCommit.slice(0, 7))).toBe(true);
      if (l.claim && (l.status === 'pending' || l.status === 'in_progress')) {
        expect(w.claim).toMatchObject({ agent: l.claim.agent, startedAt: l.claim.startedAt });
        // The last heartbeat moved to the runtime state.
        expect(heartbeats.get(l.id)).toEqual({ agent: l.claim.agent, at: l.claim.heartbeatAt });
      }
      if (l.findings?.length) expect(w.findings).toEqual(l.findings);
      const raw = readFileSync(path.join(dir, `work-orders/${l.id}.md`), 'utf8');
      expect(raw).not.toContain('heartbeatAt');
      expect(raw).toContain('<!-- @section history -->');
    }
    // The migration commit yields no per-item activity (one plain commit event).
    const events = await deriveCommitEvents(git, sh(dir, 'rev-parse', 'HEAD'));
    expect(events.map((e) => e.type)).toEqual(['commit']);
    // Idempotent: nothing to do the second time.
    expect(await migrateWorkOrders({ git, lock: storage.lock, history: storage.history })).toEqual({ migrated: [], skipped: [], commit: null, unmigrated: 0 });
    expect(count()).toBe(before + 1);
    // Writes work on the migrated documents.
    const open = now.find((w) => w.status === 'pending')!;
    await storage.workOrderService.planSet(open.id, 'tester', '1. Do it.');
    expect((await storage.workOrders.get(open.id)).hasPlan).toBe(true);
  }, 120_000);

  it('a partially migrated repo (documents present) keeps the documents and still removes the jsonl', async () => {
    const { dir, git } = await preMigrationCopy();
    const storage = createStorage(git);
    const first = parseLegacyLines(readFileSync(path.join(dir, 'work-orders.jsonl'), 'utf8')).items[0]!;
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'work-orders'), { recursive: true });
    const { workOrderCodec } = await import('../src/storage/codecs.js');
    const { docFromLegacy } = await import('../src/storage/work-order-docs.js');
    const full = sh(dir, 'rev-parse', first.specCommit);
    await writeFile(path.join(dir, `work-orders/${first.id}.md`), workOrderCodec.encode({ ...docFromLegacy(first, { specCommit: full }), title: 'Hand-written' }));
    const r = await migrateWorkOrders({ git, lock: storage.lock, history: storage.history });
    expect(r.skipped).toEqual([first.id]);
    expect((await storage.workOrders.get(first.id)).title).toBe('Hand-written');
    expect(existsSync(path.join(dir, 'work-orders.jsonl'))).toBe(false);
  }, 120_000);
});
