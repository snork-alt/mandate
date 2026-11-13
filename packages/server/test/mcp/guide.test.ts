/**
 * The agent working agreement: skill / instructions text (real tool names, the standards rule), the one MCP prompt
 * (mandate-flow), project_info / project_flow_set (defaults, validation, permissions, activity), spec_match, and the
 * standards confirmation note + User-Confirmed trailer.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer, INSTRUCTIONS, TOOLS } from '../../src/mcp/server.js';
import { CORE_RULES, FLOW_COMMAND, SKILL_BODY } from '../../src/mcp/guide.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { STANDARD_CONFIRMATION } from '../../src/mcp/tools/write.js';
import { coverage, terms } from '../../src/mcp/tools/match.js';
import { memorySettings, projectSettings } from '../../src/projects/settings.js';
import { ProjectsStore } from '../../src/projects/store.js';
import { mcpFixture, type McpFixture } from './fixture.js';

const byName = new Map(TOOLS.map((t) => [t.name, t]));

describe('working agreement text', () => {
  it('only mentions real tool names', () => {
    const texts = [CORE_RULES, SKILL_BODY, INSTRUCTIONS, FLOW_COMMAND.render('on')];
    const mentioned = new Set(texts.flatMap((t) => [...t.matchAll(/`?\b([a-z]+(?:_[a-z]+)+)\b`?/g)].map((m) => m[1]!)).filter((n) => /^(spec|standard|component|work_order|feedback|verification|project|graph|rule|rules|search|symbol|code|text|architecture)_/.test(n) || n === 'rules_for_code'));
    const unknown = [...mentioned].filter((n) => !byName.has(n) && !['spec_section', 'standard_section', 'flow_enabled', 'code_deviates', 'spec_wrong', 'standard_confirmation'].includes(n));
    expect(unknown).toEqual([]);
    for (const n of ['project_info', 'spec_match', 'feedback_create', 'work_order_create', 'feedback_close', 'verification_record', 'work_order_complete', 'standard_section_insert']) expect(mentioned.has(n), n).toBe(true);
  });

  it('states the standards hard rule in the skill and the instructions', () => {
    for (const t of [SKILL_BODY, INSTRUCTIONS]) {
      expect(t).toMatch(/standard_\*/);
      expect(t).toMatch(/question tool/);
      expect(t).toMatch(/even (when\s+the approval checkpoint\s+is off|with approval off)/);
      expect(t).toContain('confirmedByUser');
    }
    expect(SKILL_BODY).toMatchSnapshot();
  });

  it('keeps plans in the work order and covers delivery, comments and git context', () => {
    for (const t of [SKILL_BODY, INSTRUCTIONS]) {
      expect(t).toContain('work_order_plan_set');
      expect(t).toMatch(/plans\/`?, `?PLAN\.md`?, `?docs\/plans\//);
      expect(t).toMatch(/flow (is )?off/i);
      for (const n of ['work_order_touch', 'work_order_git_update', 'comments_list', 'comment_add', 'comment_resolve', 'outcome', 'blocking']) expect(t, n).toContain(n);
    }
    for (const n of ['comment_add', 'comment_resolve', 'comment_reopen', 'comments_list', 'work_order_touch_from_commits']) {
      if (SKILL_BODY.includes(n)) expect(byName.has(n), n).toBe(true);
    }
    expect(SKILL_BODY).toContain('## Audits');
  });

  it('mirrors the flow switch in the instructions', () => {
    expect(INSTRUCTIONS).toContain('START: project_info; follow effective { flow, approval, questions }');
    expect(INSTRUCTIONS).toMatch(/flow off = read context only/);
    expect(INSTRUCTIONS).toMatch(/approval off = do not wait at APPROVAL/);
    // The questions setting branches in one phrase.
    for (const t of [INSTRUCTIONS, SKILL_BODY]) expect(t).toMatch(/questions`? chat/);
  });
});

describe('the mandate-flow MCP prompt', () => {
  it('is listed (with mandate-bootstrap), and renders the setting', async () => {
    const server = createMcpServer({} as ToolContext);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(b);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(['mandate-flow', 'mandate-bootstrap']);
    const r = await c.getPrompt({ name: 'mandate-flow', arguments: { setting: 'approval off' } });
    const text = (r.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Argument: "approval off"');
    expect(text).toContain('flow_set');
    await expect(c.getPrompt({ name: 'implement' })).rejects.toThrow(/no prompt/);
    await c.close();
  });
});

describe('standard writes', () => {
  it('every standard_* write tool asks for confirmation and accepts confirmedByUser', () => {
    const std = TOOLS.filter((t) => t.name.startsWith('standard_') && t.kind === 'write');
    expect(std.length).toBeGreaterThanOrEqual(9);
    for (const t of std) {
      expect(t.description as string, t.name).toContain('Needs the user\'s confirmation, even with approval off: cite an answered standard_confirmation question');
      expect(t.input.safeParse({ confirmedByUser: 'yes' }).success, t.name).toBe(false);
    }
    for (const t of TOOLS.filter((x) => !x.name.startsWith('standard_'))) expect(typeof t.description === 'string' ? t.description : '', t.name).not.toContain(STANDARD_CONFIRMATION.trim());
  });
});

describe('MCP tools on seeded data', () => {
  let fx: McpFixture;
  beforeAll(async () => {
    fx = await mcpFixture({ settings: memorySettings() });
  }, 120_000);
  afterAll(() => fx.close());

  it('spec_match: validation and ranked candidates with reasons and graph context', async () => {
    expect((await fx.call('spec_match', { request: 'x' })).isError).toBe(true);
    expect((await fx.call('spec_match', { request: 'single sign on', limit: 50 })).isError).toBe(true);
    expect((await fx.call('spec_match', { request: 'single sign on', bogus: true })).isError).toBe(true);
    const r = await fx.call('spec_match', { request: 'Let users sign in with SSO through their identity provider', limit: 3 });
    expect(r.isError).toBe(false);
    const c = r.body.candidates;
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(3);
    expect(c[0].spec.ref).toMatch(/^mandate:\/\/specs\//);
    expect(c[0].fit).toBeGreaterThan(0);
    expect(c[0].fit).toBeLessThanOrEqual(1);
    expect(c[0].reasons[0]).toMatch(/covers \d+\/\d+ request terms/);
    expect(c.map((x: { spec: { ref: string } }) => x.spec.ref)).toContain('mandate://specs/login-sso');
    for (const x of c) for (let i = 1; i < c.length; i++) expect(c[i - 1].fit).toBeGreaterThanOrEqual(c[i].fit);
    expect(['extend_section', 'new_section', 'new_spec']).toContain(r.body.suggestion.decision);
    const none = await fx.call('spec_match', { request: 'quantum entanglement telescope calibration' });
    expect(none.body.suggestion.decision).toBe('new_spec');
  });

  it('standard writes need confirmation proof with the flow on; confirmedByUser only when questions go to chat', async () => {
    const std = await fx.call('standard_get', { ref: 'mandate://standards/api-conventions' });
    const sec = (std.body.sections ?? std.body.standard?.sections ?? []).find((s: { type: string }) => s.type === 'rule') ?? (std.body.sections ?? std.body.standard?.sections)[0];
    const ref = `mandate://standards/api-conventions/sections/${sec.id}`;
    const r = await fx.call('standard_section_update', { ref, summary: 'Flag alone is not enough with questions via Mandate.', confirmedByUser: true, agent: 'tester' });
    expect(r.body.error.code).toBe('confirmation_required');
    expect(r.body.error.hint).toContain('question_ask purpose standard_confirmation');
    const none = await fx.call('standard_section_update', { ref, summary: 'No confirmation at all is refused too.', agent: 'tester' });
    expect(none.body.error.code).toBe('confirmation_required');
  });

  it('inferred drafts need no confirmation (bootstrap); a confirmed section, activation or a non-inferred create still do', async () => {
    const rule = (title: string, provenance: 'inferred' | 'confirmed' = 'inferred') => ({ title, type: 'rule', level: 'must', rationale: 'Consistency.', body: `${title}.`, provenance, confidence: 0.9 });
    const c = await fx.call('standard_create', { title: 'Inferred draft standard', sections: [rule('Keys are kebab case')], agent: 'tester' });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const ref = c.body.ref as string;
    expect(c.body.document.status).toBe('draft');
    const ins = await fx.call('standard_section_insert', { doc: ref, section: rule('Ids are slugs'), agent: 'tester' });
    expect(ins.isError, JSON.stringify(ins.body)).toBe(false);
    const upd = await fx.call('standard_section_update', { ref: ins.body.ref, summary: 'Still inferred.', agent: 'tester' });
    expect(upd.isError, JSON.stringify(upd.body)).toBe(false);
    expect((await fx.call('standard_section_insert', { doc: ref, section: rule('Confirmed rule', 'confirmed'), agent: 'tester' })).body.error.code).toBe('confirmation_required');
    expect((await fx.call('standard_section_update', { ref: ins.body.ref, provenance: 'confirmed', agent: 'tester' })).body.error.code).toBe('confirmation_required');
    expect((await fx.call('standard_status_set', { ref, status: 'active', agent: 'tester' })).body.error.code).toBe('confirmation_required');
    expect((await fx.call('standard_create', { title: 'Unmarked standard', sections: [{ title: 'No provenance', type: 'rule', level: 'must', rationale: 'Consistency.', body: 'x.' }], agent: 'tester' })).body.error.code).toBe('confirmation_required');
    expect((await fx.call('standard_create', { title: 'Empty standard', agent: 'tester' })).body.error.code).toBe('confirmation_required');
  });

  it('records User-Confirmed: yes on standard writes with confirmedByUser (questions in chat)', async () => {
    expect((await fx.call('flow_set', { questions: 'chat', agent: 'tester' })).isError).toBe(false);
    const std = await fx.call('standard_get', { ref: 'mandate://standards/api-conventions' });
    const sec = (std.body.sections ?? std.body.standard?.sections ?? []).find((s: { type: string }) => s.type === 'rule') ?? (std.body.sections ?? std.body.standard?.sections)[0];
    const ref = `mandate://standards/api-conventions/sections/${sec.id}`;
    const ok = await fx.call('standard_section_update', { ref, summary: 'Confirmed summary edit for the audit trailer test.', confirmedByUser: true, agent: 'tester' });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    expect(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: fx.dir, encoding: 'utf8' })).toContain('User-Confirmed: yes');
    const plain = await fx.call('standard_section_update', { ref, summary: 'Unconfirmed summary edit, refused even in chat mode.', agent: 'tester' });
    expect(plain.body.error.code).toBe('confirmation_required');
    await fx.call('flow_set', { questions: 'mandate', agent: 'tester' });
  });
});

describe('no override past a gate (local mode too)', () => {
  let fx: McpFixture;
  beforeAll(async () => {
    fx = await mcpFixture({ settings: memorySettings() });
  }, 120_000);
  afterAll(() => fx.close());

  it('C1: an intake request is filed before spec_match without targets; edits that address it link it (no mismatch warning)', async () => {
    const fb = await fx.call('feedback_create', { kind: 'improvement', body: 'Add remember-me to login.', agent: 't' });
    expect(fb.isError, JSON.stringify(fb.body)).toBe(false);
    expect((await fx.call('feedback_create', { kind: 'question', body: 'Which IdPs?', agent: 't' })).isError).toBe(true);
    const m = await fx.call('spec_match', { request: 'Add remember-me to login' });
    expect(m.body.candidates.length).toBeGreaterThan(0);
    const spec = (await fx.storage.specs.list()).find((x) => x.status === 'draft' && x.sections.length) ?? (await fx.storage.specs.list()).find((x) => x.sections.length)!;
    const ed = await fx.call('spec_section_update', { ref: `mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`, summary: 'Remember-me keeps the session for 30 days.', addresses: [fb.body.ref], agent: 't' });
    expect(ed.isError, JSON.stringify(ed.body)).toBe(false);
    expect(JSON.stringify(ed.body.warnings)).not.toContain('feedback_target_mismatch');
    const up = await fx.call('feedback_update', { ref: fb.body.ref, targets: [`mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`], agent: 't' });
    expect(up.isError, JSON.stringify(up.body)).toBe(false);
  });

  it('spec_status_set done has no override / force input, and done_gate holds in local mode', async () => {
    const spec = (await fx.storage.specs.list()).find((x) => x.status === 'ready')!;
    for (const extra of [{ override: true, overrideReason: 'sole user' }, { force: true }]) {
      const r = await fx.call('spec_status_set', { ref: `mandate://specs/${spec.id}`, status: 'done', agent: 't', ...extra });
      expect(r.body.error.code).toBe('invalid_input');
    }
    const r = await fx.call('spec_status_set', { ref: `mandate://specs/${spec.id}`, status: 'done', agent: 't' });
    expect(r.body.error.code).toBe('done_gate');
    expect(r.body.error.hint).toMatch(/never force it \(no override passes it\)/);
  });
});

describe('match helpers', () => {
  it('extracts terms and coverage', () => {
    expect(terms('Please add Remember-me tokens to the login page')).toEqual(['remember-me', 'token', 'login', 'page']);
    expect(coverage(['token', 'login'], 'Login sessions use tokens').share).toBe(1);
  });
});
