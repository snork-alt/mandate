/**
 * End-to-end smoke test of the publishable package, in a temp HOME (never the real one):
 *   npm pack → npx <tarball> install --yes --no-service --no-open (global install into a temp npm prefix)
 *   → mandate start --foreground on a free port with a temp MANDATE_HOME → /health → the UI index and an asset
 *   → mandate status → stop. Also checks that native modules came from prebuilt binaries (no compiler).
 * Usage: npm run build && npm run smoke -w getmandate   (SMOKE_PORT, default 4300; SMOKE_KEEP=1 keeps the temp dir)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SMOKE_PORT ?? 4300);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mandate-smoke-'));
const home = path.join(tmp, 'home');
const prefix = path.join(tmp, 'prefix');
const work = path.join(tmp, 'work');
for (const d of [home, prefix, work]) mkdirSync(d, { recursive: true });

const log = (s) => console.log(`[smoke] ${s}`);
const realCache = execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8', cwd: os.tmpdir() }).trim();
const env = {
  PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}`,
  HOME: home,
  MANDATE_HOME: path.join(home, '.mandate'),
  MANDATE_PORT: String(port),
  MANDATE_NO_BROWSER: '1',
  npm_config_prefix: prefix,
  npm_config_cache: realCache,
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  NO_COLOR: '1',
};
let server;
let failed = false;

async function main() {
  // Port must be free (never touch other servers).
  const busy = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is in use; set SMOKE_PORT`);

  if (!existsSync(path.join(pkgDir, 'dist', 'cli.js'))) throw new Error('dist missing: run npm run build first');
  log('npm pack');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: pkgDir, encoding: 'utf8' }));
  const tarball = path.join(tmp, packed[0].filename);
  log(`${packed[0].filename}: ${(packed[0].size / 1e6).toFixed(1)} MB packed, ${packed[0].entryCount} files`);

  log('npx <tarball> install --yes --no-service --no-open');
  execFileSync('npx', ['--yes', `file:${tarball}`, 'install', '--yes', '--no-service', '--no-open'], {
    cwd: work,
    env: { ...env, MANDATE_INSTALL_SPEC: tarball },
    stdio: 'inherit',
  });
  const bin = path.join(prefix, 'bin', 'mandate');
  if (!existsSync(bin)) throw new Error(`global install missing: ${bin}`);
  const installed = path.join(prefix, 'lib', 'node_modules', JSON.parse(execFileSync('node', ['-p', `JSON.stringify(require('${path.join(pkgDir, 'package.json')}').name)`], { encoding: 'utf8' })));
  const bs = path.join(installed, 'node_modules', 'better-sqlite3');
  if (existsSync(path.join(bs, 'build'))) throw new Error('better-sqlite3 was compiled from source (expected a prebuilt binary)');
  log(`prebuilt natives: better-sqlite3 prebuilds/${readdirSync(path.join(bs, 'prebuilds')).find((f) => f.startsWith(`${process.platform}-${process.arch}`))}`);

  log(`mandate start --foreground (port ${port})`);
  server = spawn(bin, ['start', '--foreground'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => (output += d));
  server.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 30_000;
  let health;
  while (Date.now() < deadline) {
    health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null);
    if (health?.ok) break;
    if (server.exitCode !== null) throw new Error(`server exited:\n${output.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!health?.ok) throw new Error(`no /health after 30 s:\n${output.slice(-2000)}`);
  log(`/health ok (version ${health.version})`);

  const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/html' } });
  const html = await index.text();
  if (!index.ok || !html.includes('<div id="root"')) throw new Error(`UI index not served (${index.status})`);
  // The asset body is deliberately left unread: shutdown must still finish (5 s deadline in the server).
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const a = asset ? await fetch(`http://127.0.0.1:${port}${asset}`) : null;
  if (!a?.ok || !/immutable/.test(a.headers.get('cache-control') ?? '')) throw new Error(`asset ${asset} not served as immutable`);
  const spa = await fetch(`http://127.0.0.1:${port}/p/default/specs`, { headers: { accept: 'text/html' } });
  if (!(await spa.text()).includes('<div id="root"')) throw new Error('SPA fallback failed');
  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
  await mcp.arrayBuffer();
  if (mcp.status !== 401) throw new Error(`/mcp should require a key (got ${mcp.status})`);
  log('UI index, hashed asset, SPA fallback and /mcp auth ok');

  const status = JSON.parse(execFileSync(bin, ['status', '--json'], { env, encoding: 'utf8' }));
  if (!status.running || status.port !== port) throw new Error(`status: ${JSON.stringify(status)}`);
  log(`mandate status: running, mode ${status.mode}, setup ${status.setup}, ${status.projects} project(s)`);
}

try {
  await main();
  log('PASS');
} catch (e) {
  failed = true;
  console.error(`[smoke] FAIL: ${e.message}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    const t0 = Date.now();
    const exited = await Promise.race([new Promise((r) => server.once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 15_000))]);
    if (!exited) {
      server.kill('SIGKILL');
      failed = true;
      console.error('[smoke] FAIL: the server did not exit within 15 s of SIGTERM');
    } else log(`server stopped (${Date.now() - t0} ms after SIGTERM)`);
  }
  if (!process.env.SMOKE_KEEP) rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
