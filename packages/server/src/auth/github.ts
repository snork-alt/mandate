/**
 * GitHub sign-in for the web UI (OAuth web flow with `state` + PKCE S256) and the small GitHub REST client the
 * project setup uses. Sign-in works with a GitHub App (default for new setups, created with the one-click manifest
 * flow: user tokens expire and refresh, repos are visible where the app is installed) or an existing OAuth App
 * (`auth.github.clientId` + `clientSecretEnv` without `app`). The `auth` block of config.json and the client secret (env / secrets.env) are re-read on
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
import { cookieOf, originOk, sessionFor, SESSION_COOKIE, type AuthOptions } from './http.js';
import type { SessionUser } from './sessions.js';

export const DEFAULT_CALLBACK_URL = 'http://localhost:5173/auth/github/callback';
const OAUTH_COOKIE = 'mandate_oauth';
/** Single-use first-admin claim, set by the setup wizard's last step (see SetupAdminClaim). */
export const ADMIN_CLAIM_COOKIE = 'mandate_admin_claim';
const OAUTH_TTL_MS = 10 * 60_000;
export const UPGRADE_SCOPES = ['repo', 'public_repo'] as const;

export interface GithubAppInfo {
  id: number;
  slug: string;
  owner?: string;
  ownerType?: 'User' | 'Organization';
}

export interface GithubSettings {
  clientId: string;
  clientSecret: string;
  allowedUsers: string[];
  allowedOrgs: string[];
  callbackUrl: string;
  /** Set for a GitHub App (else an OAuth App). */
  app?: GithubAppInfo;
}

/** Where a user installs the GitHub App on more accounts / repositories. */
export const appInstallUrl = (web: string, slug: string) => `${web}/apps/${encodeURIComponent(slug)}/installations/new`;

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
  private liveCallbackUrl: string | null = null;

  constructor(
    private readonly configPath: string | null,
    initial: AuthConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log?: { warn(m: string): void },
    /** `<publicUrl>/auth/github/callback`; the dev default otherwise. */
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
      const json = readRawConfig(this.configPath);
      const raw = json.auth ?? {};
      // A new server address (saved by the setup wizard / Settings) moves the default callback without a restart.
      const pub = (json.server as { publicUrl?: unknown } | undefined)?.publicUrl;
      this.liveCallbackUrl = typeof pub === 'string' && /^https?:\/\//.test(pub) ? `${pub.replace(/\/+$/, '')}/auth/github/callback` : null;
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
    const callbackUrl = g?.callbackUrl ?? this.liveCallbackUrl ?? this.defaultCallbackUrl;
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
      github: configured
        ? { clientId: g!.clientId!, clientSecret: secret!, allowedUsers: g!.allowedUsers, allowedOrgs: g!.allowedOrgs, callbackUrl, ...(g!.app ? { app: { id: g!.app.id, slug: g!.app.slug, ...(g!.app.owner ? { owner: g!.app.owner } : {}), ...(g!.app.ownerType ? { ownerType: g!.app.ownerType } : {}) } } : {}) }
        : null,
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

  /**
   * Exchange the OAuth code (+ PKCE verifier). The secret travels only in this POST body. GitHub App user tokens come
   * with `expires_in` (8 h) and a rotating `refresh_token` (6 months).
   */
  async exchangeCode(s: GithubSettings, code: string, verifier: string): Promise<{ token: string; scopes: string[]; refreshToken?: string; expiresIn?: number; refreshExpiresIn?: number }> {
    const res = await this.ep.fetch(`${this.ep.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mandate' },
      body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: s.callbackUrl, code_verifier: verifier }),
    });
    const j = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !j.access_token) throw new GithubError(res.status, `GitHub token exchange failed${j.error ? `: ${j.error}` : ''}`);
    return { token: j.access_token, scopes: (j.scope ?? '').split(/[ ,]+/).filter(Boolean), ...refreshFields(j) };
  }

  /** Refresh a GitHub App user token (the refresh token rotates: the old pair stops working). */
  async refreshUserToken(s: Pick<GithubSettings, 'clientId' | 'clientSecret'>, refreshToken: string): Promise<{ token: string; refreshToken?: string; expiresIn?: number; refreshExpiresIn?: number }> {
    const res = await this.ep.fetch(`${this.ep.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mandate' },
      body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const j = (await res.json().catch(() => ({}))) as TokenResponse;
    // GitHub answers 200 with `error: bad_refresh_token` for a rejected refresh token.
    if (!res.ok || !j.access_token) throw new GithubError(j.error ? 400 : res.status, `GitHub token refresh failed${j.error ? `: ${j.error}` : ''}`);
    return { token: j.access_token, ...refreshFields(j) };
  }

  /**
   * One-click GitHub App creation: exchange the manifest code (1 hour, single use) for the app's credentials.
   * Unauthenticated by design (the code is the credential). The result holds secrets: never log it.
   */
  async convertManifest(code: string): Promise<ManifestConversion> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GithubError(400, 'GitHub manifest code: invalid');
    const res = await this.ep.fetch(`${this.ep.api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate' },
    });
    const j = (await res.json().catch(() => ({}))) as Partial<{ id: number; slug: string; name: string; client_id: string; client_secret: string; webhook_secret: string | null; pem: string; html_url: string; owner: { login: string; type: string } | null; message: string }>;
    if (res.status !== 201 || !j.id || !j.client_id || !j.client_secret || !j.pem || !j.slug) throw new GithubError(res.status, `GitHub app creation could not be completed: ${typeof j.message === 'string' ? j.message.slice(0, 200) : `HTTP ${res.status}`}`);
    return {
      id: j.id,
      slug: j.slug,
      name: j.name ?? j.slug,
      clientId: j.client_id,
      clientSecret: j.client_secret,
      webhookSecret: j.webhook_secret ?? null,
      pem: j.pem,
      htmlUrl: j.html_url ?? null,
      owner: j.owner?.login ?? null,
      ownerType: j.owner?.type === 'Organization' ? 'Organization' : 'User',
    };
  }

  /** GitHub App: the installations the user can access (user-to-server token). */
  async installations(token: string): Promise<GithubInstallation[]> {
    const out: GithubInstallation[] = [];
    let next: string | null = '/user/installations?per_page=100';
    for (let page = 0; next && page < 10; page++) {
      const res: Response = await this.ep.fetch(next.startsWith('http') ? next : `${this.ep.api}${next}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate' } });
      const body = (await res.json().catch(() => null)) as { installations?: { id: number; account: { login: string; type?: string; avatar_url?: string } | null; repository_selection?: string }[] } | null;
      if (res.status !== 200 || !body?.installations) this.fail(res.status, 'installations', body);
      for (const i of body.installations) if (i.account) out.push({ id: i.id, account: i.account.login, accountType: i.account.type === 'Organization' ? 'Organization' : 'User', avatarUrl: i.account.avatar_url ?? null, selection: i.repository_selection === 'all' ? 'all' : 'selected' });
      const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
      next = m && m[1]!.startsWith(this.ep.api) ? m[1]! : null;
    }
    return out;
  }

  /** GitHub App: repositories of one installation the user can access (paginated, most recently pushed first). */
  async installationRepos(token: string, installationId: number, q = ''): Promise<GithubRepo[]> {
    const items: GithubRepo[] = [];
    let next: string | null = `/user/installations/${installationId}/repositories?per_page=100`;
    for (let page = 0; next && page < 10; page++) {
      const res: Response = await this.ep.fetch(next.startsWith('http') ? next : `${this.ep.api}${next}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate' } });
      const body = (await res.json().catch(() => null)) as { repositories?: (RawRepo & { permissions?: { push?: boolean } })[] } | null;
      if (res.status !== 200 || !body?.repositories) this.fail(res.status, `installation ${installationId} repos`, body);
      items.push(...body.repositories.filter((x) => x.permissions?.push !== false).map(toRepo));
      const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
      next = m && m[1]!.startsWith(this.ep.api) ? m[1]! : null;
    }
    return filterRepos(items, q).sort((x, y) => (y.pushedAt ?? '').localeCompare(x.pushedAt ?? ''));
  }

  async user(token: string): Promise<SessionUser> {
    const r = await this.api<{ login: string; name?: string | null; avatar_url: string; id?: number }>(token, '/user');
    if (r.status !== 200) this.fail(r.status, 'user', r.body);
    return { login: r.body.login, ...(r.body.name ? { name: r.body.name } : {}), avatarUrl: r.body.avatar_url, ...(typeof r.body.id === 'number' ? { githubId: r.body.id } : {}) };
  }

  /** A GitHub account by login (Settings → Admins lookup); null when there is no such user. */
  async userByLogin(token: string, login: string): Promise<{ login: string; name: string | null; avatarUrl: string | null; type: string } | null> {
    const r = await this.api<{ login: string; name?: string | null; avatar_url?: string; type?: string }>(token, `/users/${encodeURIComponent(login)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail(r.status, `user ${login}`, r.body);
    return { login: r.body.login, name: r.body.name ?? null, avatarUrl: r.body.avatar_url ?? null, type: r.body.type ?? 'User' };
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
    if (r.status === 403 && /not accessible by integration/i.test(String((r.body as { message?: unknown } | null)?.message ?? '')))
      throw new GithubError(403, 'GitHub create repo: the Mandate GitHub App lacks the "Administration: Read and write" repository permission. Add it in the app settings on GitHub (Permissions & events), accept the new permission on the installation, or create the repository on GitHub and pick "Existing repository".');
    if (r.status !== 201) this.fail(r.status, 'create repo', r.body);
    return toRepo(r.body);
  }
}

type TokenResponse = { access_token?: string; scope?: string; error?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
const refreshFields = (j: TokenResponse) => ({
  ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
  ...(typeof j.expires_in === 'number' && j.expires_in > 0 ? { expiresIn: j.expires_in } : {}),
  ...(typeof j.refresh_token_expires_in === 'number' && j.refresh_token_expires_in > 0 ? { refreshExpiresIn: j.refresh_token_expires_in } : {}),
});

/** Credentials of a GitHub App created from a manifest (secrets: client secret, webhook secret, private key). */
export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  pem: string;
  htmlUrl: string | null;
  owner: string | null;
  ownerType: 'User' | 'Organization';
}

export interface GithubInstallation {
  id: number;
  account: string;
  accountType: 'User' | 'Organization';
  avatarUrl: string | null;
  /** The app sees every repo of the account, or a selection. */
  selection: 'all' | 'selected';
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
  /** GitHub sign-in routes exist only in a team (default: always). */
  githubEnabled?: boolean;
  /** After a successful sign-in (e.g. forget cached repo permissions). */
  onSignIn?: (login: string) => void;
  /**
   * First-run setup: the person who finishes the setup wizard becomes the first admin on their GitHub sign-in (identity
   * from GitHub, never typed). Returns true when this sign-in consumed the single-use setup claim.
   */
  claimAdmin?: (req: FastifyRequest, login: string) => Promise<boolean>;
  /** Extra fields for /auth/status (setup state, users, ...); they override the defaults. */
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
    const user = sessionFor(await store.session(cookieOf(req, SESSION_COOKIE)));
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
    // GitHub Apps ignore scopes (permissions come from the app and its installations).
    const scopes = st.github.app ? [] : signInScopes(st.github, q.scope);
    // The UI's origin (dev: Vite :5173 proxying /auth) so the callback, which may land on another origin (the API
    // :4000 registered in the OAuth App), sends the user back to the UI. Cookies are per host, not per port.
    const uiOrigin = uiOriginOf(req, st.callbackUrl, o.auth.uiOrigins ?? []);
    const cookie = store.sign({ state, verifier, returnTo: safeReturnTo(q.returnTo), uiOrigin, exp: Date.now() + OAUTH_TTL_MS });
    reply.header('Set-Cookie', `${OAUTH_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600${secure(st.callbackUrl)}`);
    const url = new URL(`${gh.webBase}/login/oauth/authorize`);
    url.searchParams.set('client_id', st.github.clientId);
    url.searchParams.set('redirect_uri', st.callbackUrl);
    url.searchParams.set('state', state);
    if (!st.github.app) url.searchParams.set('scope', scopes.join(' '));
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
      const { token, scopes, refreshToken, expiresIn, refreshExpiresIn } = await gh.exchangeCode(st.github, q.code, saved.verifier);
      const user = await gh.user(token);
      const listed = st.github.allowedUsers.length > 0 || st.github.allowedOrgs.length > 0;
      const claimed = (await o.claimAdmin?.(req, user.login)) ?? false;
      if (claimed) o.log?.info(`setup: ${user.login} is the first admin (signed in from the setup wizard)`);
      const allowed =
        claimed ||
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
      const now = Date.now();
      await store.saveToken(user.login, token, scopes, {
        ...(st.github.app ? { app: true } : {}),
        ...(expiresIn ? { expiresAt: now + expiresIn * 1000 } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(refreshExpiresIn ? { refreshExpiresAt: now + refreshExpiresIn * 1000 } : {}),
      });
      // User directory (avatars, names, noreply co-author addresses).
      userDirectory()?.record({ login: user.login, name: user.name ?? null, avatarUrl: user.avatarUrl, ...(user.githubId ? { id: user.githubId } : {}) });
      o.onSignIn?.(user.login);
      const sessionTtlMs = st.sessionTtlHours * 3600_000;
      const cookie = await store.createSession(user, sessionTtlMs);
      o.log?.info(`GitHub sign-in: ${user.login}`);
      reply.header('Set-Cookie', [
        `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=0`,
        ...(claimed ? [`${ADMIN_CLAIM_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=0`] : []),
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
