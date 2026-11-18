/**
 * New-project form that survives the GitHub round trip (permission upgrade, "sign in again", App install /
 * organisation grant). Before leaving for GitHub the form (step + fields) is stashed under a nonce; the return URL
 * carries `?new=1&resume=<nonce>` (OAuth `returnTo`) or GitHub's `?github=installed` (App setup_url, no nonce).
 * On return the form is restored at the step that needed authorization. localStorage (shared with the tab GitHub
 * opens), 30 minutes, same origin only.
 */
export const DRAFT_KEY = 'mandate.newProject';
export const DRAFT_TTL_MS = 30 * 60 * 1000;

export interface Stash<D> {
  nonce: string;
  step: number;
  draft: D;
  at: number;
}

const stores = (): Storage[] => {
  const out: Storage[] = [];
  for (const k of ['localStorage', 'sessionStorage'] as const) {
    try {
      out.push(window[k]);
    } catch {
      /* storage blocked */
    }
  }
  return out;
};

const newNonce = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Store the form; returns its nonce. */
export function stashDraft<D>(draft: D, step: number, now = Date.now()): string {
  const s: Stash<D> = { nonce: newNonce(), step, draft, at: now };
  for (const st of stores()) {
    try {
      st.setItem(DRAFT_KEY, JSON.stringify(s));
    } catch {
      /* full / blocked */
    }
  }
  return s.nonce;
}

export function clearDraft(): void {
  for (const st of stores()) {
    try {
      st.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** The stashed form (fresh, and matching `nonce` when one is given), without consuming it. */
export function peekDraft<D>(nonce?: string | null, now = Date.now()): Stash<D> | null {
  for (const st of stores()) {
    try {
      const raw = st.getItem(DRAFT_KEY);
      if (!raw) continue;
      const s = JSON.parse(raw) as Partial<Stash<D>>;
      if (typeof s.nonce !== 'string' || typeof s.at !== 'number' || typeof s.step !== 'number' || !s.draft || typeof s.draft !== 'object') continue;
      if (now - s.at > DRAFT_TTL_MS || now < s.at - 60_000) continue;
      if (nonce && s.nonce !== nonce) continue;
      return s as Stash<D>;
    } catch {
      /* try the next store */
    }
  }
  return null;
}

/** Does this location come back from GitHub into a New-project flow? */
export function isResumeSearch(search: string): { resume: boolean; nonce: string | null } {
  const p = new URLSearchParams(search);
  const nonce = p.get('resume');
  // GitHub's App setup_url (`?github=installed`) carries no nonce: only a fresh stash makes it a resume.
  return { resume: p.get('new') === '1' || !!nonce || (p.get('github') === 'installed' && !!peekDraft()), nonce };
}

/** Where GitHub's OAuth round trip returns to: the Projects page with the nonce. */
export const resumePath = (nonce: string) => `/?new=1&resume=${encodeURIComponent(nonce)}`;

/** A server-built `/auth/github/login?...&returnTo=` URL with its returnTo replaced by the resume path. */
export function withResume(url: string, nonce: string): string {
  try {
    const u = new URL(url, 'http://x.invalid');
    if (!u.searchParams.has('returnTo')) return url;
    u.searchParams.set('returnTo', resumePath(nonce));
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/** The form to restore on return (matching `nonce` when given; any fresh one for GitHub's `?github=installed`). */
export const restoreDraft = <D,>(nonce?: string | null, now = Date.now()): Stash<D> | null => peekDraft<D>(nonce, now);
