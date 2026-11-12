/**
 * Seed realistic work-order delivery data into a running Mandate server through the normal MCP write path
 * (append-only, no reset): a plan, git context (branch, worktree, commits, a PR merged afterwards), touched code per
 * section, section notes / deviations, review comments (blocking + reply + resolve, a non-blocking one), completion
 * with an outcome; and a review work order in progress with an open blocking comment.
 *   npx tsx scripts/work-orders-seed.ts [http://127.0.0.1:4000/p/default/mcp]
 * The agent key is read from ~/.mandate/keys.json (never printed). Work orders already past the seeded state are skipped.
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
const client = new Client({ name: 'work-order-agent', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));

type Json = Record<string, any>;
const IMPL = 'claude-code@matteo-mbp';
const REVIEWER = 'review-agent@ci';
async function call(name: string, args: Json, agent?: string): Promise<Json> {
  const r = await client.callTool({ name, arguments: { ...(agent ? { agent } : {}), ...args } });
  const body = r.structuredContent as Json;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}

/* ---------- 1. q-0002: update usage-metering, delivered end to end */
{
  const ref = 'mandate://work-orders/q-0002';
  const wo = (await call('work_order_get', { ref })).item as Json;
  if (wo.status === 'pending' && !wo.claim) {
    await call(
      'work_order_plan_set',
      {
        ref,
        plan: [
          'Bring the hourly flush in line with the new aggregation rules (double-count incident).',
          '',
          '1. **Pipeline**: make `flushUsage` reuse the idempotency key of the batch on retry (`src/metering/flush.ts`), and move the batch window computation into `src/metering/window.ts`.',
          '2. **Aggregation rules**: sum per (customer, meter, hour) before sending; drop zero rows; rename `aggregate.ts` to `rollup.ts`.',
          '3. Tests: retry with the same key does not double count (`ac-idempotent-flush`); a 50k-row hour flushes in < 30 s (`ac-flush-latency`).',
          '4. Reconcile: code refs on pipeline / aggregation, component owns for `src/metering/**`.',
        ].join('\n'),
      },
      IMPL,
    );
    await call('work_order_claim', { ref, branch: 'wo/q-0002-metering-flush', worktree: '/Users/matteo/code/api-wt/q-0002', git: [{ repo: 'api', branch: 'wo/q-0002-metering-flush', baseBranch: 'main', baseCommit: 'c03e5aa1d2b4', worktree: { path: '/Users/matteo/code/api-wt/q-0002', host: 'matteo-mbp' } }] }, IMPL);
    await call('work_order_git_update', { ref, repo: 'api', headCommit: '5b1e9f0c7a24', commits: ['8d2c41aa90e1'] }, IMPL);
    await call(
      'work_order_section_done',
      {
        ref,
        sections: ['pipeline'],
        notes: 'Retries now reuse the batch idempotency key (`batchKey(customer, hour)`), so a retried flush is a no-op on the billing side. The window computation moved to `window.ts`.',
        codeRefs: ['api:src/metering/flush.ts#L30-L95', { repo: 'api', path: 'src/metering/window.ts', lines: ['1-48'], symbols: ['flushWindow'], change: 'added' }],
        verifications: ['mandate://specs/usage-metering/sections/ac-idempotent-flush'],
        git: [{ repo: 'api', headCommit: '5b1e9f0c7a24' }],
      },
      IMPL,
    );
    const c1 = await call('comment_add', { target: `${ref}/sections/aggregation`, body: 'The rollup still counts zero rows when a meter reports only deletions: drop them before sending, the spec says "no empty rows".', blocking: true }, REVIEWER);
    await call('comment_add', { target: ref, body: 'Nit: `rollup.ts` could export the bucket type so the tests stop re-declaring it.' }, REVIEWER);
    await call(
      'work_order_section_done',
      {
        ref,
        sections: ['aggregation'],
        notes: 'Sum per (customer, meter, hour) before sending; zero rows are dropped. `aggregate.ts` was renamed to `rollup.ts`.',
        codeRefs: [{ repo: 'api', path: 'src/metering/rollup.ts', from: 'src/metering/aggregate.ts', change: 'renamed', lines: ['10-64'], symbols: ['rollupHour'] }],
        deviations: ['Zero rows are dropped in the rollup, not in the flush (the spec places it in the flush; same result, one place fewer).'],
        git: [{ repo: 'api', headCommit: 'e47a0d3b19c8', commits: ['e47a0d3b19c8'] }],
      },
      IMPL,
    );
    await call('comment_add', { target: `${ref}/sections/aggregation`, parent: c1.comment.id, body: 'Fixed in e47a0d3: zero rows are filtered in `rollupHour` (test `drops empty buckets`).' }, IMPL);
    await call('comment_resolve', { id: c1.comment.id, note: 'Verified with the new test.' }, REVIEWER);
    await call('work_order_touch', { ref, section: 'aggregation', files: [{ repo: 'api', path: 'test/metering/rollup.test.ts', lines: ['1-80'], change: 'added' }] }, IMPL);
    await call('work_order_git_update', { ref, repo: 'api', pr: { number: 318, status: 'open', url: 'https://github.com/acme/api/pull/318' } }, IMPL);
    await call(
      'work_order_complete',
      {
        ref,
        outcome: 'The hourly flush reuses the batch idempotency key on retry and the rollup sums per (customer, meter, hour) without empty rows: the double count of the incident cannot recur. PR acme/api#318.',
        reconciliation: 'usage-metering: code refs on pipeline (flush.ts, window.ts) and aggregation (rollup.ts); deviation noted on aggregation. Component metering-service owns src/metering/**.',
        git: [{ repo: 'api', headCommit: 'e47a0d3b19c8' }],
      },
      IMPL,
    );
    // The PR is merged after completion (allowed on a frozen work order).
    await call('work_order_git_update', { ref, repo: 'api', pr: { status: 'merged', mergedCommit: '9f3b2c1d7e60' }, mergedInto: 'main' }, IMPL);
    console.log('q-0002 delivered');
  } else console.log(`q-0002 is ${wo.status}: skipped`);
}

/* ---------- 2. q-0005: review of mfa-totp in progress, an open blocking comment */
{
  const ref = 'mandate://work-orders/q-0005';
  const wo = (await call('work_order_get', { ref })).item as Json;
  if (wo.status === 'pending' && !wo.claim) {
    await call('work_order_plan_set', { ref, plan: 'Review the enrolment screen and the login flow against the spec: QR + manual secret, recovery codes shown once, rate limit on TOTP attempts. Leave comments on the sections; blocking for must-fix issues.' }, REVIEWER);
    await call('work_order_claim', { ref, git: [{ repo: 'app', branch: 'feat/mfa-totp', baseBranch: 'main' }] }, REVIEWER);
    await call('comment_add', { target: `${ref}/sections/login-flow`, body: 'TOTP verification has no attempt limit: 5 wrong codes must lock the challenge for 15 minutes (spec, login flow).', blocking: true }, REVIEWER);
    await call('comment_add', { target: `${ref}/sections/enrolment-ui`, body: 'The manual secret is shown without grouping; group it by 4 characters as in the design.' }, REVIEWER);
    await call('work_order_touch', { ref, section: 'login-flow', files: ['app:src/auth/totp.ts#L12-L58'] }, REVIEWER);
    console.log('q-0005 in review');
  } else console.log(`q-0005 is ${wo.status}: skipped`);
}

await client.close();
