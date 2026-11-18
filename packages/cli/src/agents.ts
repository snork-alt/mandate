/**
 * Coding-agent wiring. Formats checked against each agent's docs (Nov 2026; see plans/cli-notes.md):
 * - MCP entries never contain keys: they reference the env var MANDATE_KEY_<PROJECT> with each agent's own syntax
 *   (Claude Code `${V}`, Cursor / VS Code / Windsurf `${env:V}`, Gemini `${V}`, opencode `{env:V}`, Codex
 *   `bearer_token_env_var`). `~/.mandate/env.sh` exports the variables; the shell rc sources it.
 * - The Agent Skill goes to `~/.claude/skills/mandate` (Claude Code) and `~/.agents/skills/mandate` (Codex, Cursor,
 *   Gemini CLI, Windsurf/Devin, opencode, VS Code all read it).
 * - Two slash commands, `/mandate-flow` and `/mandate-bootstrap`, for every agent with commands or prompts (Claude Code,
 *   Codex, Cursor, Gemini CLI, opencode; VS Code prompt files in connected repos); Windsurf / Devin uses the MCP
 *   prompts. The master skill drives everything else; `mandate-bootstrap` is a separate skill. Command files of earlier
 *   versions are still removed by uninstall.
 * - Skills and commands are short STUBS (stubs.ts, stamped `mandate-stub v<STUB_VERSION>`): they load the current text
 *   from the server (`instructions_get`), so server updates need no reinstall.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FLOW_COMMAND, MANDATE_COMMAND, SKILL_DESCRIPTION } from '../../server/src/mcp/guide.js';
import { BOOTSTRAP_COMMAND, BOOTSTRAP_SKILL_DESCRIPTION } from '../../server/src/mcp/bootstrap.js';
import { BOOTSTRAP_SKILL_STUB, commandStub, SKILL_STUB, STUB_VERSION } from '../../server/src/mcp/stubs.js';
import { isSupportedAgent, SUPPORTED_AGENTS } from '../../shared/src/supported-agents.js';
import type { Ctx } from './context.js';
import { change, jsonGet, jsonRemove, jsonSet, MANAGED_MARK, readText, removeBlock, upsertBlock, type Change } from './edits.js';

export interface McpTarget {
  /** Absolute config file. */
  file: string;
  format: 'json' | 'toml';
}

export interface Server {
  /** The key itself: only for agents without env-var expansion, only at user scope. */
  key?: string;
  /**
   * Team without a personal token: no Authorization header, so the agent signs in itself (MCP OAuth: the server's 401
   * points at its protected-resource metadata). Nothing secret is written.
   */
  oauth?: boolean;
  project: string;
  /** `mandate-<project>`. */
  name: string;
  url: string;
  envVar: string;
}

export type Cap = 'verified' | 'unverified' | 'manual' | 'unsupported';

export interface AgentDef {
  id: string;
  label: string;
  /** Official docs the paths and formats come from (checked on CHECKED). */
  docs: string[];
  /** What the agent supports, as verified in its docs; `instructions`: the project instructions file(s) it reads. */
  caps: { mcp: Cap; skills: Cap; commands: Cap; instructions: string[] };
  /** How its config references an env var in headers (null: none; the key is written literally at user scope only). */
  envSyntax: string | null;
  detect(ctx: Ctx): boolean;
  /** User-scope MCP config (install). */
  userMcp?(ctx: Ctx): McpTarget;
  /** Project-scope MCP config inside a repo (connect). */
  projectMcp?(repo: string, ctx: Ctx): McpTarget;
  /** JSON key path for a server entry (json targets). */
  jsonPath?(server: Server, existing: string | null, file: string): string[];
  entry(server: Server): unknown;
  /** Skill directories (user scope); several agents share ~/.agents/skills. */
  skillDirs(ctx: Ctx): string[];
  /** Slash commands (`/mandate-flow`, `/mandate-bootstrap`): where each agent keeps them and their file format. */
  commands?: CommandSpec;
  /** Command files written by earlier versions (removed by uninstall). */
  legacyCommands?(ctx: Ctx): string[];
  /**
   * The client refreshes its tool list on `notifications/tools/list_changed` (per its docs): its URL lists the default
   * `core` tool set and the agent adds sets with tools_enable. Others get `?tools=all` (every set, ~100 tools).
   */
  listChanged?: boolean;
  /**
   * Why the user-scope entry is kept next to a project-scope one (connect --repo): the agent reads the project config
   * only under a condition (e.g. trusted projects). Unset: project scope replaces the user-scope entry of that project.
   */
  keepUserScope?: string;
  /** Shown after wiring. */
  note?: string;
}

export const serverName = (project: string) => `mandate-${project}`;
export const envVarFor = (project: string) => `MANDATE_KEY_${project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
export const mcpUrl = (base: string, project: string) => `${base.replace(/\/+$/, '')}/p/${project}/mcp`;
export const makeServer = (base: string, project: string): Server => ({ project, name: serverName(project), url: mcpUrl(base, project), envVar: envVarFor(project) });

const onPath = (ctx: Ctx, bin: string) => {
  if (ctx.env.MANDATE_NO_PATH_DETECT) return false;
  const r = spawnSync(ctx.platform === 'win32' ? 'where' : 'which', [bin], { env: ctx.env, encoding: 'utf8' });
  return r.status === 0;
};
const at = (ctx: Ctx, ...p: string[]) => path.join(ctx.home, ...p);
/** Skills root shared by Codex, Cursor, Gemini CLI, Devin, opencode and VS Code (`~/.agents/skills`). */
const AGENTS_SKILLS = (ctx: Ctx) => at(ctx, '.agents', 'skills', 'mandate');

export interface Command {
  name: string;
  title: string;
  description: string;
  argumentHint: string;
  render(args: string): string;
}
/**
 * The slash commands deployed to every agent that has commands or prompts (others get the MCP prompts): stubs that load
 * the current command text with `instructions_get` (name, description and hint come from the server constants).
 */
export const COMMANDS: Command[] = [
  { ...FLOW_COMMAND, render: (args: string) => commandStub('flow', args) },
  { ...BOOTSTRAP_COMMAND, render: (args: string) => commandStub('bootstrap', args) },
  { ...MANDATE_COMMAND, render: (args: string) => commandStub('mandate', args) },
];
export { STUB_VERSION };

export interface CommandSpec {
  /** File of a command (user scope). */
  user?(ctx: Ctx, name: string): string;
  /** File of a command inside a repo (project scope). */
  project?(repo: string, name: string): string;
  render(c: Command): string;
}

/* ------------------------------------------------------------------ content */

export { SKILL_DESCRIPTION };

export function bootstrapSkillMd(): string {
  return `---
name: mandate-bootstrap
description: ${JSON.stringify(BOOTSTRAP_SKILL_DESCRIPTION)}
metadata:
  managed-by: mandate
---

<!-- ${MANAGED_MARK}: \`mandate uninstall\` removes it; \`mandate install\` refreshes it. -->

${BOOTSTRAP_SKILL_STUB}`;
}

export function skillMd(): string {
  return `---
name: mandate
description: ${JSON.stringify(SKILL_DESCRIPTION)}
metadata:
  managed-by: mandate
---

<!-- ${MANAGED_MARK}: \`mandate uninstall\` removes it; \`mandate install\` refreshes it. -->

${SKILL_STUB}`;
}

/** Markdown command with front matter and `$ARGUMENTS` (Claude Code, Codex, opencode). */
export function markdownCommand(c: Command): string {
  return `---
description: ${JSON.stringify(c.description)}
argument-hint: ${JSON.stringify(c.argumentHint)}
---
<!-- ${MANAGED_MARK} -->
${c.render('$ARGUMENTS')}
`;
}

/** Cursor commands: plain markdown; the text typed after the command is appended. */
export function cursorCommand(c: Command): string {
  return `<!-- ${MANAGED_MARK} -->
# ${c.title}

${c.render('(the text after the command)')}
`;
}

const tomlStr = (t: string) => `"""\n${t.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}\n"""`;
/** Gemini CLI: TOML with `{{args}}`. */
export function geminiCommand(c: Command): string {
  return `# ${MANAGED_MARK}
description = ${JSON.stringify(c.description)}
prompt = ${tomlStr(c.render('{{args}}'))}
`;
}

/** VS Code prompt file (`.github/prompts/<name>.prompt.md`): `${input:args}`. */
export function vscodePrompt(c: Command): string {
  return `---
description: ${JSON.stringify(c.description)}
argument-hint: ${JSON.stringify(c.argumentHint)}
---
<!-- ${MANAGED_MARK} -->
${c.render('${input:args}')}
`;
}

/** Names of the slash commands earlier versions wrote. */
const LEGACY = ['next-work-order', 'implement', 'check-standards', 'impact', 'file-feedback', 'verify'];

/* ------------------------------------------------------------------ agents */

const bearer = (v: string) => ({ Authorization: `Bearer ${v}` });

/** Never-committed placeholder when an agent cannot expand env vars and no key is known (project scope never gets keys). */
const literal = (s: Server) => bearer(s.key ?? `<${s.envVar}>`);

/**
 * The adapter registry. Every path and format comes from the agent's official docs (URLs per adapter, checked on
 * CHECKED); `caps` marks each capability verified / unverified (written only with --force) / manual / unsupported.
 */
export const CHECKED = '2026-11-12';
export const AGENTS: AgentDef[] = [
  {
    // code.claude.com/docs/en/mcp · /skills · /slash-commands · /memory
    id: 'claude-code',
    listChanged: true,
    label: 'Claude Code',
    docs: ['https://code.claude.com/docs/en/mcp', 'https://code.claude.com/docs/en/skills', 'https://code.claude.com/docs/en/memory'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['CLAUDE.md'] },
    envSyntax: '${VAR}',
    detect: (ctx) => existsSync(at(ctx, '.claude')) || existsSync(at(ctx, '.claude.json')) || onPath(ctx, 'claude'),
    userMcp: (ctx) => ({ file: at(ctx, '.claude.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.mcp.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ type: 'http', url: s.url, headers: bearer(`\${${s.envVar}}`) }),
    skillDirs: (ctx) => [at(ctx, '.claude', 'skills', 'mandate')],
    commands: { user: (ctx, n) => at(ctx, '.claude', 'commands', `${n}.md`), project: (repo, n) => path.join(repo, '.claude', 'commands', `${n}.md`), render: markdownCommand },
    legacyCommands: (ctx) => LEGACY.map((n) => at(ctx, '.claude', 'commands', `mandate-${n}.md`)),
    note: 'Skills "mandate" + "mandate-bootstrap"; /mandate-flow, /mandate-bootstrap.',
  },
  {
    // learn.chatgpt.com/docs/extend/mcp?surface=cli · /docs/build-skills · /docs/custom-prompts (deprecated, still read) · /docs/agent-configuration/agents-md
    id: 'codex',
    keepUserScope: 'Codex reads a project .codex/config.toml only for trusted projects',
    label: 'Codex',
    docs: ['https://learn.chatgpt.com/docs/extend/mcp?surface=cli', 'https://learn.chatgpt.com/docs/build-skills', 'https://learn.chatgpt.com/docs/custom-prompts'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['AGENTS.md'] },
    envSyntax: 'bearer_token_env_var',
    detect: (ctx) => existsSync(at(ctx, '.codex')) || onPath(ctx, 'codex'),
    userMcp: (ctx) => ({ file: at(ctx, '.codex', 'config.toml'), format: 'toml' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.codex', 'config.toml'), format: 'toml' }),
    entry: (s) => `[mcp_servers.${s.name}]\nurl = ${JSON.stringify(s.url)}\nbearer_token_env_var = ${JSON.stringify(s.envVar)}`,
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    commands: { user: (ctx, n) => at(ctx, '.codex', 'prompts', `${n}.md`), render: markdownCommand },
    legacyCommands: (ctx) => LEGACY.map((n) => at(ctx, '.codex', 'prompts', `mandate-${n}.md`)),
    note: 'Skills in ~/.agents/skills; /prompts:mandate-flow, /prompts:mandate-bootstrap (project .codex/config.toml is read for trusted projects).',
  },
  {
    // cursor.com/docs/context/mcp · /context/skills · /agent/chat/commands · /context/rules
    id: 'cursor',
    label: 'Cursor',
    docs: ['https://cursor.com/docs/context/mcp', 'https://cursor.com/docs/context/skills', 'https://cursor.com/docs/context/rules'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['AGENTS.md'] },
    envSyntax: '${env:VAR}',
    detect: (ctx) => existsSync(at(ctx, '.cursor')) || onPath(ctx, 'cursor'),
    userMcp: (ctx) => ({ file: at(ctx, '.cursor', 'mcp.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.cursor', 'mcp.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ url: s.url, headers: bearer(`\${env:${s.envVar}}`) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    commands: { user: (ctx, n) => at(ctx, '.cursor', 'commands', `${n}.md`), project: (repo, n) => path.join(repo, '.cursor', 'commands', `${n}.md`), render: cursorCommand },
    legacyCommands: (ctx) => LEGACY.map((n) => at(ctx, '.cursor', 'commands', `mandate-${n}.md`)),
  },
  {
    // code.visualstudio.com/docs/copilot/reference/mcp-configuration · /customization/agent-skills · /customization/prompt-files · /customization/custom-instructions
    id: 'vscode',
    listChanged: true,
    label: 'VS Code (Copilot)',
    docs: ['https://code.visualstudio.com/docs/copilot/reference/mcp-configuration', 'https://code.visualstudio.com/docs/copilot/customization/agent-skills', 'https://code.visualstudio.com/docs/copilot/customization/prompt-files'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['AGENTS.md'] },
    envSyntax: '${env:VAR}',
    detect: (ctx) => existsSync(vscodeUserDir(ctx)) || onPath(ctx, 'code'),
    userMcp: (ctx) => ({ file: path.join(vscodeUserDir(ctx), 'mcp.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.vscode', 'mcp.json'), format: 'json' }),
    jsonPath: (s) => ['servers', s.name],
    entry: (s) => ({ type: 'http', url: s.url, headers: bearer(`\${env:${s.envVar}}`) }),
    // Local harness reads ~/.agents/skills; the Copilot harness reads ~/.copilot/skills.
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx), at(ctx, '.copilot', 'skills', 'mandate')],
    commands: { project: (repo, n) => path.join(repo, '.github', 'prompts', `${n}.prompt.md`), render: vscodePrompt },
    note: '/mandate-flow and /mandate-bootstrap as prompt files in connected repos; also the MCP prompts.',
  },
  {
    // geminicli.com/docs/tools/mcp-server · /reference/configuration · /cli/skills · /cli/custom-commands · /cli/gemini-md
    id: 'gemini',
    label: 'Gemini CLI',
    docs: ['https://geminicli.com/docs/tools/mcp-server/', 'https://geminicli.com/docs/cli/skills/', 'https://geminicli.com/docs/cli/custom-commands/', 'https://geminicli.com/docs/cli/gemini-md'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['GEMINI.md'] },
    envSyntax: '${VAR}',
    detect: (ctx) => existsSync(at(ctx, '.gemini')) || onPath(ctx, 'gemini'),
    userMcp: (ctx) => ({ file: at(ctx, '.gemini', 'settings.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.gemini', 'settings.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ httpUrl: s.url, headers: bearer(`\${${s.envVar}}`) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    commands: { user: (ctx, n) => at(ctx, '.gemini', 'commands', `${n}.toml`), project: (repo, n) => path.join(repo, '.gemini', 'commands', `${n}.toml`), render: geminiCommand },
    legacyCommands: (ctx) => LEGACY.map((n) => at(ctx, '.gemini', 'commands', 'mandate', `${n}.toml`)),
  },
  {
    // docs.devin.ai/desktop/cascade/mcp · /skills · /workflows (deprecated) · /memories
    id: 'windsurf',
    label: 'Windsurf / Devin Desktop',
    docs: ['https://docs.devin.ai/desktop/cascade/mcp', 'https://docs.devin.ai/desktop/cascade/skills', 'https://docs.devin.ai/desktop/cascade/memories'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'unsupported', instructions: ['AGENTS.md'] },
    envSyntax: '${env:VAR}',
    detect: (ctx) => existsSync(at(ctx, '.config', 'devin')) || existsSync(at(ctx, '.codeium', 'windsurf')) || onPath(ctx, 'windsurf'),
    userMcp: (ctx) => ({ file: existsSync(at(ctx, '.config', 'devin')) ? at(ctx, '.config', 'devin', 'mcp_config.json') : at(ctx, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.devin', 'mcp_config.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ serverUrl: s.url, headers: bearer(`\${env:${s.envVar}}`) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    note: 'No slash commands (workflows are deprecated): use the MCP prompts mandate-flow / mandate-bootstrap.',
  },
  {
    // opencode.ai/docs/mcp-servers · /skills · /commands · /rules
    id: 'opencode',
    label: 'opencode',
    docs: ['https://opencode.ai/docs/mcp-servers/', 'https://opencode.ai/docs/skills/', 'https://opencode.ai/docs/commands/', 'https://opencode.ai/docs/rules/'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'verified', instructions: ['AGENTS.md'] },
    envSyntax: '{env:VAR}',
    detect: (ctx) => existsSync(at(ctx, '.config', 'opencode')) || onPath(ctx, 'opencode'),
    userMcp: (ctx) => ({ file: at(ctx, '.config', 'opencode', 'opencode.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, 'opencode.json'), format: 'json' }),
    // Current shape is `mcp.servers.<name>`; a file still on the older `mcp.<name>` shape keeps it.
    jsonPath: (s, existing, file) => {
      const mcp = existing ? (jsonGet(file, existing, ['mcp']) as Record<string, unknown> | undefined) : undefined;
      const legacy = !!mcp && Object.keys(mcp).some((k) => k !== 'servers');
      return legacy ? ['mcp', s.name] : ['mcp', 'servers', s.name];
    },
    entry: (s) => ({ type: 'remote', url: s.url, oauth: false, headers: bearer(`{env:${s.envVar}}`) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    commands: { user: (ctx, n) => at(ctx, '.config', 'opencode', 'commands', `${n}.md`), project: (repo, n) => path.join(repo, '.opencode', 'commands', `${n}.md`), render: markdownCommand },
    legacyCommands: (ctx) => LEGACY.map((n) => at(ctx, '.config', 'opencode', 'commands', `mandate-${n}.md`)),
  },
  {
    // junie.jetbrains.com/docs/junie-cli-mcp-configuration.html · /agent-skills.html · /custom-slash-commands.html · /guidelines-and-memory.html
    // No env-var expansion: the key is written literally into the user-scope file only (never a repo).
    id: 'junie',
    label: 'JetBrains Junie',
    docs: ['https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html', 'https://junie.jetbrains.com/docs/agent-skills.html', 'https://junie.jetbrains.com/docs/custom-slash-commands.html'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'unverified', instructions: ['AGENTS.md'] },
    envSyntax: null,
    detect: (ctx) => existsSync(at(ctx, '.junie')) || onPath(ctx, 'junie'),
    userMcp: (ctx) => ({ file: at(ctx, '.junie', 'mcp', 'mcp.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ url: s.url, headers: literal(s) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    // Argument placeholder syntax is not documented: written only with --force.
    commands: { user: (ctx, n) => at(ctx, '.junie', 'commands', `${n}.md`), project: (repo, n) => path.join(repo, '.junie', 'commands', `${n}.md`), render: markdownCommand },
  },
  {
    // ampcode.com/docs/customize/mcp · /skills · /agents-md (custom commands were removed in favour of skills)
    id: 'amp',
    label: 'Amp',
    docs: ['https://ampcode.com/docs/customize/mcp', 'https://ampcode.com/docs/customize/skills', 'https://ampcode.com/docs/customize/agents-md'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'unsupported', instructions: ['AGENTS.md'] },
    envSyntax: '${VAR}',
    detect: (ctx) => existsSync(at(ctx, '.config', 'amp')) || onPath(ctx, 'amp'),
    userMcp: (ctx) => ({ file: at(ctx, '.config', 'amp', 'settings.json'), format: 'json' }),
    projectMcp: (repo) => ({ file: path.join(repo, '.amp', 'settings.json'), format: 'json' }),
    jsonPath: (s) => ['amp.mcpServers', s.name],
    entry: (s) => ({ url: s.url, headers: bearer(`\${${s.envVar}}`) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    note: 'No slash commands: the skills are invoked by name; MCP prompts as fallback.',
  },
  {
    // goose-docs.ai/docs/guides/config-files · /context-engineering/using-skills · /using-goosehints
    // MCP lives in YAML (~/.config/goose/config.yaml `extensions:`): printed for the user to add (manual), not edited.
    id: 'goose',
    label: 'Goose',
    docs: ['https://goose-docs.ai/docs/guides/config-files', 'https://goose-docs.ai/docs/guides/context-engineering/using-skills', 'https://goose-docs.ai/docs/guides/context-engineering/using-goosehints'],
    caps: { mcp: 'manual', skills: 'verified', commands: 'unsupported', instructions: ['AGENTS.md'] },
    envSyntax: null,
    detect: (ctx) => existsSync(at(ctx, '.config', 'goose')) || onPath(ctx, 'goose'),
    entry: (s) => `extensions:\n  ${s.name}:\n    type: streamable_http\n    name: ${s.name}\n    enabled: true\n    uri: ${s.url}\n    headers:\n      Authorization: "Bearer <your ${s.envVar} key>"\n    timeout: 300`,
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    note: 'MCP: add the mandate-<project> extension to ~/.config/goose/config.yaml (mandate connect prints it).',
  },
  {
    // docs.cline.bot/mcp/configuring-mcp-servers · /customization/skills · /customization/cline-rules
    // No env-var expansion: literal key in the user-scope CLI settings only. Does not read ~/.agents/skills.
    id: 'cline',
    label: 'Cline',
    docs: ['https://docs.cline.bot/mcp/configuring-mcp-servers', 'https://docs.cline.bot/customization/skills', 'https://docs.cline.bot/customization/cline-rules'],
    caps: { mcp: 'verified', skills: 'verified', commands: 'unsupported', instructions: ['AGENTS.md'] },
    envSyntax: null,
    detect: (ctx) => existsSync(at(ctx, '.cline')) || onPath(ctx, 'cline'),
    userMcp: (ctx) => ({ file: ctx.env.CLINE_MCP_SETTINGS_PATH || at(ctx, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), format: 'json' }),
    jsonPath: (s) => ['mcpServers', s.name],
    entry: (s) => ({ type: 'streamableHttp', url: s.url, headers: literal(s), disabled: false }),
    skillDirs: (ctx) => [at(ctx, '.cline', 'skills', 'mandate')],
    note: 'No slash commands (workflows have no argument syntax): use the MCP prompts.',
  },
  {
    // zed.dev/docs/ai/mcp · /ai/skills · /ai/instructions — the user settings path is not stated in the docs.
    id: 'zed',
    label: 'Zed',
    docs: ['https://zed.dev/docs/ai/mcp', 'https://zed.dev/docs/ai/skills', 'https://zed.dev/docs/ai/instructions'],
    caps: { mcp: 'unverified', skills: 'verified', commands: 'unsupported', instructions: ['AGENTS.md'] },
    envSyntax: null,
    detect: (ctx) => existsSync(at(ctx, '.config', 'zed')) || onPath(ctx, 'zed'),
    userMcp: (ctx) => ({ file: at(ctx, '.config', 'zed', 'settings.json'), format: 'json' }),
    jsonPath: (s) => ['context_servers', s.name],
    entry: (s) => ({ url: s.url, headers: literal(s) }),
    skillDirs: (ctx) => [AGENTS_SKILLS(ctx)],
    note: 'Zed reads only the first instructions file it finds (.rules first); skills in ~/.agents/skills.',
  },
];

/** Whether Mandate writes this capability for the agent (unverified ones only with --force). */
export const can = (a: AgentDef, cap: 'mcp' | 'skills' | 'commands', force = false) => a.caps[cap] === 'verified' || (force && a.caps[cap] === 'unverified');

export function vscodeUserDir(ctx: Ctx): string {
  if (ctx.platform === 'darwin') return at(ctx, 'Library', 'Application Support', 'Code', 'User');
  if (ctx.platform === 'win32') return path.join(ctx.env.APPDATA ?? at(ctx, 'AppData', 'Roaming'), 'Code', 'User');
  return path.join(ctx.env.XDG_CONFIG_HOME || at(ctx, '.config'), 'Code', 'User');
}

/** Short names accepted by --agents. */
const ALIASES: Record<string, string> = { claude: 'claude-code', copilot: 'vscode', 'vs-code': 'vscode', devin: 'windsurf', 'gemini-cli': 'gemini' };
export const agentById = (id: string) => AGENTS.find((a) => a.id === (ALIASES[id.toLowerCase()] ?? id.toLowerCase()));
/** Detected agents among the supported ones (SUPPORTED_AGENTS); `all` includes hidden agents too (cleanup). */
export const detectAgents = (ctx: Ctx, supported: readonly string[] = SUPPORTED_AGENTS) => AGENTS.filter((a) => isSupportedAgent(a.id, supported) && a.detect(ctx));

/* ------------------------------------------------------------------ MCP entry changes */

/** The MCP URL an agent gets: clients that ignore tools/list_changed list every tool set from the start. */
export const agentUrl = (agent: AgentDef, url: string) => (agent.listChanged || /[?&]tools=/.test(url) ? url : `${url}?tools=all`);
const forAgent = (agent: AgentDef, s: Server): Server => ({ ...s, url: agentUrl(agent, s.url) });

/** opencode's legacy shape needs `enabled` instead of `oauth`. */
function entryFor(agent: AgentDef, s: Server, keyPath: string[]): unknown {
  const e = oauthEntry(agent.entry(forAgent(agent, s)), s) as Record<string, unknown>;
  if (agent.id === 'opencode' && keyPath.length === 2) {
    const { oauth: _o, ...rest } = e;
    return { ...rest, enabled: true };
  }
  return e;
}

/** connect --repo: this agent gets the project-scope entry, which replaces its user-scope entry of the same project. */
export const projectScopeOnly = (agent: AgentDef, force: boolean | undefined, repo: string, ctx: Ctx) => !!agent.projectMcp?.(repo, ctx) && can(agent, 'mcp', force) && agent.envSyntax !== null && !agent.keepUserScope;

/** Agents whose MCP client signs in by itself (MCP OAuth), per their docs; the others need a personal token. */
export const OAUTH_AGENTS = new Set(['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode']);

/** An MCP OAuth entry: the same entry without the Authorization header (TOML: without bearer_token_env_var). */
export function oauthEntry(e: unknown, s: Server): unknown {
  if (!s.oauth) return e;
  if (typeof e === 'string') return e.replace(/\nbearer_token_env_var = [^\n]*/, '');
  const { headers: _h, ...rest } = e as Record<string, unknown>;
  const { oauth: _o, ...auto } = rest; // opencode: without `oauth: false` it detects OAuth by itself
  return auto;
}

/** New text with the server entry added / updated (`text` = the current content, for composing several edits). */
export function mcpUpsertText(agent: AgentDef, target: McpTarget, s: Server, text: string | null): string {
  if (target.format === 'toml') {
    const tableRe = new RegExp(`^\\[mcp_servers\\.${s.name.replace(/[-]/g, '\\-')}\\]`, 'm');
    const outside = removeBlock(text, s.name, 'hash') ?? '';
    if (tableRe.test(outside)) throw new Error(`${target.file} already defines [mcp_servers.${s.name}] outside Mandate's block; remove it or leave it as is`);
    return upsertBlock(text, s.name, oauthEntry(agent.entry(forAgent(agent, s)), s) as string, 'hash');
  }
  const keyPath = agent.jsonPath!(s, text, target.file);
  return jsonSet(target.file, text, keyPath, entryFor(agent, s, keyPath));
}

/**
 * Write THE Mandate server of a config file: other Mandate entries in it (named mandate-*, or pointing at
 * /p/<id>/mcp on the same server) are replaced, so the agent sees Mandate's tools once. Other servers stay untouched.
 */
export function mcpUpsert(agent: AgentDef, target: McpTarget, s: Server): Change | null {
  let text = readText(target.file);
  const replaced = mandateServersIn(agent, target, new URL(s.url).origin).filter((n) => n !== s.name);
  for (const n of replaced) text = removeEntryText(agent, target, text ?? '', n);
  text = mcpUpsertText(agent, target, s, text);
  // A literal key (agents without env-var expansion) makes the file private (0600).
  return change(target.file, text, `MCP server ${s.name}${replaced.length ? `; replaced ${replaced.join(', ')}` : ''}`, { private: !!s.key });
}

/** The text without one server entry (managed TOML block, or the JSON entry at any of the agent's key paths). */
function removeEntryText(agent: AgentDef, target: McpTarget, text: string, name: string): string {
  if (target.format === 'toml') return removeBlock(text, name, 'hash') ?? text;
  let after = text;
  for (const p of [agent.jsonPath!({ name } as Server, after, target.file), ['mcp', name], ['mcp', 'servers', name]]) after = jsonRemove(target.file, after, p) ?? after;
  return after;
}

export function mcpRemove(agent: AgentDef, target: McpTarget, ...names: string[]): Change | null {
  const text = readText(target.file);
  if (text === null) return null;
  let after: string = text;
  for (const name of names) after = removeEntryText(agent, target, after, name);
  if (after === text) return null;
  const empty = target.format === 'toml' ? !after.trim() : after.trim() === '{}';
  return change(target.file, empty ? null : after, `MCP server ${names.join(', ')}`);
}

/** A Mandate project endpoint URL (`<origin>/p/<id>/mcp`, optional query). */
const MANDATE_URL = /^(https?:\/\/[^/]+)\/p\/[a-z0-9-]+\/mcp\/?(\?.*)?$/;

/**
 * Names of Mandate servers present in a target (uninstall, replacing): entries named mandate-*, and with `origin`,
 * entries of any name whose URL is a project endpoint of that server.
 */
export function mandateServersIn(agent: AgentDef, target: McpTarget, origin?: string): string[] {
  const text = readText(target.file);
  if (text === null) return [];
  if (target.format === 'toml') return [...text.matchAll(/# >>> mandate:begin (mandate-[a-z0-9-]+)/g)].map((m) => m[1]!);
  const names = new Set<string>();
  const own = agent.jsonPath ? agent.jsonPath({ name: 'x' } as Server, text, target.file).slice(0, -1) : [];
  for (const p of [own, ['mcpServers'], ['servers'], ['mcp'], ['mcp', 'servers']]) {
    let v: unknown;
    try {
      v = jsonGet(target.file, text, p);
    } catch {
      return [];
    }
    if (v && typeof v === 'object')
      for (const [k, e] of Object.entries(v)) {
        if (/^mandate-[a-z0-9-]+$/.test(k)) names.add(k);
        else if (origin && e && typeof e === 'object') {
          const url = ['url', 'httpUrl', 'serverUrl', 'uri'].map((f) => (e as Record<string, unknown>)[f]).find((x): x is string => typeof x === 'string');
          if (url && MANDATE_URL.exec(url)?.[1] === origin) names.add(k);
        }
      }
  }
  return [...names];
}

/* ------------------------------------------------------------------ skills and commands */

/** The skills: the master `mandate` skill and the separate `mandate-bootstrap` skill, next to each other. */
export const SKILLS = [
  { name: 'mandate', md: () => skillMd() },
  { name: 'mandate-bootstrap', md: () => bootstrapSkillMd() },
];

export function skillChanges(ctx: Ctx, agents: AgentDef[], remove = false, keepRoots: string[] = []): (Change | null)[] {
  const roots = [...new Set(agents.filter((a) => remove || can(a, 'skills', ctx.force)).flatMap((a) => a.skillDirs(ctx)).map((d) => path.dirname(d)))].filter((r) => !keepRoots.includes(r));
  return roots.flatMap((root) =>
    SKILLS.map((sk) => {
      const file = path.join(root, sk.name, 'SKILL.md');
      const cur = readText(file);
      if (remove) return cur?.includes(MANAGED_MARK) ? change(file, null, 'Agent Skill') : null;
      if (cur !== null && !cur.includes(MANAGED_MARK)) throw new Error(`${file} exists and is not managed by Mandate; leaving it alone`);
      return change(file, sk.md(), 'Agent Skill');
    }),
  );
}

/** User scope: the slash commands (install), or their removal plus earlier versions' commands (uninstall). */
export function commandChanges(ctx: Ctx, agents: AgentDef[], remove = false): (Change | null)[] {
  const out: (Change | null)[] = [];
  for (const a of agents) {
    const spec = a.commands;
    if (spec?.user && (remove || can(a, 'commands', ctx.force))) for (const c of COMMANDS) out.push(commandFileChange(spec.user(ctx, c.name), remove ? null : spec.render(c), `${a.label} slash commands`));
    if (remove) for (const f of a.legacyCommands?.(ctx) ?? []) out.push(commandFileChange(f, null, `${a.label} slash commands`));
  }
  return out;
}

/** Project scope (connect / disconnect): the slash commands inside a repo. */
export function projectCommandChanges(repo: string, agents: AgentDef[], remove = false, force = false): (Change | null)[] {
  const out: (Change | null)[] = [];
  for (const a of agents) {
    const spec = a.commands;
    if (spec?.project && (remove || can(a, 'commands', force))) for (const c of COMMANDS) out.push(commandFileChange(spec.project(repo, c.name), remove ? null : spec.render(c), `${a.label} slash commands`));
  }
  return out;
}

/** One managed command file: written (`content`), or removed (null) only while it still carries the managed mark. */
export function commandFileChange(file: string, content: string | null, summary: string): Change | null {
  const cur = readText(file);
  if (content === null) return cur?.includes(MANAGED_MARK) ? change(file, null, summary) : null;
  if (cur !== null && !cur.includes(MANAGED_MARK)) return null; // the user's own command with that name
  return change(file, content, summary);
}
