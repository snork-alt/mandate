/**
 * Architecture components (shared by `npm run seed` and the in-place migration `migrate-components.ts`):
 * nine components matching the sample specs' code refs, with owns globs, interface sections,
 * depends_on links between them, follows links to standards, one deprecated component, and
 * `affects` links from spec sections. `api:src/audit/routes.ts` is left unowned on purpose (the
 * coverage lint reports it). Idempotent.
 */
import type { CommitMeta, Storage } from '../src/storage/index.js';

type Sec = { id: string; title: string; type?: string; body: string; links?: { to: string; rel: string; note?: string }[] };
type Comp = {
  id: string;
  title: string;
  summary: string;
  kind: 'service' | 'module' | 'library' | 'datastore' | 'external';
  owns: { repo: string; paths: string[] }[];
  tags: string[];
  owner: string;
  status?: 'active' | 'deprecated';
  /** Architecture layer (top to bottom: ui, api, service, domain, data, infra). */
  layer?: string;
  /** Containing component (created earlier in this list). */
  parent?: string;
  sections: Sec[];
};

const C = (id: string, sid?: string) => `mandate://components/${id}${sid ? `/sections/${sid}` : ''}`;
const T = (id: string, sid?: string) => `mandate://standards/${id}${sid ? `/sections/${sid}` : ''}`;
const context = (body: string): Sec => ({ id: 'context', title: 'Context', type: 'mermaid', body });

export const COMPONENTS: Comp[] = [
  {
    id: 'postgres',
    title: 'Postgres',
    summary: 'Primary relational datastore (sessions, billing, audit).',
    kind: 'datastore',
    owns: [{ repo: 'app', paths: ['db/**'] }],
    tags: ['data'],
    owner: 'sofia',
    layer: 'data',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Stores sessions, subscriptions and audit events. Migrations live in `db/migrations`.' },
      { id: 'schema', title: 'Schema', body: 'Tables: `sessions`, `subscriptions`, `usage_events`, `audit_events`. Changes go through numbered migrations only.' },
    ],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    summary: 'External payment provider (checkout, subscriptions, metered usage).',
    kind: 'external',
    owns: [],
    tags: ['payments'],
    owner: 'matteo',
    layer: 'infra',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Hosts checkout, owns subscription state and receives metered usage.' },
      { id: 'api', title: 'Stripe API', body: 'Checkout Sessions, Subscriptions, Usage Records; webhooks signed with `Stripe-Signature`.' },
    ],
  },
  {
    id: 'auth-service',
    title: 'Auth service',
    summary: 'Sign-in (OIDC), sessions and token rotation.',
    kind: 'service',
    owns: [{ repo: 'app', paths: ['src/auth/**'] }],
    tags: ['auth', 'security'],
    owner: 'matteo',
    layer: 'service',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Signs users in with Google and Microsoft (OIDC), issues short-lived access tokens and rotates refresh tokens.' },
      {
        id: 'sessions-api',
        title: 'Sessions API',
        body: '`SessionStore.create(user)`, `SessionStore.rotate(refreshToken)`, `SessionStore.revokeFamily(id)`.',
        links: [{ to: C('postgres', 'schema'), rel: 'depends_on', note: 'sessions table' }],
      },
      { id: 'oidc-callback', title: 'OIDC callback', body: '`GET /auth/callback` exchanges the code (PKCE) and creates a session.' },
      context('flowchart LR\n  Browser --> Auth[Auth service]\n  Auth --> IdP[Identity provider]\n  Auth --> DB[(Postgres)]'),
      { id: 'rationale', title: 'Rationale', body: 'Kept in the app repo so sessions and the UI ship together; extract when a second client appears.', links: [{ to: T('security-baseline'), rel: 'follows' }] },
    ],
  },
  {
    id: 'api-gateway',
    title: 'API gateway',
    summary: 'HTTP edge of the public API: routing, validation, rate limits.',
    kind: 'service',
    owns: [{ repo: 'api', paths: ['src/http/**', 'src/routes/**'] }],
    tags: ['api'],
    owner: 'giulia',
    layer: 'api',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Routes requests, validates bodies at the edge and applies rate limits.', links: [{ to: T('api-conventions'), rel: 'follows' }] },
      {
        id: 'routes',
        title: 'Public routes',
        body: '`/v1/*` REST endpoints; errors follow the shared error shape.',
        links: [{ to: C('auth-service', 'sessions-api'), rel: 'depends_on', note: 'authenticates every request' }],
      },
    ],
  },
  {
    id: 'billing',
    title: 'Billing',
    summary: 'Checkout, subscriptions and Stripe webhooks.',
    kind: 'service',
    owns: [{ repo: 'app', paths: ['src/billing/**'] }],
    tags: ['payments'],
    owner: 'matteo',
    layer: 'domain',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Starts checkout, mirrors subscription state from Stripe webhooks and exposes plan limits.' },
      {
        id: 'events',
        title: 'Billing events',
        body: 'Emits `invoice.paid` and `subscription.changed` after verified webhooks.',
        links: [{ to: C('stripe', 'api'), rel: 'depends_on', note: 'webhooks' }],
      },
      { id: 'usage-api', title: 'Usage API', body: '`reportUsage(workspace, quantity, idempotencyKey)`.', links: [{ to: C('postgres', 'schema'), rel: 'depends_on' }] },
      context('flowchart LR\n  App --> Billing\n  Billing --> Stripe\n  Stripe -. webhooks .-> Billing'),
    ],
  },
  {
    id: 'usage-metering',
    title: 'Usage metering',
    summary: 'Counts API calls and flushes them to Stripe hourly.',
    kind: 'module',
    owns: [{ repo: 'api', paths: ['src/metering/**'] }],
    tags: ['payments', 'data'],
    owner: 'matteo',
    layer: 'service',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Aggregates usage per workspace and flushes it hourly, idempotently.' },
      { id: 'flush', title: 'Flush job', body: 'Hourly job; retries reuse the first idempotency key.', links: [{ to: C('billing', 'usage-api'), rel: 'depends_on' }] },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    summary: 'Transactional email (receipts, invites).',
    kind: 'service',
    owns: [{ repo: 'api', paths: ['src/notifications/**'] }],
    tags: ['email'],
    owner: 'sofia',
    layer: 'service',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Renders and sends transactional email.' },
      { id: 'templates', title: 'Templates', body: 'MJML templates rendered per locale.', links: [{ to: C('billing', 'events'), rel: 'depends_on', note: 'receipts on invoice.paid' }] },
    ],
  },
  {
    id: 'web-app',
    title: 'Web app',
    summary: 'The browser UI (React).',
    kind: 'module',
    owns: [{ repo: 'app', paths: ['src/ui/**'] }],
    tags: ['ui'],
    owner: 'giulia',
    layer: 'ui',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Pages, command palette and settings; talks to the API gateway only.' },
      { id: 'shell', title: 'App shell', body: 'Layout, navigation and the Cmd+K palette.', links: [{ to: C('api-gateway', 'routes'), rel: 'depends_on' }, { to: T('ui-accessibility'), rel: 'follows' }] },
    ],
  },
  {
    id: 'legacy-export',
    title: 'Legacy XML export',
    summary: 'Nightly XML dump for the old reporting tool (deprecated; replaced by the CSV export).',
    kind: 'module',
    owns: [{ repo: 'api', paths: ['src/export/xml/**'] }],
    tags: ['data'],
    owner: 'sofia',
    layer: 'service',
    status: 'deprecated',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Writes the nightly XML dump. Kept read-only until the reporting team confirms the switch.' },
      { id: 'job', title: 'Nightly job', body: 'Reads audit events and writes `export.xml`.', links: [{ to: C('postgres', 'schema'), rel: 'depends_on' }] },
    ],
  },
  // Containment: parts of billing and of the auth service (children inherit the parent's layer).
  {
    id: 'stripe-webhooks',
    title: 'Stripe webhooks',
    summary: 'Receives and applies Stripe webhook events (invoices, subscriptions).',
    kind: 'module',
    parent: 'billing',
    owns: [{ repo: 'app', paths: ['src/billing/webhooks.ts', 'src/billing/webhooks/**'] }],
    tags: ['payments'],
    owner: 'matteo',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Verifies, deduplicates and applies Stripe webhook events to subscriptions and invoices. Part of billing.', links: [{ to: C('stripe', 'api'), rel: 'depends_on', note: 'webhook events' }] },
    ],
  },
  {
    id: 'webhook-signature',
    title: 'Webhook signature check',
    summary: 'Verifies Stripe-Signature headers with the endpoint secret.',
    kind: 'library',
    parent: 'stripe-webhooks',
    owns: [{ repo: 'app', paths: ['src/billing/webhooks/signature.ts'] }],
    tags: ['payments', 'security'],
    owner: 'matteo',
    sections: [{ id: 'responsibility', title: 'Responsibility', body: 'Constant-time verification of the Stripe-Signature header (timestamp tolerance, replay protection).' }],
  },
  {
    id: 'session-store',
    title: 'Session store',
    summary: 'Server-side sessions: create, rotate, revoke.',
    kind: 'module',
    parent: 'auth-service',
    owns: [{ repo: 'app', paths: ['src/auth/session.ts'] }],
    tags: ['auth'],
    owner: 'matteo',
    sections: [
      { id: 'responsibility', title: 'Responsibility', body: 'Creates, rotates and revokes server-side sessions; the sessions table lives in Postgres. Part of the auth service.', links: [{ to: C('postgres', 'schema'), rel: 'depends_on', note: 'sessions table' }] },
    ],
  },
];

/** Spec sections that affect a component (`affects`). */
export const AFFECTS: { spec: string; section: string; to: string }[] = [
  { spec: 'login-sso', section: 'auth-flow', to: C('auth-service', 'oidc-callback') },
  { spec: 'login-sso', section: 'callback', to: C('auth-service', 'oidc-callback') },
  { spec: 'user-sessions', section: 'storage', to: C('auth-service', 'sessions-api') },
  { spec: 'stripe-checkout', section: 'webhooks', to: C('billing', 'events') },
  { spec: 'plans-and-pricing', section: 'tiers', to: C('billing') },
  { spec: 'usage-metering', section: 'pipeline', to: C('usage-metering', 'flush') },
  { spec: 'invoice-emails', section: 'template', to: C('notifications', 'templates') },
  { spec: 'command-palette', section: 'keyboard', to: C('web-app', 'shell') },
  { spec: 'rate-limiting', section: 'limits', to: C('api-gateway', 'routes') },
];

/** Create the components (links in a second pass, so every depends_on target exists) and the affects links. */
export async function applyComponents(storage: Storage, meta: () => CommitMeta): Promise<string[]> {
  const log: string[] = [];
  const existing = new Set((await storage.components.list()).map((c) => c.id));
  for (const c of COMPONENTS) {
    if (existing.has(c.id)) continue;
    await storage.components.create({ ...c, sections: c.sections.map(({ links: _l, ...s }) => s) } as never, { ...meta(), message: `component(${c.id}): ${c.title}` });
    log.push(`+ component ${c.id}`);
  }
  // Repos seeded before layers existed: add the layer (only where none is set).
  for (const c of COMPONENTS) {
    if (!existing.has(c.id) || !c.layer) continue;
    const cur = await storage.components.get(c.id);
    if (cur.layer || cur.status === 'archived') continue;
    await storage.components.update(c.id, { layer: c.layer } as never, { ...meta(), message: `component(${c.id}): layer ${c.layer}` });
    log.push(`layer ${c.id}`);
  }
  for (const c of COMPONENTS) {
    if (existing.has(c.id) || !c.sections.some((s) => s.links?.length)) continue;
    const cur = await storage.components.get(c.id);
    const sections = cur.sections.map((s) => ({ ...s, links: c.sections.find((x) => x.id === s.id)?.links ?? s.links }));
    await storage.components.update(c.id, { sections } as never, { ...meta(), message: `component(${c.id}): dependencies and standards` });
  }
  const bySpec = new Map<string, typeof AFFECTS>();
  for (const a of AFFECTS) bySpec.set(a.spec, [...(bySpec.get(a.spec) ?? []), a]);
  for (const [specId, list] of bySpec) {
    const spec = await storage.specs.get(specId).catch(() => null);
    if (!spec) continue;
    let changed = false;
    const sections = spec.sections.map((s) => {
      const add = list.filter((a) => a.section === s.id && !s.links.some((l) => l.to === a.to)).map((a) => ({ to: a.to, rel: 'affects' as const }));
      if (add.length) changed = true;
      return add.length ? { ...s, links: [...s.links, ...add] } : s;
    });
    if (!changed) continue;
    await storage.specs.update(specId, { sections } as never, { ...meta(), message: `spec(${specId}): link affected components` });
    log.push(`affects ${specId}`);
  }
  return log;
}
