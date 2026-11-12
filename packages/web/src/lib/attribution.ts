import { SERVICE_USER_PREFIX, type Attribution } from '@mandate/shared';
import { isLocalMode, useAuth, type AuthStatus } from '../auth';

/**
 * User attribution is a server-mode feature: in local mode the UI shows only "via <agent>" and hides every "by user"
 * filter. Without a known auth status (tests, standalone pages) users are hidden too.
 */
export const showsUsers = (s: AuthStatus | null | undefined) => !!s && !isLocalMode(s);
export const useShowUsers = () => showsUsers(useAuth());

export const isServiceUser = (user: string) => user.startsWith(SERVICE_USER_PREFIX);
export const serviceName = (user: string) => user.slice(SERVICE_USER_PREFIX.length);

/** GitHub avatar of a login (null for service accounts and non-GitHub names). */
export function avatarUrl(user: string, size = 40): string | null {
  if (isServiceUser(user) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) return null;
  return `https://github.com/${encodeURIComponent(user)}.png?size=${size}`;
}

/** "user via agent" (server mode) or "via agent" (local mode, or no user recorded). */
export function attributionText(a: Pick<Attribution, 'user' | 'agent'> | null | undefined, withUsers: boolean): string {
  if (!a) return '';
  const user = withUsers && a.user ? (isServiceUser(a.user) ? `service ${serviceName(a.user)}` : a.user) : '';
  const agent = a.agent && a.agent !== user ? `via ${a.agent}` : '';
  return [user, agent].filter(Boolean).join(' ');
}

/** The users present in a list (server mode filters); empty in local mode. */
export function usersOf(items: { user?: string }[], withUsers: boolean): string[] {
  if (!withUsers) return [];
  return Array.from(new Set(items.map((i) => i.user).filter((u): u is string => !!u))).sort();
}

/** Keep the items of the selected users (no selection, or local mode: everything). */
export function filterByUsers<T extends { user?: string }>(items: T[], users: string[] | undefined, withUsers: boolean): T[] {
  if (!withUsers || !users?.length) return items;
  return items.filter((i) => !!i.user && users.includes(i.user));
}
