import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSpecSchema } from '@mandate/shared';
import { FakeProvider } from '../src/index/embed/index.js';
import { IndexService } from '../src/index/service.js';
import { createStorage, type Storage } from '../src/storage/index.js';
import { DocViewService } from '../src/storage/views.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

const embedding = {
  provider: 'openai-compatible' as const,
  baseUrl: 'http://localhost:1/v1',
  model: 'fake',
  apiKeyEnv: null,
  dimensions: 32,
  maxInputTokens: 2048,
  batchSize: 16,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};
const WORDS = ['payments', 'ledger', 'refunds', 'auth', 'session', 'tokens', 'webhook', 'retry', 'audit', 'search', 'index', 'cache'];

afterAll(cleanupTempDirs);

/** similar_to recompute: debounced + coalesced after embedding drains, sliced so requests keep being served, same edges. */
describe('similar_to recompute scheduling', () => {
  let storage: Storage;
  let index: IndexService;

  beforeAll(async () => {
    const root = await tempDir();
    const git = await newStore(path.join(root, 'repo'));
    storage = createStorage(git);
    for (let i = 0; i < 25; i++) {
      await storage.specs.create(
        createSpecSchema.parse({
          title: `Spec ${i}`,
          sections: Array.from({ length: 6 }, (_, j) => ({ id: `s${j}`, title: `Part ${j}`, body: `${WORDS[(i + j) % WORDS.length]} ${WORDS[(i * j) % WORDS.length]} handling for spec ${i} part ${j}.` })),
        }),
      );
    }
    index = new IndexService({ git, storage, index: { path: path.join(root, 'index.sqlite'), chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 }, embedding, provider: new FakeProvider(32, 'fake:32'), similarThreshold: 0.2, similarDebounceMs: 30, similarMaxDelayMs: 200 });
    await index.start();
    await index.idle();
  }, 60_000);
  afterAll(() => index.close());

  const openEdges = () => (index.db.prepare("SELECT from_uri, to_uri, score FROM edges WHERE source = 'similar' AND valid_to IS NULL ORDER BY from_uri, to_uri").all() as { from_uri: string; to_uri: string; score: number }[]).map((e) => `${e.from_uri}|${e.to_uri}|${e.score}`);

  it('produces the full top-5 neighbour edge set (same as nearest per section)', async () => {
    const sections = (index.db.prepare('SELECT uri FROM sections').all() as { uri: string }[]).map((r) => r.uri);
    expect(sections.length).toBe(150);
    const want = new Set<string>();
    for (const uri of sections) {
      for (const n of (await index.related({ uri, limit: 5, kinds: ['section'] })).items) {
        if (n.score < 0.2) continue;
        const [a, b] = uri < n.uri ? [uri, n.uri] : [n.uri, uri];
        want.add(`${a}|${b}`);
      }
    }
    const got = openEdges().map((e) => e.split('|').slice(0, 2).join('|'));
    expect(got.length).toBeGreaterThan(0);
    expect(new Set(got)).toEqual(want);
  });

  it('coalesces many drains into one debounced run (plus at most one trailing run)', async () => {
    const spy = vi.spyOn(index, 'recomputeSimilar');
    const before = openEdges();
    const drained = (index as unknown as { onDrained(): void }).onDrained.bind(index);
    for (let i = 0; i < 50; i++) drained();
    expect(spy).not.toHaveBeenCalled(); // debounced, never synchronous inside the drain
    await index.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    // A drain while a run is in flight owes exactly one trailing run.
    spy.mockClear();
    drained();
    await new Promise((r) => setTimeout(r, 60));
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) drained();
    await index.idle();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(openEdges()).toEqual(before);
    spy.mockRestore();
  });

  it('yields to the event loop: a concurrent doc_get resolves before the recompute finishes', async () => {
    const views = new DocViewService(storage);
    let recomputeDone = false;
    let timerSawRunning: boolean | null = null;
    const run = index.recomputeSimilar(0).then(() => (recomputeDone = true));
    setTimeout(() => (timerSawRunning = !recomputeDone), 0);
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    const t0 = performance.now();
    const doc = await views.get({ kind: 'specs', id: 'spec-3' });
    const docMs = performance.now() - t0;
    await run;
    clearInterval(tick);
    expect(doc).toMatchObject({ id: 'spec-3' });
    // A timer queued after the run started fires while it is still running (the old code ran to completion synchronously).
    expect(timerSawRunning).toBe(true);
    expect(docMs).toBeLessThan(5000);
    expect(maxGap).toBeLessThan(500);
  });
});
