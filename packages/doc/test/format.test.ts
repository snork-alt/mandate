import { describe, expect, it } from 'vitest';
import { DocError, type DocIssueCode } from '../src/index.js';
import { CANONICAL, fmt } from './fixtures.js';

const codes = (md: string): DocIssueCode[] => fmt.validate(md).issues.map((i) => i.code);

/** Build a document from a frontmatter string and body. */
const doc = (front: string, body = '') => `---\n${front}\n---\n${body}`;

describe('parse', () => {
  it('parses frontmatter and sections', () => {
    const d = fmt.parse(CANONICAL);
    expect(d.frontmatter).toMatchObject({
      title: 'Login with SSO',
      status: 'in_progress',
      tags: ['security', 'api'],
      claim: { agent: 'claude-code@matteo-mbp', startedAt: '2026-11-11T22:50:00Z' },
    });
    expect(d.frontmatter).not.toHaveProperty('sections');
    expect(d.sections.map((s) => [s.id, s.type])).toEqual([
      ['overview', 'markdown'],
      ['auth-flow', 'mermaid'],
      ['button', 'html'],
    ]);
    expect(d.sections[0]!.body).toBe('Users pick a provider.\n\n### Details\n\n- Google\n- Microsoft');
    expect(d.sections[1]).toMatchObject({
      body: 'sequenceDiagram\n  User->>App: login',
      refs: [{ repo: 'app', path: 'src/auth/oidc.ts', lines: '10-64', commit: '3f2a9c1' }],
      symbols: ['OidcClient', 'AuthService.login'],
    });
    expect(d.sections[2]!.body).toBe('<button class="sso">Sign in</button>');
  });

  it('applies defaults for optional section metadata', () => {
    const d = fmt.parse(doc('title: T\nsections:\n  - id: a\n    title: A', '\n<!-- @section a -->\n## A\n'));
    expect(d.sections[0]).toEqual({ id: 'a', title: 'A', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: '' });
    expect(d.frontmatter).toEqual({ title: 'T', status: 'draft', tags: [], dependsOn: [] });
  });

  it('accepts a document without sections', () => {
    expect(fmt.parse('---\ntitle: Empty\n---\n').sections).toEqual([]);
    expect(fmt.parse('---\ntitle: Empty\nsections:\n---\n\n\n').sections).toEqual([]);
  });

  it('coerces numeric commits and line numbers to strings', () => {
    const d = fmt.parse(
      doc(
        'title: T\nimplementedCommit: 1234567\nsections:\n  - id: a\n    title: A\n    refs: [{repo: app, path: x.ts, lines: 12, commit: 7654321}]',
        '\n<!-- @section a -->\n## A\n',
      ),
    );
    expect(d.frontmatter.implementedCommit).toBe('1234567');
    expect(d.sections[0]!.refs[0]).toEqual({ repo: 'app', path: 'x.ts', lines: '12', commit: '7654321' });
    // ...and quotes them on output so they stay strings.
    expect(fmt.serialize(d)).toContain(`implementedCommit: "1234567"`);
  });

  it('ignores marker-looking lines inside code fences', () => {
    const body = '\n<!-- @section a -->\n## A\n\n```md\n<!-- @section fake -->\n## Fake\n```\n\nafter';
    const d = fmt.parse(doc('title: T\nsections:\n  - id: a\n    title: A', body));
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0]!.body).toBe('```md\n<!-- @section fake -->\n## Fake\n```\n\nafter');
  });

  it('normalizes CRLF line endings', () => {
    const d = fmt.parse(CANONICAL.replace(/\n/g, '\r\n'));
    expect(fmt.serialize(d)).toBe(CANONICAL);
  });

  it('throws a DocError listing all issues', () => {
    const bad = doc('title: T\nsections:\n  - id: a\n    title: A\n  - id: a\n    title: B', 'stray\n');
    try {
      fmt.parse(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocError);
      const issues = (err as DocError).issues.map((i) => i.code);
      expect(issues).toContain('duplicate-id');
      expect(issues).toContain('content-before-first-section');
    }
  });
});

describe('serialize', () => {
  it('round-trips the canonical file byte for byte', () => {
    expect(fmt.serialize(fmt.parse(CANONICAL))).toBe(CANONICAL);
  });

  it('is stable: serialize(parse(serialize(x))) === serialize(x)', () => {
    const once = fmt.serialize({
      frontmatter: { title: 'Weird: "quotes", #hash & commas', tags: ['a b', 'c,d'], summary: 'line one' },
      sections: [
        { id: 'x', title: 'X: a title with # chars', body: '\n\nhello\n\n\n' },
        { id: 'y', title: 'Diagram', type: 'mermaid', body: 'graph TD\n  A-->B\n' },
        { id: 'z', title: 'Empty html', type: 'html', body: '' },
      ],
    });
    const twice = fmt.serialize(fmt.parse(once));
    expect(twice).toBe(once);
    expect(fmt.parse(once).frontmatter.title).toBe('Weird: "quotes", #hash & commas');
    expect(fmt.parse(once).sections.map((s) => s.body)).toEqual(['hello', 'graph TD\n  A-->B', '']);
  });

  it('writes headings from the frontmatter title and omits empty lists', () => {
    const md = fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'Alpha', body: 'x' }] });
    expect(md).toBe(
      '---\ntitle: T\nstatus: draft\nsections:\n  - id: a\n    title: Alpha\n    type: markdown\n---\n\n<!-- @section a -->\n## Alpha\n\nx\n',
    );
  });

  it('round-trips per-section implementedCommit', () => {
    const md = fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'A', body: 'x', implementedCommit: '3f2a9c1' }] });
    expect(md).toContain('    implementedCommit: 3f2a9c1\n');
    expect(fmt.parse(md).sections[0]!.implementedCommit).toBe('3f2a9c1');
    expect(fmt.serialize(fmt.parse(md))).toBe(md);
  });

  it('uses a longer fence when the body contains backtick fences', () => {
    const body = 'flowchart LR\n```\nnot really\n```';
    const md = fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'A', type: 'mermaid', body }] });
    expect(md).toContain('````mermaid\n');
    expect(fmt.parse(md).sections[0]!.body).toBe(body);
  });

  it('rejects bodies that would not round-trip', () => {
    expect(() =>
      fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'A', body: 'x\n<!-- @section b -->\ny' }] }),
    ).toThrow(DocError);
  });

  it('rejects invalid frontmatter and section metadata', () => {
    expect(() => fmt.serialize({ frontmatter: { title: '' }, sections: [] })).toThrow(/frontmatter.title/);
    expect(() => fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'Bad Id', title: 'A' }] })).toThrow(
      /sections\[0\]\.id/,
    );
    expect(() =>
      fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'line\nbreak' }] }),
    ).toThrow(DocError);
  });
});

describe('validate', () => {
  const front = 'title: T\nsections:\n  - id: a\n    title: A\n  - id: b\n    title: B';
  const body = '\n<!-- @section a -->\n## A\n\none\n\n<!-- @section b -->\n## B\n\ntwo\n';

  it('accepts a valid document', () => {
    expect(fmt.validate(doc(front, body))).toMatchObject({ ok: true, issues: [] });
    expect(fmt.validate(CANONICAL).ok).toBe(true);
  });

  it('requires frontmatter', () => {
    expect(codes('# just markdown')).toEqual(['frontmatter-missing']);
    expect(codes('---\ntitle: T\n')).toEqual(['frontmatter-missing']);
  });

  it('reports invalid YAML and schema errors', () => {
    expect(codes(doc('title: [unclosed'))).toContain('yaml-invalid');
    expect(codes(doc('- a list'))).toContain('yaml-invalid');
    expect(codes(doc('title: T\ntitle: U'))).toContain('yaml-invalid');
    expect(codes(doc('status: nope'))).toContain('frontmatter-invalid');
    expect(codes(doc('title: T\nsections: nope'))).toContain('sections-invalid');
    expect(codes(doc('title: T\nsections:\n  - id: a', '\n<!-- @section a -->\n## A\n'))).toContain('sections-invalid');
  });

  it('reports unknown section types', () => {
    const r = fmt.validate(doc('title: T\nsections:\n  - id: a\n    title: A\n    type: video', '\n<!-- @section a -->\n## A\n'));
    expect(r.issues[0]).toMatchObject({ code: 'unknown-type', sectionId: 'a' });
  });

  it('rejects content before the first section', () => {
    const r = fmt.validate(doc(front, `\nintro\n${body}`));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'content-before-first-section', line: 10 })]);
  });

  it('detects duplicate ids in frontmatter and body', () => {
    expect(codes(doc(front.replace('id: b', 'id: a'), body))).toContain('duplicate-id');
    expect(codes(doc(front, body.replace('@section b', '@section a')))).toContain('duplicate-id');
  });

  it('checks that frontmatter sections and markers match', () => {
    expect(codes(doc(front, body + '\n<!-- @section c -->\n## C\n'))).toEqual(['marker-without-metadata']);
    expect(codes(doc(front + '\n  - id: c\n    title: C', body))).toEqual(['metadata-without-marker']);
    const swapped = '\n<!-- @section b -->\n## B\n\ntwo\n\n<!-- @section a -->\n## A\n\none\n';
    expect(codes(doc(front, swapped))).toEqual(['order-mismatch']);
  });

  it('checks headings against titles', () => {
    expect(codes(doc(front, body.replace('## A', '## Alpha')))).toEqual(['heading-mismatch']);
    expect(codes(doc(front, body.replace('## A\n', '')))).toEqual(['heading-missing']);
    const r = fmt.validate(doc(front, body.replace('## B', '### B')));
    expect(r.issues[0]).toMatchObject({ code: 'heading-missing', sectionId: 'b', line: 16 });
  });

  it('requires fences for mermaid and html bodies', () => {
    const m = 'title: T\nsections:\n  - id: a\n    title: A\n    type: mermaid';
    expect(codes(doc(m, '\n<!-- @section a -->\n## A\n\ngraph TD\n'))).toEqual(['fence-missing']);
    expect(codes(doc(m, '\n<!-- @section a -->\n## A\n\n```html\n<b/>\n```\n'))).toEqual(['fence-mismatch']);
    expect(codes(doc(m, '\n<!-- @section a -->\n## A\n'))).toEqual([]);
  });
});

describe('inspect (lenient parse)', () => {
  it('returns the document with its problems instead of throwing', () => {
    const md = doc(
      'title: Old\nsections:\n  - id: a\n    title: A\n    type: markdown\n    verifiedBy: [b, gone]\n  - id: b\n    title: B\n    type: markdown',
      '\n<!-- @section a -->\n## A\n\nText.\n\n<!-- @section b -->\n## Renamed B\n',
    );
    expect(() => fmt.parse(md)).toThrow(DocError);
    const r = fmt.inspect(md);
    expect(r.doc?.sections.map((s) => s.id)).toEqual(['a', 'b']);
    expect(r.doc?.sections[0]!.body).toBe('Text.');
    expect(r.issues.map((i) => i.code)).toEqual(['heading-mismatch', 'sections-invalid', 'sections-invalid']);
  });

  it('keeps frontmatter that fails the schema and matches parse on valid files', () => {
    expect(fmt.inspect(doc('title: 42')).doc?.frontmatter).toMatchObject({ title: 42 });
    expect(fmt.inspect(CANONICAL)).toEqual({ doc: fmt.parse(CANONICAL), issues: [] });
    expect(fmt.inspect('no frontmatter').doc).toBeUndefined();
  });
});
