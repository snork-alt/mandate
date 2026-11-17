/**
 * The lifecycle registry vs the server: the enforced tables ARE the registry's tables (and the storage layer uses
 * them), every registry tool exists, every status tool carries its gate summary, every error code the server can
 * return has a recommended action (scanned from the source, so a new code fails here), errors carry a hint, and
 * lifecycle_get validates its input.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_TRANSITIONS,
  COMPONENT_TRANSITIONS,
  ERROR_ACTIONS,
  FEEDBACK_TRANSITIONS,
  FINDING_TRANSITIONS,
  gateSummary,
  LIFECYCLE,
  LIFECYCLE_KINDS,
  lifecycleView,
  SPEC_TRANSITIONS,
  STANDARD_TRANSITIONS,
  WORK_ORDER_TRANSITIONS,
} from '@mandate/shared';
import { TOOLS } from '../../src/mcp/server.js';
import { WRITE_CODE_MAP } from '../../src/mcp/errors.js';
import { mcpFixture, type McpFixture } from './fixture.js';

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');
const byName = new Map(TOOLS.map((t) => [t.name, t]));

describe('registry ↔ enforcement', () => {
  /** Each enforced table, the registry kind that serves it, and the storage modules that check it. */
  const ENFORCED = [
    { kind: 'spec', table: SPEC_TRANSITIONS, name: 'SPEC_TRANSITIONS', files: ['storage/doc-rules.ts'] },
    { kind: 'standard', table: STANDARD_TRANSITIONS, name: 'STANDARD_TRANSITIONS', files: ['storage/doc-rules.ts'] },
    { kind: 'component', table: COMPONENT_TRANSITIONS, name: 'COMPONENT_TRANSITIONS', files: ['storage/doc-rules.ts'] },
    { kind: 'work_order', table: WORK_ORDER_TRANSITIONS, name: 'WORK_ORDER_TRANSITIONS', files: ['storage/work-orders.ts'] },
    { kind: 'request', table: FEEDBACK_TRANSITIONS, name: 'FEEDBACK_TRANSITIONS', files: ['storage/feedback.ts'] },
    { kind: 'audit', table: AUDIT_TRANSITIONS, name: 'AUDIT_TRANSITIONS', files: ['storage/audits.ts'] },
    { kind: 'audit_finding', table: FINDING_TRANSITIONS, name: 'FINDING_TRANSITIONS', files: ['storage/audits.ts'] },
  ] as const;

  it.each(ENFORCED)('$kind: the registry serves the enforced table, which storage checks', ({ kind, table, name, files }) => {
    expect(LIFECYCLE[kind].table).toBe(table);
    expect(LIFECYCLE[kind].enforced).toBe(true);
    for (const f of files) expect(read(f), `${f} uses ${name}`).toMatch(new RegExp(`\\b${name}\\[`));
  });

  it.each(ENFORCED)('$kind: every allowed transition has a step and every step is allowed', ({ kind, table }) => {
    const v = lifecycleView(kind);
    const allowed = Object.entries(table as Record<string, readonly string[]>).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)).sort();
    const described = v.steps.flatMap((s) => s.from.map((f) => `${f}->${s.to}`));
    // Steps may name a narrower source set (release: in_progress -> pending); the union still covers the table.
    expect([...new Set(described)].sort()).toEqual(allowed.filter((t) => described.includes(t)));
    expect(allowed.filter((t) => !described.includes(t)), 'transitions without a step').toEqual(
      // failed -> pending (only via an update, no agent tool) is allowed by the table but not offered to agents.
      kind === 'work_order' ? ['failed->pending'] : [],
    );
  });

  it('every tool the registry names exists', () => {
    const tools = LIFECYCLE_KINDS.flatMap((k) => [...LIFECYCLE[k].steps.flatMap((s) => s.tools), ...(LIFECYCLE[k].create?.tools ?? [])]);
    expect(tools.filter((t) => !byName.has(t))).toEqual([]);
  });

  it('every status-changing tool carries its gate summary (UI-only tools excepted)', () => {
    const tools = new Set(LIFECYCLE_KINDS.flatMap((k) => LIFECYCLE[k].steps.flatMap((s) => s.tools)));
    for (const t of tools) {
      const def = byName.get(t)!;
      if (def.uiOnly) continue;
      expect(def.description, t).toContain(gateSummary(t));
      expect(gateSummary(t)).toContain('lifecycle_get');
    }
  });
});

describe('error playbook', () => {
  /** Every literal error code thrown or returned in the MCP layer, storage and project settings. */
  function sourceCodes(): Set<string> {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['mcp', 'storage', 'projects']) walk(path.join(SRC, d));
    const codes = new Set<string>();
    const patterns = [/new [A-Z]\w*Error\(\s*'([a-z_]+)'/g, /\bcode: '([a-z_]+)'/g, /readonly code = '([a-z_]+)'/g, /\bcode: '[a-z_]+' \| '([a-z_]+)'/g, /`([a-z_]+): \$\{def\.name\}/g];
    for (const f of files) for (const re of patterns) for (const m of readFileSync(f, 'utf8').matchAll(re)) codes.add(m[1]!);
    return codes;
  }

  it('maps every server error code (after normalization) to an action', () => {
    const codes = sourceCodes();
    expect(codes.size).toBeGreaterThan(30);
    // Codes refined by toWriteError, and read-side "missing" codes that normalize to not_found.
    for (const c of ['transition_not_allowed', 'claim_conflict', 'cycle', 'superseded_target', 'missing_cause']) codes.add(c);
    const NORMALIZED: Record<string, string> = { ...WRITE_CODE_MAP, unknown_commit: 'not_found', unknown_node: 'not_found' };
    const missing = [...codes].filter((c) => !ERROR_ACTIONS[c] && !ERROR_ACTIONS[NORMALIZED[c] ?? '']);
    expect(missing).toEqual([]);
  });

  it('every error code a registry step names has an action', () => {
    const named = LIFECYCLE_KINDS.flatMap((k) => [...LIFECYCLE[k].steps.flatMap((s) => s.errors ?? []), ...(LIFECYCLE[k].create?.errors ?? [])]);
    expect(named.filter((c) => !ERROR_ACTIONS[c])).toEqual([]);
  });
});

describe('over MCP', () => {
  let fx: McpFixture;
  beforeAll(async () => {
    fx = await mcpFixture();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('lifecycle_get returns one kind or the whole registry, and validates kind', async () => {
    const one = await fx.call('lifecycle_get', { kind: 'spec' });
    expect(one.isError).toBe(false);
    expect(one.body.derived).toEqual(['in_progress']);
    expect(one.body.steps.find((s: { to: string }) => s.to === 'done').from).toEqual(['active']);
    expect(one.body.errorActions.done_gate).toBe(ERROR_ACTIONS.done_gate);
    // enforcedBy (server internals) is not returned to agents.
    expect(JSON.stringify(one.body)).not.toContain('enforcedBy');
    // Without kind: the kind list and the error actions only (not every kind in full).
    const all = await fx.call('lifecycle_get', {});
    expect(all.body.kinds).toEqual([...LIFECYCLE_KINDS, 'integrity']);
    expect(all.body.errorActions).toEqual(ERROR_ACTIONS);
    expect(JSON.stringify(all.body).length).toBeLessThan(12_000);
    const integrity = await fx.call('lifecycle_get', { kind: 'integrity' });
    expect(integrity.body.integrityRules.length).toBeGreaterThan(10);
    expect(JSON.stringify(integrity.body)).not.toContain('enforcedBy');
    for (const bad of [{ kind: 'nope' }, { kind: 'spec', extra: 1 }]) {
      const r = await fx.call('lifecycle_get', bad);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('invalid_input');
      expect(r.body.error.hint).toBeTruthy();
    }
  });

  it('a refused transition carries the registry hint', async () => {
    const id = `lc-${Date.now().toString(36)}`;
    const created = await fx.call('spec_create', { agent: 'lc@test', id, title: `Spec ${id}` });
    expect(created.isError).toBe(false);
    await fx.call('spec_status_set', { agent: 'lc@test', ref: id, status: 'archived' });
    const r = await fx.call('spec_status_set', { agent: 'lc@test', ref: id, status: 'done' });
    expect(r.body.error.code).toBe('transition_not_allowed');
    expect(r.body.error.hint).toBe(ERROR_ACTIONS.transition_not_allowed);
  });
});
