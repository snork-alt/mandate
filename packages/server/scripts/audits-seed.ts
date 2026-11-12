/**
 * Seed two realistic audits into a running Mandate server through the normal MCP write path (append-only, no reset):
 * one spec with failing findings (-> a fix work order + feedback) and one that passes.
 *   npx tsx scripts/audits-seed.ts [http://127.0.0.1:4000/p/default/mcp]
 * The agent key is read from ~/.mandate/keys.json (never printed).
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:4000/p/default/mcp');
const project = /\/p\/([^/]+)\/mcp/.exec(url.pathname)?.[1] ?? 'default';
const home = process.env.MANDATE_HOME ?? path.join(os.homedir(), '.mandate');
const keys = JSON.parse(readFileSync(path.join(home, 'keys.json'), 'utf8')) as { keys: { project: string; key: string }[] };
const key = keys.keys.find((k) => k.project === project)?.key;
if (!key) throw new Error(`no agent key for project ${project}`);
const client = new Client({ name: 'audit-agent', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));

type Json = Record<string, any>;
async function call(name: string, args: Json): Promise<Json> {
  const r = await client.callTool({ name, arguments: { ...(name.startsWith('audit_') && !['audit_plan', 'audit_get', 'audit_list'].includes(name) ? { agent: 'audit-agent' } : {}), ...args } });
  const body = r.structuredContent as Json;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}

const CODE = { repo: 'app', commit: '7c41e9a2d3b85f10e6a4c9d2b7f03e18a5c6d4b1', branch: 'main' };

/* ---------- 1. login-sso: failing findings */
{
  const target = 'mandate://specs/login-sso';
  const plan = await call('audit_plan', { target });
  const start = await call('audit_start', {
    target,
    code: CODE,
    overview: 'Scope: the OIDC login flow in `app` (src/auth/oidc.ts, src/auth/callback.ts, src/auth/session.ts) against the spec criteria and the security, testing and observability rules that apply to it.',
  });
  const id = start.audit.id as string;
  const special: Record<string, Json> = {
    'ac-unverified-rejected': {
      result: 'fail',
      notes:
        'Read `handleCallback` in `app:src/auth/callback.ts#L44-L58`. Google tokens go through `assertVerifiedEmail`, but the Microsoft branch maps work accounts straight from the `preferred_username` claim and never looks at `email_verified`. A Microsoft personal account with an unverified email therefore gets a session. The unit tests only cover the Google path.',
      findings: [
        {
          title: 'Microsoft sign-ins skip the email_verified check',
          description: 'The Microsoft branch of `handleCallback` builds the user from `preferred_username` and creates a session without checking `email_verified`, so unverified personal accounts can sign in. The criterion requires every provider to reject unverified emails.',
          suggestedFix: 'Call `assertVerifiedEmail(claims)` before `createSession` for every provider (move it above the provider switch) and add a test with a Microsoft token where `email_verified` is false.',
          evidence: '```ts\ncase "microsoft":\n  user = await upsertUser({ email: claims.preferred_username, tenant: claims.tid });\n  break; // no email_verified check\n```',
          codeRefs: ['app:src/auth/callback.ts#L44-L58'],
          classification: 'code_deviates',
        },
      ],
    },
    'ac-fake-idp-e2e': {
      result: 'partial',
      notes:
        'CI runs `e2e/login.spec.ts` against the fake provider in `app:e2e/fake-idp.ts#L1-L60`, but only the Google-shaped flow. The criterion says "the full flow" without naming which providers or error paths the fake must cover, so it is unclear whether the Microsoft tenant mapping and the error callback are in scope.',
      findings: [
        {
          title: 'The criterion does not say which flows the fake IdP must cover',
          description: '"CI runs the full flow against a fake OIDC provider" can be read as the Google happy path only (what exists) or as every provider plus error callbacks. The audit cannot decide pass or fail without the spec stating the expected coverage.',
          suggestedFix: 'State the flows the fake IdP must exercise (Google, Microsoft personal and work accounts, the error callback) in the criterion.',
          codeRefs: ['app:e2e/fake-idp.ts#L1-L60'],
          classification: 'ambiguous',
        },
      ],
    },
  };
  const ruleFail: Record<string, Json> = {
    'ac-no-secrets-in-logs': {
      result: 'fail',
      notes:
        'Searched the callback error paths for logged values. `app:src/auth/callback.ts#L71-L76` logs the whole query string on a failed token exchange, which includes the one-time authorization `code` (a credential until it expires). The redaction helper in `src/log/redact.ts` is not applied here.',
      findings: [
        {
          title: 'Callback errors log the authorization code',
          description: 'On a failed token exchange the handler logs `req.url`, which carries the authorization `code` and `state`. The rule forbids tokens and codes in logs; this one is shipped to the log provider.',
          suggestedFix: 'Log the provider and the error code only (`log.warn({ provider, error: err.code })`), or pass the query through `redact()` before logging.',
          evidence: '```ts\nlog.warn(`token exchange failed for ${req.url}`, err);\n```',
          codeRefs: ['app:src/auth/callback.ts#L71-L76', 'app:src/log/redact.ts#L1-L24'],
          classification: 'code_deviates',
          severity: 'critical',
        },
      ],
    },
  };
  for (const item of plan.items as Json[]) {
    const sid = String(item.ref).split('/sections/')[1]!;
    const spec = special[sid] ?? ruleFail[sid];
    if (spec) {
      await call('audit_record_item', { auditId: id, ref: item.ref, ...spec });
      continue;
    }
    if (item.level === 'should' && !special.__should) {
      special.__should = {};
      await call('audit_record_item', {
        auditId: id,
        ref: item.ref,
        result: 'partial',
        notes: `Checked "${item.title}" against the callback and session code. The happy path follows it, but the error branch in \`app:src/auth/callback.ts#L60-L80\` does not.`,
        findings: [
          {
            title: `Error branch does not follow "${item.title}"`,
            description: `The error branch of the callback handler is the one place in the login flow that does not follow "${item.title}".`,
            suggestedFix: 'Apply the same pattern as the happy path in the error branch.',
            codeRefs: ['app:src/auth/callback.ts#L60-L80'],
            classification: 'code_deviates',
          },
        ],
      });
      continue;
    }
    await call('audit_record_item', {
      auditId: id,
      ref: item.ref,
      result: 'pass',
      notes: `Checked "${item.title}" by reading the login code (\`app:src/auth/oidc.ts#L10-L64\`, \`app:src/auth/callback.ts#L1-L80\`)${item.check?.command ? ` and running \`${item.check.command}\`` : ''}; it holds.`,
    });
  }
  await call('audit_complete', {
    auditId: id,
    summary: 'Login mostly conforms; Microsoft sign-ins skip email verification and callback errors log the authorization code.',
    overview: [
      'Scope: the OIDC login flow in `app` at the audited commit: `src/auth/oidc.ts`, `src/auth/callback.ts`, `src/auth/session.ts`, the e2e suite and the logging helpers, against the five criteria of the spec and every rule it inherits.',
      '',
      'Assessment: the Google path is solid and well tested. Two must-level deviations remain: Microsoft sign-ins skip the `email_verified` check, and a failed token exchange logs the authorization code. One criterion (the fake IdP e2e test) is ambiguous about coverage.',
      '',
      'Risks: an unverified Microsoft personal account can sign in; authorization codes reach the log provider.',
      '',
      'Recommendations: fix both deviations in one change to the callback handler, then clarify the e2e criterion.',
    ].join('\n'),
  });
  const wo = await call('audit_findings_to_work_orders', { auditId: id, agent: 'audit-agent' });
  for (const f of wo.feedbackNeeded as Json[]) {
    await call('feedback_create', {
      agent: 'audit-agent',
      targets: [f.ref],
      kind: f.classification === 'ambiguous' ? 'ambiguity' : 'conflict',
      body: `${f.title}. ${f.description}`,
      fromFinding: f.uri,
    });
  }
  console.log(`login-sso audit ${id}: ${wo.workOrders.length} fix work order(s), ${wo.feedbackNeeded.length} feedback item(s)`);
}

/* ---------- 2. user-sessions: passes */
{
  const target = 'mandate://specs/user-sessions';
  const plan = await call('audit_plan', { target });
  const start = await call('audit_start', { target, code: CODE });
  const id = start.audit.id as string;
  for (const item of plan.items as Json[]) {
    await call('audit_record_item', {
      auditId: id,
      ref: item.ref,
      result: 'pass',
      notes: `Checked "${item.title}" in the session store and refresh endpoint (\`app:src/auth/session.ts#L1-L120\`)${item.check?.command ? `; \`${item.check.command}\` passes` : ''}. The implementation matches.`,
    });
  }
  await call('audit_complete', {
    auditId: id,
    summary: 'Sessions conform: rotation, reuse detection and cookie flags all hold.',
    overview: 'Scope: refresh-token rotation, reuse revocation and session cookies in `app:src/auth/session.ts`, against the spec criteria and the security rules it inherits.\n\nAssessment: every criterion and rule holds; tests cover rotation and the reuse path.\n\nRecommendations: none; re-audit when the session store moves to Redis.',
  });
  console.log(`user-sessions audit ${id}: passed`);
}
await client.close();
