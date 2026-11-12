import { describe, expect, it } from 'vitest';
import { githubLoginUrl, loginErrorMessage, safeReturnTo } from '../src/auth';
import { normalizeSubpath, projectIdError, repoLabel, slugify } from '../src/connect/github';
import { isUnauthorized } from '../src/mcp/client';

describe('auth helpers', () => {
  it('only accepts same-origin relative returnTo paths', () => {
    expect(safeReturnTo('/p/demo/specs?x=1#a')).toBe('/p/demo/specs?x=1#a');
    for (const bad of [null, '', 'https://evil.example', '//evil.example/x', '/\\evil.example', '/login?returnTo=/', '/auth/github/login', 'specs']) expect(safeReturnTo(bad)).toBe('/');
  });
  it('builds the GitHub login URL (encoded, sanitized)', () => {
    expect(githubLoginUrl('/p/demo/specs?a=1')).toBe('/auth/github/login?returnTo=%2Fp%2Fdemo%2Fspecs%3Fa%3D1');
    expect(githubLoginUrl('//evil')).toBe('/auth/github/login?returnTo=%2F');
  });
  it('maps login error codes', () => {
    for (const c of ['state_mismatch', 'not_allowed', 'github_error', 'not_configured']) expect(loginErrorMessage(c)).toBeTruthy();
    expect(loginErrorMessage('weird')).toContain('weird');
    expect(loginErrorMessage(null)).toBeNull();
  });
  it('recognizes MCP 401s', () => {
    expect(isUnauthorized({ code: 401 })).toBe(true);
    expect(isUnauthorized(new Error('Streamable HTTP error: Error POSTing to endpoint (HTTP 401): {"error":{}}'))).toBe(true);
    expect(isUnauthorized(new Error('HTTP 404'))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe('new project helpers', () => {
  it('slugifies names into project ids', () => {
    expect(slugify('Billing Platform')).toBe('billing-platform');
    expect(slugify('  Café & Crème!! ')).toBe('cafe-creme');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
    expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
    expect(projectIdError(slugify('Hello World 2'))).toBeNull();
  });
  it('validates ids', () => {
    expect(projectIdError('')).toBe('Required');
    expect(projectIdError('ok-id-1')).toBeNull();
    for (const bad of ['Upper', 'a--b', '-a', 'a-', 'a_b', 'a'.repeat(41)]) expect(projectIdError(bad)).not.toBeNull();
  });
  it('normalizes repo subfolders', () => {
    expect(normalizeSubpath('')).toBe('');
    expect(normalizeSubpath('/specs/billing/')).toBe('specs/billing');
    expect(normalizeSubpath('a\\b')).toBe('a/b');
    expect(normalizeSubpath('../x')).toBeNull();
    expect(normalizeSubpath('a//b')).toBeNull();
  });
  it('labels GitHub storage', () => {
    expect(repoLabel({ repo: 'acme/specs', path: null })).toBe('acme/specs');
    expect(repoLabel({ repo: 'acme/specs', path: 'billing' })).toBe('acme/specs/billing');
  });
});
