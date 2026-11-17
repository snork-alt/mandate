/** Human decisions: decisions_list, decision_access, the UI allow-list of write tools (uiAllowed), integrity_snooze. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DECISION_KINDS } from '@mandate/shared';
import { callTool, UI_AGENT, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { memorySettings } from '../../src/projects/settings.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const base = () => ({ storage: fx.storage, index: fx.index, reads: fx.reads, activity: fx.activity }) as unknown as ToolContext;
const uiCtx = (uiAccess: 'read' | 'write', mode: 'me' | 'team' = 'team', login = 'ada') =>
  ({ ...base(), settings: memorySettings(), clientName: 'mandate-web', principal: { kind: 'ui', user: { login, avatarUrl: '' } }, access: 'read', uiAccess }) as ToolContext;
const body = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;

describe('decisions_list', () => {
  it('lists pending human decisions with a question, options and kinds; counts match', async () => {
    const r = await fx.call('decisions_list', {});
    expect(r.isError).toBe(false);
    const { items, total, counts } = r.body;
    expect(total).toBe(items.length);
    expect(Object.keys(counts).sort()).toEqual([...DECISION_KINDS].sort());
    for (const d of items) {
      expect(DECISION_KINDS).toContain(d.kind);
      expect(d.ref).toMatch(/^mandate:\/\//);
      expect(d.question.length).toBeGreaterThan(10);
      expect(d.question.length).toBeLessThan(400);
      expect(d.options.length).toBeGreaterThanOrEqual(2);
      if (d.suggested) expect(d.options.map((o: any) => o.id)).toContain(d.suggested);
    }
    // Priority order: kinds in DECISION_KINDS order.
    const order = items.map((d: any) => DECISION_KINDS.indexOf(d.kind));
    expect(order).toEqual([...order].sort((a: number, b: number) => a - b));
    // Requests need no decision: open requests are not decisions.
    expect(Object.keys(counts)).not.toContain('feedback_open');
  });

  it('filters by kinds, caps with limit, strict input', async () => {
    const all = await fx.call('decisions_list', {});
    const k = (DECISION_KINDS.find((x) => all.body.counts[x] > 0) ?? 'question') as string;
    const r = await fx.call('decisions_list', { kinds: [k], limit: 1 });
    expect(r.body.items.length).toBeLessThanOrEqual(1);
    expect(r.body.items.every((d: any) => d.kind === k)).toBe(true);
    expect(r.body.total).toBe(all.body.counts[k]);
    expect((await fx.call('decisions_list', { kinds: ['nope'] })).isError).toBe(true);
    expect((await fx.call('decisions_list', { extra: 1 })).isError).toBe(true);
  });
});

describe('UI allow-list (uiAllowed)', () => {
  it('only the human-decision tools are uiAllowed, and they are write tools', () => {
    const allowed = TOOLS.filter((t) => t.uiAllowed).map((t) => t.name).sort();
    // Human decisions, requests filed from the UI (create / assign / approve a plan), plus comments (a person comments from the UI; routing wakes the agents).
    expect(allowed).toEqual(['audit_request', 'comment_add', 'comment_reopen', 'comment_resolve', 'feedback_close', 'feedback_create', 'integrity_snooze', 'question_answer', 'request_assign', 'request_close', 'request_create', 'request_plan_approve', 'section_accept', 'section_link_ack', 'work_order_release']);
    for (const n of allowed) expect(tool(n).kind).toBe('write');
  });

  it('every other write tool is refused for the UI session, even with write access', async () => {
    const writes = TOOLS.filter((t) => t.kind === 'write' && !t.uiAllowed && !t.uiOnly);
    expect(writes.length).toBeGreaterThan(20);
    for (const t of writes) {
      const r = await callTool(t, {}, uiCtx('write'));
      const e = body(r).error;
      // Strict inputs may fail validation first; nothing may run.
      expect(['forbidden', 'validation', 'invalid_input'], t.name).toContain(e?.code);
      if (e.code === 'forbidden') expect(e.message).toMatch(/read-only/);
    }
    const head = await fx.git.head();
    expect(head).toBe(await fx.git.head());
  });

  it('allowed tools need the user\'s own write access', async () => {
    const r = await callTool(tool('request_close'), { ref: 'fb-0001', resolution: 'rejected', resolutionNote: 'x' }, uiCtx('read'));
    expect(body(r).error).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/write \(push\) permission/) });
  });

  it('reject / duplicate from the UI: commit attributed to the signed-in user via mandate-ui, activity emitted', async () => {
    const spec = (await fx.storage.specs.list()).find((s) => s.status !== 'archived' && s.sections.length)!;
    const target = `mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`;
    const a = (await fx.call('request_create', { targets: [target], kind: 'bug', body: 'A', agent: 't' })).body.ref as string;
    const b = (await fx.call('request_create', { targets: [target], kind: 'question', body: 'B', agent: 't' })).body.ref as string;
    const seen: string[] = [];
    const off = fx.activity.subscribe?.((e: any) => seen.push(e.type));
    const r1 = await callTool(tool('request_close'), { ref: a, resolution: 'rejected', resolutionNote: 'no', agent: 'spoofed-agent' }, uiCtx('write'));
    expect(r1.isError).toBeFalsy();
    const info = await fx.git.commitInfo((await fx.git.head())!);
    expect(info.message).toMatch(new RegExp(`Agent: ${UI_AGENT}`));
    expect(info.message).toMatch(/Mandate-User: ada/);
    expect(info.message).not.toMatch(/spoofed-agent/);
    expect((await fx.storage.feedback.get(a.split('/').pop()!)).status).toBe('closed');
    // "applied" is the agents' (content changed); the UI may reject or mark duplicate.
    const applied = await callTool(tool('request_close'), { ref: b, resolution: 'applied' }, uiCtx('write'));
    expect(body(applied).error.code).toBe('forbidden');
    const rej = await callTool(tool('request_close'), { ref: b, resolution: 'rejected', resolutionNote: 'out of scope' }, uiCtx('write'));
    expect(rej.isError).toBeFalsy();
    expect((await fx.storage.feedback.get(b.split('/').pop()!)).resolution).toBe('rejected');
    if (typeof off === 'function') off();
  });

  it('recorded as mandate-ui by the signed-in user', async () => {
    const spec = (await fx.storage.specs.list()).find((s) => s.status !== 'archived' && s.sections.length)!;
    const ref = (await fx.call('request_create', { targets: [`mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`], kind: 'bug', body: 'L', agent: 't' })).body.ref as string;
    const r = await callTool(tool('request_close'), { ref, resolution: 'rejected', resolutionNote: 'no' }, uiCtx('write', 'team', 'ada'));
    expect(r.isError).toBeFalsy();
    const info = await fx.git.commitInfo((await fx.git.head())!);
    expect(info.message).toMatch(/Agent: mandate-ui/);
    expect(info.message).toMatch(/^Mandate-User: ada$/m);
  });

  it('decision_access: who may record decisions', async () => {
    const notAdmin = { ...uiCtx('write'), settings: { ...memorySettings(), isAdmin: () => false } } as ToolContext;
    const access = body(await callTool(tool('decision_access'), {}, notAdmin));
    expect(access).toMatchObject({ canDecide: true, user: 'ada' });
    expect(access.override).toBeUndefined();
  });

  it('release: only a STALE claim, from the UI', async () => {
    const wos = await fx.storage.workOrderService.list();
    const pending = wos.find((w) => w.status === 'pending' && !w.claim && (w.hasPlan || w.fastPath));
    expect(pending).toBeTruthy();
    if (!pending) return;
    await fx.call('work_order_claim', { ref: pending.id, agent: 'busy-agent' });
    const fresh = await callTool(tool('work_order_release'), { ref: pending.id }, uiCtx('write'));
    expect(body(fresh).error.code).toBe('claim_fresh');
    // Make it stale (no heartbeat for an hour) and release it from the UI.
    // An hour later without a heartbeat: the claim is stale.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    let r;
    try {
      r = await callTool(tool('work_order_release'), { ref: pending.id }, uiCtx('write'));
    } finally {
      vi.useRealTimers();
    }
    expect(r.isError).toBeFalsy();
    expect((await fx.storage.workOrderService.get(pending.id)).claim).toBeUndefined();
    expect((await fx.git.commitInfo((await fx.git.head())!)).message).toMatch(/release stale claim of busy-agent/);
  });

  it('an all-sections-done work order with a stale claim is no stale_claim decision and cannot be released from the UI', async () => {
    const sid = `dec-${Date.now().toString(36)}`;
    await fx.call('spec_create', { id: sid, title: 'Decision spec', summary: 's', agent: 't', sections: [{ id: 'one', title: 'One', summary: 'o', body: 'o' }] });
    const created = await fx.call('work_order_create', { spec: sid, sections: ['one'], kind: 'implement', plan: { tasks: [{ text: 'p', sections: ['one'] }] }, agent: 't' });
    const wo = { id: (created.body.ref as string).split('/').pop()! };
    await fx.call('work_order_claim', { ref: wo.id, agent: 'busy-agent' });
    const secs = ['one'];
    await fx.call('work_order_section_done', { ref: wo.id, agent: 'busy-agent', sections: secs });
    const after = await fx.storage.workOrderService.get(wo.id);
    expect(after.claim).toBeUndefined(); // auto-released
    // An old, already-stale claim on a finished work order (as before auto-release existed).
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await fx.storage.workOrderDocs.modify(wo.id, (d) => ({ ...d, claim: { agent: 'busy-agent', startedAt: old } }), { agent: 'busy-agent' });
    fx.storage.heartbeats.set(wo.id, 'busy-agent', old);
    const list = await fx.call('decisions_list', { kinds: ['stale_claim'], limit: 200 });
    expect(list.body.items.some((d: any) => d.ref.endsWith(wo.id))).toBe(false);
    const r = await callTool(tool('work_order_release'), { ref: wo.id }, uiCtx('write'));
    expect(body(r).error.code).toBe('all_done');
  });
});

describe('integrity_snooze', () => {
  it('warnings only; hidden from the overview count until it expires', async () => {
    const report = await fx.storage.integrity.current();
    const warn = report.issues.find((i) => (i.severity ?? 'warning') === 'warning');
    const err = report.issues.find((i) => i.severity === 'error');
    if (err) {
      const r = await callTool(tool('integrity_snooze'), { rule: err.rule, uri: err.uri, days: 3, note: 'n' }, uiCtx('write'));
      expect(body(r).error.code).toBe('not_snoozable');
    }
    expect(body(await callTool(tool('integrity_snooze'), { rule: 'nope', uri: 'mandate://specs/x', days: 3, note: 'n' }, uiCtx('write'))).error.code).toBe('not_found');
    expect((await fx.call('integrity_snooze', { rule: 'x', uri: 'mandate://specs/x', days: 0, note: 'n', agent: 't' })).isError).toBe(true);
    if (!warn) return;
    const before = (await fx.call('project_overview', {})).body.attention;
    const r = await callTool(tool('integrity_snooze'), { rule: warn.rule, uri: warn.uri, days: 7, note: 'known gap' }, uiCtx('write'));
    expect(r.isError).toBeFalsy();
    expect(body(r).snooze).toMatchObject({ rule: warn.rule, uri: warn.uri, by: 'ada', note: 'known gap' });
    const after = (await fx.call('project_overview', {})).body.attention;
    expect(after.integrityWarnings).toBe(before.integrityWarnings - 1);
    expect(after.integritySnoozed).toBe(before.integritySnoozed + 1);
    // Expiry: active() at a time past `until` no longer hides it.
    const later = Date.now() + 8 * 86_400_000;
    expect((await fx.storage.integritySnoozes.active(later)).has(`${warn.rule}|${warn.uri}`)).toBe(false);
    expect((await fx.storage.integritySnoozes.active()).has(`${warn.rule}|${warn.uri}`)).toBe(true);
  });
});
