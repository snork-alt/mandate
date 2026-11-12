/**
 * Server mode: Mandate as the OAuth 2.1 authorization server for its MCP endpoints (MCP authorization spec
 * 2025-11-25): RFC 9728 protected-resource metadata per project, RFC 8414 authorization-server metadata, RFC 7591
 * dynamic client registration (public clients), authorization code + PKCE (S256 only), RFC 8707 resource indicators
 * (tokens are audience-bound to one project's MCP URL), short-lived access tokens + rotating refresh tokens.
 * The user signs in upstream with GitHub (existing sign-in) and approves the client on a consent page.
 * Tokens act AS the GitHub user: repo permissions decide read / write on every call; a revoked GitHub token stops them.
 * Only SHA-256 hashes of codes and tokens are stored, in the server-state database (`oauth_clients`, `oauth_tokens`,
 * `oauth_codes`), so several server instances on one Postgres share them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProjectRegistry } from '../projects/registry.js';
import type { RepoPermissions } from './github-perms.js';
import { cookieOf, originOk, sessionForMode, SESSION_COOKIE, type AuthOptions } from './http.js';
import { stateForHome, type ServerState } from '../db/state.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64 = (n: number) => randomBytes(n).toString('base64url');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Client {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  client_id_issued_at: number;
}
interface TokenRec {
  hash: string;
  kind: 'access' | 'refresh';
  clientId: string;
  login: string;
  project: string;
  exp: number;
  /** The refresh token's family (rotation; reuse of a rotated token revokes the family). */
  family: string;
}
interface CodeRec {
  clientId: string;
  redirectUri: string;
  challenge: string;
  login: string;
  project: string;
  exp: number;
}

/** Redirect URIs: https, http on loopback, or a private-use scheme with a dot (RFC 8252). No fragments. */
export function redirectUriOk(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(url.protocol);
}

interface TokenRow {
  hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  login: string;
  project: string;
  exp: number;
  family: string;
}
const tokenRec = (r: TokenRow): TokenRec => ({ hash: r.hash, kind: r.kind, clientId: r.client_id, login: r.login, project: r.project, exp: Number(r.exp), family: r.family });

export class OAuthStore {
  private readonly state: Promise<ServerState>;

  constructor(home: string, state?: ServerState | Promise<ServerState>) {
    this.state = state ? Promise.resolve(state) : stateForHome(home);
  }

  async register(redirectUris: string[], name?: string): Promise<Client> {
    const st = await this.state;
    const c: Client = { client_id: `mcp_${b64(16)}`, redirect_uris: redirectUris, client_id_issued_at: Math.floor(Date.now() / 1000), ...(name ? { client_name: name } : {}) };
    const t = st.t('oauth_clients');
    await st.db.tx(async (q) => {
      await q.run(`INSERT INTO ${t} (client_id, client_name, redirect_uris, issued_at) VALUES (?, ?, ?, ?)`, [c.client_id, name ?? null, JSON.stringify(redirectUris), c.client_id_issued_at]);
      // Keep the newest 500 registrations.
      await q.run(`DELETE FROM ${t} WHERE client_id NOT IN (SELECT client_id FROM ${t} ORDER BY issued_at DESC, client_id DESC LIMIT 500)`);
    });
    return c;
  }

  async client(id: string): Promise<Client | undefined> {
    const st = await this.state;
    const r = await st.db.get<{ client_id: string; client_name: string | null; redirect_uris: string; issued_at: number }>(`SELECT * FROM ${st.t('oauth_clients')} WHERE client_id = ?`, [id]);
    if (!r) return undefined;
    let uris: string[] = [];
    try {
      uris = JSON.parse(r.redirect_uris) as string[];
    } catch {
      uris = [];
    }
    return { client_id: r.client_id, redirect_uris: uris, client_id_issued_at: Number(r.issued_at), ...(r.client_name ? { client_name: r.client_name } : {}) };
  }

  async newCode(rec: CodeRec): Promise<string> {
    const st = await this.state;
    const code = b64(32);
    await st.db.run(`DELETE FROM ${st.t('oauth_codes')} WHERE exp < ?`, [Date.now()]);
    await st.db.run(`INSERT INTO ${st.t('oauth_codes')} (hash, client_id, redirect_uri, challenge, login, project, exp) VALUES (?, ?, ?, ?, ?, ?, ?)`, [sha(code), rec.clientId, rec.redirectUri, rec.challenge, rec.login, rec.project, rec.exp]);
    return code;
  }

  /** One-time (an atomic DELETE … RETURNING: two instances can never both redeem a code). */
  async takeCode(code: string): Promise<CodeRec | null> {
    const st = await this.state;
    const r = await st.db.get<{ client_id: string; redirect_uri: string; challenge: string; login: string; project: string; exp: number }>(`DELETE FROM ${st.t('oauth_codes')} WHERE hash = ? RETURNING client_id, redirect_uri, challenge, login, project, exp`, [sha(code)]);
    return r && Number(r.exp) > Date.now() ? { clientId: r.client_id, redirectUri: r.redirect_uri, challenge: r.challenge, login: r.login, project: r.project, exp: Number(r.exp) } : null;
  }

  async issue(clientId: string, login: string, project: string, family = b64(12)): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const st = await this.state;
    const now = Math.floor(Date.now() / 1000);
    const access = `mat_${b64(32)}`;
    const refresh = `mrt_${b64(32)}`;
    const sql = `INSERT INTO ${st.t('oauth_tokens')} (hash, kind, client_id, login, login_lc, project, exp, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await st.db.tx(async (q) => {
      await q.run(sql, [sha(access), 'access', clientId, login, login.toLowerCase(), project, now + ACCESS_TTL_S, family]);
      await q.run(sql, [sha(refresh), 'refresh', clientId, login, login.toLowerCase(), project, now + REFRESH_TTL_S, family]);
    });
    return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_S };
  }

  /** Rotate a refresh token (atomic delete); reuse of a rotated (deleted) token is not found → invalid_grant. */
  async refresh(token: string, clientId: string): Promise<TokenRec | null> {
    const st = await this.state;
    const r = await st.db.get<TokenRow>(`DELETE FROM ${st.t('oauth_tokens')} WHERE hash = ? AND kind = 'refresh' AND client_id = ? AND exp > ? RETURNING hash, kind, client_id, login, project, exp, family`, [sha(token), clientId, Math.floor(Date.now() / 1000)]);
    return r ? tokenRec(r) : null;
  }

  async access(token: string): Promise<TokenRec | null> {
    const st = await this.state;
    const r = await st.db.get<TokenRow>(`SELECT hash, kind, client_id, login, project, exp, family FROM ${st.t('oauth_tokens')} WHERE hash = ? AND kind = 'access' AND exp > ?`, [sha(token), Math.floor(Date.now() / 1000)]);
    return r && eq(r.hash, sha(token)) ? tokenRec(r) : null;
  }

  async revoke(token: string): Promise<void> {
    const st = await this.state;
    const t = st.t('oauth_tokens');
    await st.db.run(`DELETE FROM ${t} WHERE family IN (SELECT family FROM ${t} WHERE hash = ?)`, [sha(token)]);
  }

  async revokeUser(login: string): Promise<void> {
    const st = await this.state;
    await st.db.run(`DELETE FROM ${st.t('oauth_tokens')} WHERE login_lc = ?`, [login.toLowerCase()]);
  }
}

export interface McpOAuthDeps {
  publicUrl: string;
  auth: AuthOptions;
  projects: ProjectRegistry;
  perms: RepoPermissions;
  oauth: OAuthStore;
  log?: { info(m: string): void; warn(m: string): void };
}

export const resourceOf = (publicUrl: string, project: string) => `${publicUrl}/p/${project}/mcp`;
export const resourceMetadataUrl = (publicUrl: string, project: string) => `${publicUrl}/.well-known/oauth-protected-resource/p/${project}/mcp`;

/** The project a resource indicator names (exact match on this server's public URL). */
function projectOfResource(publicUrl: string, resource: string | undefined): string | null {
  if (!resource) return null;
  const m = new RegExp(`^${publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/p/([a-z0-9-]+)/mcp/?$`).exec(resource);
  return m ? m[1]! : null;
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title>
<style>:root{--bg:#fafafa;--card:#fff;--fg:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#8b7cf6}@media(prefers-color-scheme:dark){:root{--bg:#141416;--card:#1c1c1f;--fg:#f4f4f5;--muted:#a1a1aa;--border:#2e2e33}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 Geist,ui-sans-serif,system-ui,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:440px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 6px}p{color:var(--muted);margin:6px 0}code{font-size:13px}.row{display:flex;gap:8px;margin-top:20px}
button{flex:1;height:38px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

export function registerMcpOAuth(app: FastifyInstance, d: McpOAuthDeps): void {
  const issuer = d.publicUrl;
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }

  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
  app.get('/.well-known/oauth-authorization-server', async () => asMetadata);
  app.get('/.well-known/oauth-protected-resource/p/:projectId/mcp', async (req, reply) => {
    const id = (req.params as { projectId: string }).projectId;
    if (!d.projects.config(id)) return reply.code(404).send({ error: 'not_found' });
    return { resource: resourceOf(issuer, id), authorization_servers: [issuer], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: `Mandate · ${d.projects.config(id)!.name}` };
  });

  // RFC 7591 dynamic client registration (public clients: no secret; PKCE is mandatory).
  const regSchema = z
    .object({
      redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
      client_name: z.string().max(200).optional(),
      token_endpoint_auth_method: z.string().optional(),
      grant_types: z.array(z.string()).optional(),
      response_types: z.array(z.string()).optional(),
      scope: z.string().optional(),
    })
    .passthrough();
  app.post('/oauth/register', async (req, reply) => {
    const r = regSchema.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: 'invalid_client_metadata', error_description: r.error.issues[0]?.message });
    const bad = r.data.redirect_uris.find((u) => !redirectUriOk(u));
    if (bad) return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect URIs must be https, http on localhost, or a private-use scheme' });
    const c = await d.oauth.register(r.data.redirect_uris, r.data.client_name);
    d.log?.info(`oauth client registered: ${c.client_name ?? c.client_id}`);
    return reply.code(201).send({ ...c, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  });

  const authorizeSchema = z.object({
    response_type: z.literal('code'),
    client_id: z.string().min(1).max(100),
    redirect_uri: z.string().min(1).max(2000),
    code_challenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    code_challenge_method: z.literal('S256'),
    state: z.string().max(1000).optional(),
    scope: z.string().max(200).optional(),
    resource: z.string().max(500),
  });

  const authErr = (reply: FastifyReply, redirectUri: string, error: string, state?: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (state) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuer);
    return reply.redirect(u.toString());
  };

  /** Validate an authorization request; errors before the redirect URI is trusted are shown, not redirected. */
  const check = async (q: unknown, reply: FastifyReply) => {
    const raw = (q ?? {}) as Record<string, string>;
    const client = raw.client_id ? await d.oauth.client(raw.client_id) : undefined;
    if (!client) return (reply.code(400).type('text/html').send(page('Unknown client', '<h1>Unknown client</h1><p>Register the client first (dynamic client registration).</p>')), null);
    if (!raw.redirect_uri || !client.redirect_uris.includes(raw.redirect_uri)) return (reply.code(400).type('text/html').send(page('Bad redirect', '<h1>Redirect URI not registered</h1>')), null);
    const r = authorizeSchema.safeParse(raw);
    if (!r.success) return (authErr(reply, raw.redirect_uri, r.error.issues.some((i) => i.path[0] === 'code_challenge' || i.path[0] === 'code_challenge_method') ? 'invalid_request' : r.error.issues.some((i) => i.path[0] === 'resource') ? 'invalid_target' : 'invalid_request', raw.state), null);
    const project = projectOfResource(issuer, r.data.resource);
    if (!project || !d.projects.config(project)) return (authErr(reply, r.data.redirect_uri, 'invalid_target', r.data.state), null);
    return { q: r.data, client, project };
  };

  app.get('/oauth/authorize', async (req, reply) => {
    const c = await check(req.query, reply);
    if (!c) return reply;
    const user = sessionForMode(await d.auth.store.session(cookieOf(req, SESSION_COOKIE)), d.auth.mode);
    if (!user) {
      const back = `/oauth/authorize?${new URLSearchParams(req.query as Record<string, string>).toString()}`;
      return reply.redirect(`/auth/github/login?returnTo=${encodeURIComponent(back)}`);
    }
    const access = await d.perms.access(user.login, d.projects.config(c.project));
    // No access: indistinguishable from an unknown project.
    if (access === 'none') return authErr(reply, c.q.redirect_uri, 'invalid_target', c.q.state);
    const tx = d.auth.store.sign({ q: c.q, login: user.login, exp: Date.now() + 10 * 60_000 });
    const proj = d.projects.config(c.project)!;
    const host = (() => {
      try {
        return new URL(c.q.redirect_uri).host || c.q.redirect_uri;
      } catch {
        return c.q.redirect_uri;
      }
    })();
    reply.header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    return reply.type('text/html').send(
      page(
        'Connect a coding agent',
        `<h1>Connect ${html(c.client.client_name ?? 'a coding agent')}?</h1>
<p>It will act as <b>${html(user.login)}</b> on the Mandate project <b>${html(proj.name)}</b>, with your GitHub permissions on <code>${html(proj.github?.repo ?? proj.id)}</code> (${access === 'write' ? 'read and write' : 'read only'}).</p>
<p>After approving you return to <code>${html(host)}</code>.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="tx" value="${html(tx)}"><div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div></form>`,
      ),
    );
  });

  app.post('/oauth/authorize', async (req, reply) => {
    if (!originOk(req, d.auth.uiOrigins)) return reply.code(403).type('text/html').send(page('Forbidden', '<h1>Forbidden</h1><p>Cross-site request.</p>'));
    const body = (req.body ?? {}) as { tx?: string; decision?: string };
    const tx = d.auth.store.unsign<{ q: z.infer<typeof authorizeSchema>; login: string; exp: number }>(body.tx);
    const user = sessionForMode(await d.auth.store.session(cookieOf(req, SESSION_COOKIE)), d.auth.mode);
    if (!tx || tx.exp < Date.now() || !user || user.login !== tx.login) return reply.code(400).type('text/html').send(page('Expired', '<h1>This request expired</h1><p>Start the connection again from your agent.</p>'));
    const client = await d.oauth.client(tx.q.client_id);
    if (!client || !client.redirect_uris.includes(tx.q.redirect_uri)) return reply.code(400).send({ error: 'invalid_client' });
    if (body.decision !== 'allow') return authErr(reply, tx.q.redirect_uri, 'access_denied', tx.q.state);
    const project = projectOfResource(issuer, tx.q.resource)!;
    const code = await d.oauth.newCode({ clientId: client.client_id, redirectUri: tx.q.redirect_uri, challenge: tx.q.code_challenge, login: user.login, project, exp: Date.now() + CODE_TTL_MS });
    const u = new URL(tx.q.redirect_uri);
    u.searchParams.set('code', code);
    if (tx.q.state) u.searchParams.set('state', tx.q.state);
    u.searchParams.set('iss', issuer);
    d.log?.info(`oauth: ${user.login} connected ${client.client_name ?? client.client_id} to ${project}`);
    return reply.redirect(u.toString());
  });

  const tokenErr = (reply: FastifyReply, error: string, description: string, status = 400) => reply.code(status).header('Cache-Control', 'no-store').send({ error, error_description: description });

  app.post('/oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = b.client_id ? await d.oauth.client(b.client_id) : undefined;
    if (!client) return tokenErr(reply, 'invalid_client', 'unknown client_id', 401);
    if (b.grant_type === 'authorization_code') {
      const rec = b.code ? await d.oauth.takeCode(b.code) : null;
      if (!rec || rec.clientId !== client.client_id || rec.redirectUri !== b.redirect_uri) return tokenErr(reply, 'invalid_grant', 'invalid or expired code');
      const challenge = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
      if (!b.code_verifier || !eq(challenge, rec.challenge)) return tokenErr(reply, 'invalid_grant', 'PKCE verification failed');
      if (b.resource && projectOfResource(issuer, b.resource) !== rec.project) return tokenErr(reply, 'invalid_target', 'resource does not match the authorization');
      if (!(await d.auth.store.token(rec.login))) return tokenErr(reply, 'invalid_grant', 'GitHub authorization was revoked; sign in again');
      const t = await d.oauth.issue(client.client_id, rec.login, rec.project);
      return reply.header('Cache-Control', 'no-store').send({ ...t, token_type: 'Bearer', scope: 'mcp' });
    }
    if (b.grant_type === 'refresh_token') {
      const old = b.refresh_token ? await d.oauth.refresh(b.refresh_token, client.client_id) : null;
      if (!old) return tokenErr(reply, 'invalid_grant', 'invalid refresh token');
      if (b.resource && projectOfResource(issuer, b.resource) !== old.project) return tokenErr(reply, 'invalid_target', 'resource does not match');
      if (!(await d.auth.store.token(old.login))) return tokenErr(reply, 'invalid_grant', 'GitHub authorization was revoked; sign in again');
      const t = await d.oauth.issue(client.client_id, old.login, old.project, old.family);
      return reply.header('Cache-Control', 'no-store').send({ ...t, token_type: 'Bearer', scope: 'mcp' });
    }
    return tokenErr(reply, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.token) await d.oauth.revoke(b.token);
    return reply.code(200).send({});
  });
}

/** Validate an OAuth access token for `project` (audience-bound; GitHub authorization still valid). */
export async function verifyAccessToken(oauth: OAuthStore, auth: AuthOptions, token: string, project: string | null): Promise<{ login: string; project: string; clientId: string } | null> {
  if (!token.startsWith('mat_')) return null;
  const t = await oauth.access(token);
  if (!t || t.exp <= Date.now() / 1000) return null;
  if (project !== null && t.project !== project) return null;
  if (!(await auth.store.token(t.login))) return null;
  return { login: t.login, project: t.project, clientId: t.clientId };
}

export type { FastifyRequest };
