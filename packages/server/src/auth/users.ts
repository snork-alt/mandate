/**
 * User directory: GitHub login -> name, avatar URL and numeric id, recorded at sign-in (`users.json` in the Mandate
 * home, 0600). Other committers (never signed in here) fall back to GitHub's public avatar URL, so the browser never
 * calls the GitHub API. The id gives the GitHub noreply address for `Co-authored-by:` trailers
 * (`<id>+<login>@users.noreply.github.com`); private emails are never stored.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SERVICE_USER_PREFIX, type DirectoryUser } from '@mandate/shared';

interface Entry {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  id?: number;
  seenAt: string;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class UserDirectory {
  private cache: Map<string, Entry> | null = null;
  constructor(readonly file: string) {}

  private load(): Map<string, Entry> {
    if (this.cache) return this.cache;
    const map = new Map<string, Entry>();
    try {
      const json = JSON.parse(readFileSync(this.file, 'utf8')) as { users?: Entry[] };
      for (const u of json.users ?? []) if (typeof u?.login === 'string') map.set(u.login.toLowerCase(), u);
    } catch {
      /* missing or unreadable: empty directory */
    }
    return (this.cache = map);
  }

  /** Record (or refresh) a signed-in user. */
  record(u: { login: string; name?: string | null; avatarUrl?: string | null; id?: number }): void {
    const map = this.load();
    map.set(u.login.toLowerCase(), { login: u.login, name: u.name ?? null, avatarUrl: u.avatarUrl ?? null, ...(typeof u.id === 'number' ? { id: u.id } : {}), seenAt: new Date().toISOString() });
    try {
      const dir = path.dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ users: [...map.values()] }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      /* best effort: the directory is a cache */
    }
  }

  resolve(login: string): DirectoryUser {
    if (login.startsWith(SERVICE_USER_PREFIX)) return { login, name: login.slice(SERVICE_USER_PREFIX.length), avatarUrl: null, known: false, service: true };
    const e = this.load().get(login.toLowerCase());
    if (e) return { login: e.login, name: e.name ?? null, avatarUrl: e.avatarUrl ?? githubAvatar(e.login), known: true, service: false };
    return { login, name: null, avatarUrl: LOGIN_RE.test(login) ? githubAvatar(login) : null, known: false, service: false };
  }

  /** GitHub noreply address for co-author trailers (null for service accounts / invalid logins). */
  noreply(login: string): string | null {
    if (login.startsWith(SERVICE_USER_PREFIX) || !LOGIN_RE.test(login)) return null;
    const e = this.load().get(login.toLowerCase());
    return e?.id ? `${e.id}+${e.login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  }
}

export const githubAvatar = (login: string) => `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=80`;

let directory: UserDirectory | null = null;
/** The process-wide directory (set at startup; tests may set their own). */
export function setUserDirectory(d: UserDirectory | null): void {
  directory = d;
}
export function userDirectory(): UserDirectory | null {
  return directory;
}
