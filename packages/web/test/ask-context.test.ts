import { describe, expect, it } from 'vitest';
import { buildRef } from '@mandate/shared/refs';
import { chipsFromLocation, dedupeChips } from '../src/components/ask/context';
import type { AskChip } from '../src/components/ask/types';

const SHA = 'a'.repeat(40);
const spec = (id: string): AskChip => ({ uri: buildRef({ kind: 'specs', id }), kind: 'spec', label: id });

describe('chipsFromLocation', () => {
  it('derives doc and section chips from the URL', () => {
    const chips = chipsFromLocation({ pathname: '/specs/login-sso', search: '?lines=5-9', hash: '#section-auth-flow' });
    expect(chips.map((c) => c.uri)).toEqual([
      buildRef({ kind: 'specs', id: 'login-sso' }),
      buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'auth-flow', lines: { start: 5, end: 9 } }),
    ]);
  });
  it('pins to the version being viewed', () => {
    const chips = chipsFromLocation({ pathname: '/standards/sec', search: `?version=${SHA}&view=version`, hash: '' });
    expect(chips[0]!.uri).toContain(`@${SHA}`);
  });
  it('uses a text selection (with quote) over the anchor', () => {
    const chips = chipsFromLocation({ pathname: '/specs/a', search: '', hash: '#section-x' }, { sectionId: 'y', text: 'hi' });
    expect(chips[1]).toMatchObject({ kind: 'section', quote: 'hi' });
    expect(chips[1]!.uri).toContain('/sections/y');
  });
  it('covers work orders and feedback; lists have none', () => {
    expect(chipsFromLocation({ pathname: '/work-orders/q-0001', search: '', hash: '' })[0]!.kind).toBe('work_order');
    expect(chipsFromLocation({ pathname: '/feedback/f-1', search: '', hash: '' })[0]!.kind).toBe('feedback');
    expect(chipsFromLocation({ pathname: '/specs', search: '', hash: '' })).toEqual([]);
  });
});

describe('dedupeChips', () => {
  it('collapses equal references (also with a mention prefix) and merges quotes', () => {
    const a = spec('a');
    const out = dedupeChips([a, { ...a, uri: `@mandate:${a.uri}`, quote: 'q1' }, { ...a, quote: 'q2' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.quote).toBe('q1\nq2');
  });
});
