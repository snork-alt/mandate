/**
 * Regression tests of the lineage findings of plans/fable-data-review.md §3b / §4 (one per finding id), the
 * `lineage_annotate` tool (lineage.jsonl annotations) and the backfill proposal logic.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitCauses, isMigrationCommit } from '../src/index/lineage.js';
import { proposeAnnotations } from '../src/index/lineage-backfill.js';
import { memorySettings } from '../src/projects/settings.js';
import { mcpFixture, type McpFixture } from './mcp/fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture({ settings: memorySettings('local') });
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'lineage-findings@test';
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
/** A raw commit (as an old tool / script would have made it) after editing files in place. */
function rawCommit(files: string[], message: string): string {
  git('add', ...files);
  execFileSync('git', ['-C', fx.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  return head();
}
const edit = (file: string, from: string | RegExp, to: string) => {
  const p = path.join(fx.dir, file);
  const t = readFileSync(p, 'utf8');
  const next = t.replace(from, to);
  if (next === t) throw new Error(`no change in ${file}`);
  writeFileSync(p, next);
};
const causedByCommit = (sha: string) =>
  (fx.index.db.prepare("SELECT from_uri AS f, to_uri AS t, props FROM edges WHERE kind = 'caused_by' AND props LIKE ?").all(`%"commit":"${sha}"%`) as { f: string; t: string; props: string }[]);
const woId = (r: Record<string, any>): string => r.ref.split('/').pop()!;
const nodesOf = (r: Record<string, any>): string[] => (r.nodes as { uri: string }[]).map((x) => x.uri);

async function newSpec() {
  const id = uid('lf');
  await ok('spec_create', {
    title: id,
    summary: 'A lineage findings spec.',
    sections: [
      { title: 'Overview', summary: 'What it does.', body: 'The overview.' },
      { title: 'Design', summary: 'How it works.', body: 'The design.' },
      { title: 'Cache', summary: 'Caching.', body: 'The cache.' },
      { title: 'Ac works', type: 'acceptance', method: 'test', summary: 'The feature works.', body: 'A test proves it.' },
    ],
  });
  return id;
}

describe('lineage findings', () => {
  it('L-1: migration commits create no causes', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'improvement', body: 'Clearer design.' });
    // A migration commit naming a cause records nothing.
    edit(`specs/${id}.md`, 'The design.', 'The migrated design.');
    const mig = rawCommit([`specs/${id}.md`], `spec(${id}): migrate\n\nCaused-By: ${fb.ref}\nMandate-Migration: yes`);
    // A bulk rewrite of many work orders named by one Work-Order trailer records nothing either.
    const wos: string[] = [];
    for (let i = 0; i < 4; i++) wos.push(woId(await ok('work_order_create', { spec: id, kind: 'review', sections: ['overview'], note: `bulk n${i}` })));
    for (const [i, w] of wos.entries()) edit(`work-orders/${w}.md`, `note: bulk n${i}`, `note: bulk m${i}`);
    const bulk = rawCommit(wos.map((w) => `work-orders/${w}.md`), `work order: migrate ${wos[0]}\n\nWork-Order: ${wos[0]}`);
    // Two work orders in one commit, trailer naming one: the sibling is not its effect.
    edit(`work-orders/${wos[1]}.md`, 'note: bulk m1', 'note: bulk k1');
    edit(`work-orders/${wos[2]}.md`, 'note: bulk m2', 'note: bulk k2');
    const pair = rawCommit([`work-orders/${wos[1]}.md`, `work-orders/${wos[2]}.md`], `work order: update ${wos[1]}\n\nWork-Order: ${wos[1]}`);
    await fx.index.ensureFresh();
    expect(isMigrationCommit({ 'Mandate-Migration': 'work-orders-md' })).toBe(true);
    expect(isMigrationCommit({ 'Mandate-Migration': 'no' })).toBe(false);
    expect(causedByCommit(mig)).toEqual([]);
    expect(causedByCommit(bulk)).toEqual([]);
    expect(causedByCommit(pair).filter((e) => e.f === `mandate://work-orders/${wos[2]}`)).toEqual([]);
    const up = await read('lineage', { ref: `mandate://work-orders/${wos[3]}`, direction: 'up' });
    expect(nodesOf(up)).not.toContain(`mandate://work-orders/${wos[0]}`);
  });

  it('L-2: closed feedback reaches the work order that delivered it (reason -> Caused-By; covers is causal)', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/cache`], kind: 'bug', body: 'The cache double counts.' });
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/cache`, body: 'The cache counts once.', cause: fb.ref });
    const wo = await ok('work_order_create', { spec: id, kind: 'update', sections: ['cache'], reason: [fb.ref] });
    const review = await ok('work_order_create', { spec: id, kind: 'review', sections: ['design'] });
    expect(git('log', '-1', '--format=%B', wo.commit)).toContain(`Caused-By: ${fb.ref}`);
    await ok('feedback_close', { ref: fb.ref, resolution: 'applied' }).catch(() => undefined);
    await fx.index.ensureFresh();
    const woUri = `mandate://work-orders/${woId(wo)}`;
    expect(nodesOf(await read('lineage', { ref: fb.ref, direction: 'down' }))).toContain(woUri);
    expect(nodesOf(await read('lineage', { ref: woUri, direction: 'up' }))).toContain(fb.ref);
    // A covered section causes implement / update / fix orders, not reviews.
    const spec = nodesOf(await read('lineage', { ref: `mandate://specs/${id}`, direction: 'down' }));
    expect(spec).toContain(woUri);
    expect(spec).not.toContain(`mandate://work-orders/${woId(review)}`);
  });

  it('L-3: no cause is later than its effect (targets has a time guard)', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'Design is wrong.' });
    const wo = await ok('work_order_create', { spec: id, kind: 'update', sections: ['design'] });
    const woUri = `mandate://work-orders/${woId(wo)}`;
    // Later work on the targeted section, caused by the work order.
    await ok('spec_section_update', { ref: `mandate://specs/${id}/sections/design`, body: 'The new design.', cause: woUri });
    await fx.index.ensureFresh();
    const up = nodesOf(await read('lineage', { ref: fb.ref, direction: 'up', depth: 6 }));
    expect(up).toContain(`mandate://specs/${id}/sections/design`);
    expect(up).not.toContain(woUri);
    expect(nodesOf(await read('lineage', { ref: woUri, direction: 'down', depth: 6 }))).not.toContain(fb.ref);
  });

  it('L-4: lineage is symmetric between a document and what its sections reach', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/overview`], kind: 'question', body: 'Which users?' });
    await fx.index.ensureFresh();
    expect(nodesOf(await read('lineage', { ref: `mandate://specs/${id}`, direction: 'down' }))).toContain(fb.ref);
    const up = await read('lineage', { ref: fb.ref, direction: 'up' });
    expect(nodesOf(up)).toContain(`mandate://specs/${id}`);
    expect(up.edges.some((e: { from: string; via?: string }) => e.from === `mandate://specs/${id}` && e.via === `mandate://specs/${id}/sections/overview`)).toBe(true);
  });

  it('L-6: a backlink commit does not make a cause loop', async () => {
    const id = await newSpec();
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'Loop me.' });
    const wo = await ok('work_order_create', { spec: id, kind: 'fix', sections: ['design'], reason: [fb.ref] });
    // A commit writing back into the feedback with the work order as its trailer (a backlink).
    const line = readFileSync(path.join(fx.dir, 'feedback.jsonl'), 'utf8').split('\n').find((l) => l.includes(`"id":"${fb.ref.split('/').pop()}"`))!;
    edit('feedback.jsonl', line, line.replace('Loop me.', 'Loop me (fixed by the work order).'));
    const sha = rawCommit(['feedback.jsonl'], `feedback: backlink\n\nWork-Order: ${woId(wo)}`);
    await fx.index.ensureFresh();
    expect(causedByCommit(sha).filter((e) => e.f === fb.ref)).toEqual([]);
  });

  it('L-7: a duplicate reaches the feedback it duplicates', async () => {
    const id = await newSpec();
    const a = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'Original report.' });
    const b = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/design`], kind: 'bug', body: 'Same report again.' });
    await ok('feedback_close', { ref: b.ref, resolution: 'duplicate', duplicateOf: a.ref });
    await fx.index.ensureFresh();
    const up = await read('lineage', { ref: b.ref, direction: 'up' });
    expect(nodesOf(up)).toContain(a.ref);
    // L-8: a duplicate changed nothing.
    expect(up.root.status).toBe('neutral');
  });

  it('L-8: a spec with an open, claimed work order is changing; a pending unclaimed order is not', async () => {
    const id = await newSpec();
    const wo = await ok('work_order_create', { spec: id, kind: 'implement', sections: ['design'], fastPath: false, plan: '1. Do it.' });
    await fx.index.ensureFresh();
    const before = await read('lineage', { ref: `mandate://specs/${id}`, direction: 'down' });
    expect(before.root.status).not.toBe('in_progress');
    expect(before.nodes.find((x: { uri: string }) => x.uri === `mandate://work-orders/${woId(wo)}`)?.status).toBe('neutral');
    await ok('work_order_claim', { ref: `mandate://work-orders/${woId(wo)}` });
    await fx.index.ensureFresh();
    expect((await read('lineage', { ref: `mandate://specs/${id}`, direction: 'down' })).root.status).toBe('in_progress');
  });

  it('L-9: a Verification trailer names the record written, never a cause', async () => {
    expect(commitCauses({ Verification: 'vr-0001' })).toEqual([]);
    const self = fx.index.db.prepare("SELECT count(*) AS c FROM edges WHERE kind = 'caused_by' AND to_uri LIKE 'mandate://verifications/%' AND props LIKE '%\"trailer\":\"Verification\"%'").get() as { c: number };
    expect(self.c).toBe(0);
  });

  it('L-10: legacy Queue-Item trailers read as Work-Order; Feedback-Item is identity', () => {
    expect(commitCauses({ 'Queue-Item': 'q-0001' })).toEqual([{ uri: 'mandate://work-orders/q-0001', trailer: 'Queue-Item' }]);
    expect(commitCauses({ 'Feedback-Item': 'fb-0001' })).toEqual([]);
  });

  it('GQ-6: the lineage summary counts code touched by a done work order', async () => {
    const r = await read('lineage', { ref: 'mandate://work-orders/q-0002', direction: 'down', depth: 2 });
    expect(r.summary.changed.files).toBeGreaterThan(0);
  });

  it('GQ-7: open comments need attention and rejected feedback is not done', async () => {
    const r = await read('lineage', { ref: 'mandate://work-orders/q-0002', direction: 'both', depth: 2 });
    const comments = r.nodes.filter((x: { kind: string }) => x.kind === 'comment');
    for (const c of comments) if (c.rawStatus === 'open') expect(c.status).toBe('attention');
    const rejected = await read('lineage', { ref: 'mandate://feedback/fb-0008', direction: 'down' });
    expect(rejected.root.status).toBe('neutral');
  });
});

describe('lineage_annotate', () => {
  it('is strict and validates refs and the commit', async () => {
    const sha = fx.older;
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: sha, causes: ['mandate://feedback/fb-0005'], note: 'x', bogus: 1 })).body.error.code).toBe('invalid_input');
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: sha, causes: ['mandate://feedback/fb-nope'], note: 'x' })).body.error).toMatchObject({ code: 'invalid_cause' });
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: sha, causes: ['mandate://symbols/Foo'], note: 'x' })).isError).toBe(true);
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: 'deadbeefdeadbeef', causes: ['mandate://feedback/fb-0005'], note: 'x' })).body.error.code).toBe('invalid_annotation');
    // A cause filed after the commit cannot explain it.
    const late = await ok('feedback_create', { targets: ['mandate://specs/login-sso/sections/overview'], kind: 'question', body: 'Filed later.' });
    const root = git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0]!;
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: root, causes: [late.ref], note: 'x' })).body.error.code).toBe('cause_after_effect');
  });

  it('appends a frozen record and becomes caused_by edges with source annotation', async () => {
    const id = await newSpec();
    edit(`specs/${id}.md`, 'The cache.', 'The cache, tuned.');
    const sha = rawCommit([`specs/${id}.md`], `spec(${id}): tune the cache`);
    await new Promise((r) => setTimeout(r, 2100));
    const fb = await ok('feedback_create', { targets: [`mandate://specs/${id}/sections/cache`], kind: 'bug', body: 'Cache too slow.' });
    // The feedback was filed after the commit: refused. Annotate with the spec's own design section instead.
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: sha, causes: [fb.ref], note: 'tuned for it' })).body.error.code).toBe('cause_after_effect');
    const cause = `mandate://specs/${id}/sections/design`;
    const r = await ok('lineage_annotate', { commit: sha.slice(0, 7), causes: [cause], note: 'the design asked for it' });
    expect(r.annotation).toMatchObject({ commit: sha, causes: [cause], note: 'the design asked for it', by: AGENT });
    expect(r.id).toMatch(/^la-\d{4}$/);
    expect(git('log', '-1', '--format=%B')).toContain(`Lineage-Annotation: ${r.id}`);
    expect(readFileSync(path.join(fx.dir, 'lineage.jsonl'), 'utf8')).toContain(r.id);
    // Append-only: the same annotation again is refused, and records are never updated.
    expect((await fx.call('lineage_annotate', { agent: AGENT, commit: sha, causes: [cause], note: 'again' })).isError).toBe(true);
    await expect(fx.storage.lineageAnnotations.update(r.id, { note: 'changed' } as never)).rejects.toThrow(/append_only/);
    await fx.index.ensureFresh();
    const e = causedByCommit(sha).filter((x) => JSON.parse(x.props).source === 'annotation');
    expect(e.map((x) => x.f)).toEqual(expect.arrayContaining([`mandate://commits/${sha}`, `mandate://specs/${id}/sections/cache`]));
    expect(e.every((x) => x.t === cause)).toBe(true);
    const down = await read('lineage', { ref: cause, direction: 'down' });
    expect(down.edges.some((x: { to: string; source?: string }) => x.to === `mandate://specs/${id}/sections/cache` && x.source === 'annotation')).toBe(true);
  });
});

describe('lineage backfill proposals', () => {
  it('proposes a high-confidence cause when the message names a feedback item, low when only a target matches', async () => {
    const fb = await ok('feedback_create', { targets: ['mandate://components/api-gateway/sections/responsibility'], kind: 'improvement', body: 'Name the rate limiter in the gateway responsibility.' });
    const fbId = fb.ref.split('/').pop();
    const file = 'components/api-gateway.md';
    edit(file, 'Routes requests, validates bodies at the edge and applies rate limits.', 'Routes requests, validates bodies at the edge and applies rate limits (the gateway rate limiter).');
    const named = rawCommit([file], `component(api-gateway): name the rate limiter (${fbId})`);
    edit(file, 'errors follow the shared error shape.', 'errors follow the shared error shape, always.');
    const unnamed = rawCommit([file], 'component(api-gateway): tune');
    await fx.index.ensureFresh();
    const props = proposeAnnotations(fx.index.db, { feedback: await fx.storage.feedback.list(), workOrders: await fx.storage.workOrders.list() });
    const p1 = props.find((p) => p.commit === named);
    expect(p1).toMatchObject({ confidence: 'high', causes: [fb.ref] });
    expect(p1!.evidence.join(' ')).toMatch(/names/);
    const p2 = props.find((p) => p.commit === unnamed);
    if (p2) expect(p2.confidence).toBe('low');
  });
});
