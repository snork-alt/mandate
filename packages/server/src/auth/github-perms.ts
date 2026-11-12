/**
 * Team: per-project access from GitHub repo permissions, using the signed-in user's own token.
 * `GET /repos/{owner}/{repo}` → `permissions { pull, triage, push, maintain, admin }` (covers org and team grants):
 * push / maintain / admin → write, pull / triage → read, otherwise (or 404 / 403) → none (the project is hidden: 404).
 * Cached per (user, project) for 5 minutes; a 401 marks the user's token revoked → none.
 * Local-folder projects of older installs (no GitHub repo): admins write, other signed-in users read (no allow-list
 * check possible per repo); without an admin check (older OAuth App installs) every signed-in user writes, as before.
 */
import type { ProjectConfig } from '../config.js';
import { GithubClient } from './github.js';
import type { AuthStore } from './sessions.js';

export type Access = 'none' | 'read' | 'write';

export function accessOf(p: { pull?: boolean; triage?: boolean; push?: boolean; maintain?: boolean; admin?: boolean } | undefined): Access {
  if (!p) return 'none';
  if (p.push || p.maintain || p.admin) return 'write';
  if (p.pull || p.triage) return 'read';
  return 'none';
}

export class RepoPermissions {
  private readonly cache = new Map<string, { access: Access; at: number }>();
  /** Mandate admins (allowedUsers); set at startup. */
  isAdmin?: (login: string) => boolean;

  constructor(
    private readonly store: AuthStore,
    private readonly github: GithubClient,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's access to a project (cached). */
  async access(login: string, project: ProjectConfig | undefined): Promise<Access> {
    if (!project) return 'none';
    if (!project.github) return !this.isAdmin || this.isAdmin(login) ? 'write' : 'read'; // older local-folder project
    // Revoked / missing token: no access, checked before the cache (not cached: a new sign-in applies at once).
    const tok = await this.store.token(login);
    if (!tok) return 'none';
    const key = `${login.toLowerCase()}\n${project.id}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.access;
    const r = await this.github.repoPermissions(tok.token, project.github.repo).catch(() => ({ status: 0, permissions: undefined }));
    if (r.status === 401) await this.store.markRevoked(login);
    const access: Access = r.status === 200 ? accessOf(r.permissions) : 'none';
    // Network errors (status 0) are not cached, so they retry on the next call.
    if (r.status !== 0) this.cache.set(key, { access, at: this.now() });
    return access;
  }

  /** Forget cached grants (a user signed in again, or a 401/403 from GitHub). */
  forget(login?: string): void {
    if (!login) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${login.toLowerCase()}\n`)) this.cache.delete(k);
  }
}
