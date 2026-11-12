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
      id: 'codex',
      label: 'Codex',
      where: '~/.codex/config.toml',
      language: 'toml',
      code: `[mcp_servers.${name}]\nurl = ${sh(url)}\nhttp_headers = { "Authorization" = ${sh(`Bearer ${key}`)} }`,
      note: 'Or keep the key out of the file: bearer_token_env_var = "MANDATE_KEY" and export MANDATE_KEY.',
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
