/** Cross-document section links (shared by `npm run seed` and the in-place migration). */
import type { Storage } from '../src/storage/index.js';
import { SECTION_SUMMARIES } from './section-summaries.js';

type L = { from: string; to: string; rel: string; note?: string; feedback?: string };
const S = (id: string, sid: string) => `mandate://specs/${id}/sections/${sid}`;
const T = (id: string, sid: string) => `mandate://standards/${id}/sections/${sid}`;

export const LINKS: L[] = [
  // spec -> spec
  { from: S('mfa-totp', 'login-flow'), to: S('login-sso', 'callback'), rel: 'depends_on', note: 'MFA runs after the SSO callback' },
  { from: S('login-sso', 'callback'), to: S('user-sessions', 'storage'), rel: 'depends_on', note: 'Sessions come from SessionStore' },
  { from: S('invoice-emails', 'template'), to: S('stripe-checkout', 'webhooks'), rel: 'depends_on', note: 'Receipts are sent from invoice.paid' },
  { from: S('stripe-checkout', 'webhooks'), to: S('plans-and-pricing', 'tiers'), rel: 'depends_on' },
  { from: S('plans-and-pricing', 'tiers'), to: S('usage-metering', 'aggregation'), rel: 'depends_on', note: 'Tier limits are enforced on metered usage' },
  // Former spec-level dependsOn (now derived from section links).
  { from: S('usage-metering', 'pipeline'), to: S('audit-log', 'events'), rel: 'depends_on', note: 'Usage is counted from audit events' },
  { from: S('rate-limiting', 'limits'), to: S('audit-log', 'events'), rel: 'depends_on', note: 'Throttling decisions are audited' },
  { from: S('usage-metering', 'aggregation'), to: S('rate-limiting', 'limits'), rel: 'relates_to', note: 'Throttled requests are not counted' },
  { from: S('spec-claims', 'rules'), to: S('rate-limiting', 'limits'), rel: 'conflicts_with', note: 'Agent heartbeats every 5 min can hit per-key limits' },
  { from: S('mfa-totp', 'overview'), to: S('login-sso', 'overview'), rel: 'extends' },
  { from: S('stripe-checkout', 'checkout-flow'), to: S('plans-and-pricing', 'pricing-card'), rel: 'supersedes', note: 'Checkout replaces the static upgrade buttons' },
  { from: S('audit-log', 'api'), to: S('rate-limiting', 'limits'), rel: 'relates_to' },
  { from: S('command-palette', 'overview'), to: S('dark-mode', 'overview'), rel: 'relates_to' },
  // spec -> standard
  { from: S('login-sso', 'callback'), to: T('security-baseline', 'rules'), rel: 'follows' },
  { from: S('audit-log', 'api'), to: T('api-conventions', 'pagination'), rel: 'follows' },
  { from: S('rate-limiting', 'limits'), to: T('rate-limit-headers', 'rules'), rel: 'follows' },
  { from: S('command-palette', 'keyboard'), to: T('ui-accessibility', 'rules'), rel: 'follows' },
  { from: S('stripe-checkout', 'webhooks'), to: T('api-conventions', 'rules'), rel: 'deviates_from', note: 'Stripe cannot send Idempotency-Key; the event id is the idempotency key.' },
  {
    from: S('mfa-totp', 'enrolment-ui'),
    to: T('ui-accessibility', 'ac-focus-visible'),
    rel: 'deviates_from',
    note: "SSO admins enrol on the IdP's hosted page; focus handling there is the IdP's responsibility.",
  },
  {
    from: S('command-palette', 'keyboard'),
    to: T('ui-accessibility', 'ac-focus-visible'),
    rel: 'deviates_from',
    note: 'Palette rows show selection with a background highlight instead of a focus ring, like native command palettes.',
    // Approved by giulia (a waiver needs accepted feedback from someone other than its author).
    feedback: 'fb-0010',
  },
  // standard -> standard
  { from: T('rate-limit-headers', 'rules'), to: T('api-conventions', 'rules'), rel: 'extends' },
  { from: T('rate-limit-headers', 'rules'), to: T('api-conventions', 'example'), rel: 'supersedes', note: 'The example still shows the old X-RateLimit headers' },
  { from: T('testing-policy', 'rules'), to: T('security-baseline', 'checklist'), rel: 'conflicts_with', note: 'Authz tests for every endpoint vs. E2E only on critical paths' },
  { from: T('ui-accessibility', 'checklist'), to: T('testing-policy', 'checklist'), rel: 'relates_to' },
];

/** Add the links, one commit per document; existing links are kept, duplicates skipped. */
export async function seedLinks(storage: Storage, date: () => Date): Promise<void> {
  const byDoc = new Map<string, L[]>();
  for (const l of LINKS) {
    const doc = l.from.replace(/\/sections\/.*$/, '');
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), l]);
  }
  // Specs first in an order that never creates a dangling or cyclic state.
  for (const [doc, links] of byDoc) {
    const [, kind, id] = /^mandate:\/\/(specs|standards)\/(.+)$/.exec(doc)!;
    const repo = kind === 'specs' ? storage.specs : storage.standards;
    const current = await repo.get(id!).catch(() => null);
    if (!current) continue;
    let changed = false;
    const sections = current.sections.map((s) => {
      const add = links
        .filter((l) => l.from.endsWith(`/sections/${s.id}`))
        .filter((l) => !s.links.some((x) => x.to === l.to && x.rel === l.rel))
        .map((l) => ({ to: l.to, rel: l.rel as never, ...(l.note ? { note: l.note } : {}), ...(l.feedback ? { feedback: l.feedback } : {}) }));
      if (add.length) changed = true;
      return add.length ? { ...s, links: [...s.links, ...add] } : s;
    });
    if (!changed) continue;
    await repo.update(id!, { sections } as never, {
      date: date(),
      author: { name: 'Matteo', email: 'matteo@example.com' },
      message: `${kind === 'specs' ? 'spec' : 'standard'}(${id}): link related sections`,
    });
  }
}

/** Apply SECTION_SUMMARIES (one commit per document that changes). */
export async function seedSummaries(storage: Storage, date: () => Date): Promise<void> {
  for (const kind of ['specs', 'standards'] as const) {
    const repo = kind === 'specs' ? storage.specs : storage.standards;
    for (const doc of await repo.list()) {
      let changed = false;
      const sections = doc.sections.map((s) => {
        const summary = SECTION_SUMMARIES[`${kind}/${doc.id}/${s.id}`];
        if (!summary || s.summary === summary) return s;
        changed = true;
        return { ...s, summary };
      });
      if (changed) await repo.update(doc.id, { sections } as never, { date: date(), author: { name: 'Mandate', email: 'mandate@localhost' }, message: `${kind === 'specs' ? 'spec' : 'standard'}(${doc.id}): add section summaries` });
    }
  }
}
