/**
 * Tool sets and merged tools (src/mcp/tool-sets.ts): a small default list (core), tools_enable + list_changed, the
 * `?tools=` URL parameter, calls of tools outside the listed sets, and the per-type names as hidden aliases of the
 * merged tools (same validation, errors and results).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_TOOLS, listedTools, TOOLS } from '../../src/mcp/server.js';
import { ALIASES, DEFAULT_SETS, MERGED, parseToolSets, SET_NAMES, TOOL_SETS } from '../../src/mcp/tool-sets.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let woId: string;
beforeAll(async () => {
  fx = await mcpFixture();
  woId = (await fx.storage.workOrderService.list())[0]!.id;
}, 120_000);
afterAll(async () => fx?.close());

/** A result body without the per-call news notice. */
const strip = ({ news: _n, ...b }: Record<string, any>) => b;
const names = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).tools.map((t) => t.name);

describe('sets', () => {
  it('the default list is core (the whole request flow) and has at most 52 tools', async () => {
    const listed = await names(fx.client);
    expect(listed.length).toBeLessThanOrEqual(52);
    expect(listed.sort()).toEqual([...TOOL_SETS.core].sort());
    expect(DEFAULT_SETS).toEqual(['core']);
  });

  it('every agent tool is in a set, every set member is an agent tool, aliases are never listed', () => {
    const agent = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const s of SET_NAMES) for (const n of TOOL_SETS[s]) expect(agent.has(n), `${s}: ${n}`).toBe(true);
    const inSome = new Set(Object.values(TOOL_SETS).flat());
    expect(AGENT_TOOLS.filter((t) => !inSome.has(t.name)).map((t) => t.name)).toEqual([]);
    for (const old of Object.keys(ALIASES)) expect(agent.has(old), old).toBe(false);
    expect(listedTools(parseToolSets('all').sets).length).toBe(AGENT_TOOLS.length);
  });

  it('?tools= on the MCP URL lists those sets from the start (all = every agent tool; unknown names ignored)', async () => {
    const boot = await connect(new URL(`${fx.url.href}?tools=bootstrap,nope`));
    const listed = await names(boot);
    expect(listed).toEqual(expect.arrayContaining([...TOOL_SETS.core, ...TOOL_SETS.bootstrap]));
    expect(listed).not.toContain('audit_plan');
    await boot.close();
    const all = await connect(new URL(`${fx.url.href}?tools=all`));
    expect((await names(all)).length).toBe(AGENT_TOOLS.length);
    await all.close();
  });

  it('tools_enable adds sets for the session and sends notifications/tools/list_changed', async () => {
    const c = await connect(fx.url, 'sets-client');
    let changed = 0;
    c.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    // The request flow (create, section_insert, request_create, work_order_create, ...) is listed by default.
    expect(await names(c)).toEqual(expect.arrayContaining(['create', 'section_insert', 'request_create', 'request_close', 'work_order_create']));
    expect(await names(c)).not.toContain('audit_plan');
    const r = await c.callTool({ name: 'tools_enable', arguments: { sets: ['review'] } });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as { enabled: string[]; added: string[] };
    expect(body.enabled).toEqual(['core', 'review']);
    expect(body.added).toEqual(expect.arrayContaining(['audit_plan', 'question_answer']));
    expect(changed).toBe(1);
    expect(await names(c)).toEqual(expect.arrayContaining(['audit_plan', ...TOOL_SETS.core]));
    // Nothing new: no notification. Other sessions keep their own list. The old intake set adds nothing.
    await c.callTool({ name: 'tools_enable', arguments: { sets: ['intake'] } });
    expect(changed).toBe(1);
    expect(await names(fx.client)).not.toContain('audit_plan');
    const bad = await c.callTool({ name: 'tools_enable', arguments: { sets: ['bogus'] } });
    expect(bad.isError).toBe(true);
    await c.close();
  });

  it('a tool outside the listed sets is still callable by name', async () => {
    expect(await names(fx.client)).not.toContain('graph_schema');
    const r = await fx.call('graph_schema', {});
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
  });
});

describe('merged tools and hidden aliases', () => {
  const same = async (alias: string, aArgs: Record<string, unknown>, merged: string, mArgs: Record<string, unknown>) => {
    const a = await fx.call(alias, aArgs);
    const m = await fx.call(merged, mArgs);
    expect(a.isError, JSON.stringify(a.body)).toBe(m.isError);
    expect(strip(m.body)).toEqual(strip(a.body));
    return m;
  };

  it('every per-type name maps to a merged tool and stays registered', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const [old, merged] of Object.entries(ALIASES)) {
      expect(all.has(old), old).toBe(true);
      // The old feedback names alias the request tools (merged get / list, or the request_* write tools).
      expect(MERGED.some((m) => m.name === merged) || all.has(merged)).toBe(true);
    }
    expect(Object.keys(ALIASES)).toHaveLength(56);
    expect(ALIASES.feedback_create).toBe('request_create');
  });

  it('get: documents, sections, work orders, requests, audits (auditId) and questions as the per-type tools', async () => {
    const m = await same('spec_get', { ref: 'login-sso', metadataOnly: true }, 'get', { of: 'specs', ref: 'login-sso', metadataOnly: true });
    expect(m.isError).toBe(false);
    await same('spec_get', { ref: 'mandate://specs/login-sso' }, 'get', { ref: 'mandate://specs/login-sso' });
    await same('standard_section_get', { doc: 'security-baseline', section: 'rules' }, 'get', { of: 'standards', doc: 'security-baseline', section: 'rules' });
    await same('spec_section_get', { ref: 'mandate://specs/login-sso/sections/auth-flow' }, 'get', { ref: 'mandate://specs/login-sso/sections/auth-flow' });
    await same('component_get', { ref: 'auth-service' }, 'get', { of: 'component', ref: 'auth-service' });
    await same('work_order_get', { ref: woId }, 'get', { of: 'work-orders', ref: woId });
    await same('work_order_section_get', { ref: `mandate://work-orders/${woId}/sections/plan` }, 'get', { ref: `mandate://work-orders/${woId}/sections/plan` });
    await same('audit_get', { auditId: 'mandate://audits/2026-11-12-login-sso' }, 'get', { ref: 'mandate://audits/2026-11-12-login-sso' });
    const q = await fx.call('question_ask', { agent: 'asker', purpose: 'decision', questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A', multiSelect: false }] });
    expect(q.isError, JSON.stringify(q.body)).toBe(false);
    const qid = q.body.question?.id ?? q.body.id;
    await same('question_get', { id: qid }, 'get', { ref: `mandate://questions/${qid}` });
    await same('question_get', { id: qid }, 'get', { of: 'questions', ref: qid });
    const fb = (await fx.storage.feedback.list())[0]!.id;
    await same('feedback_get', { ref: fb }, 'get', { ref: `mandate://requests/${fb}` });
    await same('request_get', { ref: fb }, 'get', { of: 'feedback', ref: fb }); // the old of still routes
  });

  it('list: every type with its own filters', async () => {
    await same('spec_list', { status: ['ready'] }, 'list', { of: 'specs', status: ['ready'] });
    await same('standard_list', {}, 'list', { of: 'standards' });
    await same('work_order_list', { status: ['pending'] }, 'list', { of: 'work-orders', status: ['pending'] });
    await same('comments_list', { target: `mandate://work-orders/${woId}` }, 'list', { of: 'comments', target: `mandate://work-orders/${woId}` });
    await same('audit_list', {}, 'list', { of: 'audits' });
  });

  it('validation errors are the per-type tool errors', async () => {
    const r = await same('spec_get', { ref: 'login-sso', bogus: 1 }, 'get', { of: 'specs', ref: 'login-sso', bogus: 1 });
    expect(r.body.error.code).toBe('invalid_input');
    expect(r.body.error.message).toContain('bogus');
    await same('spec_list', { status: 'nope' }, 'list', { of: 'specs', status: 'nope' });
    // The ref picks the type: a section ref of another kind fails as before.
    await same('spec_status_set', { agent: 't', ref: 'mandate://specs/login-sso', status: 'in_progress' }, 'status_set', { agent: 't', ref: 'mandate://specs/login-sso', status: 'in_progress' });
  });

  it('routing errors are structured (missing of, unknown of, mismatch, no tool for the type)', async () => {
    const code = async (name: string, args: Record<string, unknown>) => (await fx.call(name, args)).body.error;
    expect(await code('get', { ref: 'login-sso' })).toMatchObject({ code: 'invalid_input', path: 'of' });
    expect(await code('list', {})).toMatchObject({ code: 'invalid_input', path: 'of' });
    expect(await code('list', { of: 'bananas' })).toMatchObject({ code: 'invalid_input', path: 'of' });
    expect(await code('get', { of: 'standards', ref: 'mandate://specs/login-sso' })).toMatchObject({ code: 'invalid_input', path: 'of' });
    const std = await code('archive', { agent: 't', ref: 'mandate://standards/security-baseline' });
    expect(std).toMatchObject({ code: 'invalid_input' });
    expect(std.hint).toContain('status_set');
  });

  it('writes: a merged call and its alias write the same way (create, section_insert, section_update)', async () => {
    const a = await fx.call('spec_create', { agent: 't', title: 'Alias spec' });
    const m = await fx.call('create', { agent: 't', of: 'specs', title: 'Merged spec' });
    expect(a.isError || m.isError, JSON.stringify([a.body, m.body])).toBe(false);
    expect(Object.keys(strip(m.body)).sort()).toEqual(Object.keys(strip(a.body)).sort());
    expect(m.body.ref).toMatch(/^mandate:\/\/specs\//);
    const ins = await fx.call('section_insert', { agent: 't', doc: m.body.ref, section: { title: 'Overview', body: 'Some text.' } });
    expect(ins.isError, JSON.stringify(ins.body)).toBe(false);
    const up = await fx.call('section_update', { agent: 't', ref: ins.body.ref, summary: 'One line.' });
    expect(up.isError, JSON.stringify(up.body)).toBe(false);
    expect(up.body.section.summary).toBe('One line.');
    const mv = await fx.call('spec_section_move', { agent: 't', ref: ins.body.ref, position: 'first' });
    expect(mv.isError, JSON.stringify(mv.body)).toBe(false);
    const ar = await fx.call('archive', { agent: 't', ref: ins.body.ref });
    expect(ar.isError, JSON.stringify(ar.body)).toBe(false);
    expect(ar.body.section.archived).toBe(true);
  });
});
