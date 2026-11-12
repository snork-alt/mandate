/**
 * The New-project flow (the one write the web UI makes: registering a project backed by a GitHub repo; documents
 * stay read-only). Cookie session; every request carries `X-Mandate-UI: 1`.
 */
import { redirectToLogin } from '../auth';
import type { ProjectSummary } from './projects';

export interface GithubRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  empty: boolean;
  description: string | null;
  ownerAvatarUrl?: string | null;
  ownerType?: string;
}

/** Where repositories can live: the signed-in user first, then their organizations. */
export interface GithubOwner {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  type: 'user' | 'org';
  role?: 'admin' | 'member' | null;
  canCreateRepos: boolean;
  /** The org restricts OAuth Apps and has not approved Mandate. */
  restricted: boolean;
}

export interface RepoList {
  scopes: string[];
  needsScope: 'repo' | null;
  upgradeUrl: string;
  upgradeUrlPublic: string;
  /** Re-run OAuth (repo + read:org); GitHub's consent screen offers org Grant / Request. */
  reauthUrl?: string;
  /** GitHub's page for this OAuth App's authorization (org access grants). */
  grantUrl?: string;
  owner?: string;
  owners?: GithubOwner[];
  items: GithubRepo[];
}

/** Steps streamed by POST /ui/projects (Accept: application/x-ndjson). */
export const CREATE_STEPS = ['clone', 'init', 'push', 'key'] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];
export type CreateEvent = { step: CreateStep; status: 'start' | 'done' };

/** Parse NDJSON chunks: returns complete lines' objects and the unfinished tail. */
export function splitNdjson(buffer: string): { items: unknown[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const items: unknown[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t));
    } catch {
      /* ignore a malformed line */
    }
  }
  return { items, rest };
}

export interface NewProjectInput {
  id: string;
  name: string;
  description?: string;
  repo: string;
  branch?: string;
  path?: string;
}

export const PROJECT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PROJECT_ID_MAX = 40;

/** "My Cool Project!" -> "my-cool-project" (max 40, no leading/trailing dashes). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, PROJECT_ID_MAX)
    .replace(/^-+|-+$/g, '');
}

/** Why `id` is not a valid project id (null when valid). */
export function projectIdError(id: string): string | null {
  if (!id) return 'Required';
  if (id.length > PROJECT_ID_MAX) return `At most ${PROJECT_ID_MAX} characters`;
  if (!PROJECT_ID_RE.test(id)) return 'Lowercase letters, digits and single dashes (e.g. billing-api)';
  return null;
}

/** Subfolder inside the repo: relative, no `..`, no leading/trailing slashes (null = invalid). */
export function normalizeSubpath(p: string): string | null {
  const t = p.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!t) return '';
  if (t.split('/').some((s) => !s || s === '.' || s === '..')) return null;
  return t;
}

/** A failed request: the server's `{ error: { code, message, path?, hint? } }`. */
export class UiApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly hint?: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'UiApiError';
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    signal,
    headers: { 'X-Mandate-UI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new UiApiError('unauthorized', 'not signed in', undefined, 'sign in with GitHub', 401);
  }
  const json = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string; path?: string; hint?: string } } & T) | null;
  if (!res.ok) {
    const e = json?.error;
    throw new UiApiError(e?.code ?? 'http_error', e?.message ?? `request failed (HTTP ${res.status})`, e?.path, e?.hint, res.status);
  }
  return json as T;
}

const reposQuery = (q: string, owner: string) => {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (owner && owner !== 'all') p.set('owner', owner);
  const s = p.toString();
  return `/ui/github/repos${s ? `?${s}` : ''}`;
};

/** POST /ui/projects with live progress (NDJSON stream); falls back to the plain JSON response. */
async function createProjectStreaming(b: NewProjectInput, onEvent: (e: CreateEvent) => void): Promise<{ project: ProjectSummary }> {
  const res = await fetch('/ui/projects', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Mandate-UI': '1', 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(b),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new UiApiError('unauthorized', 'not signed in', undefined, 'sign in with GitHub', 401);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('ndjson') || !res.body) {
    const json = (await res.json().catch(() => null)) as { project?: ProjectSummary; error?: { code?: string; message?: string; path?: string; hint?: string } } | null;
    if (res.ok && json?.project) return { project: json.project };
    const e = json?.error;
    throw new UiApiError(e?.code ?? 'http_error', e?.message ?? `request failed (HTTP ${res.status})`, e?.path, e?.hint, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const { items, rest } = splitNdjson(done ? `${buffer}\n` : buffer);
    buffer = rest;
    for (const it of items as Array<Partial<CreateEvent> & { project?: ProjectSummary; error?: { code?: string; message?: string; path?: string; hint?: string } }>) {
      if (it.error) throw new UiApiError(it.error.code ?? 'error', it.error.message ?? 'project creation failed', it.error.path, it.error.hint, res.status);
      if (it.project) return { project: it.project };
      if (it.step && it.status) onEvent({ step: it.step, status: it.status });
    }
    if (done) break;
  }
  throw new UiApiError('stream_ended', 'the server ended the stream without a result', undefined, 'check the project list; retry if it is missing');
}

export const githubApi = {
  repos: (q: string, owner = 'all', signal?: AbortSignal) => request<RepoList>('GET', reposQuery(q, owner), undefined, signal),
  createRepo: (b: { name: string; private: boolean; description?: string; owner?: string }) => request<{ repo: GithubRepo }>('POST', '/ui/github/repos', b),
  createProject: (b: NewProjectInput) => request<{ project: ProjectSummary }>('POST', '/ui/projects', b),
  createProjectStreaming,
};

export { reposQuery };

/** `owner/name[/path]` of a project's GitHub storage. */
export const repoLabel = (g: { repo: string; path: string | null }) => (g.path ? `${g.repo}/${g.path}` : g.repo);
