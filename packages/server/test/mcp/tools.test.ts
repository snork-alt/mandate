/** MCP tools: listing, a happy path per tool, invalid inputs per tool, structured errors. */
import { SKILL_BODY } from '../../src/mcp/guide.js';
import { STUB_VERSION } from '../../src/mcp/stubs.js';
import { auditTools } from '../../src/mcp/tools/audits.js';
import http from 'node:http';
import { writeTools } from '../../src/mcp/tools/write.js';
import { workOrderDocTools } from '../../src/mcp/tools/work-orders.js';
import { lineageTools } from '../../src/mcp/tools/lineage.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { questionTools } from '../../src/mcp/tools/questions.js';
import { AGENT_TOOLS, UI_ONLY_TOOL_NAMES, TOOLS } from '../../src/mcp/index.js';
import { listedTools } from '../../src/mcp/server.js';
import { DEFAULT_SETS, MERGED } from '../../src/mcp/tool-sets.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let woId: string;
let fbId: string;

beforeAll(async () => {
  fx = await mcpFixture();
  woId = (await fx.storage.workOrderService.list())[0]!.id;
  fbId = (await fx.storage.feedback.list())[0]!.id;
}, 120_000);
afterAll(async () => fx?.close());

const short = () => fx.older.slice(0, 7);

/** One valid call per tool, with a check of the result shape. */
/** Write tools have their own suite (write-tools.test.ts: happy paths, error codes, schema checks). */
// project_flow_set is a write tool covered by test/mcp/guide.test.ts; upload_url_create by test/mcp/uploads.test.ts.
// Audit write tools: test/mcp/audits.test.ts. Work-order document and comment write tools: test/mcp/work-orders.test.ts.
// The flow and news tools need project settings: covered by test/mcp/flow.test.ts and news.test.ts. Questions (and question_get): questions.test.ts.
// Merged tools and tools_enable: test/mcp/tool-sets.test.ts.
const WRITE_SUITE = new Set([...MERGED.map((m) => m.name), 'tools_enable', ...writeTools.map((t) => t.name), 'project_flow_set', 'flow_next', 'request_decision_add', 'request_assign', 'request_plan_approve', 'flow_edit_allowed', 'flow_set', 'flow_policy_set', 'flow_clients_list', 'news_list', 'news_ack', 'ask_post', 'ask_get', 'ask_cancel', 'ask_pending', 'ask_answer', 'upload_url_create', 'integrity_snooze', 'feedback_get', 'feedback_list', ...auditTools.filter((t) => t.kind === 'write').map((t) => t.name), ...workOrderDocTools.filter((t) => t.kind === 'write').map((t) => t.name), ...lineageTools.filter((t) => t.kind === 'write').map((t) => t.name), ...questionTools.filter((t) => t.kind === 'write' || t.name === 'question_get').map((t) => t.name)]);
const READ_TOOLS = TOOLS.filter((t) => !WRITE_SUITE.has(t.name));
const HAPPY: Record<string, { args: () => Record<string, unknown>; check: (b: Record<string, any>) => void }> = {
  // (the security-baseline rule "rotating refresh tokens" competes for the top spot since standards have rule sections)
  search: { args: () => ({ q: 'refresh token rotation', limit: 3 }), check: (b) => expect(b.groups.map((g: any) => g.docUri)).toContain('mandate://specs/user-sessions') },
  text_search: { args: () => ({ q: 'PKCE' }), check: (b) => expect(b.matches.length).toBeGreaterThan(0) },
  symbol_search: { args: () => ({ name: 'authservce', match: 'fuzzy' }), check: (b) => expect(b.symbols.map((s: any) => s.name)).toContain('AuthService.login') },
  code_search: { args: () => ({ repo: 'app', path: 'src/auth/session.ts', lines: '30-35' }), check: (b) => expect(b.refs.length).toBeGreaterThan(0) },
  // Rules tools (storage owner): rules for a file, automated checks of a spec.
  rules_for_code: { args: () => ({ repo: 'app', path: 'src/auth/session.ts', lines: '30-35' }), check: (b) => expect(b.rules.length).toBeGreaterThan(0) },
  // Components and architecture.
  component_list: { args: () => ({ kind: ['service'] }), check: (b) => expect(b.items.map((c: any) => c.id)).toContain('auth-service') },
  component_get: { args: () => ({ ref: 'auth-service' }), check: (b) => expect(b.derived.dependsOn).toContain('postgres') },
  component_section_get: { args: () => ({ ref: 'mandate://components/auth-service/sections/sessions-api' }), check: (b) => expect(b.section.meta.links[0].rel).toBe('depends_on') },
  architecture_get: { args: () => ({ focus: 'auth-service', format: 'mermaid' }), check: (b) => (expect(b.edges.some((e: any) => e.from === 'auth-service' && e.to === 'postgres')).toBe(true), expect(b.mermaid).toContain('flowchart')) },
  // The most specific glob wins: session-store (contained in auth-service) owns src/auth/session.ts.
  code_owner: { args: () => ({ repo: 'app', path: 'src/auth/session.ts' }), check: (b) => expect(b.owner.id).toBe('session-store') },
  rule_check_plan: { args: () => ({ spec: 'mandate://specs/login-sso' }), check: (b) => expect(b.checks.length).toBeGreaterThan(0) },
  related: { args: () => ({ uri: 'mandate://specs/user-sessions/sections/overview', limit: 3 }), check: (b) => expect(b.items.length).toBeGreaterThan(0) },
  metadata_query: { args: () => ({ kinds: ['spec'], status: ['draft', 'ready', 'done'] }), check: (b) => expect(b.items.length).toBeGreaterThan(0) },
  history_search: { args: () => ({ q: 'feedback', limit: 5 }), check: (b) => expect(b.commits.length).toBeGreaterThan(0) },
  graph_search: { args: () => ({ q: 'session store' }), check: (b) => expect(JSON.stringify(b)).toContain('mandate://') },
  graph_node: { args: () => ({ uri: `@mandate:mandate://specs/login-sso@${short()}/sections/auth-flow` }), check: (b) => expect(b.node.kind).toBe('version') },
  graph_neighbors: { args: () => ({ uri: 'mandate://specs/login-sso', depth: 2, limit: 20 }), check: (b) => expect(JSON.stringify(b)).toContain('mandate://specs/login-sso/sections/') },
  graph_path: {
    args: () => ({ from: 'mandate://specs/login-sso/sections/callback', to: 'mandate://standards/security-baseline' }),
    check: (b) => expect(JSON.stringify(b)).toContain('security-baseline'),
  },
  graph_impact: { args: () => ({ uri: 'mandate://standards/security-baseline' }), check: (b) => expect(JSON.stringify(b)).toContain('mandate://specs/') },
  lineage: { args: () => ({ ref: 'mandate://specs/login-sso', depth: 2 }), check: (b) => expect(b.nodes.some((n: any) => n.layer > 0)).toBe(true) },
  blast_radius: { args: () => ({ ref: 'mandate://standards/security-baseline' }), check: (b) => expect(b.followers.length).toBeGreaterThan(0) },
  standard_where_used: { args: () => ({ ref: 'mandate://standards/security-baseline' }), check: (b) => expect(b.coverage).toBeTypeOf('object') },
  code_rules: { args: () => ({ ref: 'mandate://code/app/src/auth/session.ts' }), check: (b) => expect(Array.isArray(b.follows)).toBe(true) },
  writers_recent: { args: () => ({ limit: 50 }), check: (b) => expect(b.scanned).toBeGreaterThan(0) },
  contributors: { args: () => ({ refs: ['mandate://specs/login-sso'] }), check: (b) => expect(Array.isArray(b.contributors['mandate://specs/login-sso'])).toBe(true) },
  users_resolve: { args: () => ({ logins: ['octocat'] }), check: (b) => expect(b.users[0].avatarUrl).toContain('octocat') },
  graph_history: { args: () => ({ uri: 'mandate://specs/login-sso' }), check: (b) => expect(b.events.length).toBeGreaterThan(0) },
  graph_changes: { args: () => ({ from: short(), within: 'mandate://specs/login-sso' }), check: (b) => expect(b).toBeTypeOf('object') },
  graph_evolution: { args: () => ({ uri: 'mandate://specs/login-sso' }), check: (b) => expect(JSON.stringify(b)).toContain('has_section') },
  graph_query: {
    args: () => ({ query: 'MATCH (d:Spec)-[:HAS_SECTION]->(s:Section) WHERE d.ref = $ref RETURN s.ref ORDER BY s.ref', params: { ref: '@mandate:mandate://specs/login-sso' } }),
    check: (b) => {
      expect(b.columns).toEqual(['s.ref']);
      expect(b.rows.flat()).toContain('mandate://specs/login-sso/sections/auth-flow');
    },
  },
  graph_schema: { args: () => ({}), check: (b) => expect(b.labels.map((l: any) => l.label)).toContain('Spec') },
  graph_batch: {
    args: () => ({ ops: [{ op: 'graphNode', args: { uri: 'mandate://specs/login-sso' } }, { op: 'graphNode', args: { uri: 'mandate://specs/nope-nope' } }] }),
    check: (b) => {
      expect(b.result[0].ok).toBe(true);
      expect(b.result[1]).toMatchObject({ ok: false, error: { code: 'not_found', detail: { kind: 'node' } } });
    },
  },
  spec_list: {
    args: () => ({ status: ['draft', 'ready', 'done'], limit: 200 }),
    check: (b) => {
      expect(b.items.length).toBeGreaterThan(0);
      expect(b.items.every((s: any) => ['draft', 'ready', 'done'].includes(s.status))).toBe(true);
    },
  },
  spec_get: {
    args: () => ({ ref: 'login-sso', metadataOnly: true }),
    check: (b) => {
      expect(b.frontmatter.title).toBeTruthy();
      expect(b.sections[0].body).toBeUndefined();
      expect(b.sections[0].lines.start).toBeGreaterThan(0);
    },
  },
  spec_section_get: {
    args: () => ({ ref: `mandate://specs/login-sso@${short()}/sections/auth-flow#L1-L3` }),
    check: (b) => {
      expect(b.commit).toBe(fx.older);
      expect(b.section.id).toBe('auth-flow');
      expect(b.excerpt.text.split('\n')).toHaveLength(3);
    },
  },
  standard_list: { args: () => ({}), check: (b) => expect(b.items.map((s: any) => s.id)).toContain('security-baseline') },
  standard_get: { args: () => ({ ref: 'mandate://standards/security-baseline' }), check: (b) => expect(b.verification.criteria).toBeDefined() },
  standard_section_get: { args: () => ({ doc: 'security-baseline', section: 'rules' }), check: (b) => expect(b.section.body.length).toBeGreaterThan(0) },
  work_order_list: { args: () => ({ limit: 5 }), check: (b) => expect(b.items.length).toBeGreaterThan(0) },
  work_order_get: { args: () => ({ ref: `mandate://work-orders/${woId}` }), check: (b) => expect(b.item.id).toBe(woId) },
  work_order_section_get: { args: () => ({ ref: `mandate://work-orders/${woId}/sections/plan` }), check: (b) => expect(b.section).toMatchObject({ id: 'plan', type: 'markdown' }) },
  comments_list: { args: () => ({ target: `mandate://work-orders/${woId}` }), check: (b) => expect(b).toMatchObject({ counts: expect.any(Object), threads: expect.any(Array) }) },
  request_list: { args: () => ({ status: ['closed'] }), check: (b) => expect(b.items.every((f: any) => f.status === 'closed')).toBe(true) },
  request_get: { args: () => ({ ref: fbId }), check: (b) => expect(b.request.id).toBe(fbId) },
  verification_list: {
    args: () => ({ spec: 'user-sessions' }),
    check: (b) => {
      expect(b.items.length).toBeGreaterThan(0);
      expect(b.criteria.map((c: any) => c.sectionId)).toContain('ac-refresh-rotates');
    },
  },
  history_get: { args: () => ({ ref: 'mandate://specs/login-sso', limit: 3 }), check: (b) => expect(b.entries).toHaveLength(3) },
  // (section-level history is covered in 'history_get on a section' below)
  diff_get: { args: () => ({ ref: 'mandate://specs/login-sso', from: short() }), check: (b) => expect(['modified', 'unchanged']).toContain(b.status) },
  index_status: { args: () => ({}), check: (b) => expect(b.upToDate).toBe(true) },
  embedding_jobs: { args: () => ({ status: ['failed'], limit: 5 }), check: (b) => expect(b.items).toEqual([]) },
  embedding_jobs_retry: { args: () => ({ contentHashes: ['0000'] }), check: (b) => expect(b).toEqual({ retried: 0 }) },
  git_status: { args: () => ({}), check: (b) => expect(b).toHaveProperty('branch') },
  git_pull: { args: () => ({}), check: (b) => expect(b.pulled).toBe(false) },
  git_push: { args: () => ({}), check: (b) => expect(['no_remote', 'disabled']).toContain(b.state) },
  activity_list: { args: () => ({ ref: 'mandate://specs/login-sso', limit: 5 }), check: (b) => expect(b.events.length).toBeGreaterThan(0) },
  activity_subscribe: { args: () => ({ types: ['spec.*'] }), check: (b) => expect(b).toMatchObject({ subscribed: true, filter: { types: ['spec.*'] } }) },
  doc_list: { args: () => ({ kind: 'specs' }), check: (b) => expect(b.items.find((x: any) => x.id === 'login-sso')).toMatchObject({ title: expect.any(String), updatedAt: expect.any(String), verification: expect.any(Object) }) },
  doc_get: { args: () => ({ kind: 'specs', id: 'login-sso' }), check: (b) => expect(b).toMatchObject({ id: 'login-sso', sections: expect.any(Array), verification: expect.any(Object), links: expect.any(Object) }) },
  version_get: { args: () => ({ kind: 'specs', id: 'login-sso', commit: fx.older.slice(0, 7), against: 'head' }), check: (b) => expect(b.commit).toBe(fx.older) },
  doc_raw: { args: () => ({ kind: 'standards', id: 'security-baseline' }), check: (b) => expect(b.text).toContain('<!-- @section') },
  standard_usage: { args: () => ({ id: 'security-baseline' }), check: (b) => expect(b.items.length).toBeGreaterThan(0) },
  spec_implementation: { args: () => ({ id: 'user-sessions' }), check: (b) => expect(b.sections).toBeTypeOf('object') },
  doc_feedback: { args: () => ({ kind: 'specs', id: 'login-sso' }), check: (b) => expect(b).toMatchObject({ items: expect.any(Array), openBySection: expect.any(Object) }) },
  section_types: { args: () => ({}), check: (b) => expect(b.items.map((t: any) => t.id)).toContain('markdown') },
  decisions_list: { args: () => ({ limit: 5 }), check: (b) => expect(Array.isArray(b.items)).toBe(true) },
  decision_access: { args: () => ({}), check: (b) => expect(typeof b.canDecide).toBe('boolean') },
  project_overview: { args: () => ({ limit: 5 }), check: (b) => expect(b.maturity.total).toBeGreaterThan(0) },
  git_log: { args: () => ({ limit: 3 }), check: (b) => expect(b.items).toHaveLength(3) },
  agents_presence: { args: () => ({ ref: 'mandate://specs/login-sso/sections/auth-flow' }), check: (b) => expect(b).toMatchObject({ agents: expect.any(Array), needsPicker: expect.any(Boolean) }) },
  instructions_get: { args: () => ({ name: 'core', stubVersion: 0 }), check: (b) => expect(b).toMatchObject({ name: 'core', text: SKILL_BODY, stubVersion: STUB_VERSION, update: expect.stringContaining('re-run the Mandate installer') }) },
  lifecycle_get: { args: () => ({ kind: 'request' }), check: (b) => expect(b.steps.map((s: any) => s.to)).toEqual(['closed']) },
  project_info: { args: () => ({}), check: (b) => expect(b.effective).toEqual({ flow: 'on', questions: 'mandate' }) },
  code_context_set: { args: () => ({ repo: 'app', commit: 'ABC1234', dirty: true }), check: (b) => expect(b.label).toBe('app@abc1234+dirty') },
  questions_list: { args: () => ({ status: 'all', limit: 5 }), check: (b) => expect(b.total).toBeTypeOf('number') },
  audit_plan: { args: () => ({ target: 'mandate://specs/login-sso' }), check: (b) => expect(b.items.length).toBeGreaterThan(3) },
  audit_get: { args: () => ({ auditId: 'mandate://audits/2026-11-12-login-sso' }), check: (b) => expect(b.audit.outcome).toBe('fail') },
  audit_section_get: { args: () => ({ ref: 'mandate://audits/2026-11-12-login-sso/sections/overview' }), check: (b) => expect(b.section.body.length).toBeGreaterThan(20) },
  audit_list: { args: () => ({ limit: 10 }), check: (b) => expect(b.audits.length).toBeGreaterThanOrEqual(2) },
  audit_findings: { args: () => ({ status: ['open'] }), check: (b) => expect(b.findings.length).toBeGreaterThan(0) },
  audit_overview: { args: () => ({}), check: (b) => expect(b.specs['user-sessions']).toMatchObject({ result: 'pass' }) },
  spec_match: { args: () => ({ request: 'single sign-on login with an identity provider', limit: 3 }), check: (b) => expect(b.candidates.length).toBeGreaterThan(0) },
};

describe('tools/list', () => {
  it('lists every tool with a description and an object JSON Schema', async () => {
    // The default list is the core set; ?tools=all lists every agent tool (tool-sets.ts).
    expect((await fx.client.listTools()).tools.map((t) => t.name).sort()).toEqual(listedTools(new Set(DEFAULT_SETS)).map((t) => t.name).sort());
    const all = await connect(new URL(`${fx.url.href}?tools=all`));
    const { tools } = await all.listTools();
    await all.close();
    // Agent sessions are not served the UI / ops tools (uiOnly, deprecated, web-UI views).
    expect(tools.map((t) => t.name).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    for (const n of UI_ONLY_TOOL_NAMES) expect(tools.some((t) => t.name === n), n).toBe(false);
    expect(tools.some((t) => TOOLS.find((x) => x.name === t.name)?.uiOnly)).toBe(false);
    expect(UI_ONLY_TOOL_NAMES.size).toBe(16);
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.annotations?.readOnlyHint !== undefined, t.name).toBe(true);
    }
    // graph_query embeds the live label / relationship names and one example; graph_schema has the detail.
    const gq = tools.find((t) => t.name === 'graph_query')!;
    expect(gq.description).toContain('Labels: ');
    expect(gq.description).toContain('graph_path');
    expect(gq.description).toContain('graph_schema');
    expect(gq.description).toContain('MATCH (');
  });

  it('every tool has a happy-path case', () => {
    expect(Object.keys(HAPPY).sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
  });

  it('server info carries the instructions', () => {
    expect(fx.client.getServerVersion()?.name).toBe('mandate');
    expect(fx.client.getInstructions()).toContain('Refs are the keys');
  });
});

describe('happy path', () => {
  for (const [name, c] of Object.entries(HAPPY)) {
    it(name, async () => {
      const r = await fx.call(name, c.args());
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      c.check(r.body);
    });
  }
});

describe('invalid input', () => {
  const expectError = async (name: string, args: unknown, code: string, path?: string) => {
    const r = await fx.call(name, args);
    expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(r.body.error.code).toBe(code);
    expect(typeof r.body.error.message).toBe('string');
    expect(r.body.error).toHaveProperty('path');
    if (path !== undefined) expect(r.body.error.path).toBe(path);
    return r.body.error;
  };

  for (const t of READ_TOOLS) {
    it(`${t.name}: unknown key`, async () => {
      const err = await expectError(t.name, { ...HAPPY[t.name]!.args(), bogus: 1 }, 'invalid_input');
      expect(err.message).toContain('bogus');
    });
    it(`${t.name}: wrong type`, async () => {
      const args = HAPPY[t.name]!.args();
      const key = Object.keys(args)[0];
      if (!key) return; // no-argument tools: only unknown keys can be wrong
      const v = args[key];
      const wrong = typeof v === 'string' ? true : typeof v === 'number' ? 'ten' : typeof v === 'boolean' ? 'yes' : 'x';
      await expectError(t.name, { ...args, [key]: wrong }, 'invalid_input', key);
    });
  }

  it('malformed references', async () => {
    await expectError('graph_node', { uri: 'mandate://specs/Bad_Id' }, 'invalid_input', 'uri');
    await expectError('spec_get', { ref: 'mandate://standards/security-baseline' }, 'invalid_input', 'ref');
    await expectError('spec_section_get', { ref: 'mandate://specs/login-sso' }, 'invalid_input');
    await expectError('request_list', { target: 'https://example.com' }, 'invalid_input', 'target');
    await expectError('related', { uri: 'specs/login-sso' }, 'invalid_input', 'uri');
  });

  it('bad shas', async () => {
    await expectError('spec_get', { ref: 'login-sso', at: 'xyz' }, 'invalid_input', 'at');
    expect((await expectError('spec_get', { ref: 'login-sso', at: 'deadbeef' }, 'not_found', 'at')).detail).toEqual({ kind: 'commit' });
    await expectError('diff_get', { ref: 'mandate://specs/login-sso', from: 'zz' }, 'invalid_input', 'from');
    const conflict = await expectError('spec_get', { ref: `mandate://specs/login-sso@${short()}`, at: fx.head }, 'conflicting_versions');
    expect(conflict.hint).toBeTruthy();
  });

  it('limits exceeded', async () => {
    await expectError('search', { q: 'x', limit: 51 }, 'invalid_input', 'limit');
    await expectError('graph_neighbors', { uri: 'mandate://specs/login-sso', depth: 4 }, 'invalid_input', 'depth');
    await expectError('spec_list', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'invalid_input', 'tags');
    await expectError('search', { q: 'x'.repeat(501) }, 'invalid_input', 'q');
    await expectError('graph_batch', { ops: Array.from({ length: 21 }, () => ({ op: 'graphSchema', args: {} })) }, 'invalid_input', 'ops');
    await expectError('graph_query', { query: 'MATCH (a)-[*1..9]->(b) RETURN a', limit: 10 }, 'cypher_syntax', 'query');
  });

  it('domain errors are structured with hints', async () => {
    const nf = await expectError('spec_get', { ref: 'no-such-spec' }, 'not_found');
    expect(nf.hint).toBeTruthy();
    const sec = await expectError('spec_get', { ref: 'login-sso', sections: ['nope'] }, 'not_found', 'sections');
    expect(sec.detail).toEqual({ kind: 'section' });
    expect(sec.hint).toContain('auth-flow');
    expect((await expectError('graph_node', { uri: 'mandate://specs/no-such-spec' }, 'not_found')).detail).toEqual({ kind: 'node' });
    expect((await expectError('graph_node', { uri: 'mandate://commits/abcdef0' }, 'not_found')).detail?.kind).toMatch(/node|commit/);
    expect((await expectError('spec_get', { ref: 'no-such-spec' }, 'not_found')).detail).toEqual({ kind: 'document' });
    await expectError('verification_list', { criterion: 'mandate://specs/login-sso/sections/auth-flow' }, 'not_a_criterion');
    await expectError('code_search', {}, 'invalid_input');
    await expectError('graph_query', { query: 'CREATE (n:Spec) RETURN n' }, 'cypher_syntax', 'query');
  });

  it('unknown tool and missing arguments', async () => {
    const r = await fx.client.callTool({ name: 'spec_delete', arguments: {} });
    expect(r.isError).toBe(true);
    const r2 = await fx.client.callTool({ name: 'spec_get' });
    expect(r2.isError).toBe(true);
    expect((r2.structuredContent as any).error.path).toBe('ref');
  });
});

describe('history_get on a section', () => {
  it('returns only commits that changed the section', async () => {
    const doc = await fx.call('history_get', { ref: 'mandate://specs/login-sso', limit: 500 });
    const sec = await fx.call('history_get', { ref: '@mandate:mandate://specs/login-sso/sections/auth-flow', limit: 500 });
    expect(sec.isError, JSON.stringify(sec.body)).toBe(false);
    expect(sec.body.uri).toBe('mandate://specs/login-sso/sections/auth-flow');
    expect(sec.body.entries.length).toBeGreaterThan(0);
    expect(sec.body.entries.length).toBeLessThan(doc.body.entries.length);
    expect(sec.body.entries.at(-1).section.action).toBe('added');
    for (const e of sec.body.entries) expect(['added', 'removed', 'modified', 'moved']).toContain(e.section.action);
    const missing = await fx.call('history_get', { ref: 'mandate://specs/login-sso/sections/nope' });
    expect(missing.body.error).toMatchObject({ code: 'not_found', detail: { kind: 'section' } });
  });
});

describe('graph_query and graph_schema', () => {
  it('runs every example query embedded in the description', async () => {
    const { CYPHER_EXAMPLES } = await import('../../src/mcp/tools/graph.js');
    for (const ex of CYPHER_EXAMPLES) {
      const r = await fx.call('graph_query', { query: ex.query, params: { ref: 'mandate://specs/login-sso' } });
      expect(r.isError, `${ex.question}: ${JSON.stringify(r.body)}`).toBe(false);
    }
  });

  it('accepts a versioned reference as `at`', async () => {
    const r = await fx.call('graph_query', { query: 'MATCH (d:Spec {ref: $ref})-[:HAS_SECTION]->(s) RETURN count(s) AS n', params: { ref: 'mandate://specs/login-sso' }, at: `mandate://specs/login-sso@${short()}` });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.at.sha).toBe(fx.older);
  });
});

describe('sessions', () => {
  it('serves several sessions and broadcasts activity notifications', async () => {
    const other = await connect(fx.url, 'second');
    const got: unknown[] = [];
    other.fallbackNotificationHandler = async (n) => {
      got.push(n);
    };
    // Open the standalone SSE stream by making a request first (the transport opens GET after initialize).
    await other.listTools();
    expect(fx.hub.sessions().length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 100));
    await fx.hub.broadcastActivity({ id: 'abc', commit: fx.head, type: 'spec.updated', at: new Date().toISOString(), refs: ['mandate://specs/login-sso'], summary: 'test' });
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(got[0]).toMatchObject({ method: 'notifications/mandate/activity', params: { id: 'abc' } });
    await other.close();
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(fx.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
