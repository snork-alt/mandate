/**
 * Data consistency on the bad states the Fable data review found (plans/fable-data-review.md section 2, fixes in
 * plans/fable-data-fixes.md). Each `D-*` test rebuilds the state (in memory, or through the real tools) and asserts
 * the invariant that now reports or rejects it. `DF-*` are the code issues found while fixing the data.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandardSchema, type IntegrityIssue } from '@mandate/shared';
import { checkIntegrity, createStorage, IntegrityViolationError } from '../../src/storage/index.js';
import { coverage } from '../../src/storage/components.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/server.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';
import { audit, baseModel, C, comp, finding, issuesOf, S, spec, std, T, wo } from './fixtures.js';

afterEach(cleanupTempDirs);

/** login-sso as the review found it: `callback` owns callback.ts#L1-L80 and is verified by both criteria. */
function loginSso() {
  const m = baseModel();
  m.specs.push(
    spec('login-sso', [
      { id: 'overview', title: 'Overview', body: 'o' },
      { id: 'auth-flow', title: 'Auth flow', body: 'a', refs: [{ repo: 'app', path: 'src/auth/oidc.ts', lines: '10-64' }] },
      { id: 'callback', title: 'Callback', body: 'c', refs: [{ repo: 'app', path: 'src/auth/callback.ts', lines: '1-80' }], verifiedBy: ['ac-unverified-rejected', 'ac-callback-logging'] },
      { id: 'ac-unverified-rejected', title: 'Unverified emails are rejected', type: 'acceptance', method: 'test', body: 'x' },
      { id: 'ac-callback-logging', title: 'Callback errors are logged without tokens', type: 'acceptance', method: 'review', body: 'x' },
    ]),
  );
  m.standards.push(std('security-baseline', [{ id: 'ac-no-secrets-in-logs', title: 'No secrets in logs', type: 'rule', level: 'must', rationale: 'r', body: 'x' }]));
  return m;
}
const f3 = (extra: Record<string, unknown> = {}) => finding('f3', ['app:src/auth/callback.ts#L71-L76', 'app:src/log/redact.ts#L1-L24'], { severity: 'critical', ...extra });
const loginAudit = (passItem: Record<string, unknown> = {}, f: Record<string, unknown> = f3(), extra: Record<string, unknown> = {}) =>
  audit(
    '2026-11-12-login-sso',
    S('login-sso'),
    [
      { id: 'ac-callback-logging', ref: S('login-sso', 'ac-callback-logging'), result: 'pass', ...passItem },
      { id: 'ac-unverified-rejected', ref: S('login-sso', 'ac-unverified-rejected'), result: 'fail', findings: [finding('f1', ['app:src/auth/callback.ts#L44-L58'], { severity: 'major', classification: 'code_deviates' })] },
      { id: 'security-baseline-ac-no-secrets-in-logs', kind: 'rule', ref: T('security-baseline', 'ac-no-secrets-in-logs'), result: 'fail', findings: [f] },
    ],
    extra,
  );

describe('Fable data findings (in-memory fixtures)', () => {
  it('D-A1: an audit item passes a criterion while an open critical finding of the same audit sits on the code it verifies', () => {
    const found = issuesOf(loginSso(), 'audit_pass_contradicted', { audits: [loginAudit()] });
    expect(found.map((i) => i.uri)).toEqual(['mandate://audits/2026-11-12-login-sso/sections/ac-callback-logging', 'mandate://audits/2026-11-12-login-sso/sections/ac-callback-logging']);
    expect(found.map((i) => i.message).join('\n')).toMatch(/open critical finding f3 \(security-baseline-ac-no-secrets-in-logs\) is on the code it verifies: app:src\/auth\/callback\.ts#L71-L76/);
    expect(found[0]!.severity).toBe('warning');
  });

  it('D-A1: not reported once the findings are resolved, for non-code findings, other code, or abandoned audits', () => {
    const resolvedF1 = { result: 'pass' };
    const quiet = (a: ReturnType<typeof loginAudit>) => issuesOf(loginSso(), 'audit_pass_contradicted', { audits: [a] }).filter((i) => i.message.includes('f3'));
    expect(quiet(loginAudit(resolvedF1, f3({ resolution: { status: 'resolved' } })))).toEqual([]);
    expect(quiet(loginAudit(resolvedF1, f3({ classification: 'spec_wrong' })))).toEqual([]);
    expect(quiet(loginAudit(resolvedF1, f3({ codeRefs: ['app:src/auth/callback.ts#L90-L95'] })))).toEqual([]);
    expect(quiet(loginAudit(resolvedF1, f3(), { status: 'abandoned' }))).toEqual([]);
    // A partial / fail item is not a contradiction.
    expect(quiet(loginAudit({ result: 'fail' }))).toEqual([]);
  });

  it('D-A1: an item recorded pass with its own open must finding (hand edit) is reported', () => {
    const a = loginAudit({ findings: [finding('f9', [], { severity: 'minor', classification: 'ambiguous' })] });
    expect(issuesOf(loginSso(), 'audit_pass_contradicted', { audits: [a] }).some((i) => i.message === 'ac-callback-logging is pass with its own open minor finding f9')).toBe(true);
  });

  it('D-V1: a rule audit item recorded pass on code with an open critical finding is reported when the finding is its own', () => {
    const a = audit('2026-11-12-login-sso', S('login-sso'), [{ id: 'r', kind: 'rule', ref: T('security-baseline', 'ac-no-secrets-in-logs'), result: 'pass', findings: [f3()] }]);
    expect(issuesOf(loginSso(), 'audit_pass_contradicted', { audits: [a] })).toHaveLength(1);
  });

  it('D-W9: a fix work order that targets auth-flow and a criterion while the findings sit in callback is reported', () => {
    const m = loginSso();
    m.workOrders = [wo('wo-01m779etbv367r8jmhwy2236aa', 'login-sso', ['ac-unverified-rejected', 'auth-flow'], { kind: 'fix', findings: ['mandate://audits/2026-11-12-login-sso/findings/f1', 'mandate://audits/2026-11-12-login-sso/findings/f3'] })];
    const found = issuesOf(m, 'fix_misses_finding_code', { audits: [loginAudit()] });
    expect(found.map((i) => i.message)).toEqual([
      'audits/2026-11-12-login-sso/findings/f1: its code is in callback, which the work order does not target',
      'audits/2026-11-12-login-sso/findings/f3: its code is in callback, which the work order does not target',
    ]);
    // The replacement (q-0007: callback + both criteria) is clean; so is the cancelled order.
    m.workOrders = [
      wo('q-0007', 'login-sso', ['callback', 'ac-unverified-rejected', 'ac-callback-logging'], { kind: 'fix', findings: ['mandate://audits/2026-11-12-login-sso/findings/f3'] }),
      wo('wo-01m779etbv367r8jmhwy2236aa', 'login-sso', ['ac-unverified-rejected', 'auth-flow'], { kind: 'fix', status: 'cancelled', findings: ['mandate://audits/2026-11-12-login-sso/findings/f1'] }),
    ];
    expect(issuesOf(m, 'fix_misses_finding_code', { audits: [loginAudit()] })).toEqual([]);
  });

  it('D-T2: a deprecated standard that extends / supersedes sections of its own successor is an ERROR', () => {
    const m = baseModel();
    m.standards.push(
      std('rate-limit-headers', [{ id: 'rules', title: 'Rules', body: 'r', links: [{ to: T('std', 'rules'), rel: 'extends' }, { to: T('std', 'r1'), rel: 'supersedes', note: 'old headers' }] }], { status: 'deprecated', supersededBy: 'std' }),
    );
    const found = issuesOf(m, 'standard_successor_loop');
    expect(found.map((i) => i.message)).toEqual([
      'extends standards/std/sections/rules: a section of its own successor std',
      'supersedes standards/std/sections/r1: a section of its own successor std',
    ]);
    expect(found.every((i) => i.severity === 'error')).toBe(true);
  });

  it('D-C5: an external component that follows internal code rules is reported; its internal caller may follow them', () => {
    const m = baseModel();
    m.standards.push(std('testing-policy', [{ id: 'test-fake-http', title: 'Fake HTTP', type: 'rule', level: 'must', rationale: 'r', scope: { paths: ['**/*.test.ts'] }, check: { kind: 'lint', command: 'npm run lint' }, body: 'x' }]));
    m.components = (m.components ?? []).map((c) => (c.id === 'ext' ? comp('ext', [{ id: 'api', title: 'API', body: 'a', links: [{ to: T('testing-policy', 'test-fake-http'), rel: 'follows' }, { to: T('std'), rel: 'follows' }] }], { kind: 'external' }) : c));
    const found = issuesOf(m, 'external_follows_internal');
    expect(found).toHaveLength(1);
    expect(found[0]!.uri).toBe(C('ext', 'api'));
    expect(found[0]!.message).toBe('external ext follows internal code rules: testing-policy/test-fake-http, std/r1');
    // The fix of the data: the rule moved to the internal caller.
    m.components = m.components.map((c) => (c.id === 'ext' ? comp('ext', [{ id: 'api', title: 'API', body: 'a' }], { kind: 'external' }) : c.id === 'svc' ? { ...c, sections: c.sections.map((s) => ({ ...s, links: [...s.links, { to: T('testing-policy', 'test-fake-http'), rel: 'follows' as const }] })) } : c));
    expect(issuesOf(m, 'external_follows_internal')).toEqual([]);
  });

  it('D-S20: done specs with drift are reported (drift as derived by verification)', () => {
    const m = baseModel();
    m.specs = m.specs.map((s) => ({ ...s, status: 'done' as const }));
    const drift = new Map([['app', ['13 criteria added since done: A, B', '8 criteria not verified now: A (unverified)']]]);
    const found = issuesOf(m, 'done_spec_drift', { drift });
    expect(found.map((i) => i.message)).toEqual(['app is done but drifted: 13 criteria added since done; 8 criteria not verified now']);
  });

  it('D-C1: code referenced only by standards, work orders or audit findings counts as known code (owned or not)', () => {
    const m = baseModel();
    m.components = (m.components ?? []).map((c) => (c.id === 'svc' ? { ...c, owns: [{ repo: 'app', paths: ['src/**', 'test/metering/**', 'lib/**', 'tools/**'] }] } : c));
    // Before: three globs match no spec ref.
    expect(issuesOf(m, 'owns_matches_nothing').map((i) => i.message)).toHaveLength(3);
    m.standards = m.standards.map((s) => ({ ...s, sections: s.sections.map((x) => (x.id === 'rules' ? { ...x, refs: [{ repo: 'app', path: 'lib/validate.ts' }] } : x)) }));
    m.workOrders = [wo('q-0002', 'app', ['flow'], { touched: [{ repo: 'app', path: 'test/metering/flush.test.ts', change: 'added' }, { repo: 'api', path: 'src/gone.ts', change: 'deleted' }] })];
    const a = audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'fail', findings: [finding('f1', ['app:tools/build.ts#L1-L3', 'web:src/page.tsx'])] }]);
    expect(issuesOf(m, 'owns_matches_nothing', { audits: [a] })).toEqual([]);
    // Unowned code of those sources is reported too (the deleted file is not).
    expect(issuesOf(m, 'unowned_code_ref', { audits: [a] }).map((i) => `${i.uri} ${i.message}`)).toEqual(['mandate://audits/au/findings/f1 web:src/page.tsx is not owned by any component; flow_next will ask you to create or update a component owning it']);
    expect(coverage(m, [a]).unowned).toHaveLength(1);
  });

  it('DF-4: the ownership check counts audit, work-order and standard refs, not only spec refs', () => {
    const m = baseModel();
    m.components!.push(comp('platform', [{ id: 'r', title: 'R', body: 'r', links: [{ to: T('std'), rel: 'follows' }] }], { owns: [{ repo: 'app', paths: ['platform/**'] }] }));
    m.specs[0]!.sections[0]!.links.push({ to: C('platform'), rel: 'affects' });
    expect(issuesOf(m, 'owns_matches_nothing').map((i) => i.uri)).toEqual([C('platform')]);
    const a = audit('au', S('app'), [{ id: 'ac-flow', ref: S('app', 'ac-flow'), result: 'fail', findings: [finding('f1', ['app:platform/boot.ts#L1-L9'])] }]);
    expect(issuesOf(m, 'owns_matches_nothing', { audits: [a] })).toEqual([]);
    // Abandoned audits do not count.
    expect(issuesOf(m, 'owns_matches_nothing', { audits: [{ ...a, status: 'abandoned' }] })).toHaveLength(1);
  });

  it('DF-5: component_no_standards does not fire on kind: external components', () => {
    const m = baseModel();
    expect(m.components!.find((c) => c.id === 'ext')!.sections.flatMap((s) => s.links)).toEqual([]);
    expect(issuesOf(m, 'component_no_standards')).toEqual([]);
    m.components = m.components!.map((c) => (c.id === 'ext' ? { ...c, kind: 'service' as const } : c));
    expect(issuesOf(m, 'component_no_standards').map((i) => i.uri)).toEqual([C('ext')]);
  });
});

/* ---------------------------------------------------------------- through the real tools and the gate */

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
  return { git, storage, call, ok };
}
const key = (i: Pick<IntegrityIssue, 'rule' | 'uri' | 'message'>) => `${i.rule}|${i.uri}|${i.message}`;

describe('Fable data findings (real storage)', () => {
  it('D-T2: the pre-commit gate rejects a standard write that supersedes / extends its own successor; nothing is committed', async () => {
    const { git, storage } = await setup();
    await storage.standards.create(createStandardSchema.parse({ id: 'api-conventions', title: 'API conventions', sections: [{ id: 'rules', title: 'Rules', body: 'r' }] }));
    await storage.standards.create(createStandardSchema.parse({ id: 'rate-limit-headers', title: 'Rate limit headers', sections: [{ id: 'rules', title: 'Rules', body: 'r', links: [{ to: T('api-conventions', 'rules'), rel: 'extends' }] }] }));
    const head = await git.head();
    // Deprecating it in favour of the standard it extends would create the loop.
    const err = await storage.standards.update('rate-limit-headers', { status: 'deprecated', supersededBy: 'api-conventions' } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityViolationError);
    expect((err as IntegrityViolationError).issues.map((i) => i.rule)).toEqual(['standard_successor_loop']);
    expect(await git.head()).toBe(head);
    // The right direction is accepted: drop the extends link, then deprecate.
    const cur = await storage.standards.get('rate-limit-headers');
    await storage.standards.update('rate-limit-headers', { sections: cur.sections.map((s) => ({ ...s, links: [{ to: T('api-conventions', 'rules'), rel: 'relates_to' as const }] })) } as never);
    await storage.standards.update('rate-limit-headers', { status: 'deprecated', supersededBy: 'api-conventions' } as never);
    expect((await storage.integrity.run()).issues.filter((i) => i.rule === 'standard_successor_loop')).toEqual([]);
  });

  it('D-A1: recording the contradicting finding through the audit tools reports audit_pass_contradicted in the write result; incremental = full', async () => {
    const { storage, ok } = await setup();
    await storage.integrity.run();
    const sb = await ok('standard_create', { title: 'Security baseline', sections: [{ title: 'No secrets in logs', type: 'rule', level: 'must', rationale: 'Logs leak.', body: 'Never log tokens or codes.' }] });
    const login = await ok('spec_create', {
      title: 'Login SSO',
      sections: [
        { title: 'Callback', body: 'Handle the callback.', refs: [{ repo: 'app', path: 'src/auth/callback.ts', lines: '1-80' }], verifiedBy: ['callback-logging'] },
        { title: 'Callback logging', type: 'acceptance', method: 'review', body: 'Errors are logged without tokens.' },
      ],
    });
    await ok('spec_section_link_add', { ref: `${login.ref}/sections/callback`, to: sb.ref, rel: 'follows' });
    const started = await ok('audit_start', { target: login.ref, code: { repo: 'app', commit: 'abcdef1' } });
    const auditId = started.audit?.id ?? started.auditId ?? started.id ?? /audits\/([^/"]+)/.exec(JSON.stringify(started))![1];
    const pass = await ok('audit_record_item', { auditId, ref: `${login.ref}/sections/callback-logging`, result: 'pass', notes: 'Read callback.ts#L1-L80.' });
    expect(pass.integrity.introduced).toEqual([]);
    const fail = await ok('audit_record_item', {
      auditId,
      ref: `${sb.ref}/sections/no-secrets-in-logs`,
      result: 'fail',
      notes: 'The callback logs req.url.',
      findings: [{ title: 'Callback logs the code', description: 'req.url carries the code.', codeRefs: ['app:src/auth/callback.ts#L71-L76'], classification: 'code_deviates', severity: 'critical' }],
    });
    expect(fail.integrity.introduced.map((i: IntegrityIssue) => i.rule)).toContain('audit_pass_contradicted');
    const cached = (storage.integrity as unknown as { report: { issues: IntegrityIssue[] } }).report.issues;
    const full = (await storage.integrity.run()).issues;
    expect(cached.map(key).sort()).toEqual(full.map(key).sort());
    expect(full.filter((i) => i.rule === 'audit_pass_contradicted')).toHaveLength(1);
    // The same check, pure: the model plus the audits.
    expect(checkIntegrity(await storage.model(), { audits: await storage.audits.list() }).filter((i) => i.rule === 'audit_pass_contradicted')).toHaveLength(1);
  });
});
