/**
 * First-run setup wizard + Settings API, GitHub App creation, and the SSE probe.
 * - `GET /auth/setup?token=`: the one-time setup link (CLI `setup-url`), only to open the wizard before GitHub sign-in
 *   works. Loopback only, or HTTPS. Sets the `mandate_setup` cookie (bound to the token: completing setup invalidates
 *   it) and redirects to `/setup`.
 * - `POST /ui/setup/github/manifest` + `GET /auth/github/app/created`: one-click GitHub App (manifest flow). The
 *   client secret and webhook secret go to secrets.env, the private key to a 0600 file; config gets ids only.
 * - `PUT /ui/setup/server`: the server address (public URL; bind / proxy trust derived); restart via
 *   `POST /ui/setup/restart`.
 * - `/ui/setup/*`, `/ui/fs/*`: admin = a signed-in session (any allowed user) or, until setup
 *   completes, the setup cookie. UI-only (X-Mandate-UI, no bearer keys), same-origin Origin on writes.
 * Secrets are write-only (secrets.env); responses only say whether they are set.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, cookieOf, originOk, SESSION_COOKIE, type AuthOptions } from '../auth/http.js';
import { ADMIN_CLAIM_COOKIE, GithubClient, GithubError, type AuthConfigSource } from '../auth/github.js';
import { parseDotenv, refreshSecrets } from '../secrets.js';
import { appTokensFor, gitAuthMethod, GIT_AUTH_METHODS } from '../config.js';
import { githubRepoOf } from '../auth/app-tokens.js';
import { AdminError } from '../projects/admin.js';
import { ConfigConflictError, setSecret, SECRET_NAME_RE, SetupAdminClaim, writePrivate, type ConfigFile, type SetupState } from './files.js';
import { FsError, type FolderBrowser } from './fs.js';
import type { ProjectRegistry } from '../projects/registry.js';
import * as probes from './probes.js';
import { ENDPOINT_PRESETS, endpointOf, isLocalEndpoint, modelPreset, switchEstimate } from '../index/embed/presets.js';
import { listEmbeddingModels, testEmbeddingModel } from '../index/embed/probe.js';
import { poolerOf, resolveDatabase } from '../db/config.js';
import { probePostgres } from '../db/probe.js';
import type { Restarter } from '../restart.js';

export const SETUP_COOKIE = 'mandate_setup';

export interface SetupDeps {
  /** GitHub repo permissions decide access: the allow-list is an optional extra gate (off for older OAuth App installs). */
  repoAuth?: boolean;
  /** GitHub client for the manifest conversion (tests: a mock). */
  github?: GithubClient;
  publicUrl: string;
  trustProxy: boolean;
  port: number;
  home: string;
  localBaseDir: string;
  auth: AuthOptions;
  source: AuthConfigSource;
  setup: SetupState;
  config: ConfigFile;
  secretsFile: string;
  browser: FolderBrowser;
  hostOk: (req: FastifyRequest) => boolean;
  local: { registry: ProjectRegistry };
  fetch?: probes.Fetch;
  githubApi?: string;
  /** Database driver of the running server. */
  activeDatabase?: 'sqlite' | 'postgres';
  /**
   * Hot-apply of saved settings (no restart): `git` re-reads config.json and switches every project's git backend;
   * `database` switches the server-state database (and reports whether it changed). Each throws, leaving the running
   * server unchanged, when the new setting cannot be applied; the saved change is then rolled back.
   */
  apply?: { git?: () => Promise<unknown>; database?: () => Promise<unknown>; databaseUrlEnv?: () => string | null };
  /** Self-restart after a public URL / bind change (POST /ui/setup/restart). */
  restarter?: Restarter;
  /** The public URL the server will use after a restart (re-read from config.json). */
  nextPublicUrl?: () => string | null;
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

const isLoopbackHost = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h.toLowerCase());

/**
 * `server` settings for an address: localhost → listen on 127.0.0.1, no proxy; https → behind a reverse proxy on this
 * machine (127.0.0.1, X-Forwarded-* trusted); plain http on another host → reached directly (all interfaces).
 */
export function serverAddress(origin: string): { publicUrl: string; bind: string; trustProxy: boolean } {
  const u = new URL(origin);
  if (isLoopbackHost(u.hostname)) return { publicUrl: u.origin, bind: '127.0.0.1', trustProxy: false };
  if (u.protocol === 'https:') return { publicUrl: u.origin, bind: '127.0.0.1', trustProxy: true };
  return { publicUrl: u.origin, bind: '0.0.0.0', trustProxy: false };
}

/** `<scheme>://<host>` of the request (the Host the browser used: the Vite proxy in development), or null. */
function requestOrigin(req: FastifyRequest, trustProxy: boolean): string | null {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!/^[a-z0-9.[\]:-]+$/.test(host)) return null;
  const https = requestIsHttps(req, trustProxy);
  return `${https ? 'https' : 'http'}://${host}`;
}

const fail = (reply: FastifyReply, status: number, code: string, message: string, extra: { path?: string; hint?: string } = {}) => reply.code(status).send({ error: { code, message, ...extra } });

export function registerSetupRoutes(app: FastifyInstance, d: SetupDeps): void {
  const secure = d.publicUrl.startsWith('https://') ? '; Secure' : '';
  const gh = d.github ?? new GithubClient();

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

  // SSE probe for the team "SSE through the proxy" check: one event now, the end 1.5 s later.
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
    // Remote use of the token only over HTTPS (a team); plain-http non-loopback requests are refused.
    if (!local && !requestIsHttps(req, d.trustProxy)) return fail(reply, 403, 'forbidden', 'the setup link works on this machine (or over HTTPS); use an SSH tunnel until HTTPS is set up');
    if (!d.hostOk(req)) return fail(reply, 403, 'forbidden', 'forbidden host');
    if (d.setup.complete()) return reply.redirect('/setup?error=already_complete');
    if (!d.setup.checkToken(token)) return reply.redirect('/setup?error=invalid_token');
    const cookie = d.auth.store.sign({ h: d.setup.tokenHash(), exp: Date.now() + 6 * 3600_000 });
    reply.header('Set-Cookie', `${SETUP_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600${secure}`);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect('/setup');
  });

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
        legacy: !d.repoAuth,
        config: {
          server: { publicUrl: f.server.publicUrl ?? null, bind: f.server.bind ?? f.server.host, port: f.server.port, trustProxy: f.server.trustProxy },
          github: {
            clientId: g?.clientId ?? null,
            clientSecretEnv: g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET',
            clientSecretSet: setFlag(g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET'),
            allowedUsers: g?.allowedUsers ?? [],
            allowedOrgs: g?.allowedOrgs ?? [],
            callbackUrl: g?.callbackUrl ?? null,
            /** 'app' (GitHub App, the default for new setups) or 'oauth' (an existing OAuth App). */
            kind: g?.app ? 'app' : g?.clientId ? 'oauth' : null,
            app: g?.app ? { id: g.app.id, slug: g.app.slug, owner: g.app.owner ?? null, ownerType: g.app.ownerType ?? null, htmlUrl: g.app.htmlUrl ?? null, installUrl: `${gh.webBase}/apps/${g.app.slug}/installations/new`, privateKeySet: !!g.app.privateKeyPath && existsSync(g.app.privateKeyPath) } : null,
            suggested: { name: 'Mandate', homepageUrl: d.publicUrl, callbackUrl: `${d.publicUrl}/auth/github/callback` },
          },
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
            /** The backend this running server uses (saved changes switch it live). */
            active: d.activeDatabase ?? 'sqlite',
          },
          git: {
            backend: f.git.backend,
            cliPath: f.git.cliPath,
            author: f.git.author,
            auth: {
              /** Saved `git.auth.method` (null = default) and the method in effect ('app': GitHub App tokens over HTTPS). */
              method: f.git.auth.method ?? null,
              effectiveMethod: gitAuthMethod({ explicit: f.git.auth.method, backend: f.git.backend, appConfigured: !!f.auth.github?.app?.privateKeyPath, sshKeyPath: f.git.auth.sshKeyPath, tokenEnv: f.git.auth.tokenEnv }),
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
    wrap(async () => ({ checks: await probes.environmentChecks({ home: d.home, localBaseDir: d.localBaseDir, port: d.port, publicUrl: d.publicUrl, ...(d.fetch ? { fetch: d.fetch } : {}) }) })),
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
      if (patch.database && ['url', 'connectionString', 'password'].some((k) => k in patch.database!)) throw new AdminError(400, 'invalid_input', 'never put the database URL in config.json: save it as a secret and name the variable in urlEnv', 'database');
      const before = d.config.text();
      const version = d.config.patch(configVersion, (json) => {
        const obj = (k: string) => (json[k] && typeof json[k] === 'object' ? (json[k] as Record<string, unknown>) : {});
        if (patch.github !== undefined) {
          const auth = obj('auth');
          if (patch.github === null) delete auth.github;
          else {
            const g = { ...((auth.github as Record<string, unknown>) ?? {}), ...patch.github };
            if (g.callbackUrl === null) delete g.callbackUrl;
            // An older OAuth App install (no repo permissions) admits only the allow-list: it must not be empty.
            if (!d.repoAuth && !((g.allowedUsers as string[] | undefined)?.length || (g.allowedOrgs as string[] | undefined)?.length)) throw new AdminError(400, 'invalid_input', 'a remote server needs allowedUsers or allowedOrgs: anyone who can reach the URL could otherwise sign in', 'allowedUsers');
            auth.github = g;
          }
          json.auth = auth;
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
      // Git backend and database switch live; a change that cannot be applied is rolled back (file and server).
      const gitChange = !!(patch.git?.backend || patch.git?.cliPath);
      const applied: ('git' | 'database')[] = [];
      try {
        if (gitChange && d.apply?.git) {
          await d.apply.git();
          applied.push('git');
        }
        if (patch.database && d.apply?.database) {
          await d.apply.database();
          applied.push('database');
        }
      } catch (e) {
        d.config.restore(before);
        if (applied.includes('git')) await d.apply?.git?.().catch(() => undefined);
        const what = applied.includes('git') || !gitChange || !d.apply?.git ? 'database' : 'git backend';
        throw new AdminError(400, 'apply_failed', `The new ${what} setting could not be applied, so nothing changed: ${probes.scrub((e as Error).message)}`, what === 'database' ? 'database' : 'git');
      }
      const restartRequired = (gitChange && !d.apply?.git) || (!!patch.database && !d.apply?.database);
      return { configVersion: version, applied, restartRequired };
    }),
  );

  /**
   * The server address (`server.publicUrl`): the URL people and agents use. Bind and proxy trust follow from it unless
   * given (Advanced): a localhost URL listens on 127.0.0.1 without proxy trust; any other URL is expected behind a
   * reverse proxy on this machine (127.0.0.1, X-Forwarded-* trusted). Applies on the restart that follows
   * (POST /ui/setup/restart). The GitHub App's callback is derived from it.
   */
  app.put(
    '/ui/setup/server',
    wrap(async (req) => {
      const b = z
        .object({ configVersion: z.string().min(1), publicUrl: z.string().url(), bind: z.string().min(1).max(100).optional(), trustProxy: z.boolean().optional() })
        .strict()
        .parse(req.body);
      const u = new URL(b.publicUrl);
      if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash) throw new AdminError(400, 'invalid_input', 'use the bare address, e.g. https://mandate.example.com', 'publicUrl');
      const version = d.config.patch(b.configVersion, (json) => {
        const derived = serverAddress(u.origin);
        json.server = { ...((json.server as Record<string, unknown>) ?? {}), ...derived, ...(b.bind ? { bind: b.bind } : {}), ...(b.trustProxy !== undefined ? { trustProxy: b.trustProxy } : {}) };
        const server = json.server as Record<string, unknown>;
        delete server.mode; // older settings: there is one setup (GitHub sign-in)
        delete server.users;
        delete server.host;
      });
      d.log?.warn(`server address set to ${u.origin}; it applies when Mandate restarts`);
      let url: string | null = null;
      try {
        url = d.nextPublicUrl?.() ?? null;
      } catch {
        /* unknown until restart */
      }
      return { configVersion: version, restartRequired: true, url, restart: { kind: d.restarter?.kind() ?? 'manual', command: d.restarter?.command() ?? 'mandate restart' } };
    }),
  );

  /* -------------------------------------------------------------- one-click GitHub App (manifest flow) */

  const APP_COOKIE = 'mandate_ghapp';
  /**
   * Start: the browser POSTs `manifest` to `action` (a form, so GitHub shows "Create GitHub App"). The state is bound
   * to this browser with a signed, short-lived cookie: the redirect back is a cross-site navigation, where the
   * SameSite=Strict setup cookie is not sent, so this cookie (Lax, path-scoped) proves it is the same admin.
   */
  app.post(
    '/ui/setup/github/manifest',
    wrap(async (req, reply) => {
      const b = z
        .object({
          /** `user` (the signed-in GitHub account) or an organization login. */
          owner: z.union([z.literal('user'), z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'an organization login')]),
          /** Installable on other accounts / organizations (needed for a personal app used with org repos). */
          public: z.boolean().optional(),
          name: z.string().trim().min(1).max(34).optional(),
        })
        .strict()
        .parse(req.body);
      const base = requestOrigin(req, d.trustProxy) ?? d.publicUrl;
      const org = b.owner === 'user' ? null : b.owner;
      const state = randomBytes(24).toString('base64url');
      // The wizard runs on the server: the origin it was opened on is the address people and agents use.
      const explicit = d.config.parsed().auth.github?.callbackUrl;
      const host = (() => {
        try {
          return new URL(base).hostname.replace(/[^a-z0-9-]/gi, '-').slice(0, 18);
        } catch {
          return 'local';
        }
      })();
      // App names are unique on GitHub: a short random suffix (the user may rename it on GitHub's page).
      const name = b.name ?? `Mandate ${host} ${randomBytes(2).toString('hex')}`.slice(0, 34);
      const manifest = {
        name,
        url: base,
        description: 'Mandate: specifications for coding agents (sign-in and repository access).',
        redirect_url: `${base}/auth/github/app/created`,
        callback_urls: [...new Set([`${base}/auth/github/callback`, ...(explicit ? [explicit] : [])])].slice(0, 10),
        setup_url: `${base}/?github=installed`,
        setup_on_update: true,
        request_oauth_on_install: false,
        public: b.public ?? !org,
        default_permissions: { contents: 'write', metadata: 'read', ...(org || (d.config.parsed().auth.github?.allowedOrgs.length ?? 0) > 0 ? { members: 'read' } : {}) },
        default_events: [],
      };
      const action = `${gh.webBase}${org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new'}?state=${encodeURIComponent(state)}`;
      const cookie = d.auth.store.sign({ state, base, exp: Date.now() + 3600_000 });
      reply.header('Set-Cookie', `${APP_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/auth/github/app; Max-Age=3600${secure}`);
      reply.header('Cache-Control', 'no-store');
      return { action, manifest: JSON.stringify(manifest), state };
    }),
  );

  /** GitHub redirects here after "Create GitHub App": exchange the code, store the secrets, write the config. */
  app.get('/auth/github/app/created', async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    const saved = d.auth.store.unsign<{ state: string; base?: string; exp: number }>(cookieOf(req, APP_COOKIE));
    const back = (qs: string) => {
      reply.header('Set-Cookie', `${APP_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/github/app; Max-Age=0`);
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(`${d.setup.complete() ? '/settings?section=github&' : '/setup?'}${qs}`);
    };
    if (!d.hostOk(req)) return fail(reply, 403, 'forbidden', 'forbidden host');
    if (!saved || saved.exp <= Date.now() || typeof q.state !== 'string' || q.state !== saved.state) return back('github=state_mismatch');
    if (typeof q.code !== 'string' || !q.code) return back('github=cancelled');
    try {
      const c = await gh.convertManifest(q.code);
      const cur = d.config.parsed().auth.github;
      const secretEnv = cur?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET';
      const webhookEnv = 'MANDATE_GITHUB_WEBHOOK_SECRET';
      const keyFile = path.join(d.home, 'github-app.pem');
      // Secrets: secrets.env (0600) and a 0600 key file; never config, logs or responses.
      setSecret(d.secretsFile, secretEnv, c.clientSecret);
      if (c.webhookSecret) setSecret(d.secretsFile, webhookEnv, c.webhookSecret);
      writePrivate(keyFile, c.pem.endsWith('\n') ? c.pem : `${c.pem}\n`);
      refreshSecrets();
      d.config.patch(d.config.version(), (json) => {
        const auth = (json.auth as Record<string, unknown>) ?? {};
        const g = { ...((auth.github as Record<string, unknown>) ?? {}) };
        delete g.callbackUrl; // the app was registered with <address>/auth/github/callback
        // The address the wizard was opened on becomes the server address (bind / proxy trust derived from it).
        if (saved.base) json.server = { ...((json.server as Record<string, unknown>) ?? {}), ...serverAddress(saved.base) };
        json.auth = {
          ...auth,
          github: {
            ...g,
            clientId: c.clientId,
            clientSecretEnv: secretEnv,
            app: { id: c.id, slug: c.slug, ...(c.owner ? { owner: c.owner } : {}), ownerType: c.ownerType, ...(c.htmlUrl ? { htmlUrl: c.htmlUrl } : {}), privateKeyPath: keyFile, ...(c.webhookSecret ? { webhookSecretEnv: webhookEnv } : {}) },
          },
        };
      });
      d.log?.info(`GitHub App created: ${c.slug} (id ${c.id}); secrets saved to secrets.env and ${keyFile}`);
      return back(`github=created&app=${encodeURIComponent(c.slug)}${c.owner ? `&owner=${encodeURIComponent(c.owner)}` : ''}`);
    } catch (e) {
      d.log?.warn(`GitHub App creation failed: ${probes.scrub((e as Error).message)}`);
      return back(`github=${e instanceof GithubError && e.status === 404 ? 'expired' : 'failed'}`);
    }
  });

  // Restart this server (a new public URL / bind address). Admin / setup session, same-origin writes only.
  app.post(
    '/ui/setup/restart',
    wrap(async (_req, _reply, who) => {
      const kind = d.restarter?.kind() ?? 'manual';
      const command = d.restarter?.command() ?? 'mandate restart';
      const restarting = !!d.restarter?.trigger();
      d.log?.warn(restarting ? `restart requested from the UI (${who.kind === 'user' ? who.login : 'setup session'}): restarting (${kind})` : `restart requested from the UI, but this server is not supervised: run ${command}`);
      return { restarting, kind, command };
    }),
  );

  app.put(
    '/ui/setup/secret',
    wrap(async (req) => {
      const b = z.object({ name: z.string().regex(SECRET_NAME_RE, 'an environment variable name like MY_API_KEY'), value: z.string().min(1).max(4096).nullable() }).strict().parse(req.body);
      const dbUrl = d.apply?.database && d.apply.databaseUrlEnv?.() === b.name;
      const prev = dbUrl && existsSync(d.secretsFile) ? (parseDotenv(readFileSync(d.secretsFile, 'utf8')).get(b.name) ?? null) : null;
      setSecret(d.secretsFile, b.name, b.value);
      d.log?.info(`secret ${b.name} ${b.value === null ? 'removed' : 'set'} in secrets.env`);
      // The running database's URL changed: switch to it now (a failure restores the previous value).
      if (dbUrl) {
        try {
          await d.apply!.database!();
        } catch (e) {
          setSecret(d.secretsFile, b.name, prev);
          throw new AdminError(400, 'apply_failed', `The new database URL could not be used, so nothing changed: ${probes.scrub((e as Error).message)}`, 'database');
        }
        return { name: b.name, set: !!process.env[b.name], applied: ['database'] };
      }
      return { name: b.name, set: !!process.env[b.name] };
    }),
  );

  /* -------------------------------------------------------------- tests */

  const keyOf = (apiKey: string | undefined, env: string | null | undefined) => {
    refreshSecrets();
    return apiKey || (env && SECRET_NAME_RE.test(env) ? process.env[env] : undefined) || undefined;
  };

  {
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

  /** Test connection: version, pgvector / pg_trgm (and their schema), privileges, pooler, TLS. The URL comes from the env var. */
  app.post(
    '/ui/setup/database/test',
    wrap(async (req) => {
      const b = z
        .object({ urlEnv: z.string().regex(SECRET_NAME_RE).optional(), ssl: z.enum(['disable', 'require', 'verify-full']).nullable().optional(), extensionsSchema: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/).nullable().optional(), createExtensions: z.boolean().optional() })
        .strict()
        .parse(req.body ?? {});
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
  /** Whether the key env var of an embedding endpoint is set (names only, never the key). */
  app.post(
    '/ui/setup/embedding/keys',
    wrap(async (req) => {
      const b = z.object({ baseUrl: z.string().url(), apiKeyEnv: z.string().regex(SECRET_NAME_RE).optional() }).strict().parse(req.body);
      refreshSecrets();
      return b.apiKeyEnv ? { apiKeyEnvSet: setFlag(b.apiKeyEnv) } : {};
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
          auth: z.object({ method: z.enum(GIT_AUTH_METHODS).optional(), sshKeyPath: z.string().max(1000).nullable().optional(), passphrase: z.string().max(1000).optional(), useAgent: z.boolean().optional(), username: z.string().max(200).nullable().optional(), token: z.string().max(1000).optional() }).strict().optional(),
        })
        .strict()
        .parse(req.body);
      if (/^[a-z]+:\/\/[^/@\s]*:[^/@\s]*@/i.test(b.url)) throw new AdminError(400, 'invalid_input', 'no credentials in the URL', 'url');
      const f = d.config.parsed();
      const a = b.auth ?? {};
      if (a.method === 'app') {
        // GitHub App: an installation token minted for the URL's repo (clear error + install URL when not installed).
        const gh = githubRepoOf(b.url, new URL(process.env.MANDATE_GITHUB_URL || 'https://github.com').host);
        if (!gh) throw new AdminError(400, 'invalid_input', 'the GitHub App method needs a GitHub repository URL (https://github.com/<owner>/<repo>.git)', 'url');
        const tokens = appTokensFor(d.config.file);
        if (!tokens.available()) return { ok: false, message: 'No GitHub App with a private key is configured yet: create it in the GitHub step first.' };
        const url = `${(process.env.MANDATE_GITHUB_URL || 'https://github.com').replace(/\/+$/, '')}/${gh.owner}/${gh.repo}.git`;
        try {
          await tokens.token(gh.owner, gh.repo);
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
        return probes.testGitEmbedded(url, { type: 'github-app', owner: gh.owner, repo: gh.repo, token: () => tokens.token(gh.owner, gh.repo) });
      }
      if (b.backend === 'cli') {
        const r = await probes.testGitSystem(b.url, f.git.cliPath);
        return { ok: r.ok, message: r.message };
      }
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
      // The setup-link holder becomes the first admin on their GitHub sign-in (single-use claim, identity from GitHub).
      if (who.kind === 'setup') {
        const nonce = new SetupAdminClaim(d.home).issue();
        reply.header('Set-Cookie', `${ADMIN_CLAIM_COOKIE}=${d.auth.store.sign({ n: nonce })}; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=3600${secure}`);
      }
      d.setup.markComplete();
      d.log?.info('setup completed');
      // A new server address (saved with the GitHub App) applies on a restart: a supervised server restarts itself.
      let next: string | null = null;
      try {
        next = d.nextPublicUrl?.() ?? null;
      } catch {
        /* unknown */
      }
      const restarting = !!next && next !== d.publicUrl && (d.restarter?.kind() ?? 'manual') !== 'manual';
      if (restarting) setTimeout(() => d.restarter?.trigger(), 300).unref?.();
      return { next: 'github', restarting };
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


}

/**
 * The GitHub callback's first-admin hook: a valid, unused claim from this browser makes `login` an admin
 * (`auth.github.allowedUsers`). Consumed once; the login comes from GitHub, never from the browser.
 */
export function adminClaimHook(d: Pick<SetupDeps, 'home' | 'auth' | 'config' | 'log'>) {
  return async (req: FastifyRequest, login: string): Promise<boolean> => {
    const v = d.auth.store.unsign<{ n?: string }>(cookieOf(req, ADMIN_CLAIM_COOKIE));
    if (!v?.n || !new SetupAdminClaim(d.home).consume(v.n)) return false;
    d.config.patch(d.config.version(), (json) => {
      const auth = (json.auth as Record<string, unknown>) ?? {};
      const g = { ...((auth.github as Record<string, unknown>) ?? {}) };
      const users = (g.allowedUsers as string[] | undefined) ?? [];
      if (!users.some((u) => u.toLowerCase() === login.toLowerCase())) g.allowedUsers = [...users, login];
      json.auth = { ...auth, github: g };
    });
    d.log?.info(`first admin: ${login}`);
    return true;
  };
}

/** /auth/status additions: setup state, admin flags. */
export function setupStatus(d: Pick<SetupDeps, 'publicUrl' | 'setup' | 'auth' | 'source' | 'repoAuth'>) {
  return (req: FastifyRequest, user: { login: string } | null) => {
    const v = d.auth.store.unsign<{ h: string; exp: number }>(cookieOf(req, SETUP_COOKIE));
    const h = d.setup.tokenHash();
    const setupAccess = !!v && !!h && v.h === h && v.exp > Date.now();
    const complete = d.setup.complete();
    return {
      legacy: !d.repoAuth,
      publicUrl: d.publicUrl,
      setup: { complete, inSetupMode: !complete },
      setupAccess,
      isAdmin: (!!user && d.auth.isAdmin?.(user.login) !== false) || setupAccess,
      repoAuth: !!d.repoAuth,
    };
  };
}
