/** start / stop / restart / status / logs / open / setup-url / update / doctor. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watchFile } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { bool, str, type Args } from './args.js';
import { supervise } from './supervisor.js';
import { BIN, configFile, envFile, keysFile, logFile, PKG_NAME, PKG_ROOT, PKG_VERSION, SERVER_ENTRY, type Ctx } from './context.js';
import { currentService, platformService, serviceSpec, type ServiceManager } from './service.js';
import { health, setupState, setupUrl, waitHealthy } from './serverlink.js';
import { readSettings, savePort, type CurrentSettings } from './settings.js';
import { c, fail, info, ok, spinner, warn, type Out } from './ui.js';
import { AGENTS, detectAgents, envVarFor } from './agents.js';
import { listProjects, rcFiles } from './wiring.js';
import { sshTunnel } from './proxy.js';
import { cleanRuns, expiredRuns } from './bootstrap.js';
import { inventory } from './inventory.js';

export const spec = (ctx: Ctx, entry = SERVER_ENTRY) => () => serviceSpec(ctx, entry, PKG_VERSION);
export const service = (ctx: Ctx): ServiceManager => currentService(ctx, spec(ctx));

/** Open a URL in the default browser (best effort). */
export function openBrowser(ctx: Ctx, url: string): boolean {
  if (ctx.env.MANDATE_NO_BROWSER) return false;
  const cmd = ctx.platform === 'darwin' ? 'open' : ctx.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = ctx.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  if (ctx.platform === 'linux' && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) return false;
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ start / stop / restart */

export async function cmdStart(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const port = str(a, 'port');
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      out.err(fail(`invalid --port ${port}`));
      return 1;
    }
    // Saved so every later command (setup-url, open, status) and service restarts use the same port.
    savePort(ctx, n);
    ctx.env.MANDATE_PORT = port;
  }
  // Expired bootstrap notes are removed on every start.
  try {
    cleanRuns(ctx);
  } catch {
    /* never blocks start */
  }
  if (bool(a, 'foreground')) {
    if (!existsSync(SERVER_ENTRY)) {
      out.err(fail(`no bundled server at ${SERVER_ENTRY} (run from source? use npm run dev)`));
      return 1;
    }
    if (ctx.env.MANDATE_PORT) process.env.MANDATE_PORT = ctx.env.MANDATE_PORT;
    process.env.MANDATE_HOME = ctx.mandateHome;
    process.env.MANDATE_VERSION ??= PKG_VERSION;
    process.env.NODE_ENV ??= 'production';
    const s = readSettings(ctx);
    out.log(info(`Mandate ${PKG_VERSION} in the foreground on ${s.url} ${c.dim('(Ctrl-C to stop)')}`));
    // The server runs as a child so it can restart itself (exit 75 after an address change); output stays on this terminal.
    return supervise({ node: process.execPath, entry: SERVER_ENTRY, env: process.env, log: (m) => out.log(info(m)) });
  }
  const s = readSettings(ctx);
  const svc = service(ctx);
  // `force` (install): a freshly written service definition must (re)start even if an old server still answers.
  if (!bool(a, 'force') && (await health(s.localUrl))?.ok) {
    out.log(ok(`already running on ${s.url}`));
    return 0;
  }
  if (bool(a, 'force') && svc.kind !== 'process') await new Promise((r) => setTimeout(r, 500));
  const sp = spinner(`starting Mandate (${svc.kind})`, out);
  try {
    svc.start();
  } catch (e) {
    sp.fail(`could not start: ${(e as Error).message}`);
    return 1;
  }
  const h = await waitHealthy(s.localUrl, 30_000);
  if (!h) {
    sp.fail(`not healthy on ${s.localUrl} after 30 s; see ${c.bold(`${BIN} logs`)}`);
    return 1;
  }
  sp.succeed(`running on ${c.bold(s.url)} ${c.dim(`(${svc.kind}, v${h.version ?? '?'})`)}`);
  return 0;
}

export async function cmdStop(ctx: Ctx, _a: Args, out: Out): Promise<number> {
  const svc = service(ctx);
  try {
    svc.stop();
  } catch (e) {
    out.err(fail((e as Error).message));
    return 1;
  }
  const s = readSettings(ctx);
  for (let i = 0; i < 30 && (await health(s.localUrl, 500)); i++) await new Promise((r) => setTimeout(r, 200));
  if (await health(s.localUrl, 500)) {
    out.log(warn(`stopped the ${svc.kind} service, but something still answers on ${s.localUrl} (a foreground or dev server?)`));
    return 1;
  }
  out.log(ok('stopped'));
  return 0;
}

export async function cmdRestart(ctx: Ctx, a: Args, out: Out): Promise<number> {
  if (bool(a, 'reinstall')) {
    const p = platformService(ctx);
    if (p?.installed()) p.install(serviceSpec(ctx, SERVER_ENTRY, PKG_VERSION));
  }
  const svc = service(ctx);
  if (svc.kind === 'process') await cmdStop(ctx, a, { log: () => undefined, err: () => undefined });
  return cmdStart(ctx, { ...a, flags: { ...a.flags, foreground: false } }, out);
}

/* ------------------------------------------------------------------ status */

export interface Status {
  version: string;
  serverVersion: string | null;
  running: boolean;
  service: string;

  url: string;
  port: number;
  bind: string;
  publicUrl: string | null;
  projects: number;
  setup: 'complete' | 'pending';
  home: string;
}

export async function getStatus(ctx: Ctx): Promise<Status> {
  const s = readSettings(ctx);
  const svc = service(ctx);
  const h = await health(s.localUrl);
  return {
    version: PKG_VERSION,
    serverVersion: h?.version ?? null,
    running: !!h?.ok,
    service: svc.kind === 'process' ? 'none (detached process / foreground)' : `${svc.kind} (${svc.installed() ? 'installed' : 'not installed'})`,
    url: s.url,
    port: s.port,
    bind: s.bind,
    publicUrl: s.publicUrl ?? null,
    projects: listProjects(ctx).length,
    setup: setupState(ctx).complete() ? 'complete' : 'pending',
    home: ctx.mandateHome,
  };
}

export async function cmdStatus(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const st = await getStatus(ctx);
  if (bool(a, 'json')) {
    out.log(JSON.stringify(st, null, 2));
    return st.running ? 0 : 3;
  }
  const row = (k: string, v: string) => out.log(`  ${c.dim(k.padEnd(10))} ${v}`);
  out.log(c.bold('Mandate'));
  row('state', st.running ? c.green('● running') : c.red('○ stopped'));
  row('version', `${st.version}${st.serverVersion && st.serverVersion !== st.version ? c.yellow(` (server ${st.serverVersion}; run ${BIN} restart)`) : ''}`);
  row('sign-in', 'GitHub');
  row('url', st.url);
  row('listen', `${st.bind}:${st.port}`);
  row('service', st.service);
  row('projects', String(st.projects));
  row('setup', st.setup === 'complete' ? c.green('complete') : c.yellow(`pending (${BIN} open)`));
  row('home', st.home);
  if (!st.running) out.log(`\n${info(`start it with ${c.bold(`${BIN} start`)}`)}`);
  return st.running ? 0 : 3;
}

/* ------------------------------------------------------------------ logs */

export async function cmdLogs(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const file = logFile(ctx);
  if (!existsSync(file)) {
    out.log(info(`no log yet at ${file} (the service writes it; a foreground server logs to the terminal)`));
    return 0;
  }
  const n = Number(str(a, 'lines') ?? 80);
  const text = readFileSync(file, 'utf8');
  out.log(text.split('\n').slice(-(n + 1)).join('\n').replace(/\n$/, ''));
  if (!bool(a, 'follow')) return 0;
  let pos = statSync(file).size;
  watchFile(file, { interval: 300 }, (cur) => {
    if (cur.size < pos) pos = 0;
    if (cur.size === pos) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf.toString('utf8'));
  });
  return -1;
}

/* ------------------------------------------------------------------ open / setup-url */

/** The URL to open: the setup wizard while setup is pending, else the UI (sign-in is GitHub). */
export async function entryUrl(ctx: Ctx, s: CurrentSettings): Promise<{ url: string; kind: 'setup' | 'ui' }> {
  const setup = setupUrl(ctx, s);
  if (setup) return { url: setup, kind: 'setup' };
  return { url: s.url, kind: 'ui' };
}

export async function cmdOpen(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const s = readSettings(ctx);
  if (!(await health(s.localUrl))?.ok) {
    out.err(fail(`Mandate is not running on ${s.localUrl}; run ${c.bold(`${BIN} start`)}`));
    return 1;
  }
  const e = await entryUrl(ctx, s);
  const what = e.kind === 'setup' ? 'setup wizard' : 'Mandate';
  if (s.publicUrl && e.kind === 'setup') {
    printTunnel(s, e.url, out, str(a, 'ssh'));
    return 0;
  }
  if (bool(a, 'print') || !openBrowser(ctx, e.url)) out.log(info(`${what}: ${e.url}`));
  else out.log(ok(`opened the ${what} in your browser`));
  return 0;
}

export function printTunnel(s: CurrentSettings, url: string, out: Out, sshTarget?: string): void {
  out.log(c.bold('One-time setup link'));
  out.log(`  Safe way in before HTTPS is set up: an SSH tunnel from your computer:`);
  out.log(`    ${c.cyan(sshTunnel(s.port, sshTarget))}`);
  out.log(`  then open ${c.cyan(url)}`);
  if (s.publicUrl?.startsWith('https://')) out.log(c.dim(`  Once HTTPS works, the same link also works at ${url.replace(`http://localhost:${s.port}`, s.publicUrl)}`));
}

export async function cmdSetupUrl(ctx: Ctx, _a: Args, out: Out): Promise<number> {
  const s = readSettings(ctx);
  const url = setupUrl(ctx, s);
  if (!url) {
    out.log(ok(`setup is complete; open Mandate with ${c.bold(`${BIN} open`)}`));
    return 0;
  }
  out.log(url);
  return 0;
}

/* ------------------------------------------------------------------ update */

export async function cmdUpdate(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const target = str(a, 'from') ?? `${PKG_NAME}@latest`;
  const sp = spinner(`npm install -g ${target}`, out);
  const r = spawnSync('npm', ['install', '-g', target], { encoding: 'utf8', env: ctx.env });
  if (r.status !== 0) {
    sp.fail(`npm install -g ${target} failed`);
    out.err((r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n'));
    return 1;
  }
  sp.succeed(`installed ${target}`);
  // Restart with the NEW code (it rewrites the service definition first).
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', env: ctx.env }).stdout.trim();
  const cli = path.join(root, PKG_NAME, 'dist', 'cli.js');
  const rr = spawnSync(process.execPath, [existsSync(cli) ? cli : path.join(PKG_ROOT, 'dist', 'cli.js'), 'restart', '--reinstall'], { stdio: 'inherit', env: ctx.env });
  return rr.status ?? 1;
}

/* ------------------------------------------------------------------ doctor */

interface Check {
  label: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export async function cmdDoctor(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const checks: Check[] = [];
  const add = (label: string, level: Check['level'], detail: string, fix?: string) => checks.push({ label, level, detail, ...(fix ? { fix } : {}) });
  const s = readSettings(ctx);

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 22 ? 'ok' : 'fail', process.versions.node, major >= 22 ? undefined : 'install Node.js 22 or newer');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', git.status === 0 ? 'ok' : 'warn', git.status === 0 ? git.stdout.trim() : 'not found', git.status === 0 ? undefined : 'install git to push projects with your own credentials');

  const req = createRequire(path.join(PKG_ROOT, 'package.json'));
  for (const m of ['better-sqlite3', 'sqlite-vec', 'es-git']) {
    try {
      req(m);
      add(`native: ${m}`, 'ok', 'loads');
    } catch (e) {
      add(`native: ${m}`, 'fail', (e as Error).message.split('\n')[0]!, `reinstall: npm install -g ${PKG_NAME}`);
    }
  }

  if (existsSync(ctx.mandateHome)) {
    const mode = statSync(ctx.mandateHome).mode & 0o777;
    add('data folder', mode & 0o077 ? 'warn' : 'ok', `${ctx.mandateHome} (${mode.toString(8)})`, mode & 0o077 ? `chmod 700 ${ctx.mandateHome}` : undefined);
  } else add('data folder', 'fail', `${ctx.mandateHome} missing`, `run ${BIN} install`);
  if (existsSync(keysFile(ctx))) {
    const mode = statSync(keysFile(ctx)).mode & 0o777;
    add('agent keys', mode & 0o077 ? 'fail' : 'ok', `${keysFile(ctx)} (${mode.toString(8)})`, mode & 0o077 ? `chmod 600 ${keysFile(ctx)}` : undefined);
  }
  try {
    const { readConfigFile } = await import('../../server/src/config.js');
    readConfigFile(configFile(ctx), { ...ctx.env, MANDATE_HOME: ctx.mandateHome });
    add('config', 'ok', `${configFile(ctx)} (${s.url}; GitHub sign-in)`);
  } catch (e) {
    add('config', 'fail', (e as Error).message.split('\n').slice(0, 3).join(' '), `fix ${configFile(ctx)}`);
  }

  const svc = service(ctx);
  add('service', svc.kind === 'process' ? 'warn' : svc.running() ? 'ok' : 'warn', svc.kind === 'process' ? 'no launchd/systemd service installed' : `${svc.kind}: ${svc.running() ? 'running' : 'not running'} (${svc.file})`, svc.kind === 'process' ? `${BIN} install` : svc.running() ? undefined : `${BIN} start`);
  const h = await health(s.localUrl);
  if (h?.ok) {
    add('server', h.version === PKG_VERSION ? 'ok' : 'warn', `healthy on ${s.localUrl} (v${h.version})`, h.version === PKG_VERSION ? undefined : `${BIN} restart (server runs ${h.version}, CLI is ${PKG_VERSION})`);
    try {
      const r = await fetch(`${s.localUrl}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(3000) });
      const html = (await r.text()).includes('<div id="root"');
      add('web UI', r.ok && html ? 'ok' : 'warn', r.ok && html ? 'served' : `GET / → ${r.status}`);
    } catch (e) {
      add('web UI', 'warn', (e as Error).message);
    }
    add('setup', setupState(ctx).complete() ? 'ok' : 'warn', setupState(ctx).complete() ? 'complete' : 'not finished', `${BIN} open`);
  } else {
    const busy = await fetch(s.localUrl, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    add('server', 'fail', busy ? `port ${s.port} answers but not as Mandate` : `not reachable on ${s.localUrl}`, busy ? `free port ${s.port} or set server.port in ${configFile(ctx)}` : `${BIN} start, then ${BIN} logs`);
  }

  if (s.publicUrl) {
    {
      const { serverChecks } = await import('../../server/src/setup/probes.js');
      for (const ch of await serverChecks(s.publicUrl)) add(ch.label, ch.ok ? (ch.level === 'warning' ? 'warn' : 'ok') : ch.level === 'warning' ? 'warn' : 'fail', ch.detail, ch.fix);
    }
  }

  const agents = detectAgents(ctx);
  add('coding agents', agents.length ? 'ok' : 'warn', agents.length ? agents.map((x) => x.label).join(', ') : 'none detected', agents.length ? undefined : `install one, then ${BIN} install --agents-only`);
  for (const r of inventory(ctx, agents)) {
    const want = (['skills', 'commands'] as const).filter((k) => r.supports[k] === 'verified');
    const missing = [...(want.includes('skills') && !r.installed.skills.length ? ['skills'] : []), ...(want.includes('commands') && !r.installed.commands.length ? ['commands'] : [])];
    add(`  ${r.label}`, missing.length ? 'warn' : 'ok', `MCP ${r.installed.mcp.join(', ') || '-'} · skills ${r.installed.skills.length} · commands ${r.installed.commands.join(' ') || '-'}`, missing.length ? `${BIN} install --agents-only --agents ${r.id}` : undefined);
  }
  const projects = listProjects(ctx);
  if (projects.length) {
    add('agent env', existsSync(envFile(ctx)) ? 'ok' : 'warn', existsSync(envFile(ctx)) ? envFile(ctx) : 'env.sh missing', existsSync(envFile(ctx)) ? undefined : `${BIN} install --agents-only`);
    const missing = projects.filter((p) => !ctx.env[envVarFor(p.id)]).map((p) => envVarFor(p.id));
    const rcs = rcFiles(ctx);
    add('key env vars', missing.length ? 'warn' : 'ok', missing.length ? `not set in this shell: ${missing.join(', ')}` : 'set', missing.length ? `open a new terminal${rcs.length ? '' : `, or add: . ${envFile(ctx)} to your shell profile`}` : undefined);
  }

  // Integrity lint per project (read-only): errors and reference-gap warnings, each with its suggested fix.
  if (projects.length) {
    const { projectIntegrity } = await import('../../server/src/storage/doctor.js');
    for (const p of projects) {
      try {
        const r = await projectIntegrity({ dataDir: p.dataDir });
        if (!r) continue;
        const warnings = r.issues.filter((i) => i.severity === 'warning').length;
        add(`integrity: ${p.id}`, r.issues.length ? 'warn' : 'ok', r.issues.length ? `${r.issues.length} issue(s), ${warnings} of them warnings` : 'no issues');
        for (const i of r.issues.slice(0, 12)) add(`  ${i.rule}`, 'warn', i.message, i.hint);
        if (r.issues.length > 12) add('  …', 'warn', `${r.issues.length - 12} more`, 'see git_status in your coding agent, or the sidebar');
      } catch (e) {
        add(`integrity: ${p.id}`, 'warn', `cannot lint: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  const expired = expiredRuns(ctx);
  if (bool(a, 'clean')) {
    const removed = cleanRuns(ctx);
    add('bootstrap notes', 'ok', removed.length ? `removed ${removed.length} expired run(s)` : 'nothing past its retention');
  } else if (expired.length) add('bootstrap notes', 'warn', `${expired.length} finished run(s) past their retention`, `${BIN} doctor --clean`);

  if (bool(a, 'json')) {
    out.log(JSON.stringify(checks, null, 2));
  } else {
    for (const ch of checks) {
      const line = `${ch.label}: ${ch.detail}`;
      out.log(ch.level === 'ok' ? ok(line) : ch.level === 'warn' ? warn(line) : fail(line));
      if (ch.fix && ch.level !== 'ok') out.log(`    ${c.dim('→')} ${ch.fix}`);
    }
  }
  return checks.some((x) => x.level === 'fail') ? 1 : 0;
}

export { AGENTS };
