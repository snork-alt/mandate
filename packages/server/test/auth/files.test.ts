/** keys.json (format, 0600, permission refusal, hot reload, auto-generation), secrets.env, project config + migration, key CLI. */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KeyStore, maskKey } from '../../src/auth/keys.js';
import { parseDotenv, SecretsFile } from '../../src/secrets.js';
import { ConfigError, loadConfig, projectIndexPath } from '../../src/config.js';
import { main as cli } from '../../scripts/mandate.js';
import { AuthStore, loadServerSecret } from '../../src/auth/sessions.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

afterAll(cleanupTempDirs);

describe('keys.json', () => {
  it('creates one key per project (idempotent), mode 0600, format mnd_<project>_<base64url>', async () => {
    const file = path.join(await tempDir(), 'sub', 'keys.json');
    const ks = new KeyStore(file);
    expect(ks.ensureProjectKeys(['alpha', 'my-proj'])).toEqual(['alpha', 'my-proj']);
    expect(ks.ensureProjectKeys(['alpha', 'my-proj'])).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const keys = ks.list();
    expect(keys).toHaveLength(2);
    expect(keys[1]!.key).toMatch(/^mnd_my-proj_[A-Za-z0-9_-]{43}$/);
    expect(keys[0]).toMatchObject({ project: 'alpha', name: 'default' });
    expect(maskKey(keys[0]!.key)).toMatch(/^mnd_alpha_.{4}….{4}$/);
    // A new project later gets its own key; existing ones are untouched.
    expect(ks.ensureProjectKeys(['alpha', 'my-proj', 'gamma'])).toEqual(['gamma']);
    expect(ks.list().slice(0, 2)).toEqual(keys);
  });

  it('verifies only for the key’s own project, constant-time over every key, and records lastUsedAt', async () => {
    const ks = new KeyStore(path.join(await tempDir(), 'keys.json'), { touchIntervalMs: 0 });
    ks.ensureProjectKeys(['a', 'b']);
    const [ka, kb] = ks.list();
    expect(ks.verify('a', ka!.key)?.id).toBe(ka!.id);
    expect(ks.verify('a', kb!.key)).toBeNull();
    expect(ks.verify('a', `${ka!.key}x`)).toBeNull();
    expect(ks.verify(null, kb!.key)?.project).toBe('b');
    expect(ks.list()[0]!.lastUsedAt).toBeTruthy();
  });

  it('refuses a group/world-readable file (and never overwrites it)', async () => {
    const errors: string[] = [];
    const file = path.join(await tempDir(), 'keys.json');
    const ks = new KeyStore(file, { log: { warn: (m) => errors.push(m), error: (m) => errors.push(m) } });
    ks.ensureProjectKeys(['a']);
    const key = ks.list()[0]!.key;
    chmodSync(file, 0o644);
    expect(ks.verify('a', key)).toBeNull();
    expect(ks.status()).toMatch(/too open/);
    expect(errors.join('\n')).toMatch(/REFUSING agent keys.*chmod 600/);
    expect(errors.join('\n')).not.toContain(key);
    expect(() => ks.create('a', 'x')).toThrow(/too open/);
    chmodSync(file, 0o600);
    expect(ks.verify('a', key)).not.toBeNull();
  });

  it('picks up edits by another process (revoke) without a restart', async () => {
    const file = path.join(await tempDir(), 'keys.json');
    const server = new KeyStore(file);
    server.ensureProjectKeys(['a']);
    const extra = new KeyStore(file).create('a', 'ci-bot');
    expect(server.verify('a', extra.key)?.name).toBe('ci-bot');
    new KeyStore(file).revoke(extra.id);
    expect(server.verify('a', extra.key)).toBeNull();
  });

  it('rejects an invalid file without echoing keys', async () => {
    const file = path.join(await tempDir(), 'keys.json');
    writeFileSync(file, '{"keys":[{"id":"bad"}', { mode: 0o600 });
    const ks = new KeyStore(file);
    expect(ks.status()).toMatch(/not valid JSON/);
  });
});

describe('secrets.env', () => {
  it('parses comments, quotes and export', () => {
    const m = parseDotenv(`# comment\nA=1\nexport B="two words" \nC='single # not comment'\nD=x # trailing\n\nbad line\nE="multi\\nline"`);
    expect(Object.fromEntries(m)).toEqual({ A: '1', B: 'two words', C: 'single # not comment', D: 'x', E: 'multi\nline' });
  });

  it('fills only unset variables; hot-reloads its own values', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'secrets.env');
    writeFileSync(file, 'MY_TOKEN=from-file\nREAL=from-file\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { REAL: 'from-env' };
    const s = new SecretsFile(file, env, { warn: () => undefined });
    s.refresh();
    expect(env).toEqual({ REAL: 'from-env', MY_TOKEN: 'from-file' });
    writeFileSync(file, 'MY_TOKEN=rotated\nNEW_ONE=1\n', { mode: 0o600 });
    const t = new Date(Date.now() + 2000);
    (await import('node:fs')).utimesSync(file, t, t);
    s.refresh();
    expect(env).toEqual({ REAL: 'from-env', MY_TOKEN: 'rotated', NEW_ONE: '1' });
  });

  it('refuses a group/world-readable file with a warning that never shows values', async () => {
    const file = path.join(await tempDir(), 'secrets.env');
    writeFileSync(file, 'S=supersecretvalue\n');
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const s = new SecretsFile(file, env, { warn: (m) => warnings.push(m) });
    s.refresh();
    expect(env.S).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/NOT loading secrets.*chmod 600/);
    expect(warnings.join('\n')).not.toContain('supersecretvalue');
  });
});

describe('project config', () => {
  const write = async (json: unknown) => {
    const home = await tempDir();
    const p = path.join(home, '.mandate', 'config.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(json));
    return { home, p };
  };

  it('migrates a legacy dataDir into the project "default" (same index path), keeping other blocks', async () => {
    const { home, p } = await write({ dataDir: '~/specs', ask: { provider: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1', apiKeyEnv: 'K' } });
    const before = loadConfig({ HOME: home, MANDATE_CONFIG: p, MANDATE_DATA_DIR: '' });
    const file = JSON.parse(readFileSync(p, 'utf8'));
    expect(file.dataDir).toBeUndefined();
    expect(file.projects).toEqual([{ id: 'default', name: 'Default', dataDir: '~/specs' }]);
    expect(file.ask.model).toBe('m');
    expect(before.projects[0]).toMatchObject({ id: 'default', dataDir: path.join(home, 'specs') });
    expect(before.index.path).toBe(projectIndexPath('~/.mandate/index/{dataDirHash}.sqlite', path.join(home, 'specs'), 'default', true).replace('~', home));
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('resolves several projects with separate index files and per-project git settings', async () => {
    const { home, p } = await write({
      projects: [
        { id: 'web', name: 'Web', dataDir: '~/web' },
        { id: 'api', name: 'API', dataDir: '~/api', git: { branch: 'trunk', remote: 'https://example.com/api.git' }, github: { repo: 'acme/api', path: 'docs', connectedBy: 'octo' } },
      ],
      index: { path: '~/idx.sqlite' },
      auth: { required: true, sessionTtlHours: 24 },
    });
    const c = loadConfig({ HOME: home, MANDATE_CONFIG: p });
    expect(c.defaultProject).toBe('web');
    expect(c.projects.map((x) => x.index.path)).toEqual([path.join(home, 'idx.sqlite'), path.join(home, 'idx.api.sqlite')]);
    expect(c.projects[1]).toMatchObject({ branch: 'trunk', remote: { url: 'https://example.com/api.git' }, github: { repo: 'acme/api', path: 'docs' } });
    expect(c.warnings[0]).toMatch(/auth.required is deprecated/);
    expect(c.auth.sessionTtlHours).toBe(24);
  });

  it('validates projects strictly', async () => {
    for (const projects of [[{ id: 'Bad_Id', name: 'x', dataDir: '/x' }], [{ id: 'a', name: 'x', dataDir: '/x' }, { id: 'a', name: 'y', dataDir: '/y' }], [{ id: 'a', name: 'x', dataDir: '/x', extra: 1 }], []]) {
      const { home, p } = await write({ projects });
      expect(() => loadConfig({ HOME: home, MANDATE_CONFIG: p })).toThrow(ConfigError);
    }
  });
});

describe('key CLI', () => {
  it('creates, lists (masked) and revokes keys; unknown projects fail', async () => {
    const home = await tempDir();
    const mh = path.join(home, '.mandate');
    mkdirSync(mh, { recursive: true });
    writeFileSync(path.join(mh, 'config.json'), JSON.stringify({ projects: [{ id: 'web', name: 'Web', dataDir: '~/web' }] }));
    const env = { HOME: home, MANDATE_HOME: mh };
    const out: string[] = [];
    const run = (...a: string[]) => cli(a, env, (s) => out.push(s));
    expect(await run('key', 'create', 'web', '--name', 'ci bot')).toBe(0);
    const key = /mnd_web_\S+/.exec(out.join('\n'))![0];
    out.length = 0;
    expect(await run('key', 'list')).toBe(0);
    expect(out.join('\n')).toContain('ci bot');
    expect(out.join('\n')).not.toContain(key);
    const id = /key_[a-z0-9]+/.exec(out.join('\n'))![0];
    expect(await run('key', 'revoke', id)).toBe(0);
    expect(await run('key', 'revoke', id)).toBe(1);
    expect(await run('key', 'create', 'nope')).toBe(1);
    expect(await run('project', 'add', 'x')).toBe(2);
    // UI session for headless checks: allowed users only; works with the server's store; revocable.
    writeFileSync(path.join(mh, 'config.json'), JSON.stringify({ projects: [{ id: 'web', name: 'Web', dataDir: '~/web' }], auth: { github: { clientId: 'x', allowedUsers: ['octo'] } } }));
    out.length = 0;
    expect(await run('session', 'create', 'mallory')).toBe(1);
    expect(await run('session', 'create', 'octo', '--ttl-minutes', '5')).toBe(0);
    const cookie = /mandate_session=(\S+)/.exec(out.join('\n'))![1]!;
    const store = new AuthStore(mh, loadServerSecret(mh, env), 3600_000);
    expect(store.session(cookie)?.login).toBe('octo');
    expect(await run('session', 'revoke', cookie)).toBe(0);
    expect(store.session(cookie)).toBeNull();
    // --out: a Playwright cookie list (0600), the value never printed; revocable from the file.
    out.length = 0;
    const jar = path.join(mh, 'jar', 'cookie.json');
    expect(await run('session', 'create', 'octo', '--out', jar)).toBe(0);
    const [c] = JSON.parse(readFileSync(jar, 'utf8')) as { name: string; value: string; domain: string }[];
    expect(c).toMatchObject({ name: 'mandate_session', domain: 'localhost' });
    expect(out.join('\n')).not.toContain(c!.value);
    expect(statSync(jar).mode & 0o777).toBe(0o600);
    expect(store.session(c!.value)?.login).toBe('octo');
    expect(await run('session', 'revoke', '--file', jar)).toBe(0);
    expect(store.session(c!.value)).toBeNull();
    expect(statSync(path.join(mh, 'keys.json')).mode & 0o777).toBe(0o600);
  });
});
