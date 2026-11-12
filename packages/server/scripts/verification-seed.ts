/**
 * Acceptance criteria + verification results (shared by `npm run seed` and the in-place
 * migration). Converts markdown "Acceptance criteria" into one `acceptance` section per
 * criterion, adds criteria to specs and two standards, and records results that cover every
 * state: verified, failing, stale (criterion edited after its pass), unverified and inherited.
 * Done specs end up fully verified, consistent with the done gate.
 */
import type { SectionInput } from '@mandate/shared';
import { sectionSchema } from '@mandate/doc';
import type { Storage } from '../src/storage/index.js';

type Crit = { id: string; title: string; body: string; method: 'test' | 'manual' | 'review' | 'metric'; threshold?: { metric: string; max?: number; min?: number } };

const LOGIN_CRITERIA: Crit[] = [
  { id: 'ac-google-signin', title: 'Google sign-in works end to end', method: 'test', body: 'A new and an existing user can sign in with Google on staging and land on the home page.' },
  { id: 'ac-microsoft-signin', title: 'Microsoft sign-in works for personal and work accounts', method: 'test', body: 'Both account types complete the OIDC flow; work accounts map to their tenant.' },
  { id: 'ac-unverified-rejected', title: 'Unverified emails are rejected', method: 'test', body: 'An `id_token` with `email_verified: false` is rejected with a clear message and no session is created.' },
  { id: 'ac-callback-logging', title: 'Callback errors are logged without tokens', method: 'review', body: 'Error logs from the callback contain the provider and error code, never tokens or codes.' },
  { id: 'ac-fake-idp-e2e', title: 'E2E test with a fake IdP', method: 'test', body: 'CI runs the full flow against a fake OIDC provider.' },
];

/** Criteria appended to specs (by spec id). */
const SPEC_CRITERIA: Record<string, Crit[]> = {
  'user-sessions': [
    { id: 'ac-refresh-rotates', title: 'Refresh tokens rotate on every use', method: 'test', body: 'Each refresh returns a new refresh token and invalidates the old one.' },
    { id: 'ac-reuse-revokes', title: 'Refresh token reuse revokes the session family', method: 'test', body: 'Presenting a used refresh token revokes every token of that session.' },
  ],
  'audit-log': [
    { id: 'ac-events-recorded', title: 'Security events are recorded', method: 'test', body: 'Invites, role changes, API keys and SSO changes each produce one audit event.' },
    { id: 'ac-api-paginates', title: 'Audit API paginates newest first', method: 'test', body: '`GET /v1/audit-events` returns 50 events per page with a `next_cursor`.' },
  ],
  'plans-and-pricing': [
    { id: 'ac-prices-match', title: 'Prices match the pricing page', method: 'review', body: 'Checkout amounts for Team and Business match the published per-seat prices.' },
  ],
  'stripe-checkout': [
    { id: 'ac-webhook-signature', title: 'Webhook signatures are verified', method: 'test', body: 'Events with a missing or wrong `Stripe-Signature` are rejected with 400.' },
    { id: 'ac-redirect-not-trusted', title: 'Redirect never activates a plan', method: 'test', body: 'Only `checkout.session.completed` webhooks change the subscription.' },
  ],
  'usage-metering': [
    { id: 'ac-idempotent-flush', title: 'Flush retries reuse the idempotency key', method: 'test', body: 'Retrying an hourly flush sends the same idempotency key to Stripe.' },
    {
      id: 'ac-flush-latency',
      title: 'Hourly flush finishes quickly',
      method: 'metric',
      threshold: { metric: 'flush_p95_seconds', max: 60 },
      body: 'The hourly flush job completes within a minute at p95.',
    },
  ],
  'rate-limiting': [
    { id: 'ac-429-retry-after', title: '429 responses include Retry-After', method: 'test', body: 'Throttled requests get `429` with a `Retry-After` header in seconds.' },
  ],
  'mfa-totp': [
    { id: 'ac-admin-enrolment', title: 'Admins must enrol before their next login', method: 'manual', body: 'An admin without MFA is sent to enrolment after a successful password or SSO login.' },
  ],
  'command-palette': [
    { id: 'ac-keyboard-only', title: 'Usable with the keyboard only', method: 'manual', body: 'Open, navigate, run and close the palette without a mouse.' },
  ],
  'spec-claims': [
    { id: 'ac-stale-takeover', title: 'Stale claims can be taken over', method: 'test', body: 'A claim with a heartbeat older than 30 minutes can be claimed by another agent.' },
  ],
};

/** Checklists added to standards (inherited by specs using them). */
const STANDARD_CRITERIA: Record<string, Crit[]> = {
  'security-baseline': [
    { id: 'ac-no-secrets-in-logs', title: 'No secrets or tokens in logs', method: 'review', body: 'Logs, error messages and traces never contain tokens, passwords or card numbers.' },
    { id: 'ac-inputs-validated', title: 'Inputs validated at the edge', method: 'review', body: 'Every new request body is validated with a schema before reaching handlers.' },
  ],
  'ui-accessibility': [
    { id: 'ac-focus-visible', title: 'Visible focus on every control', method: 'manual', body: 'Tabbing through the feature shows a visible focus ring on each interactive element.' },
  ],
};

const asSection = (c: Crit): SectionInput => sectionSchema.parse({ id: c.id, title: c.title, type: 'acceptance', method: c.method, ...(c.threshold ? { threshold: c.threshold } : {}), body: c.body });
/** Standards hold rules: the same criterion as a `must` rule (the rationale is filled in by rules-seed). */
const asRule = (c: Crit): SectionInput =>
  sectionSchema.parse({ id: c.id, title: c.title, type: 'rule', level: 'must', rationale: 'Part of the baseline every user of this standard must meet.', method: c.method, body: c.body });

/**
 * The ready gate: a spec's acceptance criteria are written before it becomes ready (login-sso: its markdown checklist
 * split into acceptance sections). Sections still without a criterion (no acceptance in verifiedBy)
 * are verified by the spec's criteria.
 */
export function withCriteria(specId: string, sections: SectionInput[]): SectionInput[] {
  let out = sections;
  if (specId === 'login-sso' && out.some((s) => s.id === 'acceptance' && (s.type ?? 'markdown') === 'markdown')) {
    out = out.flatMap((s) => (s.id === 'acceptance' ? LOGIN_CRITERIA.map(asSection) : [{ ...s, ...(s.id === 'callback' ? { verifiedBy: ['ac-unverified-rejected', 'ac-callback-logging'] } : {}) }]));
  } else if (!out.some((s) => s.type === 'acceptance') && SPEC_CRITERIA[specId]) out = [...out, ...SPEC_CRITERIA[specId]!.map(asSection)];
  const crits = out.filter((s) => s.type === 'acceptance' && !s.archived).map((s) => s.id);
  if (!crits.length) return out;
  return out.map((s) => {
    if (s.type === 'acceptance' || s.archived) return s;
    const covered = (s.verifiedBy ?? []).some((v) => crits.includes(v));
    return covered ? s : { ...s, verifiedBy: [...(s.verifiedBy ?? []), crits[0]!] };
  });
}

/** Before a spec is marked done, the implementing agent verifies every criterion the done gate requires (pass). */
export async function verifyForDone(storage: Storage, specId: string, meta: { date?: Date; agent?: string; branch?: string }): Promise<void> {
  const spec = await storage.specs.get(specId);
  const v = await storage.verificationService.forSpec(spec);
  const open = [...v.own, ...v.inherited.flatMap((g) => g.criteria)].filter((c) => c.state !== 'verified' && (c.level ?? 'must') === 'must' && !c.upcoming);
  let i = 0;
  for (const c of open) {
    const at = new Date((meta.date ?? new Date()).getTime() + i++ * 1000);
    await storage.verificationService.record(
      { criterion: c.uri, appliedTo: `mandate://specs/${specId}`, result: 'pass', method: 'test', code: { repo: spec.repo ?? 'app', commit: Math.floor(at.getTime() / 1000).toString(16).slice(-7), branch: meta.branch ?? 'main' }, by: meta.agent ?? 'claude-code@matteo-mbp' },
      { date: at, author: { name: 'Mandate', email: 'mandate@localhost' }, agent: meta.agent ?? 'claude-code@matteo-mbp' },
    );
  }
}

export async function seedVerification(storage: Storage, at: (minutesFromStart: number) => Date): Promise<void> {
  let t = 0;
  const next = () => at((t += 3));
  const author = { name: 'Matteo', email: 'matteo@example.com' };

  // 1. login-sso: markdown "Acceptance criteria" -> one acceptance section per criterion.
  const login = await storage.specs.get('login-sso');
  if (login.sections.some((s) => s.id === 'acceptance' && s.type === 'markdown')) {
    const sections = login.sections.flatMap((s) =>
      s.id === 'acceptance' ? LOGIN_CRITERIA.map(asSection) : [{ ...s, ...(s.id === 'callback' ? { verifiedBy: ['ac-unverified-rejected', 'ac-callback-logging'] } : {}) }],
    );
    await storage.specs.update('login-sso', { sections } as never, { date: next(), author, message: 'spec(login-sso): split acceptance criteria into acceptance sections' });
  }

  // 2. Criteria for other specs and checklists for two standards.
  for (const [id, crits] of Object.entries(SPEC_CRITERIA)) {
    const spec = await storage.specs.get(id).catch(() => null);
    if (!spec || spec.sections.some((s) => s.type === 'acceptance')) continue;
    await storage.specs.update(id, { sections: [...spec.sections, ...crits.map(asSection)] } as never, {
      date: next(),
      author,
      message: `spec(${id}): add acceptance criteria`,
    });
  }
  for (const [id, crits] of Object.entries(STANDARD_CRITERIA)) {
    const std = await storage.standards.get(id).catch(() => null);
    if (!std || std.sections.some((s) => s.type === 'acceptance' || s.type === 'rule')) continue;
    await storage.standards.update(id, { sections: [...std.sections, ...crits.map(asRule)] } as never, {
      date: next(),
      author,
      message: `standard(${id}): add acceptance checklist`,
    });
  }

  // 3. Results.
  // (Passes recorded before done by verifyForDone do not count: the demo results are recorded once.)
  if ((await storage.verificationService.list()).some((r) => r.criterion.endsWith('/ac-google-signin'))) return;
  const v = storage.verificationService;
  const own = (spec: string, sid: string) => `mandate://specs/${spec}/sections/${sid}`;
  const std = (id: string, sid: string) => `mandate://standards/${id}/sections/${sid}`;
  // The verified code lives in the spec's repository (verification_record checks it).
  const repoOf = async (uri: string) => {
    const m = /^mandate:\/\/specs\/([a-z0-9-]+)/.exec(uri);
    return (m ? (await storage.specs.get(m[1]!).catch(() => null))?.repo : undefined) ?? 'app';
  };
  const rec = async (
    criterion: string,
    result: 'pass' | 'fail',
    o: { appliedTo?: string; agent?: string; repo?: string; test?: string; note?: string; method?: 'test' | 'manual' | 'review' | 'metric' } = {},
  ) => {
    const when = next();
    await v.record(
      {
        criterion,
        appliedTo: o.appliedTo,
        result,
        method: o.method ?? 'test',
        code: { repo: o.repo ?? (await repoOf(o.appliedTo ?? criterion)), commit: Math.floor(when.getTime() / 1000).toString(16).slice(-7), branch: 'main' },
        evidence: { ...(o.test ? { test: o.test } : {}), ci: `https://ci.example.com/runs/${Math.floor(when.getTime() / 60000) % 100000}`, ...(o.note ? { note: o.note } : {}) },
        by: o.agent ?? 'claude-code@matteo-mbp',
      },
      { date: when, author: { name: 'Mandate', email: 'mandate@localhost' }, agent: o.agent ?? 'claude-code@matteo-mbp' },
    );
  };
  const spec = (id: string) => ({ appliedTo: `mandate://specs/${id}` });

  // Done specs: everything verified (own + inherited security baseline).
  for (const id of ['user-sessions', 'audit-log']) {
    for (const c of SPEC_CRITERIA[id]!) await rec(own(id, c.id), 'pass', { test: `tests/${id}/${c.id}.spec.ts`, repo: id === 'audit-log' ? 'api' : 'app' });
    for (const c of STANDARD_CRITERIA['security-baseline']!) await rec(std('security-baseline', c.id), 'pass', { ...spec(id), repo: id === 'audit-log' ? 'api' : 'app', method: 'review', note: 'Checked in code review.' });
  }
  await rec(own('plans-and-pricing', 'ac-prices-match'), 'pass', { method: 'review', note: 'Compared checkout amounts with the pricing page.' });

  // login-sso: two passing, one failing, the rest unverified; inherited baseline partly verified.
  await rec(own('login-sso', 'ac-google-signin'), 'pass', { test: 'e2e/sso-google.spec.ts' });
  await rec(own('login-sso', 'ac-microsoft-signin'), 'pass', { test: 'e2e/sso-microsoft.spec.ts' });
  await rec(own('login-sso', 'ac-unverified-rejected'), 'fail', { test: 'auth/callback.spec.ts', note: 'Work accounts without email_verified still get a session.' });
  await rec(std('security-baseline', 'ac-no-secrets-in-logs'), 'pass', { ...spec('login-sso'), method: 'review' });

  // stripe-checkout: failing webhook verification.
  await rec(own('stripe-checkout', 'ac-webhook-signature'), 'fail', { test: 'billing/webhooks.spec.ts', note: 'STRIPE_WEBHOOK_SECRET missing in CI.' });
  await rec(own('stripe-checkout', 'ac-redirect-not-trusted'), 'pass', { test: 'billing/checkout.spec.ts' });

  // usage-metering: pass, then the criterion is tightened -> stale.
  await rec(own('usage-metering', 'ac-idempotent-flush'), 'pass', { repo: 'api', test: 'metering/flush.spec.ts' });
  await rec(own('usage-metering', 'ac-flush-latency'), 'pass', { repo: 'api', method: 'metric', note: 'p95 41 s over the last 7 days.' });
  const um = await storage.specs.get('usage-metering');
  await storage.specs.update(
    'usage-metering',
    {
      sections: um.sections.map((s) =>
        s.id === 'ac-idempotent-flush' ? { ...s, body: 'Retrying an hourly flush sends the same idempotency key to Stripe, including after a worker restart.' } : s,
      ),
    } as never,
    { date: next(), author, message: 'spec(usage-metering): idempotency must survive worker restarts' },
  );

  // mfa-totp: inherited UI checklist verified, own criterion unverified.
  await rec(std('ui-accessibility', 'ac-focus-visible'), 'pass', { ...spec('mfa-totp'), method: 'manual', agent: 'giulia' });
}
