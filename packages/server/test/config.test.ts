import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { OpenAICompatibleProvider } from '../src/index/embed/index.js';
import { truncateToTokens } from '../src/index/embed/queue.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

describe('older settings (one setup: GitHub sign-in)', () => {
  const load = async (server: Record<string, unknown> | undefined, auth?: Record<string, unknown>) => {
    const home = await tempDir();
    const mh = path.join(home, '.mandate');
    mkdirSync(mh, { recursive: true });
    const file = path.join(mh, 'config.json');
    const json = { ...(server ? { server } : {}), ...(auth ? { auth } : {}), embedding: { provider: 'none' } };
    writeFileSync(file, JSON.stringify(json));
    const cfg = loadConfig({ HOME: home, MANDATE_HOME: mh });
    // Startup never rewrites config.json (user-owned); the old key is read as an alias.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(json);
    return cfg;
  };
  const github = { github: { clientId: 'Ov23.x', allowedUsers: ['octo'] } };

  it('older server.users / server.mode values still load (ignored, with a warning); nothing is rewritten', async () => {
    for (const server of [{ users: 'me' }, { mode: 'local' }, { users: 'team' }, { mode: 'server', publicUrl: 'https://m.example.com' }]) {
      const cfg = await load(server);
      expect(cfg).toMatchObject({ legacyAuth: false });
      expect(cfg.warnings.join('\n')).toMatch(/server.users \/ server.mode are ignored/);
    }
    expect((await load(undefined)).host).toBe('127.0.0.1');
  });

  it('an older OAuth App install (auth.github, no app, no mode) keeps its allow-list behaviour', async () => {
    const cfg = await load(undefined, github);
    expect(cfg).toMatchObject({ legacyAuth: true });
    expect(cfg.auth.github).toMatchObject({ clientId: 'Ov23.x', clientSecretEnv: 'MANDATE_GITHUB_CLIENT_SECRET' });
    expect((await load(undefined, { github: { ...github.github, app: { id: 1, slug: 'mandate-x' } } })).legacyAuth).toBe(false);
  });
});

describe('config', () => {
  it('runs on defaults without creating config.json; seeds projects.json (existing ./data/repo kept as data dir)', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    mkdirSync(path.join(cwd, 'data/repo/.git'), { recursive: true });
    const cfg = loadConfig({ HOME: home, INIT_CWD: cwd });
    expect(cfg.configPath).toBe(path.join(home, '.mandate/config.json'));
    expect(existsSync(cfg.configPath)).toBe(false);
    const reg = JSON.parse(readFileSync(path.join(home, '.mandate/projects.json'), 'utf8'));
    expect(reg.projects).toEqual([{ id: 'default', name: 'Default', dataDir: path.join(cwd, 'data/repo'), createdAt: expect.any(String) }]);
    expect(cfg.projects.map((p) => p.id)).toEqual(['default']);
    expect(cfg.defaultProject).toBe('default');
    expect(cfg.embedding).toMatchObject({ provider: 'openai-compatible', model: 'nomic-embed-text', dimensions: 768 });
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
