import { describe, expect, it } from 'vitest';
import { matchesEvents } from '../src/lib/liveQueries';

describe('integrity.changed refreshes the integrity count and gaps', () => {
  const ev = [{ type: 'integrity.changed', refs: ['mandate://components/billing'] }] as never;
  it('invalidates git status, spec and component lists and pages', () => {
    expect(matchesEvents(['git', 'status'], ev)).toBe(true);
    expect(matchesEvents(['components'], ev)).toBe(true);
    expect(matchesEvents(['components', 'other'], ev)).toBe(true);
    expect(matchesEvents(['specs', 'login'], ev)).toBe(true);
    expect(matchesEvents(['feedback'], ev)).toBe(false);
  });
});
