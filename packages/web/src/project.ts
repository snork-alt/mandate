/**
 * Projects in the URL: every project page lives under `/p/<projectId>/...` (the project router's basename), the home
 * `/` is the project picker, and pre-projects links (`/specs/x`, `/work-orders/y`, ...) redirect into a project.
 */

/** Router basename of a project. */
export const projectBase = (id: string) => `/p/${encodeURIComponent(id)}`;

/** `/p/<id>/rest` -> { id, rest } (rest starts with `/`, `/` when empty); null for other paths. */
export function parseProjectPath(pathname: string): { id: string; rest: string } | null {
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  try {
    return { id: decodeURIComponent(m[1]!), rest: m[2] || '/' };
  } catch {
    return null;
  }
}

/** Where a legacy (pre-projects) URL goes: the same page inside `projectId`, search and hash kept. */
export function legacyTarget(projectId: string, pathname: string, search = '', hash = ''): string {
  const rest = pathname === '/' || pathname === '' ? '/' : pathname;
  return `${projectBase(projectId)}${rest === '/' ? '' : rest}${search}${hash}`;
}

let currentProject: string | null = null;
/** The project whose pages are rendered (set by the project app before its routes render). */
export const setCurrentProject = (id: string | null) => {
  currentProject = id;
  if (id) rememberProject(id);
};
export const getCurrentProject = () => currentProject;

/** An app path (`/specs/x`) inside the current project (`/p/<id>/specs/x`); `/p/...` and external URLs unchanged. */
export function withBase(path: string): string {
  if (!currentProject || !path.startsWith('/') || path.startsWith('//') || parseProjectPath(path)) return path;
  return `${projectBase(currentProject)}${path}`;
}

/** Absolute link to an app path of the current project (copy link). */
export const appUrl = (path: string) => `${typeof window === 'undefined' ? '' : window.location.origin}${withBase(path)}`;

/** Origin + basename of the current project: prefix for absolute app links (`${appOrigin()}/specs/x`). */
export const appOrigin = () => `${typeof window === 'undefined' ? '' : window.location.origin}${currentProject ? projectBase(currentProject) : ''}`;

/** The app path of the current page (without the project basename). */
export function appPathname(pathname = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  return parseProjectPath(pathname)?.rest ?? pathname;
}

const LAST_KEY = 'mandate.project';
function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
/** The last project opened in this browser (legacy links go there first). */
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Client-side navigation between the picker and projects (the root re-renders on `popstate` and this event). */
export const NAVIGATE_EVENT = 'mandate:navigate';
export function goTo(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
