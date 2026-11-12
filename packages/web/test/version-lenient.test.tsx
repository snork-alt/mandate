// @vitest-environment jsdom
/**
 * Opening an old version (UX review D3): versions written under an earlier schema render with
 * non-blocking validation notes; a version that cannot be loaded shows one plain banner and keeps
 * the technical reason behind "Details". Also: mermaid / html bodies wrapped in their own fence (D4).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileVersion, SectionTypeInfo } from '@mandate/shared';
import { installDom, Wrap } from './dom';
import { diffForKind } from '../src/lib/docDiff';
import { computeTracked } from '../src/components/doc/tracked/compute';
import { DocPage } from '../src/components/doc';
import type { TrackedState } from '../src/components/doc/tracked';
import { stripWrappingFence, wrappingFence } from '../src/lib/fence';

installDom();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async () => ({})),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
afterEach(cleanup);

const TYPES: SectionTypeInfo[] = [
  { id: 'markdown', label: 'Text' },
  { id: 'mermaid', label: 'Diagram', fence: 'mermaid' },
  { id: 'html', label: 'HTML', fence: 'html' },
  { id: 'acceptance', label: 'Acceptance criterion' },
];

/** Shape of a real login-sso commit ("update section callback"): verifiedBy acceptance sections, one id since renamed. */
const OLD = `---
title: Login with SSO
summary: Users can sign in with Google or Microsoft via OIDC.
category: auth
status: ready
priority: p1
tags: [security, api]
owner: matteo
repo: app
sections:
  - id: overview
    title: Overview
    type: markdown
  - id: callback
    title: Callback handling
    type: markdown
    summary: The callback checks state and creates a rotating session.
    symbols: [handleOidcCallback]
    verifiedBy: [ac-unverified-rejected, ac-old-renamed-id]
  - id: ac-unverified-rejected
    title: Unverified emails are rejected
    type: acceptance
    summary: An id_token with an unverified email is rejected.
    method: test
---

<!-- @section overview -->
## Overview

Add "Sign in with Google".

<!-- @section callback -->
## Callback handling

Verify state, then exchange the code.

<!-- @section ac-unverified-rejected -->
## Unverified emails are rejected

Rejected with a clear message.
`;
const NEW = OLD.replace('exchange the code.', 'exchange the code with PKCE.');

describe('old versions parse leniently', () => {
  it('verifiedBy an acceptance section is valid (built-in `verifies` is kept)', () => {
    const fixed = OLD.replace(', ac-old-renamed-id', '');
    const { diff, notes } = diffForKind('specs', null, fixed, TYPES);
    expect(diff.sections.map((s) => s.id)).toEqual(['overview', 'callback', 'ac-unverified-rejected']);
    expect(notes.filter((n) => /not a criterion/.test(n.message))).toEqual([]);
  });

  it('a version that fails today’s validation still diffs, with notes', () => {
    const version = { before: OLD, after: NEW, path: 'specs/login-sso.md' } as FileVersion;
    const t = computeTracked('specs', version, TYPES);
    expect(t.diff.sections.find((s) => s.id === 'callback')?.status).toBe('modified');
    expect(t.notes.map((n) => n.message)).toEqual(['section "callback": verifiedBy "ac-old-renamed-id" is not a section of this document']);
  });

  it('throws only when a version has no readable structure', () => {
    expect(() => diffForKind('specs', null, 'just text', TYPES)).toThrow();
  });
});

const base: TrackedState = {
  commit: 'abc1234',
  compare: 'prev',
  view: 'changes',
  setView: () => undefined,
  loading: false,
  notFound: false,
  select: () => undefined,
  setCompare: () => undefined,
  exit: () => undefined,
};
const page = (tracked: TrackedState) =>
  render(
    <Wrap>
      <MemoryRouter>
        <DocPage doc={{ kind: 'specs', id: 'login-sso', title: 'Login' }} header={<h1>Login</h1>} sections={[]} history={{ entries: [], loading: false, now: Date.now() }} tracked={tracked} lineageRef={null} />
      </MemoryRouter>
    </Wrap>,
  );

describe('DocPage in version mode', () => {
  it('renders an old version with a collapsed validation-notes disclosure', () => {
    const data = computeTracked('specs', { before: OLD, after: NEW, path: 'specs/login-sso.md' } as FileVersion, TYPES);
    page({ ...base, data });
    expect(screen.getAllByText('Callback handling').length).toBeGreaterThan(0);
    const notes = screen.getByTestId('version-notes') as HTMLDetailsElement;
    expect(notes.open).toBe(false);
    expect(notes.querySelector('summary')!.textContent).toBe('This version has 1 validation note');
    expect(screen.queryByText(/Version not found|could not be displayed/)).toBeNull();
  });

  it('a version that cannot be loaded: one plain banner, technical detail behind "Details"', () => {
    page({ ...base, error: new Error('2 problems: section "callback": verifiedBy x is a acceptance section, not a criterion') });
    expect(screen.getByText('This version could not be displayed. Showing the latest version.')).toBeTruthy();
    expect(screen.queryByText(/Version not found/)).toBeNull();
    const details = screen.getByTestId('version-error-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    expect(screen.queryByText('Could not show this version')).toBeNull();
  });

  it('a missing commit says "Version not found"', () => {
    page({ ...base, notFound: true, error: new Error("unknown commit 'abc1234'") });
    expect(screen.getByText(/^Version not found/)).toBeTruthy();
  });
});

describe('fence stripping (mermaid / html bodies)', () => {
  it('strips one wrapping fence with or without a language', () => {
    expect(stripWrappingFence('```mermaid\nflowchart TD\n  A-->B\n```')).toBe('flowchart TD\n  A-->B');
    expect(stripWrappingFence('```html\n<p>Hi</p>\n```\n')).toBe('<p>Hi</p>');
    expect(stripWrappingFence('~~~\n<p>Hi</p>\n~~~')).toBe('<p>Hi</p>');
    expect(stripWrappingFence('````mermaid\nA\n```\nB\n````')).toBe('A\n```\nB');
    expect(wrappingFence('```html\n<b/>\n```')).toEqual({ lang: 'html' });
  });

  it('leaves unwrapped or unbalanced bodies alone', () => {
    expect(stripWrappingFence('flowchart TD\n  A-->B')).toBe('flowchart TD\n  A-->B');
    expect(stripWrappingFence('<p>a</p>\n```js\nx\n```')).toBe('<p>a</p>\n```js\nx\n```');
    expect(stripWrappingFence('```mermaid\nA-->B')).toBe('```mermaid\nA-->B');
    expect(stripWrappingFence('````\nA\n```')).toBe('````\nA\n```');
    expect(wrappingFence('<p/>')).toBeNull();
  });
});
