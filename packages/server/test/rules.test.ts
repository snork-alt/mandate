/** Richer standards: rule sections (levels in the gate), lifecycle, scope, rulesForCode, ruleCheckPlan and the migration. */
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema, createStandardSchema } from '@mandate/shared';
import { createStorage, deriveSpecs, rulesForCode, setSpecStatus } from '../src/storage/index.js';
import { applyRichStandards, inferLevel } from '../scripts/rules-seed.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const sec = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), body: `${id} body`, ...extra });
const rule = (id: string, level: 'must' | 'should' | 'may', extra: object = {}) => ({ id, title: id, type: 'rule', level, rationale: `why ${id}`, body: `${id} holds`, ...extra });
const T = (id: string, sid?: string) => `mandate://standards/${id}${sid ? `/sections/${sid}` : ''}`;

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const spec = (id: string, sections: object[], extra: object = {}) => storage.specs.create(createSpecSchema.parse({ id, title: id, sections, ...extra }));
  const std = (id: string, sections: object[], extra: object = {}) => storage.standards.create(createStandardSchema.parse({ id, title: id, sections, ...extra }));
  const pass = (criterion: string, spec: string) =>
    storage.verificationService.record({ criterion, appliedTo: `mandate://specs/${spec}`, result: 'pass', method: 'test', code: { repo: 'app', commit: 'abc1234' }, by: 'ci', evidence: { command: 'npm run lint', output: 'ok' } });
  return { git, storage, spec, std, pass };
}

describe('rule levels in the done gate', () => {
  it('must blocks, should only warns, may informs', async () => {
    const { storage, spec, std, pass } = await setup();
    await std('s', [rule('r-must', 'must'), rule('r-should', 'should'), rule('r-may', 'may')]);
    await spec('x', [sec('a', { links: [{ to: T('s'), rel: 'follows' }] })], { status: 'ready' });
    const v = await storage.verificationService.forSpec(await storage.specs.get('x'));
    expect(v.total).toBe(2); // may is informational
    expect(v.inherited[0]!.criteria.map((c) => [c.sectionId, c.level])).toEqual([
      ['r-must', 'must'],
      ['r-should', 'should'],
      ['r-may', 'may'],
    ]);
    await expect(setSpecStatus(storage, { id: 'x', status: 'done' })).rejects.toMatchObject({ code: 'done_gate', details: [expect.objectContaining({ uri: T('s', 'r-must') })] });
    const r = await pass(T('s', 'r-must'), 'x');
    expect(r.evidence).toMatchObject({ command: 'npm run lint', output: 'ok' });
    expect((await setSpecStatus(storage, { id: 'x', status: 'done' })).status).toBe('done');
    const d = (await deriveSpecs([await storage.specs.get('x')], await storage.model(), storage.verificationService)).x!;
    expect(d.warnings.join(' ')).toMatch(/1 should-level rule\(s\) not verified: r-should/);
    // A rule added after done: Drifted, not retroactively failing (done stays done).
    const s = await storage.standards.get('s');
    await storage.standards.update('s', { sections: [...s.sections, rule('r-new', 'must')] } as never);
    expect((await storage.specs.get('x')).status).toBe('done');
    expect((await storage.verificationService.drift(await storage.specs.get('x'), await storage.model())).join(' ')).toMatch(/added since done: r-new/);
  });

  it('keeps rules in standards and acceptance criteria in specs', async () => {
    const { spec, std } = await setup();
    await expect(spec('x', [rule('r', 'must')])).rejects.toMatchObject({ code: 'invalid_section_type' });
    await expect(std('s', [{ id: 'ac', title: 'AC', type: 'acceptance', method: 'test', body: 'x' }])).rejects.toMatchObject({ code: 'invalid_section_type' });
  });
});

describe('standard lifecycle', () => {
  it('drafts never apply; effectiveFrom ahead announces; deprecated warns and needs a successor; transitions', async () => {
    const { storage, spec, std } = await setup();
    await std('next', [rule('n', 'must')]);
    await std('draft', [rule('d', 'must')], { status: 'draft', appliesTo: ['tag:api'] });
    await std('soon', [rule('s', 'must')], { effectiveFrom: '2999-01-01' });
    await spec('x', [sec('a', { links: [{ to: T('soon'), rel: 'follows' }, { to: T('next'), rel: 'follows' }] })], { tags: ['api'], status: 'ready' });
    let v = await storage.verificationService.forSpec(await storage.specs.get('x'));
    expect(v.inherited.map((g) => g.title).sort()).toEqual(['next', 'soon']); // draft excluded
    expect(v.inherited.find((g) => g.title === 'soon')!.criteria[0]).toMatchObject({ upcoming: true });
    expect(v.total).toBe(1); // only `next` counts
    // Deprecation needs a successor; specs following it get a warning pointing at it.
    await expect(storage.standards.update('soon', { status: 'deprecated' } as never)).rejects.toMatchObject({ code: 'invalid_standard' });
    await storage.standards.update('soon', { status: 'deprecated', supersededBy: 'next' } as never);
    const d = (await deriveSpecs([await storage.specs.get('x')], await storage.model(), storage.verificationService)).x!;
    expect(d.warnings.join(' ')).toMatch(/deprecated standard soon; use next instead/);
    await expect(storage.standards.update('soon', { status: 'draft' } as never)).rejects.toMatchObject({ code: 'invalid_transition' });
    v = await storage.verificationService.forSpec(await storage.specs.get('x'));
    expect(v.inherited.find((g) => g.title === 'draft')).toBeUndefined();
  });
});

describe('scope and rulesForCode', () => {
  it('matches globs and languages, narrows by rule scope, and adds rules inherited through spec sections', async () => {
    const { storage, spec, std } = await setup();
    await std('ts', [rule('ts-strict', 'must', { scope: { languages: ['typescript'] } }), rule('api-only', 'should', { scope: { paths: ['src/api/**'] } }), rule('plain', 'may')], {
      appliesTo: ['path:src/**'],
    });
    await std('sec', [rule('no-secrets', 'must'), rule('css-only', 'must', { scope: { languages: ['css'] } })]);
    await spec('x', [sec('impl', { refs: [{ repo: 'app', path: 'src/auth/login.ts', lines: '10-40' }], links: [{ to: T('sec'), rel: 'follows' }] })]);
    const m = await storage.model();
    const hits = (p: string, lines?: string, repo = 'app') => rulesForCode({ ...(repo ? { repo } : {}), path: p, ...(lines ? { lines } : {}) }, m).map((h) => `${h.title}:${h.why.join('+')}`).sort();
    // By scope: ts-strict (language) and plain (inherits its standard's path:src/** scope), not api-only (path).
    // By section: no-secrets (the spec section referencing this code follows `sec`); css-only is narrowed out;
    // `sec` rules have no code scope, so they never match a file by scope alone.
    // (`ts` applies spec-wide through path:src/**, so its rules also come through the referencing section.)
    expect(hits('src/auth/login.ts', '12')).toEqual(['no-secrets:section', 'plain:scope+section', 'ts-strict:scope+section']);
    expect(hits('src/api/routes.ts')).toEqual(['api-only:scope', 'plain:scope', 'ts-strict:scope']);
    expect(hits('src/auth/login.ts', '80-90')).toEqual(['plain:scope', 'ts-strict:scope']); // lines outside the referenced range
    expect(hits('lib/x.py')).toEqual([]); // outside the standard's path scope
    expect(hits('src/auth/login.ts', undefined, '')).toContain('no-secrets:section'); // any repo
    // path:/lang: appliesTo match specs through their code refs.
    const v = await storage.verificationService.forSpec(await storage.specs.get('x'));
    expect(v.inherited.find((g) => g.title === 'ts')!.criteria.map((c) => c.sectionId)).toEqual(['ts-strict', 'plain']);
    expect(v.inherited.find((g) => g.title === 'sec')!.criteria.map((c) => c.sectionId)).toEqual(['no-secrets']);
  });

  it('lists the automated checks of a spec (ruleCheckPlan)', async () => {
    const { storage, spec, std } = await setup();
    await std('s', [
      rule('lint-it', 'should', { check: { kind: 'lint', command: 'npm run lint', ruleId: 'x' } }),
      rule('test-it', 'must', { check: { kind: 'test', command: 'npm test' } }),
      rule('review-it', 'must', { check: { kind: 'review' } }),
    ]);
    await spec('x', [sec('a', { links: [{ to: T('s'), rel: 'follows' }] })]);
    const plan = await storage.verificationService.ruleCheckPlan({ spec: 'mandate://specs/x' });
    expect(plan.map((p) => [p.criterion.split('/').pop(), p.level, p.check.command, p.state])).toEqual([
      ['test-it', 'must', 'npm test', 'unverified'],
      ['lint-it', 'should', 'npm run lint', 'unverified'],
    ]);
  });
});

describe('migration to rule sections', () => {
  it('converts acceptance sections to rules with the same ids (verifications stay valid) and splits the prose', async () => {
    const { git, storage, spec } = await setup();
    // A pre-migration standard, written by hand (acceptance sections in standards are no longer accepted on write).
    await mkdir(path.join(git.dir, 'standards'), { recursive: true });
    await writeFile(
      path.join(git.dir, 'standards/security-baseline.md'),
      `---\ntitle: Security baseline\nappliesTo: [tag:security]\nsections:\n  - id: rules\n    title: Rules\n    type: markdown\n  - id: checklist\n    title: Review checklist\n    type: markdown\n  - id: ac-no-secrets-in-logs\n    title: No secrets or tokens in logs\n    type: acceptance\n    method: review\n---\n\n<!-- @section rules -->\n## Rules\n\n- Never log tokens.\n\n<!-- @section checklist -->\n## Review checklist\n\n- [ ] No secrets in logs\n\n<!-- @section ac-no-secrets-in-logs -->\n## No secrets or tokens in logs\n\nLogs never contain tokens.\n`,
    );
    await git.commit(['standards/security-baseline.md'], 'standard(security-baseline): legacy');
    await spec('x', [sec('a')], { tags: ['security'] });
    await storage.verificationService.record({ criterion: T('security-baseline', 'ac-no-secrets-in-logs'), appliedTo: 'mandate://specs/x', result: 'pass', method: 'review', code: { repo: 'app', commit: 'abc1234' }, by: 'ci' });
    const mapping = await applyRichStandards(storage, () => ({ author: { name: 'Giulia', email: 'g@example.com' } }));
    expect(mapping['security-baseline']![0]).toMatch(/ac-no-secrets-in-logs -> ac-no-secrets-in-logs/);
    const std = await storage.standards.get('security-baseline');
    expect(std.sections.find((s) => s.id === 'ac-no-secrets-in-logs')).toMatchObject({ type: 'rule', level: 'must', rationale: expect.any(String), check: { kind: 'lint' } });
    expect(std.sections.filter((s) => s.type === 'rule').length).toBeGreaterThanOrEqual(5);
    expect(std.sections.find((s) => s.id === 'rules')!.verifiedBy).toContain('sec-session-cookies');
    expect(std.effectiveFrom).toBe('2026-10-01');
    const log = await git.log(3);
    expect(log.find((c) => c.message.startsWith('standard(security-baseline): rules as rule sections'))!.message).toMatch(/Id mapping/);
    // The recorded pass still counts.
    const v = await storage.verificationService.forSpec(await storage.specs.get('x'));
    expect(v.inherited[0]!.criteria.find((c) => c.sectionId === 'ac-no-secrets-in-logs')!.state).toBe('verified');
    // Idempotent; the draft standard is created once.
    expect(await applyRichStandards(storage, () => ({}))).toEqual({});
    expect((await storage.standards.get('observability')).status).toBe('draft');
  });

  it('infers levels from wording', () => {
    expect(inferLevel('Never log tokens')).toBe('must');
    expect(inferLevel('Clients must retry')).toBe('must');
    expect(inferLevel('Prefer small functions')).toBe('should');
    expect(inferLevel('You may cache it')).toBe('may');
  });
});
