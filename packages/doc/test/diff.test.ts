import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, createDocFormat, diffDocs, diffPlainMarkdown, diffText, diffValues, insertSection, moveSection, updateSection, type TextOp } from '../src/index.js';
import { CANONICAL, fmt, testSchema } from './fixtures.js';

const text = (ops: TextOp[] | undefined, op: TextOp['op']) => (ops ?? []).filter((o) => o.op === op).map((o) => o.text);

describe('diffText', () => {
  it('diffs words and merges adjacent runs', () => {
    const ops = diffText('the quick brown fox', 'the slow brown fox jumps', 'words');
    expect(text(ops, 'delete')).toEqual(['quick']);
    expect(text(ops, 'insert')).toEqual(['slow', ' jumps']);
    expect(ops.map((o) => o.text).filter((_, i) => ops[i]!.op !== 'delete').join('')).toBe('the slow brown fox jumps');
  });

  it('diffs lines for code', () => {
    const ops = diffText('a\nb\nc\n', 'a\nB\nc\n', 'lines');
    expect(ops).toEqual([
      { op: 'equal', text: 'a\n' },
      { op: 'delete', text: 'b\n' },
      { op: 'insert', text: 'B\n' },
      { op: 'equal', text: 'c\n' },
    ]);
    expect(diffText('same', 'same')).toEqual([{ op: 'equal', text: 'same' }]);
    expect(diffText('', '')).toEqual([]);
  });
});

describe('diffValues', () => {
  it('reports scalar changes and list items added / removed', () => {
    const changes = diffValues(
      { status: 'ready', tags: ['a', 'b'], owner: 'x', refs: [{ path: 'a.ts' }], same: 1 },
      { status: 'in_progress', tags: ['b', 'c'], summary: 'new', refs: [{ path: 'b.ts' }], same: 1 },
    );
    expect(changes.map((c) => [c.key, c.kind])).toEqual([
      ['status', 'changed'],
      ['tags', 'changed'],
      ['summary', 'added'],
      ['refs', 'changed'],
      ['owner', 'removed'],
    ]);
    expect(changes[0]).toEqual({ key: 'status', kind: 'changed', before: 'ready', after: 'in_progress' });
    expect(changes[1]).toMatchObject({ addedItems: ['c'], removedItems: ['a'] });
    expect(changes[3]).toMatchObject({ addedItems: [{ path: 'b.ts' }], removedItems: [{ path: 'a.ts' }] });
  });

  it('treats empty lists and missing values as equal', () => {
    expect(diffValues({ tags: [] }, {})).toEqual([]);
    expect(diffValues({ claim: { a: 1 } }, { claim: { a: 1 } })).toEqual([]);
  });
});

describe('diffDocs', () => {
  const base = fmt.parse(CANONICAL);

  it('reports nothing for identical documents', () => {
    const d = diffDocs(fmt, CANONICAL, CANONICAL);
    expect(d.status).toBe('unchanged');
    expect(d.frontmatter).toEqual([]);
    expect(d.stats).toEqual({ added: 0, removed: 0, modified: 0, moved: 0, unchanged: 3 });
  });

  it('diffs frontmatter fields', () => {
    const after = fmt.serialize({ ...base, frontmatter: { ...base.frontmatter, status: 'done', tags: ['security', 'web'], claim: undefined } });
    const d = diffDocs(fmt, CANONICAL, after);
    expect(d.frontmatter.map((c) => [c.key, c.kind])).toEqual([
      ['status', 'changed'],
      ['tags', 'changed'],
      ['claim', 'removed'],
    ]);
    expect(d.frontmatter[1]).toMatchObject({ addedItems: ['web'], removedItems: ['api'] });
  });

  it('classifies sections as added, removed, modified, moved and unchanged', () => {
    let next = updateSection(base, 'overview', { body: 'Users pick an identity provider.' });
    next = updateSection(next, 'auth-flow', { body: 'sequenceDiagram\n  User->>App: login\n  App-->>User: ok', symbols: ['OidcClient'] });
    next = moveSection(next, 'button', 0);
    next = insertSection(next, { id: 'risks', title: 'Risks', body: 'Token leakage.' }, { after: 'overview' });
    const d = diffDocs(fmt, CANONICAL, fmt.serialize(next));
    expect(d.sections.map((s) => [s.id, s.status, s.moved])).toEqual([
      ['button', 'unchanged', true],
      ['overview', 'modified', false],
      ['risks', 'added', false],
      ['auth-flow', 'modified', false],
    ]);
    const flow = d.sections.find((s) => s.id === 'auth-flow')!;
    expect(flow.body?.mode).toBe('lines'); // fenced type -> line diff
    expect(text(flow.body?.ops, 'insert')).toEqual(['  App-->>User: ok\n']);
    expect(flow.meta).toEqual([expect.objectContaining({ key: 'symbols', removedItems: ['AuthService.login'] })]);
    expect(d.stats).toMatchObject({ added: 1, removed: 0, modified: 2, unchanged: 1, moved: 1 });
  });

  it('keeps removed sections at their former position', () => {
    const d = diffDocs(fmt, CANONICAL, fmt.serialize({ ...base, sections: base.sections.filter((s) => s.id !== 'auth-flow') }));
    expect(d.sections.map((s) => [s.id, s.status])).toEqual([
      ['overview', 'unchanged'],
      ['auth-flow', 'removed'],
      ['button', 'unchanged'],
    ]);
  });

  it('uses word diffs for markdown bodies and detects title changes', () => {
    const next = updateSection(base, 'overview', { title: 'Summary', body: 'Users pick a provider.\n\n### Details\n\n- Google\n- GitHub' });
    const s = diffDocs(fmt, CANONICAL, fmt.serialize(next)).sections[0]!;
    expect(s).toMatchObject({ status: 'modified', title: { before: 'Overview', after: 'Summary' } });
    expect(s.body?.mode).toBe('words');
    expect(text(s.body?.ops, 'delete')).toEqual(['Microsoft']);
    expect(text(s.body?.ops, 'insert')).toEqual(['GitHub']);
  });

  it('handles creation and deletion', () => {
    const created = diffDocs(fmt, null, CANONICAL);
    expect(created.status).toBe('added');
    expect(created.sections.every((s) => s.status === 'added')).toBe(true);
    expect(created.frontmatter.find((c) => c.key === 'title')).toMatchObject({ kind: 'added', after: 'Login with SSO' });
    const deleted = diffDocs(fmt, CANONICAL, null);
    expect(deleted.status).toBe('removed');
    expect(deleted.sections.map((s) => s.status)).toEqual(['removed', 'removed', 'removed']);
    expect(deleted.sections[0]!.body?.ops[0]?.op).toBe('delete');
  });

  it('lets a section type provide its own diff', () => {
    const registry = createDefaultRegistry().register({
      id: 'json',
      fence: 'json',
      diff: (b, a) => [{ op: 'equal', text: `${b.length}->${a.length}` }],
    });
    const f = createDocFormat(testSchema, { registry });
    const doc = (body: string) => f.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'j', title: 'J', type: 'json', body }] });
    expect(diffDocs(f, doc('[1]'), doc('[1, 2]')).sections[0]!.body?.ops).toEqual([{ op: 'equal', text: '3->6' }]);
  });

  it('reports per-item changes from a diffItems hook', () => {
    const registry = createDefaultRegistry().register({
      id: 'kv',
      fence: 'kv',
      diffItems: (b, a) => {
        const parse = (t: string) => new Map(t.split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]));
        const [pb, pa] = [parse(b), parse(a)];
        const out: { id: string; change: 'added' | 'removed' | 'modified' }[] = [];
        for (const [k, v] of pa) if (!pb.has(k)) out.push({ id: k, change: 'added' }); else if (pb.get(k) !== v) out.push({ id: k, change: 'modified' });
        for (const k of pb.keys()) if (!pa.has(k)) out.push({ id: k, change: 'removed' });
        return out;
      },
    });
    const f = createDocFormat(testSchema, { registry });
    const doc = (body: string) => f.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'k', title: 'K', type: 'kv', body }] });
    expect(diffDocs(f, doc('a=1\nb=2'), doc('a=1\nb=3\nc=4')).sections[0]!.items).toEqual([
      { id: 'b', change: 'modified' },
      { id: 'c', change: 'added' },
    ]);
  });

  it('treats summary-only edits as metadata changes', () => {
    const base = fmt.parse(CANONICAL);
    const next = updateSection(base, 'overview', { summary: 'How users pick a provider.' });
    const s = diffDocs(fmt, CANONICAL, fmt.serialize(next)).sections[0]!;
    expect(s.status).toBe('modified');
    expect(s.meta).toEqual([expect.objectContaining({ key: 'summary', kind: 'added', after: 'How users pick a provider.' })]);
  });

  it('throws when a version does not parse', () => {
    expect(() => diffDocs(fmt, 'no frontmatter', CANONICAL)).toThrow();
  });
});

describe('diffPlainMarkdown', () => {
  it('diffs simple frontmatter + markdown files as one section', () => {
    const d = diffPlainMarkdown('---\ntitle: A\n---\nhello world\n', '---\ntitle: B\n---\nhello there world\n');
    expect(d.frontmatter).toEqual([{ key: 'title', kind: 'changed', before: 'A', after: 'B' }]);
    expect(d.sections[0]).toMatchObject({ id: 'content', status: 'modified' });
    expect(text(d.sections[0]!.body?.ops, 'insert')).toEqual(['there ']);
    expect(diffPlainMarkdown(null, 'no frontmatter').sections[0]!.after?.body).toBe('no frontmatter');
  });
});
