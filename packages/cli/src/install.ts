/** `mandate install` (idempotent) and `mandate uninstall`. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { bool, str, type Args } from './args.js';
import { AGENTS, agentById, can, commandChanges, projectCommandChanges, detectAgents, makeServer, mandateServersIn, mcpRemove, mcpUpsert, skillChanges, type AgentDef } from './agents.js';
import { cmdStart, entryUrl, openBrowser, printTunnel, service } from './commands.js';
import { BIN, envFile, expand, manifestFile, PKG_NAME, PKG_ROOT, PKG_VERSION, SERVER_ENTRY, type Ctx } from './context.js';
import { applyChanges, JsoncError, type Change } from './edits.js';
import { caddySnippet, nginxSnippet } from './proxy.js';
import { platformService, serviceSpec } from './service.js';
import { health, waitHealthy } from './serverlink.js';
import { DEFAULT_BASE_DIR, publicUrlProblem, readSettings, writeSettings, type Mode, type ServerSettings } from './settings.js';
import { c, fail, info, ok, Prompter, spinner, step, warn, type Out } from './ui.js';
import { envChange, instructionFiles, KNOWN_INSTRUCTION_FILES, listProjects, projectKeys, rcChanges, readManifest, sectionChange, writeManifest } from './wiring.js';

export interface Runtime {
  ctx: Ctx;
  out: Out;
  prompt: Prompter;
  dryRun: boolean;
}

/* ------------------------------------------------------------------ mode */

export async function chooseSettings(rt: Runtime, a: Args): Promise<ServerSettings> {
  const cur = readSettings(rt.ctx);
  const flagMode = str(a, 'mode') as Mode | undefined;
  if (flagMode && flagMode !== 'local' && flagMode !== 'server') throw new Error('--mode must be local or server');
  const mode: Mode =
    flagMode ??
    (cur.configured && !rt.prompt.interactive
      ? cur.mode
      : await rt.prompt.select(
          'Are you setting Mandate up on this machine (local) or on a remote server?',
          [
            { value: 'local', label: 'On this machine (local)', hint: 'Projects are git repos in a folder (~/mandate); you sign in from this computer. No GitHub needed.' },
            { value: 'server', label: 'On a remote server', hint: 'Teammates sign in with GitHub; projects come from GitHub repos. Needs a public URL (HTTPS).' },
          ],
          cur.configured ? cur.mode : 'local',
        ));
  const port = Number(str(a, 'port') ?? cur.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1..65535');
  if (mode === 'local') return { mode, port, bind: '127.0.0.1', trustProxy: false, baseDir: cur.configured && cur.mode === 'local' ? cur.baseDir : DEFAULT_BASE_DIR };

  let publicUrl = str(a, 'public-url') ?? (cur.mode === 'server' ? cur.publicUrl : undefined);
  if (!publicUrl || (rt.prompt.interactive && !str(a, 'public-url'))) publicUrl = await rt.prompt.input('Public URL (e.g. https://mandate.example.com):', publicUrl ?? '', publicUrlProblem);
  if (!publicUrl) throw new Error('server mode needs --public-url https://mandate.example.com');
  const problem = publicUrlProblem(publicUrl);
  if (problem) throw new Error(`--public-url: ${problem}`);
  const proxyFlag = a.flags['behind-proxy'];
  const behind = proxyFlag !== undefined ? proxyFlag === true || proxyFlag === 'true' : await rt.prompt.confirm('Behind a reverse proxy (Caddy / nginx) that terminates HTTPS? (recommended)', true);
  const bind = str(a, 'bind') ?? (behind ? '127.0.0.1' : '0.0.0.0');
  return { mode, port, bind, publicUrl: new URL(publicUrl).origin, trustProxy: behind };
}

/* ------------------------------------------------------------------ agents (user scope) */

export function pickAgents(ctx: Ctx, a: Args): AgentDef[] {
  if (bool(a, 'all')) return AGENTS;
  const list = str(a, 'agents');
  if (list) return list.split(',').map((id) => agentById(id.trim()) ?? (() => { throw new Error(`unknown agent '${id}' (${AGENTS.map((x) => x.id).join(', ')})`); })());
  return detectAgents(ctx);
}

/** User-scope wiring: the master skill, /mandate-flow, MCP entries for every project (env-var keys), env.sh, shell rc hook. */
export function userWiringChanges(ctx: Ctx, agents: AgentDef[], baseUrl: string): { changes: (Change | null)[]; skipped: string[] } {
  const changes: (Change | null)[] = [];
  const skipped: string[] = [];
  changes.push(...skillChanges(ctx, agents), ...commandChanges(ctx, agents));
  const projects = listProjects(ctx).map((p) => p.id);
  if (projects.length) {
    const keys = projectKeys(ctx, projects);
    for (const ag of agents) {
      const t = ag.userMcp?.(ctx);
      if (!t || !can(ag, 'mcp', ctx.force)) {
        if (ag.caps.mcp === 'unverified' && t) skipped.push(`${ag.label}: MCP config location is unverified; not written (use --force to write ${t.file})`);
        continue;
      }
      try {
        // Agents without env-var expansion get the key itself, in their user-scope file only (never in a repo).
        changes.push(mcpUpsert(ag, t, ...projects.map((id) => ({ ...makeServer(baseUrl, id), ...(ag.envSyntax === null ? { key: keys.get(id) } : {}) }))));
      } catch (e) {
        skipped.push(e instanceof JsoncError ? `${ag.label}: ${e.message}; add the mandate-<project> servers by hand (${BIN} connect prints them)` : `${ag.label}: ${(e as Error).message}`);
      }
    }
    changes.push(envChange(ctx, keys), ...rcChanges(ctx));
  }
  return { changes, skipped };
}

export function wireAgents(rt: Runtime, agents: AgentDef[], baseUrl: string): number {
  let changes: (Change | null)[];
  let skipped: string[];
  try {
    ({ changes, skipped } = userWiringChanges(rt.ctx, agents, baseUrl));
  } catch (e) {
    rt.out.log(warn((e as Error).message));
    return 0;
  }
  for (const s of skipped) rt.out.log(warn(s));
  const applied = applyChanges(changes, { dryRun: rt.dryRun, out: rt.out, home: rt.ctx.home });
  if (!applied.length) rt.out.log(ok('agent wiring is up to date'));
  for (const ag of agents) if (ag.note) rt.out.log(c.dim(`  ${ag.label}: ${ag.note}`));
  return applied.length;
}

/* ------------------------------------------------------------------ global install */

function runningViaNpx(ctx: Ctx): boolean {
  return /[\\/]_npx[\\/]/.test(PKG_ROOT) || (ctx.env.npm_command === 'exec' && !ctx.env.VITEST);
}

function globalRoot(ctx: Ctx): string | null {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', env: ctx.env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Install this exact version globally when run through npx; returns the server entry the service should run. */
async function ensureGlobal(rt: Runtime, a: Args): Promise<string> {
  const root = globalRoot(rt.ctx);
  const globalEntry = root ? path.join(root, PKG_NAME, 'dist', 'server.js') : null;
  if (!runningViaNpx(rt.ctx)) return SERVER_ENTRY;
  if (a.flags.global === false) {
    rt.out.log(info(`skipping the global install (--no-global); the \`${BIN}\` command needs: npm install -g ${PKG_NAME}@${PKG_VERSION}`));
    return SERVER_ENTRY;
  }
  const spec = rt.ctx.env.MANDATE_INSTALL_SPEC || `${PKG_NAME}@${PKG_VERSION}`;
  if (!(await rt.prompt.confirm(`Install the \`${BIN}\` command globally (npm install -g ${spec})?`, true))) {
    rt.out.log(info(`skipped; run it later: npm install -g ${spec}`));
    return SERVER_ENTRY;
  }
  if (rt.dryRun) {
    rt.out.log(`  ${c.dim('would run')} npm install -g ${spec}`);
    return globalEntry ?? SERVER_ENTRY;
  }
  const sp = spinner(`npm install -g ${spec}`, rt.out);
  const r = spawnSync('npm', ['install', '-g', spec], { encoding: 'utf8', env: rt.ctx.env });
  if (r.status !== 0) {
    sp.warn(`npm install -g ${spec} failed; continuing from the npx copy`);
    rt.out.log(c.dim((r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n')));
    rt.out.log(info(`retry later: npm install -g ${spec}  (permissions? see https://docs.npmjs.com/resolving-eacces-permissions-errors)`));
    return SERVER_ENTRY;
  }
  sp.succeed(`installed ${c.bold(BIN)} globally`);
  return globalEntry && existsSync(globalEntry) ? globalEntry : SERVER_ENTRY;
}

/* ------------------------------------------------------------------ install */

export async function cmdInstall(rt: Runtime, a: Args): Promise<number> {
  const { ctx, out } = rt;
  const TOTAL = 7;
  out.log(`\n${c.bold(c.magenta('Mandate'))} ${c.dim(`v${PKG_VERSION}`)} ${c.dim('— specifications for coding agents')}\n`);

  if (bool(a, 'agents-only')) {
    const s = readSettings(ctx);
    wireAgents(rt, pickAgents(ctx, a), s.url);
    return 0;
  }

  // 1. Mode (decides how the server binds, before anything is reachable).
  out.log(step(1, TOTAL, 'Mode'));
  const settings = await chooseSettings(rt, a);
  out.log(ok(settings.mode === 'local' ? `local: this machine only (127.0.0.1:${settings.port})` : `server: ${settings.publicUrl} → listening on ${settings.bind}:${settings.port}${settings.trustProxy ? ' behind a reverse proxy' : ''}`));
  if (settings.mode === 'server' && settings.publicUrl!.startsWith('http://')) {
    out.log(warn(c.bold('The public URL is plain http: sign-in cookies and agent keys would travel unencrypted. Use HTTPS (see the proxy snippets below).')));
  }

  // 2. Prerequisites.
  out.log(step(2, TOTAL, 'Prerequisites'));
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    out.err(fail(`Node.js ${process.versions.node}: Mandate needs Node.js 22 or newer`));
    return 1;
  }
  out.log(ok(`Node.js ${process.versions.node}`));
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status === 0) out.log(ok(git.stdout.trim()));
  else out.log(warn(settings.mode === 'local' ? 'git not found: Mandate works without it, but install git to push projects with your own credentials' : 'git not found (optional; the embedded git is used)'));

  // 3. Global command.
  out.log(step(3, TOTAL, 'The mandate command'));
  const entry = await ensureGlobal(rt, a);
  if (!runningViaNpx(ctx)) out.log(ok(`${BIN} ${PKG_VERSION} (${PKG_ROOT})`));

  // 4. Data folder and config.
  out.log(step(4, TOTAL, 'Data folder'));
  if (!rt.dryRun) {
    mkdirSync(ctx.mandateHome, { recursive: true, mode: 0o700 });
    chmodSync(ctx.mandateHome, 0o700);
    const file = writeSettings(ctx, settings);
    out.log(ok(`${ctx.mandateHome} ${c.dim(`(config: ${file})`)}`));
    if (settings.mode === 'local') {
      const base = expand(ctx, settings.baseDir ?? DEFAULT_BASE_DIR);
      mkdirSync(base, { recursive: true });
      out.log(ok(`projects folder ${base} ${c.dim('(change it in the setup wizard)')}`));
    }
  } else out.log(`  ${c.dim('would create')} ${ctx.mandateHome} and write server settings to config.json`);

  // 5. Service + start.
  out.log(step(5, TOTAL, 'Background service'));
  const s = readSettings(ctx);
  let running = false;
  if (a.flags.service === false) {
    out.log(info(`no service (--no-service). Run in the foreground: ${c.bold(`${BIN} start --foreground`)}`));
    running = !!(await health(s.localUrl))?.ok;
  } else if (rt.dryRun) {
    const p = platformService(ctx);
    out.log(`  ${c.dim('would install')} ${p ? `${p.kind} service ${p.file}` : 'nothing (no service manager): would start a detached process'}`);
  } else {
    const p = platformService(ctx);
    if (p) {
      p.install(serviceSpec(ctx, entry, PKG_VERSION));
      out.log(ok(`${p.kind} service ${c.dim(p.file)}`));
      if (p.kind === 'systemd' && settings.mode === 'server') {
        const user = ctx.env.USER ?? '';
        const l = spawnSync('loginctl', ['enable-linger', user], { encoding: 'utf8' });
        out.log(l.status === 0 ? ok('lingering enabled: Mandate keeps running after you log out') : warn(`to keep Mandate running after logout: sudo loginctl enable-linger ${user}`));
      }
    } else {
      out.log(info(`no launchd/systemd here: Mandate runs as a background process (${BIN} start / ${BIN} stop); or in the foreground: ${BIN} start --foreground`));
    }
    const code = await cmdStart(ctx, { cmd: 'start', positional: [], flags: { force: !!p }, rest: [] }, out);
    running = code === 0;
  }

  // 6. Coding agents.
  out.log(step(6, TOTAL, 'Coding agents'));
  if (a.flags.agents === false) out.log(info(`skipped (--no-agents); later: ${BIN} install --agents-only`));
  else {
    const found = pickAgents(ctx, a);
    if (!found.length) out.log(info(`no coding agents detected (${AGENTS.map((x) => x.label).join(', ')}); later: ${BIN} install --agents-only`));
    else {
      out.log(info(`detected: ${found.map((x) => c.bold(x.label)).join(', ')}`));
      if (await rt.prompt.confirm('Add the Mandate skills and the /mandate-flow and /mandate-bootstrap commands to them (and MCP entries for existing projects)?', true)) wireAgents(rt, found, s.url);
      else out.log(info(`skipped; later: ${BIN} install --agents-only`));
    }
  }

  // 7. Open the setup wizard / UI.
  out.log(step(7, TOTAL, settings.mode === 'local' ? 'Open Mandate' : 'Finish setup'));
  if (rt.dryRun) out.log(`  ${c.dim('would open the setup wizard')}`);
  else if (!running) out.log(info(`start Mandate, then run ${c.bold(`${BIN} open`)}`));
  else {
    const e = await entryUrl(ctx, s);
    if (settings.mode === 'server') {
      if (e.kind === 'setup') printTunnel(s, e.url, out, str(a, 'ssh'));
      else out.log(ok(`setup is complete: ${s.url}`));
    } else if (a.flags.open === false || !openBrowser(ctx, e.url)) out.log(info(`${e.kind === 'setup' ? 'setup wizard' : 'sign-in link'}: ${e.url}`));
    else out.log(ok(`opened the ${e.kind === 'setup' ? 'setup wizard' : 'UI'} in your browser`));
  }

  if (settings.mode === 'server' && !rt.dryRun) printProxy(s.publicUrl!, s.port, out);

  out.log(`\n${c.bold('Next steps')}`);
  if (settings.mode === 'local') {
    out.log(`  ${c.cyan(`${BIN} open`)}        open Mandate (one-time sign-in link)`);
    out.log(`  ${c.cyan(`${BIN} connect`)}     in a code repo: link it to a Mandate project for your coding agents`);
  } else {
    out.log(`  1. Point DNS for ${new URL(s.publicUrl!).hostname} at this server and set up the reverse proxy (above).`);
    out.log(`  2. Finish the setup wizard (GitHub sign-in) through the SSH tunnel.`);
    out.log(`  3. On each developer machine, in a code repo: ${c.cyan(`npx ${PKG_NAME} connect --url ${s.publicUrl} --project <id>`)}`);
  }
  out.log(`  ${c.cyan(`${BIN} status`)}      ${c.dim('·')} ${c.cyan(`${BIN} logs -f`)} ${c.dim('·')} ${c.cyan(`${BIN} doctor`)}`);
  return 0;
}

export function printProxy(publicUrl: string, port: number, out: Out): void {
  const input = { publicUrl, upstream: `127.0.0.1:${port}` };
  out.log(`\n${c.bold('Reverse proxy')} ${c.dim('(Caddy is simplest: automatic HTTPS)')}`);
  out.log(c.dim(caddySnippet(input)));
  out.log(`${c.bold('or nginx')}`);
  out.log(c.dim(nginxSnippet(input)));
}

/* ------------------------------------------------------------------ uninstall */

/**
 * Everything Mandate wrote, for `agents` (default: all). A subset keeps shared locations (e.g. ~/.agents/skills) that
 * another detected agent outside the subset still reads, and keeps env.sh / the shell hook / connected repos.
 */
export function uninstallChanges(ctx: Ctx, agents: AgentDef[] = AGENTS): (Change | null)[] {
  const all = agents.length === AGENTS.length;
  const changes: (Change | null)[] = [];
  // User scope: every given agent, wired or not (removal only touches Mandate's own entries / files).
  for (const ag of agents) {
    const t = ag.userMcp?.(ctx);
    if (t) changes.push(safe(() => mcpRemove(ag, t, ...mandateServersIn(ag, t))));
  }
  const others = AGENTS.filter((a) => !agents.includes(a) && a.detect(ctx));
  const keepRoots = [...new Set(others.flatMap((a) => a.skillDirs(ctx)).map((d) => path.dirname(d)))];
  changes.push(...skillChanges(ctx, agents, true, keepRoots), ...commandChanges(ctx, agents, true));
  if (!all) return changes;
  changes.push(...rcChanges(ctx, true));
  // Project scope: the repos `connect` wired.
  const byRepo = new Map<string, string[]>();
  for (const r of readManifest(ctx).repos) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r.project]);
  for (const [repo, ids] of byRepo) changes.push(...disconnectChanges(ctx, repo, ...ids));
  if (existsSync(envFile(ctx))) changes.push({ file: envFile(ctx), before: '', after: null, summary: 'agent key env vars' });
  return changes;
}

export function disconnectChanges(ctx: Ctx, repo: string, ...projects: string[]): (Change | null)[] {
  const out: (Change | null)[] = [];
  for (const ag of AGENTS) {
    const t = ag.projectMcp?.(repo, ctx);
    if (t) out.push(safe(() => mcpRemove(ag, t, ...projects.map((p) => `mandate-${p}`))));
  }
  out.push(...projectCommandChanges(repo, AGENTS, true));
  for (const f of KNOWN_INSTRUCTION_FILES) out.push(safe(() => sectionChange(path.join(repo, f), null)));
  return out;
}

const safe = (fn: () => Change | null): Change | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export async function cmdUninstall(rt: Runtime, a: Args): Promise<number> {
  const { ctx, out } = rt;
  const purge = bool(a, 'purge');
  out.log(c.bold(`Uninstall Mandate${rt.dryRun ? ' (dry run)' : ''}`));
  if (!rt.dryRun && !(await rt.prompt.confirm('Remove the background service and all agent wiring?', true))) return 1;

  if (str(a, 'agents')) {
    // Only these agents' wiring; the service, keys and data stay.
    applyChanges(uninstallChanges(ctx, pickAgents(ctx, a)), { dryRun: rt.dryRun, out, home: ctx.home });
    return 0;
  }
  const p = platformService(ctx);
  if (rt.dryRun) out.log(`  ${c.dim('would stop and remove')} ${p?.installed() ? p.file : 'the background process'}`);
  else {
    try {
      service(ctx).stop();
    } catch {
      /* not running */
    }
    if (p?.installed()) {
      p.uninstall();
      out.log(ok(`removed the ${p.kind} service`));
    }
  }
  applyChanges(uninstallChanges(ctx), { dryRun: rt.dryRun, out, home: ctx.home });
  if (!rt.dryRun) rmSync(manifestFile(ctx), { force: true });

  if (purge) {
    const really = rt.dryRun ? false : rt.prompt.interactive ? await rt.prompt.confirm(c.red(`Delete ${ctx.mandateHome} (config, keys, indexes, sessions)? Project repos in the projects folder are kept.`), false) : bool(a, 'yes');
    if (rt.dryRun) out.log(`  ${c.dim('would delete')} ${ctx.mandateHome}`);
    else if (really) {
      rmSync(ctx.mandateHome, { recursive: true, force: true });
      out.log(ok(`deleted ${ctx.mandateHome}`));
    } else out.log(info(`kept ${ctx.mandateHome}`));
  } else out.log(info(`kept your data in ${ctx.mandateHome} (delete it with ${BIN} uninstall --purge)`));
  if (!rt.dryRun) out.log(info(`remove the command too: npm uninstall -g ${PKG_NAME}`));
  return 0;
}

export { writeManifest };
