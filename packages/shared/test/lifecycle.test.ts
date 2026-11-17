/** The lifecycle registry is complete and self-consistent (server enforcement is checked in server/test/mcp/lifecycle.test.ts). */
import { describe, expect, it } from 'vitest';
import { ERROR_ACTIONS, gateSummary, LIFECYCLE, LIFECYCLE_KINDS, lifecycleGetInputSchema, lifecycleView } from '../src/index.js';

describe('lifecycle registry', () => {
  it('has an entry for every object kind', () => {
    expect(Object.keys(LIFECYCLE).sort()).toEqual([...LIFECYCLE_KINDS].sort());
    for (const k of ['spec', 'spec_section', 'standard', 'standard_section', 'component', 'work_order', 'work_order_section', 'request', 'verification', 'comment', 'audit', 'audit_finding', 'flow_policy', 'maturity']) {
      expect(LIFECYCLE_KINDS, k).toContain(k);
    }
  });

  it.each(LIFECYCLE_KINDS)('%s is consistent', (kind) => {
    const e = LIFECYCLE[kind];
    const v = lifecycleView(kind);
    expect(e.kind).toBe(kind);
    const states = new Set(e.states);
    if (e.initial) expect(states.has(e.initial)).toBe(true);
    for (const s of [...e.terminal, ...e.frozen, ...e.derived]) expect(states.has(s), s).toBe(true);
    for (const [from, tos] of Object.entries(e.table)) {
      expect(states.has(from), from).toBe(true);
      for (const to of tos) expect(states.has(to), to).toBe(true);
    }
    for (const t of e.terminal) expect(e.table[t] ?? [], `terminal ${t}`).toEqual([]);
    for (const s of v.steps) {
      expect(states.has(s.to), s.to).toBe(true);
      expect(s.when.length, `${kind} -> ${s.to}: when`).toBeGreaterThan(5);
      // A narrower `from` must stay inside the table.
      for (const f of s.from) expect(e.table[f] ?? [], `${f} -> ${s.to}`).toContain(s.to);
      for (const c of s.errors ?? []) expect(ERROR_ACTIONS[c], c).toBeTruthy();
    }
    for (const c of e.create?.errors ?? []) expect(ERROR_ACTIONS[c], c).toBeTruthy();
    if (kind === 'maturity') expect(e.derived).toEqual([...e.states]);
  });

  it('summarizes the gates of a status tool in one line', () => {
    // status_set serves specs, standards and components: each transition names its kind.
    const s = gateSummary('status_set');
    expect(s).toContain('spec ready -> done (DONE GATE');
    expect(s).toContain('standard active -> deprecated');
    expect(s).toContain('lifecycle_get { kind }');
    expect(gateSummary('request_close')).toContain('lifecycle_get { kind: "request" }');
    expect(s).not.toContain('\n');
    expect(gateSummary('search')).toBe('');
  });

  it('lifecycle_get input: optional known kind, nothing else', () => {
    expect(lifecycleGetInputSchema.parse({})).toEqual({});
    expect(lifecycleGetInputSchema.parse({ kind: 'request' })).toEqual({ kind: 'request' });
    expect(lifecycleGetInputSchema.parse({ kind: 'feedback' })).toEqual({ kind: 'request' }); // the old name
    expect(lifecycleGetInputSchema.safeParse({ kind: 'x' }).success).toBe(false);
    expect(lifecycleGetInputSchema.safeParse({ kind: 'spec', more: 1 }).success).toBe(false);
  });
});
