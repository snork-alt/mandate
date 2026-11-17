/**
 * `mandate connect [--project <id>]`, inside a code repo: the same wiring as the one-line installer, for this
 * machine's Mandate (user-scope and project-scope MCP entries signing in with GitHub, skills, commands, and a
 * "Mandate" section in CLAUDE.md / AGENTS.md). Projects are created in the web UI (from a GitHub repo).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { bool, str, type Args } from './args.js';
import { can, commandChanges, envVarFor, makeServer, mcpRemove, mcpUpsert, OAUTH_AGENTS, projectCommandChanges, projectScopeOnly, skillChanges, type AgentDef } from './agents.js';
import { BIN, envFile, type Ctx } from './context.js';
import { applyChanges, JsoncError, type Change } from './edits.js';
import { disconnectChanges, pickAgents, type Runtime } from './install.js';
import { claudeFlowWiring } from './claude-flow.js';
import { publicUrlProblem, readSettings } from './settings.js';
import { c, fail, info, ok, warn } from './ui.js';
import { envChange, instructionFiles, listProjects, rcChanges, readEnvKeys, readManifest, repoSection, sectionChange, writeManifest } from './wiring.js';

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
export function connectChanges(ctx: Ctx, repo: string, project: string, baseUrl: string, agents: AgentDef[], oauth = false): { changes: (Change | null)[]; skipped: string[] } {
  const s = { ...makeServer(baseUrl, project), ...(oauth ? { oauth: true } : {}) };
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
  if (remoteUrl) return connectRemote(rt, a, repo, remoteUrl);
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
  if (project && !projects.some((p) => p.id === project)) {
    out.err(fail(`no project '${project}' (projects: ${projects.map((p) => p.id).join(', ') || 'none'}); create it in the web UI (New project, from a GitHub repo)`));
    return 1;
  }
  if (!project) {
    const linked = readManifest(ctx).repos.find((r) => r.repo === repo);
    const def = linked?.project ?? projects.find((p) => p.id === guess)?.id ?? (projects.length === 1 ? projects[0]!.id : undefined);
    const choices = projects.map((p) => ({ value: p.id, label: `${p.name} ${c.dim(`(${p.id})`)}`, hint: p.dataDir }));
    if (!choices.length) {
      out.err(fail('no projects yet: create one in the web UI (New project, from a GitHub repo), then run connect again'));
      return 1;
    }
    project = await rt.prompt.select('Which Mandate project holds the specs for this repo?', choices, def ?? choices[0]!.value);
  }
  // Same wiring as a developer machine: this server's URL, GitHub sign-in through MCP OAuth.
  return connectRemote(rt, { ...a, flags: { ...a.flags, project } }, repo, s.url);
}

const isLoopbackUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u);

/** Per-agent summary line: "Claude Code: MCP ✓ skills ✓ commands ✓". */
export function wiringSummary(ctx: Ctx, agents: AgentDef[], wired: Map<string, { mcp: boolean | string }>): string[] {
  const mark = (v: boolean | string) => (v === true ? '✓' : v === false ? '–' : v);
  return agents.map((ag) => {
    const w = wired.get(ag.id) ?? { mcp: false };
    const skills = can(ag, 'skills', ctx.force);
    const commands = !!ag.commands && can(ag, 'commands', ctx.force);
    return `${ag.label}: MCP ${mark(w.mcp)} skills ${mark(skills)} commands ${mark(commands)}`;
  });
}

/**
 * Wire this machine's coding agents to a Mandate server (`mandate connect --url <server> --project <id>`; the one-line
 * installer `curl -fsSL <server>/p/<id>/install.sh | sh` runs exactly this):
 * - user scope: the MCP server entry for every detected agent (through the adapter registry), the skills and the
 *   slash commands; with `--repo` (inside a git repo) also the project-scope entries and the CLAUDE.md / AGENTS.md
 *   section (no key in any file that can be committed);
 * - auth: agents sign in with GitHub through MCP OAuth (no token written). With `--auth token`, a personal token
 *   (pasted, or already in env.sh) is referenced as `$MANDATE_KEY_<PROJECT>`, exported by ~/.mandate/env.sh (0600), for
 *   agents that cannot sign in by themselves; those without env-var expansion get it in their user config (0600),
 *   never in a repo.
 * - `--remove` undoes the user-scope MCP entry and the repo wiring. Idempotent: entries are updated in place.
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
  // Repo wiring (the current repo) unless --no-repo; the installer asks first inside a git repo, and passes --no-repo outside one.
  const wireRepo = a.flags.repo !== false;
  const agents = pickAgents(ctx, a);
  const server = makeServer(base, project);
  const v = envVarFor(project);

  if (bool(a, 'remove')) {
    const changes: (Change | null)[] = [];
    for (const ag of agents) {
      const t = ag.userMcp?.(ctx);
      if (t && can(ag, 'mcp', true)) changes.push(mcpRemove(ag, t, server.name));
    }
    if (wireRepo) changes.push(...disconnectChanges(ctx, repo, project));
    changes.push(...claudeFlowWiring(ctx, agents, { project, url: base, repo: wireRepo ? repo : undefined, remove: true }));
    applyChanges(changes, { dryRun: rt.dryRun, out, home: ctx.home });
    if (!rt.dryRun) {
      const m = readManifest(ctx);
      writeManifest(ctx, { ...m, repos: m.repos.filter((r) => !(r.project === project && (r.repo === repo || r.repo === `user:${base}`))) });
    }
    out.log(ok(`removed ${c.bold(server.name)} from ${agents.map((x) => x.label).join(', ') || 'no agents'}${wireRepo ? ` and ${repo}` : ''}`));
    out.log(c.dim(`  skills and commands stay for your other projects; remove everything: ${BIN} uninstall`));
    return 0;
  }

  // MCP OAuth by default; `--auth token`: a personal token (web UI → Connect agent), kept only in env.sh.
  const wantToken = str(a, 'auth') === 'token';
  let key = wantToken ? (ctx.env[v] ?? readEnvKeys(ctx).get(v)) : undefined;
  if (!key && wantToken && rt.prompt.interactive) key = (await rt.prompt.input(`Personal token for '${project}' (web UI → Connect agent → Personal tokens; stored only in ${envFile(ctx)}):`, '')) || undefined;
  const oauth = !key;
  if (base.startsWith('http://') && !isLoopbackUrl(base)) out.log(warn('plain http: sign-in and tokens would travel unencrypted; use the https URL'));

  const changes: (Change | null)[] = [];
  const skipped: string[] = [];
  const wired = new Map<string, { mcp: boolean | string }>();
  for (const ag of agents) {
    const t = ag.userMcp?.(ctx);
    if (!t || !can(ag, 'mcp', ctx.force)) {
      wired.set(ag.id, { mcp: ag.caps.mcp === 'manual' ? 'manual' : false });
      if (ag.caps.mcp === 'unverified' && t) skipped.push(`${ag.label}: MCP config location is unverified; not written (use --force to write ${t.file})`);
      continue;
    }
    if (oauth && !OAUTH_AGENTS.has(ag.id)) {
      wired.set(ag.id, { mcp: 'needs a personal token' });
      skipped.push(`${ag.label}: cannot sign in by itself; create a personal token (web UI → Connect agent) and run again with --auth token`);
      continue;
    }
    // --repo: the project-scope entry is the one; the user-scope entry of the same project would only repeat it.
    if (wireRepo && projectScopeOnly(ag, !!ctx.force, repo, ctx)) {
      changes.push(mcpRemove(ag, t, server.name));
      wired.set(ag.id, { mcp: true });
      continue;
    }
    try {
      // Literal keys only for agents without env-var expansion, at user scope (0600); OAuth entries carry no header.
      changes.push(mcpUpsert(ag, t, { ...server, ...(oauth ? { oauth: true } : ag.envSyntax === null ? { key: key! } : {}) }));
      wired.set(ag.id, { mcp: true });
    } catch (e) {
      wired.set(ag.id, { mcp: false });
      skipped.push(e instanceof JsoncError ? `${ag.label}: ${e.message}; add server ${server.name} by hand` : `${ag.label}: ${(e as Error).message}`);
    }
  }
  changes.push(...skillChanges(ctx, agents), ...commandChanges(ctx, agents));
  changes.push(...claudeFlowWiring(ctx, agents, { project, url: base, repo: wireRepo ? repo : undefined, strict: bool(a, 'strict-flow') }));
  if (wireRepo) {
    const r = connectChanges(ctx, repo, project, base, agents.filter((ag) => !oauth || OAUTH_AGENTS.has(ag.id)), oauth);
    changes.push(...r.changes);
    skipped.push(...r.skipped);
  }
  if (!rt.dryRun) mkdirSync(ctx.mandateHome, { recursive: true, mode: 0o700 });
  // Tokens only in env.sh (0600), sourced by the shell profile; never echoed.
  const keyChanges = rt.dryRun || !key ? [] : [envChange(ctx, new Map([[project, key]])), ...rcChanges(ctx)];
  if (bool(a, 'strict-flow') && oauth) skipped.push(`strict flow: the edit guard (${BIN} guard) authenticates with a personal token; connect with --auth token for it to enforce (without one it lets edits through)`);
  for (const x of skipped) out.log(warn(x));
  applyChanges([...changes, ...keyChanges], { dryRun: rt.dryRun, out, home: ctx.home });
  if (!rt.dryRun) {
    const m = readManifest(ctx);
    const entry = wireRepo ? repo : `user:${base}`;
    writeManifest(ctx, { ...m, repos: [...m.repos.filter((r) => !(r.repo === entry && r.project === project)), { repo: entry, project, agents: agents.map((x) => x.id), at: new Date().toISOString() }] });
  }

  out.log(`\n${ok(`connected to ${c.bold(project)} at ${base} as MCP server ${c.bold(server.name)}${oauth ? ' (MCP sign-in: your agent opens GitHub sign-in on first use)' : ''}`)}`);
  if (!agents.length) out.log(warn('no coding agents detected (choose with --agents claude-code,codex,…)'));
  for (const line of wiringSummary(ctx, agents, wired)) out.log(`  ${line}`);
  if (wireRepo) out.log(info(`repo ${repo}: project MCP entries and the Mandate section (safe to commit: no key)`));
  if (key && !ctx.env[v]) out.log(info(`load the token in this terminal: ${c.cyan(`. ${envFile(ctx)}`)} ${c.dim('(new terminals load it automatically)')}`));
  if (oauth && agents.length) {
    // One sign-in per project and agent: without it the server shows "needs authentication".
    out.log(`\n${c.bold('Next: sign in (once)')}`);
    for (const ag of agents) {
      if (ag.id === 'claude-code') out.log(`  ${ag.label}: run ${c.cyan('/mcp')} → ${c.bold(server.name)} → ${c.bold('Authenticate')}, then ${c.bold('Allow')} in the browser`);
      else if (ag.id === 'codex') out.log(`  ${ag.label}: run ${c.cyan(`codex mcp login ${server.name}`)}, then ${c.bold('Allow')} in the browser`);
      else out.log(`  ${ag.label}: it opens the sign-in page on first use of ${c.bold(server.name)}; choose ${c.bold('Allow')}`);
    }
  }
  out.log(`\n${c.bold('Verify')}`);
  if (agents.some((x) => x.id === 'claude-code')) out.log(`  ${c.cyan('claude mcp list')}   ${c.dim(`shows ${server.name} as connected${oauth ? ' (after signing in)' : ''}`)}`);
  if (agents.some((x) => x.id === 'codex')) out.log(`  ${c.cyan(oauth ? `codex mcp login ${server.name}` : 'codex mcp list')}`);
  out.log(`  ask your agent: ${c.dim('"use Mandate: project_info"')}`);
  out.log(c.dim(`  undo: ${BIN} connect --url ${base} --project ${project} --remove`));
  return 0;
}
