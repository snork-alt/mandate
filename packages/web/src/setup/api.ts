/** Setup wizard + Settings: server contract (`/ui/setup/*`, `/ui/fs/*`, `/ui/projects/local`). Secrets are write-only. */
import { useQuery } from '@tanstack/react-query';
import { uiRequest, uiStream } from '../lib/ui';
import type { ProjectSummary } from '../connect/projects';

export type AskProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

export interface AskModelConfig {
  id: string;
  provider: AskProvider;
  model: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  apiKeySet?: boolean;
}

export type ServerMode = 'local' | 'server';

export interface SetupConfig {
  /** Server mode only. */
  github?: {
    clientId: string | null;
    clientSecretEnv: string;
    clientSecretSet?: boolean;
    allowedUsers: string[];
    allowedOrgs: string[];
    callbackUrl: string | null;
    suggested?: { name: string; homepageUrl: string; callbackUrl: string };
  };
  /** The projects folder (local mode). */
  local: { baseDir: string };
  server: { mode: ServerMode; publicUrl: string | null; bind: string; port: number; trustProxy: boolean };
  ask: {
    default: string | null;
    models: AskModelConfig[];
    /** Limits per question (null = default). */
    maxToolCalls?: number | null;
    tokenBudget?: number | null;
    timeoutMs?: number | null;
    maxOutputTokens?: number | null;
    /** `ask.limits`: tool-result truncation (+ per-tool overrides). */
    limits?: AskLimits | null;
  };
  embedding: EmbeddingSettings;
  git: GitConfig;
  /** Server-state database (server mode, Advanced). Older servers omit it. */
  database?: DatabaseSettings;
}

export interface DatabaseSettings {
  driver: 'sqlite' | 'postgres';
  /** Env var holding the connection URL (a secret in secrets.env). */
  urlEnv: string;
  urlSet: boolean;
  pooler: 'none' | 'transaction' | 'session' | 'unknown';
  schemaPerProject: boolean | 'prefix';
  ssl: 'disable' | 'require' | 'verify-full' | null;
  prepare: boolean | null;
  extensionsSchema: string | null;
  pool: { max: number; idleTimeoutMs: number; connectionTimeoutMs: number };
  /** The backend the running server uses. */
  active: 'sqlite' | 'postgres';
}

export interface DatabaseProbe {
  ok: boolean;
  target: string;
  version?: string;
  versionNum?: number;
  pooler: DatabaseSettings['pooler'];
  ssl: boolean;
  extensions: Record<string, { installed: boolean; schema: string | null; version: string | null; available: boolean }>;
  canCreateSchema?: boolean;
  errors: string[];
  warnings: string[];
}

export type EmbeddingPreset = 'ollama' | 'openai' | 'cheaperinference' | 'custom';

export interface EmbeddingSettings {
  provider: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKeyEnv?: string | null;
  apiKeySet?: boolean;
  preset?: EmbeddingPreset | null;
  requestDimensions?: number | null;
  maxInputTokens?: number;
  batchSize?: number;
  documentPrefix?: string;
  queryPrefix?: string;
  /** A non-local endpoint: spec text leaves this machine. */
  remote?: boolean;
}

/** Per-model settings from the server's preset table. */
export interface EmbeddingModelPreset {
  family: string;
  documentPrefix: string;
  queryPrefix: string;
  maxInputTokens: number;
  batchSize: number;
  dimensions?: number;
  shortenTo?: number[];
  pricePerMTok?: number;
  known: boolean;
}

export interface EmbeddingServing {
  mode: 'current' | 'previous' | 'text-only' | 'none';
  modelId: string | null;
  model: string | null;
  note?: string;
}

export interface EmbeddingEstimate {
  chunks: number;
  tokens: number;
  avgTokens: number;
  costUsd: number | null;
  pricePerMTok: number | null;
  projects: { id: string; chunks: number; pending: number; embedded: number; serving: EmbeddingServing }[];
}

type EmbedConn = { baseUrl: string; preset?: EmbeddingPreset; apiKeyEnv?: string | null };

export interface GitConfig {
  backend: 'embedded' | 'cli';
  cliPath?: string;
  author: { name: string; email: string };
  auth: { sshKeyPath: string | null; sshPassphraseEnv: string | null; passphraseSet: boolean; username: string | null; tokenEnv: string | null; tokenSet: boolean };
  autoPush: { enabled: boolean; debounceSeconds: number; intervalSeconds: number };
  /** The installed git CLI (version null when missing). */
  system: { version: string | null; userName: string | null; userEmail: string | null };
  agentAvailable: boolean;
  /** Private keys found in ~/.ssh. */
  defaultKeys: string[];
}

export interface GitTestInput {
  url: string;
  backend: 'cli' | 'embedded';
  auth?: { sshKeyPath?: string; passphrase?: string; useAgent?: boolean; username?: string; token?: string };
}

/** `ask.limits` (per-tool override field name per the server's Ask schema). */
export interface AskLimits {
  maxToolResultTokens?: number;
  [PER_TOOL_FIELD]?: Record<string, number>;
}
export const PER_TOOL_FIELD = 'perTool' as const;

/** Defaults and ranges of the Ask limits (mirrors the server config schema). */
export const ASK_LIMITS = {
  maxToolCalls: { def: 12, min: 1, max: 50, label: 'Tool calls per question', help: 'How many tool calls (search, graph, reads) the model may make before it must answer.' },
  tokenBudget: { def: 300_000, min: 2_000, max: 2_000_000, label: 'Token budget per question', help: 'Input + output tokens across the whole question; caps the cost of one answer.' },
  timeoutMs: { def: 120_000, min: 5_000, max: 600_000, label: 'Timeout (ms)', help: 'Stop a question that runs longer than this.' },
  maxOutputTokens: { def: 16_000, min: 256, max: 64_000, label: 'Max answer tokens', help: 'Longest answer the model may write in one step.' },
  maxToolResultTokens: { def: 5_000, min: 100, max: 200_000, label: 'Max tokens per tool result', help: 'Longer tool results are truncated before the model reads them (keeps questions cheap).' },
} as const;

export interface SetupState {
  complete: boolean;
  configVersion: string;
  config: SetupConfig;
}

export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

type DatabasePatch = Partial<Pick<DatabaseSettings, 'driver' | 'urlEnv' | 'schemaPerProject' | 'ssl' | 'prepare' | 'extensionsSchema'>> & { pool?: Partial<DatabaseSettings['pool']> };
type GitPatch = { backend?: GitConfig['backend']; cliPath?: string; author?: GitConfig['author']; auth?: Partial<Pick<GitConfig['auth'], 'sshKeyPath' | 'sshPassphraseEnv' | 'username' | 'tokenEnv'>>; autoPush?: GitConfig['autoPush'] };
export type ConfigPatch = Partial<{ [K in Exclude<keyof SetupConfig, 'git' | 'database'>]: Partial<NonNullable<SetupConfig[K]>> }> & { git?: GitPatch; database?: DatabasePatch };

export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  /** With `files=1`: false for files. */
  isDir?: boolean;
}
export interface FsList {
  path: string;
  parent: string | null;
  home: string;
  entries: FsEntry[];
}
export interface FsInspect {
  path: string;
  isGitRepo: boolean;
  remote: string | null;
  branch: string | null;
  hasMandateLayout: boolean;
  /** Set when the folder is inside another repository (pick that root instead). */
  enclosingRepo?: string | null;
}

export interface LocalProjectInput {
  name: string;
  description?: string;
  mode: 'new' | 'existing';
  path?: string;
  remote?: string;
  branch?: string;
}
export const LOCAL_STEPS = ['init', 'register', 'key'] as const;
export type LocalStep = (typeof LOCAL_STEPS)[number];

const opts = { noLoginRedirect: true };
const get = <T,>(url: string) => uiRequest<T>('GET', url, undefined, opts);
const post = <T,>(url: string, body: unknown = {}) => uiRequest<T>('POST', url, body, opts);
const put = <T,>(url: string, body: unknown) => uiRequest<T>('PUT', url, body, opts);

export const setupApi = {
  state: () => get<SetupState>('/ui/setup/state'),
  checks: () => get<{ checks: SetupCheck[] }>('/ui/setup/checks'),
  patch: (configVersion: string, patch: ConfigPatch) => put<{ configVersion: string; restartRequired?: boolean }>('/ui/setup/config', { configVersion, patch }),
  secret: (name: string, value: string | null) => put<{ name: string; set: boolean }>('/ui/setup/secret', { name, value }),
  testGithub: (b: { clientId: string; clientSecret?: string }) => post<{ ok: boolean; message: string }>('/ui/setup/test/github', b),
  askModels: (b: { provider: AskProvider; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }) =>
    post<{ ok: boolean; models: string[]; suggested: string | null; message: string }>('/ui/setup/ask/models', b),
  askTest: (b: { provider: AskProvider; baseUrl?: string; apiKeyEnv?: string; apiKey?: string; model: string }) => post<{ ok: boolean; message: string; ms: number }>('/ui/setup/ask/test', b),
  embeddingDetect: () => post<{ ollama: boolean; baseUrl: string; models: string[]; hasNomic: boolean; install: string[] }>('/ui/setup/embedding/detect'),
  embeddingTest: (b: EmbedConn & { model: string; requestDimensions?: number | null; documentPrefix?: string }) =>
    post<{ ok: boolean; dimensions: number | null; ms: number; message: string; errorKind?: string; preset: EmbeddingModelPreset }>('/ui/setup/embedding/test', b),
  embeddingModels: (b: EmbedConn) =>
    post<{ ok: boolean; models: { id: string; pricePerMTok: number | null; known: boolean }[]; suggested: string | null; total: number; message: string; errorKind?: string }>('/ui/setup/embedding/models', b),
  embeddingKeys: (b: { baseUrl: string; apiKeyEnv?: string }) =>
    post<{ candidates: { askModelId: string; label: string; apiKeyEnv: string; apiKeySet: boolean }[]; apiKeyEnvSet?: boolean }>('/ui/setup/embedding/keys', b),
  embeddingPreset: (model: string) => post<EmbeddingModelPreset>('/ui/setup/embedding/preset', { model }),
  embeddingEstimate: (b: { model: string; pricePerMTok?: number | null }) => post<EmbeddingEstimate>('/ui/setup/embedding/estimate', b),
  setMode: (configVersion: string, mode: ServerMode, publicUrl?: string) => put<{ configVersion: string; restartRequired: boolean }>('/ui/setup/mode', { configVersion, mode, ...(publicUrl ? { publicUrl } : {}) }),
  complete: () => post<{ next: 'github' | 'local' }>('/ui/setup/complete'),
  databaseTest: (b: { urlEnv?: string; ssl?: DatabaseSettings['ssl']; extensionsSchema?: string | null; createExtensions?: boolean }) =>
    post<{ ok: boolean; message: string; details: DatabaseProbe | null }>('/ui/setup/database/test', b),
  fsList: (path?: string, o: { files?: boolean; hidden?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    if (o.files) q.set('files', '1');
    if (o.hidden) q.set('hidden', '1');
    const qs = q.toString();
    return get<FsList>(`/ui/fs/list${qs ? `?${qs}` : ''}`);
  },
  gitTest: (b: GitTestInput) => post<{ ok: boolean; message: string }>('/ui/setup/git/test', b),
  gitPubkey: (path: string) => get<{ publicKey: string; fingerprint: string; publicKeyPath: string }>(`/ui/setup/git/pubkey?path=${encodeURIComponent(path)}`),
  fsMkdir: (path: string) => post<{ path: string }>('/ui/fs/mkdir', { path }),
  fsInspect: (path: string) => get<FsInspect>(`/ui/fs/inspect?path=${encodeURIComponent(path)}`),
  createLocalProject: (b: LocalProjectInput, onEvent: (e: { step: LocalStep; status: 'start' | 'done' }) => void) =>
    uiStream<{ project: ProjectSummary }, { step: LocalStep; status: 'start' | 'done' }>('/ui/projects/local', b, 'project', onEvent),
};

export const useSetupState = () => useQuery({ queryKey: ['setup', 'state'], queryFn: setupApi.state, staleTime: 0 });

/** Env var names for secrets (defaults; the config may name others). */
export const SECRET_DEFAULTS = {
  github: 'MANDATE_GITHUB_CLIENT_SECRET',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  sshPassphrase: 'MANDATE_SSH_PASSPHRASE',
  gitToken: 'MANDATE_GIT_TOKEN',
} as const;

export const ASK_PRESETS: { id: string; label: string; provider: AskProvider; baseUrl: string | null; apiKeyEnv: string | null; hint: string; keyUrl?: string }[] = [
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', baseUrl: null, apiKeyEnv: SECRET_DEFAULTS.anthropic, hint: 'Claude models. Needs an API key.', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: null, apiKeyEnv: SECRET_DEFAULTS.openai, hint: 'GPT models. Needs an API key.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google', provider: 'google', baseUrl: null, apiKeyEnv: SECRET_DEFAULTS.google, hint: 'Gemini models. Needs an API key.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'ollama', label: 'Ollama (local)', provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: null, hint: 'Runs on this machine; no key, nothing leaves your computer.' },
  { id: 'compatible', label: 'OpenAI-compatible', provider: 'openai-compatible', baseUrl: '', apiKeyEnv: null, hint: 'Any server with the OpenAI API (LM Studio, vLLM, a gateway…).' },
];

/** `~/mandate-projects` for display (paths under the home dir). */
export const tildify = (p: string, home?: string | null) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** Model id for the config list: `<provider>-<model>` slugged. */
export const modelConfigId = (provider: string, model: string) =>
  `${provider}-${model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
