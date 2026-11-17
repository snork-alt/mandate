/** Setup wizard + Settings: server contract (`/ui/setup/*`, `/ui/fs/*`, `/ui/projects/local`). Secrets are write-only. */
import { useQuery } from '@tanstack/react-query';
import { uiRequest } from '../lib/ui';
import type { ProjectSummary } from '../connect/projects';

export interface GithubAppSettings {
  id: number;
  slug: string;
  owner: string | null;
  ownerType: 'User' | 'Organization' | null;
  htmlUrl: string | null;
  /** Install the app on more accounts / repositories. */
  installUrl: string;
  privateKeySet: boolean;
}

export interface SetupConfig {
  /** GitHub sign-in (always). */
  github?: {
    clientId: string | null;
    clientSecretEnv: string;
    clientSecretSet?: boolean;
    allowedUsers: string[];
    allowedOrgs: string[];
    callbackUrl: string | null;
    /** `app`: a GitHub App (one-click, the default); `oauth`: an existing OAuth App; null: not set up. */
    kind?: 'app' | 'oauth' | null;
    app?: GithubAppSettings | null;
    suggested?: { name: string; homepageUrl: string; callbackUrl: string };
  };
  /** The server address (`publicUrl` null: http://localhost:<port>). */
  server: { publicUrl: string | null; bind: string; port: number; trustProxy: boolean };
  embedding: EmbeddingSettings;
  git: GitConfig;
  /** Server-state database (Advanced). Older servers omit it. */
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
  auth: {
    sshKeyPath: string | null;
    sshPassphraseEnv: string | null;
    passphraseSet: boolean;
    username: string | null;
    tokenEnv: string | null;
    tokenSet: boolean;
    /** Saved `git.auth.method` (null: default); older servers omit it. 'app': GitHub App tokens over HTTPS. */
    method?: 'app' | 'ssh' | null;
    /** The method in effect (or an error object for an invalid value). */
    effectiveMethod?: 'app' | 'ssh' | Record<string, unknown>;
  };
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

export interface SetupState {
  complete: boolean;
  configVersion: string;
  /** An older OAuth App install (sign-in allow-list, no per-repo permissions). */
  legacy?: boolean;
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
type GitPatch = { backend?: GitConfig['backend']; cliPath?: string; author?: GitConfig['author']; auth?: Partial<Pick<GitConfig['auth'], 'sshKeyPath' | 'sshPassphraseEnv' | 'username' | 'tokenEnv'>> & { method?: 'app' | 'ssh' }; autoPush?: GitConfig['autoPush'] };
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


/** Settings the server switched live on save (no restart). */
export type AppliedSetting = 'git' | 'database';
/** How this server restarts: by its supervisor (service / foreground CLI), by `npm run dev`'s watcher, or by hand. */
export type RestartKind = 'supervised' | 'dev' | 'manual';

/** Fired after a save the server applied live (detail: AppliedSetting[]); the setup shell shows "Applied ✓". */
export const APPLIED_EVENT = 'mandate:settings-applied';
export function announceApplied(applied: AppliedSetting[] | undefined): void {
  if (applied?.length) window.dispatchEvent(new CustomEvent<AppliedSetting[]>(APPLIED_EVENT, { detail: applied }));
}

/** The running server's start time (null when /health is unreachable or does not report it). */
export async function serverStartedAt(fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await fetchFn('/health', { cache: 'no-store' });
    const h = (await r.json()) as { startedAt?: number };
    return typeof h.startedAt === 'number' ? h.startedAt : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the restarted server: /health answers with a start time other than `before`.
 * Resolves false after `timeoutMs`.
 */
export async function waitForRestart(before: number | null, o: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch; now?: () => number } = {}): Promise<boolean> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.timeoutMs ?? 30_000);
  while (now() < deadline) {
    try {
      const r = await f('/health', { cache: 'no-store' });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; startedAt?: number };
        if (h.ok && (before === null || h.startedAt !== before)) return true;
      }
    } catch {
      /* down while restarting */
    }
    await new Promise((res) => setTimeout(res, o.intervalMs ?? 1000));
  }
  return false;
}

const opts = { noLoginRedirect: true };
const get = <T,>(url: string) => uiRequest<T>('GET', url, undefined, opts);
const post = <T,>(url: string, body: unknown = {}) => uiRequest<T>('POST', url, body, opts);
const put = <T,>(url: string, body: unknown) => uiRequest<T>('PUT', url, body, opts);

export const setupApi = {
  state: () => get<SetupState>('/ui/setup/state'),
  checks: () => get<{ checks: SetupCheck[] }>('/ui/setup/checks'),
  patch: (configVersion: string, patch: ConfigPatch) => put<{ configVersion: string; applied?: AppliedSetting[]; restartRequired?: boolean }>('/ui/setup/config', { configVersion, patch }),
  secret: (name: string, value: string | null) => put<{ name: string; set: boolean; applied?: AppliedSetting[] }>('/ui/setup/secret', { name, value }),
  testGithub: (b: { clientId: string; clientSecret?: string }) => post<{ ok: boolean; message: string }>('/ui/setup/test/github', b),
  embeddingDetect: () => post<{ ollama: boolean; baseUrl: string; models: string[]; hasNomic: boolean; install: string[] }>('/ui/setup/embedding/detect'),
  embeddingTest: (b: EmbedConn & { model: string; requestDimensions?: number | null; documentPrefix?: string }) =>
    post<{ ok: boolean; dimensions: number | null; ms: number; message: string; errorKind?: string; preset: EmbeddingModelPreset }>('/ui/setup/embedding/test', b),
  embeddingModels: (b: EmbedConn) =>
    post<{ ok: boolean; models: { id: string; pricePerMTok: number | null; known: boolean }[]; suggested: string | null; total: number; message: string; errorKind?: string }>('/ui/setup/embedding/models', b),
  embeddingKeys: (b: { baseUrl: string; apiKeyEnv?: string }) =>
    post<{ apiKeyEnvSet?: boolean }>('/ui/setup/embedding/keys', b),
  embeddingPreset: (model: string) => post<EmbeddingModelPreset>('/ui/setup/embedding/preset', { model }),
  embeddingEstimate: (b: { model: string; pricePerMTok?: number | null }) => post<EmbeddingEstimate>('/ui/setup/embedding/estimate', b),
  /** The server address (applies on restart); listen address and proxy trust are derived unless given. */
  setServer: (configVersion: string, publicUrl: string, o: { bind?: string; trustProxy?: boolean } = {}) =>
    put<{ configVersion: string; restartRequired: boolean; url?: string | null; restart?: { kind: RestartKind; command: string } }>('/ui/setup/server', { configVersion, publicUrl, ...o }),
  /** Settings → Admins: who a GitHub login is (avatar, name); 404 when there is no such user. */
  githubUser: (login: string) => get<{ login: string; name: string | null; avatarUrl: string | null }>(`/ui/github/users/${encodeURIComponent(login)}`),
  /** One-click GitHub App: the form to POST to GitHub (`manifest` field) for the account (`user`) or an organization. */
  githubManifest: (b: { owner: 'user' | string; public?: boolean }) => post<{ action: string; manifest: string; state: string }>('/ui/setup/github/manifest', b),
  /** Restart the server (a new address): a supervised server restarts itself; else `command` is what to run. */
  restart: () => post<{ restarting: boolean; kind: RestartKind; command: string }>('/ui/setup/restart'),
  /** `restarting`: a new server address (saved with the GitHub App) applies now; wait for it before signing in. */
  complete: () => post<{ next: 'github'; restarting?: boolean }>('/ui/setup/complete'),
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
};

export const useSetupState = () => useQuery({ queryKey: ['setup', 'state'], queryFn: setupApi.state, staleTime: 0 });

/** Env var names for secrets (defaults; the config may name others). */
export const SECRET_DEFAULTS = {
  github: 'MANDATE_GITHUB_CLIENT_SECRET',
  openai: 'OPENAI_API_KEY',
  sshPassphrase: 'MANDATE_SSH_PASSPHRASE',
  gitToken: 'MANDATE_GIT_TOKEN',
} as const;

/** `~/mandate-projects` for display (paths under the home dir). */
export const tildify = (p: string, home?: string | null) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
