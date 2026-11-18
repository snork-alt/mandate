// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, DRAFT_TTL_MS, isResumeSearch, peekDraft, restoreDraft, resumePath, stashDraft, withResume } from '../src/connect/newProjectDraft';

const form = { name: 'Acme', id: 'acme', description: '', repo: { fullName: 'octo/specs' }, branch: 'main', owner: 'octo' };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('New project draft across the GitHub round trip', () => {
  it('restores the form and step by nonce, and survives being read twice (StrictMode)', () => {
    const n = stashDraft(form, 1);
    expect(restoreDraft<typeof form>(n)).toMatchObject({ step: 1, draft: form });
    expect(restoreDraft<typeof form>(n)?.draft.name).toBe('Acme');
    expect(restoreDraft('other')).toBeNull();
  });
  it('expires after 30 minutes and clears', () => {
    stashDraft(form, 1, 1000);
    expect(peekDraft(null, 1000 + DRAFT_TTL_MS - 1)).not.toBeNull();
    expect(peekDraft(null, 1000 + DRAFT_TTL_MS + 1)).toBeNull();
    stashDraft(form, 1);
    clearDraft();
    expect(peekDraft()).toBeNull();
  });
  it('rejects malformed stashes', () => {
    localStorage.setItem('mandate.newProject', '{"nonce":1}');
    sessionStorage.setItem('mandate.newProject', 'not json');
    expect(peekDraft()).toBeNull();
  });
  it('adds the resume nonce to the OAuth returnTo', () => {
    const url = withResume('/auth/github/login?scope=repo&returnTo=%2F%3Fnew%3D1', 'abc123');
    const u = new URL(url, 'http://x');
    expect(u.pathname).toBe('/auth/github/login');
    expect(u.searchParams.get('scope')).toBe('repo');
    expect(u.searchParams.get('returnTo')).toBe(resumePath('abc123'));
    expect(withResume('/other?x=1', 'n')).toBe('/other?x=1');
  });
  it('recognises the return from GitHub', () => {
    expect(isResumeSearch('?new=1&resume=abc')).toEqual({ resume: true, nonce: 'abc' });
    expect(isResumeSearch('?github=installed').resume).toBe(false); // no stash: e.g. the setup wizard
    stashDraft(form, 1);
    expect(isResumeSearch('?github=installed').resume).toBe(true);
    expect(isResumeSearch('').resume).toBe(false);
  });
});
