import { describe, expect, it } from 'vitest';
import { mergeGit, mergeLineRanges, mergeTouched, normalizeCodePath, touchedFromInput } from '../src/work-orders.js';
import { replayComments, type CommentLine } from '../src/comments.js';

describe('touched / git merge', () => {
  it('normalizes paths and merges line ranges', () => {
    expect(normalizeCodePath('./src//a/./b.ts')).toBe('src/a/b.ts');
    expect(normalizeCodePath('../x')).toBeNull();
    expect(mergeLineRanges(['10-20', '5', '21-22', '30-31', '15-18'])).toEqual(['5', '10-22', '30-31']);
  });

  it('merges files idempotently: added stays added, renames keep from, deleted wins', () => {
    const a = mergeTouched([], [touchedFromInput('app:src/a.ts#L1-L5'), { repo: 'app', path: 'src/n.ts', change: 'added', lines: ['1-3'] }]);
    expect(mergeTouched(a, [touchedFromInput('app:src/a.ts#L1-L5')])).toEqual(a);
    const b = mergeTouched(a, [{ repo: 'app', path: 'src/n.ts', change: 'modified', lines: ['4'], symbols: ['x'] }]);
    expect(b.find((t) => t.path === 'src/n.ts')).toEqual({ repo: 'app', path: 'src/n.ts', change: 'added', lines: ['1-4'], symbols: ['x'] });
    const c = mergeTouched(b, [{ repo: 'app', path: 'src/b.ts', change: 'renamed', from: 'src/a.ts' }]);
    expect(c.map((t) => `${t.path}:${t.change}:${t.from ?? ''}`)).toEqual(['src/b.ts:renamed:src/a.ts', 'src/n.ts:added:']);
    const d = mergeTouched(c, [{ repo: 'app', path: 'src/c.ts', change: 'renamed', from: 'src/b.ts' }, { repo: 'app', path: 'src/n.ts', change: 'deleted' }]);
    expect(d.map((t) => `${t.path}:${t.change}:${t.from ?? ''}`)).toEqual(['src/c.ts:renamed:src/a.ts', 'src/n.ts:deleted:']);
    expect(() => mergeTouched([], [{ repo: 'app', path: 'x.ts', change: 'renamed' }])).toThrow(/from/);
  });

  it('merges git context per repo', () => {
    let g = mergeGit([], { repo: 'app', branch: 'b', headCommit: 'aaaa' });
    g = mergeGit(g, { repo: 'app', commits: ['bbbb'], headCommit: 'cccc', pr: { number: 1, status: 'open' } });
    g = mergeGit(g, { repo: 'web', branch: 'w' });
    g = mergeGit(g, { repo: 'app', pr: { status: 'merged', mergedCommit: 'dddd' } });
    expect(g).toEqual([
      { repo: 'app', branch: 'b', headCommit: 'cccc', commits: ['aaaa', 'bbbb', 'cccc'], pr: { number: 1, status: 'merged', mergedCommit: 'dddd' } },
      { repo: 'web', branch: 'w' },
    ]);
    expect(() => mergeGit([], { repo: 'app', pr: { status: 'open' } })).toThrow(/number/);
  });
});

describe('comments replay', () => {
  it('threads replies and replays resolve / reopen', () => {
    const t = 'mandate://work-orders/wo-1';
    const lines: CommentLine[] = [
      { id: 'c-1', target: `${t}/sections/a`, author: { agent: 'r' }, body: 'Fix it', blocking: true, createdAt: '1' },
      { id: 'c-2', target: `${t}/sections/a`, parent: 'c-1', author: { agent: 'i' }, body: 'Done', createdAt: '2' },
      { id: 'c-3', target: `${t}/sections/a`, parent: 'c-2', author: { agent: 'r' }, body: 'Thanks', createdAt: '3' },
      { id: 'cs-1', type: 'resolve', commentId: 'c-2', by: 'r', at: '4', note: 'ok' },
      { id: 'cs-2', type: 'reopen', commentId: 'c-1', by: 'r', at: '5' },
    ];
    const [th] = replayComments(lines);
    expect(th).toMatchObject({ id: 'c-1', status: 'open', blocking: true });
    expect(th!.replies.map((r) => r.id)).toEqual(['c-2', 'c-3']);
    expect(th!.events.map((e) => e.type)).toEqual(['resolve', 'reopen']);
    expect(replayComments([...lines, { id: 'cs-3', type: 'resolve', commentId: 'c-1', by: 'r', at: '6' }])[0]).toMatchObject({ status: 'resolved', resolvedBy: 'r', resolvedAt: '6' });
  });
});

import { planProgress } from '../src/overview.js';
describe('planProgress with a structured plan', () => {
  it('counts only the Steps of a work_order_create plan (files, tests and risks are lists too)', () => {
    const md = '**Steps**\n- [x] Write the code\n- [ ] Write the test\n\n**Files to change**\n- src/a.ts\n- tests/a.test.ts\n\n**Tests**\n- it works proves: ac-1\n\n**Risks**\n- flaky';
    expect(planProgress(md)).toEqual({ total: 2, done: 1, current: { index: 2, text: 'Write the test' } });
    expect(planProgress('1. one\n2. two')).toEqual({ total: 2 });
  });
});
