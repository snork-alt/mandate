/**
 * GitHub App installation access tokens for git over HTTPS (`git.auth.method: 'app'`).
 *
 * A short-lived JWT signed with the App's private key (RS256, 9 min) finds the installation that covers the repo
 * (`GET /repos/{owner}/{repo}/installation`) and mints a token for that repo only
 * (`POST /app/installations/{id}/access_tokens`). Tokens live in memory, are reused until 5 minutes before they expire
 * and are minted again on demand. They are never written to disk, config, URLs, argv or logs: the git stores hand them
 * to git through an in-memory credential (embedded) or a credential helper fed by the child's env (system git), and
 * scrub them from error text.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AppTokenSource {
  /** App id, slug (install URL) and private key path, read on every mint (the setup wizard may change them live). */
  app: () => { id: number; slug: string; privateKeyPath?: string } | null;
  /** REST base (https://api.github.com) and web base (https://github.com). */
  api?: string;
  web?: string;
  fetch?: typeof fetch;
  now?: () => number;
  readKey?: (path: string) => string;
}

export class AppNotInstalledError extends Error {
  constructor(
    readonly repo: string,
    readonly installUrl: string,
  ) {
    super(`The Mandate GitHub App is not installed on ${repo} (or cannot access it): install it at ${installUrl} and grant it this repository (Contents: read and write)`);
    this.name = 'AppNotInstalledError';
  }
}

interface Cached {
  token: string;
  expiresAt: number;
}

/** Refresh this long before GitHub's expiry (tokens last 1 h). */
const REFRESH_MARGIN_MS = 5 * 60_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT for the App (iat 60 s in the past against clock drift, 9 min lifetime; GitHub allows 10). */
export function appJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Parse `owner/repo` out of a GitHub remote URL (https, ssh:// or scp-like); null for other hosts / shapes. */
export function githubRepoOf(url: string, host = 'github.com'): { owner: string; repo: string } | null {
  const h = host.replace(/[.]/g, '\\.');
  const m = new RegExp(`^(?:https?://(?:[^@/]+@)?${h}/|ssh://(?:[^@/]+@)?${h}(?::\\d+)?/|[\\w.-]+@${h}:)([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\\.git)?/?$`, 'i').exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export class AppInstallationTokens {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<Cached>>();
  private readonly installations = new Map<string, number>();
  private readonly api: string;
  private readonly web: string;
  private readonly http: typeof fetch;
  private readonly now: () => number;
  private readonly readKey: (path: string) => string;

  constructor(private readonly src: AppTokenSource) {
    this.api = (src.api ?? 'https://api.github.com').replace(/\/+$/, '');
    this.web = (src.web ?? 'https://github.com').replace(/\/+$/, '');
    this.http = src.fetch ?? ((...a) => fetch(...a));
    this.now = src.now ?? Date.now;
    this.readKey = src.readKey ?? ((p) => readFileSync(p, 'utf8'));
  }

  /** True when an App with a private key is configured. */
  available(): boolean {
    return !!this.src.app()?.privateKeyPath;
  }

  /** A valid installation token for `owner/repo` (cached; minted when missing or about to expire). */
  async token(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > this.now()) return hit.token;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.mint(owner, repo).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const c = await p;
    this.cache.set(key, c);
    return c.token;
  }

  /** Drop a cached token (e.g. the remote rejected it). */
  invalidate(owner: string, repo: string): void {
    const key = `${owner}/${repo}`.toLowerCase();
    this.cache.delete(key);
    this.installations.delete(key);
  }

  private async call(jwt: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await this.http(`${this.api}${path}`, {
        ...init,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mandate', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (e) {
      throw new Error(`GitHub App token: cannot reach ${this.api} (${(e as Error).message})`);
    }
    const text = await res.text().catch(() => '');
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private async mint(owner: string, repo: string): Promise<Cached> {
    const app = this.src.app();
    if (!app) throw new Error('git.auth.method is "app" but no GitHub App is configured (auth.github.app): finish the setup wizard or use method "ssh"');
    if (!app.privateKeyPath) throw new Error(`GitHub App '${app.slug}' has no private key (auth.github.app.privateKeyPath): recreate it in the setup wizard or use git.auth.method "ssh"`);
    let pem: string;
    try {
      pem = this.readKey(app.privateKeyPath);
    } catch (e) {
      throw new Error(`GitHub App private key ${app.privateKeyPath} is not readable (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    let jwt: string;
    try {
      jwt = appJwt(app.id, pem, this.now());
    } catch {
      throw new Error(`GitHub App private key ${app.privateKeyPath} is not a valid PEM RSA key`);
    }
    const installUrl = `${this.web}/apps/${encodeURIComponent(app.slug)}/installations/new`;
    const key = `${owner}/${repo}`.toLowerCase();
    let id = this.installations.get(key);
    if (!id) {
      const r = await this.call(jwt, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
      if (r.status === 404) throw new AppNotInstalledError(`${owner}/${repo}`, installUrl);
      if (r.status === 401) throw new Error(`GitHub rejected the App's credentials (HTTP 401): check auth.github.app.id and the private key`);
      if (r.status !== 200 || typeof r.body?.id !== 'number') throw new Error(`GitHub App installation lookup for ${owner}/${repo} failed (HTTP ${r.status})`);
      id = r.body.id;
      this.installations.set(key, id);
    }
    const r = await this.call(jwt, `/app/installations/${id}/access_tokens`, { method: 'POST', body: JSON.stringify({ repositories: [repo] }) });
    if (r.status === 404 || r.status === 422) {
      this.installations.delete(key);
      throw new AppNotInstalledError(`${owner}/${repo}`, installUrl);
    }
    const token = r.body?.token;
    if (r.status !== 201 || typeof token !== 'string' || !token) throw new Error(`GitHub App token for ${owner}/${repo} could not be created (HTTP ${r.status})`);
    const exp = Date.parse(String(r.body?.expires_at ?? ''));
    return { token, expiresAt: Number.isFinite(exp) ? exp : this.now() + 60 * 60_000 };
  }
}
