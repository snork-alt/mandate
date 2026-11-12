import { describe, expect, it } from 'vitest';
import { checkLinks, diffDocs, findCycle, parseLinkTarget } from '../src/index.js';
import { fmt } from './fixtures.js';

const doc = (links: string) => `---
title: T
status: draft
sections:
  - id: a
    title: A
    type: markdown
    links: ${links}
---

<!-- @section a -->
## A

x
`;

describe('section links', () => {
  it('parses, round-trips and rejects duplicate (to, rel)', () => {
    const md = doc('[{to: "mandate://specs/other/sections/b", rel: depends_on, note: needs tokens}]');
    expect(fmt.parse(md).sections[0]!.links).toEqual([{ to: 'mandate://specs/other/sections/b', rel: 'depends_on', note: 'needs tokens' }]);
    expect(fmt.serialize(fmt.parse(md))).toContain('links: [{to: mandate://specs/other/sections/b, rel: depends_on, note: needs tokens}]');
    expect(fmt.validate(doc('[{to: "mandate://specs/o/sections/b", rel: extends}, {to: "mandate://specs/o/sections/b", rel: extends}]')).issues[0]!.message).toMatch(/duplicate link/);
    // One relation per target: contradictory pairs are duplicates too.
    expect(checkLinks('specs', 'me', [{ id: 'a', links: [{ to: 'mandate://standards/o/sections/b', rel: 'follows' }, { to: 'mandate://standards/o/sections/b', rel: 'deviates_from', note: 'x' }] }])[0]).toMatch(/only one link per target/);
    expect(checkLinks('specs', 'me', [{ id: 'a', links: [{ to: 'mandate://specs/o', rel: 'extends' }] }])[0]).toMatch(/whole document/);
    expect(fmt.validate(doc('[{to: "mandate://specs/o/sections/b", rel: blocks}]')).ok).toBe(false); // unknown rel
  });

  it('enforces direction, other-document targets and per-direction rels', () => {
    const s = (to: string, rel = 'extends', note?: string) => [{ id: 'a', links: [{ to, rel: rel as 'extends', ...(note ? { note } : {}) }] }];
    expect(checkLinks('specs', 'me', s('mandate://specs/other/sections/x', 'depends_on'))).toEqual([]);
    expect(checkLinks('specs', 'me', s('mandate://specs/me/sections/x'))[0]).toMatch(/another document/);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec/sections/x', 'follows'))).toEqual([]);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec/sections/x', 'depends_on'))[0]).toMatch(/follows, deviates_from or relates_to/);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec/sections/x', 'deviates_from'))[0]).toMatch(/needs a note/);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec/sections/x', 'deviates_from', 'legacy client'))).toEqual([]);
    expect(checkLinks('specs', 'me', s('mandate://specs/o/sections/x', 'follows'))[0]).toMatch(/not allowed/);
    // Whole standards: spec sections may follow / deviate from / relate to them; nothing else may.
    expect(checkLinks('specs', 'me', s('mandate://standards/sec', 'follows'))).toEqual([]);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec', 'deviates_from', 'why'))).toEqual([]);
    expect(checkLinks('specs', 'me', s('mandate://standards/sec', 'depends_on'))[0]).toMatch(/whole document/);
    expect(checkLinks('standards', 'x', s('mandate://standards/sec', 'extends'))[0]).toMatch(/whole document/);
    expect(checkLinks('standards', 'sec', s('mandate://specs/x/sections/y'))[0]).toMatch(/standards never link to specs/);
    expect(checkLinks('standards', 'sec', s('mandate://standards/api/sections/y', 'depends_on'))[0]).toMatch(/cannot depend on each other/);
  });

  it('parses section and whole-standard targets', () => {
    expect(parseLinkTarget('mandate://standards/sec')).toEqual({ kind: 'standards', id: 'sec' });
    expect(parseLinkTarget('mandate://standards/sec/sections/a')).toEqual({ kind: 'standards', id: 'sec', sectionId: 'a' });
    expect(parseLinkTarget('nope')).toBeNull();
  });

  it('round-trips archived sections and waiver fields', () => {
    const md = doc('[{to: "mandate://standards/s/sections/b", rel: deviates_from, note: why, feedback: fb-1, pin: abc, by: giulia}]').replace('    type: markdown\n', '    type: markdown\n    archived: true\n');
    const d = fmt.parse(md);
    expect(d.sections[0]).toMatchObject({ archived: true, links: [{ feedback: 'fb-1', pin: 'abc', by: 'giulia' }] });
    expect(fmt.parse(fmt.serialize(d))).toEqual(d);
  });

  it('finds depends_on cycles', () => {
    expect(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toBeNull();
    expect(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a', 'b', 'c', 'a']);
  });

  it('marks added and removed links in diffs', () => {
    const d = diffDocs(fmt, doc('[{to: "mandate://specs/o/sections/b", rel: extends}]'), doc('[{to: "mandate://specs/o/sections/c", rel: extends}]'));
    expect(d.sections[0]!.meta[0]).toMatchObject({ key: 'links', addedItems: [{ to: 'mandate://specs/o/sections/c', rel: 'extends' }], removedItems: [{ to: 'mandate://specs/o/sections/b', rel: 'extends' }] });
  });
});
