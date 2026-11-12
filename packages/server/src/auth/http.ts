/**
 * Request authentication (always on). Every principal is a GitHub user (or a named service account):
 * - Agents: MCP OAuth access tokens or personal tokens (per user, per project); project keys (keys.json) only as
 *   named service accounts for CI, attributed `service:<name>`. Older installs' shared project keys are refused.
 * - Web UI: the GitHub sign-in session cookie (`mandate_session`, HttpOnly, SameSite=Lax). It authorizes read tools
 *   (and `git_pull`) on every project, never document writes. Cookie-authenticated non-GET requests must carry an
 *   `Origin` equal to the request's own origin (or listed in `server.uiOrigins`): CSRF protection.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyStore } from './keys.js';
import type { AuthStore, SessionUser } from './sessions.js';
import { AGENT_TOKEN_PREFIX, type AgentTokens } from './agent-tokens.js';
import { verifyAccessToken, type OAuthStore } from './mcp-oauth.js';

export const SESSION_COOKIE = 'mandate_session';

/** Who is calling: an agent key (bound to one project) or a signed-in UI user (read-only, any project). */
export type Principal =
  /** `service`: a named service-account key (CI), attributed as `service:<keyName>`. */
  | { kind: 'key'; keyId: string; keyName: string; project: string; service?: boolean }
  | { kind: 'ui'; user: SessionUser }
  /** An agent acting AS a GitHub user (MCP OAuth access token or personal agent token), bound to one project. */
  | { kind: 'user'; login: string; project: string; via: 'oauth' | 'pat'; tokenId: string; tokenName: string };

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Hostname of a Host header (`[::1]:4000` → `[::1]`). */
export function hostName(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
}

export interface AuthOptions {
  keys: KeyStore;
  store: AuthStore;
  /** Extra browser origins for the UI cookie besides same-origin. */
  uiOrigins?: string[];
  /** Shared per-project keys (`mnd_…`) accepted (unit tests; default true). The server accepts service accounts only. */
  sharedKeys?: boolean;
  /** Personal agent tokens (`mndp_…`). */
  agentTokens?: AgentTokens;
  /** MCP OAuth access tokens (`mat_…`). */
  oauth?: OAuthStore;
  /** Who may administer (create projects, Settings); default: every signed-in user. */
  isAdmin?: (login: string) => boolean;
}

/**
 * Agent auth policy: agents authenticate per GitHub user (MCP OAuth or personal tokens); project keys are refused except
 * named service accounts. `repoAuth` (project access from GitHub repo permissions, admins from allowedUsers) is on
 * except for older OAuth App installs (`legacyAuth`), which keep the sign-in allow-list as before.
 */
export function agentAuthPolicy(c: { legacyAuth: boolean }): { perUserAgents: boolean; sharedKeys: boolean; repoAuth: boolean } {
  return { perUserAgents: true, sharedKeys: false, repoAuth: !c.legacyAuth };
}

export function cookieOf(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The request's Origin is its own origin (same Host) or explicitly allowed. */
export function originOk(req: FastifyRequest, extra: string[] = []): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() || extra.includes(u.origin);
}

/** The signed-in UI user of a request (null when there is no valid session cookie). */
export async function sessionUser(req: FastifyRequest, opts: Pick<AuthOptions, 'store'>): Promise<SessionUser | null> {
  return sessionFor(await opts.store.session(cookieOf(req, SESSION_COOKIE)));
}

/** Only GitHub sessions are valid (one-time-link sessions of older installs are refused: sign in with GitHub). */
export function sessionFor(user: SessionUser | null): SessionUser | null {
  return user && (user.kind ?? 'github') === 'github' ? user : null;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: number; message: string };

/**
 * Authenticate one request for `project` (null = the unscoped endpoint, any project's key accepted).
 * The bearer key wins when present (an invalid one is never downgraded to the cookie).
 */
export async function authenticate(req: FastifyRequest, project: string | null, opts: AuthOptions): Promise<AuthResult> {
  const authz = req.headers.authorization;
  if (typeof authz === 'string' && authz.length) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
    if (!m) return { ok: false, status: 401, message: 'unauthorized: expected Authorization: Bearer <key>' };
    const presented = m[1]!;
    if (presented.startsWith('mat_') && opts.oauth) {
      const t = await verifyAccessToken(opts.oauth, opts, presented, project);
      if (!t) return { ok: false, status: 401, message: 'unauthorized: invalid or expired access token (sign in again from your agent)' };
      return { ok: true, principal: { kind: 'user', login: t.login, project: t.project, via: 'oauth', tokenId: t.clientId, tokenName: (await opts.oauth.client(t.clientId))?.client_name ?? 'oauth' } };
    }
    if (presented.startsWith(AGENT_TOKEN_PREFIX) && opts.agentTokens) {
      const t = await opts.agentTokens.verify(presented);
      if (!t || (project !== null && t.project !== project) || !(await opts.store.token(t.login))) return { ok: false, status: 401, message: `unauthorized: invalid token${project ? ` for project '${project}'` : ''}` };
      return { ok: true, principal: { kind: 'user', login: t.login, project: t.project, via: 'pat', tokenId: t.id, tokenName: t.name } };
    }
    const perUser = 'unauthorized: Mandate uses per-user access so every write is attributed: use MCP sign-in or a personal token (Connect dialog); CI: a service account key (mandate key create <project> --service <name>)';
    const problem = opts.keys.status();
    if (problem) return { ok: false, status: 401, message: opts.sharedKeys === false ? perUser : `unauthorized: agent keys are disabled (${problem})` };
    const k = opts.keys.verify(project, presented);
    // Team: project keys are refused; only named service accounts are accepted (attributed service:<name>).
    if (opts.sharedKeys === false && !k?.service) return { ok: false, status: 401, message: perUser };
    if (!k) return { ok: false, status: 401, message: `unauthorized: invalid key${project ? ` for project '${project}'` : ''}` };
    return { ok: true, principal: { kind: 'key', keyId: k.id, keyName: k.name, project: k.project, ...(k.service ? { service: true } : {}) } };
  }
  const cookie = cookieOf(req, SESSION_COOKIE);
  if (cookie !== undefined) {
    // CSRF: state-changing methods need a matching Origin; GET (SSE stream) checks it when the browser sends one.
    const needsOrigin = req.method !== 'GET' && req.method !== 'HEAD';
    if ((needsOrigin || req.headers.origin !== undefined) && !originOk(req, opts.uiOrigins)) {
      return { ok: false, status: 403, message: 'forbidden: cookie-authenticated requests need a same-origin Origin header' };
    }
    const user = sessionFor(await opts.store.session(cookie));
    if (!user) return { ok: false, status: 401, message: 'unauthorized: sign in again (session expired or logged out)' };
    return { ok: true, principal: { kind: 'ui', user } };
  }
  return { ok: false, status: 401, message: 'unauthorized: send Authorization: Bearer <key> (keys live in ~/.mandate/keys.json; npm run mandate -- key create <project>)' };
}

export function rpcError(reply: FastifyReply, status: number, code: number, message: string, wwwAuthenticate?: string) {
  if (status === 401) reply.header('WWW-Authenticate', wwwAuthenticate ?? 'Bearer realm="mandate"');
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}
