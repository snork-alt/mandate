/**
 * Work orders as markdown documents over MCP: plan gate (fast-path fixes excepted), freeze after completion (PR fields
 * excepted), heartbeats outside git, section notes / code / deviations, touched code (merge, renames, per section,
 * graph, claim_overlap), git context (merge, repos, claim history, graph lookups), touch_from_commits, comments
 * (threads, resolve / reopen, open_comments gate, frozen rule, permissions), doc kind reads and activity.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../helpers.js';
import { mcpFixture, type McpFixture } from './fixture.js';

// Graph assertions wait for the index to catch up: generous timeouts under full-suite load.
vi.setConfig({ testTimeout: 90_000 });

let fx: McpFixture;
let code: string;
const sh = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  // A local CODE repo the server may read (as if wired with `mandate connect`).
  code = path.join(await tempDir(), 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', code]);
  sh(code, 'config', 'user.email', 't@x');
  sh(code, 'config', 'user.name', 'T');
  await writeFile(path.join(code, 'a.ts'), 'one\ntwo\nthree\n');
  await writeFile(path.join(code, 'old.ts'), 'export const x = 1;\n'.repeat(5));
  sh(code, 'add', '.');
  sh(code, 'commit', '-q', '-m', 'base');
  fx = await mcpFixture({ codeRepos: (repo: string) => (repo === 'app' ? code : null) });
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'impl@test';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}, agent = AGENT) {
  const r = await fx.call(name, { agent, ...args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function read(name: string, args: Record<string, unknown> = {}) {
  const r = await fx.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown> = {}, agent = AGENT) {
  const r = await fx.call(name, { agent, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string; detail?: Record<string, any> };
}
const commitCount = () => Number(sh(fx.dir, 'rev-list', '--count', 'HEAD'));

/** A spec with two sections (code refs on the first) and a work order on both. */
async function setup(opts: { kind?: string; plan?: string; sections?: string[]; fastPath?: boolean } = {}) {
  const spec = uid('wos');
  await ok('spec_create', {
    id: spec,
    title: `Spec ${spec}`,
    summary: 'A test spec.',
    sections: [
      { id: 'design', title: 'Design', summary: 'How it works.', body: 'The design.', refs: [{ repo: 'app', path: `src/${spec}/handler.ts`, lines: '1-40' }] },
      { id: 'api', title: 'API', summary: 'The API.', body: 'The API.' },
    ],
  });
  const wo = await ok('work_order_create', {
    spec,
    sections: opts.sections ?? ['design', 'api'],
    kind: opts.kind ?? 'implement',
    ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
    ...(opts.fastPath ? { fastPath: true } : {}),
  });
  return { spec, ref: wo.ref as string, id: (wo.ref as string).split('/').pop()!, wo };
}

describe('work orders as documents', () => {
  it('stores work-orders/<id>.md with plan, wo-sections, reconciliation, outcome; doc kind reads', async () => {
    const { id, ref, spec } = await setup({ plan: '1. Build it.' });
    const raw = (await read('doc_raw', { kind: 'work-orders', id })).text as string;
    expect(raw).toContain('<!-- @section plan -->');
    expect(raw).toContain('type: wo-section');
    expect(raw).toContain(`target: mandate://specs/${spec}/sections/design`);
    expect(raw).not.toContain('heartbeatAt');
    const doc = await read('doc_get', { kind: 'work-orders', id });
    expect(doc.sections.map((s: any) => s.id)).toEqual(['plan', 'design', 'api', 'reconciliation', 'outcome']);
    expect(doc.workOrder.item).toMatchObject({ id, hasPlan: true, title: expect.stringContaining('Implement') });
    expect(doc.workOrder.doc.plan).toBe('1. Build it.');
    const sec = await read('work_order_section_get', { ref: `${ref}/sections/design` });
    expect(sec.section).toMatchObject({ id: 'design', type: 'wo-section' });
    expect(sec.section.meta).toMatchObject({ target: `mandate://specs/${spec}/sections/design`, status: 'pending' });
    // Versioned refs, history and version_get.
    const head = sh(fx.dir, 'rev-parse', 'HEAD');
    const v = await read('work_order_section_get', { ref: `mandate://work-orders/${id}@${head}/sections/plan` });
    expect(v.section.body).toBe('1. Build it.');
    expect((await read('history_get', { ref })).entries.length).toBeGreaterThan(0);
    expect((await read('history_get', { ref: `${ref}/sections/plan` })).entries[0].section.action).toBe('added');
    expect((await read('version_get', { kind: 'work-orders', id, commit: head.slice(0, 7) })).commit).toBe(head);
    const wg = await read('work_order_get', { ref });
    expect(wg.doc.sections.map((s: any) => s.uri)).toEqual([`${ref}/sections/design`, `${ref}/sections/api`]);
  });

  it('plan is required before claiming, except fast-path fixes; plan_set is versioned', async () => {
    const { ref } = await setup();
    expect((await fail('work_order_claim', { ref })).code).toBe('plan_required');
    const next = await ok('work_order_next', { spec: (await read('work_order_get', { ref })).item.spec });
    expect(next.workOrder).toBeNull();
    expect(next.skipped.map((s: any) => s.reason).join()).toContain('no plan');
    await ok('work_order_plan_set', { ref, plan: 'v1' });
    await ok('work_order_plan_set', { ref, plan: 'v2: refined' });
    expect((await ok('work_order_claim', { ref })).workOrder.item.status).toBe('in_progress');
    expect((await read('history_get', { ref: `${ref}/sections/plan` })).entries.length).toBeGreaterThanOrEqual(2);
    // Fast path: kind fix, one section, fastPath: true.
    const fast = await setup({ kind: 'fix', sections: ['api'], fastPath: true });
    expect((await ok('work_order_claim', { ref: fast.ref })).workOrder.item).toMatchObject({ status: 'in_progress', fastPath: true });
    // fastPath on anything else is refused.
    const spec = (await read('work_order_get', { ref })).item.spec;
    expect((await fail('work_order_create', { spec, sections: ['design', 'api'], kind: 'fix', fastPath: true })).code).toBe('validation');
  }, 60_000);

  it('heartbeats are not committed; git fields on heartbeat commit only when they change', async () => {
    const { ref, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    const before = commitCount();
    for (let i = 0; i < 3; i++) await ok('work_order_heartbeat', { ref });
    expect(commitCount()).toBe(before);
    expect(fx.storage.heartbeats.get(id)?.agent).toBe(AGENT);
    await ok('work_order_heartbeat', { ref, git: [{ repo: 'app', headCommit: 'abc1234' }] });
    expect(commitCount()).toBe(before + 1);
    await ok('work_order_heartbeat', { ref, git: [{ repo: 'app', headCommit: 'abc1234' }] });
    expect(commitCount()).toBe(before + 1);
  });

  it('completion needs an outcome; closed work orders are frozen except PR status / merge fields', async () => {
    const { ref, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref, git: [{ repo: 'app', branch: 'wo/x', baseBranch: 'main', pr: { number: 7, status: 'open', url: 'https://example.com/pr/7' } }] });
    expect((await fail('work_order_complete', { ref })).code).toBe('outcome_required');
    const done = await ok('work_order_complete', { ref, outcome: 'Built it.', reconciliation: 'Updated design code refs.' });
    expect(done.workOrder.item).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect(done.workOrder.doc).toMatchObject({ outcome: 'Built it.', reconciliation: 'Updated design code refs.' });
    expect(done.workOrder.item.claims.at(-1)).toMatchObject({ agent: AGENT, ended: 'completed' });
    expect((await fail('work_order_plan_set', { ref, plan: 'late' })).code).toBe('work_order_frozen');
    expect((await fail('work_order_touch', { ref, files: ['app:a.ts'] })).code).toBe('work_order_frozen');
    expect((await fail('work_order_git_update', { ref, repo: 'app', headCommit: 'def5678' })).code).toBe('work_order_frozen');
    // PR status / mergedCommit / mergedInto may change after completion.
    const merged = await ok('work_order_git_update', { ref, repo: 'app', pr: { status: 'merged', mergedCommit: '0123abcd' }, mergedInto: 'main' });
    expect(merged.workOrder.item.git[0]).toMatchObject({ branch: 'wo/x', pr: { number: 7, status: 'merged', mergedCommit: '0123abcd' }, mergedInto: 'main' });
    // Storage rule as well.
    await expect(fx.storage.workOrderDocs.modify(id, (d) => ({ ...d, note: 'edited' }))).rejects.toMatchObject({ code: 'work_order_frozen' });
    await expect(fx.storage.workOrderDocs.delete(id)).rejects.toMatchObject({ code: 'archive_only' });
  });

  it('stale claims use runtime heartbeats; after a restart claims are fresh until the TTL since startup', async () => {
    const { MemoryHeartbeats, SqliteHeartbeats } = await import('../../src/storage/heartbeats.js');
    const { effectiveHeartbeat } = await import('../../src/storage/heartbeats.js');
    const { isClaimStale } = await import('@mandate/shared');
    const file = path.join(await tempDir(), 'rt.sqlite');
    const hour = 3600_000;
    const old = new Date(Date.now() - 2 * hour).toISOString();
    const claim = { agent: 'a', startedAt: old };
    // A process that started long ago: an old heartbeat is stale, a fresh one is not.
    const s1 = new SqliteHeartbeats(file, Date.now() - 3 * hour);
    s1.set('wo-x', 'a', old);
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s1, 'wo-x', claim) })).toBe(true);
    s1.set('wo-x', 'a', new Date().toISOString());
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s1, 'wo-x', claim) })).toBe(false);
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    s1.set('wo-x', 'a', recent);
    s1.set('wo-old', 'a', old);
    s1.close();
    // Restart: the heartbeat survives (SQLite); a claim still fresh when the previous process stopped counts as fresh
    // until the TTL since startup (grace to heartbeat again) ...
    const s2 = new SqliteHeartbeats(file);
    expect(s2.get('wo-x')).toEqual({ agent: 'a', at: recent });
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s2, 'wo-x', claim) })).toBe(false);
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s2, 'wo-x', claim) }, Date.now() + 31 * 60_000)).toBe(true);
    // ... but a claim that was already stale before the restart stays stale (DF-3).
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s2, 'wo-old', claim) })).toBe(true);
    // Another agent's heartbeat does not keep this claim alive.
    const m = new MemoryHeartbeats(0);
    m.set('wo-y', 'someone-else', new Date().toISOString());
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(m, 'wo-y', claim) })).toBe(true);
    s2.close();
    // End to end: agent-b takes over agent-a's stale claim; the history keeps both.
    const { ref, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref, git: [{ repo: 'app', branch: 'wo/a' }] }, 'agent-a');
    expect((await fail('work_order_claim', { ref }, 'agent-b')).code).toBe('claim_conflict');
    await fx.storage.workOrderDocs.modify(id, (d) => ({ ...d, claim: { ...d.claim!, startedAt: old } }));
    fx.storage.heartbeats.set(id, 'agent-a', old);
    const hb = fx.storage.heartbeats as { startedAt: number };
    const started = hb.startedAt;
    hb.startedAt = 0;
    try {
      expect((await read('work_order_get', { ref })).item.claim.heartbeatAt).toBe(old);
      expect((await fail('work_order_section_done', { ref, sections: ['design'] }, 'agent-b')).code).toBe('stale_claim');
      const taken = await ok('work_order_claim', { ref }, 'agent-b');
      expect(taken.workOrder.item.claim.agent).toBe('agent-b');
      expect(taken.workOrder.item.claims).toEqual([expect.objectContaining({ agent: 'agent-a', ended: 'taken_over', startedAt: old })]);
      // Re-claim by the same agent keeps the claim (no new history entry); release ends it.
      await ok('work_order_claim', { ref }, 'agent-b');
      const rel = await ok('work_order_release', { ref }, 'agent-b');
      expect(rel.workOrder.item.claims.map((c: any) => `${c.agent}:${c.ended}`)).toEqual(['agent-a:taken_over', 'agent-b:released']);
      expect(rel.workOrder.item.git[0].branch).toBe('wo/a');
    } finally {
      hb.startedAt = started;
    }
  });

  it('section_done writes notes, code refs, deviations and verifications into the wo-section', async () => {
    const { ref, spec } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    const r = await ok('work_order_section_done', {
      ref,
      sections: [`${ref}/sections/design`],
      notes: 'Implemented the handler.',
      codeRefs: [`app:src/${spec}/handler.ts#L10-L20`, { repo: 'app', path: `./src/${spec}/handler.ts`, lines: ['15-30'], symbols: ['handle'] }],
      deviations: ['Uses a queue instead of a cron.'],
      verifications: [`mandate://specs/${spec}/sections/api`],
    });
    const s = r.workOrder.doc.sections.find((x: any) => x.id === 'design');
    expect(s).toMatchObject({ status: 'done', notes: 'Implemented the handler.', deviations: ['Uses a queue instead of a cron.'], verifications: [`mandate://specs/${spec}/sections/api`] });
    expect(s.codeRefs).toEqual([{ repo: 'app', path: `src/${spec}/handler.ts`, lines: ['10-30'], symbols: ['handle'], change: 'modified' }]);
    expect(r.workOrder.item.touched).toEqual(s.codeRefs);
    expect(r.workOrder.item.status).toBe('in_progress');
    // Only this tool's own warnings matter here (the flow layer may add missing_cause when no cause is passed).
    // and integrity warnings: the touched file is owned by no component (unowned_code_ref, with its hint).
    expect((r.warnings as string[]).filter((w) => !w.startsWith('missing_cause') && !w.startsWith('integrity: '))).toEqual([]);
    expect(r.integrity.introduced.map((i: { rule: string }) => i.rule)).toContain('unowned_code_ref');
    const spec2 = await read('spec_get', { ref: spec });
    expect(spec2.sections.find((x: any) => x.id === 'design').meta.implementedCommit).toBe(r.workOrder.item.specCommit);
  });

  it('touched: idempotent merge, renames, per section vs aggregate, graph and code_search, claim_overlap', async () => {
    const { ref, spec, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    const files = [`app:src/${spec}/a.ts#L1-L5`, `app:src/${spec}/a.ts#L6-L9`, { repo: 'app', path: `src/${spec}/new.ts`, change: 'added' }];
    const t1 = await ok('work_order_touch', { ref, section: 'design', files });
    const before = commitCount();
    const t2 = await ok('work_order_touch', { ref, section: 'design', files });
    expect(commitCount()).toBe(before);
    expect(t2.workOrder.item.touched).toEqual(t1.workOrder.item.touched);
    expect(t1.workOrder.item.touched).toEqual([
      { repo: 'app', path: `src/${spec}/a.ts`, lines: ['1-9'], change: 'modified' },
      { repo: 'app', path: `src/${spec}/new.ts`, change: 'added' },
    ]);
    // A rename at WO level only: the section keeps its own list.
    await ok('work_order_touch', { ref, files: [{ repo: 'app', path: `src/${spec}/b.ts`, change: 'renamed', from: `src/${spec}/a.ts` }, { repo: 'app', path: `src/${spec}/new.ts`, change: 'modified', lines: ['3'] }] });
    const got = await read('work_order_get', { ref });
    expect(got.touched).toEqual([
      { repo: 'app', path: `src/${spec}/b.ts`, change: 'renamed', from: `src/${spec}/a.ts` },
      { repo: 'app', path: `src/${spec}/new.ts`, lines: ['3'], change: 'added' },
    ]);
    expect(got.doc.sections.find((s: any) => s.id === 'design').codeRefs.map((c: any) => c.path)).toEqual([`src/${spec}/a.ts`, `src/${spec}/new.ts`]);
    expect((await fail('work_order_touch', { ref, files: ['app:../etc/passwd'] })).code).toBe('invalid_path');
    // Graph: work order -> touches -> code; reverse touched_by; code_search and code_owner list the work order.
    const nb = await read('graph_neighbors', { uri: `mandate://code/app/src/${spec}/new.ts`, direction: 'in', kinds: ['touches'] });
    expect(nb.nodes.map((n: any) => n.uri)).toContain(`mandate://work-orders/${id}`);
    const cs = await read('code_search', { repo: 'app', path: `src/${spec}/new.ts` });
    expect(cs.workOrders.map((w: any) => w.workOrder)).toContain(`mandate://work-orders/${id}`);
    const owner = await read('code_owner', { repo: 'app', path: `src/${spec}/b.ts` });
    expect(owner.workOrders.map((w: any) => w.id)).toContain(id);
    // claim_overlap: another open work order (other spec) touching the same file warns, never fails.
    const other = await setup({ plan: 'p' });
    await ok('work_order_touch', { ref: other.ref, files: [`app:src/${spec}/new.ts`] });
    const cl = await ok('work_order_claim', { ref: other.ref }, 'agent-2');
    expect(cl.warnings.join()).toContain(`claim_overlap: work order ${id}`);
    expect(cl.overlaps[0]).toMatchObject({ workOrder: id, files: [`app:src/${spec}/new.ts`] });
  });

  it('git context: per-repo merge, several repos, graph lookups by branch, sha and PR, search', async () => {
    const { ref, id } = await setup({ plan: 'p' });
    const branch = `wo/${id.slice(-6)}`;
    await ok('work_order_claim', { ref, branch, git: [{ repo: 'app', baseBranch: 'main', baseCommit: 'aaaa1111', worktree: { path: '/tmp/wt', host: 'laptop' } }] });
    await ok('work_order_git_update', { ref, repo: 'app', headCommit: 'bbbb2222', commits: ['bbbb1111'] }, AGENT);
    await ok('work_order_git_update', { ref, repo: 'app', branch, headCommit: 'bbbb3333', pr: { number: 4242, status: 'draft', url: 'https://example.com/pr/4242' } });
    await ok('work_order_git_update', { ref, repo: 'web', branch: `${branch}-web`, headCommit: 'cccc1111' });
    const g = (await read('work_order_get', { ref })).git;
    expect(g).toEqual([
      { repo: 'app', baseBranch: 'main', baseCommit: 'aaaa1111', worktree: { path: '/tmp/wt', host: 'laptop' }, headCommit: 'bbbb3333', commits: ['bbbb1111', 'bbbb2222', 'bbbb3333'], branch, pr: { number: 4242, status: 'draft', url: 'https://example.com/pr/4242' } },
      { repo: 'web', branch: `${branch}-web`, headCommit: 'cccc1111', commits: ['cccc1111'] },
    ]);
    const wo = `mandate://work-orders/${id}`;
    const byBranch = await read('graph_neighbors', { uri: `mandate://branches/${encodeURIComponent(branch)}`, direction: 'in', kinds: ['on_branch'] });
    expect(byBranch.nodes.map((n: any) => n.uri)).toContain(wo);
    const bySha = await read('graph_neighbors', { uri: 'mandate://code-commits/app/bbbb2222', direction: 'out', kinds: ['implements'] });
    expect(bySha.nodes.map((n: any) => n.uri)).toContain(wo);
    const pr = await read('graph_node', { uri: 'mandate://prs/app/4242' });
    expect(pr.node).toMatchObject({ kind: 'pull_request', props: { status: 'draft', workOrder: wo } });
    const byPr = await read('graph_neighbors', { uri: 'mandate://prs/app/4242', direction: 'in', kinds: ['has_pr'] });
    expect(byPr.nodes.map((n: any) => n.uri)).toContain(wo);
    const found = await read('search', { q: 'bbbb2222', mode: 'text', limit: 5 });
    expect(JSON.stringify(found)).toContain(wo);
    // PR merged after the fact: merged_as code commit -> implements.
    await ok('work_order_complete', { ref, outcome: 'Done.' });
    await ok('work_order_git_update', { ref, repo: 'app', pr: { status: 'merged', mergedCommit: 'dddd4444' } });
    const merge = await read('graph_neighbors', { uri: 'mandate://code-commits/app/dddd4444', direction: 'both' });
    expect(merge.nodes.map((n: any) => n.uri)).toEqual(expect.arrayContaining([wo, 'mandate://prs/app/4242']));
  });

  it('touch_from_commits reads a local code repo; unavailable repos give a clear error', async () => {
    const { ref } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    const base = sh(code, 'rev-parse', 'HEAD');
    await writeFile(path.join(code, 'a.ts'), 'one\nTWO\nthree\nfour\n');
    sh(code, 'mv', 'old.ts', 'renamed.ts');
    await writeFile(path.join(code, 'b.ts'), 'new\n');
    sh(code, 'add', '-A');
    sh(code, 'commit', '-q', '-m', 'change');
    const head = sh(code, 'rev-parse', 'HEAD');
    const r = await ok('work_order_touch_from_commits', { ref, repo: 'app', range: `${base}..${head}`, section: 'design' });
    expect(r.codeCommits).toEqual([head]);
    const by = Object.fromEntries((r.workOrder.touched as any[]).map((t) => [t.path, t]));
    expect(by['a.ts']).toMatchObject({ change: 'modified', lines: ['2', '4'].length ? expect.any(Array) : [], commits: [head] });
    expect(by['renamed.ts']).toMatchObject({ change: 'renamed', from: 'old.ts' });
    expect(by['b.ts']).toMatchObject({ change: 'added', lines: ['1'] });
    expect(r.workOrder.git.find((g: any) => g.repo === 'app')).toMatchObject({ headCommit: head, commits: [head] });
    const e = await fail('work_order_touch_from_commits', { ref, repo: 'other', commits: ['abcd1234'] });
    expect(e.code).toBe('code_repo_unavailable');
    expect(e.message).toContain('work_order_touch');
  });

  it('migrated audit fix work orders keep a plan stub; audit_findings_to_work_orders writes one', async () => {
    const fix = (await fx.storage.workOrderService.list()).find((w) => w.kind === 'fix' && w.findings?.length);
    if (fix) expect(fix.hasPlan).toBe(true);
  });
});

describe('comments', () => {
  it('threads, replies, resolve / reopen replay, the open_comments gate and the frozen rule', async () => {
    const { ref, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    const before = commitCount();
    const c1 = await ok('comment_add', { target: `${ref}/sections/design`, body: 'The callback does not check state. @impl@test please fix.', blocking: true }, 'reviewer');
    expect(c1.uri).toMatch(/^mandate:\/\/comments\/c-/);
    expect(commitCount()).toBe(before + 1);
    expect(sh(fx.dir, 'show', '--stat', '--format=%B', 'HEAD')).toContain('comments.jsonl');
    expect(sh(fx.dir, 'show', '--stat', '--format=', 'HEAD')).not.toContain('work-orders/');
    const c2 = await ok('comment_add', { target: ref, body: 'Nit: rename the helper.' }, 'reviewer');
    const reply = await ok('comment_add', { target: ref, parent: c1.comment.id, body: 'Fixed in abc1234.' });
    expect(reply.comment.target).toBe(`${ref}/sections/design`);
    expect((await fail('comment_add', { target: ref, parent: c1.comment.id, body: 'x', blocking: true })).code).toBe('validation');
    const list = await read('comments_list', { target: ref });
    expect(list.counts).toEqual({ open: 2, openBlocking: 1, resolved: 0 });
    expect(list.threads.find((t: any) => t.id === c1.comment.id).replies.map((r: any) => r.body)).toEqual(['Fixed in abc1234.']);
    expect((await read('comments_list', { target: `${ref}/sections/design` })).threads).toHaveLength(1);
    expect((await read('work_order_get', { ref })).comments.counts).toEqual({ open: 2, openBlocking: 1, resolved: 0 });
    // Blocking comments gate completion.
    const gate = await fail('work_order_complete', { ref, outcome: 'Done.' });
    expect(gate.code).toBe('open_comments');
    expect(gate.detail!.threads.map((t: any) => t.id)).toEqual([c1.comment.id]);
    // Resolve (through a reply id), idempotent; reopen; resolve again.
    const res = await ok('comment_resolve', { id: reply.comment.id, note: 'Verified.' }, 'reviewer');
    expect(res.thread).toMatchObject({ id: c1.comment.id, status: 'resolved', resolvedBy: 'reviewer', resolveNote: 'Verified.' });
    const n = commitCount();
    expect((await ok('comment_resolve', { id: c1.comment.id }, 'reviewer')).warnings).toEqual(['already resolved']);
    expect(commitCount()).toBe(n);
    expect((await ok('comment_reopen', { id: `mandate://comments/${c1.comment.id}` }, 'reviewer')).thread.status).toBe('open');
    await ok('comment_resolve', { id: c1.comment.id }, 'reviewer');
    const t = (await read('comments_list', { target: ref, includeResolved: true })).threads.find((x: any) => x.id === c1.comment.id);
    expect(t.events.map((e: any) => e.type)).toEqual(['resolve', 'reopen', 'resolve']);
    // Append-only.
    await expect(fx.storage.commentService.repo.update(c1.comment.id, { body: 'edited' } as never)).rejects.toMatchObject({ code: 'append_only' });
    // Non-blocking open threads only warn.
    const done = await ok('work_order_complete', { ref, outcome: 'Done.' });
    expect(done.warnings.join()).toContain(c2.uri);
    // Frozen: replies yes, new threads and reopen no; resolve yes.
    expect((await fail('comment_add', { target: ref, body: 'Late issue.' }, 'reviewer')).code).toBe('work_order_frozen');
    await ok('comment_add', { target: ref, parent: c2.comment.id, body: 'Agreed, later.' });
    expect((await fail('comment_reopen', { id: c1.comment.id }, 'reviewer')).code).toBe('work_order_frozen');
    await ok('comment_resolve', { id: c2.comment.id }, 'reviewer');
    // Graph and activity.
    const node = await read('graph_node', { uri: c1.uri });
    expect(node.node).toMatchObject({ kind: 'comment', props: { status: 'resolved', blocking: true } });
    const nb = await read('graph_neighbors', { uri: c1.uri, direction: 'both' });
    expect(nb.edges.map((e: any) => `${e.kind}:${e.to}`)).toEqual(expect.arrayContaining([`comments_on:${ref}/sections/design`, `reply_to:${c1.uri}`]));
    const act = await read('activity_list', { ref: `mandate://work-orders/${id}`, types: ['comment.*'], limit: 50 });
    const types = act.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['comment.added', 'comment.resolved', 'comment.reopened']));
    expect((await fail('comment_add', { target: 'mandate://work-orders/wo-nope', body: 'x' })).code).toBe('not_found');
  });

  it('write tools need write access; comments_list works read-only', async () => {
    const { ref } = await setup({ plan: 'p' });
    const { callTool } = await import('../../src/mcp/define.js');
    const { TOOLS } = await import('../../src/mcp/server.js');
    const base = { storage: fx.storage, index: fx.index, reads: fx.reads } as never;
    for (const name of ['comment_add', 'work_order_plan_set', 'work_order_touch', 'work_order_git_update']) {
      const def = TOOLS.find((t) => t.name === name)!;
      const args = name === 'comment_add' ? { target: ref, body: 'x', agent: 'x' } : name === 'work_order_plan_set' ? { ref, plan: 'x', agent: 'x' } : name === 'work_order_touch' ? { ref, files: ['app:x.ts'], agent: 'x' } : { ref, repo: 'app', agent: 'x' };
      const ui = await callTool(def, args, { ...(base as object), principal: { kind: 'ui', user: { login: 'u' } } } as never);
      expect((ui.structuredContent as any).error.code, name).toBe('forbidden');
      const ro = await callTool(def, args, { ...(base as object), access: 'read' } as never);
      expect((ro.structuredContent as any).error.code, name).toBe('forbidden');
    }
    const listDef = TOOLS.find((t) => t.name === 'comments_list')!;
    expect((await callTool(listDef, { target: ref }, { ...(base as object), access: 'read' } as never)).isError).toBeFalsy();
  });
});

describe('activity', () => {
  it('plan_set, touched and git updates are events; heartbeats are not', async () => {
    const { ref, id } = await setup({ plan: 'p' });
    await ok('work_order_claim', { ref });
    await ok('work_order_plan_set', { ref, plan: 'p2' });
    await ok('work_order_touch', { ref, files: ['app:src/z.ts'] });
    await ok('work_order_git_update', { ref, repo: 'app', headCommit: 'eeee5555' });
    await ok('work_order_heartbeat', { ref });
    const act = await read('activity_list', { ref: `mandate://work-orders/${id}`, limit: 50 });
    const types = act.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['work_order.created', 'work_order.claimed', 'work_order.plan_set', 'work_order.touched', 'work_order.git_updated']));
    expect(types).not.toContain('work_order.heartbeat');
  });
});
