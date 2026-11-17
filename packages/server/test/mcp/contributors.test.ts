/**
 * Phase B: contributors (direct + propagated through causes), co-author trailers (team), the user
 * directory, "changing" work-order progress (claim / branch / PR), blast radius on touched files, touched code of
 * reconciled work orders in "where it's used", and comment attribution.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishAllSteps, mcpFixture, type McpFixture } from './fixture.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { MemoryClientStore, memorySettings } from '../../src/projects/settings.js';
import { DocViewService } from '../../src/storage/views.js';
import { setUserDirectory, UserDirectory } from '../../src/auth/users.js';
import type { Principal } from '../../src/auth/http.js';
import { tempDir } from '../helpers.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
  const dir = new UserDirectory(path.join(await tempDir(), 'users.json'));
  dir.record({ login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice', id: 101 });
  setUserDirectory(dir);
}, 120_000);
afterAll(async () => {
  setUserDirectory(null);
  await fx?.close();
});

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
    clientName: `agent-of-${login ?? 'local'}`,
    ...(login ? { principal: { kind: 'user', login, project: 'test', via: 'oauth', tokenId: 't', tokenName: 'cli' } as Principal } : {}),
  }) as ToolContext;
async function call(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  if (name === 'work_order_complete') await finishAllSteps(fx.storage, String(args.ref));
  const r = await callTool(TOOLS.find((t) => t.name === name)!, args, ctx);
  const body = r.structuredContent as Record<string, any>;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}
const git = (...a: string[]) => execFileSync('git', ['-C', fx.dir, ...a], { encoding: 'utf8' }).trim();
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
async function newSpec(ctx: ToolContext) {
  const id = uid('ctb');
  await call(ctx, 'spec_create', {
    title: id,
    summary: 'Contributors.',
    sections: [
      { title: 'Overview', summary: 'What.', body: 'Body.' },
      { title: 'Design', summary: 'How.', body: 'Design.' },
      { title: 'Ac works', type: 'acceptance', method: 'test', summary: 'Works.', body: 'Proven.' },
    ],
  });
  return id;
}
const by = (list: { user: string; roles: string[]; kind: string }[], user: string) => list.find((c) => c.user === user);

describe('contributors', () => {
  let id: string;
  let fb: string;
  let wo: string;
  beforeAll(async () => {
    id = await newSpec(as('zed'));
    fb = (await call(as('alice'), 'request_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Cache it.' })).ref;
    await call(as('carol'), 'spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'Cached.', cause: fb });
    wo = (await call(as('dave'), 'work_order_create', { spec: id, kind: 'implement', sections: ['overview'], plan: { steps: ['1. do'] }, cause: fb })).ref;
    await call(as('erin'), 'spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'Overview v2.', cause: wo });
  }, 120_000);

  it('feedback contributors propagate to the section it changed (via the feedback), direct first', async () => {
    const r = await call(as(null), 'contributors', { refs: [`mandate://specs/${id}/sections/design`] });
    const list = r.contributors[`mandate://specs/${id}/sections/design`];
    expect(list[0]).toMatchObject({ user: 'carol', kind: 'direct' });
    expect(by(list, 'carol')!.roles).toContain('edited');
    expect(by(list, 'alice')).toMatchObject({ kind: 'via', via: [{ uri: fb, kind: 'feedback' }] });
    expect(by(list, 'alice')!.roles).toContain('filed');
    expect(list.findIndex((c: { kind: string }) => c.kind === 'via')).toBeGreaterThan(list.findIndex((c: { kind: string }) => c.kind === 'direct'));
  });

  it('chains through a work order (feedback -> work order -> section) and respects the depth', async () => {
    const sec = `mandate://specs/${id}/sections/overview`;
    const deep = (await call(as(null), 'contributors', { refs: [sec], depth: 2 })).contributors[sec];
    expect(by(deep, 'erin')!.kind).toBe('direct');
    expect(by(deep, 'dave')).toMatchObject({ kind: 'via', via: [{ uri: wo }] });
    expect(by(deep, 'alice')).toMatchObject({ kind: 'via', via: [{ uri: wo }, { uri: fb }] });
    const shallow = (await call(as(null), 'contributors', { refs: [sec], depth: 1 })).contributors[sec];
    expect(by(shallow, 'dave')).toBeDefined();
    expect(by(shallow, 'alice')).toBeUndefined();
    const none = (await call(as(null), 'contributors', { refs: [sec], depth: 0 })).contributors[sec];
    expect(none.every((c: { kind: string }) => c.kind === 'direct')).toBe(true);
  });

  it('a user who is both direct and indirect is direct, noting also-via', async () => {
    await call(as('alice'), 'spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'Cached, LRU.', cause: fb });
    const list = (await call(as(null), 'contributors', { refs: [`mandate://specs/${id}/sections/design`] })).contributors[`mandate://specs/${id}/sections/design`];
    expect(by(list, 'alice')).toMatchObject({ kind: 'direct', alsoVia: [{ uri: fb }] });
    expect(list.filter((c: { user: string }) => c.user === 'alice')).toHaveLength(1);
  });

  it('the document aggregates its sections; co-authors of a caused write are trailers with noreply addresses', async () => {
    const doc = (await call(as(null), 'contributors', { refs: [`mandate://specs/${id}`] })).contributors[`mandate://specs/${id}`];
    expect(doc.filter((c: { kind: string }) => c.kind === 'direct').map((c: { user: string }) => c.user)).toEqual(expect.arrayContaining(['zed', 'carol', 'erin', 'alice']));
    await call(as('frank'), 'spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'Cached, LRU, TTL.', cause: fb });
    const msg = git('log', '-1', '--format=%B');
    expect(msg).toMatch(/^Co-authored-by: alice <101\+alice@users\.noreply\.github\.com>$/m);
    expect(msg).not.toMatch(/Co-authored-by: frank/);
    const h = await call(as(null), 'history_get', { ref: `mandate://specs/${id}`, limit: 1 });
    expect(h.entries[0].coAuthors).toEqual(expect.arrayContaining(['alice']));
  });

  it('users_resolve: directory entries, GitHub avatar fallback, service accounts', async () => {
    const r = await call(as(null), 'users_resolve', { logins: ['alice', 'bob', 'service:ci'] });
    expect(r.users[0]).toMatchObject({ login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice', known: true });
    expect(r.users[1]).toMatchObject({ login: 'bob', known: false, avatarUrl: expect.stringContaining('avatars.githubusercontent.com/bob') });
    expect(r.users[2]).toMatchObject({ service: true, avatarUrl: null });
  });
});

describe('work orders in lineage (phase B)', () => {
  it('changing: an open work order shows progress, claim, branch and its open PR; PRs link out', async () => {
    const id = await newSpec(as('zed'));
    const fb = (await call(as('alice'), 'request_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Do it.' })).ref;
    const wo = (await call(as('dave'), 'work_order_create', { spec: id, kind: 'implement', sections: ['design', 'overview'], plan: { steps: ['1. do'] }, reason: [fb.split('/').pop()] })).ref;
    await call(as('dave'), 'work_order_claim', { ref: wo, git: [{ repo: 'app', branch: 'wo/cache', baseBranch: 'main', pr: { number: 42, status: 'open', url: 'https://github.com/acme/app/pull/42' } }] });
    await call(as('dave'), 'work_order_section_done', { ref: wo, sections: ['design'], notes: 'done' }).catch(() => undefined);
    const r = await call(as(null), 'lineage', { ref: fb, direction: 'down', depth: 2 });
    const node = r.nodes.find((x: { uri: string }) => x.uri === wo);
    expect(node.status).toBe('in_progress');
    expect(node.progress).toMatchObject({ sectionsTotal: 2, claimedBy: 'agent-of-dave', branch: 'wo/cache', prs: [{ repo: 'app', number: 42, status: 'open', url: 'https://github.com/acme/app/pull/42' }] });
    expect(r.summary.changing.workOrders).toBe(1);
    expect(r.summary.changing.prs).toBe(1);
    expect(r.summary.changing.branches).toEqual(['wo/cache']);
    expect(r.summary.changing.items[0]).toMatchObject({ uri: wo, work: { branch: 'wo/cache' } });
    expect(r.summary.changing.items[0].progress).toMatch(/sections · agent-of-dave on wo\/cache · PR #42 open/);
    expect(r.summary.text).toMatch(/Changing: 1 work order \(\d\/2\), PR #42 open/);
    const pr = await call(as(null), 'lineage', { ref: wo, direction: 'down', depth: 1, structure: true });
    expect(pr.nodes.find((x: { kind: string }) => x.kind === 'pull_request')?.url).toBe('https://github.com/acme/app/pull/42');
  });

  it('blast_radius lists open work orders that touched the same files; comments carry the user', async () => {
    const id = await newSpec(as('zed'));
    const wo = (await call(as('dave'), 'work_order_create', { spec: id, kind: 'implement', sections: ['design'], plan: { steps: ['1. do'] } })).ref;
    await call(as('dave'), 'work_order_claim', { ref: wo });
    await call(as('dave'), 'work_order_touch', { ref: wo, files: ['app:src/blast/radius.ts#L1-L20'] });
    const b = await call(as(null), 'blast_radius', { ref: 'mandate://code/app/src/blast/radius.ts' });
    expect(b.openWorkOrders.map((x: { uri: string }) => x.uri)).toContain(wo);
    expect(b.openWorkOrders.find((x: { uri: string }) => x.uri === wo).via).toMatch(/^touches /);
    const c = await call(as('bob'), 'comment_add', { target: wo, body: 'Looks good.' });
    expect(JSON.stringify(c)).toContain('"user":"bob"');
  });

  it("where it's used: code touched by a reconciled (done) work order on a section following a rule", async () => {
    const std = uid('tstd');
    await call(as('zed'), 'standard_create', { title: std, appliesTo: ['tag:zz-none'], sections: [{ title: 'R one', type: 'rule', rationale: 'Because.', level: 'must', summary: 'One.', body: 'Do it.' }], confirmedByUser: true });
    const id = await newSpec(as('zed'));
    await call(as('zed'), 'spec_section_link_add', { ref: `mandate://specs/${id}/sections/design`, rel: 'follows', to: `mandate://standards/${std}/sections/r-one` });
    const wo = (await call(as('dave'), 'work_order_create', { spec: id, kind: 'implement', sections: ['design'], plan: { steps: ['1. do'] } })).ref;
    await call(as('dave'), 'work_order_claim', { ref: wo });
    await call(as('dave'), 'work_order_touch', { ref: wo, section: 'design', files: ['app:src/touched/rule.ts#L5-L9'] });
    await call(as('dave'), 'work_order_section_done', { ref: wo, sections: ['design'], notes: 'Built.' });
    const crit = `mandate://specs/${id}/sections/ac-works`;
    await call(as('dave'), 'verification_record', { criterion: crit, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test' });
    await call(as('dave'), 'verification_record', { criterion: `mandate://standards/${std}/sections/r-one`, appliedTo: id, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'review' });
    await call(as('dave'), 'work_order_complete', { ref: wo, outcome: 'Done.', reconciliation: 'Refs updated.' });
    const w = await call(as(null), 'standard_where_used', { ref: `mandate://standards/${std}` });
    expect(w.locations.find((l: { path: string }) => l.path === 'src/touched/rule.ts')).toMatchObject({ state: 'compliant', source: wo });
    const rules = await call(as(null), 'code_rules', { ref: 'mandate://code/app/src/touched/rule.ts#L6-L6' });
    expect(rules.follows.map((r: { rule: string }) => r.rule)).toContain(`mandate://standards/${std}/sections/r-one`);
  });
});
