/** Ask: model-facing tool results are compacted and hard-bounded (never drop uri/title; truncation notes lead with narrowing). */
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@mandate/doc';
import { bound, MAX_CONTINUATIONS, modelResult, prune, toModel } from '../../src/ask/compact.js';

const H = 'a'.repeat(40);
const note = (text: string) => {
  const line = text.split('\n').find((l) => l.startsWith('{"truncated":true'));
  return line ? (JSON.parse(line) as { truncated: true; shown: number; total?: number; unit: string; next?: { cursor: string } }) : undefined;
};

/** Large, realistic bodies per tool family. */
function bigSpec(sections = 40) {
  return {
    uri: 'mandate://specs/big',
    id: 'big',
    commit: H,
    frontmatter: { title: 'Big spec', status: 'ready', summary: 'A big one', tags: ['api'], implementedCommit: H, exemptFrom: [] },
    sections: Array.from({ length: sections }, (_, i) => ({
      uri: `mandate://specs/big/sections/s${i}`,
      id: `s${i}`,
      title: `Section ${i}`,
      type: i % 5 === 0 ? 'acceptance' : 'markdown',
      summary: `Summary of section ${i}`,
      lines: { start: i * 10, end: i * 10 + 9 },
      meta: { refs: [], symbols: [], links: i % 3 === 0 ? [{ to: 'mandate://standards/security-baseline', rel: 'follows' }] : [], verifiedBy: [], implementedCommit: H },
      body: i % 2 ? 'short body' : `Long body ${i}. `.repeat(200),
    })),
    meta: { updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'Sofia', revisions: 3, lastCommit: H },
    verification: { own: [{ sectionId: 's0', last: { result: 'pass', method: 'test', at: '2026-11-10T00:00:00Z' } }], inherited: [], total: 8, verified: 1, failing: 0, stale: 0 },
    links: { sections: {}, warnings: [], supersededStandards: [] },
  };
}
function bigSearch(groups = 30) {
  return {
    query: 'tokens',
    mode: 'hybrid',
    groups: Array.from({ length: groups }, (_, g) => ({
      docUri: `mandate://specs/d${g}`,
      docTitle: `Doc ${g}`,
      docKind: 'spec',
      status: g % 2 ? 'ready' : 'done',
      score: 0.5,
      hits: Array.from({ length: 6 }, (_, h) => ({ uri: `mandate://specs/d${g}/sections/h${h}#L${h + 1}`, sectionTitle: `Hit ${h}`, snippet: `<mark>token</mark> ${'x'.repeat(300)}`, score: 0.1, lines: { start: 1, end: 2 } })),
    })),
    facets: { kinds: { section: 120, spec: 30 }, status: { ready: 15, done: 15 } },
    total: 180,
    nextCursor: 'MzA',
  };
}
const bigTable = (rows = 2000) => ({ columns: ['d.ref', 'n'], rows: Array.from({ length: rows }, (_, i) => [`mandate://specs/s${i}`, i]), truncated: false, at: H, elapsedMs: 3 });
const bigGraph = (n = 400) => ({
  root: 'mandate://standards/security-baseline',
  nodes: Array.from({ length: n }, (_, i) => ({ uri: `mandate://specs/s${i}`, ref: `mandate://specs/s${i}`, kind: i % 2 ? 'spec' : 'section', label: `Spec ${i}`, props: { status: 'ready', summary: 'z'.repeat(200), implementedCommit: H, path: 'specs/x.md' } })),
  edges: Array.from({ length: n }, (_, i) => ({ from: 'mandate://standards/security-baseline', to: `mandate://specs/s${i}`, kind: i % 3 ? 'uses_standard' : 'follows', props: {} })),
  nextCursor: null,
});
const bigList = (n = 500) => ({
  items: Array.from({ length: n }, (_, i) => ({ uri: `mandate://work-orders/q-${i}`, id: `q-${i}`, spec: `spec-${i % 7}`, specCommit: H, status: ['done', 'pending', 'failed'][i % 3], sections: [{ id: 'a', status: 'done' }], reason: [], createdAt: '2026', note: null })),
  total: 1200,
  nextCursor: '500',
});
const bigSection = () => ({
  docUri: 'mandate://specs/big',
  docTitle: 'Big spec',
  docStatus: 'ready',
  commit: null,
  section: { uri: 'mandate://specs/big/sections/s0', id: 's0', title: 'Section 0', type: 'markdown', lines: { start: 1, end: 900 }, meta: { links: [] }, body: Array.from({ length: 300 }, (_, i) => `Paragraph ${i}: ${'w'.repeat(200)}`).join('\n\n') },
});
const huge = () => ({ blob: 'q'.repeat(200_000) });

const CASES: [string, () => Record<string, any>, Record<string, any>][] = [
  ['spec_get', () => bigSpec(), {}],
  ['standard_get', () => bigSpec(), {}],
  ['spec_section_get', bigSection, {}],
  ['search', () => bigSearch(), { q: 'tokens' }],
  ['text_search', () => ({ matches: Array.from({ length: 900 }, (_, i) => ({ uri: `mandate://specs/s${i % 9}#L${i}`, docUri: `mandate://specs/s${i % 9}`, docTitle: `S${i % 9}`, line: i, text: 'y'.repeat(150) })), total: 900, nextCursor: 'NTA' }), { q: 'y' }],
  ['graph_query', () => bigTable(), { query: 'MATCH (n) RETURN n' }],
  ['graph_neighbors', () => bigGraph(), { uri: 'mandate://standards/security-baseline' }],
  ['graph_impact', () => ({ uri: 'mandate://standards/x', total: 600, groups: { section: bigGraph(300).nodes, spec: bigGraph(300).nodes } }), {}],
  ['work_order_list', () => bigList(), {}],
  ['activity_list', () => ({ events: Array.from({ length: 800 }, (_, i) => ({ id: `${H}:${i}`, commit: H, at: '2026', agent: 'a', type: 'commit', summary: 's'.repeat(120), details: { x: 'd'.repeat(500) } })), total: 800, nextCursor: '800' }), {}],
  ['doc_raw', huge, {}],
  ['unknown_tool', () => ({ a: Array.from({ length: 50 }, () => 'v'.repeat(500)) }), {}],
];

describe('compaction: noise', () => {
  it('drops null / empty values, ids duplicated by uri, line numbers, scores; shortens hashes; keeps uri and title', () => {
    expect(prune({ uri: 'mandate://specs/a#L3', id: 'a', ref: 'mandate://specs/a#L3', title: 'A', x: null, y: [], z: {}, s: '', lines: { start: 1 }, score: 0.3, commit: H, validationIssues: [], snippet: '<mark>t</mark>ok' })).toEqual({
      uri: 'mandate://specs/a',
      title: 'A',
      commit: 'aaaaaaa',
      snippet: 'tok',
    });
    expect(prune({ id: 'keep-me', title: 'no uri here' })).toEqual({ id: 'keep-me', title: 'no uri here' });
  });

  it('specs become an outline with short bodies inline, verification per criterion, and a pointer to section_get', () => {
    const t = modelResult('spec_get', bigSpec(6), {}, { maxTokens: 5000 }).text;
    expect(t).toContain('mandate://specs/big "Big spec"');
    expect(t).toContain('- s1 [markdown] "Section 1"');
    expect(t).toContain('short body');
    expect(t).not.toContain('Long body 0. Long body 0.');
    expect(t).toMatch(/body \d+ chars: spec_section_get/);
    expect(t).toContain('verification: pass (test 2026-11-10)');
    expect(t).toContain('follows→mandate://standards/security-baseline');
    expect(t).not.toContain(H);
  });

  it('graphs become ref -rel-> ref lines; search collapses to one line per hit without anchors', () => {
    const g = modelResult('graph_neighbors', bigGraph(3), {}, { maxTokens: 5000 }).text;
    expect(g).toContain('mandate://standards/security-baseline -follows-> mandate://specs/s0');
    expect(g).toContain('node mandate://specs/s1 "Spec 1" (spec, ready)');
    const s = modelResult('search', bigSearch(2), { q: 'tokens' }, { maxTokens: 5000 }).text;
    expect(s).toContain('mandate://specs/d0/sections/h0 "Hit 0": token');
    expect(s).not.toContain('#L');
    expect(s).not.toContain('<mark>');
    expect(s).toContain('(+3 more hits in this document)');
  });
});

describe('bounding', () => {
  for (const cap of [300, 2000, 5000]) {
    it(`never exceeds the cap (${cap} tokens) for any tool, cuts whole items and says so`, () => {
      for (const [name, make, args] of CASES) {
        const body = make();
        const r = modelResult(name, body, args, { maxTokens: cap });
        expect(r.tokens, `${name} @${cap}`).toBeLessThanOrEqual(cap);
        expect(estimateTokens(r.text), name).toBe(r.tokens);
        if (cap === 300) expect(r.truncated, name).toBe(true);
        if (!r.truncated) continue;
        const n = note(r.text);
        expect(n, `${name}: continuation note`).toBeTruthy();
        expect(r.text, name).toMatch(/Narrow (first|the query)/);
        // Whole items only: every shown item of the compacted list is complete.
        const c = toModel(name, body, args);
        const shownItems = c.items.slice(0, n!.shown);
        for (const it of shownItems) expect(r.text, `${name} item`).toContain(it);
      }
    });
  }

  it('keeps uri and title of every shown item', () => {
    const r = modelResult('work_order_list', bigList(), {}, { maxTokens: 1500 });
    const lines = r.text.split('\n').filter((l) => l.startsWith('{"uri"'));
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(JSON.parse(l).uri).toMatch(/^mandate:\/\/work-orders\/q-\d+$/);
    const d = modelResult('spec_get', bigSpec(), {}, { maxTokens: 600 }).text;
    expect(d.split('\n')[0]).toBe('mandate://specs/big "Big spec"');
  });

  it('builds a continuation cursor from the cut (numeric lists, base64 index tools) and the server cursor otherwise', () => {
    const list = note(modelResult('work_order_list', bigList(), { cursor: '100' }, { maxTokens: 1000 }).text)!;
    expect(list.next?.cursor).toBe(String(100 + list.shown));
    expect(list.total).toBe(1200);
    const s = note(modelResult('search', bigSearch(), { q: 'tokens' }, { maxTokens: 1000 }).text)!;
    expect(Buffer.from(s.next!.cursor, 'base64url').toString()).toBe(String(s.shown));
    // Nothing cut, but the server has more: its cursor.
    const small = { ...bigList(3), total: 1200, nextCursor: '3' };
    const n = note(modelResult('work_order_list', small, {}, { maxTokens: 5000 }).text)!;
    expect(n).toMatchObject({ shown: 3, total: 1200, next: { cursor: '3' } });
  });

  it('leads with narrowing suggestions taken from the data (facets, section ids, refs, statuses)', () => {
    const s = modelResult('search', bigSearch(), { q: 'tokens' }, { maxTokens: 800 }).text;
    const hint = s.slice(s.indexOf('Narrow first'));
    expect(hint).toContain('kinds: section(120), spec(30)');
    expect(hint).toContain('status: ready(15), done(15)');
    expect(hint).toContain('mandate://specs/d0');
    expect(hint.indexOf('Narrow first')).toBeLessThan(hint.indexOf('cursor'));
    const d = modelResult('spec_get', bigSpec(), {}, { maxTokens: 400 }).text;
    expect(d).toContain('call spec_section_get for the sections you need (long: s0, s2, s4');
    const t = modelResult('graph_query', bigTable(), {}, { maxTokens: 400 }).text;
    expect(t).toContain('add a WHERE clause, aggregate with count()');
    expect(note(t)).toMatchObject({ truncated: true, total: 2000, unit: 'rows' });
    const w = modelResult('work_order_list', bigList(), {}, { maxTokens: 400 }).text;
    expect(w).toMatch(/filter by status: (done|pending|failed)\(\d+\)/);
    const g = modelResult('graph_neighbors', bigGraph(), {}, { maxTokens: 400 }).text;
    expect(g).toContain('filter by relation (uses_standard, follows)');
  });

  it(`withholds the cursor after ${MAX_CONTINUATIONS} continuation calls and insists on narrowing`, () => {
    const c = toModel('work_order_list', bigList(), { cursor: '200' });
    const ok = bound('work_order_list', c, { maxTokens: 800, continuations: MAX_CONTINUATIONS - 1 }).text;
    expect(note(ok)!.next).toBeTruthy();
    const stop = bound('work_order_list', c, { maxTokens: 800, continuations: MAX_CONTINUATIONS }).text;
    expect(note(stop)!.next).toBeUndefined();
    expect(stop).toContain('Do not page further');
  });

  it('passes small results through untouched (no note)', () => {
    const r = modelResult('graph_query', bigTable(3), {}, { maxTokens: 5000 });
    expect(r.truncated).toBe(false);
    expect(r.text).not.toContain('truncated');
    expect(modelResult('spec_section_get', { error: { code: 'not_found', message: 'x' } }, {}, { maxTokens: 300 }).text).toContain('not_found');
  });
});
