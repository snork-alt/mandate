import type { SectionInput, SpecStatus, Priority } from '@mandate/shared';

/** A section; `draftBody` / `draftTitle` give a first version that a later "refine" commit replaces. */
export type SeedSection = SectionInput & {
  draftBody?: string;
  draftTitle?: string;
  /** Standards this section follows (seeded as `follows` links to the whole standard). */
  standards?: string[];
};

/** Final state of a sample spec; the seed script derives a plausible commit history from it. */
export interface SeedSpec {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority?: Priority;
  /** `reopened` = was done, then moved back to ready (keeps implementedCommit). */
  final: SpecStatus | 'reopened' | 'in_progress_stale';
  tags: string[];
  owner: string;
  repo: string;
  /** Standards the spec follows; seeded as `follows` links on its first section (spec-level standards are derived). */
  standards?: string[];
  /** Who implements it (claim / done commits). */
  agent?: string;
  /** Days before now when the spec was first drafted. */
  startDaysAgo: number;
  sections: SeedSection[];
}

export interface SeedStandard {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  owner: string;
  appliesTo: string[];
  startDaysAgo: number;
  sections: SeedSection[];
}

export const STANDARDS: SeedStandard[] = [
  {
    id: 'security-baseline',
    title: 'Security baseline',
    summary: 'Rules every feature touching authentication, sessions or user data must follow.',
    tags: ['security'],
    owner: 'giulia',
    appliesTo: ['tag:security', 'category:auth'],
    startDaysAgo: 22,
    sections: [
      {
        id: 'rules',
        title: 'Rules',
        draftBody: `- Never log tokens or passwords.
- Secrets come from the environment, never from the repo.
- Session cookies are \`HttpOnly\` and \`Secure\`.`,
        body: `- Never log tokens, passwords or full card numbers. Redact with \`redact()\` from \`@app/log\`.
- Secrets come from the environment or the vault, never from the repo.
- Session cookies are \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\`.
- Access tokens live at most 15 minutes; refresh tokens rotate on every use.
- Validate every request body with a zod schema at the edge; use parameterized queries only.`,
      },
      {
        id: 'request-pipeline',
        title: 'Request pipeline',
        type: 'mermaid',
        body: `flowchart LR
  A[Request] --> B[TLS + HSTS]
  B --> C[Rate limit]
  C --> D[Authenticate]
  D --> E[Validate body]
  E --> F[Handler]
  F --> G[Audit log]
  D -->|invalid| X[401]
  E -->|invalid| Y[400]`,
      },
      {
        id: 'example',
        title: 'Example',
        refs: [{ repo: 'app', path: 'src/http/middleware/validate.ts', lines: '1-42' }],
        symbols: ['validateBody', 'redact'],
        body: `\`\`\`ts
app.post('/v1/sessions', validateBody(loginSchema), async (req) => {
  log.info('login', redact({ email: req.body.email }));
  return sessions.create(await users.verify(req.body));
});
\`\`\``,
      },
      {
        id: 'checklist',
        title: 'Review checklist',
        body: `- [ ] No secrets or tokens in logs or error messages
- [ ] Inputs validated at the edge
- [ ] New endpoints covered by authz tests
- [ ] Dependencies free of critical advisories`,
      },
    ],
  },
  {
    id: 'api-conventions',
    title: 'API conventions',
    summary: 'How HTTP APIs look across services: naming, errors, pagination, idempotency.',
    tags: ['api'],
    owner: 'matteo',
    appliesTo: ['tag:api', 'repo:api'],
    startDaysAgo: 21,
    sections: [
      {
        id: 'rules',
        title: 'Rules',
        body: `- Resources are plural nouns: \`/v1/invoices/:id\`.
- Errors use \`{ "error": { "code": "snake_case", "message": "…" } }\` with a matching HTTP status.
- Every mutating endpoint accepts an \`Idempotency-Key\` header.
- Timestamps are RFC 3339 in UTC.`,
      },
      {
        id: 'pagination',
        title: 'Pagination',
        draftBody: 'List endpoints paginate with `?page=` and `?per_page=`.',
        body: `List endpoints paginate with an opaque \`?cursor=\` and return \`next_cursor\` (null on the last page). Offsets are not allowed: they skip or repeat items when data changes.`,
      },
      {
        id: 'example',
        title: 'Example',
        refs: [{ repo: 'api', path: 'src/http/errors.ts', lines: '8-30', commit: 'e19b2c4' }],
        symbols: ['ApiError', 'paginate'],
        body: `\`\`\`http
GET /v1/invoices?cursor=eyJpZCI6NDJ9 HTTP/1.1

HTTP/1.1 200 OK
{ "data": [ … ], "next_cursor": "eyJpZCI6OTJ9" }
\`\`\``,
      },
    ],
  },
  {
    id: 'testing-policy',
    title: 'Testing policy',
    summary: 'What to test, at which level, and how to keep the suite fast and trustworthy.',
    tags: ['quality'],
    owner: 'sofia',
    appliesTo: ['repo:app', 'repo:api'],
    startDaysAgo: 20,
    sections: [
      {
        id: 'rules',
        title: 'Rules',
        body: `- New behaviour ships with tests at the lowest level that can catch the bug.
- External services (Stripe, OIDC providers) are faked at the HTTP boundary, never mocked in-process.
- Critical paths (auth, billing) need end-to-end tests.`,
      },
      {
        id: 'steps',
        title: 'Steps for a new feature',
        body: `1. Write the failing test that describes the behaviour.
2. Implement until it passes.
3. Add one end-to-end test if the feature crosses a service boundary.
4. Run the suite twice; flaky tests are fixed or deleted the same day.`,
      },
      {
        id: 'checklist',
        title: 'Checklist',
        body: `- [ ] Unit or integration test for each new branch of logic
- [ ] No retries or sleeps added to make tests pass
- [ ] Fakes, not mocks, for HTTP dependencies`,
      },
    ],
  },
  {
    id: 'ui-accessibility',
    title: 'UI accessibility',
    summary: 'Keyboard, contrast and motion rules for every screen.',
    tags: ['ui'],
    owner: 'giulia',
    appliesTo: ['tag:ui', 'category:ui'],
    startDaysAgo: 19,
    sections: [
      {
        id: 'rules',
        title: 'Rules',
        body: `- All interactive elements are reachable by keyboard and have a visible focus ring.
- Colour contrast meets WCAG AA (4.5:1 for text).
- Icons that convey meaning have an accessible label.
- Motion respects \`prefers-reduced-motion\`.`,
      },
      {
        id: 'focus-ring',
        title: 'Focus ring example',
        type: 'html',
        refs: [{ repo: 'app', path: 'src/ui/theme/focus.css' }],
        body: `<div style="display:flex;gap:12px;align-items:center">
  <button style="padding:8px 14px;border-radius:6px;border:1px solid #d0d0d6;background:#fff">Default</button>
  <button style="padding:8px 14px;border-radius:6px;border:1px solid #8f6fd2;background:#fff;outline:2px solid #b39ae3;outline-offset:2px">Focused</button>
</div>`,
      },
      {
        id: 'checklist',
        title: 'Checklist',
        body: `- [ ] Tab order follows the visual order
- [ ] Every icon-only button has \`aria-label\`
- [ ] Checked with a screen reader on one flow`,
      },
    ],
  },
];

export const SPECS: SeedSpec[] = [
  /* ------------------------------------------------------------------ auth */
  {
    id: 'login-sso',
    title: 'Login with SSO',
    summary: 'Users can sign in with Google or Microsoft via OIDC.',
    category: 'auth',
    priority: 'p1',
    final: 'in_progress',
    tags: ['security', 'api'],
    owner: 'matteo',
    repo: 'app',
    standards: ['security-baseline'],
    agent: 'claude-code@matteo-mbp',
    startDaysAgo: 9,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        draftBody: `Add Google login to the login page. Accounts are matched by email.`,
        body: `Add "Sign in with Google" and "Sign in with Microsoft" to the login page. Accounts are matched by verified email; unknown emails get a new account in the default workspace.

Out of scope: SAML, SCIM provisioning, account linking UI.`,
      },
      {
        id: 'auth-flow',
        title: 'Authentication flow',
        type: 'mermaid',
        standards: ['security-baseline'],
        refs: [{ repo: 'app', path: 'src/auth/oidc.ts', lines: '10-64', commit: '3f2a9c1' }],
        symbols: ['OidcClient', 'AuthService.login'],
        draftBody: `sequenceDiagram
  actor User
  participant App
  participant IdP as Identity provider
  User->>App: Click "Sign in with Google"
  App->>IdP: Redirect /authorize
  IdP->>App: Redirect /callback?code
  App->>IdP: POST /token (code)
  IdP-->>App: id_token
  App-->>User: Set session cookie`,
        body: `sequenceDiagram
  autonumber
  actor User
  participant App
  participant IdP as Identity provider
  User->>App: Click "Sign in with Google"
  App->>App: Create state + PKCE verifier
  App->>IdP: Redirect /authorize
  IdP-->>User: Consent screen
  User->>IdP: Approve
  IdP->>App: Redirect /callback?code&state
  App->>IdP: POST /token (code, verifier)
  IdP-->>App: id_token, access_token
  App->>App: Verify id_token, upsert user
  App-->>User: Set session cookie, redirect home`,
      },
      {
        id: 'callback',
        title: 'Callback handling',
        refs: [
          { repo: 'app', path: 'src/auth/callback.ts', lines: '1-80' },
          { repo: 'app', path: 'src/auth/session.ts', lines: '22-41', commit: '9b81d0e' },
        ],
        symbols: ['handleOidcCallback', 'SessionStore.create'],
        body: `1. Reject the request unless \`state\` matches the value stored in the short-lived \`oidc_state\` cookie.
2. Exchange the code with the PKCE verifier; never send a client secret from the browser.
3. Verify the \`id_token\` signature against the provider's JWKS (cache for 1 h) and check \`iss\`, \`aud\`, \`exp\` and \`nonce\`.
4. Require \`email_verified: true\`.
5. Create the session through \`SessionStore.create\` so refresh-token rotation from **user-sessions** applies.

\`\`\`ts
export async function handleOidcCallback(req: Request): Promise<Response> {
  const { code, state } = parseCallback(req.url);
  assertState(req, state);
  const tokens = await oidc.exchange(code, readVerifier(req));
  const claims = await oidc.verify(tokens.id_token);
  const user = await users.upsertByEmail(claims.email);
  return sessions.create(user, { provider: claims.iss });
}
\`\`\``,
      },
      {
        id: 'acceptance',
        title: 'Acceptance criteria',
        draftBody: `- [ ] Google sign-in works end to end on staging
- [ ] Microsoft sign-in works for personal and work accounts
- [ ] Unverified emails are rejected`,
        body: `- [x] Google sign-in works end to end on staging
- [x] Microsoft sign-in works for personal and work accounts
- [ ] Unverified emails are rejected with a clear message
- [ ] Callback errors are logged without tokens (see security baseline)
- [ ] E2E test with a fake IdP`,
      },
    ],
  },
  {
    id: 'user-sessions',
    title: 'User sessions and refresh tokens',
    summary: 'Short-lived access tokens with rotating refresh tokens stored server-side.',
    category: 'auth',
    priority: 'p1',
    final: 'done',
    tags: ['security'],
    owner: 'matteo',
    repo: 'app',
    standards: ['security-baseline', 'testing-policy'],
    agent: 'codex@build-02',
    startDaysAgo: 20,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Replace the 30-day JWT with a 15-minute access token plus a refresh token that rotates on every use. Reuse of an old refresh token revokes the whole session family.`,
      },
      {
        id: 'lifecycle',
        title: 'Token lifecycle',
        type: 'mermaid',
        body: `stateDiagram-v2
  [*] --> Active: login
  Active --> Active: refresh (rotate)
  Active --> Expired: 30 days idle
  Active --> Revoked: logout
  Active --> Revoked: refresh token reuse
  Expired --> [*]
  Revoked --> [*]`,
      },
      {
        id: 'storage',
        title: 'Storage',
        refs: [{ repo: 'app', path: 'db/migrations/0042_sessions.sql' }],
        symbols: ['sessions', 'session_tokens'],
        body: `| Table | Column | Notes |
|---|---|---|
| \`sessions\` | \`id\`, \`user_id\`, \`created_at\`, \`revoked_at\` | one row per login |
| \`session_tokens\` | \`hash\`, \`session_id\`, \`used_at\` | SHA-256 of the refresh token |

Only hashes are stored. A token whose \`used_at\` is set and is presented again triggers revocation.`,
      },
    ],
  },
  {
    id: 'mfa-totp',
    title: 'TOTP multi-factor authentication',
    summary: 'Optional authenticator-app codes as a second factor, required for admins.',
    category: 'auth',
    priority: 'p2',
    final: 'active',
    tags: ['security', 'ui'],
    owner: 'giulia',
    repo: 'app',
    standards: ['security-baseline', 'ui-accessibility'],
    startDaysAgo: 6,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Users can enrol an authenticator app (RFC 6238, 30 s period, 6 digits). Admins must enrol before their next login. Ten single-use recovery codes are shown once at enrolment.`,
      },
      {
        id: 'enrolment-ui',
        title: 'Enrolment screen',
        type: 'html',
        standards: ['ui-accessibility'],
        body: `<div style="max-width:420px;border:1px solid #e5e5ea;border-radius:12px;padding:20px">
  <h3 style="margin:0 0 4px;font-size:16px">Set up two-factor authentication</h3>
  <p style="margin:0 0 16px;color:#6b6f76;font-size:13px">Scan the code with your authenticator app, then enter the 6-digit code.</p>
  <div style="display:flex;gap:16px;align-items:center">
    <div style="width:96px;height:96px;border-radius:8px;background:repeating-linear-gradient(45deg,#222 0 6px,#fff 6px 12px)"></div>
    <div style="flex:1">
      <label style="font-size:12px;color:#6b6f76">Verification code</label>
      <input value="482 913" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid #d0d0d6;border-radius:6px;font-size:15px;letter-spacing:2px"/>
    </div>
  </div>
  <button style="margin-top:16px;width:100%;padding:9px;border:0;border-radius:6px;background:#8f6fd2;color:#fff;font-weight:600">Verify and enable</button>
</div>`,
      },
      {
        id: 'login-flow',
        title: 'Login flow',
        type: 'mermaid',
        body: `flowchart LR
  A[Password or SSO ok] --> B{MFA enrolled?}
  B -- no --> C{Admin?}
  C -- yes --> D[Force enrolment]
  C -- no --> E[Signed in]
  B -- yes --> F[Ask for TOTP code]
  F -->|valid| E
  F -->|recovery code| E
  F -->|5 failures| G[Lock for 15 min]`,
      },
    ],
  },
  /* ------------------------------------------------------------------ billing */
  {
    id: 'stripe-checkout',
    title: 'Stripe checkout for subscriptions',
    summary: 'Upgrade from the pricing page through Stripe Checkout and keep plans in sync via webhooks.',
    category: 'billing',
    priority: 'p0',
    final: 'in_progress_stale',
    tags: ['payments', 'api'],
    owner: 'matteo',
    repo: 'app',
    standards: ['api-conventions', 'security-baseline'],
    agent: 'claude-code@ci-runner-3',
    startDaysAgo: 8,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `The "Upgrade" button creates a Checkout Session for the selected plan and redirects. The subscription state in our database is only ever changed by webhooks, never by the redirect.`,
      },
      {
        id: 'checkout-flow',
        title: 'Checkout flow',
        type: 'mermaid',
        refs: [{ repo: 'app', path: 'src/billing/checkout.ts', lines: '12-58' }],
        symbols: ['createCheckoutSession'],
        body: `sequenceDiagram
  participant U as User
  participant A as App
  participant S as Stripe
  U->>A: POST /v1/billing/checkout {plan}
  A->>S: checkout.sessions.create
  S-->>A: session.url
  A-->>U: 303 redirect
  U->>S: Pay
  S->>A: webhook checkout.session.completed
  A->>A: activate subscription`,
      },
      {
        id: 'webhooks',
        title: 'Webhooks',
        draftTitle: 'Webhook handling',
        standards: ['api-conventions'],
        refs: [
          { repo: 'app', path: 'src/billing/webhooks.ts', lines: '1-120', commit: 'a41c7f2' },
        ],
        symbols: ['handleStripeEvent', 'SubscriptionService.sync'],
        body: `Handle and acknowledge within 2 s; do the work in a job.

| Event | Action |
|---|---|
| \`checkout.session.completed\` | create subscription, set plan |
| \`customer.subscription.updated\` | sync plan, seats, period end |
| \`customer.subscription.deleted\` | downgrade to free at period end |
| \`invoice.payment_failed\` | mark past due, email owner |

Verify the signature with \`STRIPE_WEBHOOK_SECRET\` and store processed event ids to make handling idempotent.`,
      },
    ],
  },
  {
    id: 'plans-and-pricing',
    title: 'Plans and pricing model',
    summary: 'Free, Team and Business tiers with per-seat pricing and annual discount.',
    category: 'billing',
    priority: 'p1',
    final: 'done',
    tags: ['payments'],
    owner: 'sofia',
    repo: 'app',
    agent: 'claude-code@matteo-mbp',
    startDaysAgo: 19,
    sections: [
      {
        id: 'tiers',
        title: 'Tiers',
        body: `| Plan | Price / seat / month | Limits |
|---|---|---|
| Free | €0 | 3 seats, 1 project |
| Team | €12 | unlimited projects, SSO |
| Business | €24 | audit log, SAML, priority support |

Annual billing gets two months free.`,
      },
      {
        id: 'pricing-card',
        title: 'Pricing card',
        type: 'html',
        body: `<div style="display:flex;gap:12px">
  <div style="flex:1;border:1px solid #e5e5ea;border-radius:12px;padding:16px">
    <div style="font-size:13px;color:#6b6f76">Free</div>
    <div style="font-size:24px;font-weight:700;margin:6px 0">€0</div>
    <div style="font-size:12px;color:#6b6f76">Up to 3 seats</div>
  </div>
  <div style="flex:1;border:2px solid #8f6fd2;border-radius:12px;padding:16px">
    <div style="font-size:13px;color:#7a59bf;font-weight:600">Team · Popular</div>
    <div style="font-size:24px;font-weight:700;margin:6px 0">€12<span style="font-size:12px;font-weight:400;color:#6b6f76"> /seat/mo</span></div>
    <div style="font-size:12px;color:#6b6f76">Unlimited projects, SSO</div>
  </div>
  <div style="flex:1;border:1px solid #e5e5ea;border-radius:12px;padding:16px">
    <div style="font-size:13px;color:#6b6f76">Business</div>
    <div style="font-size:24px;font-weight:700;margin:6px 0">€24</div>
    <div style="font-size:12px;color:#6b6f76">Audit log, SAML</div>
  </div>
</div>`,
      },
    ],
  },
  {
    id: 'invoice-emails',
    title: 'Invoice and receipt emails',
    summary: 'Branded receipts after each successful payment, with a PDF invoice attached.',
    category: 'billing',
    priority: 'p3',
    final: 'active',
    tags: ['email'],
    owner: 'sofia',
    repo: 'app',
    startDaysAgo: 3,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Open questions:

- Do we send our own receipts or turn on Stripe's?
- Which address gets them when the workspace has several admins?`,
      },
      {
        id: 'template',
        title: 'Email template',
        type: 'html',
        body: `<div style="max-width:480px;margin:auto;border:1px solid #e5e5ea;border-radius:12px;overflow:hidden">
  <div style="background:#8f6fd2;color:#fff;padding:16px 20px;font-weight:600">Receipt from Acme</div>
  <div style="padding:20px;font-size:14px">
    <p style="margin-top:0">Thanks for your payment.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr><td style="padding:6px 0;color:#6b6f76">Team plan · 5 seats</td><td style="text-align:right">€60.00</td></tr>
      <tr><td style="padding:6px 0;color:#6b6f76">VAT 22%</td><td style="text-align:right">€13.20</td></tr>
      <tr><td style="padding:8px 0;border-top:1px solid #e5e5ea;font-weight:600">Total</td><td style="text-align:right;border-top:1px solid #e5e5ea;font-weight:600">€73.20</td></tr>
    </table>
  </div>
</div>`,
      },
    ],
  },
  {
    id: 'usage-metering',
    title: 'Usage-based metering',
    summary: 'Count API calls per workspace and report them to Stripe as metered usage.',
    category: 'billing',
    priority: 'p2',
    final: 'reopened',
    tags: ['payments', 'data'],
    owner: 'matteo',
    repo: 'api',
    standards: ['api-conventions'],
    agent: 'codex@build-02',
    startDaysAgo: 16,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Each authenticated API request increments a counter for the workspace. Counters are flushed hourly and reported to Stripe as usage records.

> **Reopened:** usage was double-counted when the flush job retried after a timeout. Reporting must be idempotent per (workspace, hour).`,
      },
      {
        id: 'pipeline',
        title: 'Pipeline',
        type: 'mermaid',
        draftBody: `flowchart LR
  R[API request] --> C[(Redis counter)]
  C -->|hourly| F[Flush job]
  F --> S[Stripe usage record]`,
        refs: [{ repo: 'api', path: 'src/metering/flush.ts', lines: '30-95', commit: 'c03e5aa' }],
        symbols: ['MeteringFlushJob', 'UsageCounter.increment'],
        body: `flowchart LR
  R[API request] --> C[(Redis counter<br/>ws:hour)]
  C -->|hourly| F[Flush job]
  F --> D[(usage_records)]
  F -->|idempotency key ws:hour| S[Stripe usage record]`,
      },
      {
        id: 'aggregation',
        title: 'Aggregation rules',
        body: `- Count only 2xx and 4xx responses; 5xx are on us.
- Requests with the \`X-Internal\` header are not counted.
- The idempotency key is \`usage:<workspace>:<yyyy-mm-ddThh>\`.`,
      },
    ],
  },
  /* ------------------------------------------------------------------ platform */
  {
    id: 'spec-claims',
    title: 'Spec claims and heartbeats',
    summary: 'Agents claim a spec before working on it and keep the claim alive with heartbeats.',
    category: 'platform',
    priority: 'p1',
    final: 'active',
    tags: ['agents', 'api'],
    owner: 'matteo',
    repo: 'mandate',
    standards: ['api-conventions'],
    startDaysAgo: 5,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `A claim records which agent works on a spec, on which branch and in which worktree. Only one claim per spec. A claim whose heartbeat is older than 30 minutes is **stale** and may be taken over.`,
      },
      {
        id: 'lifecycle',
        title: 'Claim lifecycle',
        type: 'mermaid',
        body: `stateDiagram-v2
  [*] --> ready
  ready --> in_progress: claim
  in_progress --> in_progress: heartbeat
  in_progress --> ready: release / stale takeover
  in_progress --> done: complete
  done --> ready: reopen`,
      },
      {
        id: 'rules',
        title: 'Rules',
        symbols: ['claimSpec', 'heartbeat', 'releaseClaim'],
        body: `- \`claimSpec\` fails with \`409 already_claimed\` unless the existing claim is stale.
- \`heartbeat\` only updates \`claim.heartbeatAt\`; at most one commit per 5 minutes per spec.
- Completing sets \`status: done\`, stores \`implementedCommit\` and removes the claim.`,
      },
    ],
  },
  {
    id: 'audit-log',
    title: 'Audit log',
    summary: 'Append-only log of security-relevant actions, filterable by actor and resource.',
    category: 'platform',
    priority: 'p2',
    final: 'done',
    tags: ['security', 'data'],
    owner: 'giulia',
    repo: 'api',
    standards: ['security-baseline', 'api-conventions'],
    agent: 'claude-code@matteo-mbp',
    startDaysAgo: 18,
    sections: [
      {
        id: 'events',
        title: 'Events',
        body: `| Event | Payload |
|---|---|
| \`member.invited\` | inviter, email, role |
| \`member.role_changed\` | actor, member, from, to |
| \`api_key.created\` | actor, key prefix |
| \`sso.configured\` | actor, provider |`,
      },
      {
        id: 'api',
        title: 'API',
        standards: ['api-conventions'],
        refs: [{ repo: 'api', path: 'src/audit/routes.ts', lines: '1-48' }],
        symbols: ['AuditLog.append', 'GET /v1/audit-events'],
        body: `\`GET /v1/audit-events?actor=&resource=&cursor=\` returns newest first, 50 per page. Events are retained for 400 days.`,
      },
    ],
  },
  {
    id: 'rate-limiting',
    title: 'API rate limiting',
    summary: 'Token-bucket limits per API key with standard rate-limit headers.',
    category: 'platform',
    priority: 'p2',
    final: 'active',
    tags: ['api'],
    owner: 'giulia',
    repo: 'api',
    standards: ['api-conventions'],
    startDaysAgo: 4,
    sections: [
      {
        id: 'limits',
        title: 'Limits',
        body: `- 100 requests / 10 s per API key (burst 200).
- Responses carry \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`.
- Exceeding returns \`429\` with \`{ "error": { "code": "rate_limited" } }\` and an audit event when a key is throttled for more than a minute.`,
      },
      {
        id: 'algorithm',
        title: 'Algorithm',
        type: 'mermaid',
        symbols: ['TokenBucket.take'],
        body: `flowchart TD
  A[Request] --> B{tokens > 0?}
  B -- yes --> C[take 1 token] --> D[Handle]
  B -- no --> E[429 + Retry-After]
  F[Refill 10 tokens/s] --> B`,
      },
    ],
  },
  {
    id: 'legacy-xml-export',
    title: 'Legacy XML export',
    summary: 'Nightly XML dump for the old reporting tool. Replaced by the CSV export.',
    category: 'platform',
    priority: 'p3',
    final: 'archived',
    tags: ['data'],
    owner: 'sofia',
    repo: 'api',
    startDaysAgo: 21,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Archived: the reporting team moved to the CSV export, so this will not be built.`,
      },
    ],
  },
  /* ------------------------------------------------------------------ ui */
  {
    id: 'command-palette',
    title: 'Command palette',
    summary: 'Cmd+K palette for navigation, search and quick actions across the app.',
    category: 'ui',
    priority: 'p2',
    final: 'active',
    tags: ['ui', 'productivity'],
    owner: 'matteo',
    repo: 'app',
    standards: ['ui-accessibility'],
    startDaysAgo: 7,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Opens with **Cmd+K** / **Ctrl+K** from anywhere. Results are grouped: Navigation, Projects, Actions. Recent items show first when the query is empty.`,
      },
      {
        id: 'mock',
        title: 'Mock',
        type: 'html',
        standards: ['ui-accessibility'],
        body: `<div style="max-width:520px;margin:auto;border:1px solid #e5e5ea;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.12);overflow:hidden">
  <div style="padding:12px 16px;border-bottom:1px solid #e5e5ea;color:#6b6f76;font-size:14px">Search or jump to…</div>
  <div style="padding:6px 8px;font-size:13px">
    <div style="padding:4px 8px;color:#9a9ea6;font-size:11px;text-transform:uppercase">Navigation</div>
    <div style="padding:7px 8px;border-radius:6px;background:#f2eefb">Go to Projects</div>
    <div style="padding:7px 8px">Go to Settings</div>
    <div style="padding:4px 8px;color:#9a9ea6;font-size:11px;text-transform:uppercase">Actions</div>
    <div style="padding:7px 8px">Create project</div>
  </div>
</div>`,
      },
      {
        id: 'keyboard',
        title: 'Keyboard',
        refs: [{ repo: 'app', path: 'src/ui/palette/Palette.tsx' }],
        symbols: ['usePaletteHotkeys'],
        body: `| Key | Action |
|---|---|
| ↑ / ↓ | move selection |
| Enter | run |
| Esc | close |
| Tab | switch group |`,
      },
    ],
  },
  {
    id: 'dark-mode',
    title: 'Dark mode',
    summary: 'System-aware dark theme with a manual override in settings.',
    category: 'ui',
    priority: 'p3',
    final: 'active',
    tags: ['ui'],
    owner: 'giulia',
    repo: 'app',
    standards: ['ui-accessibility'],
    startDaysAgo: 2,
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        body: `Follow \`prefers-color-scheme\` by default; settings offer Light / Dark / System. Colours come from design tokens so components need no changes.`,
      },
    ],
  },
];

/** Work orders on sections of a spec (specCommit = the spec's version when created). */
export const WORK_ORDERS: {
  /** Kept for the original items; new ones get a generated `wo-` id. */
  id?: string;
  spec: string;
  kind: 'implement' | 'update' | 'review' | 'verify';
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  note?: string;
  sections: { id: string; status: 'pending' | 'done' }[];
  createdBy: string;
  agent?: string;
  /** Hours before now. */
  hoursAgo: number;
}[] = [
  {
    id: 'q-0001',
    spec: 'login-sso',
    kind: 'implement',
    priority: 'p1',
    status: 'in_progress',
    sections: [
      { id: 'overview', status: 'done' },
      { id: 'auth-flow', status: 'done' },
      { id: 'callback', status: 'pending' },
    ],
    createdBy: 'matteo',
    agent: 'claude-code@matteo-mbp',
    hoursAgo: 1.1,
  },
  {
    id: 'q-0002',
    spec: 'usage-metering',
    kind: 'update',
    priority: 'p2',
    status: 'pending',
    note: 'Aggregation rules changed after the double-count incident; bring the flush job in line.',
    sections: [
      { id: 'pipeline', status: 'pending' },
      { id: 'aggregation', status: 'pending' },
    ],
    createdBy: 'matteo',
    hoursAgo: 6,
  },
  {
    id: 'q-0003',
    spec: 'audit-log',
    kind: 'implement',
    priority: 'p2',
    status: 'done',
    sections: [
      { id: 'events', status: 'done' },
      { id: 'api', status: 'done' },
    ],
    createdBy: 'giulia',
    agent: 'claude-code@matteo-mbp',
    hoursAgo: 30,
  },
  {
    id: 'q-0004',
    spec: 'stripe-checkout',
    kind: 'implement',
    priority: 'p0',
    status: 'failed',
    note: 'Webhook signature verification fails in CI: STRIPE_WEBHOOK_SECRET is not set for the test environment.',
    sections: [
      { id: 'checkout-flow', status: 'done' },
      { id: 'webhooks', status: 'pending' },
    ],
    createdBy: 'matteo',
    agent: 'claude-code@ci-runner-3',
    hoursAgo: 4,
  },
  {
    id: 'q-0005',
    spec: 'mfa-totp',
    kind: 'review',
    priority: 'p2',
    status: 'pending',
    sections: [
      { id: 'enrolment-ui', status: 'pending' },
      { id: 'login-flow', status: 'pending' },
    ],
    createdBy: 'giulia',
    hoursAgo: 2,
  },
  {
    id: 'q-0006',
    spec: 'user-sessions',
    kind: 'verify',
    priority: 'p3',
    status: 'pending',
    sections: [
      { id: 'lifecycle', status: 'pending' },
      { id: 'storage', status: 'pending' },
    ],
    createdBy: 'sofia',
    hoursAgo: 28,
  },
  // Work orders around the checkout chain (usage-metering <- plans tiers <- stripe webhooks <- invoice emails),
  // so a work order's dependency graph has two upstream levels and a downstream work order.
  {
    spec: 'plans-and-pricing',
    kind: 'review',
    priority: 'p3',
    status: 'pending',
    note: 'Check the tier limits against what usage metering actually counts.',
    sections: [{ id: 'tiers', status: 'pending' }],
    createdBy: 'giulia',
    hoursAgo: 0.5,
  },
  {
    spec: 'invoice-emails',
    kind: 'implement',
    priority: 'p2',
    status: 'pending',
    note: 'Blocked on the Stripe webhooks: receipts go out from invoice.paid.',
    sections: [{ id: 'template', status: 'pending' }],
    createdBy: 'sofia',
    hoursAgo: 0.4,
  },
];

/** Effects of applying feedback: each becomes one commit with a `Feedback: <id>` trailer. */
export type FeedbackApply =
  | { type: 'replace'; target: string; find: string; replace: string; message: string; hoursAgo: number }
  | { type: 'createStandard'; id: string; title: string; summary: string; tags: string[]; sections: SectionInput[]; message: string; hoursAgo: number }
  | { type: 'archiveSection'; target: string; message: string; hoursAgo: number };

/** Feedback items (the "why" behind changes). Closing happens after the apply commits, which freezes them. */
export const FEEDBACK: {
  id: string;
  targets: string[];
  quote?: string;
  kind: 'ambiguity' | 'conflict' | 'bug' | 'improvement' | 'question';
  body: string;
  hoursAgo: number;
  /** Author handle (default matteo). Waivers need approval by someone other than the waiver's author. */
  by?: string;
  /** Final state (status open when omitted). */
  final?: { status: 'accepted' } | { status: 'closed'; resolution: 'applied' | 'rejected' | 'duplicate'; resolutionNote?: string; duplicateOf?: string; hoursAgo: number };
  apply?: FeedbackApply[];
}[] = [
  {
    id: 'fb-0010',
    targets: ['mandate://specs/command-palette/sections/keyboard'],
    kind: 'question',
    body: 'Native command palettes show the selected row with a background highlight, not a focus ring. Approving the deviation from the focus-visible criterion for the palette rows.',
    by: 'giulia',
    hoursAgo: 3,
    final: { status: 'accepted' },
  },
  {
    id: 'fb-0001',
    targets: ['mandate://specs/login-sso/sections/callback'],
    quote: 'Require email_verified: true.',
    kind: 'ambiguity',
    body: 'Microsoft work accounts often omit `email_verified`. Should those be rejected too, or trusted because the tenant verified them?',
    hoursAgo: 0.6,
  },
  {
    id: 'fb-0002',
    targets: ['mandate://specs/stripe-checkout/sections/webhooks', 'mandate://standards/api-conventions/sections/rules'],
    quote: 'Handle and acknowledge within 2 s; do the work in a job.',
    kind: 'conflict',
    body: 'API conventions require an `Idempotency-Key` header on every mutating endpoint, but Stripe cannot send one to our webhook. Exempt webhooks, or derive the key from the event id?',
    hoursAgo: 3.5,
  },
  {
    id: 'fb-0003',
    targets: ['mandate://specs/mfa-totp/sections/overview'],
    quote: 'Admins must enrol before their next login.',
    kind: 'question',
    body: 'What happens to admins who sign in with SSO only? Their IdP may already enforce MFA.',
    hoursAgo: 20,
  },
  {
    id: 'fb-0004',
    targets: ['mandate://specs/plans-and-pricing/sections/tiers'],
    kind: 'improvement',
    body: 'Add a non-profit discount tier (50% off Team) — sales gets this question every week.',
    hoursAgo: 50,
    final: { status: 'accepted' },
  },
  {
    id: 'fb-0005',
    targets: ['mandate://specs/usage-metering/sections/aggregation'],
    quote: 'The idempotency key is',
    kind: 'bug',
    body: 'Flush retries generated a fresh idempotency key, so Stripe counted the same hour twice. The spec should say retries must reuse the first key.',
    hoursAgo: 14 * 24,
    final: { status: 'closed', resolution: 'applied', hoursAgo: 12 * 24 },
  },
  {
    id: 'fb-0006',
    targets: ['mandate://specs/rate-limiting/sections/limits'],
    quote: '100 requests / 10 s per API key (burst 200).',
    kind: 'improvement',
    body: 'The refill rate is only in the diagram, and the header rules are repeated in every spec. State the rate next to the limit and move the headers into a standard.',
    hoursAgo: 72,
    apply: [
      {
        type: 'replace',
        hoursAgo: 48,
        target: 'mandate://specs/rate-limiting/sections/limits',
        find: '100 requests / 10 s per API key (burst 200).',
        replace: '100 requests / 10 s per API key (burst 200, refilled at 10 tokens/s).',
        message: 'spec(rate-limiting): state the refill rate',
      },
      {
        type: 'createStandard',
        hoursAgo: 47,
        id: 'rate-limit-headers',
        title: 'Rate limit headers',
        summary: 'How every API reports rate limits to clients.',
        tags: ['api'],
        sections: [
          {
            id: 'rules',
            title: 'Rules',
            body: '- Send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response.\n- `429` responses also send `Retry-After` in seconds.',
          },
        ],
        message: 'standard(rate-limit-headers): extract header rules from rate-limiting',
      },
      { type: 'archiveSection', hoursAgo: 46, target: 'mandate://specs/legacy-xml-export/sections/overview', message: 'spec(legacy-xml-export): archive the overview (superseded by the CSV export; documents are never deleted)' },
    ],
    final: { status: 'closed', resolution: 'applied', hoursAgo: 45 },
  },
  {
    id: 'fb-0007',
    targets: ['mandate://standards/security-baseline/sections/rules'],
    quote: 'Secrets come from the environment or the vault, never from the repo.',
    kind: 'ambiguity',
    body: 'Which vault? Name it, otherwise every team picks a different one.',
    hoursAgo: 6 * 24,
    apply: [
      {
        type: 'replace',
        hoursAgo: 5 * 24,
        target: 'mandate://standards/security-baseline/sections/rules',
        find: 'Secrets come from the environment or the vault, never from the repo.',
        replace: 'Secrets come from the environment or from 1Password Connect (the team vault), never from the repo.',
        message: 'standard(security-baseline): name the secrets vault',
      },
    ],
    final: { status: 'closed', resolution: 'applied', hoursAgo: 5 * 24 - 1 },
  },
  {
    id: 'fb-0008',
    targets: ['mandate://standards/testing-policy/sections/rules'],
    quote: 'Critical paths (auth, billing) need end-to-end tests.',
    kind: 'improvement',
    body: 'Require end-to-end tests for every new endpoint, not only auth and billing.',
    hoursAgo: 4 * 24,
    final: {
      status: 'closed',
      resolution: 'rejected',
      resolutionNote: 'E2E tests stay limited to critical paths; other endpoints use contract tests, which are faster and less flaky.',
      hoursAgo: 3 * 24,
    },
  },
  {
    id: 'fb-0009',
    targets: ['mandate://specs/stripe-checkout/sections/webhooks'],
    kind: 'conflict',
    body: 'Webhook handler cannot satisfy the Idempotency-Key rule from API conventions.',
    hoursAgo: 3,
    final: { status: 'closed', resolution: 'duplicate', duplicateOf: 'fb-0002', hoursAgo: 2.5 },
  },
];
