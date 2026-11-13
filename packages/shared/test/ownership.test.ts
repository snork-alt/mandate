import { describe, expect, it } from 'vitest';
import { globMatch, ownerOf } from '../src/index.js';

type C = { id: string; owns: { repo: string; paths: string[] }[]; status?: string };

describe('globMatch (compiled once per glob)', () => {
  it('keeps the glob semantics', () => {
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/c.ts')).toBe(false);
    expect(globMatch('src/{a,b}/?.ts', 'src/b/x.ts')).toBe(true);
    expect(globMatch('src/{a,b}/?.ts', 'src/c/x.ts')).toBe(false);
    expect(globMatch('src/**', '/src/x/y')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
    // Same glob, many paths: cached regex gives the same answers.
    for (let i = 0; i < 1000; i++) expect(globMatch('src/**/*.ts', `src/d${i}/f.ts`)).toBe(true);
  });
});

describe('ownerOf memo', () => {
  const make = (): C[] => [
    { id: 'api', owns: [{ repo: 'app', paths: ['src/**'] }] },
    { id: 'auth', owns: [{ repo: 'app', paths: ['src/auth/**'] }] },
  ];

  it('returns the most specific owner, repeatedly and per repo', () => {
    const comps = make();
    for (let i = 0; i < 3; i++) {
      expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('auth');
      expect(ownerOf('app', 'src/y.ts', comps)?.component.id).toBe('api');
      expect(ownerOf('other', 'src/y.ts', comps)).toBeNull();
      expect(ownerOf(undefined, 'src/y.ts', comps)?.glob).toBe('src/**');
    }
  });

  it('is invalidated when components change (status, owns, replaced component, new array)', () => {
    const comps = make();
    expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('auth');
    comps[1]!.status = 'archived';
    expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('api');
    comps[1]!.status = 'active';
    comps[1]!.owns = [{ repo: 'app', paths: ['lib/**'] }];
    expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('api');
    expect(ownerOf('app', 'lib/z.ts', comps)?.component.id).toBe('auth');
    comps[0] = { id: 'core', owns: [{ repo: 'app', paths: ['src/**'] }] };
    expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('core');
    comps.push({ id: 'deep', owns: [{ repo: 'app', paths: ['src/auth/x.ts'] }] });
    expect(ownerOf('app', 'src/auth/x.ts', comps)?.component.id).toBe('deep');
    expect(ownerOf('app', 'src/auth/x.ts', make())?.component.id).toBe('auth');
  });

  it('is cheap for many lookups over many components (memoized)', () => {
    const comps: C[] = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, owns: [{ repo: 'app', paths: [`pkg${i}/**/*.{ts,tsx}`, `pkg${i}/src/{a,b}/**`] }] }));
    const paths = Array.from({ length: 500 }, (_, i) => `pkg${i % 200}/src/a/f${i}.ts`);
    const t0 = performance.now();
    for (let round = 0; round < 40; round++) for (const p of paths) ownerOf('app', p, comps);
    const ms = performance.now() - t0;
    expect(ownerOf('app', 'pkg7/src/a/f7.ts', comps)?.component.id).toBe('c7');
    // 20k lookups x 400 globs uncached would be ~8M regex compilations; memoized it is a few ms.
    expect(ms).toBeLessThan(1500);
  });
});
