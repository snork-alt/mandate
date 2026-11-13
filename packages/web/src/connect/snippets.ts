/**
 * "Connect agent" snippets: how to point a coding agent at a project's MCP endpoint (Streamable HTTP + bearer key).
 * Pure builders: the popup renders them with the key masked and copies them with the real key.
 */

export interface SnippetInput {
  /** Project id (the server name becomes `mandate-<id>`). */
  project: string;
  /** Absolute MCP URL of the project. */
  url: string;
  /** The key (or a masked placeholder for display). */
  key: string;
  /** Env var for the key in Claude Code / Codex guides (default `MANDATE_KEY_<ID>`). */
  envVar?: string;
}

export interface Snippet {
  id: string;
  label: string;
  /** Where the snippet goes (file path or "terminal"). */
  where: string;
  language: 'json' | 'toml' | 'bash';
  code: string;
  note?: string;
}

/** MCP server name used in every snippet. */
export const serverName = (project: string) => `mandate-${project}`;

/** `mnd_proj_abcdef…` -> `mnd_proj_••••••••wxyz`: prefix (incl. project) and last 4 kept. */
export function maskKey(key: string): string {
  const m = /^(mnd_[a-z0-9-]+_)(.*)$/.exec(key);
  const prefix = m ? m[1]! : key.slice(0, 4);
  const rest = m ? m[2]! : key.slice(4);
  if (rest.length <= 4) return `${prefix}${'•'.repeat(rest.length)}`;
  return `${prefix}${'•'.repeat(12)}${rest.slice(-4)}`;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
/** Double-quoted shell string (keys are base64url, but be safe). */
const sh = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

/** The generic config (shown first): most agents accept this `mcpServers` shape. */
export function genericSnippet({ project, url, key }: SnippetInput): Snippet {
  return {
    id: 'generic',
    label: 'Generic JSON',
    where: "your coding agent's MCP config",
    language: 'json',
    code: json({ mcpServers: { [serverName(project)]: { type: 'http', url, headers: auth(key) } } }),
  };
}

/** Per-agent examples (tabs). */
export function agentSnippets(input: SnippetInput): Snippet[] {
  const { project, url, key } = input;
  const name = serverName(project);
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: 'terminal (project scope: add --scope project)',
      language: 'bash',
      code: `claude mcp add --transport http ${name} ${url} \\\n  --header ${sh(`Authorization: Bearer ${key}`)}`,
    },
    {
      id: 'codex',
      label: 'Codex',
      where: '~/.codex/config.toml',
      language: 'toml',
      code: `[mcp_servers.${name}]\nurl = ${sh(url)}\nhttp_headers = { "Authorization" = ${sh(`Bearer ${key}`)} }`,
      note: 'Or keep the key out of the file: bearer_token_env_var = "MANDATE_KEY" and export MANDATE_KEY.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: '.cursor/mcp.json (or ~/.cursor/mcp.json)',
      language: 'json',
      code: json({ mcpServers: { [name]: { url, headers: auth(key) } } }),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      where: '.vscode/mcp.json',
      language: 'json',
      code: json({ servers: { [name]: { type: 'http', url, headers: auth(key) } } }),
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      where: '~/.gemini/settings.json',
      language: 'json',
      code: json({ mcpServers: { [name]: { httpUrl: url, headers: auth(key) } } }),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      where: '~/.codeium/windsurf/mcp_config.json',
      language: 'json',
      code: json({ mcpServers: { [name]: { serverUrl: url, headers: auth(key) } } }),
    },
    {
      id: 'opencode',
      label: 'opencode',
      where: 'opencode.json',
      language: 'json',
      code: json({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'remote', url, enabled: true, headers: auth(key) } } }),
    },
  ];
}

/**
 * Absolute MCP URL for agents. In development the UI runs on Vite and proxies to the API server; agents should talk to
 * the API server directly (`apiPort`, from the Vite config). In production the UI is served by the API itself.
 */
export function mcpUrlFor(loc: { protocol: string; hostname: string; origin: string }, mcpPath: string, apiPort?: string): string {
  if (apiPort) return `${loc.protocol}//${loc.hostname}:${apiPort}${mcpPath}`;
  return `${loc.origin}${mcpPath}`;
}

declare const __MANDATE_API_PORT__: string | undefined;
/** The API port when running under the Vite dev server (undefined in a production build). */
export const devApiPort = (): string | undefined => (import.meta.env?.DEV && typeof __MANDATE_API_PORT__ !== 'undefined' ? __MANDATE_API_PORT__ : undefined);

/** Env var holding a project's key: `MANDATE_KEY_<ID>` (dashes become underscores). */
export const keyEnvVar = (project: string) => `MANDATE_KEY_${project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** First thing to ask the agent once connected. */
export const FIRST_PROMPT = 'Use Mandate to show me the open work orders';

/** One manual setup guide (Claude Code and Codex read the key from an env var). */
export interface AgentGuide {
  id: string;
  label: string;
  /** `export MANDATE_KEY_<ID>=…` (shell profile), when the agent reads the key from the environment. */
  env?: string;
  register: Snippet;
  verify: string;
}

export function agentGuides(input: SnippetInput): AgentGuide[] {
  const { project, url, key } = input;
  const name = serverName(project);
  const env = input.envVar ?? keyEnvVar(project);
  const exportLine = `export ${env}=${key}`;
  const rest = agentSnippets(input).filter((s) => s.id !== 'claude-code' && s.id !== 'codex');
  const verify: Record<string, string> = {
    cursor: 'Cursor Settings → MCP: mandate-' + project + ' shows a green dot and its tools.',
    vscode: 'Command palette → "MCP: List Servers" → mandate-' + project + ' is running.',
    gemini: 'Run /mcp in Gemini CLI: mandate-' + project + ' is connected.',
    windsurf: 'Cascade → MCP servers: mandate-' + project + ' is enabled.',
    opencode: 'Run `opencode mcp list`: mandate-' + project + ' is connected.',
  };
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      env: exportLine,
      register: {
        id: 'claude-code',
        label: 'Claude Code',
        where: 'terminal, in your code repository (add --scope user for every repository)',
        language: 'bash',
        code: `claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: Bearer $${env}"`,
      },
      verify: 'Run /mcp inside Claude Code: ' + name + ' is listed as connected.',
    },
    {
      id: 'codex',
      label: 'Codex',
      env: exportLine,
      register: {
        id: 'codex',
        label: 'Codex',
        where: '~/.codex/config.toml',
        language: 'toml',
        code: `[mcp_servers.${name}]\nurl = "${url}"\nbearer_token_env_var = "${env}"`,
      },
      verify: 'Run `codex mcp list`: ' + name + ' is listed.',
    },
    ...rest.map((s) => ({ id: s.id, label: s.label, register: s, verify: verify[s.id] ?? 'Check the agent’s MCP server list.' })),
  ];
}

/** The recommended path: the Mandate CLI wires the agent up in the current code repository. */
export const connectCommand = (project: string) => `mandate connect --project ${project}`;

/** Env var for a personal token (team): the same `MANDATE_KEY_<ID>` the CLI exports (env.sh) and Mandate's upload curl reads. */
export const tokenEnvVar = keyEnvVar;

/** Team: agents that sign in with GitHub themselves (MCP OAuth discovery); no key to copy. */
export interface OAuthGuide {
  id: string;
  label: string;
  steps: Snippet[];
  verify: string;
}

export function oauthGuides(project: string, url: string): OAuthGuide[] {
  const name = serverName(project);
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      steps: [{ id: 'claude-code', label: 'Claude Code', where: 'terminal (add --scope user for every repository)', language: 'bash', code: `claude mcp add --transport http ${name} ${url}` }],
      verify: `Run /mcp in Claude Code: ${name} shows “authenticate”. Pick it; your browser opens GitHub sign-in.`,
    },
    {
      id: 'codex',
      label: 'Codex',
      steps: [
        { id: 'codex-add', label: 'Codex', where: 'terminal', language: 'bash', code: `codex mcp add ${name} --url ${url}` },
        { id: 'codex-login', label: 'Codex login', where: 'terminal (opens GitHub sign-in in the browser)', language: 'bash', code: `codex mcp login ${name}` },
      ],
      verify: `Run \`codex mcp list\`: ${name} is listed and logged in.`,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      steps: [{ id: 'cursor', label: 'Cursor', where: '.cursor/mcp.json (or ~/.cursor/mcp.json)', language: 'json', code: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2) }],
      verify: `Cursor Settings → MCP: click “Needs login” next to ${name}.`,
    },
    {
      id: 'vscode',
      label: 'VS Code',
      steps: [{ id: 'vscode', label: 'VS Code', where: '.vscode/mcp.json', language: 'json', code: JSON.stringify({ servers: { [name]: { type: 'http', url } } }, null, 2) }],
      verify: `Start ${name} from the MCP view; VS Code asks you to sign in with GitHub.`,
    },
  ];
}

/** True for URLs only reachable from this machine (localhost, 127.x, ::1, 0.0.0.0). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** One line under the MCP URL: whether remote agents can reach it (E1). */
export const urlReachNote = (url: string, withKey = false): string =>
  isLoopbackUrl(url)
    ? 'This URL works on this machine only. Set a public URL in Settings to connect remote agents.'
    : `This URL is public: remote agents, including ChatGPT connectors that need a public HTTPS MCP URL, can connect${withKey ? ' with the key' : ''}.`;

/* ------------------------------------------------------------------ one-line installer */

export type InstallShell = 'sh' | 'powershell';

/** Windows browsers get the PowerShell one-liner first. */
export const shellFor = (userAgent: string): InstallShell => (/Windows/i.test(userAgent) ? 'powershell' : 'sh');

/** `curl -fsSL <base>/p/<id>/install.sh | sh` (or `irm …/install.ps1 | iex`): installs the getmandate CLI from the
 * server, then connects the agents; no token in it, ever. `flags` (e.g. `--agents codex`) go to `getmandate connect`:
 * `sh -s -- <flags>`, or on Windows `& ([scriptblock]::Create((irm …/install.ps1))) <flags>` (the form install.ps1 documents). */
export function installCommand(base: string, project: string, shell: InstallShell, flags = ''): string {
  const root = `${base.replace(/\/+$/, '')}/p/${project}`;
  const f = flags.trim();
  if (shell === 'sh') return f ? `curl -fsSL ${root}/install.sh | sh -s -- ${f}` : `curl -fsSL ${root}/install.sh | sh`;
  return f ? `& ([scriptblock]::Create((irm ${root}/install.ps1))) ${f}` : `irm ${root}/install.ps1 | iex`;
}

/** Removes the agent wiring (`getmandate uninstall`) and the CLI the installer put on the machine. */
export function uninstallCommand(base: string, shell: InstallShell): string {
  const root = base.replace(/\/+$/, '');
  return shell === 'sh' ? `curl -fsSL ${root}/uninstall.sh | sh` : `irm ${root}/uninstall.ps1 | iex`;
}

/** Download, check the published SHA-256, then run (for people who do not pipe into a shell). */
export function verifyCommands(base: string, project: string, shell: InstallShell, flags = ''): string {
  const root = `${base.replace(/\/+$/, '')}/p/${project}`;
  const f = flags.trim() ? ` ${flags.trim()}` : '';
  return shell === 'sh'
    ? `curl -fsSLO ${root}/install.sh\ncurl -fsSL ${root}/install.sh.sha256 | shasum -a 256 -c -\nsh install.sh${f}`
    : `irm ${root}/install.ps1 -OutFile install.ps1\n(Get-FileHash install.ps1 -Algorithm SHA256).Hash.ToLower() -eq (irm ${root}/install.ps1.sha256).Split(' ')[0]\n.\\install.ps1${f}`;
}
