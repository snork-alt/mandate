/**
 * GitHub sign-in for the web UI (OAuth web flow with `state` + PKCE S256) and the small GitHub REST client the
 * project setup uses. The `auth` block of config.json and the client secret (env / secrets.env) are re-read on
 * change, so the first-run setup page turns into the login page without a restart.
 * Scopes: sign-in asks only for what the allow-list needs (`read:org` when `allowedOrgs` is set, else none);
 * "New project" upgrades to `repo` (private repos) or `public_repo` incrementally.
 */
import { userDirectory } from './users.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authConfigSchema, readRawConfig, type AuthConfig } from '../config.js';
import { refreshSecrets } from '../secrets.js';
import { cookieOf, originOk, sessionForMode, SESSION_COOKIE, type AuthOptions } from './http.js';
import type { SessionUser } from './sessions.js';

export const DEFAULT_CALLBACK_URL = 'http://localhost:5173/auth/github/callback';
const OAUTH_COOKIE = 'mandate_oauth';
const OAUTH_TTL_MS = 10 * 60_000;
export const UPGRADE_SCOPES = ['repo', 'public_repo'] as const;

export interface GithubSettings {
  clientId: string;
  clientSecret: string;
  allowedUsers: string[];
  allowedOrgs: string[];
  callbackUrl: string;
}

export interface AuthState {
  configured: boolean;
  /** Exact missing fields (empty when configured). */
  missing: string[];
  callbackUrl: string;
  sessionTtlHours: number;
  github: GithubSettings | null;
}

/** The `auth` block, re-read when config.json changes; the secret is read from the env on every call. */
export class AuthConfigSource {
  private stamp = '';
  private cfg: AuthConfig;

  constructor(
    private readonly configPath: string | null,
    initial: AuthConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log?: { warn(m: string): void },
    /** `<publicUrl>/auth/github/callback` (server mode); the dev default otherwise. */
    private readonly defaultCallbackUrl: string = DEFAULT_CALLBACK_URL,
    /** false with repo-based permissions: anyone may sign in and sees only the projects whose repo they can read. */
    readonly allowListRequired = true,
  ) {
    this.cfg = initial;
  }

  private reload() {
    if (!this.configPath) return;
    try {
      const st = statSync(this.configPath);
      const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (stamp === this.stamp) return;
      this.stamp = stamp;
      const raw = readRawConfig(this.configPath).auth ?? {};
      const r = authConfigSchema.safeParse(raw);
      if (r.success) this.cfg = r.data;
      else this.log?.warn(`auth config invalid (keeping the previous one): ${r.error.issues.map((i) => `auth.${i.path.join('.')}: ${i.message}`).join('; ')}`);
    } catch {
      // unreadable: keep the last good config
    }
  }

  /** `auth.github.allowedUsers` (re-read on change), e.g. for admin rights. */
  allowedUsers(): string[] {
    this.reload();
    return this.cfg.github?.allowedUsers ?? [];
  }

  current(): AuthState {
    this.reload();
    if (this.env === process.env) refreshSecrets();
    const g = this.cfg.github;
    const callbackUrl = g?.callbackUrl ?? this.defaultCallbackUrl;
    const missing: string[] = [];
    if (!g) missing.push('auth.github');
    if (!g?.clientId) missing.push('auth.github.clientId');
    const secretEnv = g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET';
    const secret = this.env[secretEnv];
    if (!secret) missing.push(`env ${secretEnv} (auth.github.clientSecretEnv) is not set`);
    if (this.allowListRequired && !g?.allowedUsers.length && !g?.allowedOrgs.length) missing.push('auth.github.allowedUsers or auth.github.allowedOrgs (at least one)');
    const configured = missing.length === 0;
    return {
      configured,
      missing,
      callbackUrl,
      sessionTtlHours: this.cfg.sessionTtlHours,
      github: configured ? { clientId: g!.clientId!, clientSecret: secret!, allowedUsers: g!.allowedUsers, allowedOrgs: g!.allowedOrgs, callbackUrl } : null,
    };
  }
}

/* ------------------------------------------------------------------ REST client */

export interface GithubRepo {
  fullName: string;
  owner: string;
  /** Owner avatar (GitHub CDN URL) or null. */
  ownerAvatarUrl: string | null;
  /** 'User' | 'Organization' (for the owner filter). */
  ownerType: string | null;
  name: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  empty: boolean;
  description: string | null;
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface GithubEndpoints {
  /** https://github.com (OAuth). */
  web: string;
  /** https://api.github.com (REST). */
  api: string;
  fetch: typeof fetch;
}

export const GITHUB: GithubEndpoints = { web: 'https://github.com', api: 'https://api.github.com', fetch: (...a) => fetch(...a) };

type RawRepo = { full_name: string; name: string; owner: { login: string; avatar_url?: string; type?: string }; private: boolean; default_branch?: string | null; pushed_at?: string | null; size?: number; description?: string | null };
const toRepo = (r: RawRepo): GithubRepo => ({
  fullName: r.full_name,
  owner: r.owner.login,
  ownerAvatarUrl: r.owner.avatar_url ?? null,
  ownerType: r.owner.type ?? null,
  name: r.name,
  private: r.private,
  defaultBranch: r.default_branch ?? null,
  pushedAt: r.pushed_at ?? null,
  empty: (r.size ?? 0) === 0,
  description: r.description ?? null,
});

export class GithubClient {
  constructor(private readonly ep: GithubEndpoints = GITHUB) {}

  get webBase(): string {
    return this.ep.web;
  }

  private async api<T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T; scopes: string[] | null }> {
    const res = await this.ep.fetch(`${this.ep.api}${path}`, {
      ...init,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const scopes = res.headers.get('x-oauth-scopes');
    return { status: res.status, body: body as T, scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean) };
  }

  private fail(status: number, what: string, body: unknown): never {
    const msg = body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message).slice(0, 200) : `HTTP ${status}`;
    throw new GithubError(status, `GitHub ${what}: ${msg}`);
  }

  /** Exchange the OAuth code (+ PKCE verifier). The secret travels only in this POST body. */
  async exchangeCode(s: GithubSettings, code: string, verifier: string): Promise<{ token: string; scopes: string[] }> {
    const res = await this.ep.fetch(`${this.ep.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mandate' },
      body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: s.callbackUrl, code_verifier: verifier }),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
    if (!res.ok || !j.access_token) throw new GithubError(res.status, `GitHub token exchange failed${j.error ? `: ${j.error}` : ''}`);
    return { token: j.access_token, scopes: (j.scope ?? '').split(/[ ,]+/).filter(Boolean) };
  }

  async user(token: string): Promise<SessionUser> {
    const r = await this.api<{ login: string; name?: string | null; avatar_url: string; id?: number }>(token, '/user');
    if (r.status !== 200) this.fail(r.status, 'user', r.body);
    return { login: r.body.login, ...(r.body.name ? { name: r.body.name } : {}), avatarUrl: r.body.avatar_url, ...(typeof r.body.id === 'number' ? { githubId: r.body.id } : {}) };
  }

  /** Active member of `org` (needs read:org for private memberships). */
  async isOrgMember(token: string, org: string): Promise<boolean> {
    const r = await this.api<{ state?: string }>(token, `/user/memberships/orgs/${encodeURIComponent(org)}`);
    return r.status === 200 && r.body?.state === 'active';
  }

  /** GET with Link-header pagination (`rel="next"`), at most `maxPages` pages. */
  private async paged<T>(token: string, first: string, what: string, maxPages = 10): Promise<{ items: T[]; scopes: string[] | null }> {
    const items: T[] = [];
    let scopes: string[] | null = null;
    let next: string | null = first;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await this.ep.fetch(next.startsWith('http') ? next : `${this.ep.api}${next}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate' },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.status !== 200 || !Array.isArray(body)) this.fail(res.status, what, body);
      const sc = res.headers.get('x-oauth-scopes');
      scopes ??= sc === null ? null : sc.split(',').map((x) => x.trim()).filter(Boolean);
      items.push(...(body as T[]));
      const link = res.headers.get('link') ?? '';
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      next = m ? m[1]! : null;
      // Only follow links on the same API host.
      if (next && !next.startsWith(this.ep.api)) next = null;
    }
    return { items, scopes };
  }

  /** Repos the user can push to (owner, collaborator, org member), most recently pushed first; `q` filters by name. */
  async repos(token: string, q = ''): Promise<{ items: GithubRepo[]; scopes: string[] | null }> {
    const r = await this.paged<RawRepo & { permissions?: { push?: boolean } }>(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', 'repos');
    return { items: filterRepos(r.items.filter((x) => x.permissions?.push !== false).map(toRepo), q), scopes: r.scopes };
  }

  /** The user's organizations with role and whether they may create repos there (needs read:org for private memberships). */
  async orgs(token: string): Promise<GithubOrg[]> {
    const list = await this.paged<{ login: string; avatar_url?: string; description?: string | null }>(token, '/user/orgs?per_page=100', 'orgs');
    const roles = new Map<string, string>();
    try {
      const m = await this.paged<{ organization: { login: string }; role: string; state: string }>(token, '/user/memberships/orgs?state=active&per_page=100', 'memberships');
      for (const x of m.items) roles.set(x.organization.login.toLowerCase(), x.role);
    } catch {
      // memberships need read:org; roles stay unknown
    }
    return Promise.all(
      list.items.map(async (o) => {
        const d = await this.api<{ name?: string | null; members_can_create_repositories?: boolean }>(token, `/orgs/${encodeURIComponent(o.login)}`).catch(() => null);
        const role = roles.get(o.login.toLowerCase()) ?? null;
        return {
          login: o.login,
          name: d?.status === 200 ? (d.body.name ?? null) : null,
          avatarUrl: o.avatar_url ?? null,
          role,
          canCreateRepos: role === 'admin' || (d?.status === 200 && d.body.members_can_create_repositories !== false && role !== null),
        };
      }),
    );
  }

  /**
   * Repos of one org the user can push to. `restricted`: the org has OAuth App access restrictions and has not
   * approved this app (GitHub answers 403 "...OAuth App access restrictions..."), so its repos are hidden.
   */
  async orgRepos(token: string, org: string, q = ''): Promise<{ items: GithubRepo[]; restricted: boolean }> {
    try {
      const r = await this.paged<RawRepo & { permissions?: { push?: boolean } }>(token, `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed`, `org ${org} repos`);
      return { items: filterRepos(r.items.filter((x) => x.permissions?.push !== false).map(toRepo), q), restricted: false };
    } catch (e) {
      if (e instanceof GithubError && e.status === 403 && /OAuth App access restrictions/i.test(e.message)) return { items: [], restricted: true };
      throw e;
    }
  }

  /** `permissions` of a repo for the token's user (covers org / team grants); status 404/403 = no access. */
  async repoPermissions(token: string, fullName: string): Promise<{ status: number; permissions?: { pull?: boolean; triage?: boolean; push?: boolean; maintain?: boolean; admin?: boolean } }> {
    const r = await this.api<{ permissions?: { pull?: boolean; triage?: boolean; push?: boolean; maintain?: boolean; admin?: boolean } }>(token, `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`);
    return { status: r.status, ...(r.status === 200 ? { permissions: r.body?.permissions } : {}) };
  }

  async repo(token: string, fullName: string): Promise<GithubRepo & { canPush: boolean }> {
    const r = await this.api<RawRepo & { permissions?: { push?: boolean } }>(token, `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`);
    if (r.status !== 200) this.fail(r.status, `repo ${fullName}`, r.body);
    return { ...toRepo(r.body), canPush: r.body.permissions?.push !== false };
  }

  /** Create a repo for the user, or in `owner` (an org) when given. */
  async createRepo(token: string, input: { name: string; private: boolean; description?: string; owner?: string }): Promise<GithubRepo> {
    const path = input.owner ? `/orgs/${encodeURIComponent(input.owner)}/repos` : '/user/repos';
    const r = await this.api<RawRepo>(token, path, { method: 'POST', body: JSON.stringify({ name: input.name, private: input.private, description: input.description ?? '', auto_init: false }) });
    if (r.status !== 201) this.fail(r.status, 'create repo', r.body);
    return toRepo(r.body);
  }
}

export interface GithubOrg {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** 'admin' | 'member' | null (unknown without read:org). */
  role: string | null;
  canCreateRepos: boolean;
}

function filterRepos(items: GithubRepo[], q: string): GithubRepo[] {
  const needle = q.trim().toLowerCase();
  return needle ? items.filter((r) => r.fullName.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle)) : items;
}

/* ------------------------------------------------------------------ routes */

export interface AuthRouteOptions {
  auth: AuthOptions;
  source: AuthConfigSource;
  github?: GithubClient;
  log?: { warn(m: string): void; info(m: string): void };
  /** GitHub sign-in routes exist only in server mode (default: always). */
  githubEnabled?: boolean;
  /** After a successful sign-in (e.g. forget cached repo permissions). */
  onSignIn?: (login: string) => void;
  /** Extra fields for /auth/status (setup state, mode, ...); they override the defaults. */
  statusExtra?: (req: FastifyRequest, user: SessionUser | null) => Record<string, unknown>;
}

const b64 = (b: Buffer) => b.toString('base64url');
const safeReturnTo = (v: unknown) => (typeof v === 'string' && /^\/(?![/\\])[^\s]*$/.test(v) && v.length < 1000 ? v : '/');

/**
 * Origin of the UI that started the sign-in, from its Host (the Vite proxy keeps it). Only same-host-as-callback,
 * loopback or `server.uiOrigins` origins are kept (no open redirect); '' = relative redirects.
 */
export function uiOriginOf(req: FastifyRequest, callbackUrl: string, extra: string[]): string {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!/^[a-z0-9.[\]:-]+$/.test(host)) return '';
  let cb: URL;
  try {
    cb = new URL(callbackUrl);
  } catch {
    return '';
  }
  const origin = `${cb.protocol}//${host}`;
  if (origin === cb.origin) return '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(name) && ['localhost', '127.0.0.1', '[::1]'].includes(cb.hostname);
  return loopback || name === cb.hostname || extra.includes(origin) ? origin : '';
}

/** Scopes for a sign-in: what the allow-list needs plus an optional upgrade. */
export function signInScopes(s: GithubSettings, upgrade?: string): string[] {
  const up = upgrade && (UPGRADE_SCOPES as readonly string[]).includes(upgrade) ? upgrade : null;
  // Repo access for New project always comes with read:org (list orgs, roles, org repos).
  return [...(s.allowedOrgs.length || up ? ['read:org'] : []), ...(up ? [up] : [])];
}

export function registerAuthRoutes(app: FastifyInstance, o: AuthRouteOptions): void {
  const gh = o.github ?? new GithubClient();
  const { store } = o.auth;
  const secure = (url: string) => (url.startsWith('https://') ? '; Secure' : '');

  app.get('/auth/status', async (req, reply) => {
    const st = o.source.current();
    const user = sessionForMode(await store.session(cookieOf(req, SESSION_COOKIE)), o.auth.mode);
    reply.header('Cache-Control', 'no-store');
    return {
      authenticated: !!user,
      user,
      configured: st.configured,
      missing: st.missing,
      callbackUrl: st.callbackUrl,
      loginUrl: '/auth/github/login',
      ...(user && user.kind !== 'local' ? { scopes: await store.scopes(user.login) } : {}),
      ...(o.statusExtra?.(req, user) ?? {}),
    };
  });

  if (o.githubEnabled === false) {
    registerLogout(app, o);
    return;
  }

  app.get('/auth/github/login', async (req, reply) => {
    const st = o.source.current();
    const q = req.query as { returnTo?: string; scope?: string };
    if (!st.github) return reply.redirect(`/login?error=not_configured`);
    const state = b64(randomBytes(24));
    const verifier = b64(randomBytes(48));
    const challenge = b64(createHash('sha256').update(verifier).digest());
    const scopes = signInScopes(st.github, q.scope);
    // The UI's origin (dev: Vite :5173 proxying /auth) so the callback, which may land on another origin (the API
    // :4000 registered in the OAuth App), sends the user back to the UI. Cookies are per host, not per port.
    const uiOrigin = uiOriginOf(req, st.callbackUrl, o.auth.uiOrigins ?? []);
    const cookie = store.sign({ state, verifier, returnTo: safeReturnTo(q.returnTo), uiOrigin, exp: Date.now() + OAUTH_TTL_MS });
    reply.header('Set-Cookie', `${OAUTH_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600${secure(st.callbackUrl)}`);
    const url = new URL(`${gh.webBase}/login/oauth/authorize`);
    url.searchParams.set('client_id', st.github.clientId);
    url.searchParams.set('redirect_uri', st.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'false');
    return reply.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const st = o.source.current();
    const saved = store.unsign<{ state: string; verifier: string; returnTo: string; uiOrigin?: string; exp: number }>(cookieOf(req, OAUTH_COOKIE));
    const ui = saved?.uiOrigin ?? '';
    const fail = (code: string) => {
      reply.header('Set-Cookie', `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=0`);
      return reply.redirect(`${ui}/login?error=${code}`);
    };
    if (!st.github) return fail('not_configured');
    const q = req.query as { code?: string; state?: string; error?: string };
    const stateOk = !!saved && typeof q.state === 'string' && saved.exp > Date.now() && saved.state.length === q.state.length && timingSafeEqual(Buffer.from(saved.state), Buffer.from(q.state));
    if (!stateOk) return fail('state_mismatch');
    if (q.error || typeof q.code !== 'string' || !q.code) return fail('github_error');
    try {
      const { token, scopes } = await gh.exchangeCode(st.github, q.code, saved.verifier);
      const user = await gh.user(token);
      const listed = st.github.allowedUsers.length > 0 || st.github.allowedOrgs.length > 0;
      const allowed =
        (!listed && !o.source.allowListRequired) ||
        st.github.allowedUsers.some((u) => u.toLowerCase() === user.login.toLowerCase()) ||
        (await (async () => {
          for (const org of st.github!.allowedOrgs) if (await gh.isOrgMember(token, org)) return true;
          return false;
        })());
      if (!allowed) {
        o.log?.warn(`sign-in refused for GitHub user ${user.login} (not in allowedUsers / allowedOrgs)`);
        return fail('not_allowed');
      }
      await store.saveToken(user.login, token, scopes);
      // User directory (avatars, names, noreply co-author addresses).
      userDirectory()?.record({ login: user.login, name: user.name ?? null, avatarUrl: user.avatarUrl, ...(user.githubId ? { id: user.githubId } : {}) });
      o.onSignIn?.(user.login);
      const sessionTtlMs = st.sessionTtlHours * 3600_000;
      const cookie = await store.createSession(user, sessionTtlMs);
      o.log?.info(`GitHub sign-in: ${user.login}`);
      reply.header('Set-Cookie', [
        `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=0`,
        `${SESSION_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure(st.callbackUrl)}`,
      ]);
      return reply.redirect(`${ui}${saved.returnTo}`);
    } catch (e) {
      o.log?.warn(`GitHub sign-in failed: ${(e as Error).message}`);
      return fail('github_error');
    }
  });

  registerLogout(app, o);
}

function registerLogout(app: FastifyInstance, o: AuthRouteOptions) {
  app.post('/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!originOk(req, o.auth.uiOrigins)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Origin must be same-origin' } });
    await o.auth.store.deleteSession(cookieOf(req, SESSION_COOKIE));
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return reply.code(204).send();
  });
}
