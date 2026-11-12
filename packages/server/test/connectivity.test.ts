/**
 * The reviewed connectivity rules (plans/connectivity-review.md): C1-C4, C6, I2-I10 and the user
 * decisions (section-level standards, claims on work orders, feedback on verification results,
 * derived spec dependencies).
 */
import path from 'node:path';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema, createStandardSchema, standardUsage, type Section } from '@mandate/shared';
import { createStorage, deriveSpecs, derivedStatus, setSpecStatus, type CommitMeta } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const sec = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), body: `${id} body`, ...extra });
const crit = (id: string, extra: object = {}) => ({ id, title: id, type: 'acceptance', method: 'review', body: `${id} holds`, ...extra });
/** Standards hold rules (a must rule behaves like an acceptance criterion). */
const rule = (id: string, extra: object = {}) => ({ id, title: id, type: 'rule', level: 'must', rationale: 'because', body: `${id} holds`, ...extra });
const link = (to: string, rel: string, extra: object = {}) => ({ to, rel, ...extra });
const S = (id: string, sid?: string) => `mandate://specs/${id}${sid ? `/sections/${sid}` : ''}`;
const T = (id: string, sid?: string) => `mandate://standards/${id}${sid ? `/sections/${sid}` : ''}`;
const as = (name: string): CommitMeta => ({ author: { name, email: `${name}@example.com` } });

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const spec = (id: string, sections: object[], extra: object = {}, meta: CommitMeta = {}) =>
    storage.specs.create(createSpecSchema.parse({ id, title: id, sections, ...extra }), meta);
  const std = (id: string, sections: object[], extra: object = {}) => storage.standards.create(createStandardSchema.parse({ id, title: id, sections, ...extra }));
  const patch = async (id: string, f: (s: Section) => Section, extra: object = {}, meta: CommitMeta = {}) => {
    const cur = await storage.specs.get(id);
    return storage.specs.update(id, { sections: cur.sections.map(f), ...extra } as never, meta);
  };
  const pass = (criterion: string, appliedTo?: string) =>
    storage.verificationService.record({ criterion, ...(appliedTo ? { appliedTo } : {}), result: 'pass', method: 'review', code: { repo: 'app', commit: 'abc1234' }, by: 'ci' });
  const feedback = async (target: string, by: string, accept = true) => {
    const f = await storage.feedbackService.create({ targets: [target], kind: 'question', body: 'approve?' }, as(by));
    if (accept) await storage.feedbackService.update(f.id, { status: 'accepted' }, as(by));
    return f.id;
  };
  return { git, storage, spec, std, patch, pass, feedback };
}

describe('decision 1: standards are linked at section level, spec level is derived', () => {
  it('whole standard -> all criteria; standard section -> its criteria (+ extends); appliesTo -> spec-wide; provenance (I2)', async () => {
    const { storage, spec, std } = await setup();
    await std('base', [sec('rule', { verifiedBy: ['ac-rule'] }), rule('ac-rule'), rule('ac-other')]);
    await std('ext', [sec('more', { verifiedBy: ['ac-ext'], links: [link(T('base', 'rule'), 'extends')] }), rule('ac-ext'), rule('ac-unrelated')]);
    await std('tagged', [rule('ac-tag')], { appliesTo: ['tag:api'] });
    await spec('s', [sec('impl', { links: [link(T('ext', 'more'), 'follows')] }), sec('all', { links: [link(T('base'), 'follows')] })], { tags: ['api'] });
    const s = await storage.specs.get('s');
    const v = await storage.verificationService.forSpec(s);
    const uris = v.inherited.flatMap((g) => g.criteria.map((c) => c.uri)).sort();
    expect(uris).toEqual([T('base', 'ac-other'), T('base', 'ac-rule'), T('ext', 'ac-ext'), T('tagged', 'ac-tag')]);
    const acRule = v.inherited.flatMap((g) => g.criteria).find((c) => c.uri === T('base', 'ac-rule'))!;
    expect(acRule.sections!.sort()).toEqual(['all', 'impl']); // attached to the following sections
    const acTag = v.inherited.flatMap((g) => g.criteria).find((c) => c.uri === T('tagged', 'ac-tag'))!;
    expect(acTag).toMatchObject({ sections: [], path: ['appliesTo tag:api', 'tagged/ac-tag'] });
    const acExt = v.inherited.flatMap((g) => g.criteria).find((c) => c.uri === T('base', 'ac-other'))!;
    expect(acExt.path![0]).toBe('all follows base');
    // Derived spec-level standards with the sections that follow them.
    const derived = (await deriveSpecs([s], await storage.model(), storage.verificationService)).s!;
    expect(derived.standards.map((x) => [x.id, x.sections.map((y) => y.id), x.appliesBy])).toEqual([
      ['ext', ['impl'], []],
      ['base', ['all'], []],
      ['tagged', [], ['tag:api']],
    ]);
    expect(standardUsage(await storage.standards.get('base'), [s])[0]).toMatchObject({ sections: [{ id: 'all' }] });
    // Only spec sections may target a whole standard, and only with follows / deviates_from / relates_to.
    await expect(spec('bad', [sec('a', { links: [link(T('base'), 'depends_on')] })])).rejects.toMatchObject({ code: 'invalid_links' });
  });

  it('inherited staleness is tracked per following section', async () => {
    const { storage, spec, std, patch, pass } = await setup();
    await std('base', [rule('ac')]);
    await spec('s', [sec('impl', { links: [link(T('base'), 'follows')] })]);
    await pass(T('base', 'ac'), S('s'));
    expect((await storage.verificationService.forSpec(await storage.specs.get('s'))).inherited[0]!.criteria[0]!.state).toBe('verified');
    await patch('s', (x) => ({ ...x, body: 'rewritten' }));
    const c = (await storage.verificationService.forSpec(await storage.specs.get('s'))).inherited[0]!.criteria[0]!;
    expect(c).toMatchObject({ state: 'stale', staleReason: expect.stringMatching(/IMPL/) });
  });
});

describe('decision 2 + I5: claims live on work orders; spec in_progress is derived', () => {
  it('claims, heartbeats, releases; two agents on different sections of one spec; reason links feedback', async () => {
    const { storage, spec, feedback } = await setup();
    await spec('s', [sec('a'), sec('b')], { status: 'ready' });
    const fb = await feedback(S('s', 'a'), 'giulia');
    const w = storage.workOrderService;
    const one = await w.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }], reason: [fb] });
    const two = await w.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'b' }] });
    await expect(w.create({ spec: 's', kind: 'review', status: 'pending', sections: [{ id: 'a' }], reason: ['fb-nope'] })).rejects.toThrow(/fb-nope/);
    expect(derivedStatus(await storage.specs.get('s'), await storage.model())).toBe('ready');
    const c1 = await w.claim({ id: one.id, agent: 'agent-1', branch: 'b1' });
    expect(c1).toMatchObject({ status: 'in_progress', claim: { agent: 'agent-1', branch: 'b1' } });
    await w.claim({ id: two.id, agent: 'agent-2' });
    await expect(w.claim({ id: one.id, agent: 'agent-2' })).rejects.toMatchObject({ statusCode: 409, code: 'claimed' });
    expect(derivedStatus(await storage.specs.get('s'), await storage.model())).toBe('in_progress');
    const derived = (await deriveSpecs([await storage.specs.get('s')], await storage.model(), storage.verificationService)).s!;
    expect(derived.claims.map((c) => [c.workOrder, c.claim.agent, c.sections])).toEqual([
      [one.id, 'agent-1', ['a']],
      [two.id, 'agent-2', ['b']],
    ]);
    expect((await w.heartbeat({ id: one.id, agent: 'agent-1' })).claim!.heartbeatAt).toBeTruthy();
    await expect(w.heartbeat({ id: one.id, agent: 'agent-2' })).rejects.toMatchObject({ code: 'claimed' });
    expect((await w.release({ id: two.id, agent: 'agent-2' })).claim).toBeUndefined();
    expect((await w.resolve(one.id)).reasons).toEqual([expect.objectContaining({ id: fb, status: 'accepted' })]);
    // Closing drops the claim; stored spec files have no claim field.
    expect((await w.update(one.id, { status: 'cancelled' })).claim).toBeUndefined();
    expect(await storage.specs.raw('s')).not.toMatch(/claim:/);
  });

  it('a stale claim can be taken over', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a')], { status: 'ready' });
    const w = storage.workOrderService;
    const o = await w.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] });
    await w.claim({ id: o.id, agent: 'old' }, { date: new Date(Date.now() - 2 * 3600_000) });
    expect((await w.claim({ id: o.id, agent: 'new' })).claim!.agent).toBe('new');
  });
});

describe('decision 3 + I9: feedback on sections and verification results, exemptions', () => {
  it('targets verification results; whole documents are rejected', async () => {
    const { storage, spec, pass } = await setup();
    await spec('s', [crit('ac')]);
    const r = await pass(S('s', 'ac'));
    const f = await storage.feedbackService.create({ targets: [`mandate://verifications/${r.id}`], kind: 'bug', body: 'flaky pass' });
    const resolved = await storage.feedbackService.resolve(f.id);
    expect(resolved.targets[0]).toMatchObject({ kind: 'verifications', id: r.id, verification: { result: 'pass' } });
    await expect(storage.feedbackService.create({ targets: [S('s')], kind: 'bug', body: 'whole doc' })).rejects.toThrow();
  });

  it('an exemption from appliesTo needs accepted feedback by someone else', async () => {
    const { storage, spec, std, feedback } = await setup();
    await std('ui', [rule('ac-ui')], { appliesTo: ['tag:ui'] });
    await spec('s', [sec('a')], { tags: ['ui'] }, as('matteo'));
    const own = await feedback(T('ui', 'ac-ui'), 'matteo');
    await expect(storage.specs.update('s', { exemptFrom: [{ standard: 'ui', reason: 'headless', feedback: own }] }, as('matteo'))).rejects.toThrow(/someone other than matteo/);
    const other = await feedback(T('ui', 'ac-ui'), 'giulia');
    await storage.specs.update('s', { exemptFrom: [{ standard: 'ui', reason: 'headless', feedback: other }] }, as('matteo'));
    const v = await storage.verificationService.forSpec(await storage.specs.get('s'));
    expect(v.inherited).toEqual([]);
    expect(standardUsage(await storage.standards.get('ui'), [await storage.specs.get('s')])[0]).toMatchObject({ exempt: true, appliesBy: [] });
  });
});

describe('decision 4 + C6: spec dependencies are derived; one cycle check; broken dependencies', () => {
  it('derives dependsOn from section links and rejects cycles at section and document level', async () => {
    const { storage, spec, patch } = await setup();
    await spec('b', [sec('t'), sec('u')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on')] }), sec('v')]);
    expect((await deriveSpecs([await storage.specs.get('a')], await storage.model(), storage.verificationService)).a!.dependsOn).toEqual(['b']);
    // B/u depends on A/v: no section cycle, but a spec-level (derived) cycle -> rejected.
    await expect(patch('b', (x) => (x.id === 'u' ? { ...x, links: [{ to: S('a', 'v'), rel: 'depends_on' }] } : x))).rejects.toThrow(/cycle/);
    await expect(patch('b', (x) => (x.id === 't' ? { ...x, links: [{ to: S('a', 's'), rel: 'depends_on' }] } : x))).rejects.toThrow(/cycle/);
  });

  it('archived targets break dependencies; new links to archived sections are rejected', async () => {
    const { storage, spec, patch } = await setup();
    await spec('b', [sec('t'), sec('old')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on')] })]);
    expect((await storage.linkService.forDoc('specs', await storage.specs.get('a'))).sections.s).toMatchObject({ blocked: true, broken: false });
    await patch('b', (x) => (x.id === 't' ? { ...x, archived: true } : x));
    expect((await storage.linkService.forDoc('specs', await storage.specs.get('a'))).sections.s).toMatchObject({ blocked: false, broken: true });
    await patch('b', (x) => (x.id === 'old' ? { ...x, archived: true } : x));
    await expect(spec('c', [sec('x', { links: [link(S('b', 'old'), 'depends_on')] })])).rejects.toThrow(/archived/);
  });
});

describe('C1: gate snapshot, drift and criteria shrink', () => {
  it('records the snapshot at done, derives Drifted, and needs accepted feedback to shrink the criteria', async () => {
    const { storage, spec, std, patch, pass, feedback } = await setup();
    await spec('s', [sec('a'), crit('ac-1')], { status: 'ready' });
    await pass(S('s', 'ac-1'));
    const done = await setSpecStatus(storage, { id: 's', status: 'done' });
    expect(done.gate).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), criteria: [{ uri: S('s', 'ac-1'), state: 'verified' }] });
    const m = await storage.model();
    expect(await storage.verificationService.drift(await storage.specs.get('s'), m)).toEqual([]);
    // A standard that starts to apply later: done stays done, but Drifted.
    await std('new-rules', [rule('ac-new')]);
    await patch('s', (x) => (x.id === 'a' ? { ...x, links: [{ to: T('new-rules'), rel: 'follows' }] } : x));
    const drift = await storage.verificationService.drift(await storage.specs.get('s'), await storage.model());
    expect(drift.join(' ')).toMatch(/1 criteria added since done/);
    expect((await storage.specs.get('s')).status).toBe('done');
    // Shrinking (archiving a criterion, unfollowing) a done spec needs an accepted Feedback trailer.
    await expect(patch('s', (x) => (x.id === 'ac-1' ? { ...x, archived: true } : x))).rejects.toMatchObject({ code: 'criteria_shrink' });
    const fb = await feedback(S('s', 'ac-1'), 'giulia');
    await patch('s', (x) => (x.id === 'ac-1' ? { ...x, archived: true } : x), {}, { trailers: { Feedback: fb } });
    expect((await storage.verificationService.forSpec(await storage.specs.get('s'))).own).toEqual([]);
  });
});

describe('C2: waivers need approval by someone else and lapse when the criterion changes', () => {
  it('rejects self-approved waivers (abuse case), accepts others, and goes stale on change', async () => {
    const { storage, spec, std, feedback } = await setup();
    await std('ui', [sec('rules', { verifiedBy: ['ac-focus'] }), rule('ac-focus'), rule('ac-other')]);
    await spec('s', [sec('impl', { links: [link(T('ui'), 'follows')] })], {}, as('agent'));
    const state = async () => (await storage.verificationService.forSpec(await storage.specs.get('s'))).inherited[0]!.criteria.find((c) => c.uri === T('ui', 'ac-focus'))!;
    const deviate = (fb?: string) => ({ to: T('ui', 'rules'), rel: 'deviates_from', note: 'native palette rows', ...(fb ? { feedback: fb } : {}) });
    const withLink = (l: object) => async () => {
      const cur = await storage.specs.get('s');
      return cur.sections.map((x) => (x.id === 'impl' ? { ...x, links: [...x.links, l] } : x));
    };
    // 1. No feedback: documented deviation, but nothing is waived.
    await storage.specs.update('s', { sections: await withLink(deviate())() } as never, as('agent'));
    expect(await state()).toMatchObject({ state: 'unverified', waiver: { effective: false, reason: 'no_feedback' } });
    // 2. Abuse: the implementing agent approves its own waiver.
    const self = await feedback(T('ui', 'ac-focus'), 'agent');
    const selfLinks = (await storage.specs.get('s')).sections.map((x) => (x.id === 'impl' ? { ...x, links: [x.links[0]!, deviate(self)] } : x));
    await expect(storage.specs.update('s', { sections: selfLinks } as never, as('agent'))).rejects.toThrow(/same author/);
    // 3. Open (not accepted) feedback is not an approval.
    const open = await feedback(T('ui', 'ac-focus'), 'giulia', false);
    const openLinks = (await storage.specs.get('s')).sections.map((x) => (x.id === 'impl' ? { ...x, links: [x.links[0]!, deviate(open)] } : x));
    await expect(storage.specs.update('s', { sections: openLinks } as never, as('agent'))).rejects.toThrow(/not accepted/);
    // 4. Accepted by someone else: waived, scoped to the target section's verifiedBy (ac-other stays required).
    const ok = await feedback(T('ui', 'ac-focus'), 'giulia');
    const okLinks = (await storage.specs.get('s')).sections.map((x) => (x.id === 'impl' ? { ...x, links: [x.links[0]!, deviate(ok)] } : x));
    const written = await storage.specs.update('s', { sections: okLinks } as never, as('agent'));
    expect(written.sections[0]!.links[1]).toMatchObject({ feedback: ok, by: 'agent', pin: expect.any(String) });
    expect(await state()).toMatchObject({ state: 'waived', waiver: { effective: true, feedback: ok, section: 'impl' } });
    const other = (await storage.verificationService.forSpec(await storage.specs.get('s'))).inherited[0]!.criteria.find((c) => c.uri === T('ui', 'ac-other'))!;
    expect(other.state).toBe('unverified');
    // 5. The criterion changes: the waiver lapses (stale).
    const ui = await storage.standards.get('ui');
    await storage.standards.update('ui', { sections: ui.sections.map((x) => (x.id === 'ac-focus' ? { ...x, body: 'stricter focus rule' } : x)) });
    expect(await state()).toMatchObject({ state: 'unverified', waiver: { effective: false, reason: 'stale' } });
  });
});

describe('C3: immutable ids, protected inbound references, archive-only documents', () => {
  it('rejects removing referenced sections, reusing ids and deleting documents', async () => {
    const { git, storage, spec, patch } = await setup();
    await spec('b', [sec('t'), sec('free')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on')] })]);
    const b = await storage.specs.get('b');
    await expect(storage.specs.update('b', { sections: b.sections.filter((x) => x.id !== 't') } as never)).rejects.toMatchObject({ code: 'section_referenced' });
    // Unreferenced sections may go, but their id is never reused.
    await storage.specs.update('b', { sections: b.sections.filter((x) => x.id !== 'free') } as never);
    await expect(patch('b', (x) => x, {})).resolves.toBeTruthy();
    const b2 = await storage.specs.get('b');
    await expect(storage.specs.update('b', { sections: [...b2.sections, { ...b.sections[1]!, body: 'new meaning' }] } as never)).rejects.toMatchObject({ code: 'id_reused' });
    // Documents: archive-only, ids never reused.
    await expect(storage.specs.delete('a')).rejects.toMatchObject({ code: 'archive_only' });
    await rm(path.join(git.dir, 'specs/a.md'));
    await git.commit(['specs/a.md'], 'hand delete');
    await expect(spec('a', [sec('s')])).rejects.toMatchObject({ code: 'id_reused' });
  });

  it('closed feedback resolves at its closing commit', async () => {
    const { storage, spec, patch } = await setup();
    await spec('s', [sec('a')]);
    const f = await storage.feedbackService.create({ targets: [S('s', 'a')], kind: 'bug', body: 'x' });
    await storage.feedbackService.update(f.id, { status: 'closed', resolution: 'rejected', resolutionNote: 'no' });
    await patch('s', (x) => ({ ...x, title: 'Renamed later' }));
    const r = await storage.feedbackService.resolve(f.id);
    expect(r.targets[0]).toMatchObject({ section: { title: 'A' }, at: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});

describe('C4: full shas, pin lost, closing never validates pins', () => {
  it('stores full shas and reports unreadable pins as unknown', async () => {
    const { git, storage, spec, pass } = await setup();
    await spec('s', [crit('ac')]);
    const w = await storage.workOrderService.create({ spec: 's', kind: 'review', status: 'pending', sections: [{ id: 'ac' }] });
    expect(w.specCommit).toMatch(/^[0-9a-f]{40}$/);
    await pass(S('s', 'ac'));
    // Simulate a history rewrite: pins point at commits that no longer exist.
    const lost = 'f'.repeat(40);
    const vfile = path.join(git.dir, 'verifications.jsonl');
    const line = JSON.parse((await readFile(vfile, 'utf8')).trim().split('\n').pop()!);
    await appendFile(vfile, `${JSON.stringify({ ...line, id: 'vr-lost', specCommit: lost })}\n`);
    const wfile = path.join(git.dir, 'work-orders.jsonl');
    await writeFile(wfile, (await readFile(wfile, 'utf8')).replace(w.specCommit, lost));
    await git.commit(['verifications.jsonl', 'work-orders.jsonl'], 'rewrite');
    expect((await storage.verificationService.forSpec(await storage.specs.get('s'))).own[0]!.state).toBe('unknown');
    expect((await storage.workOrderService.resolve(w.id)).pinLost).toBe(true);
    // Cancelling never validates the pin.
    expect((await storage.workOrderService.update(w.id, { status: 'cancelled' })).status).toBe('cancelled');
  });
});

describe('I2 + I3: extends / supersedes acyclic, one live successor, no new links to superseded sections', () => {
  it('enforces the rules', async () => {
    const { storage, std, spec } = await setup();
    await std('x', [sec('a'), sec('old')]);
    await std('y', [sec('b', { links: [link(T('x', 'a'), 'extends')] }), sec('new', { links: [link(T('x', 'old'), 'supersedes')] })]);
    const x = await storage.standards.get('x');
    await expect(storage.standards.update('x', { sections: x.sections.map((s) => (s.id === 'a' ? { ...s, links: [{ to: T('y', 'b'), rel: 'extends' }] } : s)) })).rejects.toThrow(/extends cycle/);
    await std('z', [sec('c')]);
    const z = await storage.standards.get('z');
    await expect(storage.standards.update('z', { sections: z.sections.map((s) => ({ ...s, links: [{ to: T('x', 'old'), rel: 'supersedes' }] })) })).rejects.toThrow(/live successors/);
    await expect(spec('s', [sec('f', { links: [link(T('x', 'old'), 'follows')] })])).rejects.toThrow(/superseded; link to .*y\/sections\/new/);
  });
});

describe('I6: section_done, obsolete, archive cascade', () => {
  it('records implementedCommit = specCommit, supports obsolete, cancels on archive', async () => {
    const { storage, spec, patch } = await setup();
    await spec('s', [sec('a'), sec('b'), sec('c')], { status: 'ready' });
    const w = storage.workOrderService;
    const o = await w.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }, { id: 'b' }] });
    await patch('s', (x) => (x.id === 'a' ? { ...x, body: 'changed after pinning' } : x));
    await w.sectionDone({ id: o.id, sections: ['a'] });
    const s = await storage.specs.get('s');
    expect(s.sections.find((x) => x.id === 'a')!.implementedCommit).toBe(o.specCommit); // the version actually implemented
    expect((await w.implementation('s')).a).toMatchObject({ outdated: true });
    // Archiving a covered section makes it obsolete; the work order is then done.
    await patch('s', (x) => (x.id === 'b' ? { ...x, archived: true } : x));
    expect(await w.get(o.id)).toMatchObject({ status: 'done', sections: [{ id: 'a', status: 'done' }, { id: 'b', status: 'obsolete' }] });
    const o2 = await w.create({ spec: 's', kind: 'update', status: 'pending', sections: [{ id: 'c' }] });
    await setSpecStatus(storage, { id: 's', status: 'archived' });
    expect((await w.get(o2.id)).status).toBe('cancelled');
  });
});

describe('I7: concurrency and lint', () => {
  it('two writers racing for the same section: exactly one wins (checks run inside the lock)', async () => {
    const { storage, spec } = await setup();
    await spec('s', [sec('a')]);
    const results = await Promise.allSettled([
      storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] }, { agent: 'one' }),
      storage.workOrderService.create({ spec: 's', kind: 'update', status: 'pending', sections: [{ id: 'a' }] }, { agent: 'two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect(await storage.workOrders.list()).toHaveLength(1);
  });

  it('lints what only holds per write (e.g. a cycle merged in from another clone)', async () => {
    const { git, storage, spec } = await setup();
    await spec('b', [sec('t')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on')] })]);
    expect((await storage.integrity.run()).issues).toEqual([]);
    const file = path.join(git.dir, 'specs/b.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('    type: markdown\n', `    type: markdown\n    links: [{to: "${S('a', 's')}", rel: depends_on}]\n`));
    await git.commit(['specs/b.md'], 'merged from another clone');
    const report = await storage.integrity.current();
    expect(report.issues.map((i) => i.rule)).toContain('depends_on_cycle');
  });
});

describe('I8: upstream changed only for obliging relations, acknowledgeable via seenAt', () => {
  it('ignores relates_to, flags depends_on, clears with seenAt', async () => {
    const { git, storage, spec, patch } = await setup();
    await spec('b', [sec('t'), sec('r')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on'), link(S('b', 'r'), 'relates_to')] })]);
    const head = (await git.log(1))[0]!.id;
    await patch('a', (x) => ({ ...x, implementedCommit: head }));
    await patch('b', (x) => ({ ...x, body: `${x.body} (changed)` }));
    let info = (await storage.linkService.forDoc('specs', await storage.specs.get('a'))).sections.s!;
    expect(info.outgoing.map((o) => [o.rel, o.upstreamChanged])).toEqual([
      ['depends_on', true],
      ['relates_to', false],
    ]);
    // A title-only change is not an upstream change; an acknowledgement (seenAt) clears it.
    const now = (await git.log(1))[0]!.id;
    await patch('a', (x) => ({ ...x, links: x.links.map((l) => (l.rel === 'depends_on' ? { ...l, seenAt: now } : l)) }));
    await patch('b', (x) => ({ ...x, title: `${x.title}!` }));
    info = (await storage.linkService.forDoc('specs', await storage.specs.get('a'))).sections.s!;
    expect(info.upstreamChanged).toBe(false);
    // An unreadable pin is "unknown", never "fine".
    await patch('a', (x) => ({ ...x, links: x.links.map((l) => (l.rel === 'depends_on' ? { ...l, seenAt: 'f'.repeat(40) } : l)) }));
    info = (await storage.linkService.forDoc('specs', await storage.specs.get('a'))).sections.s!;
    expect(info.pinLost).toBe(true);
  });
});

describe('I10: transitions and the full done gate', () => {
  it('enforces the transition table and gates on blocked sections and open work', async () => {
    const { storage, spec } = await setup();
    await spec('b', [sec('t')]);
    await spec('a', [sec('s', { links: [link(S('b', 't'), 'depends_on')] })], { status: 'ready' });
    await expect(setSpecStatus(storage, { id: 'a', status: 'done' })).rejects.toMatchObject({ code: 'done_gate', details: [expect.objectContaining({ state: 'blocked' })] });
    await storage.specs.update('b', { sections: [{ ...(await storage.specs.get('b')).sections[0]!, implementedCommit: (await storage.git.log(1))[0]!.id }] });
    const o = await storage.workOrderService.create({ spec: 'a', kind: 'implement', status: 'pending', sections: [{ id: 's' }] });
    await expect(setSpecStatus(storage, { id: 'a', status: 'done' })).rejects.toMatchObject({ code: 'done_gate', details: [expect.objectContaining({ state: 'open' })] });
    await storage.workOrderService.update(o.id, { status: 'cancelled' });
    expect((await setSpecStatus(storage, { id: 'a', status: 'done' })).status).toBe('done');
    await setSpecStatus(storage, { id: 'a', status: 'archived' });
    await expect(setSpecStatus(storage, { id: 'a', status: 'ready' })).rejects.toMatchObject({ code: 'invalid_transition' });
    expect((await setSpecStatus(storage, { id: 'a', status: 'draft' })).status).toBe('draft');
    // Work orders and feedback have their tables too.
    await expect(storage.workOrderService.update(o.id, { status: 'pending' })).rejects.toThrow(/not allowed/);
  });
});
