/**
 * Ported from the removed REST API tests: writes go through the storage services (with the same input schemas the
 * write tools use), reads through the UI view service (`doc_list`, `doc_get`, `version_get`, ... over MCP).
 */
import path from 'node:path';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFeedbackSchema,
  createSpecSchema,
  createStandardSchema,
  createWorkOrderSchema,
  updateFeedbackSchema,
  updateSpecSchema,
  updateStandardSchema,
  updateWorkOrderSchema,
  type CreateFeedbackInput,
} from '@mandate/shared';
import { createStorage, type CommitMeta, type Storage } from '../src/storage/index.js';
import { DocReadService } from '../src/storage/read.js';
import { DocViewService } from '../src/storage/views.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

let gitStore: Awaited<ReturnType<typeof newStore>>;
let s: Storage;
let views: DocViewService;
let reads: DocReadService;

beforeEach(async () => {
  gitStore = await newStore(path.join(await tempDir(), 'repo'));
  s = createStorage(gitStore);
  views = new DocViewService(s);
  reads = new DocReadService(s);
});
afterEach(async () => cleanupTempDirs());

const spec = async (payload: object, meta: CommitMeta = {}) => s.specs.create(createSpecSchema.parse(payload) as never, meta);
const updSpec = async (id: string, patch: object, meta: CommitMeta = {}) => s.specs.update(id, updateSpecSchema.parse(patch) as never, meta);
const std = async (payload: object, meta: CommitMeta = {}) => s.standards.create(createStandardSchema.parse(payload) as never, meta);
const updStd = async (id: string, patch: object, meta: CommitMeta = {}) => s.standards.update(id, updateStandardSchema.parse(patch) as never, meta);
const fb = async (payload: object, meta: CommitMeta = {}) => s.feedbackService.create(createFeedbackSchema.parse(payload) as CreateFeedbackInput, meta);
const updFb = async (id: string, patch: object, meta: CommitMeta = {}) => s.feedbackService.update(id, updateFeedbackSchema.parse(patch), meta);

describe('documents', () => {
  it('specs: create, update, history, versions, raw, archive-only', async () => {
    const created = await spec(
      { title: 'My Spec', category: 'auth', tags: ['api'], sections: [{ id: 'flow', title: 'Flow', type: 'mermaid', body: 'graph TD\n  A-->B' }] },
      { agent: 'claude@box', branch: 'spec/my-spec' },
    );
    expect(created).toMatchObject({ id: 'my-spec', status: 'draft' });
    let list = (await views.list({ kind: 'specs' })).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'my-spec', revisions: 1, updatedBy: 'claude@box', createdAt: expect.stringMatching(/^\d{4}-/) });
    expect((list[0]!.sections as { id: string; refs: unknown[] }[])[0]).toMatchObject({ id: 'flow', type: 'mermaid', body: 'graph TD\n  A-->B', refs: [] });

    await updSpec('my-spec', { title: 'Renamed', category: null });
    const got = await views.get({ kind: 'specs', id: 'my-spec' });
    expect(got).toMatchObject({ title: 'Renamed', tags: ['api'], revisions: 2, verification: expect.any(Object), links: expect.any(Object) });
    expect(got.category).toBeUndefined();

    const history = (await reads.historyGet({ ref: 'mandate://specs/my-spec' })).entries;
    expect(history.map((h) => h.subject)).toEqual(['spec: update my-spec', 'spec: create my-spec']);
    expect(history[1]).toMatchObject({ agent: 'claude@box', branch: 'spec/my-spec', changes: ['text'] });
    expect(history[0]!.changes).toEqual(['text', 'metadata']);
    const [latest, first] = history;

    let v = await views.version({ kind: 'specs', id: 'my-spec', commit: latest!.commit });
    expect(v).toMatchObject({ status: 'modified', base: first!.commit, index: 2, total: 2 });
    expect(v.before).toContain('title: My Spec');
    expect(v.after).toContain('title: Renamed');
    v = await views.version({ kind: 'specs', id: 'my-spec', commit: first!.commit.slice(0, 7), against: 'head' });
    expect(v).toMatchObject({ against: 'head', status: 'modified', newer: latest!.commit });
    expect((await views.raw({ kind: 'specs', id: 'my-spec' })).text).toMatch(/^---\ntitle: Renamed\n/);
    expect((await views.raw({ kind: 'specs', id: 'nope' })).text).toBeNull();
    await expect(views.version({ kind: 'specs', id: 'my-spec', commit: 'abcdef0' })).rejects.toMatchObject({ code: 'unknown_commit' });
    await expect(views.version({ kind: 'specs', id: 'my-spec', commit: 'zzz' } as never)).rejects.toThrow();

    // Documents are archive-only.
    await expect(s.specs.delete('my-spec')).rejects.toMatchObject({ code: 'archive_only' });
    expect(await updSpec('my-spec', { status: 'archived' })).toMatchObject({ status: 'archived' });
    list = (await views.list({ kind: 'specs' })).items;
    expect(list[0]).toMatchObject({ status: 'archived' });
    expect((await views.gitLog({ limit: 80 })).items).toHaveLength(3);
  });

  it('lists section types', () => {
    expect(views.sectionTypes({}).items).toEqual([
      expect.objectContaining({ id: 'markdown', label: 'Markdown' }),
      expect.objectContaining({ id: 'mermaid', fence: 'mermaid' }),
      expect.objectContaining({ id: 'html', fence: 'html' }),
      expect.objectContaining({ id: 'image', label: 'Image' }),
      expect.objectContaining({ id: 'acceptance' }),
      expect.objectContaining({ id: 'rule', label: 'Rule' }),
      expect.objectContaining({ id: 'audit-item', label: 'Audit item' }),
      expect.objectContaining({ id: 'wo-section', label: 'Work-order section' }),
    ]);
  });

  it('validates input', async () => {
    await expect(spec({ body: 'no title' })).rejects.toThrow();
    await expect(spec({ title: 'Dup', sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-id' })]) });
    await expect(spec({ title: 'Odd', sections: [{ id: 'a', title: 'A', type: 'video' }] })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown-type' })]) });
    await expect(reads.historyGet({ ref: 'mandate://specs/nope' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(views.get({ kind: 'specs', id: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(views.list({ kind: 'nope' } as never)).rejects.toThrow();
  });

  it('work orders default to pending; standards usage; git status and pull', async () => {
    await spec({ id: 'qs', title: 'QS', sections: [{ id: 'a', title: 'A', body: 'x' }] });
    const wo = await s.workOrderService.create(createWorkOrderSchema.parse({ spec: 'qs', kind: 'implement', sections: [{ id: 'a' }] }) as never);
    expect(wo.id).toMatch(/^q-\d{4}$/);
    expect(wo).toMatchObject({ status: 'pending' });
    expect(() => updateWorkOrderSchema.parse({ status: 'nope' })).toThrow();
    expect(() => createWorkOrderSchema.parse({ spec: 'qs', kind: 'review', sections: [] })).toThrow();
    expect(await reads.workOrderGet({ ref: wo.id })).toMatchObject({ item: { id: wo.id }, spec: { id: 'qs', title: 'QS' }, sections: [{ id: 'a', headChanged: false }] });
    expect((await reads.historyGet({ ref: `mandate://work-orders/${wo.id}` })).entries).toHaveLength(1);
    expect((await views.list({ kind: 'work-orders' })).items.map((w) => w.id)).toEqual([wo.id]);
    expect(await views.specImplementation({ id: 'qs' })).toEqual({ sections: {} });

    await std({ id: 'std', title: 'STD', appliesTo: ['tag:api'] });
    // Standards are linked at section level (follows the whole standard or one section); spec level is derived.
    const follows = (sid: string) => ({ sections: [{ id: sid, title: sid.toUpperCase(), links: [{ to: 'mandate://standards/std', rel: 'follows' }] }] });
    for (const [id, extra] of [
      ['whole', follows('a')],
      ['in-section', follows('b')],
      ['by-tag', { tags: ['api'] }],
      ['unrelated', { tags: ['ui'] }],
      ['archived', { status: 'archived', ...follows('a') }],
    ] as const) {
      await spec({ id, title: id, ...extra });
    }
    const usage = (await views.standardUsage({ id: 'std' })).items;
    expect(usage.map((u) => u.specId).sort()).toEqual(['archived', 'by-tag', 'in-section', 'whole']);
    expect(usage.find((u) => u.specId === 'in-section')).toMatchObject({ sections: [{ id: 'b', title: 'B' }], follows: [{ id: 'b', target: 'mandate://standards/std' }], appliesBy: [] });
    expect(usage.find((u) => u.specId === 'by-tag')).toMatchObject({ appliesBy: ['tag:api'] });
    expect((await views.get({ kind: 'specs', id: 'whole' })).standards).toEqual([expect.objectContaining({ id: 'std', sections: [{ id: 'a', target: 'mandate://standards/std' }] })]);
    expect((await views.list({ kind: 'standards' })).items[0]).toMatchObject({ id: 'std', usedBy: 3 }); // archived specs not counted
    await expect(views.standardUsage({ id: 'nope' })).rejects.toMatchObject({ statusCode: 404 });

    expect({ ...(await gitStore.status()), integrity: await s.integrity.current() }).toMatchObject({ clean: true, branch: 'main', integrity: { issues: [] } });
    expect(gitStore.hasRemote()).toBe(false);
  });
});

describe('feedback', () => {
  const doc = (id: string, body = 'x') => ({ id, title: id.toUpperCase(), sections: [{ id: 'a', title: 'A', body }, { id: 'b', title: 'B', body: 'y' }] });

  it('validates targets and resolutions', async () => {
    await spec(doc('fs'));
    const f1 = await fb({ targets: ['mandate://specs/fs/sections/a#L12'], kind: 'ambiguity', body: 'How often?', quote: 'x' });
    expect(f1.id).toMatch(/^fb-\d{4}$/);
    expect(f1).toMatchObject({ status: 'open', changes: [], warnings: [], createdBy: 'local' });
    expect(f1).not.toHaveProperty('source');
    // An intake bug may start without targets (C1); bad targets are still rejected.
    for (const bad of [['mandate://specs/nope'], ['mandate://specs/fs/sections/zz'], ['https://x']]) {
      await expect(fb({ targets: bad, kind: 'bug', body: 'b' }), JSON.stringify(bad)).rejects.toThrow();
    }
    const close = (patch: object) => updFb(f1.id, { status: 'closed', ...patch });
    await expect(close({})).rejects.toThrow(); // resolution required
    await expect(close({ resolution: 'rejected' })).rejects.toThrow(); // note required
    await expect(close({ resolution: 'duplicate' })).rejects.toThrow(); // duplicateOf required
    await expect(close({ resolution: 'duplicate', duplicateOf: 'fb-0099' })).rejects.toThrow(); // must exist
    await expect(updFb(f1.id, { resolution: 'applied' })).rejects.toThrow(); // only when closed
    expect(await views.docFeedback({ kind: 'specs', id: 'fs' })).toMatchObject({ openBySection: { a: 1 }, items: [{ id: f1.id, sections: ['a'] }] });
    // Verification results are targets too (to dispute a result); unknown ones are rejected.
    await expect(fb({ targets: ['mandate://verifications/vr-nope'], kind: 'bug', body: 'flaky' })).rejects.toThrow();
  });

  it('derives resulting changes (create, modify, delete, rename) from Feedback trailers, frozen at closing', async () => {
    await spec(doc('old-name'));
    await spec(doc('doomed'));
    await std({ id: 'std-a', title: 'Std A', sections: [{ id: 'r', title: 'R', body: 'one' }] });
    await fb({ id: 'fb-0001', targets: ['mandate://specs/old-name/sections/a'], kind: 'improvement', body: 'Rework' });
    await fb({ id: 'fb-0002', targets: ['mandate://specs/old-name/sections/b'], kind: 'question', body: 'Legacy' });
    // A legacy closed item with a whole-document target still loads (written before the section-only rule).
    const dir = gitStore.dir;
    const fbFile = path.join(dir, 'feedback.jsonl');
    await writeFile(fbFile, (await readFile(fbFile, 'utf8')).replace('"mandate://specs/old-name/sections/b"', '"mandate://specs/old-name"').replace(/"Legacy","status":"open"/, '"Legacy","status":"closed","resolution":"rejected","resolutionNote":"old"'));
    await gitStore.commit(['feedback.jsonl'], 'legacy item');
    const legacy = (await views.list({ kind: 'feedback' })).items.find((f) => f.id === 'fb-0002')!;
    expect(legacy).toMatchObject({ status: 'closed', targets: ['mandate://specs/old-name'] });
    expect(legacy.validationIssues).toBeUndefined();
    const tr: CommitMeta = { message: 'apply fb\n\nFeedback: fb-0001' };

    await updStd('std-a', { sections: [{ id: 'r', title: 'R', body: 'two' }, { id: 'n', title: 'New', body: 'z' }] }, tr);
    await std({ id: 'std-b', title: 'Std B', sections: [] }, tr);
    // Documents cannot be deleted through Mandate (archive-only); a deletion made by hand with a trailer still shows.
    await expect(s.specs.delete('doomed', tr)).rejects.toMatchObject({ code: 'archive_only' });
    await rm(path.join(dir, 'specs/doomed.md'));
    await gitStore.commit(['specs/doomed.md'], 'spec: remove doomed by hand\n\nFeedback: fb-0001');
    await rename(path.join(dir, 'specs/old-name.md'), path.join(dir, 'specs/new-name.md'));
    await gitStore.commit(['specs/old-name.md', 'specs/new-name.md'], 'spec: rename old-name\n\nFeedback: fb-0001');

    let r = await reads.feedbackGet({ ref: 'fb-0001' });
    const changes = r.feedback.changes;
    const by = (uri: string) => changes.find((c) => c.uri === uri);
    expect(by('mandate://standards/std-a')).toMatchObject({ action: 'modified', docTitle: 'Std A' });
    expect(by('mandate://standards/std-a')!.sections.map((x) => [x.id, x.action])).toEqual([
      ['r', 'modified'],
      ['n', 'added'],
    ]);
    expect(by('mandate://standards/std-b')).toMatchObject({ action: 'created', docTitle: 'Std B' });
    expect(by('mandate://specs/doomed')).toMatchObject({ action: 'deleted', docTitle: 'DOOMED' });
    expect(by('mandate://specs/doomed')!).toHaveProperty('lastVersion');
    expect(by('mandate://specs/new-name')).toMatchObject({ action: 'renamed', from: 'mandate://specs/old-name' });
    expect(changes).toHaveLength(4);

    // Close as applied; afterwards the item is immutable and trailers are rejected.
    const closed = await updFb('fb-0001', { status: 'closed', resolution: 'applied' });
    expect(closed).toMatchObject({ status: 'closed', resolution: 'applied', warnings: [] });
    expect(closed.closedAt).toBeTruthy();
    await expect(updFb('fb-0001', { body: 'edit' })).rejects.toMatchObject({ code: 'request_closed' });
    await expect(updFb('fb-0001', { status: 'closed', resolution: 'rejected', resolutionNote: 'n' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(s.feedbackService.delete('fb-0001')).rejects.toMatchObject({ statusCode: 409 });
    await expect(updStd('std-b', { title: 'Std B2' }, tr)).rejects.toMatchObject({ statusCode: 409 });
    expect((await views.get({ kind: 'standards', id: 'std-b' })).title).toBe('Std B'); // nothing written

    // A commit made outside Mandate after closing is ignored (and reported).
    await writeFile(path.join(dir, 'standards/std-b.md'), (await views.raw({ kind: 'standards', id: 'std-b' })).text!.replace('Std B', 'Std B3'));
    await gitStore.commit(['standards/std-b.md'], 'outside edit\n\nFeedback: fb-0001');
    r = await reads.feedbackGet({ ref: 'fb-0001' });
    expect(r.feedback.changes).toHaveLength(4);
    expect(r.feedback.warnings[0]).toMatch(/after it was closed/);

    // Hand edit of a closed line in feedback.jsonl is flagged.
    const jsonl = path.join(dir, 'feedback.jsonl');
    await writeFile(jsonl, (await readFile(jsonl, 'utf8')).replace('"Rework"', '"Reworked"'));
    await gitStore.commit(['feedback.jsonl'], 'hand edit');
    r = await reads.feedbackGet({ ref: 'fb-0001' });
    expect(r.feedback.warnings.some((w) => /Tampered/.test(w))).toBe(true);
  });

  it('warns when an applied item has no linked commits; duplicates link to an existing item', async () => {
    await spec(doc('w'));
    await expect(fb({ targets: ['mandate://specs/w'], kind: 'bug', body: 'whole doc' })).rejects.toThrow();
    await fb({ id: 'fb-0001', targets: ['mandate://specs/w/sections/a'], kind: 'bug', body: 'b1' });
    await fb({ id: 'fb-0002', targets: ['mandate://specs/w/sections/a'], kind: 'bug', body: 'b2' });
    // DF-12: applied needs a linked change; an explicit commit link (relatedTo) is one, but no Feedback-trailer commit
    // changed a document, so the warning stays.
    await expect(updFb('fb-0001', { status: 'closed', resolution: 'applied' })).rejects.toThrow(/applied_without_changes/);
    await updFb('fb-0001', { relatedTo: [`mandate://commits/${(await s.git.head())!}`] });
    expect((await updFb('fb-0001', { status: 'closed', resolution: 'applied' })).warnings[0]).toMatch(/no commit/);
    expect(await updFb('fb-0002', { status: 'closed', resolution: 'duplicate', duplicateOf: 'fb-0001' })).toMatchObject({ resolution: 'duplicate', duplicateOf: 'fb-0001' });
    expect((await fb({ targets: ['mandate://specs/w/sections/b'], kind: 'question', body: 'follow-up', relatedTo: ['fb-0001'] })).relatedTo).toEqual(['fb-0001']);
  });
});
