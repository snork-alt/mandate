/**
 * Regression tests for the Fable review of MCP write tools (plans/fable-data-review.md part 5, MW-*) and the code
 * issues found by the data-fix agent (plans/fable-data-fixes.md, DF-*). One test per finding, named after its id.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createComponentSchema, createSpecSchema, createStandardSchema, isClaimStale, USER_TRAILER, verificationRecordInputSchema, workOrderGitUpdateInputSchema } from '@mandate/shared';
import { createStorage, specCodec, type CommitMeta, type Storage } from '../src/storage/index.js';
import { DocWriteService } from '../src/storage/doc-writes.js';
import { MemoryHeartbeats, SqliteHeartbeats, effectiveHeartbeat } from '../src/storage/heartbeats.js';
import { resolveCauses } from '../src/storage/causes.js';
import { deriveCommitEvents } from '../src/events/derive.js';
import { TOOLS } from '../src/mcp/server.js';
import { memorySettings } from '../src/projects/settings.js';
import { checkIntegrity } from '../src/storage/integrity.js';
import { DocReadService } from '../src/storage/read.js';
import { callTool, defineTool, type ToolContext } from '../src/mcp/define.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const sec = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), body: `${id} body`, ...extra });
const crit = (id: string, extra: object = {}) => ({ id, title: id, type: 'acceptance', method: 'review', body: `${id} holds`, ...extra });
const rule = (id: string, extra: object = {}) => ({ id, title: id, type: 'rule', level: 'must', rationale: 'because', body: `${id} holds`, ...extra });
const link = (to: string, rel: string, extra: object = {}) => ({ to, rel, ...extra });
const ref = (repo: string, p: string) => ({ repo, path: p });
const S = (id: string, sid?: string) => `mandate://specs/${id}${sid ? `/sections/${sid}` : ''}`;
const T = (id: string, sid?: string) => `mandate://standards/${id}${sid ? `/sections/${sid}` : ''}`;
const as = (agent: string, extra: CommitMeta = {}): CommitMeta => ({ agent, ...extra });

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const docs = new DocWriteService(storage);
  const spec = (id: string, sections: object[], extra: object = {}, meta: CommitMeta = {}) => storage.specs.create(createSpecSchema.parse({ id, title: id, sections, ...extra }), meta);
  const std = (id: string, sections: object[], extra: object = {}) => storage.standards.create(createStandardSchema.parse({ id, title: id, sections, ...extra }));
  const pass = (criterion: string, appliedTo?: string, repo = 'app') =>
    storage.verificationService.record({ criterion, ...(appliedTo ? { appliedTo } : {}), result: 'pass', method: 'review', code: { repo, commit: 'abc1234' }, by: 'ci' });
  const feedback = async (target: string, meta: CommitMeta, accept = true) => {
    const f = await storage.feedbackService.create({ targets: [target], kind: 'question', body: 'approve?' }, meta);
    if (accept) await storage.feedbackService.update(f.id, { status: 'accepted' }, meta);
    return f.id;
  };
  /** An implement work order with a plan, claimed by `agent` (the spec counts as claimed). */
  const claimed = async (specId: string, sections: string[], agent = 'agent-a') => {
    const w = await storage.workOrderService.create({ spec: specId, kind: 'implement', status: 'pending', sections: sections.map((id) => ({ id })), plan: 'the plan' });
    return storage.workOrderService.claim({ id: w.id, agent });
  };
  return { git, storage, docs, spec, std, pass, feedback, claimed };
}

/** A completed spec audit with one fail finding per given item (code refs as given). */
async function auditWithFindings(storage: Storage, target: string, items: { ref: string; codeRefs?: string[] }[]) {
  const a = await storage.auditService.start({ target, overview: 'scope' }, { agent: 'auditor' });
  const plan = a.sections.filter((s) => s.type === 'audit-item');
  for (const s of plan) {
    const it = items.find((i) => i.ref === (s as { ref?: string }).ref);
    if (it) await storage.auditService.recordItem({ auditId: a.id, ref: it.ref, result: 'fail', notes: 'checked the code', findings: [{ title: `bad ${s.id}`, description: 'wrong', classification: 'code_deviates', codeRefs: it.codeRefs ?? [] }] });
    else await storage.auditService.recordItem({ auditId: a.id, ref: (s as { ref: string }).ref, result: 'pass' });
  }
  await storage.auditService.complete({ auditId: a.id, summary: 'done' });
  return storage.audits.get(a.id);
}

const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('expected the write to fail');
};

describe('fable write review: MW-*', () => {
  it('MW-1: concurrent section writes do not lose updates', async () => {
    const { storage, docs, spec } = await setup();
    await spec('s', [sec('a'), sec('b'), sec('c')]);
    await Promise.all([
      docs.sectionUpdate('specs', S('s', 'a'), { body: 'BODY-FROM-A' }, as('x')),
      docs.sectionInsert('specs', 's', { title: 'New one', body: 'n' } as never, {}, as('y')),
      docs.sectionArchive('specs', S('s', 'c'), as('z')),
      docs.sectionUpdate('specs', S('s', 'b'), { summary: 'B summary' }, as('w')),
    ]);
    const s = await storage.specs.get('s');
    expect(s.sections.find((x) => x.id === 'a')!.body).toBe('BODY-FROM-A');
    expect(s.sections.find((x) => x.id === 'b')!.summary).toBe('B summary');
    expect(s.sections.find((x) => x.id === 'c')!.archived).toBe(true);
    expect(s.sections.some((x) => x.id === 'new-one')).toBe(true);
    // Audits: parallel item records, then parallel re-check / feedback link on one completed audit.
    await spec('t', [crit('c1'), crit('c2'), crit('c3')]);
    const a = await storage.auditService.start({ target: S('t'), overview: 'scope' }, { agent: 'auditor' });
    const finding = (n: string) => ({ title: n, description: 'd', classification: 'code_deviates' as const });
    await Promise.all([
      storage.auditService.recordItem({ auditId: a.id, ref: S('t', 'c1'), result: 'fail', notes: 'n', findings: [finding('f-a')] }),
      storage.auditService.recordItem({ auditId: a.id, ref: S('t', 'c2'), result: 'fail', notes: 'n', findings: [finding('f-b')] }),
      storage.auditService.recordItem({ auditId: a.id, ref: S('t', 'c3'), result: 'pass' }),
    ]);
    const recorded = await storage.audits.get(a.id);
    expect(recorded.sections.filter((x) => x.type === 'audit-item').map((x) => (x as { result?: string }).result).sort()).toEqual(['fail', 'fail', 'pass']);
    await storage.auditService.complete({ auditId: a.id, summary: 's' });
    const [f1, f2] = recorded.sections.flatMap((x) => x.findings ?? []).map((f) => f.id);
    const fb = await storage.feedbackService.create({ targets: [S('t', 'c2')], kind: 'question', body: 'q' }, as('x'));
    await Promise.all([
      storage.auditService.recheck({ auditId: a.id, findingId: f1!, result: 'wont_fix', notes: 'accepted' }, 'u'),
      storage.auditService.linkFeedback(`mandate://audits/${a.id}/findings/${f2}`, fb.id, 'u'),
    ]);
    const after = (await storage.audits.get(a.id)).sections.flatMap((x) => x.findings ?? []);
    expect(after.find((f) => f.id === f1)!.resolution?.status).toBe('wont_fix');
    expect(after.find((f) => f.id === f2)!.resolution?.feedback).toBe(fb.id);
  });

  it('MW-2: waiver approval compares server-resolved principals, never raw agent strings', async () => {
    const { storage, docs, spec, std, feedback } = await setup();
    await std('ui', [rule('contrast')]);
    await spec('s', [sec('a'), sec('b'), sec('c')]);
    // Local mode: agent identities, trimmed and case-folded.
    const fbAlice = await feedback(S('s', 'a'), as('alice'));
    const caseVariant = await errOf(docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: fbAlice }, as(' Alice ')));
    expect(caseVariant.message).toMatch(/same author/);
    await docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: fbAlice }, as('bob'));
    // Server mode: the user (Mandate-User, from the principal) decides, whatever the agent string says.
    const user = (u: string, agent: string) => as(agent, { trailers: { [USER_TRAILER]: u } });
    const fbGiulia = await feedback(S('s', 'b'), user('giulia', 'claude-code'));
    const sameUser = await errOf(docs.linkAdd('specs', S('s', 'b'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: fbGiulia }, user('Giulia', 'other-agent')));
    expect(sameUser.message).toMatch(/same author/);
    // Another user with the SAME agent string is someone else.
    await docs.linkAdd('specs', S('s', 'b'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: fbGiulia }, user('marco', 'claude-code'));
    const stored = (await storage.specs.get('s')).sections.find((x) => x.id === 'b')!.links.find((l) => l.rel === 'deviates_from')!;
    expect(stored.by).toBe('marco');
    // Exemptions use the same rule.
    await std('tagged', [rule('r')], { appliesTo: ['tag:api'] });
    await spec('e', [sec('a')], { tags: ['api'] });
    const fbE = await feedback(S('e', 'a'), as('alice'));
    const ex = await errOf(docs.updateMeta('specs', 'e', { exemptFrom: [{ standard: 'tagged', reason: 'r', feedback: fbE }] }, as('ALICE')));
    expect(ex.message).toMatch(/same author/);
  });

  it('MW-3: an unrelated cycle never hides a new cycle; exact document matching', async () => {
    const { storage, docs, spec, git } = await setup();
    await spec('aa-two', [sec('s')]);
    await spec('aa-one', [sec('s', { links: [link(S('aa-two', 's'), 'depends_on')] })]);
    // An outside commit (as a pull would bring in) closes aa-one <-> aa-two.
    const two = await storage.specs.get('aa-two');
    const raw = specCodec.encode({ ...two, sections: [{ ...two.sections[0]!, links: [link(S('aa-one', 's'), 'depends_on')] }] } as never);
    await writeFile(path.join(git.dir, 'specs/aa-two.md'), raw);
    await git.commit(['specs/aa-two.md'], 'outside: close a cycle');
    await spec('zz-two', [sec('s')]);
    await spec('zz-one', [sec('s', { links: [link(S('zz-two', 's'), 'depends_on')] })]);
    const e = await errOf(docs.linkAdd('specs', S('zz-two', 's'), { to: S('zz-one', 's'), rel: 'depends_on' }, as('x')));
    expect(e.message).toMatch(/cycle/);
    // `specs/aa` is not `specs/aa-one`: a prefix never blocks another document.
    await spec('aa', [sec('s')]);
    await docs.sectionUpdate('specs', S('aa', 's'), { body: 'edited' }, as('x'));
  });

  it('MW-4: by design, a section that follows a whole standard may deviate from one of its sections (the waiver shape)', async () => {
    const { storage, docs, spec, std } = await setup();
    await std('ui', [rule('contrast'), rule('focus')]);
    await spec('s', [sec('a', { links: [link(T('ui'), 'follows')] })]);
    await docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'not yet' }, as('x'));
    // Without approval nothing is waived: the criterion stays in force.
    const v = await storage.verificationService.forSpec(await storage.specs.get('s'));
    const c = v.inherited.flatMap((g) => g.criteria).find((x) => x.uri === T('ui', 'contrast'))!;
    expect(c.waiver).toMatchObject({ effective: false, reason: 'no_feedback' });
  });

  it('MW-5: archived sections are frozen (link add / remove, restore)', async () => {
    const { storage, docs, spec } = await setup();
    await spec('other', [sec('t')]);
    await spec('s', [sec('a', { links: [link(S('other', 't'), 'relates_to')] }), sec('b')]);
    await docs.sectionArchive('specs', S('s', 'a'), as('x'));
    expect((await errOf(docs.linkAdd('specs', S('s', 'a'), { to: S('other', 't'), rel: 'depends_on' }, as('x')))).message).toMatch(/archived/);
    expect((await errOf(docs.linkRemove('specs', S('s', 'a'), { to: S('other', 't') }, as('x')))).message).toMatch(/archived/);
    const cur = await storage.specs.get('s');
    const restore = await errOf(storage.specs.update('s', { sections: cur.sections.map((x) => ({ ...x, archived: false })) } as never));
    expect(restore.message).toMatch(/never restored/);
    // Moving it is allowed (position only).
    await docs.sectionMove('specs', S('s', 'a'), { position: 'last' }, as('x'));
  });

  it('MW-6: criteria removed through a standard write need accepted feedback when a spec is done or claimed', async () => {
    const { storage, docs, spec, std, claimed, feedback } = await setup();
    await std('sec', [rule('r1'), rule('r2')]);
    await spec('s', [sec('a', { links: [link(T('sec'), 'follows')] })], { status: 'ready' });
    await claimed('s', ['a']);
    const e = await errOf(docs.sectionArchive('standards', T('sec', 'r2'), as('x')));
    expect(e.code).toBe('criteria_shrink');
    const fb = await feedback(T('sec', 'r2'), as('user'));
    await docs.sectionArchive('standards', T('sec', 'r2'), as('x', { trailers: { Feedback: fb } }));
    expect((await storage.standards.get('sec')).sections.find((x) => x.id === 'r2')!.archived).toBe(true);
  });

  it('MW-7: no verification for an archived criterion, no work order on an archived section', async () => {
    const { storage, docs, spec, pass } = await setup();
    await spec('s', [sec('a'), crit('ac')]);
    await docs.sectionArchive('specs', S('s', 'ac'), as('x'));
    expect((await errOf(pass(S('s', 'ac')))).message).toMatch(/archived/);
    await docs.sectionArchive('specs', S('s', 'a'), as('x'));
    expect((await errOf(storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] }))).message).toMatch(/archived/);
  });

  it("MW-8: a deprecated standard's sections are not live successors", async () => {
    const { storage, docs, std } = await setup();
    await std('api', [rule('example')]);
    await std('successor', [rule('s')]);
    await std('old', [rule('o', { links: [link(T('api', 'example'), 'supersedes')] })]);
    await docs.setStandardStatus('old', 'deprecated', 'successor', as('x'));
    await std('next', [rule('n')]);
    await docs.linkAdd('standards', T('next', 'n'), { to: T('api', 'example'), rel: 'supersedes' }, as('x'));
    expect((await storage.standards.get('next')).sections[0]!.links).toHaveLength(1);
  });

  it('MW-9: archived components are frozen', async () => {
    const { storage, docs } = await setup();
    await storage.components.create(createComponentSchema.parse({ id: 'legacy', title: 'Legacy', kind: 'module', owns: [{ repo: 'app', paths: ['src/legacy/**'] }], sections: [sec('job')] }));
    await docs.setComponentStatus('legacy', 'deprecated', as('x'));
    await docs.setComponentStatus('legacy', 'archived', as('x'));
    expect((await errOf(docs.sectionInsert('components', 'legacy', { title: 'More', body: 'b' } as never, {}, as('x')))).message).toMatch(/archived/);
    expect((await errOf(docs.sectionUpdate('components', 'mandate://components/legacy/sections/job', { body: 'b2' }, as('x')))).message).toMatch(/archived/);
    expect((await errOf(docs.updateMeta('components', 'legacy', { title: 'Renamed after archive' }, as('x')))).message).toMatch(/archived/);
  });

  it('MW-10: component writes emit typed component.* activity events', async () => {
    const { storage, docs, git } = await setup();
    await storage.components.create(createComponentSchema.parse({ id: 'billing', title: 'Billing', kind: 'module', owns: [{ repo: 'app', paths: ['src/billing/**'] }], sections: [sec('job')] }));
    const created = await deriveCommitEvents(git, (await git.head())!);
    expect(created.map((e) => e.type)).toContain('component.created');
    await docs.sectionUpdate('components', 'mandate://components/billing/sections/job', { body: 'new job' }, as('x'));
    expect((await deriveCommitEvents(git, (await git.head())!)).map((e) => e.type)).toContain('component.section.updated');
    await docs.setComponentStatus('billing', 'deprecated', as('x'));
    expect((await deriveCommitEvents(git, (await git.head())!)).map((e) => e.type)).toContain('component.status_changed');
  });

  it('MW-11: section_done validates every input before the first commit', async () => {
    const { storage, git, spec, claimed } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = await claimed('s', ['a']);
    const head = await git.head();
    await errOf(storage.workOrderService.sectionDone({ id: w.id, agent: 'agent-a', sections: ['a'], codeRefs: [{ repo: 'app', path: 'src/x.ts', change: 'renamed' }] as never }));
    expect(await git.head()).toBe(head);
    expect((await storage.specs.get('s')).sections[0]!.implementedCommit).toBeUndefined();
  });

  it('MW-12: section_done and complete need the claim', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], plan: 'p' });
    expect((await errOf(storage.workOrderService.sectionDone({ id: w.id, agent: 'mallory', sections: ['a'] }))).code).toBe('not_claimed');
    expect((await errOf(storage.workOrderService.complete(w.id, 'mallory', { outcome: 'o' }))).code).toBe('not_claimed');
    await storage.workOrderService.claim({ id: w.id, agent: 'agent-a' });
    expect((await errOf(storage.workOrderService.complete(w.id, 'mallory', { outcome: 'o' }))).code).toBe('claimed');
    expect((await storage.workOrderService.complete(w.id, 'agent-a', { outcome: 'o' })).workOrder.status).toBe('done');
  });

  it('MW-13: a claimed plan cannot be emptied; a failed work order without a plan can be reopened', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a'), sec('b')], { status: 'ready' });
    const w = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], plan: 'p' });
    await storage.workOrderService.claim({ id: w.id, agent: 'a' });
    expect((await errOf(storage.workOrderService.planSet(w.id, 'a', '   '))).message).toMatch(/cannot be emptied/);
    const bare = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'b' }] });
    await storage.workOrderService.close(bare.id, 'failed', 'a', 'gave up');
    expect((await storage.workOrderService.claim({ id: bare.id, agent: 'a' })).status).toBe('in_progress');
    expect((await storage.workOrderService.planSet(bare.id, 'a', 'now a plan')).hasPlan).toBe(true);
  });

  it('MW-14: wo-section verifications are verification results or criterion references', async () => {
    const { storage, spec, claimed, pass } = await setup();
    await spec('s', [sec('a'), crit('ac')], { status: 'ready' });
    const w = await claimed('s', ['a']);
    expect((await errOf(storage.workOrderService.sectionDone({ id: w.id, agent: 'agent-a', sections: ['a'], verifications: ['not a ref at all'] }))).message).toMatch(/verifications/);
    expect((await errOf(storage.workOrderService.sectionDone({ id: w.id, agent: 'agent-a', sections: ['a'], verifications: ['mandate://verifications/vr-9999'] }))).message).toMatch(/does not exist/);
    const vr = await pass(S('s', 'ac'));
    await storage.workOrderService.sectionDone({ id: w.id, agent: 'agent-a', sections: ['a'], verifications: [`mandate://verifications/${vr.id}`, S('s', 'ac')] });
  });

  it('MW-15: complete re-checks claim and blocking comments inside the write lock', async () => {
    const { storage, spec, claimed } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = await claimed('s', ['a']);
    // A blocking comment and a completion racing: the completion sees the comment (checked inside the lock).
    const [c, done] = await Promise.allSettled([
      storage.commentService.add({ target: `mandate://work-orders/${w.id}`, body: 'must fix', blocking: true }, { agent: 'reviewer' }),
      storage.workOrderService.complete(w.id, 'agent-a', { outcome: 'o' }),
    ]);
    expect(c.status).toBe('fulfilled');
    expect(done.status === 'rejected' ? (done.reason as { code: string }).code : 'done').toMatch(/open_comments|done/);
  });

  it('MW-16: code-repo shas given as input have at least 7 characters', async () => {
    expect(workOrderGitUpdateInputSchema.safeParse({ ref: 'q-0001', repo: 'app', headCommit: 'abcd' }).success).toBe(false);
    expect(workOrderGitUpdateInputSchema.safeParse({ ref: 'q-0001', repo: 'app', headCommit: 'abcd123' }).success).toBe(true);
    const code = (verificationRecordInputSchema as unknown as { _def: { schema?: { shape: { code: z.ZodTypeAny } } }; shape?: { code: z.ZodTypeAny } }).shape?.code ?? (verificationRecordInputSchema as never as { _def: { schema: { shape: { code: z.ZodTypeAny } } } })._def.schema.shape.code;
    expect(code.safeParse({ repo: 'app', commit: 'abcd' }).success).toBe(false);
    expect(code.safeParse({ repo: 'app', commit: 'abcd123' }).success).toBe(true);
  });

  it('MW-17: a Feedback trailer naming an unknown item is refused', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a')]);
    const e = await errOf(storage.specs.update('s', { title: 'x' } as never, { trailers: { Feedback: 'fb-9999' } }));
    expect(e.message).toMatch(/fb-9999/);
  });

  it('MW-18: verification code.repo must be a repository of the spec', async () => {
    const { spec, pass } = await setup();
    await spec('s', [sec('a', { refs: [ref('api', 'src/a.ts')] }), crit('ac')]);
    expect((await errOf(pass(S('s', 'ac'), undefined, 'nonexistent-repo'))).message).toMatch(/not a repository of s/);
    await pass(S('s', 'ac'), undefined, 'api');
  });

  it('MW-19: concurrent findings_to_work_orders calls create one fix work order', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('impl', { refs: [ref('app', 'src/a.ts')] }), crit('c1')], { status: 'ready' });
    const a = await auditWithFindings(storage, S('s'), [{ ref: S('s', 'c1'), codeRefs: ['app:src/a.ts'] }]);
    const [r1, r2] = await Promise.all([storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'x'), storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'y')]);
    expect(r1.workOrders.length + r2.workOrders.length).toBe(1);
    expect((await storage.workOrderService.list()).filter((w) => w.kind === 'fix')).toHaveLength(1);
  });

  it('MW-20: an unmappable finding is reported unassigned, never given an arbitrary section', async () => {
    const { storage, spec, std } = await setup();
    await std('base', [rule('r')]);
    await spec('s', [sec('impl', { refs: [ref('app', 'src/a.ts')] }), sec('other')], { status: 'ready', repo: 'app', tags: [] });
    await spec('u', [sec('x', { links: [link(T('base'), 'follows')], refs: [ref('app', 'src/u.ts')] })], { status: 'ready' });
    // Standard audit: the finding names code that a spec using the standard references, but no section of it follows
    // the rule and none references that code -> unassigned.
    const a = await auditWithFindings(storage, T('base'), [{ ref: T('base', 'r'), codeRefs: ['app:src/nowhere.ts'] }]);
    const out = await storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'x');
    expect(out.workOrders).toHaveLength(0);
    expect(out.unassigned).toHaveLength(1);
  });

  it('MW-21: the audit backlink commit carries no Work-Order cause trailer', async () => {
    const { storage, spec, git } = await setup();
    await spec('s', [sec('impl', { refs: [ref('app', 'src/a.ts')] }), crit('c1')], { status: 'ready' });
    const a = await auditWithFindings(storage, S('s'), [{ ref: S('s', 'c1'), codeRefs: ['app:src/a.ts'] }]);
    const out = await storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'x');
    const log = await storage.history.log(`audits/${a.id}.md`);
    const backlink = log.find((h) => h.subject.includes(`-> work order ${out.workOrders[0]!.id}`))!;
    expect(backlink.trailers['Work-Order']).toBeUndefined();
    expect(backlink.trailers['Fix-Work-Order']).toBe(out.workOrders[0]!.id);
    void git;
  });

  it('MW-22: comments cannot target audits', async () => {
    const { storage, spec } = await setup();
    await spec('s', [crit('c1')]);
    const a = await auditWithFindings(storage, S('s'), []);
    const e = await errOf(storage.commentService.add({ target: `mandate://audits/${a.id}`, body: 'hi' }, { agent: 'x' }));
    expect(e.code).toBe('invalid_target');
  });

  it('MW-23: spec-archive cascade commits keep attribution and are reported', async () => {
    const { storage, docs, spec } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], plan: 'p' });
    const out = await docs.setStatus('s', 'archived', as('a', { branch: 'br', trailers: { 'Agent-Key': 'k1' } }));
    expect(out.commits).toHaveLength(2);
    const wo = (await storage.workOrderService.list())[0]!;
    const cascade = (await storage.history.log(`work-orders/${wo.id}.md`)).find((h) => h.subject.includes('spec archived'))!;
    expect(cascade.trailers).toMatchObject({ Branch: 'br', 'Agent-Key': 'k1' });
  });

  it('MW-24: an idempotency key reused on another branch is a conflict, not a replay', async () => {
    const ctx = { storage: {}, index: null, reads: {}, clientName: 'c' } as unknown as ToolContext;
    const tool = defineTool({ name: 'mw24_write', title: 't', kind: 'write', description: 't', input: z.object({ id: z.string() }).strict(), run: async (a) => ({ id: a.id }) });
    const key = `k-${Date.now()}`;
    expect((await callTool(tool, { id: 'x', branch: 'b1', idempotencyKey: key }, ctx)).isError).toBeFalsy();
    const r = await callTool(tool, { id: 'x', branch: 'b2', idempotencyKey: key }, ctx);
    expect((r.structuredContent as { error?: { code: string } }).error?.code).toBe('idempotency_conflict');
  });

  it('MW-25: a cause naming an unknown work-order section is refused', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], plan: 'p' });
    await expect(resolveCauses(storage, `mandate://work-orders/${w.id}/sections/does-not-exist`)).rejects.toMatchObject({ code: 'invalid_cause' });
    expect(await resolveCauses(storage, `mandate://work-orders/${w.id}/sections/a`)).toHaveLength(1);
  });
});

describe('user-confirmed rules', () => {
  it('waiver_self_approved: approvals come from someone else; strict with several users', async () => {
    const { storage, docs, spec, std, claimed } = await setup();
    await std('ui', [rule('contrast'), rule('focus')]);
    await spec('s', [sec('a', { links: [link(T('ui'), 'follows')] })]);
    const filed = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'question', body: 'waive?' }, as('claude-code@ci'));
    await storage.feedbackService.update(filed.id, { status: 'accepted' }, as('snork-alt'));
    expect((await storage.feedback.get(filed.id)).acceptedBy).toBe('snork-alt');
    // The accepter writing the waiver itself (any case): refused; the filer too.
    expect((await errOf(docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: filed.id }, as('Snork-Alt')))).code).toBe('waiver_self_approved');
    expect((await errOf(docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: filed.id }, as('claude-code@ci')))).code).toBe('waiver_self_approved');
    // Filed by one agent, accepted by snork-alt, written by a third identity: effective.
    await docs.linkAdd('specs', S('s', 'a'), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: filed.id }, as('data-fix-agent'));
    const v = await storage.verificationService.forSpec(await storage.specs.get('s'));
    expect(v.inherited.flatMap((g) => g.criteria).find((c) => c.uri === T('ui', 'contrast'))!.waiver).toMatchObject({ effective: true });
    // Server mode: principals are users; exemptions follow the same rule.
    await std('tagged', [rule('r')], { appliesTo: ['tag:api'] });
    await spec('e', [sec('a')], { tags: ['api'] });
    const user = (u: string, agent: string) => as(agent, { trailers: { [USER_TRAILER]: u } });
    const fbE = await storage.feedbackService.create({ targets: [S('e', 'a')], kind: 'question', body: 'exempt?' }, user('giulia', 'claude-code'));
    await storage.feedbackService.update(fbE.id, { status: 'accepted' }, user('marco', 'claude-code'));
    expect((await errOf(docs.updateMeta('specs', 'e', { exemptFrom: [{ standard: 'tagged', reason: 'r', feedback: fbE.id }] }, user('MARCO', 'other')))).code).toBe('waiver_self_approved');
    // Criteria removal on a claimed spec: the accepter cannot approve its own removal.
    await spec('c', [sec('impl'), crit('ac')], { status: 'ready' });
    await claimed('c', ['impl']);
    const fbC = await storage.feedbackService.create({ targets: [S('c', 'ac')], kind: 'improvement', body: 'drop it' }, as('alice'));
    await storage.feedbackService.update(fbC.id, { status: 'accepted' }, as('bob'));
    expect((await errOf(docs.sectionArchive('specs', S('c', 'ac'), as('bob', { trailers: { Feedback: fbC.id } })))).code).toBe('waiver_self_approved');
    await docs.sectionArchive('specs', S('c', 'ac'), as('carol', { trailers: { Feedback: fbC.id } }));
  });

  it('self_approved_override: self-approval only with override + reason, for the sole active user or an admin', async () => {
    const { storage, docs, spec, std, git } = await setup();
    await std('ui', [rule('contrast')]);
    await spec('s', [sec('a', { links: [link(T('ui'), 'follows')] }), sec('b', { links: [link(T('ui'), 'follows')] }), sec('c', { links: [link(T('ui'), 'follows')] })]);
    const accept = TOOLS.find((t) => t.name === 'feedback_accept')!;
    const serverCtx = (login: string, admin = false) =>
      ({ storage, index: null, reads: new DocReadService(storage), clientName: 'claude-code', principal: { kind: 'user', login, project: 'test', via: 'pat', tokenId: 't', tokenName: 't' }, settings: { ...memorySettings(), isAdmin: () => admin } }) as unknown as ToolContext;
    const call = async (ctx: ToolContext, args: object) => (await callTool(accept, args, ctx)).structuredContent as { error?: { code: string; message: string } };
    const fileAs = async (u: string, sid: string) => (await storage.feedbackService.create({ targets: [S('s', sid)], kind: 'question', body: 'waive?' }, as('claude-code', { trailers: { [USER_TRAILER]: u } }))).id;
    const waive = (fb: string, u: string, sid: string) => docs.linkAdd('specs', S('s', sid), { to: T('ui', 'contrast'), rel: 'deviates_from', note: 'n', feedback: fb }, as('claude-code', { trailers: { [USER_TRAILER]: u } }));
    // Single active user (only "solo" writes): without the flag refused at the waiver, override needs a reason.
    const f1 = await fileAs('solo', 'a');
    expect((await call(serverCtx('solo'), { ref: f1 })).error).toBeUndefined();
    expect((await errOf(waive(f1, 'solo', 'a'))).code).toBe('waiver_self_approved');
    expect((await call(serverCtx('solo'), { ref: f1, override: true })).error?.code).toBe('validation');
    expect((await call(serverCtx('solo'), { ref: f1, override: true, overrideReason: 'I am the only user' })).error).toBeUndefined();
    await waive(f1, 'solo', 'a');
    // Recorded: trailer, activity event, integrity warning.
    const head = (await git.log(5)).find((c) => c.message.includes('Approval-Override'))!;
    expect(head.message).toMatch(/Approval-Override: I am the only user/);
    expect((await deriveCommitEvents(git, head.id)).map((e) => e.type)).toContain('approval.override');
    expect(checkIntegrity(await storage.model()).filter((i) => i.rule === 'self_approved_override').map((i) => i.uri)).toEqual([`mandate://feedback/${f1}`]);
    // Multi-user: another user wrote recently -> strict (override refused), unless admin.
    const f2 = await fileAs('other', 'b');
    expect((await call(serverCtx('solo'), { ref: f2, override: true, overrideReason: 'r' })).error?.code).toBe('override_not_allowed');
    expect((await call(serverCtx('solo', true), { ref: f2, override: true, overrideReason: 'admin decision' })).error).toBeUndefined();
    // No authenticated user (an agent without a GitHub principal): self-approval is refused.
    const f3 = (await storage.feedbackService.create({ targets: [S('s', 'c')], kind: 'question', body: 'w' }, as('me'))).id;
    const anon = { storage, index: null, reads: new DocReadService(storage), clientName: 'me', settings: memorySettings() } as unknown as ToolContext;
    const r = await callTool(accept, { ref: f3, agent: 'me', override: true, overrideReason: 'nobody' }, anon);
    expect((r.structuredContent as { error?: { code: string } }).error?.code).toBe('override_not_allowed');
  });

  it('ready_gate: a spec becomes ready only when every live section has an acceptance criterion', async () => {
    const { storage, docs, spec, std } = await setup();
    await std('base', [rule('r')]);
    await spec('s', [sec('overview'), sec('impl'), sec('ruled', { links: [link(T('base'), 'follows')] }), crit('ac')]);
    const e = await errOf(docs.setStatus('s', 'ready', as('x')));
    expect(e.code).toBe('ready_gate');
    expect(e.message).toMatch(/overview, impl/);
    expect(e.message).not.toMatch(/ruled/); // a followed rule is its criterion
    await docs.sectionUpdate('specs', S('s', 'overview'), { verifiedBy: ['ac'] }, as('x'));
    await docs.sectionArchive('specs', S('s', 'impl'), as('x'));
    expect((await docs.setStatus('s', 'ready', as('x'))).value.status).toBe('ready');
    void storage;
  });
});

describe('fable data fixes: DF-*', () => {
  it('DF-1: findings map to the owning section of their code ref', async () => {
    const { storage, spec, std } = await setup();
    await std('sec', [rule('r')]);
    // overview follows the rule, webhooks owns the finding's code: the fix targets webhooks.
    await spec('pay', [sec('overview', { links: [link(T('sec'), 'follows')] }), sec('webhooks', { refs: [ref('app', 'src/webhooks.ts')] })], { status: 'ready' });
    const a = await auditWithFindings(storage, T('sec'), [{ ref: T('sec', 'r'), codeRefs: ['app:src/webhooks.ts#L10'] }]);
    const out = await storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'x');
    expect(out.workOrders).toHaveLength(1);
    expect(out.workOrders[0]!.sections).toEqual(['webhooks']);
  });

  it('DF-2: a finding can be relinked to a replacement work order', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('impl', { refs: [ref('app', 'src/a.ts')] }), crit('c1')], { status: 'ready' });
    const a = await auditWithFindings(storage, S('s'), [{ ref: S('s', 'c1'), codeRefs: ['app:src/a.ts'] }]);
    const first = (await storage.auditService.findingsToWorkOrders({ auditId: a.id }, 'x')).workOrders[0]!;
    const fid = (await storage.audits.get(a.id)).sections.flatMap((s) => s.findings ?? [])[0]!.id;
    const repl = await storage.workOrderService.create({ spec: 's', kind: 'fix', status: 'pending', sections: [{ id: 'impl' }], plan: 'p' });
    // While the first one is live: refused.
    expect((await errOf(storage.auditService.relinkFinding({ auditId: a.id, findingId: fid, workOrder: repl.id }, 'x'))).code).toBe('finding_linked');
    await storage.workOrderService.close(first.id, 'cancelled', 'x', 'wrong section');
    const { previous } = await storage.auditService.relinkFinding({ auditId: a.id, findingId: fid, workOrder: repl.id }, 'x');
    expect(previous).toBe(first.id);
    const f = (await storage.audits.get(a.id)).sections.flatMap((s) => s.findings ?? []).find((x) => x.id === fid)!;
    expect(f.resolution?.workOrder).toBe(repl.id);
    expect((await storage.workOrderDocs.get(repl.id)).findings).toContain(`mandate://audits/${a.id}/findings/${fid}`);
  });

  it('DF-3: a claim already stale before a restart is reported stale, never fresh', async () => {
    const file = path.join(await tempDir(), 'rt.sqlite');
    const old = new Date(Date.now() - 20 * 3600_000).toISOString();
    const claim = { agent: 'a', startedAt: old };
    const s1 = new SqliteHeartbeats(file, Date.now() - 24 * 3600_000);
    s1.set('q-0001', 'a', old);
    s1.close();
    const s2 = new SqliteHeartbeats(file); // a restart a minute ago
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(s2, 'q-0001', claim) })).toBe(true);
    s2.close();
    // Unknown history (fresh clone / memory store): the restart grace still applies.
    expect(isClaimStale({ heartbeatAt: effectiveHeartbeat(new MemoryHeartbeats(), 'q-0001', claim) })).toBe(false);
    // Releasing someone else's stale claim says it is stale (take it over), not "fresh claim".
    const { storage, spec } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], plan: 'p' });
    await storage.workOrderService.claim({ id: w.id, agent: 'old' }, { date: new Date(Date.now() - 2 * 3600_000) });
    (storage.heartbeats as { startedAt: number }).startedAt = 0;
    expect((await errOf(storage.workOrderService.release({ id: w.id, agent: 'new' }))).code).toBe('stale_claim');
  });

  it('DF-6: adding a code ref to a claimed spec is not a criteria shrink', async () => {
    const { storage, docs, spec, std, claimed } = await setup();
    await std('scoped', [rule('only-a', { scope: { paths: ['src/a/**'] } })], { appliesTo: ['tag:api'] });
    await spec('s', [sec('impl')], { status: 'ready', tags: ['api'] });
    await claimed('s', ['impl']);
    await docs.sectionUpdate('specs', S('s', 'impl'), { refs: [ref('app', 'src/b/totp.ts')] }, as('x'));
    expect((await storage.specs.get('s')).sections[0]!.refs).toHaveLength(1);
    // Removing a criterion is still guarded.
    await docs.sectionInsert('specs', 's', { title: 'Crit', type: 'acceptance', method: 'review', body: 'holds' } as never, {}, as('x'));
    expect((await errOf(docs.sectionArchive('specs', S('s', 'crit'), as('x')))).code).toBe('criteria_shrink');
  });

  it('DF-7: feedback relatedTo accepts any resolvable element reference', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a'), crit('ac')]);
    const f = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'question', body: 'q' }, as('x'));
    await storage.feedbackService.update(f.id, { relatedTo: [S('s', 'ac')] }, as('x'));
    expect((await storage.feedback.get(f.id)).relatedTo).toEqual([S('s', 'ac')]);
    expect((await errOf(storage.feedbackService.update(f.id, { relatedTo: [S('s', 'missing')] }, as('x')))).message).toMatch(/does not exist/);
  });

  it('DF-9: a whole audit item can be re-checked on a completed audit', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('impl'), crit('c1'), crit('c2')]);
    const a = await auditWithFindings(storage, S('s'), [{ ref: S('s', 'c1') }]);
    expect((await errOf(storage.auditService.recheckItem({ auditId: a.id, item: S('s', 'c1'), result: 'pass', notes: '' }, 'x'))).message).toMatch(/notes/);
    const { item } = await storage.auditService.recheckItem({ auditId: a.id, item: S('s', 'c1'), result: 'partial', notes: 'half fixed', commit: 'abcdef1' }, 'x');
    expect(item.result).toBe('fail'); // the original result stays
    expect(item.itemRechecks).toEqual([expect.objectContaining({ result: 'partial', notes: 'half fixed', by: 'x' })]);
    const shared = await import('@mandate/shared');
    expect(shared.auditRecheckInputSchema.safeParse({ auditId: a.id, item: S('s', 'c2'), result: 'n_a', notes: 'gone' }).success).toBe(true);
    expect(shared.auditRecheckInputSchema.safeParse({ auditId: a.id, item: S('s', 'c2'), result: 'wont_fix', notes: 'x' }).success).toBe(false);
    expect(shared.auditRecheckInputSchema.safeParse({ auditId: a.id, findingId: 'f1', result: 'partial' }).success).toBe(false);
  });

  it('DF-10: feedback can target audit items and findings', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('impl'), crit('c1')]);
    const a = await auditWithFindings(storage, S('s'), [{ ref: S('s', 'c1') }]);
    const item = `mandate://audits/${a.id}/sections/c1`;
    const fid = a.sections.flatMap((x) => x.findings ?? [])[0]!.id;
    const finding = `mandate://audits/${a.id}/findings/${fid}`;
    const f = await storage.feedbackService.create({ targets: [item, finding], kind: 'question', body: 'is this right?' }, as('x'));
    const r = await storage.feedbackService.resolve(f.id);
    expect(r.targets.map((t) => t.kind)).toEqual(['audits', 'findings']);
    expect((await errOf(storage.feedbackService.create({ targets: [`mandate://audits/${a.id}/findings/f99`], kind: 'question', body: 'q' }, as('x')))).message).toMatch(/does not exist/);
  });

  it('DF-11: spec_create takes addresses (Feedback trailer)', async () => {
    const shared = await import('@mandate/shared');
    const tool = TOOLS.find((t) => t.name === 'spec_create')!;
    const args = { title: 'New', addresses: ['fb-0001'] };
    expect((tool.input as z.ZodTypeAny).safeParse(args).success).toBe(true);
    expect(tool.trailers?.(args as never)).toMatchObject({ Feedback: 'fb-0001' });
    void shared;
  });

  it('DF-12: closing feedback as applied needs a linked change', async () => {
    const { storage, docs, spec, git } = await setup();
    await spec('s', [sec('a')]);
    const f = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'improvement', body: 'b' }, as('x'));
    await storage.feedbackService.update(f.id, { status: 'accepted' }, as('x'));
    expect((await errOf(storage.feedbackService.update(f.id, { status: 'closed', resolution: 'applied' }, as('x')))).code).toBe('applied_without_changes');
    await docs.sectionUpdate('specs', S('s', 'a'), { body: 'applied' }, as('x', { trailers: { Feedback: f.id } }));
    await storage.feedbackService.update(f.id, { status: 'closed', resolution: 'applied' }, as('x'));
    // An explicit commit link (relatedTo) also counts; a cause trailer too.
    const g = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'improvement', body: 'c' }, as('x'));
    await storage.feedbackService.update(g.id, { status: 'accepted', relatedTo: [`mandate://commits/${(await git.head())!}`] }, as('x'));
    await storage.feedbackService.update(g.id, { status: 'closed', resolution: 'applied' }, as('x'));
    const h = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'improvement', body: 'd' }, as('x'));
    await docs.sectionUpdate('specs', S('s', 'a'), { body: 'caused' }, as('x', { trailers: { 'Caused-By': `mandate://feedback/${h.id}` } }));
    await storage.feedbackService.update(h.id, { status: 'closed', resolution: 'applied' }, as('x'));
  });
});
