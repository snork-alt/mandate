/**
 * Web UI auth (always on): the UI signs in with GitHub OAuth (server-set HttpOnly cookie) and stays read-only; coding
 * agents use per-project bearer keys. Until GitHub sign-in is configured, the UI shows the setup page.
 */
import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';

export interface AuthUser {
  login: string;
  name?: string;
  avatarUrl: string;
}

export interface AuthStatus {
  authenticated: boolean;
  user: AuthUser | null;
  /** GitHub sign-in is fully configured (client id, secret, allow list). */
  configured: boolean;
  /** What is missing when not configured (exact config fields / env vars). */
  missing: string[];
  /** The OAuth callback URL to register on GitHub (null when not derivable). */
  callbackUrl: string | null;
  loginUrl: string;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/auth/status', { credentials: 'same-origin', headers: { 'X-Mandate-UI': '1' } });
  if (!res.ok) throw new Error(`auth status unavailable (HTTP ${res.status})`);
  return (await res.json()) as AuthStatus;
}

export const useAuthStatus = () => useQuery({ queryKey: ['auth', 'status'], queryFn: fetchAuthStatus, staleTime: 60_000 });

/** Only same-origin relative paths are accepted as `returnTo` (no open redirects). */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/login') || raw.startsWith('/auth/')) return '/';
  return raw;
}

/** The GitHub login start URL (a top-level navigation, never fetched). */
export const githubLoginUrl = (returnTo: string, base = '/auth/github/login') => `${base}?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;

/** `/login?returnTo=<current page>`. */
export const loginPath = (returnTo = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search + window.location.hash) =>
  `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;

export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Mandate-UI': '1' } });
}

/** Messages for `/login?error=`. */
export const LOGIN_ERRORS: Record<string, string> = {
  state_mismatch: 'The login request expired or was started in another tab. Please try again.',
  not_allowed: 'Your GitHub account is not allowed on this Mandate server. Ask an admin to add your login or organization to auth.github.allowedUsers / allowedOrgs.',
  github_error: 'GitHub returned an error during sign-in. Please try again.',
  not_configured: 'GitHub sign-in is not configured on this server yet.',
};

export const loginErrorMessage = (code: string | null) => (code ? (LOGIN_ERRORS[code] ?? `Sign-in failed (${code}).`) : null);

/** Example `auth` block for the configure page. */
export const DEFAULT_CALLBACK_URL = 'http://localhost:5173/auth/github/callback';
export const AUTH_CONFIG_EXAMPLE = {
  github: {
    clientId: 'Ov23li...',
    clientSecretEnv: 'MANDATE_GITHUB_CLIENT_SECRET',
    allowedUsers: ['your-login'],
    allowedOrgs: [] as string[],
    callbackUrl: 'http://localhost:5173/auth/github/callback',
  },
  sessionTtlHours: 168,
};

/** Called on any MCP / UI 401: the session expired or was revoked -> sign in again (returning here). */
export function redirectToLogin(): void {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  window.location.assign(loginPath());
}

/** The auth status the app was gated on (signed-in user for the sidebar). */
export const AuthContext = createContext<AuthStatus | null>(null);
export const useAuth = () => useContext(AuthContext);
