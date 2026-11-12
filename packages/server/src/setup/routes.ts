/**
 * First-run setup wizard + Settings API, local sign-in, and the SSE probe.
 * - `GET /auth/setup?token=`: the one-time setup link (CLI `setup-url`). Loopback only, or HTTPS in server mode.
 *   Sets the `mandate_setup` cookie (bound to the token: completing setup invalidates it) and redirects to `/setup`.
 * - `GET /auth/local?token=`: local mode one-time sign-in link (CLI `open`), loopback only → session cookie.
 * - `/ui/setup/*`, `/ui/fs/*`, `/ui/projects/local`: admin = a signed-in session (any allowed user) or, until setup
 *   completes, the setup cookie. UI-only (X-Mandate-UI, no bearer keys), same-origin Origin on writes.
 * Secrets are write-only (secrets.env); responses only say whether they are set.
 */
import os from 'node:os';
import type { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, cookieOf, originOk, SESSION_COOKIE, type AuthOptions } from '../auth/http.js';
import type { AuthConfigSource } from '../auth/github.js';
import { refreshSecrets } from '../secrets.js';
import { AdminError } from '../projects/admin.js';
import { ConfigConflictError, setSecret, SECRET_NAME_RE, type ConfigFile, type LocalLoginTokens, type SetupState } from './files.js';
import { FsError, type FolderBrowser } from './fs.js';
import { createLocalProject, type LocalProjectDeps } from './local-projects.js';
import * as probes from './probes.js';
import { askKeyCandidates, ENDPOINT_PRESETS, endpointOf, isLocalEndpoint, modelPreset, switchEstimate } from '../index/embed/presets.js';
import { listEmbeddingModels, testEmbeddingModel } from '../index/embed/probe.js';
import { poolerOf, resolveDatabase } from '../db/config.js';
import { probePostgres } from '../db/probe.js';

export const SETUP_COOKIE = 'mandate_setup';

export interface SetupDeps {
  mode: 'local' | 'server';
  /** Server mode with GitHub repo permissions: the allow-list is an optional extra gate. */
  repoAuth?: boolean;
  legacyMode: boolean;
  publicUrl: string;
  trustProxy: boolean;
  port: number;
  home: string;
  localBaseDir: string;
  auth: AuthOptions;
  source: AuthConfigSource;
  setup: SetupState;
  logins: LocalLoginTokens;
  config: ConfigFile;
  secretsFile: string;
  browser: FolderBrowser;
  hostOk: (req: FastifyRequest) => boolean;
  local: Omit<LocalProjectDeps, 'browser' | 'baseDir'>;
  fetch?: probes.Fetch;
  githubApi?: string;
  /** Database driver of the running server (Settings shows when a change awaits a restart). */
  activeDatabase?: 'sqlite' | 'postgres';
  /** Test seam for the database probe (PGlite). */
  probeDatabase?: typeof probePostgres;
  log?: { info(m: string): void; warn(m: string): void };
}

/* ------------------------------------------------------------------ request facts */

const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/** The client is on this machine: socket address is loopback, and no proxy forwarded it (unless trusted and loopback). */
export function clientIsLoopback(req: FastifyRequest, trustProxy: boolean): boolean {
  const fwd = req.headers['x-forwarded-for'] ?? req.headers.forwarded;
  const sock = req.socket.remoteAddress ?? '';
  if (fwd) {
    if (!trustProxy) return false; // an untrusted proxy in front: never treat as local
    const first = String(fwd).split(',')[0]!.trim().replace(/^for=/i, '').replace(/^"|"$/g, '');
    return LOOPBACK_ADDR.test(first) && LOOPBACK_ADDR.test(sock);
  }
  return LOOPBACK_ADDR.test(sock);
}

export function requestIsHttps(req: FastifyRequest, trustProxy: boolean): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  return trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
}

type Admin = { kind: 'user'; login: string } | { kind: 'setup' };

const fail = (reply: FastifyReply, status: number, code: string, message: string, extra: { path?: string; hint?: string } = {}) => reply.code(status).send({ error: { code, message, ...extra } });

export function registerSetupRoutes(app: FastifyInstance, d: SetupDeps): void {
  const secure = d.publicUrl.startsWith('https://') ? '; Secure' : '';

  const setupCookieOk = (req: FastifyRequest) => {
    const v = d.auth.store.unsign<{ h: string; exp: number }>(cookieOf(req, SETUP_COOKIE));
    const h = d.setup.tokenHash();
    return !!v && !!h && v.h === h && v.exp > Date.now();
  };

  /** Admin gate for the setup / settings API. Returns null after replying. */
  const admin = async (req: FastifyRequest, reply: FastifyReply): Promise<Admin | null> => {
    if (!d.hostOk(req)) return (fail(reply, 403, 'forbidden', 'forbidden host'), null);
    if (req.headers.authorization) return (fail(reply, 403, 'forbidden', 'UI-only route (not for agent keys)'), null);
    if (req.headers['x-mandate-ui'] !== '1') return (fail(reply, 403, 'forbidden', 'missing X-Mandate-UI header'), null);
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return (fail(reply, 403, 'forbidden', 'cross-site request'), null);
    if (req.method !== 'GET' && !originOk(req, d.auth.uiOrigins)) return (fail(reply, 403, 'forbidden', 'Origin must be same-origin'), null);
    if (cookieOf(req, SESSION_COOKIE)) {
      const a = await authenticate(req, null, d.auth);
      if (a.ok && a.principal.kind === 'ui') {
        if (d.auth.isAdmin?.(a.principal.user.login) === false) return (fail(reply, 403, 'forbidden', 'only Mandate admins (auth.github.allowedUsers) can change settings'), null);
        return { kind: 'user', login: a.principal.user.login };
      }
    }
    if (setupCookieOk(req)) return { kind: 'setup' };
    fail(reply, 401, 'unauthorized', d.setup.complete() ? 'sign in to change settings' : 'open the setup link printed by `getmandate setup-url`');
    return null;
  };

  const wrap =
    <T>(fn: (req: FastifyRequest, reply: FastifyReply, who: Admin) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const who = await admin(req, reply);
      if (!who) return reply;
      try {
        return await fn(req, reply, who);
      } catch (e) {
        if (e instanceof AdminError) return fail(reply, e.status, e.code, e.message, { ...(e.path ? { path: e.path } : {}), ...(e.hint ? { hint: e.hint } : {}) });
        if (e instanceof FsError) return fail(reply, e.status, 'invalid_path', e.message, { path: 'path' });
        if (e instanceof ConfigConflictError) return fail(reply, 409, 'config_changed', 'The config was edited outside Mandate; reload.', { hint: 'reload the page to load the current config' });
        if (e instanceof z.ZodError) return fail(reply, 400, 'invalid_input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), { path: String(e.issues[0]?.path[0] ?? '') });
        d.log?.warn(`setup: ${probes.scrub((e as Error).message)}`);
        return fail(reply, 400, 'invalid_input', probes.scrub((e as Error).message));
      }
    };

  /* -------------------------------------------------------------- public */

  // SSE probe for the server-mode "SSE through the proxy" check: one event now, the end 1.5 s later.
  app.get('/health/sse', async (_req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write('event: ping\ndata: 1\n\n');
    setTimeout(() => {
      res.write('event: done\ndata: 1\n\n');
      res.end();
    }, 1500).unref?.();
  });

  app.get('/auth/setup', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    const local = clientIsLoopback(req, d.trustProxy);
    // Remote use of the token only over HTTPS (server mode); plain-http non-loopback requests are refused.
    if (!local && !(d.mode === 'server' && requestIsHttps(req, d.trustProxy))) return fail(reply, 403, 'forbidden', 'the setup link works on this machine (or over HTTPS in server mode); use an SSH tunnel until HTTPS is set up');
    if (!d.hostOk(req)) return fail(reply, 403, 'forbidden', 'forbidden host');
    if (d.setup.complete()) return reply.redirect('/setup?error=already_complete');
    if (!d.setup.checkToken(token)) return reply.redirect('/setup?error=invalid_token');
    const cookie = d.auth.store.sign({ h: d.setup.tokenHash(), exp: Date.now() + 6 * 3600_000 });
    reply.header('Set-Cookie', `${SETUP_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600${secure}`);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect('/setup');
  });

  const localSession = async (reply: FastifyReply) => {
    const u = os.userInfo();
    const cookie = await d.auth.store.createSession({ login: u.username, name: u.username, avatarUrl: '', kind: 'local' });
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${secure}`);
  };

  if (d.mode === 'local') {
    app.get('/auth/local', async (req, reply) => {
      if (!clientIsLoopback(req, d.trustProxy) || !d.hostOk(req)) return fail(reply, 403, 'forbidden', 'local sign-in works only on this machine');
      if (!(await d.logins.consume((req.query as { token?: string }).token))) return reply.redirect('/login?error=link_expired');
      await localSession(reply);
      reply.header('Cache-Control', 'no-store');
      return reply.redirect('/');
    });
  }

  /* -------------------------------------------------------------- state */

  const setFlag = (name: string | null | undefined) => !!(name && process.env[name]);

  app.get(
    '/ui/setup/state',
    wrap(async () => {
      refreshSecrets();
      const f = d.config.parsed();
      const g = f.auth.github;
      const sys = await probes.systemGit(f.git.cliPath);
      return {
        complete: d.setup.complete(),
        configVersion: d.config.version(),
        mode: d.mode,
        legacy: d.legacyMode,
        config: {
          server: { mode: f.server.mode ?? d.mode, publicUrl: f.server.publicUrl ?? null, bind: f.server.bind ?? f.server.host, port: f.server.port, trustProxy: f.server.trustProxy },
          ...(d.mode === 'server'
            ? {
                github: {
                  clientId: g?.clientId ?? null,
                  clientSecretEnv: g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET',
                  clientSecretSet: setFlag(g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET'),
                  allowedUsers: g?.allowedUsers ?? [],
                  allowedOrgs: g?.allowedOrgs ?? [],
                  callbackUrl: g?.callbackUrl ?? null,
                  suggested: { name: 'Mandate', homepageUrl: d.publicUrl, callbackUrl: `${d.publicUrl}/auth/github/callback` },
                },
              }
            : { local: { baseDir: f.local.baseDir } }),
          ask: {
            maxToolCalls: (f.ask as Record<string, unknown>).maxToolCalls ?? null,
            tokenBudget: (f.ask as Record<string, unknown>).tokenBudget ?? null,
            timeoutMs: (f.ask as Record<string, unknown>).timeoutMs ?? null,
            maxOutputTokens: (f.ask as Record<string, unknown>).maxOutputTokens ?? null,
            limits: (f.ask as Record<string, unknown>).limits ?? null,
            default: f.ask.default,
            models: f.ask.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}), provider: m.provider, model: m.model, baseUrl: m.baseUrl, apiKeyEnv: m.apiKeyEnv, apiKeySet: setFlag(m.apiKeyEnv) })) },
          embedding: {
            provider: f.embedding.provider,
            baseUrl: f.embedding.baseUrl,
            model: f.embedding.model,
            dimensions: f.embedding.dimensions,
            apiKeyEnv: f.embedding.apiKeyEnv,
            apiKeySet: setFlag(f.embedding.apiKeyEnv),
            preset: f.embedding.preset ?? (f.embedding.provider === 'openai-compatible' ? endpointOf(f.embedding.baseUrl) : null),
            requestDimensions: f.embedding.requestDimensions ?? null,
            maxInputTokens: f.embedding.maxInputTokens,
            batchSize: f.embedding.batchSize,
            documentPrefix: f.embedding.documentPrefix,
            queryPrefix: f.embedding.queryPrefix,
            remote: f.embedding.provider === 'openai-compatible' && !isLocalEndpoint(f.embedding.baseUrl),
          },
          // Server-state database (Settings → Advanced → Database). The URL is a secret: only whether it is set.
          database: {
            driver: f.database.driver,
            urlEnv: f.database.urlEnv,
            urlSet: setFlag(f.database.urlEnv),
            pooler: poolerOf(process.env[f.database.urlEnv] || undefined),
            schemaPerProject: f.database.schemaPerProject,
            ssl: f.database.ssl ?? null,
            prepare: f.database.prepare ?? null,
            extensionsSchema: f.database.extensionsSchema ?? null,
            pool: f.database.pool,
            /** The backend this running server uses (a change applies after a restart). */
            active: d.activeDatabase ?? 'sqlite',
          },
          git: {
            backend: f.git.backend,
            cliPath: f.git.cliPath,
            author: f.git.author,
            auth: {
              sshKeyPath: f.git.auth.sshKeyPath,
              sshPassphraseEnv: f.git.auth.sshPassphraseEnv,
              passphraseSet: setFlag(f.git.auth.sshPassphraseEnv),
              username: f.git.auth.username,
              tokenEnv: f.git.auth.tokenEnv,
              tokenSet: setFlag(f.git.auth.tokenEnv),
            },
            autoPush: f.git.autoPush,
            system: sys,
            agentAvailable: !!process.env.SSH_AUTH_SOCK,
            defaultKeys: probes.defaultSshKeys(),
          },
        },
      };
    }),
  );

  app.get(
    '/ui/setup/checks',
    wrap(async () => ({ checks: await probes.environmentChecks({ mode: d.mode, home: d.home, localBaseDir: d.localBaseDir, port: d.port, publicUrl: d.publicUrl, ...(d.fetch ? { fetch: d.fetch } : {}) }) })),
  );

  /* -------------------------------------------------------------- config writes */

  const githubPatch = z
    .object({
      clientId: z.string().trim().min(1).max(100).optional(),
      clientSecretEnv: z.string().regex(SECRET_NAME_RE).optional(),
      allowedUsers: z.array(z.string()).optional(),
      allowedOrgs: z.array(z.string()).optional(),
      callbackUrl: z.string().url().nullable().optional(),
    })
    .strict();
  const patchSchema = z
    .object({
      configVersion: z.string().min(1),
      patch: z
        .object({
          github: githubPatch.nullable().optional(),
          local: z.object({ baseDir: z.string().min(1).max(1000) }).strict().optional(),
          ask: z
            .object({
              default: z.string().nullable().optional(),
              models: z.array(z.record(z.string(), z.unknown())).optional(),
              maxToolCalls: z.number().optional(),
              tokenBudget: z.number().optional(),
              timeoutMs: z.number().optional(),
              maxOutputTokens: z.number().optional(),
              /** `ask.limits` (e.g. maxToolResultTokens + per-tool overrides); validated by the config schema. */
              limits: z.record(z.string(), z.unknown()).optional(),
            })
            .strict()
            .optional(),
          embedding: z.record(z.string(), z.unknown()).optional(),
          /** `database` block (validated strictly by the config schema; null removes an optional key). */
          database: z.record(z.string(), z.unknown()).optional(),
          git: z
            .object({
              backend: z.enum(['embedded', 'cli']).optional(),
              cliPath: z.string().min(1).optional(),
              author: z.object({ name: z.string().min(1), email: z.string().min(1) }).strict().optional(),
              auth: z.record(z.string(), z.unknown()).optional(),
              autoPush: z.record(z.string(), z.unknown()).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict();

  app.put(
    '/ui/setup/config',
    wrap(async (req) => {
      const { configVersion, patch } = patchSchema.parse(req.body);
      if (patch.github !== undefined && d.mode !== 'server') throw new AdminError(400, 'invalid_input', 'GitHub sign-in exists only in server mode', 'github');
      if (patch.local && d.mode !== 'local') throw new AdminError(400, 'invalid_input', 'the projects folder applies to local mode', 'local');
      if (patch.local) d.browser.resolve(patch.local.baseDir, false); // confined to home
      if (patch.database && d.mode !== 'server') throw new AdminError(400, 'invalid_input', 'the database backend is a server-mode setting (local mode uses SQLite)', 'database');
      if (patch.database && ['url', 'connectionString', 'password'].some((k) => k in patch.database!)) throw new AdminError(400, 'invalid_input', 'never put the database URL in config.json: save it as a secret and name the variable in urlEnv', 'database');
      const version = d.config.patch(configVersion, (json) => {
        const obj = (k: string) => (json[k] && typeof json[k] === 'object' ? (json[k] as Record<string, unknown>) : {});
        if (patch.github !== undefined) {
          const auth = obj('auth');
          if (patch.github === null) delete auth.github;
          else {
            const g = { ...((auth.github as Record<string, unknown>) ?? {}), ...patch.github };
            if (g.callbackUrl === null) delete g.callbackUrl;
            if (!d.repoAuth && !((g.allowedUsers as string[] | undefined)?.length || (g.allowedOrgs as string[] | undefined)?.length)) throw new AdminError(400, 'invalid_input', 'a remote server needs allowedUsers or allowedOrgs: anyone who can reach the URL could otherwise sign in', 'allowedUsers');
            auth.github = g;
          }
          json.auth = auth;
        }
        if (patch.local) json.local = { ...obj('local'), ...patch.local };
        if (patch.ask) {
          // Legacy single-model blocks become { models } (the schema's preprocess reads both); other keys are kept.
          const cur = obj('ask');
          const legacy = 'provider' in cur && patch.ask.models !== undefined; // replacing the models of a legacy block
          const base = legacy ? Object.fromEntries(Object.entries(cur).filter(([k]) => ['maxToolCalls', 'timeoutMs', 'tokenBudget', 'maxOutputTokens', 'limits'].includes(k))) : cur;
          const { limits, ...rest } = patch.ask;
          json.ask = { ...base, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(limits ? { limits: { ...((base.limits as object) ?? {}), ...limits } } : {}) };
        }
        if (patch.embedding) {
          // null clears an optional field (requestDimensions, preset) instead of storing null.
          const next: Record<string, unknown> = { ...obj('embedding'), ...patch.embedding };
          for (const k of ['requestDimensions', 'preset']) if (next[k] === null) delete next[k];
          json.embedding = next;
        }
        if (patch.database) {
          const next: Record<string, unknown> = { ...obj('database'), ...patch.database };
          for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
          json.database = next;
        }
        if (patch.git) {
          const git = obj('git');
          const { auth, autoPush, ...rest } = patch.git;
          json.git = { ...git, ...rest, ...(auth ? { auth: { ...((git.auth as object) ?? {}), ...auth } } : {}), ...(autoPush ? { autoPush: { ...((git.autoPush as object) ?? {}), ...autoPush } } : {}) };
        }
      });
      d.log?.info('settings saved to config.json');
      // The embedding block hot-reloads: apply it to the open projects now (the rest pick it up on their next read).
      if (patch.embedding) void d.local.registry.opened().then((rs) => rs.forEach((r) => r.index?.refreshEmbedding()), () => undefined);
      return { configVersion: version, restartRequired: !!(patch.git?.backend || patch.git?.cliPath || patch.database) };
    }),
  );

  app.put(
    '/ui/setup/mode',
    wrap(async (req) => {
      const b = z
        .object({ configVersion: z.string().min(1), mode: z.enum(['local', 'server']), publicUrl: z.string().url().optional(), bind: z.string().min(1).optional(), trustProxy: z.boolean().optional() })
        .strict()
        .parse(req.body);
      if (b.mode === 'server' && !b.publicUrl && !d.config.parsed().server.publicUrl) throw new AdminError(400, 'invalid_input', 'server mode needs the public URL (https://…)', 'publicUrl');
      const version = d.config.patch(b.configVersion, (json) => {
        const server = (json.server as Record<string, unknown>) ?? {};
        json.server = { ...server, mode: b.mode, ...(b.publicUrl ? { publicUrl: b.publicUrl } : {}), ...(b.bind ? { bind: b.bind } : {}), ...(b.trustProxy !== undefined ? { trustProxy: b.trustProxy } : {}) };
      });
      d.log?.warn(`deployment mode set to ${b.mode}; restart Mandate to apply`);
      return { configVersion: version, restartRequired: true };
    }),
  );

  app.put(
    '/ui/setup/secret',
    wrap(async (req) => {
      const b = z.object({ name: z.string().regex(SECRET_NAME_RE, 'an environment variable name like MY_API_KEY'), value: z.string().min(1).max(4096).nullable() }).strict().parse(req.body);
      setSecret(d.secretsFile, b.name, b.value);
      d.log?.info(`secret ${b.name} ${b.value === null ? 'removed' : 'set'} in secrets.env`);
      return { name: b.name, set: !!process.env[b.name] };
    }),
  );

  /* -------------------------------------------------------------- tests */

  const keyOf = (apiKey: string | undefined, env: string | null | undefined) => {
    refreshSecrets();
    return apiKey || (env && SECRET_NAME_RE.test(env) ? process.env[env] : undefined) || undefined;
  };

  if (d.mode === 'server') {
    app.post(
      '/ui/setup/test/github',
      wrap(async (req) => {
        const b = z.object({ clientId: z.string().trim().min(1).max(100), clientSecret: z.string().min(1).max(200).optional() }).strict().parse(req.body);
        const secret = b.clientSecret ?? keyOf(undefined, d.config.parsed().auth.github?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET');
        if (!secret) return { ok: false, message: 'Paste the client secret first.' };
        return probes.testGithubApp(b.clientId, secret, d.fetch, d.githubApi);
      }),
    );
  }

  const providerSchema = z
    .object({ provider: z.enum(['anthropic', 'openai', 'google', 'openai-compatible']), baseUrl: z.string().url().nullable().optional(), apiKeyEnv: z.string().nullable().optional(), apiKey: z.string().max(400).optional(), model: z.string().max(200).optional() })
    .strict();
  app.post(
    '/ui/setup/ask/models',
    wrap(async (req) => {
      const b = providerSchema.parse(req.body);
      return probes.listModels({ provider: b.provider, baseUrl: b.baseUrl ?? null, apiKey: keyOf(b.apiKey, b.apiKeyEnv) }, d.fetch);
    }),
  );
  app.post(
    '/ui/setup/ask/test',
    wrap(async (req) => {
      const b = providerSchema.parse(req.body);
      return probes.testModel({ provider: b.provider, baseUrl: b.baseUrl ?? null, apiKey: keyOf(b.apiKey, b.apiKeyEnv), ...(b.model ? { model: b.model } : {}) }, d.fetch);
    }),
  );
  /** Test connection: version, pgvector / pg_trgm (and their schema), privileges, pooler, TLS. The URL comes from the env var. */
  app.post(
    '/ui/setup/database/test',
    wrap(async (req) => {
      const b = z
        .object({ urlEnv: z.string().regex(SECRET_NAME_RE).optional(), ssl: z.enum(['disable', 'require', 'verify-full']).nullable().optional(), extensionsSchema: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/).nullable().optional(), createExtensions: z.boolean().optional() })
        .strict()
        .parse(req.body ?? {});
      if (d.mode !== 'server') throw new AdminError(400, 'invalid_input', 'the database backend is a server-mode setting', 'database');
      refreshSecrets();
      const cfg = d.config.parsed().database;
      const r = resolveDatabase({ ...cfg, driver: 'postgres', path: undefined, sslRootCertPath: undefined, ...(b.urlEnv ? { urlEnv: b.urlEnv } : {}), ...(b.ssl !== undefined ? { ssl: b.ssl ?? undefined } : {}) }, process.env, d.home);
      if (r.driver !== 'postgres' || !r.url) return { ok: false, message: `set the connection URL first (secret ${b.urlEnv ?? cfg.urlEnv})`, details: null };
      const res = await (d.probeDatabase ?? probePostgres)({ url: r.url, ...(r.ssl ? { ssl: r.ssl } : {}), ...(b.createExtensions ? { createExtensions: true } : {}), ...(b.extensionsSchema ?? cfg.extensionsSchema ? { extensionsSchema: (b.extensionsSchema ?? cfg.extensionsSchema)! } : {}) });
      const ext = Object.entries(res.extensions).map(([n, e]) => `${n} ${e.installed ? `✓ (${e.schema})` : e.available ? 'not enabled' : 'unavailable'}`).join(', ');
      return { ok: res.ok, message: res.ok ? `Connected: ${res.version?.split(' ').slice(0, 2).join(' ')}; ${ext}` : (res.errors[0] ?? 'failed'), details: res };
    }),
  );
  app.post(
    '/ui/setup/embedding/detect',
    wrap(async () => probes.detectOllama(d.fetch)),
  );
  /** Key for an embedding probe: pasted (never stored here), else the named env var (secrets.env). */
  const embedConn = z
    .object({
      baseUrl: z.string().url(),
      preset: z.enum(ENDPOINT_PRESETS).optional(),
      apiKeyEnv: z.string().regex(SECRET_NAME_RE).nullable().optional(),
      apiKey: z.string().max(400).optional(),
    })
    .strict();
  app.post(
    '/ui/setup/embedding/models',
    wrap(async (req) => {
      const b = embedConn.parse(req.body);
      return listEmbeddingModels({ baseUrl: b.baseUrl, apiKey: keyOf(b.apiKey, b.apiKeyEnv), ...(b.preset ? { preset: b.preset } : {}) }, d.fetch);
    }),
  );
  app.post(
    '/ui/setup/embedding/test',
    wrap(async (req) => {
      const b = embedConn
        .extend({ model: z.string().min(1).max(200), requestDimensions: z.number().int().min(16).max(8192).nullable().optional(), documentPrefix: z.string().max(500).optional() })
        .parse(req.body);
      return testEmbeddingModel({ baseUrl: b.baseUrl, model: b.model, apiKey: keyOf(b.apiKey, b.apiKeyEnv), requestDimensions: b.requestDimensions ?? null, ...(b.documentPrefix !== undefined ? { documentPrefix: b.documentPrefix } : {}) }, d.fetch);
    }),
  );
  /** Ask models on the same endpoint with a key: offer "use the same key as Ask model X" (env var names only). */
  app.post(
    '/ui/setup/embedding/keys',
    wrap(async (req) => {
      const b = z.object({ baseUrl: z.string().url(), apiKeyEnv: z.string().regex(SECRET_NAME_RE).optional() }).strict().parse(req.body);
      refreshSecrets();
      return { candidates: askKeyCandidates(b.baseUrl, d.config.parsed().ask.models, (n) => setFlag(n)), ...(b.apiKeyEnv ? { apiKeyEnvSet: setFlag(b.apiKeyEnv) } : {}) };
    }),
  );
  /** Model presets (prefixes, limits, sizes) for a model id. */
  app.post(
    '/ui/setup/embedding/preset',
    wrap(async (req) => {
      const b = z.object({ model: z.string().min(1).max(200) }).strict().parse(req.body);
      return modelPreset(b.model);
    }),
  );
  /**
   * What switching to `model` costs: distinct chunk texts × average tokens over the open projects, with the price when
   * known; plus each project's embedding state (which model answers queries while a backfill runs).
   */
  app.post(
    '/ui/setup/embedding/estimate',
    wrap(async (req) => {
      const b = z.object({ model: z.string().min(1).max(200), pricePerMTok: z.number().min(0).max(1000).nullable().optional() }).strict().parse(req.body);
      const runtimes = await d.local.registry.opened();
      let chunks = 0;
      let chars = 0;
      const projects = [];
      for (const r of runtimes) {
        if (!r.index) continue;
        const row = r.index.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(len), 0) AS c FROM (SELECT content_hash, MAX(LENGTH(prefix) + LENGTH(text)) AS len FROM chunks GROUP BY content_hash)').get() as { n: number; c: number };
        chunks += row.n;
        chars += row.c;
        const st = r.index.queue;
        projects.push({ id: r.config.id, chunks: row.n, pending: st?.pending() ?? 0, embedded: st?.embedded() ?? 0, serving: r.index.embeddingServing() });
      }
      // Same heuristic as the chunker's estimate: ~4 characters per token, +15 %.
      const avgTokens = chunks ? Math.ceil(((chars / chunks) * 1.15) / 4) : 0;
      const price = b.pricePerMTok ?? modelPreset(b.model).pricePerMTok ?? null;
      return { ...switchEstimate(chunks, avgTokens, price), avgTokens, pricePerMTok: price, projects };
    }),
  );

  app.post(
    '/ui/setup/git/test',
    wrap(async (req) => {
      const b = z
        .object({
          url: z.string().trim().min(1).max(500),
          backend: z.enum(['cli', 'embedded']),
          auth: z.object({ sshKeyPath: z.string().max(1000).nullable().optional(), passphrase: z.string().max(1000).optional(), useAgent: z.boolean().optional(), username: z.string().max(200).nullable().optional(), token: z.string().max(1000).optional() }).strict().optional(),
        })
        .strict()
        .parse(req.body);
      if (/^[a-z]+:\/\/[^/@\s]*:[^/@\s]*@/i.test(b.url)) throw new AdminError(400, 'invalid_input', 'no credentials in the URL', 'url');
      const f = d.config.parsed();
      if (b.backend === 'cli') {
        const r = await probes.testGitSystem(b.url, f.git.cliPath);
        return { ok: r.ok, message: r.message };
      }
      const a = b.auth ?? {};
      const keyPath = a.sshKeyPath === undefined ? f.git.auth.sshKeyPath : a.sshKeyPath;
      let auth: Parameters<typeof probes.testGitEmbedded>[1];
      if (keyPath && !a.useAgent) auth = { type: 'ssh', privateKeyPath: d.browser.resolve(keyPath), passphrase: a.passphrase ?? keyOf(undefined, f.git.auth.sshPassphraseEnv), username: 'git' };
      else if (a.token || (f.git.auth.tokenEnv && keyOf(undefined, f.git.auth.tokenEnv) && /^https?:/.test(b.url))) auth = { type: 'https', username: a.username ?? f.git.auth.username ?? 'git', token: a.token ?? keyOf(undefined, f.git.auth.tokenEnv)! };
      else if (/^(ssh:\/\/|[\w.-]+@)/.test(b.url)) auth = { type: 'ssh-agent', username: 'git' };
      return probes.testGitEmbedded(b.url, auth);
    }),
  );
  app.get(
    '/ui/setup/git/pubkey',
    wrap(async (req, reply) => {
      const p = d.browser.resolve(String((req.query as { path?: string }).path ?? ''));
      const info = probes.publicKeyInfo(p);
      if (!info) return fail(reply, 404, 'not_found', `no public key at ${p}.pub`, { path: 'path', hint: 'generate one: ssh-keygen -t ed25519' });
      return info;
    }),
  );

  app.post(
    '/ui/setup/complete',
    wrap(async (_req, reply, who) => {
      d.setup.markComplete();
      // Local mode: the setup link holder is on this machine; sign them in so "Open Mandate" just works.
      if (d.mode === 'local' && who.kind === 'setup') await localSession(reply);
      d.log?.info('setup completed');
      return { next: d.mode === 'local' ? 'local' : 'github' };
    }),
  );

  /* -------------------------------------------------------------- folder browser */

  app.get(
    '/ui/fs/list',
    wrap(async (req) => {
      const q = req.query as { path?: string; files?: string; hidden?: string };
      return d.browser.list(q.path, { files: q.files === '1', hidden: q.hidden === '1' });
    }),
  );
  app.get(
    '/ui/fs/inspect',
    wrap(async (req) => d.browser.inspect(String((req.query as { path?: string }).path ?? ''))),
  );
  app.post(
    '/ui/fs/mkdir',
    wrap(async (req) => ({ path: d.browser.mkdir(z.object({ path: z.string().min(1).max(1000) }).strict().parse(req.body).path) })),
  );

  /* -------------------------------------------------------------- local projects */

  if (d.mode === 'local') {
    app.post(
      '/ui/projects/local',
      wrap(async (req, reply) => {
        const deps: LocalProjectDeps = { ...d.local, browser: d.browser, baseDir: d.config.parsed().local.baseDir };
        if (String(req.headers.accept ?? '').includes('application/x-ndjson')) {
          reply.hijack();
          const res = reply.raw;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
          const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
          try {
            line({ project: await createLocalProject(deps, req.body, (step, status) => line({ step, status })) });
          } catch (e) {
            line({ error: e instanceof AdminError ? { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.hint ? { hint: e.hint } : {}) } : { code: 'internal', message: probes.scrub((e as Error).message) } });
          }
          res.end();
          return reply;
        }
        return reply.code(201).send({ project: await createLocalProject(deps, req.body) });
      }),
    );
  }
}

/** /auth/status additions: mode, setup state, admin flags. */
export function setupStatus(d: Pick<SetupDeps, 'mode' | 'legacyMode' | 'publicUrl' | 'setup' | 'auth' | 'source' | 'repoAuth'>) {
  return (req: FastifyRequest, user: { login: string } | null) => {
    const v = d.auth.store.unsign<{ h: string; exp: number }>(cookieOf(req, SETUP_COOKIE));
    const h = d.setup.tokenHash();
    const setupAccess = !!v && !!h && v.h === h && v.exp > Date.now();
    const complete = d.setup.complete();
    return {
      mode: d.mode,
      legacy: d.legacyMode,
      publicUrl: d.mode === 'server' ? d.publicUrl : null,
      setup: { complete, inSetupMode: !complete },
      setupAccess,
      isAdmin: (!!user && d.auth.isAdmin?.(user.login) !== false) || setupAccess,
      repoAuth: !!d.repoAuth,
      // Local mode needs no GitHub app: "configured" is about sign-in being possible.
      ...(d.mode === 'local' ? { configured: true, missing: [] } : {}),
    };
  };
}
