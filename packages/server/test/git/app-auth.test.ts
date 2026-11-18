/**
 * `git.auth.method: 'app'`: GitHub App installation tokens (minted from the App's private key, cached until shortly
 * before expiry) push and fetch over HTTPS without an SSH key. The token never lands in argv, the remote URL, git
 * config, process.env, errors or logs. Both backends against a local smart-HTTP server (`git http-backend`) that
 * demands Basic auth `x-access-token:<token>`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppInstallationTokens, AppNotInstalledError, githubRepoOf } from '../../src/auth/app-tokens.js';
import { CliGitStore } from '../../src/git/CliGitStore.js';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import type { GitStore } from '../../src/git/GitStore.js';
import { scrubbed } from '../../src/git/remote-auth.js';
import { loadConfig, type RemoteConfig } from '../../src/config.js';
import { cleanupTempDirs, tempDir } from '../helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const AUTHOR = { name: 'Mandate', email: 'mandate@example.com' };

/** A fake GitHub REST API: installation lookup + token minting; records calls and verifies the JWT. */
function fakeGithub(o: { installedOn?: string[]; tokens?: () => string; expiresInMs?: () => number } = {}) {
  const calls: { method: string; path: string; body: unknown; jwtOk: boolean }[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const jwt = String((init.headers as Record<string, string>).Authorization ?? '').replace(/^Bearer /, '');
    const [h, b, s] = jwt.split('.');
    const jwtOk = !!s && createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')) && JSON.parse(Buffer.from(b!, 'base64url').toString()).iss === '123';
    calls.push({ method: init.method ?? 'GET', path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : null, jwtOk });
    if (!jwtOk) return new Response('{"message":"bad jwt"}', { status: 401 });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(u.pathname);
    if (m) return (o.installedOn ?? ['acme/specs']).includes(`${m[1]}/${m[2]}`) ? new Response(JSON.stringify({ id: 77 }), { status: 200 }) : new Response('{"message":"Not Found"}', { status: 404 });
    if (u.pathname === '/app/installations/77/access_tokens' && init.method === 'POST') {
      const token = o.tokens?.() ?? `ghs_tok${++i}xxxxxxxxxxxxxxxx`;
      return new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + (o.expiresInMs?.() ?? 3600_000)).toISOString() }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const minter = (keyPath: string, gh: ReturnType<typeof fakeGithub>, now?: () => number) =>
  new AppInstallationTokens({ app: () => ({ id: 123, slug: 'mandate-test', privateKeyPath: keyPath }), fetch: gh.fetch, api: 'https://api.test', web: 'https://gh.test', ...(now ? { now } : {}) });

let keyPath: string;
beforeAll(async () => {
  keyPath = path.join(await tempDir(), 'app.pem');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
});
afterAll(cleanupTempDirs);

describe('installation tokens', () => {
  it('mints with a valid RS256 JWT, scopes the token to the repo and caches it until shortly before expiry', async () => {
    let now = Date.now();
    const gh = fakeGithub();
    const t = minter(keyPath, gh, () => now);
    const [a, b] = await Promise.all([t.token('acme', 'specs'), t.token('acme', 'specs')]);
    expect(a).toBe('ghs_tok1xxxxxxxxxxxxxxxx');
    expect(b).toBe(a); // concurrent callers share one mint
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /repos/acme/specs/installation', 'POST /app/installations/77/access_tokens']);
    expect(gh.calls.every((c) => c.jwtOk)).toBe(true);
    expect(gh.calls[1]!.body).toEqual({ repositories: ['specs'] });
    now += 50 * 60_000; // 10 min left: still cached
    expect(await t.token('acme', 'specs')).toBe(a);
    expect(gh.calls).toHaveLength(2);
    now += 6 * 60_000; // 4 min left: refreshed (installation id cached)
    expect(await t.token('acme', 'specs')).toBe('ghs_tok2xxxxxxxxxxxxxxxx');
    expect(gh.calls.map((c) => c.path).slice(2)).toEqual(['/app/installations/77/access_tokens']);
    t.invalidate('acme', 'specs');
    expect(await t.token('acme', 'specs')).toBe('ghs_tok3xxxxxxxxxxxxxxxx');
  });

  it('not installed on the repo: a clear error with the install URL', async () => {
    const t = minter(keyPath, fakeGithub({ installedOn: [] }));
    const e = await t.token('acme', 'other').catch((x: Error) => x);
    expect(e).toBeInstanceOf(AppNotInstalledError);
    expect((e as Error).message).toContain('acme/other');
    expect((e as Error).message).toContain('https://gh.test/apps/mandate-test/installations/new');
  });

  it('missing app / key: actionable errors, never the key contents', async () => {
    const none = new AppInstallationTokens({ app: () => null, fetch: fakeGithub().fetch });
    await expect(none.token('a', 'b')).rejects.toThrow(/no GitHub App is configured/);
    const bad = new AppInstallationTokens({ app: () => ({ id: 123, slug: 's', privateKeyPath: '/nonexistent/key.pem' }), fetch: fakeGithub().fetch });
    await expect(bad.token('a', 'b')).rejects.toThrow(/not readable/);
  });

  it('parses GitHub remote URLs', () => {
    expect(githubRepoOf('git@github.com:acme/specs.git')).toEqual({ owner: 'acme', repo: 'specs' });
    expect(githubRepoOf('https://github.com/acme/specs')).toEqual({ owner: 'acme', repo: 'specs' });
    expect(githubRepoOf('ssh://git@github.com/acme/my.repo.git')).toEqual({ owner: 'acme', repo: 'my.repo' });
    expect(githubRepoOf('https://gitlab.com/acme/specs.git')).toBeNull();
  });

  it('scrubs secrets from errors', () => {
    const e = scrubbed(new Error('fatal: could not read from https://x-access-token:ghs_secret123@github.com and ghs_secret123'), ['ghs_secret123']);
    expect(e.message).not.toContain('ghs_secret123');
    expect(e.stack ?? '').not.toContain('ghs_secret123');
  });
});

describe('config: git.auth.method', () => {
  const setup = async (git: Record<string, unknown>, app = true) => {
    const home = await tempDir();
    const p = path.join(home, '.mandate/config.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ git, auth: { github: { clientId: 'Iv1', ...(app ? { app: { id: 123, slug: 'mandate-test', privateKeyPath: keyPath } } : {}) } } }));
    return home;
  };
  it("defaults to 'app' for the embedded backend when a GitHub App is configured; the remote becomes plain HTTPS", async () => {
    const cfg = loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ remote: 'git@github.com:acme/specs.git' }) });
    expect(cfg.remote?.url).toBe('https://github.com/acme/specs.git');
    expect(cfg.remote?.auth).toMatchObject({ type: 'github-app', owner: 'acme', repo: 'specs' });
    expect(JSON.stringify(cfg.remote)).not.toMatch(/ghs_|token":"/);
  });
  it("stays 'ssh' without an App, with an SSH key, or for system git unless chosen", async () => {
    expect(loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ remote: 'git@github.com:acme/specs.git' }, false) }).remote?.auth?.type).toBe('ssh-agent');
    expect(loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ remote: 'git@github.com:acme/specs.git', auth: { sshKeyPath: '/k' } }) }).remote?.auth?.type).toBe('ssh');
    expect(loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ backend: 'cli', remote: 'https://github.com/acme/specs.git' }) }).remote?.auth).toBeUndefined();
    expect(loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ backend: 'cli', remote: 'https://github.com/acme/specs.git', auth: { method: 'app' } }) }).remote?.auth?.type).toBe('github-app');
    expect(loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: await setup({ remote: 'git@github.com:acme/specs.git', auth: { method: 'ssh' } }) }).remote?.auth?.type).toBe('ssh-agent');
  });
  it("an explicit 'app' with a non-GitHub remote is a config error", async () => {
    const home = await setup({ remote: 'https://gitlab.com/acme/specs.git', auth: { method: 'app' } });
    expect(() => loadConfig({ MANDATE_DATA_DIR: '/tmp/mandate-app-auth-data', HOME: home })).toThrow(/not a GitHub repository URL/);
  });
});

/* ---------------------------------------------------------------- push / fetch over smart HTTP */

/** `git http-backend` behind Basic auth; 401 + WWW-Authenticate when the credentials are missing or wrong. */
async function gitHttpServer(root: string, valid: () => Set<string>) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    if (!auth.startsWith('Basic ') || user !== 'x-access-token' || !valid().has(pass ?? '')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end('auth required');
      return;
    }
    seen.push(pass!);
    const u = new URL(req.url!, 'http://x');
    const cgi = spawn('git', ['http-backend'], {
      env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method!, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', REMOTE_USER: 'x', REMOTE_ADDR: '127.0.0.1', GIT_HTTP_RECEIVE_PACK: 'true' } as NodeJS.ProcessEnv,
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (c: Buffer) => chunks.push(c));
    cgi.on('close', () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf('\r\n\r\n');
      const headEnd = sep >= 0 ? sep : out.indexOf('\n\n');
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, headEnd).toString().split(/\r?\n/)) {
        const [k, ...v] = line.split(':');
        if (!k) continue;
        if (k.toLowerCase() === 'status') status = Number(v.join(':').trim().split(' ')[0]);
        else headers[k] = v.join(':').trim();
      }
      res.writeHead(status, headers).end(out.subarray(headEnd + (sep >= 0 ? 4 : 2)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.each(['embedded', 'cli'] as const)('push / fetch with the GitHub App (%s backend)', (backend) => {
  let root: string;
  let srv: Awaited<ReturnType<typeof gitHttpServer>>;
  let gh: ReturnType<typeof fakeGithub>;
  let tokens: AppInstallationTokens;
  let minted: string[];
  let argvLog: string;
  let gitWrapper: string;

  beforeAll(async () => {
    root = await tempDir();
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', path.join(root, 'acme/specs.git')]);
    minted = [];
    gh = fakeGithub({ tokens: () => (minted.push(`ghs_${backend}${minted.length}SECRETxxxxxxxx`), minted[minted.length - 1]!) });
    tokens = minter(keyPath, gh);
    srv = await gitHttpServer(root, () => new Set(minted));
    // system git through a wrapper that records argv and the env var names it sees (never their values here).
    argvLog = path.join(root, 'argv.log');
    gitWrapper = path.join(root, 'git-wrap.sh');
    writeFileSync(gitWrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nenv | cut -d= -f1 | grep -E '^GIT_|^MANDATE' >> '${argvLog}'\nexec git "$@"\n`);
    chmodSync(gitWrapper, 0o755);
  }, 30_000);
  afterAll(() => srv?.close());

  const remote = (): RemoteConfig => ({
    url: `${srv.url}/acme/specs.git`,
    branch: 'main',
    auth: { type: 'github-app', owner: 'acme', repo: 'specs', token: () => tokens.token('acme', 'specs'), invalidate: () => tokens.invalidate('acme', 'specs') },
  });
  const make = (dir: string, r = remote()): GitStore => (backend === 'embedded' ? new EsGitStore({ dir, author: AUTHOR, remote: r }) : new CliGitStore({ dir, author: AUTHOR, remote: r, gitPath: gitWrapper }));

  it('pushes and fetches with an installation token; no secret on disk, in argv, process.env or errors', async () => {
    const dir = path.join(root, `w-${backend}`);
    const store = make(dir);
    await store.openOrCreate();
    writeFileSync(path.join(dir, 'a.md'), 'hello');
    await store.commit(['a.md'], 'add a');
    await store.push();
    expect(srv.seen.length).toBeGreaterThan(0);
    expect(execFileSync('git', ['-C', path.join(root, 'acme/specs.git'), 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('add a');

    // A second clone fetches / pulls the change.
    const dir2 = path.join(root, `w2-${backend}`);
    const other = make(dir2);
    await other.openOrCreate();
    expect(readFileSync(path.join(dir2, 'a.md'), 'utf8')).toBe('hello');
    writeFileSync(path.join(dir2, 'b.md'), 'b');
    await other.commit(['b.md'], 'add b');
    await other.push();
    expect(await store.pull()).toBe(true);
    expect(existsSync(path.join(dir, 'b.md'))).toBe(true);

    // One cached token served every operation.
    expect(minted).toHaveLength(1);
    const secret = minted[0]!;
    for (const f of [path.join(dir, '.git/config'), path.join(dir2, '.git/config')]) expect(readFileSync(f, 'utf8')).not.toContain(secret);
    expect(readFileSync(path.join(dir, '.git/config'), 'utf8')).toContain(`url = ${srv.url}/acme/specs.git`);
    expect(JSON.stringify(process.env)).not.toContain(secret);
    if (backend === 'cli') {
      const log = readFileSync(argvLog, 'utf8');
      expect(log).toContain('push');
      expect(log).not.toContain(secret);
      expect(log).not.toContain('ghs_');
    }
  });

  it('a rejected token: the error names no secret, the cached token is dropped and the next attempt re-mints', async () => {
    const dir = path.join(root, `w3-${backend}`);
    const store = make(dir);
    await store.openOrCreate();
    writeFileSync(path.join(dir, 'c.md'), 'c');
    await store.commit(['c.md'], 'add c');
    await store.pull().catch(() => undefined);
    const valid = minted.slice();
    minted.length = 0; // the server forgets every token: pushes now fail with 401
    const before = gh.calls.length;
    const e = await store.push().then(() => null, (x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    for (const s of valid) expect(`${e!.message}\n${e!.stack}`).not.toContain(s);
    expect(e!.message).not.toContain('ghs_');
    // invalidated: the next push mints a new token (accepted again) and succeeds.
    await store.pull();
    await store.push();
    expect(gh.calls.length).toBeGreaterThan(before);
  });

  it('App not installed: push fails with the install URL', async () => {
    const t2 = minter(keyPath, fakeGithub({ installedOn: [] }));
    const dir = path.join(root, `w4-${backend}`);
    execFileSync('git', ['init', '-q', '--initial-branch=main', dir]);
    const store = make(dir, { ...remote(), auth: { type: 'github-app', owner: 'acme', repo: 'specs', token: () => t2.token('acme', 'specs') } });
    await store.open();
    writeFileSync(path.join(dir, 'd.md'), 'd');
    await store.commit(['d.md'], 'add d');
    await expect(store.push()).rejects.toThrow(/installations\/new/);
  });
});
