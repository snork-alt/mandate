/**
 * Richer standards (shared by `npm run seed` and the in-place migration `migrate-rules.ts`):
 * converts each standard's prose "Rules" / "Checklist" bullets into one `rule` section per rule
 * (level inferred from the wording, rationale, Do / Don't examples, scope, checks), converts the
 * standards' former acceptance sections into `must` rules WITH THE SAME IDS (so existing verification
 * records stay valid; the id mapping is identity and is written into the commit message), and sets
 * the lifecycle: rate-limit-headers deprecated (superseded by api-conventions), a new draft standard.
 * Idempotent: standards that already have rule sections are left alone.
 */
import type { SectionInput, StoredStandard } from '@mandate/shared';
import type { CommitMeta, Storage } from '../src/storage/index.js';

type Rule = Omit<SectionInput, 'type'> & {
  id: string;
  title: string;
  level: 'must' | 'should' | 'may';
  rationale: string;
  body: string;
  scope?: { paths?: string[]; languages?: string[] };
  check?: { kind: 'lint' | 'test' | 'script' | 'review'; command?: string; ruleId?: string; note?: string };
  examples?: string[];
  /** Which prose section (rules / checklist / pagination) the rule came from. */
  from?: string;
};

const F = '```';
const doDont = (prose: string, lang: string, good: string, bad: string) => `${prose}\n\n**Do**\n\n${F}${lang}\n${good}\n${F}\n\n**Don't**\n\n${F}${lang}\n${bad}\n${F}`;
const TS = { languages: ['typescript'] };
const API_TS = { paths: ['src/api/**', 'src/routes/**', 'src/http/**', 'src/billing/**'], languages: ['typescript'] };
const TESTS = { paths: ['**/*.test.ts', '**/*.spec.ts', 'e2e/**'] };

/** Level from the wording: "must"/"never"/"always" -> must, "should" -> should, otherwise should. */
export function inferLevel(text: string): 'must' | 'should' | 'may' {
  if (/\b(must|never|always|only)\b/i.test(text)) return 'must';
  if (/\bmay\b/i.test(text)) return 'may';
  return 'should';
}

/** Former acceptance sections of standards -> rules (same ids). */
export const CONVERTED: Record<string, Record<string, Omit<Rule, 'id' | 'title' | 'body'>>> = {
  'security-baseline': {
    'ac-no-secrets-in-logs': {
      level: 'must',
      rationale: 'Logs are shipped to third-party tools and kept for months; a leaked token is a live credential.',
      scope: TS,
      check: { kind: 'lint', command: 'npm run lint -- --rule no-secret-log', ruleId: 'no-secret-log' },
      examples: ['mandate://code/app/src/log/redact.ts#L1-L24'],
    },
    'ac-inputs-validated': {
      level: 'must',
      rationale: 'Unvalidated input is the root of injection and mass-assignment bugs; validating once at the edge keeps handlers simple.',
      check: { kind: 'test', command: 'npm test -- edge-validation' },
    },
  },
  'ui-accessibility': {
    'ac-focus-visible': {
      level: 'must',
      rationale: 'Keyboard users cannot use controls they cannot see focused (WCAG 2.4.7).',
      check: { kind: 'review', note: 'Tab through the feature once.' },
    },
  },
};

/** New rule sections per standard (split from the prose bullets). */
export const RULES: Record<string, Rule[]> = {
  'security-baseline': [
    {
      id: 'sec-secrets-from-env',
      title: 'Secrets come from the environment or 1Password',
      level: 'must',
      from: 'rules',
      rationale: 'Secrets in the repository end up in every clone, fork and CI cache.',
      scope: { paths: ['src/**', 'config/**'] },
      check: { kind: 'script', command: 'gitleaks detect --no-banner' },
      body: doDont('Read secrets from `process.env` (populated by 1Password Connect); never commit them.', 'ts', "const key = process.env.STRIPE_SECRET_KEY!;", "const key = 'sk_live_51H…';"),
    },
    {
      id: 'sec-session-cookies',
      title: 'Session cookies are HttpOnly, Secure, SameSite=Lax',
      level: 'must',
      from: 'rules',
      rationale: 'Script-readable or cross-site cookies turn any XSS or CSRF into account takeover.',
      check: { kind: 'test', command: 'npm test -- session-cookie' },
      body: doDont('Set all three attributes on every session cookie.', 'ts', "res.cookie('sid', id, { httpOnly: true, secure: true, sameSite: 'lax' });", "res.cookie('sid', id);"),
    },
    {
      id: 'sec-token-lifetimes',
      title: 'Short-lived access tokens, rotating refresh tokens',
      level: 'must',
      from: 'rules',
      rationale: 'Short lifetimes limit the damage of a stolen token; rotation detects reuse.',
      check: { kind: 'test', command: 'npm test -- token-lifetime' },
      body: 'Access tokens live at most 15 minutes; refresh tokens rotate on every use.',
    },
    {
      id: 'sec-parameterized-queries',
      title: 'Parameterized queries only',
      level: 'must',
      from: 'rules',
      rationale: 'String-built SQL is the classic injection vector.',
      scope: { paths: ['src/**/*.ts', 'src/**/*.go'] },
      check: { kind: 'lint', command: 'npm run lint -- --rule no-sql-concat', ruleId: 'no-sql-concat' },
      body: doDont('Pass values as parameters.', 'ts', "db.query('select * from users where id = $1', [id]);", "db.query(`select * from users where id = '${id}'`);"),
    },
    {
      id: 'sec-authz-tests',
      title: 'New endpoints have authorization tests',
      level: 'should',
      from: 'checklist',
      rationale: 'Missing authorization checks are the most common API vulnerability (OWASP API1).',
      scope: { paths: ['src/api/**', 'src/routes/**'] },
      check: { kind: 'test', command: 'npm test -- authz' },
      body: 'Each new endpoint has a test that a user without the permission gets 403.',
    },
    {
      id: 'sec-dependency-advisories',
      title: 'No dependencies with critical advisories',
      level: 'should',
      from: 'checklist',
      rationale: 'Known-vulnerable dependencies are exploited within days of disclosure.',
      check: { kind: 'script', command: 'npm audit --audit-level=critical' },
      body: 'The dependency audit reports no critical advisories.',
    },
  ],
  'api-conventions': [
    {
      id: 'api-error-shape',
      title: 'Errors use one JSON shape with a matching status',
      level: 'must',
      from: 'rules',
      rationale: 'Clients and agents handle errors generically only if every endpoint answers the same way.',
      scope: API_TS,
      check: { kind: 'test', command: 'npm test -- error-shape' },
      examples: ['mandate://code/api/src/http/errors.ts#L1-L30'],
      body: doDont('Return `{ "error": { "code", "message" } }` with the HTTP status that matches the code.', 'ts', "reply.code(404).send({ error: { code: 'invoice_not_found', message: 'No such invoice' } });", "reply.code(200).send({ ok: false, msg: 'not found' });"),
    },
    {
      id: 'api-idempotency-key',
      title: 'Mutating endpoints accept Idempotency-Key',
      level: 'must',
      from: 'rules',
      rationale: 'Retries after timeouts must not create duplicates (payments, invites).',
      check: { kind: 'test', command: 'npm test -- idempotency' },
      body: 'Every POST / PUT / PATCH / DELETE accepts an `Idempotency-Key` header and replays the first response for a repeated key.',
    },
    {
      id: 'api-plural-resources',
      title: 'Resources are plural nouns',
      level: 'should',
      from: 'rules',
      rationale: 'Predictable URLs let clients guess endpoints and keep the API consistent.',
      check: { kind: 'review' },
      body: doDont('Name collections in the plural.', 'http', 'GET /v1/invoices/:id', 'GET /v1/getInvoice?id=…'),
    },
    {
      id: 'api-rfc3339-utc',
      title: 'Timestamps are RFC 3339 in UTC',
      level: 'should',
      from: 'rules',
      rationale: 'Local times and epoch numbers are ambiguous across clients and time zones.',
      scope: API_TS,
      check: { kind: 'lint', command: 'npm run lint -- --rule utc-timestamps', ruleId: 'utc-timestamps' },
      body: doDont('Serialize with `toISOString()`.', 'ts', 'createdAt: new Date().toISOString()', 'createdAt: Date.now()'),
    },
    {
      id: 'api-cursor-pagination',
      title: 'Lists paginate with opaque cursors',
      level: 'must',
      from: 'pagination',
      rationale: 'Offsets skip or repeat items when data changes between pages.',
      check: { kind: 'test', command: 'npm test -- pagination' },
      body: 'List endpoints take `?cursor=` and return `next_cursor` (null on the last page); offsets are not allowed.',
    },
    {
      id: 'api-rate-limit-headers',
      title: 'Rate limit headers on every response',
      level: 'must',
      from: 'rules',
      rationale: 'Clients back off correctly only if they can see their budget (replaces the deprecated rate-limit-headers standard).',
      check: { kind: 'test', command: 'npm test -- rate-limit-headers' },
      body: 'Send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; `429` responses also send `Retry-After` in seconds.',
    },
  ],
  'rate-limit-headers': [
    {
      id: 'rl-headers',
      title: 'Send the RateLimit-* headers',
      level: 'must',
      from: 'rules',
      rationale: 'Clients need their remaining budget to back off.',
      body: 'Send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response.',
    },
    {
      id: 'rl-retry-after',
      title: '429 responses send Retry-After',
      level: 'must',
      from: 'rules',
      rationale: 'Without it clients retry immediately and make the overload worse.',
      body: '`429` responses also send `Retry-After` in seconds.',
    },
  ],
  'testing-policy': [
    {
      id: 'test-lowest-level',
      title: 'Test at the lowest level that catches the bug',
      level: 'should',
      from: 'rules',
      rationale: 'Low-level tests are fast and precise; end-to-end tests are slow and flaky.',
      check: { kind: 'review' },
      body: 'New behaviour ships with tests at the lowest level that can catch the bug.',
    },
    {
      id: 'test-fake-http',
      title: 'Fake external services at the HTTP boundary',
      level: 'must',
      from: 'rules',
      rationale: 'In-process mocks drift from the real API; HTTP fakes exercise the real client code.',
      scope: { paths: ['**/*.test.ts', '**/*.spec.ts'], languages: ['typescript'] },
      check: { kind: 'lint', command: 'npm run lint -- --rule no-sdk-mocks', ruleId: 'no-sdk-mocks' },
      body: doDont('Run a fake server and point the client at it.', 'ts', "const stripe = await startFakeStripe(); process.env.STRIPE_URL = stripe.url;", "vi.mock('stripe', () => ({ default: vi.fn() }));"),
    },
    {
      id: 'test-e2e-critical',
      title: 'Critical paths have end-to-end tests',
      level: 'must',
      from: 'rules',
      rationale: 'Auth and billing failures cost the most and cross service boundaries.',
      scope: { paths: ['src/auth/**', 'src/billing/**'] },
      check: { kind: 'test', command: 'npm run e2e' },
      body: 'Auth and billing flows have at least one end-to-end test each.',
    },
    {
      id: 'test-no-sleeps',
      title: 'No sleeps or retries to make tests pass',
      level: 'should',
      from: 'checklist',
      rationale: 'Sleeps hide races and slow down the suite; flaky tests are fixed or deleted the same day.',
      scope: TESTS,
      check: { kind: 'lint', command: 'npm run lint -- --rule no-test-sleep', ruleId: 'no-test-sleep' },
      body: doDont('Wait for the condition, not for time.', 'ts', 'await expect.poll(() => job.status).toBe("done");', 'await sleep(2000);'),
    },
  ],
  'ui-accessibility': [
    {
      id: 'ui-contrast-aa',
      title: 'Text contrast meets WCAG AA',
      level: 'must',
      from: 'rules',
      rationale: 'Low-contrast text is unreadable for many users and in bright light.',
      scope: { paths: ['src/ui/**', 'src/components/**', '**/*.css'], languages: ['css', 'typescript'] },
      check: { kind: 'test', command: 'npm run test:a11y' },
      body: 'Text has a contrast ratio of at least 4.5:1 (3:1 for large text).',
    },
    {
      id: 'ui-icon-labels',
      title: 'Meaningful icons have an accessible label',
      level: 'must',
      from: 'rules',
      rationale: 'Screen readers announce unlabeled icon buttons as "button".',
      scope: { paths: ['src/**/*.tsx'] },
      check: { kind: 'lint', command: 'npm run lint -- --rule jsx-a11y/control-has-associated-label', ruleId: 'jsx-a11y/control-has-associated-label' },
      body: doDont('Label icon-only controls.', 'tsx', '<ActionIcon aria-label="Copy reference"><IconAt /></ActionIcon>', '<ActionIcon><IconAt /></ActionIcon>'),
    },
    {
      id: 'ui-reduced-motion',
      title: 'Motion respects prefers-reduced-motion',
      level: 'should',
      from: 'rules',
      rationale: 'Animations can trigger vestibular disorders.',
      scope: { languages: ['css'] },
      body: doDont('Disable non-essential motion when asked.', 'css', '@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }', '.panel { transition: transform 400ms; }'),
    },
    {
      id: 'ui-screen-reader-pass',
      title: 'One flow checked with a screen reader',
      level: 'may',
      from: 'checklist',
      rationale: 'Automated checks miss reading order and announcements.',
      check: { kind: 'review', note: 'VoiceOver or NVDA on the main flow.' },
      body: 'Check the main flow of the feature with a screen reader once.',
    },
  ],
};

/** A draft standard (never applies until activated). */
export const DRAFT_STANDARD = {
  id: 'observability',
  title: 'Observability',
  summary: 'Structured logs and trace ids across services (draft; not in force yet).',
  status: 'draft' as const,
  tags: ['platform'],
  owner: 'sofia',
  appliesTo: ['repo:api', 'repo:app'],
  sections: [
    { id: 'overview', title: 'Overview', body: 'Every service emits structured JSON logs with a trace id, so one request can be followed end to end.' },
    {
      id: 'obs-structured-logs',
      title: 'Logs are structured JSON',
      type: 'rule',
      level: 'must' as const,
      rationale: 'Free-text logs cannot be queried or correlated.',
      check: { kind: 'lint' as const, command: 'npm run lint -- --rule structured-logs', ruleId: 'structured-logs' },
      body: doDont('Log objects with a message.', 'ts', "log.info({ invoiceId }, 'invoice paid');", 'console.log("invoice paid " + invoiceId);'),
    },
    {
      id: 'obs-trace-id',
      title: 'Requests carry a trace id',
      type: 'rule',
      level: 'should' as const,
      rationale: 'Without a shared id, cross-service debugging is guesswork.',
      body: 'Propagate the incoming `traceparent` header and include the trace id in every log line.',
    },
  ],
};

const asSection = (r: Rule) => {
  const { from: _f, ...rest } = r;
  return { ...rest, type: 'rule' };
};

/** Apply richer standards; returns the id mapping per standard (old acceptance id -> rule id). */
export async function applyRichStandards(storage: Storage, meta: () => CommitMeta): Promise<Record<string, string[]>> {
  const mapping: Record<string, string[]> = {};
  for (const std of await storage.standards.list()) {
    const rules = RULES[std.id] ?? [];
    const converted = CONVERTED[std.id] ?? {};
    if (!rules.length && !Object.keys(converted).length) continue;
    if (std.sections.some((s) => s.type === 'rule' && rules.some((r) => r.id === s.id))) continue; // already applied
    const map: string[] = [];
    let sections: StoredStandard['sections'] = std.sections.map((s) => {
      const c = converted[s.id];
      if ((s.type !== 'acceptance' && s.type !== 'rule') || !c) return s;
      map.push(`${s.id} -> ${s.id} (${s.type === 'acceptance' ? 'acceptance -> rule, ' : ''}same id: verification records stay valid)`);
      // `method` is kept: the criterion's content (title, body, method) is unchanged, so passes and waiver pins stay valid.
      return { ...s, type: 'rule', ...c } as never;
    });
    // Converted acceptance sections that do not exist yet (seed order) are added as rules.
    for (const [id, c] of Object.entries(converted)) if (!sections.some((s) => s.id === id)) map.push(`${id}: missing, skipped`), void c;
    const fresh = rules.filter((r) => !sections.some((s) => s.id === r.id));
    sections = [...sections, ...(fresh.map(asSection) as never[])];
    // Prose sections now point at their rules (following "rules" brings those rules; links keep working).
    const byFrom = (from: string) => [...fresh.filter((r) => r.from === from).map((r) => r.id), ...(from === 'checklist' ? Object.keys(converted).filter((id) => sections.some((s) => s.id === id)) : [])];
    sections = sections.map((s) => {
      const ids = byFrom(s.id).filter((id) => !s.verifiedBy.includes(id));
      if (!ids.length || (s.id !== 'rules' && s.id !== 'checklist' && s.id !== 'pagination')) return s;
      // Bodies stay unchanged (a changed body would make passes recorded against these sections stale).
      return { ...s, verifiedBy: [...s.verifiedBy, ...ids] };
    });
    const lifecycle =
      std.id === 'rate-limit-headers' ? { status: 'deprecated', supersededBy: 'api-conventions' } : std.id === 'security-baseline' ? { effectiveFrom: '2026-10-01' } : {};
    map.push(...fresh.map((r) => `+ ${r.id} (${r.level}${r.from ? `, from ${r.from}` : ''})`));
    await storage.standards.update(std.id, { sections, ...lifecycle } as never, {
      ...meta(),
      message: `standard(${std.id}): rules as rule sections${'status' in lifecycle ? `; deprecated, superseded by ${lifecycle.supersededBy}` : ''}\n\nId mapping (old -> new):\n${map.map((x) => `- ${x}`).join('\n')}`,
    });
    mapping[std.id] = map;
  }
  if (!(await storage.standards.list()).some((s) => s.id === DRAFT_STANDARD.id)) {
    await storage.standards.create(DRAFT_STANDARD as never, { ...meta(), message: `standard(${DRAFT_STANDARD.id}): draft` });
  }
  return mapping;
}
