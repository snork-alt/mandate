/** The one-line installer: rendering (no secrets, pinned version, URL / project), routes (HTTPS, checksum, the CLI
 * tarball), the tarball cache, and real sh runs with stubbed npm / curl. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { CliTarball, findCliPackage, type Packer } from '../src/install/cli-package.js';
import { registerInstallRoutes } from '../src/install/routes.js';
import { renderInstallPs1, renderInstallSh, renderUninstallPs1, renderUninstallSh, sha256Hex } from '../src/install/script.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const TGZ_BYTES = 'fake getmandate tarball\n';
const TGZ_SHA = sha256Hex(TGZ_BYTES);
const TEAM = { url: 'https://mandate.example.com', project: 'web', version: '1.2.3', cliSha256: TGZ_SHA };

describe('rendering', () => {
  it('pins the version and the CLI checksum, installs from the server (never npm "latest"); holds no token', () => {
    const sh = renderInstallSh(TEAM);
    expect(sh).toContain("MANDATE_URL='https://mandate.example.com'");
    expect(sh).toContain("MANDATE_PROJECT='web'");
    expect(sh).toContain("MANDATE_VERSION='1.2.3'");
    expect(sh).toContain(`MANDATE_CLI_SHA256='${TGZ_SHA}'`);
    expect(sh).toContain('CLI_URL="$MANDATE_URL/getmandate.tgz"');
    expect(sh).toContain('npm install -g --no-fund --no-audit --loglevel=error "$TGZ"');
    expect(sh).toContain('npm install -g --prefix "$CLI_PREFIX"'); // per-user fallback
    expect(sh).toContain('"$CLI" "$@"'); // then connect from the installed CLI
    expect(sh).toMatch(/^set -eu$/m);
    expect(sh).toMatch(/^main "\$@"$/m); // the body runs only once fully read (curl | sh)
    expect(sh).not.toMatch(/npx|getmandate@|mnd_|mndp_|mat_|Bearer|latest/);
    const ps = renderInstallPs1(TEAM);
    expect(ps).toContain("$MandateVersion = '1.2.3'");
    expect(ps).toContain(`$MandateCliSha256 = '${TGZ_SHA}'`);
    expect(ps).toContain('Get-FileHash -Path $tgz -Algorithm SHA256');
    expect(ps).toContain("'--prefix', $CliPrefix");
    expect(ps).not.toMatch(/npx|getmandate@|mnd_|mndp_|Bearer|latest/);
    expect(renderInstallSh({ ...TEAM, cliSha256: null })).toContain("MANDATE_CLI_SHA256=''");
    expect(renderUninstallSh({ url: TEAM.url })).toContain('"$CLI" uninstall "$@"');
    expect(renderUninstallPs1({ url: TEAM.url })).toContain('& $cliPath uninstall @PassArgs');
  });
  it('refuses unsafe inputs (they end up in a shell script)', () => {
    expect(() => renderInstallSh({ ...TEAM, project: "x'; rm -rf ~" })).toThrow(/project/);
    expect(() => renderInstallSh({ ...TEAM, version: '1.2.3; curl evil' })).toThrow(/version/);
    expect(() => renderInstallSh({ ...TEAM, url: 'https://x.example.com/path' })).toThrow(/origin/);
    expect(() => renderInstallSh({ ...TEAM, cliSha256: "x'; evil" })).toThrow(/checksum/);
    expect(() => renderUninstallSh({ url: "https://x.example.com/'" })).toThrow(/origin/);
  });
  it('is valid POSIX sh (sh -n)', async () => {
    const dir = await tempDir();
    for (const [n, text] of [['a.sh', renderInstallSh(TEAM)], ['b.sh', renderInstallSh({ ...TEAM, project: null, cliSha256: null })], ['u.sh', renderUninstallSh({ url: TEAM.url })]] as const) {
      writeFileSync(path.join(dir, n), text);
      expect(spawnSync('sh', ['-n', path.join(dir, n)]).status).toBe(0);
    }
  });
});

/** A CliTarball over a fake package whose "npm pack" writes TGZ_BYTES (counts calls). */
async function fakeCli(version = '1.2.3') {
  const dir = await tempDir();
  const pkg = path.join(dir, 'pkg');
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'getmandate', version, bin: { mandate: 'dist/cli.js' } }));
  writeFileSync(path.join(pkg, 'dist', 'cli.js'), '// cli\n');
  let packs = 0;
  const pack: Packer = async (_dir, dest) => {
    packs++;
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(dest, `getmandate-${version}.tgz`), TGZ_BYTES + (packs > 1 ? `#${packs}` : ''));
    return `getmandate-${version}.tgz`;
  };
  const cache = path.join(dir, 'home', 'cache', 'cli');
  return { dir, pkg, cache, cli: new CliTarball({ dir: pkg, name: 'getmandate', version }, cache, pack), packs: () => packs };
}

describe('the CLI tarball', () => {
  it('finds the package (installed, or packages/cli in the repo; built only)', async () => {
    const f = await fakeCli();
    expect(findCliPackage({}, path.join(f.pkg, 'dist'))).toEqual({ dir: f.pkg, name: 'getmandate', version: '1.2.3' });
    const repo = await tempDir();
    mkdirSync(path.join(repo, 'packages', 'server', 'src', 'install'), { recursive: true });
    mkdirSync(path.join(repo, 'packages', 'cli'), { recursive: true });
    writeFileSync(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: 'getmandate', version: '0.1.0', bin: { mandate: 'dist/cli.js' } }));
    expect(findCliPackage({}, path.join(repo, 'packages', 'server', 'src', 'install'))).toBeNull(); // not built
    mkdirSync(path.join(repo, 'packages', 'cli', 'dist'));
    writeFileSync(path.join(repo, 'packages', 'cli', 'dist', 'cli.js'), '');
    expect(findCliPackage({}, path.join(repo, 'packages', 'server', 'src', 'install'))?.dir).toBe(path.join(repo, 'packages', 'cli'));
    expect(findCliPackage({ MANDATE_CLI_PACKAGE_DIR: f.pkg }, '/')?.dir).toBe(f.pkg);
  });

  it('packs once per build (concurrent requests share it), atomically into the cache; a rebuilt dist repacks', async () => {
    const f = await fakeCli();
    const [a, b] = await Promise.all([f.cli.get(), f.cli.get()]);
    expect(f.packs()).toBe(1);
    expect(a).toEqual(b);
    expect(a.sha256).toBe(TGZ_SHA);
    expect(readFileSync(a.path, 'utf8')).toBe(TGZ_BYTES);
    expect(path.dirname(a.path)).toBe(f.cache);
    expect((await f.cli.get()).path).toBe(a.path);
    // A second server process (fresh object) reuses the cached file.
    const again = new CliTarball(f.cli.pkg, f.cache, async () => { throw new Error('should not pack'); });
    expect((await again.get()).sha256).toBe(TGZ_SHA);
    // Rebuild: new fingerprint → new tarball, the old one is dropped.
    utimesSync(path.join(f.pkg, 'dist', 'cli.js'), new Date(), new Date(Date.now() + 5000));
    const c = await f.cli.get();
    expect(f.packs()).toBe(2);
    expect(c.path).not.toBe(a.path);
    expect(existsSync(a.path)).toBe(false);
  });
});

describe('routes', () => {
  const app = async (url: string, withCli = true) => {
    const a = Fastify();
    registerInstallRoutes(a, { url, version: '1.2.3', trustProxy: true, hostOk: (r) => r.headers.host !== 'evil.example', hasProject: (id) => id === 'web', cli: withCli ? (await fakeCli()).cli : null });
    return a;
  };
  const viaProxy = (proto: string) => ({ host: 'mandate.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': proto });

  it('served over HTTPS (no-store, shell type), refused over plain http; the checksum matches', async () => {
    const a = await app('https://mandate.example.com');
    const r = await a.inject({ url: '/p/web/install.sh', headers: viaProxy('https') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/x-shellscript/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain("MANDATE_PROJECT='web'");
    expect(r.body).toContain(`MANDATE_CLI_SHA256='${TGZ_SHA}'`);
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

  it('serves the CLI tarball and its checksum (same rules); 503 without a built CLI', async () => {
    const a = await app('https://mandate.example.com');
    const t = await a.inject({ url: '/getmandate.tgz', headers: viaProxy('https') });
    expect(t.statusCode).toBe(200);
    expect(t.headers['content-type']).toBe('application/gzip');
    expect(t.headers['x-mandate-version']).toBe('1.2.3');
    expect(t.body).toBe(TGZ_BYTES);
    expect((await a.inject({ url: '/getmandate.tgz.sha256', headers: viaProxy('https') })).body).toBe(`${TGZ_SHA}  getmandate.tgz\n`);
    expect((await a.inject({ url: '/getmandate.tgz', headers: viaProxy('http') })).statusCode).toBe(403);
    expect((await a.inject({ url: '/getmandate.tgz', headers: { ...viaProxy('https'), host: 'evil.example' } })).statusCode).toBe(403);
    const none = await app('https://mandate.example.com', false);
    expect((await none.inject({ url: '/getmandate.tgz', headers: viaProxy('https') })).statusCode).toBe(503);
    expect((await none.inject({ url: '/p/web/install.sh', headers: viaProxy('https') })).body).toContain("MANDATE_CLI_SHA256=''");
  });

  it('serves the uninstallers (+ checksums)', async () => {
    const a = await app('https://mandate.example.com');
    for (const kind of ['sh', 'ps1']) {
      const r = await a.inject({ url: `/uninstall.${kind}`, headers: viaProxy('https') });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('uninstall');
      expect((await a.inject({ url: `/uninstall.${kind}.sha256`, headers: viaProxy('https') })).body).toBe(`${sha256Hex(r.body)}  uninstall.${kind}\n`);
      expect((await a.inject({ url: `/uninstall.${kind}`, headers: viaProxy('http') })).statusCode).toBe(403);
    }
  });

  it('a Mandate on localhost: this machine only', async () => {
    const a = await app('http://localhost:4000');
    const ok = await a.inject({ url: '/p/web/install.sh', headers: { host: 'localhost:4000' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("MANDATE_URL='http://localhost:4000'");
    expect((await a.inject({ url: '/p/web/install.sh', headers: { host: 'localhost:4000' }, remoteAddress: '192.168.1.9' })).statusCode).toBe(403);
    expect((await a.inject({ url: '/getmandate.tgz', headers: { host: 'localhost:4000' }, remoteAddress: '192.168.1.9' })).statusCode).toBe(403);
  });
});

describe('a real run with stubbed npm and curl', () => {
  const realNode = process.execPath;
  const setup = async (o: { nodeMajor?: string; failGlobal?: boolean; tgz?: string } = {}) => {
    const dir = await tempDir();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'calls.log');
    const prefix = path.join(dir, 'npm-global');
    mkdirSync(prefix);
    const tgzSrc = path.join(dir, 'served.tgz');
    writeFileSync(tgzSrc, o.tgz ?? TGZ_BYTES);
    const sh = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    // node: the version probe is stubbed; the rest (sha256) is the real node.
    sh('node', `if [ "$1" = -p ]; then echo ${o.nodeMajor ?? process.versions.node.split('.')[0]}; else exec '${realNode}' "$@"; fi`);
    sh('curl', `echo "curl $*" >> '${log}'\nfor a; do out=$a; done\ncase "$*" in *.sha256*) echo "${TGZ_SHA}  getmandate.tgz" > "$out" ;; *) cp '${tgzSrc}' "$out" ;; esac`);
    // A fake installed CLI: logs its args; --version prints 1.2.3.
    const fakeCliBody = `case "$1" in --version) echo 1.2.3 ;; *) echo "getmandate $*" >> '${log}' ;; esac`;
    sh(
      'npm',
      `echo "npm $*" >> '${log}'
P='${prefix}'
case "$*" in *--prefix*) for a; do [ "$prev" = --prefix ] && P=$a; prev=$a; done ;; esac
case "$1" in
  prefix) echo "$P" ;;
  root) echo "$P/lib/node_modules" ;;
  install)
    case "$*" in *--prefix*) ;; *) ${o.failGlobal ? 'echo "npm error code EACCES" >&2; exit 243' : ':'} ;; esac
    mkdir -p "$P/bin" "$P/lib/node_modules/getmandate"
    printf '%s\\n' '#!/bin/sh' '${fakeCliBody.replace(/'/g, `'"'"'`)}' > "$P/bin/getmandate"
    chmod +x "$P/bin/getmandate" ;;
  uninstall) rm -rf "$P/bin/getmandate" "$P/lib/node_modules/getmandate" ;;
  exec) : ;;
esac`,
    );
    const home = path.join(dir, 'home');
    mkdirSync(home);
    const work = path.join(dir, 'work');
    mkdirSync(work);
    const run = (script: string, args: string[], cwd = work, extraPath = '') => {
      writeFileSync(path.join(dir, 'script.sh'), script);
      return spawnSync('sh', [path.join(dir, 'script.sh'), ...args], { cwd, encoding: 'utf8', env: { PATH: `${extraPath}${bin}:/usr/bin:/bin`, HOME: home }, input: '' });
    };
    // Lookups (npm prefix / root -g) are not interesting: only downloads, installs and CLI runs.
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((c) => c && !/^npm (prefix|root) -g$/.test(c)) : []);
    const reset = () => writeFileSync(log, '');
    return { dir, home, prefix, run, work, calls, reset, userPrefix: path.join(home, '.mandate', 'cli') };
  };
  const connectLine = (extra: string) => `getmandate connect --url https://mandate.example.com --project web ${extra}`;

  it('installs the CLI from the server (checksum-verified, npm install -g), then runs connect with the pass-through flags', async () => {
    const t = await setup();
    const r = t.run(renderInstallSh(TEAM), ['--agents', 'claude-code,codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('This will:');
    expect(r.stdout).toContain('GitHub sign-in on first use');
    expect(r.stdout).toContain(`sha256 ok (${TGZ_SHA})`);
    expect(r.stdout).toContain(`export PATH="${t.prefix}/bin:$PATH"`); // not on PATH: printed hint, no rc edits
    expect(r.stdout).toContain('/uninstall.sh | sh');
    const calls = t.calls();
    expect(calls[0]).toMatch(/^curl -fsSL https:\/\/mandate\.example\.com\/getmandate\.tgz -o /);
    expect(calls.some((c) => /^npm install -g --no-fund --no-audit --loglevel=error .*getmandate-1\.2\.3\.tgz$/.test(c))).toBe(true);
    expect(calls.at(-1)).toBe(connectLine('--no-repo --agents claude-code,codex'));
    expect(existsSync(path.join(t.prefix, 'bin', 'getmandate'))).toBe(true);
    // Re-run: this version is installed → no download, connect only; --reinstall forces it.
    t.reset();
    expect(t.run(renderInstallSh(TEAM), []).stdout).toContain('getmandate 1.2.3 is already installed');
    expect(t.calls()).toEqual([connectLine('--no-repo')]);
    t.reset();
    expect(t.run(renderInstallSh(TEAM), ['--reinstall']).status).toBe(0);
    expect(t.calls().some((c) => c.startsWith('npm install -g'))).toBe(true);
    expect(t.calls().at(-1)).toBe(connectLine('--no-repo'));
  });

  it('falls back to a per-user prefix when the global install fails (and keeps upgrading there)', async () => {
    const t = await setup({ failGlobal: true });
    const r = t.run(renderInstallSh(TEAM), ['--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('npm install -g failed');
    expect(r.stdout).toContain(`Installing for this user only, into ${t.userPrefix}`);
    expect(r.stdout).toContain(`export PATH="${t.userPrefix}/bin:$PATH"`);
    expect(existsSync(path.join(t.userPrefix, 'bin', 'getmandate'))).toBe(true);
    expect(t.calls().at(-1)).toBe(connectLine('--no-repo --yes'));
    t.reset();
    expect(t.run(renderInstallSh(TEAM), ['--reinstall']).status).toBe(0);
    expect(t.calls().filter((c) => c.startsWith('npm install'))).toEqual([expect.stringContaining(`--prefix ${t.userPrefix}`)]);
  });

  it('refuses a tarball whose checksum does not match (nothing installed); reads the .sha256 when not embedded', async () => {
    const bad = await setup({ tgz: 'tampered' });
    const r = bad.run(renderInstallSh(TEAM), []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum mismatch/);
    expect(bad.calls().some((c) => c.startsWith('npm install'))).toBe(false);
    const t = await setup();
    expect(t.run(renderInstallSh({ ...TEAM, cliSha256: null }), []).status).toBe(0);
    expect(t.calls()).toContain('curl -fsSL https://mandate.example.com/getmandate.tgz.sha256 -o ' + t.calls().find((c) => c.includes('.sha256'))!.split(' -o ')[1]);
  });

  it('inside a git repo with --yes: repo wiring too; --uninstall removes (with the installed CLI)', async () => {
    const t = await setup();
    execFileSync('git', ['init', '-q', t.work]);
    expect(t.run(renderInstallSh(TEAM), ['--yes']).status).toBe(0);
    expect(t.calls().at(-1)).toBe(connectLine('--repo --yes'));
    t.reset();
    expect(t.run(renderInstallSh(TEAM), ['--uninstall', '--yes']).status).toBe(0);
    expect(t.calls()).toEqual([connectLine('--repo --remove --yes')]);
  });

  it('--dry-run with no CLI installed: installs nothing, previews from the verified tarball (npm exec)', async () => {
    const t = await setup();
    const r = t.run(renderInstallSh(TEAM), ['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('(dry run) would install getmandate 1.2.3');
    expect(t.calls().some((c) => c.startsWith('npm install'))).toBe(false);
    expect(t.calls().at(-1)).toMatch(/^npm exec --yes --package=.*getmandate-1\.2\.3\.tgz -- getmandate connect --url https:\/\/mandate\.example\.com --project web --no-repo --dry-run$/);
  });

  it('refuses plain http unless --insecure; needs Node 22 (never installs it)', async () => {
    const t = await setup();
    const http = renderInstallSh({ ...TEAM, url: 'http://mandate.example.com' });
    const r = t.run(http, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing plain http/);
    expect(t.run(http, ['--insecure']).status).toBe(0);
    const old = await setup({ nodeMajor: '18' });
    const o = old.run(renderInstallSh(TEAM), []);
    expect(o.status).toBe(1);
    expect(o.stdout).toMatch(/Node\.js 22 or newer/);
    expect(old.calls()).toEqual([]); // nothing downloaded or installed
  });

  it('uninstall.sh: nothing installed → says so; else getmandate uninstall (flags pass through), then removes the CLI', async () => {
    const t = await setup();
    const none = t.run(renderUninstallSh({ url: TEAM.url }), []);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('getmandate is not installed');
    // Global install.
    t.run(renderInstallSh(TEAM), []);
    t.reset();
    // getmandate is found on PATH once its folder is on PATH (the way the installer's hint says).
    const onPath = `${t.prefix}/bin:`;
    const dry = t.run(renderUninstallSh({ url: TEAM.url }), ['--dry-run'], t.work, onPath);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('(dry run) would run: npm uninstall -g getmandate');
    expect(existsSync(path.join(t.prefix, 'bin', 'getmandate'))).toBe(true);
    t.reset();
    const u = t.run(renderUninstallSh({ url: TEAM.url }), ['--purge', '--yes'], t.work, onPath);
    expect(u.status, u.stderr).toBe(0);
    expect(t.calls()).toEqual(['getmandate uninstall --purge --yes', 'npm uninstall -g --loglevel=error getmandate']);
    expect(existsSync(path.join(t.prefix, 'bin', 'getmandate'))).toBe(false);
    // Per-user install.
    const f = await setup({ failGlobal: true });
    f.run(renderInstallSh(TEAM), []);
    f.reset();
    const v = f.run(renderUninstallSh({ url: TEAM.url }), []);
    expect(v.status, v.stderr).toBe(0);
    expect(f.calls()[0]).toBe('getmandate uninstall');
    expect(v.stdout).toContain(`Removed the getmandate CLI (${f.userPrefix})`);
    expect(existsSync(f.userPrefix)).toBe(false);
  });
});
