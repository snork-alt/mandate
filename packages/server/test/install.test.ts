/** The one-line installer: rendering (no secrets, pinned version, URL / project), routes (HTTPS, checksum), a real sh run. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { registerInstallRoutes } from '../src/install/routes.js';
import { renderInstallPs1, renderInstallSh, sha256Hex } from '../src/install/script.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const TEAM = { url: 'https://mandate.example.com', project: 'web', version: '1.2.3' };

describe('rendering', () => {
  it('pins the version and names the server and project; holds no token', () => {
    const sh = renderInstallSh(TEAM);
    expect(sh).toContain("MANDATE_URL='https://mandate.example.com'");
    expect(sh).toContain("MANDATE_PROJECT='web'");
    expect(sh).toContain('npx -y "getmandate@$MANDATE_VERSION"');
    expect(sh).toContain("MANDATE_VERSION='1.2.3'");
    expect(sh).toMatch(/^set -eu$/m);
    expect(sh).not.toMatch(/mnd_|mndp_|mat_|Bearer|latest/);
    const ps = renderInstallPs1(TEAM);
    expect(ps).toContain("$MandateVersion = '1.2.3'");
    expect(ps).toContain('getmandate@$MandateVersion');
    expect(ps).not.toMatch(/mnd_|mndp_|Bearer/);
  });
  it('refuses unsafe inputs (they end up in a shell script)', () => {
    expect(() => renderInstallSh({ ...TEAM, project: "x'; rm -rf ~" })).toThrow(/project/);
    expect(() => renderInstallSh({ ...TEAM, version: '1.2.3; curl evil' })).toThrow(/version/);
    expect(() => renderInstallSh({ ...TEAM, url: 'https://x.example.com/path' })).toThrow(/origin/);
  });
  it('is valid POSIX sh (sh -n)', async () => {
    const dir = await tempDir();
    for (const [n, i] of [['a.sh', TEAM], ['b.sh', { ...TEAM, project: null }]] as const) {
      writeFileSync(path.join(dir, n), renderInstallSh(i));
      expect(spawnSync('sh', ['-n', path.join(dir, n)]).status).toBe(0);
    }
  });
});

describe('routes', () => {
  const app = (url: string) => {
    const a = Fastify();
    registerInstallRoutes(a, { url, version: '1.2.3', trustProxy: true, hostOk: (r) => r.headers.host !== 'evil.example', hasProject: (id) => id === 'web' });
    return a;
  };
  const viaProxy = (proto: string) => ({ host: 'mandate.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': proto });

  it('served over HTTPS (no-store, shell type), refused over plain http; the checksum matches', async () => {
    const a = app('https://mandate.example.com');
    const r = await a.inject({ url: '/p/web/install.sh', headers: viaProxy('https') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/x-shellscript/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain("MANDATE_PROJECT='web'");
    const sum = await a.inject({ url: '/p/web/install.sh.sha256', headers: viaProxy('https') });
    expect(sum.body).toBe(`${sha256Hex(r.body)}  install.sh\n`);
    expect((await a.inject({ url: '/p/web/install.sh', headers: viaProxy('http') })).statusCode).toBe(403);
    const ps = await a.inject({ url: '/p/web/install.ps1', headers: viaProxy('https') });
    expect(ps.body).toContain("$MandateProject = 'web'");
    expect((await a.inject({ url: '/p/web/install.ps1.sha256', headers: viaProxy('https') })).body).toBe(`${sha256Hex(ps.body)}  install.ps1\n`);
    expect((await a.inject({ url: '/install.sh', headers: viaProxy('https') })).body).toContain("MANDATE_PROJECT=''");
    expect((await a.inject({ url: '/p/nope/install.sh', headers: viaProxy('https') })).statusCode).toBe(404);
    expect((await a.inject({ url: '/p/web/install.sh', headers: { ...viaProxy('https'), host: 'evil.example' } })).statusCode).toBe(403);
  });

  it('a Mandate on localhost: this machine only', async () => {
    const a = app('http://localhost:4000');
    const ok = await a.inject({ url: '/p/web/install.sh', headers: { host: 'localhost:4000' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("MANDATE_URL='http://localhost:4000'");
    expect((await a.inject({ url: '/p/web/install.sh', headers: { host: 'localhost:4000' }, remoteAddress: '192.168.1.9' })).statusCode).toBe(403);
  });
});

describe('a real run with a stubbed npx', () => {
  const setup = async (nodeMajor = process.versions.node.split('.')[0]) => {
    const dir = await tempDir();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'npx.log');
    writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`);
    writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho ${nodeMajor}\n`);
    chmodSync(path.join(bin, 'npx'), 0o755);
    chmodSync(path.join(bin, 'node'), 0o755);
    const home = path.join(dir, 'home');
    mkdirSync(home);
    const work = path.join(dir, 'work');
    mkdirSync(work);
    const run = (script: string, args: string[], cwd = work) => {
      writeFileSync(path.join(dir, 'install.sh'), script);
      return spawnSync('sh', [path.join(dir, 'install.sh'), ...args], { cwd, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, input: '' });
    };
    return { dir, log, run, work, args: () => readFileSync(log, 'utf8').trim().split('\n') };
  };

  it('calls the pinned connect with the URL, project and the pass-through flags (outside a repo: no repo wiring)', async () => {
    const t = await setup();
    const r = t.run(renderInstallSh(TEAM), ['--agents', 'claude-code,codex', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('This will, for every coding agent');
    expect(r.stdout).toContain('GitHub sign-in on first use');
    expect(t.args()).toEqual(['-y', 'getmandate@1.2.3', 'connect', '--url', 'https://mandate.example.com', '--project', 'web', '--no-repo', '--agents', 'claude-code,codex', '--dry-run']);
  });

  it('inside a git repo with --yes: repo wiring too; --uninstall removes', async () => {
    const t = await setup();
    execFileSync('git', ['init', '-q', t.work]);
    expect(t.run(renderInstallSh(TEAM), ['--yes']).status).toBe(0);
    expect(t.args()).toEqual(['-y', 'getmandate@1.2.3', 'connect', '--url', 'https://mandate.example.com', '--project', 'web', '--repo', '--yes']);
    expect(t.run(renderInstallSh(TEAM), ['--uninstall', '--yes']).status).toBe(0);
    expect(t.args()).toEqual(['-y', 'getmandate@1.2.3', 'connect', '--url', 'https://mandate.example.com', '--project', 'web', '--repo', '--remove', '--yes']);
  });

  it('refuses plain http unless --insecure; needs Node 22 (never installs it)', async () => {
    const t = await setup();
    const http = renderInstallSh({ ...TEAM, url: 'http://mandate.example.com' });
    const r = t.run(http, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing plain http/);
    expect(t.run(http, ['--insecure']).status).toBe(0);
    const old = await setup('18');
    const o = old.run(renderInstallSh(TEAM), []);
    expect(o.status).toBe(1);
    expect(o.stdout).toMatch(/Node\.js 22 or newer/);
    expect(() => readFileSync(old.log)).toThrow(); // npx never ran
  });
});
