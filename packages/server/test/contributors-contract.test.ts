/**
 * Contract: EVERY node kind has contributors (like "every node kind has lineage"). For each kind, a fixture element is
 * written by known users and its contributors are asserted, including propagation through a cause
 * (feedback by alice and bob -> a standard rule edited by carol: carol direct, alice and bob via) and section-level
 * granularity. Legacy commits (no user) fall back to the agent (userRecorded: false); 
 */
import { NODE_KINDS, buildArchitectureRef, type Contributor } from '@mandate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpFixture, type McpFixture } from './mcp/fixture.js';
import { callTool, type ToolContext } from '../src/mcp/define.js';
import { TOOLS } from '../src/mcp/server.js';
import { MemoryClientStore, memorySettings } from '../src/projects/settings.js';
import { DocViewService } from '../src/storage/views.js';
import type { Principal } from '../src/auth/http.js';

let fx: McpFixture;
/** These clients ask in chat (questions: chat), so confirmedByUser confirms standard writes. */
const CHAT = new MemoryClientStore();
const chatGet = CHAT.get.bind(CHAT);
CHAT.get = async (p, id) => ({ ...((await chatGet(p, id)) ?? { flow: null, approval: null }), questions: 'chat' }) as never;
const as = (login: string | null, mode: 'team' | 'me' = 'team'): ToolContext =>
  ({
    storage: fx.storage,
    index: fx.index,
    reads: fx.reads,
    views: new DocViewService(fx.storage),
    settings: memorySettings({}, 'test', CHAT),
    clientName: `agent-of-${login ?? 'nobody'}`,
    ...(login ? { principal: { kind: 'user', login, project: 'test', via: 'oauth', tokenId: 't', tokenName: 'cli' } as Principal } : {}),
  }) as ToolContext;
async function call(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const r = await callTool(TOOLS.find((t) => t.name === name)!, args, ctx);
  const body = r.structuredContent as Record<string, any>;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}
const S = Date.now().toString(36);
const refs: Partial<Record<(typeof NODE_KINDS)[number], { ref: string; expect: Record<string, { kind?: 'direct' | 'via'; role?: string }> }>> = {};

beforeAll(async () => {
  fx = await mcpFixture();
  // ids are assigned by Mandate (slug of the title)
  const std = (await call(as('zed'), 'standard_create', { title: `Std ccs ${S}`, appliesTo: ['tag:zz-none'], sections: [{ title: 'R one', type: 'rule', rationale: 'Because.', level: 'must', summary: 'One.', body: 'Do it.' }], confirmedByUser: true })).document.id as string;
  const spec = (await call(as('zed'), 'spec_create', {
    title: `Spec cc ${S}`,
    summary: 'Contract.',
    sections: [
      { title: 'Overview', summary: 'What.', body: 'Body.', symbols: [`ContractSym${S}`] },
      { title: 'Design', summary: 'How.', body: 'Design.' },
      { title: 'Ac works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'Proven.' },
    ],
  })).document.id as string;
  const comp = (await call(as('zed'), 'component_create', { title: `Comp ccc ${S}`, kind: 'module' })).document.id as string;
  // request by alice -> carol edits the rule section (cause) and the spec design section
  const fb = (await call(as('alice'), 'request_create', { targets: [`mandate://standards/${std}/sections/r-one`], kind: 'improvement', body: 'Tighten it.' })).ref;
  await call(as('carol'), 'standard_section_update', { ref: `mandate://standards/${std}/sections/r-one`, body: 'Do it, always.', cause: fb, confirmedByUser: true });
  await call(as('carol'), 'spec_section_update', { ref: `mandate://specs/${spec}/sections/design`, body: 'Design v2.', branch: `feat/cc-${S}` });
  // work order by dave: claim with a branch + PR, touched code, a code commit; bob comments; erin verifies
  const wo = (await call(as('dave'), 'work_order_create', { spec, kind: 'implement', sections: ['design'], plan: { tasks: [{ text: '1. do', sections: ['design'] }] } })).ref;
  await call(as('dave'), 'work_order_claim', { ref: wo, git: [{ repo: `app${S}`, branch: `wo/cc-${S}`, baseBranch: 'main', headCommit: 'abc1234', pr: { number: 77, status: 'open', url: 'https://example.com/pr/77' } }] });
  await call(as('dave'), 'work_order_touch', { ref: wo, section: 'design', files: [`app${S}:src/cc/file.ts#L1-L9`], code: { repo: `app${S}`, commit: 'abcdef1' } });
  const comment = await call(as('bob'), 'comment_add', { target: wo, body: 'Check the edge case.' });
  // gina's agent asks a question about the spec; hank answers it in the web UI
  const question = (await call(as('gina'), 'question_ask', { purpose: 'decision', request: fb.split('/').pop(), context: [`mandate://specs/${spec}`], questions: [{ header: 'Scope', question: 'Ship design v2?', options: [{ label: 'Yes', description: 'Now' }, { label: 'No', description: 'Later' }], recommended: 'Yes' }] })).ref as string;
  await call({ ...as(null), principal: { kind: 'ui', user: { login: 'hank', avatarUrl: '' } }, uiAccess: 'write' } as ToolContext, 'question_answer', { id: question, answers: { q1: 'Yes' } });
  const ver = (await call(as('erin'), 'verification_record', { criterion: `mandate://specs/${spec}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test' })).ref;
  // audit by frank with a finding
  const started = await call(as('frank'), 'audit_start', { target: `mandate://specs/${spec}`, code: { repo: 'app', commit: 'abcdef1' }, overview: 'Scope.' });
  const auditId = started.audit.id as string;
  const rec = await call(as('frank'), 'audit_record_item', {
    auditId,
    ref: `mandate://specs/${spec}/sections/ac-works`,
    result: 'fail',
    notes: 'It fails (src/cc/file.ts#L1-L9).',
    findings: [{ title: 'Broken', description: 'It is broken.', suggestedFix: 'Fix it.', codeRefs: [`app${S}:src/cc/file.ts#L2-L3`], classification: 'code_deviates' }],
  });
  await fx.index.ensureFresh();
  const head = fx.git.head ? await fx.git.head() : null;
  const commentId = (comment.comment?.id ?? comment.id ?? comment.ref?.split('/').pop()) as string;
  const version = `mandate://specs/${spec}@${(await fx.storage.history.log(`specs/${spec}.md`))[0]!.commit}`;
  const D = { kind: 'direct' as const };
  Object.assign(refs, {
    spec: { ref: `mandate://specs/${spec}`, expect: { zed: { ...D, role: 'created' }, carol: { ...D, role: 'edited' }, erin: { ...D, role: 'verified' } } },
    standard: { ref: `mandate://standards/${std}`, expect: { zed: D, carol: D } },
    section: { ref: `mandate://standards/${std}/sections/r-one`, expect: { carol: { ...D, role: 'edited' }, alice: { kind: 'via', role: 'filed' } } },
    component: { ref: `mandate://components/${comp}`, expect: { zed: { ...D, role: 'created' } } },
    work_order: { ref: wo, expect: { dave: { ...D, role: 'claimed' }, bob: { ...D, role: 'commented' } } },
    feedback: { ref: fb, expect: { alice: { ...D, role: 'filed' } } },
    verification: { ref: ver, expect: { erin: D } },
    comment: { ref: `mandate://comments/${commentId}`, expect: { bob: { ...D, role: 'commented' } } },
    question: { ref: question, expect: { gina: { ...D, role: 'asked' }, hank: { ...D, role: 'answered' } } },
    audit: { ref: `mandate://audits/${auditId}`, expect: { frank: D } },
    finding: { ref: rec.findings[0], expect: { frank: D } },
    code_file: { ref: `mandate://code/app${S}/src/cc/file.ts`, expect: { dave: { ...D, role: 'touched' } } },
    code_range: { ref: `mandate://code/app${S}/src/cc/file.ts#L1-L9`, expect: { dave: { ...D, role: 'touched' } } },
    repo: { ref: `mandate://repos/app${S}`, expect: { dave: { ...D, role: 'touched' } } },
    commit: { ref: `mandate://commits/${head}`, expect: { frank: { ...D, role: 'committed' } } },
    branch: { ref: `mandate://branches/feat%2Fcc-${S}`, expect: { carol: { ...D, role: 'committed' } } },
    pull_request: { ref: `mandate://prs/app${S}/77`, expect: { dave: D } },
    code_commit: { ref: `mandate://code-commits/app${S}/abc1234`, expect: { dave: { ...D, role: 'implemented' } } },
    agent: { ref: 'mandate://agents/agent-of-erin', expect: { erin: { ...D, role: 'used' } } },
    // P6: a user node's contributors are the user itself (the commits it authored).
    user: { ref: 'mandate://users/erin', expect: { erin: { ...D, role: 'committed' } } },
    version: { ref: version, expect: { zed: D } },
    excerpt: { ref: `mandate://specs/${spec}/sections/design#L1-L1`, expect: { carol: D } },
    symbol: { ref: `mandate://symbols/ContractSym${S}`, expect: { zed: { ...D, role: 'mentioned' } } },
    architecture: { ref: buildArchitectureRef(), expect: { zed: D } },
  });
}, 180_000);
afterAll(async () => {
  await fx?.close();
});

const get = async (ref: string, mode: 'team' | 'me' = 'team'): Promise<Contributor[]> => {
  const r = await call(as(null, mode), 'contributors', { refs: [ref] });
  return Object.values(r.contributors as Record<string, Contributor[]>)[0]!;
};

describe('contributors contract', () => {
  it('every node kind has a fixture case', () => {
    expect(NODE_KINDS.filter((k) => !refs[k])).toEqual([]);
  });

  for (const kind of NODE_KINDS) {
    it(`${kind}: the known writers are its contributors`, async () => {
      const c = refs[kind]!;
      const list = await get(c.ref);
      for (const [user, want] of Object.entries(c.expect)) {
        const got = list.find((x) => x.user === user && x.userRecorded);
        expect(got, `${kind} ${c.ref}: ${user} in ${JSON.stringify(list.map((x) => [x.user, x.kind, x.roles]))}`).toBeDefined();
        if (want.kind) expect(got!.kind, `${kind}: ${user} kind`).toBe(want.kind);
        if (want.role) expect(got!.roles, `${kind}: ${user} roles`).toContain(want.role);
      }
    });
  }

  it('section-level granularity: the spec overview section has no carol (she edited design only)', async () => {
    const ov = await get(refs.spec!.ref.replace(/$/, '/sections/overview'));
    expect(ov.some((x) => x.user === 'carol')).toBe(false);
    expect(ov.some((x) => x.user === 'zed')).toBe(true);
  });

  it('legacy commits (no recorded user) fall back to the agent with userRecorded: false', async () => {
    const list = await get('mandate://specs/login-sso');
    expect(list.length).toBeGreaterThan(0);
    const legacy = list.filter((x) => !x.userRecorded);
    expect(legacy.length, JSON.stringify(list.map((x) => [x.user, x.userRecorded]))).toBeGreaterThan(0);
    expect(legacy.every((x) => x.agents.length === 0 || x.agents.includes(x.user))).toBe(true);
  });

  it('get tools carry contributors in their derived data', async () => {
    const s = await call(as(null), 'standard_section_get', { ref: refs.section!.ref });
    expect((s.contributors as Contributor[]).map((x) => x.user)).toEqual(expect.arrayContaining(['carol', 'alice']));
    const f = await call(as(null), 'request_get', { ref: refs.feedback!.ref });
    expect((f.contributors as Contributor[]).map((x) => x.user)).toEqual(expect.arrayContaining(['alice']));
  });
});
