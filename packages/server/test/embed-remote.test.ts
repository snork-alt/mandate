/** Remote embeddings: model presets and prefixes, /models filtering, dimension autodetect, `dimensions` request param, Ask key reuse, model switch with search kept answering, hot reload. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSpecSchema } from '@mandate/shared';
import { embeddingConfigSchema, resolveEmbeddingConfig, type ResolvedEmbeddingConfig } from '../src/config.js';
import { FakeProvider, createProvider, modelIdFor, OpenAICompatibleProvider } from '../src/index/embed/index.js';
import { liveEmbeddingConfig } from '../src/index/embed/live.js';
import { embeddingModelsOf, isEmbeddingEntry, modelPreset, QWEN3_QUERY_PREFIX, switchEstimate } from '../src/index/embed/presets.js';
import { listEmbeddingModels, testEmbeddingModel } from '../src/index/embed/probe.js';
import { IndexService } from '../src/index/service.js';
import { createStorage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const KEY = 'sk-remote-SECRET-0123456789abcdef';

/** A mocked OpenAI-compatible endpoint: /models (mixed list), /embeddings (vector length = `dimensions` or 1536). */
function endpoint() {
  const bodies: Record<string, unknown>[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (auth !== `Bearer ${KEY}`) return json(401, { error: { message: `invalid key ${auth ?? ''}` } });
    if (url.endsWith('/models'))
      return json(200, {
        data: [
          { id: 'gpt-6-luna' },
          { id: 'text-embedding-3-large' },
          { id: 'text-embedding-3-small', pricing: { input_per_million: '0.017' } },
          { id: 'all-minilm-l12-v2', type: 'embedding' },
          { id: 'bge-m3', supported_endpoints: ['/v1/embeddings'] },
          { id: 'claude-haiku-5.5', type: 'chat' },
        ],
      });
    if (url.endsWith('/embeddings')) {
      const b = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions?: number };
      bodies.push(b);
      if (b.model === 'missing-embed') return json(404, { error: { message: 'model missing-embed not found' } });
      if (b.model === 'busy-embed') return json(429, { error: { message: 'slow down' } });
      const n = b.dimensions ?? 1536;
      return json(200, { data: b.input.map((_, i) => ({ index: i, embedding: Array.from({ length: n }, (_, k) => (k === i ? 1 : 0)) })) });
    }
    return json(404, {});
  };
  return { f, bodies };
}

describe('model presets', () => {
  it('prefixes, limits and sizes per model family', () => {
    expect(modelPreset('nomic-embed-text:latest')).toMatchObject({ documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', dimensions: 768, known: true });
    expect(modelPreset('text-embedding-3-small')).toMatchObject({ documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, shortenTo: [256, 512, 1024, 1536], pricePerMTok: 0.02 });
    expect(modelPreset('openai/text-embedding-3-large')).toMatchObject({ dimensions: 3072, pricePerMTok: 0.13 });
    expect(modelPreset('qwen3-embedding-8b')).toMatchObject({ documentPrefix: '', queryPrefix: QWEN3_QUERY_PREFIX });
    expect(QWEN3_QUERY_PREFIX).toMatch(/^Instruct: .+\nQuery:$/);
    expect(modelPreset('gemini-embedding-2')).toMatchObject({ documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ' });
    expect(modelPreset('embeddinggemma-300m').queryPrefix).toBe('task: search result | query: ');
    expect(modelPreset('gemini-embedding-001')).toMatchObject({ documentPrefix: '', queryPrefix: '' });
    expect(modelPreset('mxbai-embed-large').queryPrefix).toMatch(/^Represent this sentence/);
    expect(modelPreset('something-new')).toMatchObject({ documentPrefix: '', queryPrefix: '', known: false });
    expect(modelPreset('text-embedding-ada-002').shortenTo).toBeUndefined();
  });

  it('estimates a switch: chunks × average tokens, cost when the price is known', () => {
    expect(switchEstimate(1000, 300, 0.02)).toEqual({ chunks: 1000, tokens: 300_000, costUsd: 0.006 });
    expect(switchEstimate(10, 100, null).costUsd).toBeNull();
  });

  it('config: new fields are optional (old configs parse unchanged); requestDimensions drives dimensions', () => {
    const old = embeddingConfigSchema.parse({ provider: 'openai-compatible', model: 'nomic-embed-text' });
    expect(old).not.toHaveProperty('preset');
    expect(old.dimensions).toBe(768);
    expect(() => embeddingConfigSchema.parse({ unknown: 1 })).toThrow();
    const cfg = embeddingConfigSchema.parse({ model: 'text-embedding-3-small', preset: 'openai', requestDimensions: 512, dimensions: 1536, apiKeyEnv: 'OPENAI_API_KEY' });
    const r = resolveEmbeddingConfig(cfg, { OPENAI_API_KEY: KEY }, '/x/config.json');
    expect(r.dimensions).toBe(512);
    expect(r.apiKey).toBe(KEY);
    expect(modelIdFor(r)).toContain(':512:');
  });
});

describe('/models filtering and Test (mocked endpoint)', () => {
  it('keeps embedding models only (id or API marker), with listed prices and the preset default', async () => {
    const { f } = endpoint();
    const r = await listEmbeddingModels({ baseUrl: 'https://api.openai.com/v1', apiKey: KEY }, f);
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(['all-minilm-l12-v2', 'bge-m3', 'text-embedding-3-large', 'text-embedding-3-small']);
    expect(r.suggested).toBe('text-embedding-3-small');
    expect(r.models.find((m) => m.id === 'text-embedding-3-small')!.pricePerMTok).toBe(0.017);
    expect(r.models.find((m) => m.id === 'text-embedding-3-large')!.pricePerMTok).toBe(0.13);
    expect(isEmbeddingEntry({ id: 'gpt-6-luna' })).toBe(false);
    expect(embeddingModelsOf([{ id: 'qwen3-embedding-0.6b' }], 'custom').suggested).toBe('qwen3-embedding-0.6b');
    const bad = await listEmbeddingModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'wrong' }, f);
    expect(bad).toMatchObject({ ok: false, errorKind: 'auth' });
  });

  it('Test autodetects the dimensions, measures latency and classifies errors without echoing the key', async () => {
    const { f, bodies } = endpoint();
    const ok = await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'text-embedding-3-small', apiKey: KEY }, f);
    expect(ok).toMatchObject({ ok: true, dimensions: 1536 });
    expect(ok.ms).toBeGreaterThanOrEqual(0);
    expect(ok.preset.shortenTo).toContain(512);
    expect(bodies.at(-1)).not.toHaveProperty('dimensions');
    const short = await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'text-embedding-3-small', apiKey: KEY, requestDimensions: 512 }, f);
    expect(short).toMatchObject({ ok: true, dimensions: 512 });
    expect(bodies.at(-1)).toMatchObject({ dimensions: 512 });
    expect(await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'missing-embed', apiKey: KEY }, f)).toMatchObject({ ok: false, errorKind: 'model' });
    expect(await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'busy-embed', apiKey: KEY }, f)).toMatchObject({ ok: false, errorKind: 'rate_limit' });
    const auth = await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'text-embedding-3-small', apiKey: 'sk-wrong-key-abcdefghijklmnop' }, f);
    expect(auth).toMatchObject({ ok: false, errorKind: 'auth' });
    expect(JSON.stringify(auth)).not.toContain('sk-wrong-key');
    const down = await testEmbeddingModel({ baseUrl: 'https://x.example/v1', model: 'm', apiKey: KEY }, async () => {
      throw new Error(`connect ECONNREFUSED (key ${KEY})`);
    });
    expect(down).toMatchObject({ ok: false, errorKind: 'network' });
    expect(down.message).not.toContain(KEY);
  });

  it('the provider sends `dimensions` only when a shortened size is configured', async () => {
    const { f, bodies } = endpoint();
    const cfg = resolveEmbeddingConfig(embeddingConfigSchema.parse({ model: 'text-embedding-3-small', baseUrl: 'https://x.example/v1', requestDimensions: 256, documentPrefix: '', queryPrefix: '' }), {}, '/c');
    const p = createProvider({ ...cfg, apiKey: KEY }) as OpenAICompatibleProvider;
    (p as unknown as { opts: { fetch: typeof fetch } }).opts.fetch = f;
    const [v] = await p.embed(['hello']);
    expect(v!.length).toBe(256);
    expect(bodies.at(-1)).toMatchObject({ model: 'text-embedding-3-small', dimensions: 256 });
    const full = new OpenAICompatibleProvider({ baseUrl: 'https://x.example/v1', model: 'text-embedding-3-small', dimensions: 1536, apiKey: KEY, modelId: 'x', fetch: f });
    await full.embed(['hello']);
    expect(bodies.at(-1)).not.toHaveProperty('dimensions');
  });
});

/* ------------------------------------------------------------------ model switch */

const spec = (title: string, body: string) => createSpecSchema.parse({ title, sections: [{ id: 'overview', title: 'Overview', body, summary: 'What it is.' }] });
const indexCfg = (file: string) => ({ path: file, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 });
const baseCfg = (model: string, dims: number): ResolvedEmbeddingConfig => ({ ...embeddingConfigSchema.parse({ model, dimensions: dims, documentPrefix: '', queryPrefix: '' }) });

/** FakeProvider that blocks until `open()`. */
class Gated extends FakeProvider {
  private gate: Promise<void>;
  private release!: () => void;
  constructor(dims: number, id: string) {
    super(dims, id);
    this.gate = new Promise((r) => (this.release = r));
  }
  open() {
    this.release();
  }
  override async embed(texts: string[]) {
    await this.gate;
    return super.embed(texts);
  }
}

async function corpus() {
  const dir = await tempDir();
  const git = await newStore(dir);
  const storage = createStorage(git);
  await storage.specs.create(spec('Refunds', 'Customers get their money back within 14 days.'));
  await storage.specs.create(spec('Ledger', 'Entries are double booked and reconciled nightly.'));
  return { git, storage, file: path.join(dir, '..', `${path.basename(dir)}-switch.sqlite`) };
}

describe('switching models', () => {
  it('re-embeds in the background while search keeps answering from the previous model', async () => {
    const { git, storage, file } = await corpus();
    const a = new FakeProvider(32, 'fake:a');
    const index = new IndexService({ git, storage, index: indexCfg(file), embedding: baseCfg('a', 32), provider: a });
    await index.start();
    await index.idle();
    expect((await index.status()).embedding.serving).toMatchObject({ mode: 'current', modelId: 'fake:a' });

    const b = new Gated(48, 'fake:b');
    await index.reconfigureEmbedding(baseCfg('b', 48), b);
    const st = await index.status();
    expect(st.embedding.modelId).toBe('fake:b');
    expect(st.embedding.pending).toBeGreaterThan(0); // backfill queued for the new model
    expect(st.embedding.serving).toMatchObject({ mode: 'previous', modelId: 'fake:a' });
    expect(st.embedding.serving!.note).toMatch(/previous model/);
    const during = await index.search({ q: 'money back' });
    expect(during.semantic.used).toBe(true);
    expect(during.groups[0]!.docUri).toContain('refunds');

    b.open();
    await index.idle();
    const after = await index.status();
    expect(after.embedding).toMatchObject({ pending: 0, serving: { mode: 'current', modelId: 'fake:b' } });
    expect((await index.search({ q: 'money back' })).semantic.used).toBe(true);

    // Back to the first model: its vectors come from the cache, no re-embedding.
    const calls = a.calls;
    await index.reconfigureEmbedding(baseCfg('a', 32), a);
    await index.idle();
    expect(a.calls).toBe(calls);
    expect((await index.status()).embedding).toMatchObject({ pending: 0, serving: { mode: 'current', modelId: 'fake:a' } });
    index.close();
  });

  it('after a restart mid-backfill: the recorded previous model answers; without one usable, text-only and said so', async () => {
    const { git, storage, file } = await corpus();
    const a = new FakeProvider(32, 'fake:a');
    const first = new IndexService({ git, storage, index: indexCfg(file), embedding: baseCfg('a', 32), provider: a });
    await first.start();
    await first.idle();
    first.close();

    // Restart with model b (blocked): the previous model is rebuilt from embed_models through providerFor.
    const b = new Gated(48, 'fake:b');
    const second = new IndexService({ git, storage, index: indexCfg(file), embedding: baseCfg('b', 48), provider: b, providerFor: (c) => (c.model === 'a' ? new FakeProvider(32, 'fake:a') : null) });
    await second.start();
    expect((await second.status()).embedding.serving).toMatchObject({ mode: 'previous', modelId: 'fake:a' });
    expect((await second.search({ q: 'money back' })).semantic.used).toBe(true);
    second.close();

    // The previous model cannot be rebuilt (e.g. its key is gone): text-only until the backfill finishes.
    const c = new Gated(48, 'fake:b');
    const third = new IndexService({ git, storage, index: indexCfg(file), embedding: baseCfg('b', 48), provider: c, providerFor: () => null });
    await third.start();
    const st = await third.status();
    expect(st.embedding.serving).toMatchObject({ mode: 'text-only' });
    const r = await third.search({ q: 'money back' });
    expect(r.semantic.used).toBe(false);
    expect(r.semantic.reason).toMatch(/text-only until the new model b finishes/);
    expect(r.groups.length).toBeGreaterThan(0); // text search still answers
    c.open();
    await third.idle();
    expect((await third.status()).embedding.serving).toMatchObject({ mode: 'current', modelId: 'fake:b' });
    expect((await third.search({ q: 'money back' })).semantic.used).toBe(true);
    third.close();
  });

  it('hot reload: a changed embedding block in config.json applies without a restart', async () => {
    const { git, storage, file } = await corpus();
    const dir = await tempDir();
    mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, 'config.json');
    const write = (model: string, extra: Record<string, unknown> = {}) => writeFileSync(cfgPath, JSON.stringify({ embedding: { model, dimensions: 32, documentPrefix: '', queryPrefix: '', ...extra } }));
    write('a');
    const resolved = resolveEmbeddingConfig(embeddingConfigSchema.parse({ model: 'a', dimensions: 32, documentPrefix: '', queryPrefix: '' }), process.env, cfgPath, cfgPath);
    expect(liveEmbeddingConfig(resolved).model).toBe('a');
    const made: string[] = [];
    const index = new IndexService({
      git,
      storage,
      index: indexCfg(file),
      embedding: resolved,
      embeddingReloadMs: 0,
      providerFor: (c) => (made.push(c.model), new FakeProvider(c.dimensions, `fake:${c.model}:${c.dimensions}`)),
    });
    await index.start();
    await index.idle();
    expect((await index.status()).embedding.modelId).toBe('fake:a:32');
    await new Promise((r) => setTimeout(r, 20));
    write('b', { requestDimensions: 24 });
    const st = await index.status(); // status re-reads the block
    await index.idle();
    const after = await index.status();
    expect(after.embedding.modelId).toBe('fake:b:24');
    expect(after.embedding.dimensions).toBe(24);
    expect(after.embedding.serving).toMatchObject({ mode: 'current', modelId: 'fake:b:24' });
    expect(made).toEqual(['a', 'b']);
    expect(st.embedding).toBeTruthy();
    index.close();
  });
});
