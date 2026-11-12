import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { OpenAICompatibleProvider } from '../src/index/embed/index.js';
import { truncateToTokens } from '../src/index/embed/queue.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

describe('config', () => {
  it('creates ~/.mandate/config.json with defaults (existing ./data/repo kept as data dir)', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    mkdirSync(path.join(cwd, 'data/repo/.git'), { recursive: true });
    const cfg = loadConfig({ HOME: home, INIT_CWD: cwd });
    expect(cfg.configPath).toBe(path.join(home, '.mandate/config.json'));
    const file = JSON.parse(readFileSync(cfg.configPath, 'utf8'));
    expect(file.projects).toEqual([{ id: 'default', name: 'Default', dataDir: path.join(cwd, 'data/repo') }]);
    expect(file.dataDir).toBeUndefined();
    expect(cfg.projects.map((p) => p.id)).toEqual(['default']);
    expect(cfg.defaultProject).toBe('default');
    expect(file.embedding).toMatchObject({ provider: 'openai-compatible', model: 'nomic-embed-text', dimensions: 768 });
    expect(readFileSync(cfg.configPath, 'utf8')).toContain('\n  "server": {\n');
    expect(cfg.port).toBe(4000);
    expect(cfg.index.path).toMatch(new RegExp(`^${home}/\\.mandate/index/[0-9a-f]{16}\\.sqlite$`));
    // Without ./data/repo: ~/.mandate/repos/default
    const home2 = await tempDir();
    expect(loadConfig({ HOME: home2, INIT_CWD: home2 }).dataDir).toBe(path.join(home2, '.mandate/repos/default'));
  });

  it('env > file > defaults; secrets only from named env vars', async () => {
    const home = await tempDir();
    const p = path.join(home, '.mandate/config.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        dataDir: '~/specs',
        server: { port: 4100 },
        git: { remote: 'https://example.com/specs.git', auth: { username: 'me', tokenEnv: 'MY_TOKEN' } },
        embedding: { provider: 'none', apiKeyEnv: 'EMB_KEY' },
        index: { path: '~/idx.sqlite' },
      }),
    );
    const cfg = loadConfig({ HOME: home, MY_TOKEN: 's3cret', EMB_KEY: 'k', MANDATE_PORT: '4200', MANDATE_INDEX_PATH: '' });
    expect(cfg.dataDir).toBe(path.join(home, 'specs'));
    expect(cfg.port).toBe(4200);
    expect(cfg.remote).toEqual({ url: 'https://example.com/specs.git', branch: 'main', auth: { type: 'https', username: 'me', token: 's3cret' } });
    expect(cfg.embedding).toMatchObject({ provider: 'none', apiKey: 'k', dimensions: 768 });
    expect(cfg.index.path).toBe(path.join(home, 'idx.sqlite'));
    expect(loadConfig({ HOME: home, MANDATE_EMBEDDING_PROVIDER: 'local', MANDATE_DATA_DIR: '/x' })).toMatchObject({ dataDir: '/x', embedding: { provider: 'local' } });
  });

  it('reports every problem with the file path', async () => {
    const home = await tempDir();
    const p = path.join(home, '.mandate/config.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ dataDir: 'x', server: { port: 'no' }, git: { auth: { tokenEnv: 'ghp_literal-secret!' } }, extra: 1 }));
    let err: unknown;
    try {
      loadConfig({ HOME: home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain(p);
    expect(msg).toMatch(/server\.port/);
    expect(msg).toMatch(/git\.auth\.tokenEnv: must be the NAME of an environment variable/);
    expect(msg).toMatch(/Unrecognized key.*extra/);
    writeFileSync(p, '{ nope');
    expect(() => loadConfig({ HOME: home })).toThrow(/not valid JSON/);
  });
});

describe('openai-compatible provider', () => {
  it('posts to /embeddings, retries on 5xx and checks dimensions', async () => {
    const calls: string[] = [];
    let n = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${JSON.parse(String(init.body)).input.length}`);
      if (n++ === 0) return new Response('busy', { status: 503 });
      return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1/', model: 'm', dimensions: 2, modelId: 'x', fetch: fakeFetch, retries: 2 });
    const v = await p.embed(['a', 'b']);
    expect(calls).toEqual(['http://h/v1/embeddings 2', 'http://h/v1/embeddings 2']);
    expect([...v[0]!]).toEqual([1, 0]);
    const bad = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', dimensions: 3, modelId: 'x', fetch: fakeFetch, retries: 0 });
    await expect(bad.embed(['a', 'b'])).rejects.toThrow(/2-dimensional vectors but embedding.dimensions is 3/);
    const denied = new OpenAICompatibleProvider({ baseUrl: 'http://h', model: 'm', dimensions: 2, modelId: 'x', fetch: (async () => new Response('no', { status: 401 })) as typeof fetch });
    await expect(denied.embed(['a'])).rejects.toThrow(/HTTP 401/);
  });

  it('truncates long inputs to the token budget', () => {
    expect(truncateToTokens('word '.repeat(5000), 100).length).toBeLessThanOrEqual(348);
    expect(truncateToTokens('short', 100)).toBe('short');
  });
});
