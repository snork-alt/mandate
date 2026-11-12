/**
 * Commit authorship: a write triggered by a signed-in GitHub user (its message carries a `Mandate-User: <login>`
 * trailer, set by the server from the authenticated principal) is authored by that user,
 * `<name or login> <<id>+<login>@users.noreply.github.com>`, and committed by Mandate (`git.author`). Background and
 * system commits (sync merges, migrations, service accounts) have no user trailer and stay authored by Mandate.
 */
import { SERVICE_USER_PREFIX, userOfTrailers } from '@mandate/shared';
import { userDirectory } from '../auth/users.js';

export interface Identity {
  name: string;
  email: string;
}

const TRAILER_RE = /^([A-Za-z][\w-]*):[ \t]*(.+)$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Trailers of a commit message (its last paragraph when every line is `Key: value`). */
function trailersOf(message: string): Record<string, string> {
  const paras = message.replace(/\r\n?/g, '\n').trim().split('\n').slice(1).join('\n').trim().split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? '';
  const out: Record<string, string> = {};
  const lines = last.split('\n');
  if (!last || !lines.every((l) => TRAILER_RE.test(l))) return out;
  for (const l of lines) {
    const m = TRAILER_RE.exec(l)!;
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** git rejects `<`, `>` and newlines in identities. */
const clean = (s: string) => s.replace(/[<>\r\n\0]/g, '').trim();

/** The GitHub user's commit identity (directory name and numeric id when known), or null for none / service accounts. */
export function userIdentity(login: string): Identity | null {
  if (!login || login.startsWith(SERVICE_USER_PREFIX) || !LOGIN_RE.test(login)) return null;
  const dir = userDirectory();
  const u = dir?.resolve(login);
  const name = clean(u?.name || u?.login || login) || login;
  const email = dir?.noreply(login) ?? `${login}@users.noreply.github.com`;
  return { name, email };
}

/** Author of a commit: explicit option, else the triggering GitHub user (trailer), else null (= the committer). */
export function commitAuthor(message: string, explicit?: Identity): Identity | null {
  if (explicit) return explicit;
  const login = userOfTrailers(trailersOf(message));
  return login ? userIdentity(login) : null;
}
