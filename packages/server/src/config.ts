import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { refreshSecrets } from './secrets.js';
import { AppInstallationTokens, githubRepoOf } from './auth/app-tokens.js';
import { DEFAULT_DATABASE_CONFIG, databaseConfigSchema, resolveDatabase, type ResolvedDatabase } from './db/config.js';

/**
 * Credentials for the git remote (resolved from the config file + env, never stored in the file).
 * - `ssh`: private key on disk (+ optional passphrase / public key path).
 * - `ssh-agent`: use keys loaded in the running ssh-agent.
 * - `https`: username + personal access token (sent as basic-auth password).
 */
export type RemoteAuth =
  | { type: 'ssh'; privateKeyPath: string; publicKeyPath?: string; passphrase?: string; username?: string }
  | { type: 'ssh-agent'; username?: string }
  | { type: 'https'; username: string; token: string }
  | GithubAppRemoteAuth;

/**
 * `git.auth.method: 'app'`: HTTPS with a short-lived GitHub App installation token, minted in memory on use
 * (see auth/app-tokens.ts). The token never lands in config, the remote URL, argv or logs.
 */
export interface GithubAppRemoteAuth {
  type: 'github-app';
  owner: string;
  repo: string;
  /** A valid installation token (cached until shortly before expiry). Throws AppNotInstalledError with the install URL. */
  token: () => Promise<string>;
  /** Forget the cached token (the remote rejected it). */
  invalidate?: () => void;
}

/** `git.auth.method`: 'app' = GitHub App installation tokens over HTTPS; 'ssh' = SSH key / agent (or `tokenEnv`). */
export const GIT_AUTH_METHODS = ['app', 'ssh'] as const;
export type GitAuthMethod = (typeof GIT_AUTH_METHODS)[number];

export interface RemoteConfig {
  url: string;
  branch: string;
  auth?: RemoteAuth;
}

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be the NAME of an environment variable (secrets are never stored in the file)')
  .nullable()
  .default(null);

export const embeddingConfigSchema = z
  .object({
    provider: z.enum(['openai-compatible', 'local', 'none']).default('openai-compatible'),
    baseUrl: z.string().url().default('http://localhost:11434/v1'),
    model: z.string().min(1).default('nomic-embed-text'),
    apiKeyEnv: envName,
    dimensions: z.number().int().positive().default(768),
    maxInputTokens: z.number().int().positive().default(2048),
    batchSize: z.number().int().positive().max(2048).default(32),
    documentPrefix: z.string().default('search_document: '),
    queryPrefix: z.string().default('search_query: '),
    /** Endpoint preset the UI picked (ollama | openai | cheaperinference | custom); informational, optional. */
    preset: z.enum(['ollama', 'openai', 'cheaperinference', 'custom']).nullable().optional(),
    /**
     * Shortened vector size sent as the `dimensions` request parameter (models that support it, e.g. OpenAI
     * text-embedding-3-*). When set, `dimensions` follows it. Null / unset: the model's full size, no parameter sent.
     */
    requestDimensions: z.number().int().min(16).max(8192).nullable().optional(),
  })
  .strict();
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
/** Embedding config with the key read from its env var; `source` (live process only) enables hot reload. */
export type ResolvedEmbeddingConfig = EmbeddingConfig & { apiKey?: string; source?: string };

/**
 * `embedding` block + `MANDATE_EMBEDDING_*` env overrides + the key from `apiKeyEnv`. `requestDimensions` wins over
 * `dimensions` (the vectors come back that size).
 */
export function resolveEmbeddingConfig(e: EmbeddingConfig, env: NodeJS.ProcessEnv, configPath: string, source?: string): ResolvedEmbeddingConfig {
  const intVar = (name: string) => {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ConfigError(configPath, [`env ${name}: expected a positive integer, got "${v}"`]);
    return n;
  };
  const embedding: ResolvedEmbeddingConfig = {
    ...e,
    provider: ((env.MANDATE_EMBEDDING_PROVIDER || undefined) as EmbeddingConfig['provider'] | undefined) ?? e.provider,
    baseUrl: env.MANDATE_EMBEDDING_BASE_URL || e.baseUrl,
    model: env.MANDATE_EMBEDDING_MODEL || e.model,
    dimensions: intVar('MANDATE_EMBEDDING_DIMENSIONS') ?? e.requestDimensions ?? e.dimensions,
    apiKey: env.MANDATE_EMBEDDING_API_KEY || (e.apiKeyEnv ? env[e.apiKeyEnv] || undefined : undefined),
  };
  if (!['openai-compatible', 'local', 'none'].includes(embedding.provider)) {
    throw new ConfigError(configPath, [`env MANDATE_EMBEDDING_PROVIDER: expected openai-compatible | local | none, got "${embedding.provider}"`]);
  }
  if (source) Object.defineProperty(embedding, 'source', { value: source, enumerable: false });
  return embedding;
}

/**
 * Models for answering questions in the web UI's Ask panel. Keys are read only from the env var `apiKeyEnv` names
 * (environment or ~/.mandate/secrets.env). Shape: `{ default, models: [{ id, label, provider, model, baseUrl, apiKeyEnv }], <limits> }`.
 * The legacy single-model shape (`provider` / `model` / `baseUrl` / `apiKeyEnv` directly under `ask`) is read as one
 * model with id `default` (nothing configured when `provider` is null).
 */
export const ASK_PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
/** Limits per question (optional; defaults in ASK_LIMITS). Set on `ask` and optionally overridden per model. */
const askLimitFields = {
  maxToolCalls: z.number().int().min(1).max(50).optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  /** Input + output tokens across the whole agent loop of one question. */
  tokenBudget: z.number().int().min(2_000).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(64_000).optional(),
  /** Hard cap (estimated tokens) of every tool result the model reads; bigger results are compacted and cut. */
  maxToolResultTokens: z.number().int().min(200).max(50_000).optional(),
};
/** Per-tool overrides of maxToolResultTokens (tools that legitimately need more, e.g. spec_section_get). */
const toolResultTokensSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'a tool name'), z.number().int().min(200).max(50_000)).optional();
export const ASK_MODEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const askModelConfigSchema = z
  .object({
    id: z.string().regex(ASK_MODEL_ID, 'letters, digits, _ or - (max 64)'),
    /** Shown in the model picker (default: the id). */
    label: z.string().trim().min(1).max(80).optional(),
    provider: z.enum(ASK_PROVIDERS),
    /** Required except for anthropic (default claude-opus-5-5). */
    model: z.string().min(1).nullable().default(null),
    /** Required for `openai-compatible` (e.g. http://localhost:11434/v1 for Ollama); optional override for the others. */
    baseUrl: z.string().url().nullable().default(null),
    apiKeyEnv: envName,
    ...askLimitFields,
  })
  .strict();
export type AskModelConfig = z.infer<typeof askModelConfigSchema>;

/** Legacy `ask` block (one model, fields at the top) -> the multi-model shape, before validation. */
function legacyAskToModels(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v) || 'models' in v || 'default' in v) return v;
  const { provider = null, model = null, baseUrl = null, apiKeyEnv = null, ...rest } = v as Record<string, unknown>;
  // Old files carry `provider: null` (nothing configured): no model, no error.
  return { ...rest, models: provider === null ? [] : [{ id: 'default', provider, model, baseUrl, apiKeyEnv }] };
}

export const askConfigSchema = z.preprocess(
  legacyAskToModels,
  z
    .object({
      /** Model id used when the question names none (default: the first model). */
      default: z.string().regex(ASK_MODEL_ID).nullable().optional(),
      models: z.array(askModelConfigSchema).max(20).default([]),
      ...askLimitFields,
      toolResultTokens: toolResultTokensSchema,
    })
    .strict()
    .superRefine((c, ctx) => {
      const seen = new Set<string>();
      c.models.forEach((m, i) => {
        if (seen.has(m.id)) ctx.addIssue({ code: 'custom', path: ['models', i, 'id'], message: `duplicate model id '${m.id}'` });
        seen.add(m.id);
      });
      if (c.default != null && !seen.has(c.default)) ctx.addIssue({ code: 'custom', path: ['default'], message: `no model with id '${c.default}'` });
    })
    .transform((c) => ({ ...c, default: c.default ?? c.models[0]?.id ?? null })),
);
export type AskConfig = z.output<typeof askConfigSchema>;
/** In memory: each model's key (from its env var) and the config file for hot reload; never written or returned. */
export type ResolvedAskConfig = Omit<AskConfig, 'models'> & { models: (AskModelConfig & { apiKey?: string })[]; source?: string };
export const ASK_LIMITS = { maxToolCalls: 12, timeoutMs: 120_000, tokenBudget: 150_000, maxOutputTokens: 16_000, maxToolResultTokens: 5_000 } as const;
/** Default per-tool result caps: a section's full text may exceed the general cap. */
export const ASK_TOOL_RESULT_TOKENS: Readonly<Record<string, number>> = { spec_section_get: 8_000, standard_section_get: 8_000, component_section_get: 8_000 };
/** Written into config files that have no `ask` block. */
export const DEFAULT_ASK_BLOCK = { models: [] } as const;
export const DEFAULT_ASK_CONFIG: AskConfig = { default: null, models: [] };

/** Resolve each model's key from its env var (in memory only). */
export function resolveAskConfig(ask: AskConfig, env: NodeJS.ProcessEnv, source?: string): ResolvedAskConfig {
  return {
    ...ask,
    models: ask.models.map((m) => ({ ...m, ...(m.apiKeyEnv && env[m.apiKeyEnv] ? { apiKey: env[m.apiKeyEnv] } : {}) })),
    ...(source ? { source } : {}),
  };
}

/** `{dataDirHash}` in `index.path` is replaced by a short hash of the resolved data dir. */
export const DEFAULT_INDEX_PATH = '~/.mandate/index/{dataDirHash}.sqlite';

export const indexConfigSchema = z
  .object({
    path: z.string().min(1).default(DEFAULT_INDEX_PATH),
    chunkTargetTokens: z.number().int().min(64).default(350),
    chunkOverlapTokens: z.number().int().min(0).default(50),
    sectionSoftLimitTokens: z.number().int().positive().default(600),
    /** graph_query statement timeout. */
    queryTimeoutMs: z.number().int().min(100).max(60_000).default(2000),
    /** Embedding jobs failing this many times are marked failed (embedding_jobs lists them; embedding_jobs_retry re-arms). */
    embedMaxAttempts: z.number().int().min(1).max(100).default(6),
  })
  .strict();
export type IndexConfig = z.infer<typeof indexConfigSchema>;

export const GIT_BACKENDS = ['embedded', 'cli'] as const;
export type GitBackend = (typeof GIT_BACKENDS)[number];

/** Which GitStore implementation to use and how to run the `cli` one. */
export interface GitBackendConfig {
  backend: GitBackend;
  cliPath: string;
  cliEnv: Record<string, string>;
}

/** Background push after commits (debounced) plus a periodic sweep; never force. */
export const autoPushSchema = z
  .object({
    enabled: z.boolean().default(true),
    debounceSeconds: z.number().int().min(1).max(3600).default(10),
    intervalSeconds: z.number().int().min(30).max(86_400).default(300),
  })
  .strict();
export type AutoPushConfig = z.infer<typeof autoPushSchema>;
/** Per-project override: only the fields given (no defaults, so the global block still applies). */
export const autoPushOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    debounceSeconds: z.number().int().min(1).max(3600).optional(),
    intervalSeconds: z.number().int().min(30).max(86_400).optional(),
  })
  .strict();
export const DEFAULT_AUTO_PUSH: AutoPushConfig = { enabled: true, debounceSeconds: 10, intervalSeconds: 300 };

/** Project ids: kebab-case slugs (they appear in URLs `/p/<id>/mcp` and in key prefixes `mnd_<id>_...`). */
export const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const projectIdSchema = z.string().max(40).regex(PROJECT_ID_RE, 'kebab-case slug (a-z, 0-9, single dashes)');

const gitAuthSchema = z
  .object({
    /**
     * 'app': push / fetch over HTTPS with the GitHub App's installation token (no SSH key). 'ssh': SSH key / agent.
     * Unset: 'app' for the embedded backend when a GitHub App is configured and no SSH key / token is set, else 'ssh'
     * (system git then keeps using your own git credentials).
     */
    method: z.enum(GIT_AUTH_METHODS).optional(),
    sshKeyPath: z.string().min(1).nullable().default(null),
    sshPassphraseEnv: envName,
    username: z.string().min(1).nullable().default(null),
    tokenEnv: envName,
  })
  .strict();

/** Per-project auth override: only the fields given (no null defaults that would mask the global block). */
const gitAuthOverrideSchema = z
  .object({
    method: z.enum(GIT_AUTH_METHODS).optional(),
    sshKeyPath: z.string().min(1).nullable().optional(),
    sshPassphraseEnv: envName.unwrap().optional(),
    username: z.string().min(1).nullable().optional(),
    tokenEnv: envName.unwrap().optional(),
  })
  .strict();

/** One project: its own git repo / folder, index, activity feed, Ask conversations and MCP endpoint `/p/<id>/mcp`. */
export const projectConfigSchema = z
  .object({
    id: projectIdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    /** The git working tree (for GitHub projects: the clone, `~/.mandate/projects/<id>/repo`). */
    dataDir: z.string().min(1),
    /** GitHub-backed project (created in the UI): the storage repo, the folder inside it and who connected it. */
    github: z
      .object({
        repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'owner/name'),
        /** Folder inside the repo holding this project (several projects may share a repo); omitted = repo root. */
        path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'a relative folder like docs/specs').refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), 'no . or .. segments').optional(),
        /** GitHub login whose stored OAuth token pulls and pushes. */
        connectedBy: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
      })
      .strict()
      .optional(),
    /** Per-project git settings; unset fields fall back to the top-level `git` block (auth: env-var names only). */
    git: z
      .object({
        remote: z.string().min(1).nullable().optional(),
        branch: z.string().min(1).optional(),
        auth: gitAuthOverrideSchema.optional(),
        /** Overrides the top-level `git.autoPush` for this project. */
        autoPush: autoPushOverrideSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectFileConfig = z.infer<typeof projectConfigSchema>;

/**
 * Sign-in (always on): the web UI logs in with a GitHub OAuth App; agents use per-project keys (keys.json).
 * The client secret is read only from the env var `clientSecretEnv` names (env or ~/.mandate/secrets.env).
 */
export const DEFAULT_GITHUB_SECRET_ENV = 'MANDATE_GITHUB_CLIENT_SECRET';
export const githubAuthSchema = z
  .object({
    clientId: z.string().trim().min(1).optional(),
    clientSecretEnv: envName.unwrap().default(DEFAULT_GITHUB_SECRET_ENV),
    allowedUsers: z.array(z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub login')).default([]),
    allowedOrgs: z.array(z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub organization login')).default([]),
    /** Must be served by the origin that serves the UI (dev: the Vite proxy, http://localhost:5173/auth/github/callback). */
    callbackUrl: z.string().url().optional(),
    /**
     * Set when sign-in uses a GitHub App (created with the one-click manifest flow) instead of an OAuth App: its user
     * tokens expire and refresh, and they only see repositories where the app is installed. Secrets (client secret,
     * webhook secret, private key) never live here: secrets.env and a 0600 key file.
     */
    app: z
      .object({
        id: z.number().int().positive(),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'a GitHub App slug'),
        owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub login').optional(),
        ownerType: z.enum(['User', 'Organization']).optional(),
        htmlUrl: z.string().url().optional(),
        privateKeyPath: z.string().min(1).optional(),
        webhookSecretEnv: envName.unwrap().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const authConfigSchema = z
  .object({
    /** Deprecated (auth is always on): accepted and ignored with a warning. */
    required: z.boolean().optional(),
    github: githubAuthSchema.optional(),
    sessionTtlHours: z.number().int().min(1).max(24 * 90).default(168),
  })
  .strict();
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const fileConfigSchema = z
  .object({
    /** Deprecated alias (single-repo installs): migrated into `projects` as the project `default`. */
    dataDir: z.string().min(1).optional(),
    projects: z
      .array(projectConfigSchema)
      .default([])
      .superRefine((ps, c) => {
        const seen = new Set<string>();
        ps.forEach((p, i) => {
          if (seen.has(p.id)) c.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate project id '${p.id}'` });
          seen.add(p.id);
        });
      }),
    /** Project that legacy URLs (and the unscoped `/mcp` default) resolve to; default: the first project. */
    defaultProject: projectIdSchema.optional(),
    server: z
      .object({
        port: z.number().int().positive().max(65535).default(4000),
        host: z.string().min(1).default('127.0.0.1'),
        /** Deprecated (ignored): Mandate always uses GitHub sign-in. Accepted so older configs still load. */
        users: z.enum(['me', 'team']).optional(),
        /** Deprecated (ignored): Mandate always uses GitHub sign-in. Accepted so older configs still load. */
        mode: z.enum(['local', 'server']).optional(),
        /** Address to listen on (alias of `host`, written by the getmandate CLI). */
        bind: z.string().min(1).optional(),
        /** Public URL (a server: `https://mandate.example.com`); default http://localhost:<port> (this computer). */
        publicUrl: z.string().url().optional(),
        /** Behind a reverse proxy: trust X-Forwarded-Proto / -Host. */
        trustProxy: z.boolean().default(false),
        /** Extra browser origins allowed for the web UI's cookie session (loopback only; same-origin is always allowed). */
        uiOrigins: z.array(z.string().regex(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/, 'a loopback origin like http://localhost:5173')).default([]),
      })
      .strict()
      .default({ port: 4000, host: '127.0.0.1', trustProxy: false, uiOrigins: [] }),
    git: z
      .object({
        /** `embedded` = libgit2 via es-git (default); `cli` = the system `git` binary (>= 2.30). */
        backend: z.enum(GIT_BACKENDS).default('embedded'),
        /** git binary for the `cli` backend (name on PATH or absolute path). */
        cliPath: z.string().min(1).default('git'),
        /** Extra environment variables for git processes of the `cli` backend (e.g. HTTPS_PROXY). */
        cliEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name'), z.string()).default({}),
        remote: z.string().min(1).nullable().default(null),
        branch: z.string().min(1).default('main'),
        autoPush: autoPushSchema.default(DEFAULT_AUTO_PUSH),
        author: z.object({ name: z.string().min(1), email: z.string().min(1) }).strict().default({ name: 'Mandate', email: 'mandate@localhost' }),
        auth: gitAuthSchema.default({ sshKeyPath: null, sshPassphraseEnv: null, username: null, tokenEnv: null }),
      })
      .strict()
      .default({
        backend: 'embedded',
        cliPath: 'git',
        cliEnv: {},
        remote: null,
        branch: 'main',
        autoPush: DEFAULT_AUTO_PUSH,
        author: { name: 'Mandate', email: 'mandate@localhost' },
        auth: { sshKeyPath: null, sshPassphraseEnv: null, username: null, tokenEnv: null },
      }),
    embedding: embeddingConfigSchema.default(embeddingConfigSchema.parse({})),
    index: indexConfigSchema.default(indexConfigSchema.parse({})),
    ask: askConfigSchema.default(DEFAULT_ASK_CONFIG),
    auth: authConfigSchema.default({ sessionTtlHours: 168 }),
    /** Server state (and, later, the index) backend: SQLite (default) or Postgres (`urlEnv` names the URL's env var). */
    database: databaseConfigSchema.default(DEFAULT_DATABASE_CONFIG),
    /** Deprecated (local-folder projects are no longer created); kept so older configs load. */
    local: z
      .object({ baseDir: z.string().min(1).default('~/mandate') })
      .strict()
      .default({ baseDir: '~/mandate' }),
  })
  .strict();
export type FileConfig = z.infer<typeof fileConfigSchema>;

/** A project with every path resolved and the git settings merged (top-level `git` block + the project's own). */
export interface ProjectConfig {
  id: string;
  name: string;
  description?: string;
  /** GitHub storage (UI-created projects); the remote's token comes from the token store, never from config. */
  github?: { repo: string; path?: string; connectedBy: string };
  /** Absolute git working tree. */
  dataDir: string;
  branch: string;
  remote?: RemoteConfig;
  author: { name: string; email: string };
  git: GitBackendConfig;
  /** `index.path` resolved for this project (SQLite index: FTS, embeddings cache, graph). */
  index: IndexConfig;
  /** Durable idempotency keys of write tools (next to the index). */
  idempotencyFile: string;
  /** Background push (top-level `git.autoPush` merged with the project's own). */
  autoPush: AutoPushConfig;
}

export interface AppConfig {
  /** The config file that was read (created with defaults when missing). */
  configPath: string;
  port: number;
  host: string;
  /** Loopback browser origins allowed for the web UI cookie session besides same-origin. */
  uiOrigins: string[];
  /** Every registered project (at least one). */
  projects: ProjectConfig[];
  /** Id of the default project (legacy URLs, `/health`). */
  defaultProject: string;
  /** `~/.mandate/keys.json` (MANDATE_KEYS_FILE overrides): agent keys, one or more per project. */
  keysPath: string;
  /** `~/.mandate` (MANDATE_HOME): session store, session secret. */
  home: string;
  /** Server-state database (SQLite file or Postgres; the URL is a secret read from the env var `urlEnv` names). */
  database: ResolvedDatabase;
  /** Sign-in config at startup (the server re-reads the file's `auth` block on change). */
  auth: AuthConfig;
  /**
   * An older install signing in with an OAuth App and an allow-list, without a setup marker (`auth.github` with
   * allowedUsers / allowedOrgs, no `app`, `server.mode` or `server.users`): it keeps the allow-list as the gate (no
   * per-repo permissions) and admin rights for every signed-in user, exactly as before.
   */
  legacyAuth: boolean;
  /** Where the UI is reached (`server.publicUrl`, default http://localhost:<port>). */
  publicUrl: string;
  trustProxy: boolean;
  /** Projects folder for new local-folder projects (absolute). */
  localBaseDir: string;
  /** `~/.mandate/projects.json`: the server-owned project registry. */
  projectsPath: string;
  /** Notices and warnings for the log (registry migration, deprecated fields). */
  warnings: string[];
  /** The default project's settings, kept for single-project callers (scripts, tests). */
  /** Absolute git working tree. */
  dataDir: string;
  branch: string;
  remote?: RemoteConfig;
  author: { name: string; email: string };
  git: GitBackendConfig;
  embedding: ResolvedEmbeddingConfig;
  index: IndexConfig;
  /** Keys are held in memory only (from the env var each model's `apiKeyEnv` names), never written or returned. */
  ask: ResolvedAskConfig;
}

export class ConfigError extends Error {
  constructor(
    readonly configPath: string,
    problems: string[],
  ) {
    super(`Invalid Mandate config ${configPath}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** Directory holding config.json, repos/ and index/ (`MANDATE_HOME`, default `~/.mandate`). */
export function mandateHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(expandHome(env.MANDATE_HOME ?? '~/.mandate', env.HOME ?? os.homedir()));
}

/**
 * Defaults for a new config file. The default project's data dir is `./data/repo` (relative to where npm was
 * invoked) when that repository already exists, so existing installs keep their data; otherwise `~/.mandate/repos/default`.
 */
export function defaultFileConfig(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const local = path.resolve(env.INIT_CWD ?? process.cwd(), 'data/repo');
  const dataDir = existsSync(path.join(local, '.git')) ? local : '~/.mandate/repos/default';
  return fileConfigSchema.parse({ projects: [{ id: 'default', name: 'Default', dataDir }] });
}

/**
 * Pre-projects config files have a top-level `dataDir`: it becomes the project `default` (same data dir, so the same
 * index, activity and idempotency files). Returns the migrated JSON, or null when nothing changed.
 */
export function migrateLegacyConfig(json: Record<string, unknown>): Record<string, unknown> | null {
  const projects = Array.isArray(json.projects) ? (json.projects as Record<string, unknown>[]) : [];
  if (typeof json.dataDir !== 'string') return null;
  const { dataDir, ...rest } = json;
  if (projects.some((p) => p.dataDir === dataDir)) return { ...rest, projects };
  const ids = new Set(projects.map((p) => p.id));
  let id = 'default';
  for (let n = 2; ids.has(id); n++) id = `default-${n}`;
  return { ...rest, projects: [{ id, name: id === 'default' ? 'Default' : `Default ${id.slice(8)}`, dataDir }, ...projects] };
}

/** Write the config file atomically (mode 0600: it may name env vars and paths, never secrets). */
export function writeConfigFile(configPath: string, json: unknown): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
}

/** Read the raw JSON of the config file (no defaults, no validation). */
export function readRawConfig(configPath: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(configPath, [`not valid JSON: ${(e as Error).message}`]);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ConfigError(configPath, ['expected a JSON object']);
  return json as Record<string, unknown>;
}

/**
 * Read and validate the config file. The server never writes config.json (it is user-owned): a missing file means
 * defaults, and legacy shapes (top-level `dataDir`, `projects`) are only read, to seed projects.json once.
 */
export function readConfigFile(configPath: string, env: NodeJS.ProcessEnv = process.env): FileConfig {
  if (!existsSync(configPath)) return defaultFileConfig(env);
  let json = readRawConfig(configPath);
  const migrated = migrateLegacyConfig(json);
  if (migrated) json = migrated;
  const r = fileConfigSchema.safeParse(json);
  if (!r.success) {
    throw new ConfigError(
      configPath,
      r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return r.data;
}

/* ------------------------------------------------------------------ projects.json (server-owned registry) */

/** One registered project in `~/.mandate/projects.json`. */
export const projectEntrySchema = z
  .object({
    id: projectIdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    dataDir: z.string().min(1),
    /** GitHub storage (UI-created projects). */
    github: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub owner'),
        repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'a repository name'),
        branch: z.string().min(1).max(200).optional(),
        path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'a relative folder like docs/specs').refine((p) => !p.split('/').some((x) => x === '.' || x === '..'), 'no . or .. segments').optional(),
      })
      .strict()
      .optional(),
    /** GitHub login whose stored token pulls / pushes (GitHub projects). */
    connectedBy: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
    createdAt: z.string().min(1),
    /** Coding-agent flow (MCP project_info / project_flow_set; Settings → Agent flow). Absent = both true. */
    /** Legacy (migrated to flowPolicy / approvalPolicy at startup): `{ enabled, approval }`. */
    flow: z.object({ enabled: z.boolean(), approval: z.boolean() }).strict().optional(),
    /** Coding-agent flow policy (admin): required | optional (default; each client chooses) | off (read-only context). */
    flowPolicy: z.enum(['required', 'optional', 'off']).optional(),
    /** Approval checkpoint policy (admin): required | optional (default; each client chooses). */
    approvalPolicy: z.enum(['required', 'optional']).optional(),
    /** Per-project overrides of the config.json `git` block. */
    git: z
      .object({
        remote: z.string().min(1).nullable().optional(),
        branch: z.string().min(1).optional(),
        auth: gitAuthOverrideSchema.optional(),
        autoPush: autoPushOverrideSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) => !p.github || !!p.connectedBy, { message: 'GitHub projects need connectedBy', path: ['connectedBy'] });
export type ProjectEntry = z.infer<typeof projectEntrySchema>;

export const projectsFileSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(projectEntrySchema).superRefine((ps, c) => {
      const seen = new Set<string>();
      ps.forEach((p, i) => {
        if (seen.has(p.id)) c.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate project id '${p.id}'` });
        seen.add(p.id);
      });
    }),
  })
  .strict();
export type ProjectsFile = z.infer<typeof projectsFileSchema>;

/** `~/.mandate/projects.json` (`MANDATE_PROJECTS_FILE` overrides). */
export function projectsPathOf(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== '')) as NodeJS.ProcessEnv;
  return path.resolve(expandHome(env.MANDATE_PROJECTS_FILE ?? path.join(mandateHome(env), 'projects.json'), env.HOME ?? os.homedir()));
}

/** A legacy config.json project (`projects[]` before projects.json) as a registry entry. */
export function entryFromLegacy(p: ProjectFileConfig, createdAt = new Date().toISOString()): ProjectEntry {
  const [owner, repo] = p.github ? p.github.repo.split('/') : [];
  return {
    id: p.id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    dataDir: p.dataDir,
    ...(p.github ? { github: { owner: owner!, repo: repo!, ...(p.git?.branch ? { branch: p.git.branch } : {}), ...(p.github.path ? { path: p.github.path } : {}) }, connectedBy: p.github.connectedBy } : {}),
    createdAt,
    ...(p.git ? { git: p.git } : {}),
  };
}

/** A registry entry in the internal shape the resolver uses. */
function legacyFromEntry(e: ProjectEntry): ProjectFileConfig {
  const branch = e.github?.branch ?? e.git?.branch;
  const git = { ...(e.git ?? {}), ...(branch ? { branch } : {}) };
  return {
    id: e.id,
    name: e.name,
    ...(e.description ? { description: e.description } : {}),
    dataDir: e.dataDir,
    ...(e.github ? { github: { repo: `${e.github.owner}/${e.github.repo}`, ...(e.github.path ? { path: e.github.path } : {}), connectedBy: e.connectedBy! } } : {}),
    ...(Object.keys(git).length ? { git } : {}),
  };
}

export function parseProjectsFile(file: string, text: string): ProjectsFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(file, [`not valid JSON: ${(e as Error).message}`]);
  }
  const r = projectsFileSchema.safeParse(json);
  if (!r.success) throw new ConfigError(file, r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return r.data;
}

/** Atomic write (temp + rename), mode 0600. */
export function writeProjectsFile(file: string, value: ProjectsFile): void {
  const checked = projectsFileSchema.parse(value);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The registry: projects.json when it exists (config.json `projects` / `dataDir` are then stale: warning).
 * Otherwise it is created once from config.json (`projects`, legacy `dataDir`, or the default project); config.json
 * itself is never edited (a notice says the key can be removed).
 */
export function loadProjectsRegistry(projectsPath: string, file: FileConfig, configPath: string, rawJson: Record<string, unknown> | null): { projects: ProjectFileConfig[]; notices: string[] } {
  const notices: string[] = [];
  const staleKeys = rawJson ? ['projects', 'dataDir'].filter((k) => k in rawJson) : [];
  if (existsSync(projectsPath)) {
    const reg = parseProjectsFile(projectsPath, readFileSync(projectsPath, 'utf8'));
    if (staleKeys.length) notices.push(`warning: ${configPath} still has ${staleKeys.map((k) => `"${k}"`).join(' and ')}; ${projectsPath} is the project registry and wins (delete the stale key from config.json)`);
    return { projects: reg.projects.map(legacyFromEntry), notices };
  }
  const now = new Date().toISOString();
  const reg: ProjectsFile = { version: 1, projects: file.projects.map((p) => entryFromLegacy(p, now)) };
  writeProjectsFile(projectsPath, reg);
  notices.push(`created ${projectsPath} with ${reg.projects.length} project(s) from ${staleKeys.length ? configPath : 'defaults'}${staleKeys.length ? `; you can delete the ${staleKeys.map((k) => `"${k}"`).join(' / ')} key from config.json (it is no longer read)` : ''}`);
  return { projects: reg.projects.map(legacyFromEntry), notices };
}

const intEnv = (v: string | undefined, name: string, configPath: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(configPath, [`env ${name}: expected a positive integer, got "${v}"`]);
  return n;
};

/**
 * Load config: environment variables (`MANDATE_*`) > `~/.mandate/config.json` > defaults.
 * The file is created with defaults when missing. Secrets are read from the env vars the file names.
 * `MANDATE_DATA_DIR`, `MANDATE_BRANCH` and `MANDATE_REMOTE_URL` override the default project only.
 */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  // Empty variables count as unset.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== '')) as NodeJS.ProcessEnv;
  const home = env.HOME ?? os.homedir();
  const configPath = configPathOf(env);
  const file = readConfigFile(configPath, env);
  const rawJson = existsSync(configPath) ? readRawConfig(configPath) : null;
  const projectsPath = projectsPathOf(env);
  const registry = loadProjectsRegistry(projectsPath, file.projects.length ? file : { ...file, projects: defaultFileConfig(env).projects }, configPath, rawJson);
  if (!registry.projects.length) throw new ConfigError(projectsPath, ['projects: no projects registered (create one in the web UI: New project)']);
  const baseDir = env.INIT_CWD ?? process.cwd();
  const resolvePath = (p: string, base: string) => path.resolve(base, expandHome(p, home));

  const backend = (env.MANDATE_GIT_BACKEND ?? file.git.backend) as GitBackend;
  if (!GIT_BACKENDS.includes(backend)) {
    throw new ConfigError(configPath, [`env MANDATE_GIT_BACKEND: expected embedded | cli, got "${backend}"`]);
  }
  const gitBackend: GitBackendConfig = { backend, cliPath: env.MANDATE_GIT_CLI_PATH ?? file.git.cliPath, cliEnv: file.git.cliEnv };
  const author = { name: env.MANDATE_AUTHOR_NAME ?? file.git.author.name, email: env.MANDATE_AUTHOR_EMAIL ?? file.git.author.email };

  const embedding = resolveEmbeddingConfig(file.embedding, env, configPath, rawEnv === process.env ? configPath : undefined);

  const port = intEnv(env.MANDATE_PORT ?? env.PORT, 'MANDATE_PORT', configPath) ?? file.server.port;
  const defaultProject = file.defaultProject && registry.projects.some((p) => p.id === file.defaultProject) ? file.defaultProject : registry.projects[0]!.id;
  const indexTemplate = env.MANDATE_INDEX_PATH ?? file.index.path;
  const projects = registry.projects.map((p): ProjectConfig => {
    const isDefault = p.id === defaultProject;
    const dataDir = isDefault && env.MANDATE_DATA_DIR ? resolvePath(env.MANDATE_DATA_DIR, baseDir) : resolvePath(p.dataDir, path.dirname(configPath));
    const branch = (isDefault ? env.MANDATE_BRANCH : undefined) ?? p.git?.branch ?? file.git.branch;
    // The top-level remote belongs to the default project (single-repo installs); other projects name their own.
    const remoteUrl = (isDefault ? env.MANDATE_REMOTE_URL : undefined) ?? (p.git?.remote !== undefined ? p.git.remote : isDefault ? file.git.remote : null) ?? undefined;
    const a = { ...file.git.auth, ...(p.git?.auth ?? {}) };
    const sshKeyPath = (isDefault ? env.MANDATE_SSH_KEY_PATH : undefined) ?? a.sshKeyPath ?? undefined;
    const token = (isDefault ? env.MANDATE_GIT_TOKEN : undefined) ?? (a.tokenEnv ? env[a.tokenEnv] : undefined);
    const username = (isDefault ? (env.MANDATE_SSH_USERNAME ?? env.MANDATE_GIT_USERNAME) : undefined) ?? a.username ?? undefined;
    let auth: RemoteAuth | undefined;
    let url = remoteUrl;
    const method = gitAuthMethod({ explicit: ((isDefault ? env.MANDATE_GIT_AUTH_METHOD : undefined) ?? a.method) as GitAuthMethod | undefined, backend, appConfigured: !!file.auth.github?.app?.privateKeyPath, sshKeyPath, tokenEnv: a.tokenEnv ?? (isDefault ? env.MANDATE_GIT_TOKEN : undefined) });
    if (method instanceof Error) throw new ConfigError(configPath, [`git.auth.method${isDefault ? '' : ` (project '${p.id}')`}: ${method.message}`]);
    const ghRepo = remoteUrl ? githubRepoOf(remoteUrl, new URL(githubWeb(env)).host) : null;
    if (method === 'app' && remoteUrl && !ghRepo && a.method) {
      throw new ConfigError(configPath, [`git.auth.method "app"${isDefault ? '' : ` (project '${p.id}')`}: the remote ${redactRemote(remoteUrl)} is not a GitHub repository URL (https://github.com/<owner>/<repo>.git)`]);
    }
    if (method === 'app' && remoteUrl && ghRepo) {
      url = `${githubWeb(env)}/${ghRepo.owner}/${ghRepo.repo}.git`;
      const tokens = appTokensFor(configPath, env);
      auth = { type: 'github-app', owner: ghRepo.owner, repo: ghRepo.repo, token: () => tokens.token(ghRepo.owner, ghRepo.repo), invalidate: () => tokens.invalidate(ghRepo.owner, ghRepo.repo) };
    } else if (sshKeyPath) {
      auth = {
        type: 'ssh',
        privateKeyPath: resolvePath(sshKeyPath, path.dirname(configPath)),
        passphrase: (isDefault ? env.MANDATE_SSH_PASSPHRASE : undefined) ?? (a.sshPassphraseEnv ? env[a.sshPassphraseEnv] : undefined),
        username,
      };
    } else if (token || (a.tokenEnv && rawEnv === process.env && remoteUrl)) {
      auth = { type: 'https', username: username ?? 'git', token: token ?? '' };
      // Named token env var in the live process: read it on use so a changed secrets.env applies without a restart.
      if (a.tokenEnv && rawEnv === process.env && !(isDefault && env.MANDATE_GIT_TOKEN)) {
        const name = a.tokenEnv;
        const fallback = token ?? '';
        Object.defineProperty(auth, 'token', { enumerable: true, get: () => (refreshSecrets(), process.env[name] || fallback) });
      }
    } else if (remoteUrl && /^(?:ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(remoteUrl)) {
      auth = { type: 'ssh-agent', username };
    }
    const index = { ...file.index, path: projectIndexPath(indexTemplate, dataDir, p.id, isDefault) };
    if (index.path !== ':memory:') index.path = resolvePath(index.path, path.dirname(configPath));
    return {
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.github ? { github: p.github } : {}),
      dataDir,
      branch,
      ...(url ? { remote: { url, branch, auth } } : {}),
      author,
      git: gitBackend,
      index,
      idempotencyFile: index.path === ':memory:' ? '' : `${index.path}.idempotency.json`,
      autoPush: { ...file.git.autoPush, ...(p.git?.autoPush ?? {}) },
    };
  });
  const def = projects.find((p) => p.id === defaultProject)!;

  return {
    configPath,
    port,
    host: env.MANDATE_HOST ?? file.server.bind ?? file.server.host,
    legacyAuth: !file.server.users && !file.server.mode && !!file.auth.github && !file.auth.github.app && (file.auth.github.allowedUsers.length > 0 || file.auth.github.allowedOrgs.length > 0),
    publicUrl: (file.server.publicUrl ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: file.server.trustProxy,
    localBaseDir: resolvePath(file.local.baseDir, home),
    uiOrigins: file.server.uiOrigins,
    projects,
    defaultProject,
    keysPath: path.resolve(expandHome(env.MANDATE_KEYS_FILE ?? path.join(mandateHome(env), 'keys.json'), home)),
    home: mandateHome(env),
    database: resolveDatabaseOrThrow(file.database, env, configPath),
    auth: file.auth,
    projectsPath,
    warnings: [...registry.notices, ...(file.auth.required !== undefined ? ['auth.required is deprecated and ignored: sign-in is always on (GitHub)'] : []), ...(file.server.users || file.server.mode ? ['server.users / server.mode are ignored: Mandate always signs in with GitHub (the setup wizard creates the GitHub App)'] : [])],
    dataDir: def.dataDir,
    branch: def.branch,
    remote: def.remote,
    author,
    git: gitBackend,
    embedding,
    ask: resolveAskConfig(file.ask, env, rawEnv === process.env ? configPath : undefined),
    index: def.index,
  };
}

function resolveDatabaseOrThrow(d: FileConfig['database'], env: NodeJS.ProcessEnv, configPath: string): ResolvedDatabase {
  try {
    return resolveDatabase(d, env, mandateHome(env));
  } catch (e) {
    throw new ConfigError(configPath, [`database: ${(e as Error).message}`]);
  }
}

/** The config file path (`MANDATE_CONFIG`, default `~/.mandate/config.json`). */
export function configPathOf(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== '')) as NodeJS.ProcessEnv;
  const home = env.HOME ?? os.homedir();
  return path.resolve(expandHome(env.MANDATE_CONFIG ?? path.join(mandateHome(env), 'config.json'), home));
}

/**
 * A project's index file from the `index.path` template: `{dataDirHash}` (short hash of the resolved data dir, the
 * default: `~/.mandate/index/<hash>.sqlite`, so the migrated default project keeps its index) and `{projectId}`
 * are substituted. A fixed path (no placeholder) is used as-is by the default project; others get `.<id>` before
 * the extension so indexes never collide.
 */
export function projectIndexPath(template: string, dataDir: string, projectId: string, isDefault: boolean): string {
  if (template === ':memory:') return template;
  const dataDirHash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  const templated = /\{(dataDirHash|projectId)\}/.test(template);
  const p = template.replaceAll('{dataDirHash}', dataDirHash).replaceAll('{projectId}', projectId);
  if (templated || isDefault) return p;
  const ext = path.extname(p);
  return `${p.slice(0, p.length - ext.length)}.${projectId}${ext}`;
}

/**
 * Effective `git.auth.method`. Explicit wins. Unset: 'app' for the embedded backend when a GitHub App with a private
 * key is configured and no SSH key / HTTPS token is set; otherwise 'ssh' (system git keeps the user's own credentials).
 */
export function gitAuthMethod(o: { explicit?: string; backend: GitBackend; appConfigured: boolean; sshKeyPath?: string | null; tokenEnv?: string | null }): GitAuthMethod | Error {
  if (o.explicit !== undefined) return (GIT_AUTH_METHODS as readonly string[]).includes(o.explicit) ? (o.explicit as GitAuthMethod) : new Error(`expected app | ssh, got "${o.explicit}"`);
  return o.backend === 'embedded' && o.appConfigured && !o.sshKeyPath && !o.tokenEnv ? 'app' : 'ssh';
}

/** GitHub web base (MANDATE_GITHUB_URL for GitHub Enterprise / tests). */
const githubWeb = (env: NodeJS.ProcessEnv) => (env.MANDATE_GITHUB_CLONE_BASE || env.MANDATE_GITHUB_URL || 'https://github.com').replace(/\/+$/, '');

const redactRemote = (u: string) => u.replace(/\/\/[^@/]*@/, '//***@');

/** One installation-token cache per config file; the App (id, slug, key) is re-read from the file on every mint. */
const appTokenCaches = new Map<string, AppInstallationTokens>();
export function appTokensFor(configPath: string, env: NodeJS.ProcessEnv = process.env): AppInstallationTokens {
  let t = appTokenCaches.get(configPath);
  if (!t) {
    t = new AppInstallationTokens({
      app: () => {
        try {
          const app = authConfigSchema.safeParse(readRawConfig(configPath).auth ?? {}).data?.github?.app;
          if (!app) return null;
          return { id: app.id, slug: app.slug, ...(app.privateKeyPath ? { privateKeyPath: path.resolve(path.dirname(configPath), expandHome(app.privateKeyPath, os.homedir())) } : {}) };
        } catch {
          return null;
        }
      },
      api: env.MANDATE_GITHUB_API_URL || undefined,
      web: env.MANDATE_GITHUB_URL || undefined,
    });
    appTokenCaches.set(configPath, t);
  }
  return t;
}
