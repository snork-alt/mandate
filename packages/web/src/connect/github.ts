/**
 * The New-project flow (the one write the web UI makes: registering a project backed by a GitHub repo; documents
 * stay read-only). Cookie session; every request carries `X-Mandate-UI: 1`.
 */
import { uiRequest, uiStream, UiApiError, splitNdjson } from '../lib/ui';

export { UiApiError, splitNdjson };
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
  /** GitHub App mode: only repositories where the app is installed are listed; `installUrl` adds more. */
  app?: { slug: string | null; installUrl: string | null };
}

/** Steps streamed by POST /ui/projects (Accept: application/x-ndjson). */
export const CREATE_STEPS = ['clone', 'init', 'push', 'key'] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];
export type CreateEvent = { step: CreateStep; status: 'start' | 'done' };

export interface NewProjectInput {
  name: string;
  description?: string;
  repo: string;
  branch?: string;
  /** Folder inside the repo (older projects; the dialog no longer offers it). */
  path?: string;
}

/** A registered code repository: stable short name (code refs use it), optional remote URL; auto = registered by an agent. */
export interface CodeRepoEntry {
  name: string;
  github?: string;
  remote?: string;
  defaultBranch?: string;
  auto?: boolean;
  registeredBy?: string;
  registeredAt?: string;
}

/** Settings → Code repositories, per project. */
export interface CodeReposProject {
  id: string;
  name: string;
  specsRepo: string | null;
  codeRepos: CodeRepoEntry[];
  /** Repo names used in the project's data that are not registered yet. */
  unlinked: { name: string; uses: number }[];
}
export interface CodeReposState {
  admin: boolean;
  projects: CodeReposProject[];
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

const request = <T,>(method: 'GET' | 'POST', url: string, body?: unknown, signal?: AbortSignal) => uiRequest<T>(method, url, body, { signal });

const reposQuery = (q: string, owner: string) => {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (owner && owner !== 'all') p.set('owner', owner);
  const s = p.toString();
  return `/ui/github/repos${s ? `?${s}` : ''}`;
};

/** POST /ui/projects with live progress (NDJSON stream); falls back to the plain JSON response. */
const createProjectStreaming = (b: NewProjectInput, onEvent: (e: CreateEvent) => void) => uiStream<{ project: ProjectSummary }, CreateEvent>('/ui/projects', b, 'project', onEvent);

export const githubApi = {
  repos: (q: string, owner = 'all', signal?: AbortSignal) => request<RepoList>('GET', reposQuery(q, owner), undefined, signal),
  createRepo: (b: { name: string; private: boolean; description?: string; owner?: string }) => request<{ repo: GithubRepo }>('POST', '/ui/github/repos', b),
  createProject: (b: NewProjectInput) => request<{ project: ProjectSummary }>('POST', '/ui/projects', b),
  createProjectStreaming,
};

export { reposQuery };

export const codeReposApi = {
  list: (project?: string) => uiRequest<CodeReposState>('GET', `/ui/code-repos${project ? `?project=${encodeURIComponent(project)}` : ''}`, undefined, { noLoginRedirect: true }),
  save: (project: string, codeRepos: CodeRepoEntry[]) => uiRequest<CodeReposProject>('PUT', `/ui/code-repos/${encodeURIComponent(project)}`, { codeRepos }),
};

/** `owner/name[/path]` of a project's GitHub storage. */
export const repoLabel = (g: { repo: string; path: string | null }) => (g.path ? `${g.repo}/${g.path}` : g.repo);
