import { describe, expect, it } from 'vitest';
import { buildNodeUri, buildRef, nodeKindOf, parseNodeUri, parseRef, refMention, type MandateRef, type NodeRef } from '../src/refs.js';

describe('refs', () => {
  const cases: [MandateRef, string][] = [
    [{ kind: 'specs', id: 'login-sso' }, 'mandate://specs/login-sso'],
    [{ kind: 'specs', id: 'login-sso', sectionId: 'auth-flow' }, 'mandate://specs/login-sso/sections/auth-flow'],
    [{ kind: 'standards', id: 'security-baseline', sectionId: 'rules' }, 'mandate://standards/security-baseline/sections/rules'],
    [{ kind: 'work-orders', id: 'wo-01jx3k' }, 'mandate://work-orders/wo-01jx3k'],
    [{ kind: 'feedback', id: 'fb-0012' }, 'mandate://feedback/fb-0012'],
    [{ kind: 'standards', id: 'security-baseline', sectionId: 'ac-no-secrets-in-logs', commit: 'abc1234' }, 'mandate://standards/security-baseline@abc1234/sections/ac-no-secrets-in-logs'],
    [{ kind: 'specs', id: 'a', commit: '3f2a9c1' }, 'mandate://specs/a@3f2a9c1'],
    [{ kind: 'specs', id: 'a', sectionId: 'b', commit: '3f2a9c1', lines: { start: 12, end: 20 } }, 'mandate://specs/a@3f2a9c1/sections/b#L12-L20'],
    [
      { kind: 'specs', id: 'login-sso', sectionId: 'tokens', commit: 'a91e0f2c3d4e5f60718293a4b5c6d7e8f9012345', lines: { start: 42, end: 48 } },
      'mandate://specs/login-sso@a91e0f2c3d4e5f60718293a4b5c6d7e8f9012345/sections/tokens#L42-L48',
    ],
    [{ kind: 'specs', id: 'a', sectionId: 'b', lines: { start: 7, end: 7 } }, 'mandate://specs/a/sections/b#L7'],
  ];

  it.each(cases)('builds and parses %j', (ref, uri) => {
    expect(buildRef(ref)).toBe(uri);
    expect(parseRef(uri)).toEqual(ref);
    expect(parseRef(`@mandate:${uri}`)).toEqual(ref);
  });

  it('reads the legacy `mandate://queue/<id>` form as an alias of work-orders (and emits the new form)', () => {
    const ref = parseRef('mandate://queue/q-0001@abc1234');
    expect(ref).toEqual({ kind: 'work-orders', id: 'q-0001', commit: 'abc1234' });
    expect(buildRef(ref!)).toBe('mandate://work-orders/q-0001@abc1234');
    expect(parseRef('@mandate:mandate://queue/q-0001')).toEqual({ kind: 'work-orders', id: 'q-0001' });
  });

  it('formats Claude Code mentions', () => {
    expect(refMention({ kind: 'specs', id: 'login-sso', sectionId: 'auth-flow' })).toBe(
      '@mandate:mandate://specs/login-sso/sections/auth-flow',
    );
  });

  it('rejects invalid references', () => {
    for (const bad of [
      'https://specs/a',
      'mandate://blueprints/a',
      'mandate://specs/Bad_Id',
      'mandate://work-orders/a/sections/b',
      'mandate://queue/a/sections/b',
      'mandate://feedback/a/sections/b',
      'mandate://specs/a@xyz',
      'mandate://specs/a/sections/b@abc1234', // version suffix belongs on the document id
      'mandate://specs/a#L5-L2',
      'mandate://specs/a#L0',
      'mandate://specs/a/sections/',
      'mandate://specs/a/sections/b/criteria/ac-1',
    ]) {
      expect(parseRef(bad), bad).toBeNull();
    }
    expect(() => buildRef({ kind: 'work-orders', id: 'a', sectionId: 'b' })).toThrow();
  });
});

describe('graph node uris', () => {
  const nodes: [NodeRef, string][] = [
    [{ kind: 'symbols', name: 'AuthService.login' }, 'mandate://symbols/AuthService.login'],
    [{ kind: 'symbols', name: 'Foo::bar' }, 'mandate://symbols/Foo::bar'],
    [{ kind: 'symbols', name: 'GET /v1/audit-events' }, 'mandate://symbols/GET%20%2Fv1%2Faudit-events'],
    [{ kind: 'code', repo: 'app', path: 'src/auth/oidc.ts' }, 'mandate://code/app/src/auth/oidc.ts'],
    [{ kind: 'code', repo: 'app', path: 'src/auth/oidc.ts', lines: { start: 10, end: 64 } }, 'mandate://code/app/src/auth/oidc.ts#L10-L64'],
    [{ kind: 'code', repo: 'app', path: 'a b.ts', lines: { start: 3, end: 3 } }, 'mandate://code/app/a%20b.ts#L3'],
    [{ kind: 'repos', name: 'api' }, 'mandate://repos/api'],
    [{ kind: 'commits', sha: '3f2a9c1' }, 'mandate://commits/3f2a9c1'],
    [{ kind: 'specs', id: 'a', sectionId: 'b' }, 'mandate://specs/a/sections/b'],
    [{ kind: 'agents', name: 'codex@build-02' }, 'mandate://agents/codex%40build-02'],
    [{ kind: 'branches', name: 'feat/sso' }, 'mandate://branches/feat%2Fsso'],
    [{ kind: 'verifications', id: 'vr-0001' }, 'mandate://verifications/vr-0001'],
  ];

  it.each(nodes)('builds and parses %j', (ref, uri) => {
    expect(buildNodeUri(ref)).toBe(uri);
    expect(parseNodeUri(uri)).toEqual(ref);
  });

  it('classifies node kinds', () => {
    expect(nodes.map(([r]) => nodeKindOf(r))).toEqual(['symbol', 'symbol', 'symbol', 'code_file', 'code_range', 'code_range', 'repo', 'commit', 'section', 'agent', 'branch', 'verification']);
  });

  it('rejects invalid node uris', () => {
    for (const bad of ['mandate://code/app', 'mandate://code/app/../x', 'mandate://commits/xyz', 'mandate://symbols/', 'mandate://code/app/x#L5-L2', 'mandate://other/x', 'mandate://symbols/%E0%A4%A']) {
      expect(parseNodeUri(bad)).toBeNull();
    }
  });
});

describe('ref builders registry', () => {
  it('covers every ref kind and builds chip references', async () => {
    const { REF_KINDS, refBuilders, buildCodeRef, buildSymbolRef, buildCommitRef, mentionOf, refFromText, refLabel } = await import('../src/refs.js');
    expect(Object.keys(refBuilders).sort()).toEqual([...REF_KINDS].sort());
    expect(buildCodeRef({ repo: 'app', path: 'src/a.ts', lines: '10-64', commit: 'abc1234' })).toBe('mandate://code/app@abc1234/src/a.ts#L10-L64');
    expect(buildSymbolRef('AuthService.login')).toBe('mandate://symbols/AuthService.login');
    expect(buildCommitRef('a'.repeat(40))).toBe(`mandate://commits/${'a'.repeat(40)}`);
    expect(mentionOf('mandate://specs/x')).toBe('@mandate:mandate://specs/x');
    expect(refFromText(' @mandate:mandate://specs/x ')).toBe('mandate://specs/x');
    expect(refFromText('hello')).toBeNull();
    expect(refLabel('mandate://specs/x/sections/y')).toBe('specs/x/sections/y');
  });
});

describe('every reference is a node (kinds + canonical form)', () => {
  it('classifies versions and excerpts and canonicalises copied forms', async () => {
    const { canonicalRef, NODE_KINDS } = await import('../src/refs.js');
    const cases: [string, string][] = [
      ['mandate://specs/a', 'spec'],
      ['@mandate:mandate://specs/a/sections/b', 'section'],
      ['mandate://specs/a@3f2a9c1', 'version'],
      ['mandate://specs/a@3f2a9c1/sections/b', 'version'],
      ['mandate://specs/a/sections/b@3f2a9c1', 'version'],
      ['mandate://specs/a@3f2a9c1/sections/b#L3-L9', 'excerpt'],
      ['mandate://standards/s#L2', 'excerpt'],
    ];
    for (const [uri, kind] of cases) {
      expect(nodeKindOf(parseNodeUri(uri)!)).toBe(kind);
      expect(NODE_KINDS).toContain(kind);
      const c = canonicalRef(uri)!;
      expect(canonicalRef(c)).toBe(c);
      expect(parseNodeUri(c)).toEqual(parseNodeUri(uri));
    }
    expect(canonicalRef('mandate://specs/a@3f2a9c1/sections/b')).toBe(canonicalRef('mandate://specs/a/sections/b@3f2a9c1'));
    expect(canonicalRef('nope')).toBeNull();
  });
});
