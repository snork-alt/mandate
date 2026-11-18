/**
 * The coding agents of the Connect dialog, mirroring the CLI's adapter registry (packages/cli/src/agents.ts): the
 * `--agents` id, whether the agent signs in with GitHub by itself (MCP OAuth, `OAUTH_AGENTS`), the files the installer
 * writes (skills, slash commands, instructions) and the manual MCP entry. Pure data and builders, no React.
 */
import { isSupportedAgent, SUPPORTED_AGENTS } from '@mandate/shared';
import { agentGuides, genericSnippet, keyEnvVar, serverName, type Snippet } from './snippets';

export type AgentTabId = 'claude-code' | 'codex' | 'cursor' | 'vscode' | 'gemini' | 'windsurf' | 'opencode' | 'junie' | 'amp' | 'goose' | 'cline' | 'zed';

export interface AgentFiles {
  /** Skill directories (the `mandate` and `mandate-bootstrap` skills sit next to each other). */
  skills: string[];
  /** Where the `/mandate-flow` and `/mandate-bootstrap` commands go, and how they are typed; null: no slash commands. */
  commands: { dir: string; names: string } | null;
  /** Why there are no commands (MCP prompts instead). */
  commandsNote?: string;
  /** Instructions file in the code repository ("Use Mandate" section). */
  instructions: string;
}

export interface AgentDef {
  id: AgentTabId;
  label: string;
  /** Signs in with GitHub by itself (MCP OAuth); the others need a personal token (`--auth token`). */
  oauth: boolean;
  /** The CLI does not write its MCP entry (manual / unverified config location): add it by hand. */
  manualMcp?: string;
  /** First tabs (the rest under "More"). */
  main: boolean;
  files: AgentFiles;
  /** The command to run in the agent to start the flow (shown after "Then ask"). */
  flowCommand?: string;
}

const AGENTS_SKILLS = '~/.agents/skills/mandate';
const SLASH = '/mandate, /mandate-flow, /mandate-bootstrap';

export const ALL_AGENT_DEFS: AgentDef[] = [
  { id: 'claude-code', label: 'Claude Code', oauth: true, main: true, files: { skills: ['~/.claude/skills/mandate'], commands: { dir: '~/.claude/commands/', names: SLASH }, instructions: 'CLAUDE.md' }, flowCommand: '/mandate-flow' },
  { id: 'codex', label: 'Codex', oauth: true, main: true, files: { skills: [AGENTS_SKILLS], commands: { dir: '~/.codex/prompts/', names: '/prompts:mandate, /prompts:mandate-flow, /prompts:mandate-bootstrap' }, instructions: 'AGENTS.md' }, flowCommand: '/prompts:mandate-flow' },
  { id: 'cursor', label: 'Cursor', oauth: true, main: true, files: { skills: [AGENTS_SKILLS], commands: { dir: '~/.cursor/commands/', names: SLASH }, instructions: 'AGENTS.md' }, flowCommand: '/mandate-flow' },
  { id: 'vscode', label: 'VS Code', oauth: true, main: true, files: { skills: [AGENTS_SKILLS, '~/.copilot/skills/mandate'], commands: { dir: '.github/prompts/ (prompt files, in your code repository)', names: SLASH }, instructions: 'AGENTS.md' }, flowCommand: '/mandate-flow' },
  { id: 'gemini', label: 'Gemini CLI', oauth: true, main: true, files: { skills: [AGENTS_SKILLS], commands: { dir: '~/.gemini/commands/', names: SLASH }, instructions: 'GEMINI.md' }, flowCommand: '/mandate-flow' },
  { id: 'windsurf', label: 'Windsurf', oauth: true, main: true, files: { skills: [AGENTS_SKILLS], commands: null, commandsNote: 'No slash commands (workflows are deprecated): use the MCP prompts mandate-flow / mandate-bootstrap.', instructions: 'AGENTS.md' } },
  { id: 'opencode', label: 'opencode', oauth: true, main: true, files: { skills: [AGENTS_SKILLS], commands: { dir: '~/.config/opencode/commands/', names: SLASH }, instructions: 'AGENTS.md' }, flowCommand: '/mandate-flow' },
  { id: 'junie', label: 'JetBrains Junie', oauth: false, main: false, files: { skills: [AGENTS_SKILLS], commands: { dir: '~/.junie/commands/', names: SLASH }, instructions: 'AGENTS.md' } },
  { id: 'amp', label: 'Amp', oauth: false, main: false, files: { skills: [AGENTS_SKILLS], commands: null, commandsNote: 'No slash commands: the skills are invoked by name; MCP prompts as fallback.', instructions: 'AGENTS.md' } },
  {
    id: 'goose',
    label: 'Goose',
    oauth: false,
    main: false,
    manualMcp: 'The installer does not edit Goose’s config: add the extension below to ~/.config/goose/config.yaml.',
    files: { skills: [AGENTS_SKILLS], commands: null, commandsNote: 'No slash commands: use the MCP prompts mandate-flow / mandate-bootstrap.', instructions: 'AGENTS.md' },
  },
  { id: 'cline', label: 'Cline', oauth: false, main: false, files: { skills: ['~/.cline/skills/mandate'], commands: null, commandsNote: 'No slash commands (workflows have no argument syntax): use the MCP prompts.', instructions: 'AGENTS.md' } },
  {
    id: 'zed',
    label: 'Zed',
    oauth: false,
    main: false,
    manualMcp: 'Zed’s settings path is not documented, so the installer skips the MCP entry (add --force to write ~/.config/zed/settings.json), or add it by hand.',
    files: { skills: [AGENTS_SKILLS], commands: null, commandsNote: 'No slash commands. Zed reads only the first instructions file it finds (.rules first).', instructions: 'AGENTS.md' },
  },
];

/** The agents the UI offers: only SUPPORTED_AGENTS (the shared switch); the others stay defined but hidden. */
export const visibleAgents = (supported: readonly string[] = SUPPORTED_AGENTS): AgentDef[] => ALL_AGENT_DEFS.filter((a) => isSupportedAgent(a.id, supported));
export const AGENT_DEFS: AgentDef[] = visibleAgents();
export const MAIN_AGENTS = AGENT_DEFS.filter((a) => a.main);
export const MORE_AGENTS = AGENT_DEFS.filter((a) => !a.main);
export const agentDef = (id: string) => AGENT_DEFS.find((a) => a.id === id) ?? AGENT_DEFS[0]!;
/** One line for the dialog while only some agents are enabled (null when every agent is). */
export const SUPPORT_NOTE: string | null = AGENT_DEFS.length < ALL_AGENT_DEFS.length ? `Mandate currently supports ${AGENT_DEFS.map((a) => a.label).join(', ')}. Other coding agents are planned.` : null;

/** Flags for the one-liner: the agent, plus `--auth token` for agents that cannot sign in by themselves. */
export const installFlags = (a: AgentDef, oauthServer: boolean) => `--agents ${a.id}${oauthServer && !a.oauth ? ' --auth token' : ''}`;

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Manual registration, team (MCP OAuth): no header, the agent signs in itself. Agents without OAuth: see `tokenEntry`. */
export function oauthRegistration(a: AgentDef, project: string, url: string): { steps: Snippet[]; verify: string } | null {
  const name = serverName(project);
  const s = (id: string, where: string, language: Snippet['language'], code: string): Snippet => ({ id, label: a.label, where, language, code });
  switch (a.id) {
    case 'claude-code':
      return { steps: [s('claude-code', 'terminal · add --scope user for every repository', 'bash', `claude mcp add --transport http ${name} ${url}`)], verify: `run /mcp in Claude Code: ${name} shows “authenticate”; pick it and your browser opens GitHub sign-in.` };
    case 'codex':
      return {
        steps: [s('codex-add', 'terminal', 'bash', `codex mcp add ${name} --url ${url}`), s('codex-login', 'terminal (opens GitHub sign-in in the browser)', 'bash', `codex mcp login ${name}`)],
        verify: `run \`codex mcp list\`: ${name} is listed and logged in.`,
      };
    case 'cursor':
      return { steps: [s('cursor', '~/.cursor/mcp.json (or .cursor/mcp.json)', 'json', json({ mcpServers: { [name]: { url } } }))], verify: `Cursor Settings → MCP: click “Needs login” next to ${name}.` };
    case 'vscode':
      return { steps: [s('vscode', '.vscode/mcp.json (or your user mcp.json)', 'json', json({ servers: { [name]: { type: 'http', url } } }))], verify: `start ${name} from the MCP view; VS Code asks you to sign in with GitHub.` };
    case 'gemini':
      return { steps: [s('gemini', '~/.gemini/settings.json', 'json', json({ mcpServers: { [name]: { httpUrl: url } } }))], verify: `run /mcp in Gemini CLI: ${name} asks you to sign in; then it is connected.` };
    case 'windsurf':
      return { steps: [s('windsurf', '~/.codeium/windsurf/mcp_config.json', 'json', json({ mcpServers: { [name]: { serverUrl: url } } }))], verify: `Cascade → MCP servers: ${name} opens GitHub sign-in on first use, then is enabled.` };
    case 'opencode':
      return { steps: [s('opencode', '~/.config/opencode/opencode.json (or opencode.json)', 'json', json({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'remote', url, enabled: true } } }))], verify: `run \`opencode mcp list\`: ${name} is connected after the browser sign-in.` };
    default:
      return null;
  }
}

/** Manual entry with a key / personal token (`key` may be a placeholder or a masked value). */
export function tokenEntry(a: AgentDef, input: { project: string; url: string; key: string }): { env?: string; register: Snippet; verify: string } {
  const env = keyEnvVar(input.project);
  const guide = agentGuides({ ...input, envVar: env }).find((g) => g.id === a.id);
  if (guide) return { env: guide.env, register: guide.register, verify: guide.verify };
  const name = serverName(input.project);
  const auth = { Authorization: `Bearer ${input.key}` };
  const s = (where: string, language: Snippet['language'], code: string): Snippet => ({ id: a.id, label: a.label, where, language, code });
  switch (a.id) {
    case 'junie':
      return { register: s('~/.junie/mcp/mcp.json (user scope only; never in a repository)', 'json', json({ mcpServers: { [name]: { url: input.url, headers: auth } } })), verify: `Junie → MCP settings: ${name} is connected.` };
    case 'amp':
      return { env: `export ${env}=${input.key}`, register: s('~/.config/amp/settings.json', 'json', json({ 'amp.mcpServers': { [name]: { url: input.url, headers: { Authorization: `Bearer \${${env}}` } } } })), verify: `run \`amp mcp list\`: ${name} is listed.` };
    case 'goose':
      return {
        register: s('~/.config/goose/config.yaml', 'bash', `extensions:\n  ${name}:\n    type: streamable_http\n    name: ${name}\n    enabled: true\n    uri: ${input.url}\n    headers:\n      Authorization: "Bearer ${input.key}"\n    timeout: 300`),
        verify: `run \`goose\` and ask for its extensions: ${name} is enabled.`,
      };
    case 'cline':
      return { register: s('~/.cline/data/settings/cline_mcp_settings.json (user scope only)', 'json', json({ mcpServers: { [name]: { type: 'streamableHttp', url: input.url, headers: auth, disabled: false } } })), verify: `Cline → MCP Servers: ${name} shows a green dot.` };
    case 'zed':
      return { register: s('~/.config/zed/settings.json (user scope only)', 'json', json({ context_servers: { [name]: { url: input.url, headers: auth } } })), verify: `Zed → Agent panel → settings: ${name} is active.` };
    default:
      return { register: genericSnippet(input), verify: 'Check the agent’s MCP server list.' };
  }
}
