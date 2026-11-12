/**
 * Request authentication (always on).
 * - Agents: `Authorization: Bearer <key>` (keys.json); a key is valid only on its own project's endpoint and
 *   authorizes read + write tools there.
 * - Web UI: the GitHub sign-in session cookie (`mandate_session`, HttpOnly, SameSite=Lax). It authorizes read tools
 *   (and `git_pull`) on every project, never document writes. Cookie-authenticated non-GET requests must carry an
 *   `Origin` equal to the request's own origin (or listed in `server.uiOrigins`): CSRF protection.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyStore } from './keys.js';
import type { AuthStore, SessionUser } from './sessions.js';

export const SESSION_COOKIE = 'mandate_session';

/** Who is calling: an agent key (bound to one project) or a signed-in UI user (read-only, any project). */
export type Principal = { kind: 'key'; keyId: string; keyName: string; project: string } | { kind: 'ui'; user: SessionUser };

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
export function sessionUser(req: FastifyRequest, opts: AuthOptions): SessionUser | null {
  return opts.store.session(cookieOf(req, SESSION_COOKIE));
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: number; message: string };

/**
 * Authenticate one request for `project` (null = the unscoped endpoint, any project's key accepted).
 * The bearer key wins when present (an invalid one is never downgraded to the cookie).
 */
export function authenticate(req: FastifyRequest, project: string | null, opts: AuthOptions): AuthResult {
  const authz = req.headers.authorization;
  if (typeof authz === 'string' && authz.length) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
    if (!m) return { ok: false, status: 401, message: 'unauthorized: expected Authorization: Bearer <key>' };
    const problem = opts.keys.status();
    if (problem) return { ok: false, status: 401, message: `unauthorized: agent keys are disabled (${problem})` };
    const k = opts.keys.verify(project, m[1]!);
    if (!k) return { ok: false, status: 401, message: `unauthorized: invalid key${project ? ` for project '${project}'` : ''}` };
    return { ok: true, principal: { kind: 'key', keyId: k.id, keyName: k.name, project: k.project } };
  }
  const cookie = cookieOf(req, SESSION_COOKIE);
  if (cookie !== undefined) {
    // CSRF: state-changing methods need a matching Origin; GET (SSE stream) checks it when the browser sends one.
    const needsOrigin = req.method !== 'GET' && req.method !== 'HEAD';
    if ((needsOrigin || req.headers.origin !== undefined) && !originOk(req, opts.uiOrigins)) {
      return { ok: false, status: 403, message: 'forbidden: cookie-authenticated requests need a same-origin Origin header' };
    }
    const user = opts.store.session(cookie);
    if (!user) return { ok: false, status: 401, message: 'unauthorized: sign in again (session expired or logged out)' };
    return { ok: true, principal: { kind: 'ui', user } };
  }
  return { ok: false, status: 401, message: 'unauthorized: send Authorization: Bearer <key> (keys live in ~/.mandate/keys.json; npm run mandate -- key create <project>)' };
}

export function rpcError(reply: FastifyReply, status: number, code: number, message: string) {
  if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="mandate"');
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}
