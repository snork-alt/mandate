import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema, createStandardSchema, verificationRecordSchema } from '@mandate/shared';
import { createStorage, setSpecStatus } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const crit = (id: string, title: string, body: string, method = 'test') => ({ id, title, type: 'acceptance', method, body });

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  await storage.standards.create(
    createStandardSchema.parse({ id: 'sec', title: 'Security', appliesTo: ['tag:security'], sections: [{ ...crit('ac-no-secrets', 'No secrets in logs', 'Logs never contain tokens.', 'review'), type: 'rule', level: 'must', rationale: 'Logs leave the system.' }] }),
  );
  await storage.specs.create(
    createSpecSchema.parse({
      id: 'login',
      title: 'Login',
      tags: ['security'],
      status: 'active',
      sections: [
        { id: 'flow', title: 'Flow', body: 'x', verifiedBy: ['ac-rotate'] },
        crit('ac-rotate', 'Tokens rotate', 'Refresh rotates the token.'),
        crit('ac-fast', 'Fast', 'p95 < 300ms', 'manual'),
      ],
    }),
  );
  const v = storage.verificationService;
  const code = { repo: 'app', commit: 'abc1234', branch: 'main' };
  const rec = (criterion: string, result: 'pass' | 'fail', extra: object = {}) =>
    v.record({ criterion, result, method: 'test', code, by: 'claude', evidence: { test: 'auth.spec.ts' }, ...extra });
  return { git, storage, v, rec };
}

describe('verification', () => {
  it('validates records and is append-only', async () => {
    const { storage, rec } = await setup();
    expect(verificationRecordSchema.safeParse({ criterion: 'nope' }).success).toBe(false);
    const r = await rec('mandate://specs/login/sections/ac-rotate', 'pass');
    expect(r).toMatchObject({ appliedTo: 'mandate://specs/login', result: 'pass' });
    expect(r.id).toMatch(/^vr-\d{4}$/); // sequenced inside the write lock
    expect(r.specCommit).toMatch(/^[0-9a-f]{40}$/); // full sha (C4)
    await expect(rec('mandate://specs/login/sections/flow', 'pass')).rejects.toThrow(/not an acceptance section/);
    await expect(rec('mandate://standards/sec/sections/ac-no-secrets', 'pass')).rejects.toThrow(/appliedTo/);
    // I4: callers cannot set `at` (the server does; results are ordered by append position).
    await expect(rec('mandate://specs/login/sections/ac-rotate', 'pass', { at: '2099-01-01T00:00:00Z' })).rejects.toThrow();
    // M2: a supplied specCommit must exist and contain the criterion.
    await expect(rec('mandate://specs/login/sections/ac-rotate', 'pass', { specCommit: 'deadbeef' })).rejects.toThrow(/unknown commit/);
    await expect(storage.verifications.update(r.id, { result: 'fail' } as never)).rejects.toMatchObject({ statusCode: 409, code: 'append_only' });
    await expect(storage.verifications.delete(r.id)).rejects.toMatchObject({ code: 'append_only' });
  });

  it('derives verified / failing / stale / unverified, including inherited standard criteria', async () => {
    const { storage, v, rec } = await setup();
    await rec('mandate://specs/login/sections/ac-rotate', 'pass');
    await rec('mandate://specs/login/sections/ac-fast', 'fail');
    let spec = await storage.specs.get('login');
    let sv = await v.forSpec(spec);
    expect(sv.own.map((c) => [c.sectionId, c.state])).toEqual([
      ['ac-rotate', 'verified'],
      ['ac-fast', 'failing'],
    ]);
    expect(sv.inherited).toEqual([expect.objectContaining({ standard: 'mandate://standards/sec', criteria: [expect.objectContaining({ state: 'unverified' })] })]);
    expect(sv).toMatchObject({ verified: 1, total: 3, failing: 1, stale: 0 });

    // Editing the criterion after its last pass makes it stale.
    await storage.specs.update('login', {
      sections: spec.sections.map((s) => (s.id === 'ac-rotate' ? { ...s, body: 'Refresh rotates the token and revokes reuse.' } : s)),
    });
    spec = await storage.specs.get('login');
    sv = await v.forSpec(spec);
    expect(sv.own[0]!.state).toBe('stale');
    // A newer (later appended) failing result wins over an older pass, whatever the record times say.
    await rec('mandate://specs/login/sections/ac-rotate', 'fail', {}, );
    expect((await v.forSpec(spec)).own[0]!.state).toBe('failing');
    await rec('mandate://specs/login/sections/ac-rotate', 'pass');
    expect((await v.forSpec(await storage.specs.get('login'))).own[0]!.state).toBe('verified');
    // I4: changing a section that lists the criterion in verifiedBy makes the pass stale too.
    spec = await storage.specs.get('login');
    await storage.specs.update('login', { sections: spec.sections.map((s) => (s.id === 'flow' ? { ...s, body: 'new flow' } : s)) });
    const st = (await v.forSpec(await storage.specs.get('login'))).own[0]!;
    expect(st).toMatchObject({ state: 'stale', staleReason: expect.stringMatching(/Flow/) });

    const matrix = await v.forStandard(await storage.standards.get('sec'));
    expect(matrix.specs).toEqual([{ spec: 'login', title: 'Login', status: 'active', states: { 'mandate://standards/sec/sections/ac-no-secrets': 'unverified' } }]);
  });

  it('gates moving a spec to done until every own and inherited criterion is verified', async () => {
    const { storage, rec } = await setup();
    await expect(setSpecStatus(storage, { id: 'login', status: 'done' })).rejects.toMatchObject({ statusCode: 409, code: 'done_gate' });
    try {
      await storage.specs.update('login', { status: 'done' });
    } catch (err) {
      expect((err as { details: { title: string }[] }).details.map((d) => d.title)).toEqual(['Tokens rotate', 'Fast', 'No secrets in logs']);
    }
    await rec('mandate://specs/login/sections/ac-rotate', 'pass');
    await rec('mandate://specs/login/sections/ac-fast', 'pass');
    await rec('mandate://standards/sec/sections/ac-no-secrets', 'pass', { appliedTo: 'mandate://specs/login' });
    expect((await setSpecStatus(storage, { id: 'login', status: 'done' })).status).toBe('done');
    // Already done: other edits are not gated.
    expect((await storage.specs.update('login', { summary: 'ok' })).summary).toBe('ok');
  });
});
