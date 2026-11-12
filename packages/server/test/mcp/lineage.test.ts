/**
 * Lineage (lineage-brief §2, §4, §6): `cause` validation, `Caused-By` trailers and `caused_by` edges (sections
 * included, existing trailers too), the missing-cause warning, lineage up / down / both with depth and time travel,
 * blast_radius, and "where standards are used" (applies_at / violated_at, coverage against appliesTo).
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpFixture, type McpFixture } from './fixture.js';
import { memorySettings } from '../../src/projects/settings.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture({ settings: memorySettings('local') });
  // This client asks in chat, so confirmedByUser confirms its standard writes.
  await fx.call('flow_set', { questions: 'chat' });
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'lineage@test';
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
async function ok(name: string, args: Record<string, unknown> = {}, write = true) {
  const r = await fx.call(name, write ? { agent: AGENT, ...args } : args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
const read = (name: string, args: Record<string, unknown>) => ok(name, args, false);
const git = (...args: string[]) => execFileSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8' }).trim();
const head = () => git('rev-parse', 'HEAD');
const edges = (from: string, kind: string) => (fx.index.db.prepare('SELECT to_uri AS t, props FROM edges WHERE from_uri = ? AND kind = ?').all(from, kind) as { t: string; props: string }[]);

async function newSpec() {
  const id = uid('lin');
  await ok('spec_create', {
    title: id,
    summary: 'A lineage test spec.',
    sections: [
      { title: 'Overview', summary: 'What it does.', body: 'The overview.' },
      { title: 'Design', summary: 'How it works.', body: 'The design.' },
      { title: 'Ac works', type: 'acceptance', method: 'test', summary: 'The feature works.', body: 'A test proves it.' },
    ],
  });
  return id;
}

describe('cause', () => {
  it('is validated: unknown or non-cause references are refused with a structured error and nothing is written', async () => {
    const id = await newSpec();
    const before = head();
    const bad = await fx.call('spec_section_update', { agent: AGENT, ref: `mandate://specs/${id}/sections/design`, body: 'x', cause: 'mandate://feedback/fb-doesnotexist' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatchObject({ code: 'invalid_cause', path: 'cause' });
    const sym = await fx.call('spec_section_update', { agent: AGENT, ref: `mandate://specs/${id}/sections/design`, body: 'x', cause: ['mandate://symbols/Foo'] });
    expect(sym.isError).toBe(true);
    const sec = await fx.call('spec_section_update', { agent: AGENT, ref: `mandate://specs/${id}/sections/design`, body: 'x', cause: [`mandate://specs/${id}/sections/nope`] });
    expect(sec.body.error).toMatchObject({ code: 'invalid_cause', path: 'cause.0' });
    expect(head()).toBe(before);
  });

  it('is recorded as a Caused-By trailer and caused_by edges from the commit, the doc and the changed section', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Make the design clearer.' });
    const sectionUri = `mandate://specs/${id}/sections/design`;
    await ok('spec_section_update', { ref: sectionUri, body: 'A clearer design.', cause: `@mandate:${fb.ref}` });
    expect(git('log', '-1', '--format=%B')).toContain(`Caused-By: ${fb.ref}`);
    await fx.index.ensureFresh();
    const sha = head();
    expect(edges(sectionUri, 'caused_by').map((e) => e.t)).toContain(fb.ref);
    expect(edges(`mandate://specs/${id}`, 'caused_by').map((e) => e.t)).toContain(fb.ref);
    expect(edges(`mandate://commits/${sha}`, 'caused_by').map((e) => e.t)).toContain(fb.ref);
    expect(JSON.parse(edges(sectionUri, 'caused_by')[0]!.props)).toMatchObject({ commit: sha, trailer: 'Caused-By' });
    // history_get and activity_list return the causes.
    const h = await read('history_get', { ref: `mandate://specs/${id}`, limit: 1 });
    expect(h.entries[0].causes).toEqual([fb.ref]);
    const act = await read('activity_list', { ref: `mandate://specs/${id}`, limit: 5 });
    expect(act.events.some((e: { causes?: string[] }) => e.causes?.includes(fb.ref))).toBe(true);
  });

  it('existing trailers (Feedback, Work-Order) produce caused_by edges too', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'improvement', body: 'Say more.' });
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/overview`, body: 'More words.', addresses: [fb.ref.split('/').pop()] });
    expect(git('log', '-1', '--format=%B')).toMatch(/Feedback: fb-/);
    await fx.index.ensureFresh();
    expect(edges(`mandate://specs/${id}/sections/overview`, 'caused_by').map((e) => e.t)).toContain(fb.ref);
  });

  it('a flow write without a cause succeeds with a missing_cause warning; with a cause, no warning', async () => {
    const id = await newSpec();
    const w = await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'v2' });
    expect(w.warnings.some((x: string) => x.startsWith('missing_cause'))).toBe(true);
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'b' });
    expect(fb.warnings.some((x: string) => x.startsWith('missing_cause'))).toBe(false); // an origin, not a flow step
    const c = await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'v3', cause: fb.ref });
    expect(c.warnings.some((x: string) => x.startsWith('missing_cause'))).toBe(false);
  });
});

describe('lineage', () => {
  let id: string;
  let fbRef: string;
  let before: string;
  let after: string;
  beforeAll(async () => {
    id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Why not cache it?' });
    fbRef = fb.ref;
    await fx.index.ensureFresh();
    before = head();
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'Cached design.', cause: fbRef });
    await ok('spec_section_insert', { doc: id, section: { title: 'Cache', summary: 'The cache.', body: 'An LRU cache.' }, cause: fbRef });
    after = head();
    await ok('verification_record', { criterion: `mandate://specs/${id}/sections/ac-works`, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'test', cause: fbRef });
    await fx.index.ensureFresh();
  });

  it('down: what a feedback item led to (sections changed, marked done) with a summary', async () => {
    const r = await read('lineage', { ref: fbRef, direction: 'down', depth: 1 });
    expect(r.root.uri).toBe(fbRef);
    const down = r.nodes.filter((x: { layer: number }) => x.layer > 0).map((x: { uri: string }) => x.uri);
    expect(down).toEqual(expect.arrayContaining([`mandate://specs/${id}/sections/design`, `mandate://specs/${id}/sections/cache`]));
    const design = r.nodes.find((x: { uri: string }) => x.uri === `mandate://specs/${id}/sections/design`);
    expect(design.status).toBe('done');
    const e = r.edges.find((x: { to: string; kind: string }) => x.to === `mandate://specs/${id}/sections/cache` && x.kind === 'caused_by');
    expect(e).toMatchObject({ from: fbRef, recorded: true });
    expect(r.summary.text).toMatch(/Changed: \d+ sections? in 1 doc/);
    expect(r.nodes.every((x: { kind: string }) => x.kind !== 'commit')).toBe(true); // history hidden by default
  });

  it('up: why a section changed (the feedback), and depth limits the walk', async () => {
    const r = await read('lineage', { ref: `@mandate:mandate://specs/${id}/sections/cache`, direction: 'up', depth: 1, structure: true });
    const up = r.nodes.filter((x: { layer: number }) => x.layer < 0);
    expect(up.map((x: { uri: string }) => x.uri)).toEqual(expect.arrayContaining([fbRef, `mandate://specs/${id}`]));
    expect(up.every((x: { layer: number }) => x.layer === -1)).toBe(true);
    const deeper = await read('lineage', { ref: `mandate://specs/${id}/sections/cache`, direction: 'up', depth: 2, structure: true });
    expect(deeper.nodes.length).toBeGreaterThanOrEqual(r.nodes.length);
    expect(r.nodes.every((x: { layer: number }) => x.layer <= 0)).toBe(true);
  });

  it('both: causes and effects, with filters by kind and status', async () => {
    const r = await read('lineage', { ref: `mandate://specs/${id}`, direction: 'both', depth: 2 });
    expect(r.nodes.some((x: { layer: number }) => x.layer < 0)).toBe(true);
    expect(r.nodes.some((x: { layer: number }) => x.layer > 0)).toBe(true);
    const onlyFb = await read('lineage', { ref: `mandate://specs/${id}/sections/design`, kinds: ['feedback'] });
    expect(onlyFb.nodes.filter((x: { uri: string }) => x.uri !== onlyFb.root.uri).every((x: { kind: string }) => x.kind === 'feedback')).toBe(true);
    const attention = await read('lineage', { ref: `mandate://specs/${id}`, status: ['attention'] });
    expect(attention.nodes.filter((x: { uri: string }) => x.uri !== attention.root.uri).every((x: { status: string }) => x.status === 'attention')).toBe(true);
  });

  it('causal by default: no structural edges, the root document absorbs its own sections', async () => {
    const r = await read('lineage', { ref: `mandate://specs/${id}`, direction: 'both', depth: 3 });
    expect(r.structure).toBe(false);
    const kinds = new Set(r.edges.map((e: { kind: string }) => e.kind));
    for (const k of ['has_section', 'inherits_rule', 'covers', 'depends_on', 'follows', 'applied_to']) expect(kinds.has(k)).toBe(false);
    expect(r.nodes.some((x: { uri: string }) => x.uri.startsWith(`mandate://specs/${id}/sections/`))).toBe(false);
    expect(r.nodes.find((x: { uri: string }) => x.uri === fbRef)?.layer).toBeLessThan(0);
    expect(r.nodes.some((x: { kind: string; layer: number }) => x.kind === 'verification' && x.layer > 0)).toBe(true);
    const full = await read('lineage', { ref: `mandate://specs/${id}`, direction: 'both', depth: 1, structure: true });
    expect(full.edges.some((e: { kind: string }) => e.kind === 'has_section')).toBe(true);
  });

  it('story: one event per commit and element, oldest first, with causes, causal links, actors and gaps', async () => {
    const r = await read('lineage', { ref: fbRef, direction: 'down', depth: 2, story: true });
    const ev = r.events as { id: string; at: string; kind: string; verb: string; text: string; subject: string; causes: string[]; causedBy?: string; gapMs?: number; agent?: string; sections?: { title: string }[]; version?: string }[];
    expect(ev.length).toBeGreaterThanOrEqual(4);
    expect(ev[0]!.kind).toBe('feedback'); // down: the story starts when the feedback was filed
    expect([...ev].map((e) => e.at)).toEqual([...ev].map((e) => e.at).sort());
    const filed = ev.find((e) => e.kind === 'feedback' && e.verb === 'created')!;
    expect(filed.text).toMatch(/^Feedback filed/);
    const edit = ev.find((e) => e.kind === 'spec' && e.sections?.some((s) => s.title === 'Design'))!;
    expect(edit.text).toMatch(/Edited .*Design/);
    expect(edit.causes).toContain(fbRef);
    expect(edit.causedBy).toBe(filed.id);
    expect(edit.agent).toBe(AGENT);
    expect(edit.version).toMatch(new RegExp(`^mandate://specs/${id}@[0-9a-f]{40}$`));
    expect(ev.indexOf(edit)).toBeGreaterThan(ev.indexOf(filed));
    expect(edit.gapMs).toBeGreaterThanOrEqual(0);
    const ver = ev.find((e) => e.kind === 'verification')!;
    expect(ver.text).toMatch(/^Verification pass/);
    expect(ver.causedBy).toBe(filed.id);
    // the spec's own story folds its section edits into one event per commit
    const spec = await read('lineage', { ref: `mandate://specs/${id}`, story: true, eventLimit: 3 });
    expect(spec.events.length).toBe(3);
    expect(spec.eventsTruncated).toBe(true);
    expect(new Set(spec.events.map((e: { id: string }) => e.id)).size).toBe(3);
  });

  it('time travel: as of the commit before the change, the feedback led to nothing; viewRef pins it', async () => {
    const then = await read('lineage', { ref: fbRef, direction: 'down', depth: 1, at: before });
    expect(then.nodes.some((x: { uri: string }) => x.uri === `mandate://specs/${id}/sections/cache`)).toBe(false);
    const now = await read('lineage', { ref: fbRef, direction: 'down', depth: 1, at: after });
    expect(now.nodes.some((x: { uri: string }) => x.uri === `mandate://specs/${id}/sections/cache`)).toBe(true);
    const spec = await read('lineage', { ref: `mandate://specs/${id}`, at: after });
    expect(spec.viewRef).toBe(`mandate://specs/${id}@${after}`);
  });

  it('commits and versions have lineage when asked for (history kinds)', async () => {
    const r = await read('lineage', { ref: `mandate://commits/${after}`, direction: 'both', depth: 1 });
    expect(r.nodes.some((x: { uri: string }) => x.uri === fbRef)).toBe(true);
    expect(r.nodes.some((x: { uri: string }) => x.uri === `mandate://specs/${id}/sections/cache`)).toBe(true);
  });

  it('refuses malformed input with structured errors', async () => {
    expect((await fx.call('lineage', { ref: 'nope' })).body.error.code).toBe('invalid_input');
    expect((await fx.call('lineage', { ref: `mandate://specs/${id}`, depth: 9 })).body.error.code).toBe('invalid_input');
    expect((await fx.call('lineage', { ref: 'mandate://specs/does-not-exist' })).body.error.code).toBe('not_found');
  });
});

describe('blast_radius', () => {
  it('lists dependent specs, followers of a standard, open work orders and open issues', async () => {
    const std = uid('bstd');
    await ok('standard_create', { title: std, appliesTo: ['tag:zz-none'], sections: [{ title: 'R one', type: 'rule', rationale: 'Because.', level: 'must', summary: 'The rule.', body: 'Do it.' }], confirmedByUser: true });
    const base = await newSpec();
    const dep = await newSpec();
    await ok('spec_section_link_add', { ref: `mandate://specs/${dep}/sections/design`, rel: 'depends_on', to: `mandate://specs/${base}/sections/design` });
    await ok('spec_section_link_add', { ref: `mandate://specs/${base}/sections/design`, rel: 'follows', to: `mandate://standards/${std}/sections/r-one` });
    await ok('feedback_create', { targets: [`mandate://specs/${base}/sections/overview`], kind: 'bug', body: 'Broken.' });
    await ok('work_order_create', { spec: base, kind: 'implement', sections: ['design'] });
    await fx.index.ensureFresh();
    const b = await read('blast_radius', { ref: `mandate://specs/${base}` });
    expect(b.dependentSpecs.map((x: { uri: string }) => x.uri)).toContain(`mandate://specs/${dep}`);
    expect(b.openIssues.some((x: { kind: string }) => x.kind === 'feedback')).toBe(true);
    expect(b.openWorkOrders.length).toBeGreaterThanOrEqual(1);
    expect(b.text).toMatch(/dependent specs/);
    const s = await read('blast_radius', { ref: `mandate://standards/${std}` });
    expect(s.followers.map((x: { uri: string }) => x.uri)).toEqual(expect.arrayContaining([`mandate://specs/${base}`]));
  });
});

describe('where standards are used', () => {
  it('records applies_at / violated_at from verification code refs; code_rules and coverage', async () => {
    const std = uid('wstd');
    await ok('standard_create', {
      title: std,
      appliesTo: ['path:src/**'],
      sections: [
        { title: 'R safe', type: 'rule', rationale: 'Safety first.', level: 'must', summary: 'Safety.', body: 'Always safe.' },
      ],
      confirmedByUser: true,
    });
    const spec = await newSpec();
    await ok('spec_section_link_add', { ref: `mandate://specs/${spec}/sections/design`, rel: 'follows', to: `mandate://standards/${std}/sections/r-safe` });
    const crit = `mandate://standards/${std}/sections/r-safe`;
    await ok('verification_record', { criterion: crit, appliedTo: spec, code: { repo: 'app', commit: 'abcdef1234' }, result: 'pass', method: 'review', codeRefs: ['app:src/auth/session.ts#L10-L40'] });
    await ok('verification_record', { criterion: crit, appliedTo: spec, code: { repo: 'app', commit: 'abcdef1234' }, result: 'fail', method: 'review', codeRefs: ['app:src/api/errors.ts'] });
    await fx.index.ensureFresh();
    expect(edges(crit, 'applies_at').map((e) => e.t)).toContain('mandate://code/app/src/auth/session.ts#L10-L40');
    expect(edges(crit, 'violated_at').map((e) => e.t)).toContain('mandate://code/app/src/api/errors.ts');
    const w = await read('standard_where_used', { ref: `mandate://standards/${std}` });
    expect(w.locations.find((l: { path: string }) => l.path === 'src/auth/session.ts')).toMatchObject({ state: 'compliant', rule: crit });
    expect(w.locations.find((l: { path: string; state: string }) => l.path === 'src/api/errors.ts' && l.state !== 'unchecked')).toMatchObject({ state: 'violating' });
    expect(w.coverage.inScope).toBeGreaterThanOrEqual(0);
    expect(w.coverage.checked).toBeLessThanOrEqual(w.coverage.inScope);
    // recorded results; reconciled work orders on specs following the rule (in scope via appliesTo) may add more
    expect(w.locations.filter((l: { source?: string }) => l.source?.startsWith('mandate://verifications/'))).toHaveLength(2);
    expect(w.byComponent.reduce((n: number, g: { compliant: number; violating: number }) => n + g.compliant + g.violating, 0)).toBe(w.locations.filter((l: { state: string }) => l.state !== 'unchecked').length);
    const rules = await read('code_rules', { ref: 'mandate://code/app/src/auth/session.ts#L20-L22' });
    expect(rules.follows.map((r: { rule: string }) => r.rule)).toContain(crit);
    expect(rules.follows[0].label).toContain('›');
    const bad = await read('code_rules', { ref: 'mandate://code/app/src/api/errors.ts' });
    expect(bad.violates.map((r: { rule: string }) => r.rule)).toContain(crit);
    // the lineage of the rule reaches the code it applies at
    const lin = await read('lineage', { ref: crit, direction: 'down', depth: 1 });
    expect(lin.nodes.some((x: { uri: string }) => x.uri === 'mandate://code/app/src/auth/session.ts#L10-L40')).toBe(true);
  });

  it('coverage counts in-scope files from appliesTo and lists the never-checked ones', async () => {
    const files = fx.index.db.prepare("SELECT DISTINCT uri FROM nodes WHERE kind = 'code_file' AND valid_to IS NULL LIMIT 1").get() as { uri: string } | undefined;
    if (!files) return; // fixture without code files
    const m = /^mandate:\/\/code\/([^/]+)\/(.+)$/.exec(files.uri)!;
    const std = uid('cstd');
    await ok('standard_create', { title: std, appliesTo: [`path:${m[2]}`], sections: [{ title: 'R x', type: 'rule', rationale: 'Because.', level: 'should', summary: 'x.', body: 'x.' }], confirmedByUser: true });
    await fx.index.ensureFresh();
    const w = await read('standard_where_used', { ref: `mandate://standards/${std}` });
    expect(w.coverage.inScope).toBeGreaterThanOrEqual(1);
    expect(w.coverage.checked).toBe(0);
    expect(w.coverage.unchecked).toContain(files.uri);
    expect(w.locations.every((l: { state: string }) => l.state === 'unchecked')).toBe(true);
  });
});
