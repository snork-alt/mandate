/**
 * Data consistency of the seed data (scripts/seed.ts into a temp repo): the seed goes through the real write path, so
 * it must pass the pre-commit gate (no ERROR rule, in particular no standard extending / superseding its own
 * successor, Fable D-T2), and the full integrity check reports the expected gaps only.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRITY_RULES, type IntegrityIssue } from '@mandate/shared';
import { checkIntegrity, createStorage, type Storage } from '../../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';

describe('seed data consistency', () => {
  let storage: Storage;
  let issues: IntegrityIssue[];
  const of = (rule: string) => issues.filter((i) => i.rule === rule);

  beforeAll(async () => {
    const root = await tempDir();
    const dir = path.join(root, 'repo');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MANDATE_HOME: path.join(root, 'home'), MANDATE_DATA_DIR: dir, INIT_CWD: root },
      stdio: 'pipe',
    });
    storage = createStorage(await newStore(dir));
    issues = (await storage.integrity.run()).issues;
  }, 120_000);
  afterAll(cleanupTempDirs);

  it('the seed has no ERROR-level integrity issue and only registry rules', () => {
    expect(issues.filter((i) => i.severity === 'error').map((i) => `${i.rule} ${i.uri}: ${i.message}`)).toEqual([]);
    const known = new Set(INTEGRITY_RULES.map((r) => r.rule));
    for (const i of issues) expect(known.has(i.rule), i.rule).toBe(true);
  });

  it('D-T2: no seeded standard extends or supersedes its own successor (rate-limit-headers -> api-conventions)', async () => {
    expect(of('standard_successor_loop')).toEqual([]);
    const rlh = await storage.standards.get('rate-limit-headers');
    expect(rlh.supersededBy).toBe('api-conventions');
    expect(rlh.sections.flatMap((s) => s.links).filter((l) => (l.rel === 'extends' || l.rel === 'supersedes') && l.to.startsWith('mandate://standards/api-conventions'))).toEqual([]);
  });

  it('D-C5: no seeded external component follows an internal code rule', () => {
    expect(of('external_follows_internal')).toEqual([]);
  });

  it('DF-5: seeded external components are not asked for standards', async () => {
    const external = new Set((await storage.components.list()).filter((c) => c.kind === 'external').map((c) => `mandate://components/${c.id}`));
    expect(of('component_no_standards').filter((i) => external.has(i.uri))).toEqual([]);
  });

  it('D-S20: the done specs whose criteria changed after done are reported as drifted (user-sessions)', () => {
    expect(of('done_spec_drift').map((i) => i.uri)).toContain('mandate://specs/user-sessions');
    for (const i of of('done_spec_drift')) expect(i.message).toMatch(/is done but drifted: /);
  });

  it('D-A1: no seeded audit item passes against an open must / critical finding', () => {
    expect(of('audit_pass_contradicted')).toEqual([]);
  });

  it('D-W9: no seeded fix work order misses the code its findings point to', () => {
    expect(of('fix_misses_finding_code')).toEqual([]);
  });

  it('the full report equals the pure check plus the drift rule (no rule depends on hidden state)', async () => {
    const pure = checkIntegrity(await storage.model(), { audits: await storage.audits.list() });
    const key = (i: IntegrityIssue) => `${i.rule}|${i.uri}|${i.message}`;
    expect(issues.filter((i) => i.rule !== 'done_spec_drift').map(key).sort()).toEqual(pure.map(key).sort());
  });
});
