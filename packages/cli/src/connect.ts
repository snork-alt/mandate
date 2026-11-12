/**
 * `mandate connect [--project <id>]`, inside a code repo: project-scope MCP entries for the detected agents (keys by
 * env var only, safe to commit), a "Mandate" section in CLAUDE.md / AGENTS.md, and the user-scope env.sh.
 * Local mode: when the repo has no Mandate project yet, offers to create one in the projects folder (~/mandate/<id>).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { bool, str, type Args } from './args.js';
import { can, projectCommandChanges, envVarFor, makeServer, mcpUpsert, serverName, type AgentDef } from './agents.js';
import { BIN, envFile, type Ctx } from './context.js';
import { applyChanges, JsoncError, type Change } from './edits.js';
import { disconnectChanges, pickAgents, type Runtime } from './install.js';
import { createLocalProject, health } from './serverlink.js';
import { publicUrlProblem, readSettings } from './settings.js';
import { c, fail, info, ok, warn } from './ui.js';
import { envChange, instructionFiles, listProjects, projectKeys, rcChanges, readEnvKeys, readManifest, repoSection, sectionChange, writeManifest } from './wiring.js';

export function repoRoot(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'project';

/** Project-scope changes for one repo (pure: used by tests and --dry-run). */
export function connectChanges(ctx: Ctx, repo: string, project: string, baseUrl: string, agents: AgentDef[]): { changes: (Change | null)[]; skipped: string[] } {
  const s = makeServer(baseUrl, project);
  const changes: (Change | null)[] = [];
  const skipped: string[] = [];
  for (const ag of agents) {
    const t = ag.projectMcp?.(repo, ctx);
    // Project files can be committed: only agents that reference the key by env var get one.
    if (!t || !can(ag, 'mcp', ctx.force) || ag.envSyntax === null) continue;
    try {
      changes.push(mcpUpsert(ag, t, s));
    } catch (e) {
      skipped.push(e instanceof JsoncError ? `${ag.label}: ${e.message}; add server ${s.name} by hand` : `${ag.label}: ${(e as Error).message}`);
    }
  }
  changes.push(...projectCommandChanges(repo, agents, false, ctx.force));
  for (const f of instructionFiles(repo, agents)) changes.push(sectionChange(f, repoSection(project, s.url)));
  return { changes, skipped };
}

export async function cmdConnect(rt: Runtime, a: Args): Promise<number> {
  const { ctx, out } = rt;
  const repo = repoRoot(ctx.cwd);
  const remoteUrl = str(a, 'url');
  if (remoteUrl && !bool(a, 'remove')) return connectRemote(rt, a, repo, remoteUrl);
  const s = readSettings(ctx);
  const agents = pickAgents(ctx, a);
  const projects = listProjects(ctx);

  if (bool(a, 'remove')) {
    const m = readManifest(ctx);
    const linked = m.repos.filter((r) => r.repo === repo);
    const ids = str(a, 'project') ? [str(a, 'project')!] : linked.map((r) => r.project);
    if (!ids.length) {
      out.log(info(`${repo} is not connected`));
      return 0;
    }
    applyChanges(disconnectChanges(ctx, repo, ...ids), { dryRun: rt.dryRun, out, home: ctx.home });
    if (!rt.dryRun) writeManifest(ctx, { ...m, repos: m.repos.filter((r) => !(r.repo === repo && ids.includes(r.project))) });
    out.log(ok(`disconnected ${repo}`));
    return 0;
  }

  out.log(`${c.bold('Connect')} ${repo}`);
  let project = str(a, 'project');
  const guess = slug(path.basename(repo));
  if (project && !projects.some((p) => p.id === project) && s.mode === 'server') {
    out.err(fail(`no project '${project}' (projects: ${projects.map((p) => p.id).join(', ') || 'none'}); create it in the web UI from a GitHub repo`));
    return 1;
  }
  if (!project) {
    const linked = readManifest(ctx).repos.find((r) => r.repo === repo);
    const def = linked?.project ?? projects.find((p) => p.id === guess)?.id ?? (projects.length === 1 ? projects[0]!.id : undefined);
    const NEW = '__new__';
    const choices = [
      ...projects.map((p) => ({ value: p.id, label: `${p.name} ${c.dim(`(${p.id})`)}`, hint: p.dataDir })),
      ...(s.mode === 'local' ? [{ value: NEW, label: `New project ${c.bold(guess)} in ${s.baseDir}/${guess}` }] : []),
    ];
    if (!choices.length) {
      out.err(fail(s.mode === 'server' ? 'no projects yet: create one in the web UI (from a GitHub repo), then run connect again' : 'no projects'));
      return 1;
    }
    project = await rt.prompt.select('Which Mandate project holds the specs for this repo?', choices, def ?? (s.mode === 'local' ? NEW : choices[0]!.value));
    if (project === NEW) project = guess;
  }

  // Local mode: create the project when it does not exist yet.
  if (!projects.some((p) => p.id === project)) {
    if (s.mode !== 'local') return 1;
    if (!(await rt.prompt.confirm(`Create the Mandate project '${project}' in ${s.baseDir}/${project}?`, true))) return 1;
    if (rt.dryRun) out.log(`  ${c.dim('would create project')} ${project} in ${s.baseDir}/${project}`);
    else {
      if (!(await health(s.localUrl))?.ok) {
        out.err(fail(`Mandate is not running; start it (${BIN} start) and run connect again`));
        return 1;
      }
      try {
        // Mandate assigns the id (a slug of the name); use the one it returns.
        const p = await createLocalProject(ctx, s, { name: project, mode: 'new' });
        project = p.id;
        out.log(ok(`created project ${c.bold(p.id)} in ${s.baseDir}/${p.id}`));
      } catch (e) {
        out.err(fail((e as Error).message));
        return 1;
      }
    }
  }

  if (!agents.length) out.log(warn(`no coding agents detected; writing ${c.bold('AGENTS.md')} only (choose with --agents claude-code,codex,…)`));
  const { changes, skipped } = connectChanges(ctx, repo, project, s.url, agents);
  for (const x of skipped) out.log(warn(x));
  // The key reaches agents through MANDATE_KEY_<PROJECT> (user scope, never in the repo).
  const all = listProjects(ctx).map((p) => p.id);
  if (!all.includes(project)) all.push(project);
  const keyChanges = rt.dryRun ? [] : [envChange(ctx, projectKeys(ctx, all)), ...rcChanges(ctx)];
  applyChanges([...changes, ...keyChanges], { dryRun: rt.dryRun, out, home: ctx.home });
  if (!rt.dryRun) {
    const m = readManifest(ctx);
    writeManifest(ctx, { ...m, repos: [...m.repos.filter((r) => !(r.repo === repo && r.project === project)), { repo, project, agents: agents.map((x) => x.id), at: new Date().toISOString() }] });
  }

  for (const ag of agents.filter((x) => x.caps.mcp === 'manual')) {
    out.log(info(`${ag.label}: add this by hand (${ag.docs[0]}):`));
    out.log(c.dim(String(ag.entry(makeServer(s.url, project)))));
  }
  for (const ag of agents.filter((x) => x.envSyntax === null && x.caps.mcp === 'verified')) out.log(info(`${ag.label} cannot read keys from env vars: its MCP entry is in your user config (${ag.userMcp?.(ctx).file}), not in the repo.`));
  const v = envVarFor(project);
  out.log(`\n${ok(`connected to ${c.bold(project)} as MCP server ${c.bold(serverName(project))}`)}`);
  out.log(info(`agent configs reference ${c.bold(`$${v}`)}; no key is written into the repo (safe to commit).`));
  if (!ctx.env[v]) out.log(info(`load it in this terminal: ${c.cyan(`. ${envFile(ctx)}`)} ${c.dim('(new terminals load it automatically)')}`));
  if (s.mode === 'server') out.log(info(`developer machines: ${c.cyan(`npx getmandate connect --url ${s.url} --project ${project}`)}`));
  out.log(info('try it: ask your agent to "use Mandate to find the next work order" (Claude Code: /mandate-next-work-order)'));
  out.log(c.dim(`  undo: ${BIN} connect --remove`));
  return 0;
}

/**
 * A developer machine using a remote (server-mode) Mandate: `mandate connect --url https://mandate.example.com
 * --project <id>`. The key (copied from the web UI's Connect agent dialog) goes only into ~/.mandate/env.sh.
 */
async function connectRemote(rt: Runtime, a: Args, repo: string, url: string): Promise<number> {
  const { ctx, out } = rt;
  const problem = publicUrlProblem(url);
  if (problem) {
    out.err(fail(`--url: ${problem}`));
    return 2;
  }
  const base = new URL(url).origin;
  const project = str(a, 'project') ?? (await rt.prompt.input('Project id (see the web UI):', ''));
  if (!project || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) {
    out.err(fail('--project <id> is required with --url'));
    return 2;
  }
  const v = envVarFor(project);
  let key = ctx.env[v] ?? readEnvKeys(ctx).get(v);
  if (!key && rt.prompt.interactive) key = (await rt.prompt.input(`Agent key for '${project}' (web UI → Connect agent; stored only in ${envFile(ctx)}):`, '')) || undefined;
  if (base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(base)) out.log(warn('plain http: the key would travel unencrypted; use the https URL'));
  const agents = pickAgents(ctx, a);
  const { changes, skipped } = connectChanges(ctx, repo, project, base, agents);
  for (const x of skipped) out.log(warn(x));
  if (!rt.dryRun && key) mkdirSync(ctx.mandateHome, { recursive: true, mode: 0o700 });
  const keyChanges = rt.dryRun || !key ? [] : [envChange(ctx, new Map([[project, key]])), ...rcChanges(ctx)];
  applyChanges([...changes, ...keyChanges], { dryRun: rt.dryRun, out, home: ctx.home });
  if (!rt.dryRun) {
    mkdirSync(ctx.mandateHome, { recursive: true, mode: 0o700 });
    const m = readManifest(ctx);
    writeManifest(ctx, { ...m, repos: [...m.repos.filter((r) => !(r.repo === repo && r.project === project)), { repo, project, agents: agents.map((x) => x.id), at: new Date().toISOString() }] });
  }
  out.log(`\n${ok(`connected to ${c.bold(project)} at ${base} as MCP server ${c.bold(serverName(project))}`)}`);
  if (!key) out.log(info(`set the key: export ${v}=<key from the web UI> (or run connect again in a terminal to paste it)`));
  else if (!ctx.env[v]) out.log(info(`load it in this terminal: ${c.cyan(`. ${envFile(ctx)}`)}`));
  return 0;
}
