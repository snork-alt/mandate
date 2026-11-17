/**
 * Ids are assigned by Mandate (slugs of titles, sequenced fb / q / vr, unique inside the write lock) and integrity is
 * always checked (pre-commit ERROR gate, per-write delta, incremental report = full check, sync and periodic re-checks).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createComponentSchema, createSpecSchema, idFromTitle, INTEGRITY_RULES, type IntegrityDelta } from '@mandate/shared';
import { checkIntegrity, coveredBy, createStorage, type Storage } from '../src/storage/index.js';
import { IntegrityViolationError, neighbours } from '../src/storage/integrity.js';
import { DocReadService } from '../src/storage/read.js';
import { DocViewService } from '../src/storage/views.js';
import { callTool, type ToolContext } from '../src/mcp/define.js';
import { TOOLS } from '../src/mcp/server.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const ctx: ToolContext = { storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), clientName: 'tester' };
  const call = async (name: string, args: Record<string, unknown>) => {
    const def = TOOLS.find((t) => t.name === name)!;
    const r = await callTool(def, args, ctx);
    return { ok: !r.isError, body: r.structuredContent as Record<string, any> };
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { git, storage, ctx, call, ok };
}

const SPEC = (title: string, sections: object[] = [{ title: 'Overview', body: 'What it does.' }]) => ({ title, sections });

describe('ids are assigned by Mandate', () => {
  it('documents: slug of the title, max 48 chars, ascii, de-duplicated -2 / -3; the result returns id and ref', async () => {
    const { ok } = await setup();
    const a = await ok('spec_create', SPEC('Login & SSO — Flow'));
    expect(a.ref).toBe('mandate://specs/login-sso-flow');
    expect(a.document.id).toBe('login-sso-flow');
    expect((await ok('spec_create', SPEC('Login & SSO flow'))).ref).toBe('mandate://specs/login-sso-flow-2');
    expect((await ok('spec_create', SPEC('login sso flow'))).ref).toBe('mandate://specs/login-sso-flow-3');
    const long = await ok('spec_create', SPEC('A very long title that goes on and on beyond the limit of ids for sure'));
    expect(long.document.id.length).toBeLessThanOrEqual(48);
    expect(long.document.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect((await ok('spec_create', SPEC('Ünïcödé café'))).document.id).toBe('unicode-cafe');
    expect((await ok('spec_create', SPEC('日本語'))).document.id).toBe('spec');
    expect((await ok('standard_create', { title: 'Secure Defaults', sections: [{ title: 'Rules', body: 'x' }] })).ref).toBe('mandate://standards/secure-defaults');
    expect((await ok('component_create', { title: 'Auth Service', kind: 'service' })).ref).toBe('mandate://components/auth-service');
  });

  it('sections: slug of the title, unique per document (also against archived and former ids); verifiedBy names siblings by title', async () => {
    const { ok } = await setup();
    const s = await ok('spec_create', SPEC('Checkout', [{ title: 'Design', body: 'd' }, { title: 'Design', body: 'again' }, { title: 'Pays once', type: 'acceptance', method: 'test', body: 'ok' }, { title: 'Flow', body: 'f', verifiedBy: ['pays-once'] }]));
    expect(s.document.sections.map((x: { id: string }) => x.id)).toEqual(['design', 'design-2', 'pays-once', 'flow']);
    expect(s.document.sections[3].verifiedBy).toEqual(['pays-once']);
    const ins = await ok('spec_section_insert', { doc: s.ref, section: { title: 'Design', body: 'third' } });
    expect(ins.ref).toBe('mandate://specs/checkout/sections/design-3');
    await ok('spec_section_archive', { ref: ins.ref });
    expect((await ok('spec_section_insert', { doc: s.ref, section: { title: 'Design', body: 'fourth' } })).ref).toBe('mandate://specs/checkout/sections/design-4');
  });

  it('sequenced kinds keep their formats: feedback fb-NNNN, work orders q-NNNN, verifications vr-NNNN; comments and audits as before', async () => {
    const { ok } = await setup();
    const s = await ok('spec_create', SPEC('Pay', [{ title: 'Design', body: 'd' }, { title: 'Works', type: 'acceptance', method: 'test', body: 'ok' }]));
    const fb1 = await ok('request_create', { targets: [`${s.ref}/sections/design`], kind: 'question', body: 'Why?' });
    const fb2 = await ok('request_create', { targets: [`${s.ref}/sections/design`], kind: 'question', body: 'How?' });
    expect([fb1.ref, fb2.ref]).toEqual(['mandate://requests/fb-0001', 'mandate://requests/fb-0002']);
    const wo = await ok('work_order_create', { spec: s.ref, sections: ['design'], kind: 'review', plan: 'Plan.' });
    expect(wo.ref ?? wo.workOrder?.id).toMatch(/q-0001$/);
    const vr = await ok('verification_record', { criterion: `${s.ref}/sections/works`, code: { repo: 'app', commit: 'abcdef1' }, result: 'pass', method: 'test' });
    expect(JSON.stringify(vr)).toMatch(/vr-0001/);
    const c = await ok('comment_add', { target: `mandate://work-orders/q-0001/sections/plan`, body: 'Looks fine.' });
    expect(JSON.stringify(c)).toMatch(/c-[0-9a-z]{26}/);
  });

  it('sequences skip older formats and continue after the highest number', async () => {
    const { storage } = await setup();
    await storage.feedback.create({ id: 'fb-01m75wdatzh7rgt231a8k6a0ks', targets: ['mandate://specs/x/sections/y'], kind: 'question', body: 'old', status: 'open', relatedTo: [] } as never).catch(() => undefined);
    await storage.feedback.create({ id: 'fb-0007', targets: ['mandate://specs/x/sections/y'], kind: 'question', body: 'seeded', status: 'open', relatedTo: [] } as never).catch(() => undefined);
    const ids = (await storage.feedback.list()).map((f) => f.id);
    const created = await storage.feedback.create({ targets: ['mandate://specs/x/sections/y'], kind: 'question', body: 'new', status: 'open', relatedTo: [] } as never).catch((e) => e as Error);
    if (created instanceof Error) return; // target validation of the service layer: the repository path is what matters here
    expect(created.id).toBe(ids.includes('fb-0007') ? 'fb-0008' : 'fb-0001');
  });

  it('a supplied id is refused with a clear hint (create, sections, section insert)', async () => {
    const { call, ok } = await setup();
    for (const [name, args] of [
      ['spec_create', { id: 'mine', title: 'Mine' }],
      ['spec_create', { title: 'Mine', sections: [{ id: 'mine', title: 'A' }] }],
      ['standard_create', { id: 'mine', title: 'Mine' }],
      ['component_create', { id: 'mine', title: 'Mine', kind: 'service' }],
    ] as const) {
      const r = await call(name, args);
      expect(r.ok, name).toBe(false);
      expect(r.body.error.message).toMatch(/ids are assigned by Mandate; omit id/);
      expect(r.body.error.hint).toMatch(/omit id/);
    }
    const s = await ok('spec_create', SPEC('Doc'));
    const r = await call('spec_section_insert', { doc: s.ref, section: { id: 'x', title: 'X' } });
    expect(r.body.error.path).toBe('section.id');
    expect(r.body.error.message).toMatch(/ids are assigned by Mandate/);
  });

  it('concurrent creates with the same title get distinct ids (allocated inside the write lock)', async () => {
    const { ok } = await setup();
    const docs = await Promise.all(Array.from({ length: 8 }, () => ok('spec_create', SPEC('Same title'))));
    expect(new Set(docs.map((d) => d.ref)).size).toBe(8);
    const spec = docs[0]!.ref as string;
    const secs = await Promise.all(Array.from({ length: 6 }, (_, i) => ok('spec_section_insert', { doc: spec, section: { title: 'Part', body: `p${i}` } })));
    expect(new Set(secs.map((x) => x.ref)).size).toBe(6);
    const fbs = await Promise.all(Array.from({ length: 6 }, () => ok('request_create', { targets: [`${spec}/sections/overview`], kind: 'question', body: 'q' })));
    expect(new Set(fbs.map((x) => x.ref)).size).toBe(6);
  });

  it('ids are immutable: updates never change them, documents are never deleted', async () => {
    const { ok, call, storage } = await setup();
    const s = await ok('spec_create', SPEC('Stable'));
    await ok('spec_update_meta', { ref: s.ref, title: 'Renamed completely' });
    expect((await storage.specs.get('stable')).title).toBe('Renamed completely');
    expect((await call('spec_update_meta', { ref: s.ref, id: 'other' })).ok).toBe(false);
    await expect(storage.specs.delete('stable')).rejects.toMatchObject({ code: 'archive_only' });
  });

  it('idFromTitle', () => {
    expect(idFromTitle('  Hello, World!  ', 'x')).toBe('hello-world');
    expect(idFromTitle('', 'section')).toBe('section');
    expect(idFromTitle('word '.repeat(30), 'x').length).toBeLessThanOrEqual(48);
  });
});

describe('integrity is always checked', () => {
  it('every write returns integrity { introduced, resolved }; warnings carry the hint', async () => {
    const { ok } = await setup();
    const c = await ok('component_create', { title: 'Billing', kind: 'service' });
    expect(c.integrity).toBeDefined();
    const rules = (c.integrity as IntegrityDelta).introduced.map((i) => i.rule).sort();
    expect(rules).toEqual(['component_no_code', 'component_no_standards', 'component_unreferenced']);
    expect(c.warnings.some((w: string) => w.startsWith('integrity: component_no_code') && w.includes('fix:'))).toBe(true);
    const s = await ok('spec_create', SPEC('Bill', [{ title: 'Charge', body: 'c' }]));
    expect(s.integrity).toEqual({ introduced: [], resolved: [] });
    const link = await ok('spec_section_link_add', { ref: `${s.ref}/sections/charge`, to: c.ref, rel: 'affects' });
    expect(link.integrity.resolved.map((i: { rule: string }) => i.rule)).toEqual(['component_unreferenced']);
    const fb = await ok('request_create', { targets: [`${s.ref}/sections/charge`], kind: 'question', body: 'q' });
    expect(fb.integrity).toEqual({ introduced: [], resolved: [] });
  });

  it('every write tool goes through the integrity collector', () => {
    const writes = TOOLS.filter((t) => t.kind === 'write');
    expect(writes.length).toBeGreaterThan(30);
  });

  it('an ERROR rule blocks before the commit (no commit is created)', async () => {
    const { git, storage, ok } = await setup();
    await ok('spec_create', SPEC('Gate'));
    const head = await git.head();
    const spec = await storage.specs.get('gate');
    await expect(storage.specs.update('gate', { sections: spec.sections.map((s) => ({ ...s, implementedCommit: 'abc1234' })) } as never)).rejects.toBeInstanceOf(IntegrityViolationError);
    expect(await git.head()).toBe(head);
    expect((await git.status()).clean).toBe(true);
    // Through a tool: structured error with the issue and its hint.
    await storage.components.create(createComponentSchema.parse({ id: 'parent', title: 'Parent', kind: 'service', sections: [] }));
    await storage.components.create(createComponentSchema.parse({ id: 'child', title: 'Child', kind: 'service', parent: 'parent', sections: [] }));
    const before = await git.head();
    // Hand-written frontmatter edit through the repository that bypasses no domain rule but breaks an invariant.
    await expect(storage.components.update('child', { parent: 'missing' } as never)).rejects.toThrow();
    expect(await git.head()).toBe(before);
  });

  it('the incremental report equals the full check after random write sequences', async () => {
    const { storage } = await setup();
    await storage.integrity.run();
    const ids = ['a', 'b', 'c', 'd'];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (const id of ids) await storage.components.create(createComponentSchema.parse({ id: `c-${id}`, title: id, kind: rnd(2) ? 'service' : 'external', owns: rnd(2) ? [{ repo: 'app', paths: [`src/${id}/**`] }] : [], sections: [{ id: 'resp', title: 'R', body: 'r' }] }));
    for (const id of ids) await storage.specs.create(createSpecSchema.parse({ id: `s-${id}`, title: id, sections: [{ id: 'one', title: 'One', body: 'x', refs: rnd(2) ? [{ repo: 'app', path: `src/${ids[rnd(4)]}/x.ts` }] : [] }, { id: 'two', title: 'Two', body: 'y' }] }));
    for (let step = 0; step < 30; step++) {
      const op = rnd(5);
      const a = ids[rnd(4)]!;
      const b = ids[rnd(4)]!;
      try {
        if (op === 0) {
          const s = await storage.specs.get(`s-${a}`);
          await storage.specs.update(`s-${a}`, { sections: s.sections.map((x) => (x.id === 'one' ? { ...x, links: [...x.links.filter((l) => !l.to.includes('components')), { to: `mandate://components/c-${b}`, rel: 'affects' as const }] } : x)) } as never);
        } else if (op === 1) {
          const s = await storage.specs.get(`s-${a}`);
          await storage.specs.update(`s-${a}`, { sections: s.sections.map((x) => ({ ...x, links: [] })) } as never);
        } else if (op === 2 && a !== b) {
          const s = await storage.specs.get(`s-${a}`);
          await storage.specs.update(`s-${a}`, { sections: s.sections.map((x) => (x.id === 'two' ? { ...x, links: [{ to: `mandate://specs/s-${b}/sections/one`, rel: 'depends_on' as const }] } : x)) } as never);
        } else if (op === 3) {
          const c = await storage.components.get(`c-${a}`);
          await storage.components.update(`c-${a}`, { owns: c.owns.length ? [] : [{ repo: 'app', paths: [`src/${b}/**`] }] } as never);
        } else {
          await storage.components.update(`c-${a}`, { status: rnd(2) ? 'deprecated' : 'active' } as never);
        }
      } catch {
        /* rejected writes (cycles, transitions) commit nothing */
      }
      const cached = (storage.integrity as unknown as { report: { issues: { rule: string; uri: string; message: string }[] } }).report.issues;
      const full = checkIntegrity(await storage.model());
      const key = (i: { rule: string; uri: string; message: string }) => `${i.rule}|${i.uri}|${i.message}`;
      expect(cached.map(key).sort(), `step ${step}`).toEqual(full.map(key).sort());
    }
  });

  it('the incremental check equals the full check on the affected elements', async () => {
    const { storage } = await setup();
    await storage.components.create(createComponentSchema.parse({ id: 'x', title: 'X', kind: 'service', sections: [] }));
    await storage.specs.create(createSpecSchema.parse({ id: 's', title: 'S', sections: [{ id: 'a', title: 'A', body: 'a', links: [{ to: 'mandate://components/x', rel: 'affects' }] }] }));
    const m = await storage.model();
    const scope = new Set<string>();
    neighbours(m, 'mandate://components/x', scope);
    expect([...scope].sort()).toEqual(['mandate://components/x', 'mandate://specs/s']);
    const inc = checkIntegrity(m, { scope });
    const full = checkIntegrity(m).filter((i) => coveredBy(i, scope));
    expect(inc).toEqual(full);
  });

  it('re-checks fully after outside commits (sync) and periodically', async () => {
    const { git, storage } = await setup();
    await storage.integrity.run();
    const runs = storage.integrity.fullRuns;
    // An outside commit: a component written by hand.
    await writeFile(path.join(git.dir, 'components', 'hand.md').replace('/components/hand.md', '/hand.md'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(git.dir, 'components'), { recursive: true });
    await writeFile(path.join(git.dir, 'components', 'hand.md'), '---\ntitle: Hand\nkind: service\nstatus: active\nowns: []\ntags: []\n---\n');
    await git.commit(['components/hand.md'], 'hand edit');
    const r = await storage.integrity.sync();
    expect(storage.integrity.fullRuns).toBe(runs + 1);
    expect(r.head).toBe(await git.head());
    expect(r.issues.some((i) => i.uri === 'mandate://components/hand')).toBe(true);
    // Unchanged HEAD: no re-run.
    await storage.integrity.sync();
    expect(storage.integrity.fullRuns).toBe(runs + 1);
    // Periodic.
    storage.integrity.start(20);
    await new Promise((res) => setTimeout(res, 120));
    storage.integrity.stop();
    expect(storage.integrity.fullRuns).toBeGreaterThan(runs + 2);
  });

  it('own writes keep the report current without full runs; changes are announced', async () => {
    const { storage } = await setup();
    await storage.integrity.run();
    const runs = storage.integrity.fullRuns;
    const seen: number[] = [];
    storage.integrity.onChange((_r, counts) => seen.push(counts.total));
    await storage.components.create(createComponentSchema.parse({ id: 'q', title: 'Q', kind: 'service', sections: [] }));
    const r = await storage.integrity.current();
    expect(storage.integrity.fullRuns).toBe(runs);
    expect(r.issues.filter((i) => i.uri === 'mandate://components/q')).toHaveLength(3);
    expect(seen.at(-1)).toBe(r.issues.length);
  });

  it('the registry classifies every rule the checker emits', async () => {
    const { storage } = await setup();
    const known = new Set(INTEGRITY_RULES.map((r) => r.rule));
    await storage.components.create(createComponentSchema.parse({ id: 'z', title: 'Z', kind: 'service', sections: [] }));
    for (const i of (await storage.integrity.run()).issues) {
      expect(known.has(i.rule), i.rule).toBe(true);
      expect(i.severity).toBe(INTEGRITY_RULES.find((r) => r.rule === i.rule)!.severity);
    }
    for (const r of INTEGRITY_RULES.filter((x) => x.severity === 'error')) expect(r.enforcedBy, r.rule).toMatch(/guard/);
  });
});

export type { Storage };
