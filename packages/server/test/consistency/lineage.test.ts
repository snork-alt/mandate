/**
 * Lineage invariants (plans/fable-data-review.md §3b), checked on a copy of the seed data (the data repo clone the
 * contract suites use) and on a fixture modelled on the bad states found by the review (a migration commit with a
 * cause, a bulk work-order rewrite under one Work-Order trailer, a work order whose origin is only its `reason`, later
 * work on a section targeted by earlier feedback):
 * 1. every work order links to its origin (reason feedback, findings);
 * 2. closed (applied) feedback reaches the work order that delivered it;
 * 3. no cause is later than its effect (feedback never has a later work order upstream, unless it records it itself);
 * 4. migration and bulk commits create no causes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNodeUri, buildRef, parseNodeUri } from '@mandate/shared';
import { BULK_WORK_ORDERS, isMigrationCommit } from '../../src/index/lineage.js';
import type { IndexService } from '../../src/index/service.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { graphFixture, type GraphFixture } from '../graph-fixture.js';
import { cleanupTempDirs } from '../helpers.js';

const fbRef = (id: string) => (id.startsWith('mandate://') ? id : buildRef({ kind: 'feedback', id }));

async function invariants(index: IndexService, storage: Storage): Promise<Record<string, string[]>> {
  const db = index.db;
  const out: Record<string, string[]> = { origin: [], delivered: [], time: [], migration: [] };
  const created = (uri: string) => (db.prepare('SELECT min(abs(valid_from)) AS s FROM nodes WHERE uri = ?').get(uri) as { s: number | null }).s;
  const wos = await storage.workOrders.list();
  const fbs = new Map((await storage.feedback.list()).map((f) => [f.id, f]));
  // 1 + 2
  for (const w of wos) {
    const wo = buildRef({ kind: 'work-orders', id: w.id });
    const reason = (w.reason ?? []).map(fbRef);
    const findings = ((w as { findings?: string[] }).findings ?? []).map((f) => { const n = parseNodeUri(f); return n ? buildNodeUri(n) : f; });
    const origins = [...reason, ...findings];
    if (origins.length) {
      const up = await index.lineage({ ref: wo, direction: 'up', depth: 2 } as never);
      for (const o of origins) if (!up.nodes.some((x) => x.uri === o)) out.origin!.push(`${w.id} -/-> ${o}`);
    }
    // Delivered: the feedback this order acts on (reason, or a recorded cause), when closed applied.
    const recorded = (db.prepare("SELECT DISTINCT to_uri AS t FROM edges WHERE from_uri = ? AND kind = 'caused_by' AND to_uri LIKE 'mandate://feedback/%'").all(wo) as { t: string }[]).map((r) => r.t);
    for (const f of new Set([...reason, ...recorded])) {
      const rec = fbs.get(f.split('/').pop()!);
      if (!rec || rec.status !== 'closed' || (rec.resolution ?? 'applied') !== 'applied') continue;
      const down = await index.lineage({ ref: f, direction: 'down', depth: 3 } as never);
      if (!down.nodes.some((x) => x.uri === wo)) out.delivered!.push(`${f} -/-> ${w.id}`);
    }
  }
  // 3
  for (const f of fbs.values()) {
    const uri = fbRef(f.id);
    const born = created(uri);
    if (born === null) continue;
    const direct = new Set((db.prepare("SELECT to_uri AS t FROM edges WHERE from_uri = ? AND kind = 'caused_by'").all(uri) as { t: string }[]).map((r) => r.t));
    const up = await index.lineage({ ref: uri, direction: 'up', depth: 6 } as never);
    for (const x of up.nodes) {
      if (x.kind !== 'work_order' || direct.has(x.uri)) continue;
      const c = created(x.uri);
      if (c !== null && c > born) out.time!.push(`${f.id} <- ${x.uri} (created later)`);
    }
  }
  // 4
  const commits = db.prepare('SELECT sha, trailers FROM commits').all() as { sha: string; trailers: string }[];
  for (const c of commits) {
    const wosChanged = (db.prepare("SELECT count(DISTINCT to_uri) AS n FROM edges WHERE from_uri = ? AND kind = 'changed' AND to_uri LIKE 'mandate://work-orders/%' AND to_uri NOT LIKE '%/sections/%'").get(`mandate://commits/${c.sha}`) as { n: number }).n;
    if (!isMigrationCommit(JSON.parse(c.trailers || '{}')) && wosChanged <= BULK_WORK_ORDERS) continue;
    const n = (db.prepare("SELECT count(*) AS n FROM edges WHERE kind = 'caused_by' AND props LIKE ? AND (props NOT LIKE '%\"source\":\"annotation\"%')").get(`%"commit":"${c.sha}"%`) as { n: number }).n;
    if (n) out.migration!.push(`${c.sha.slice(0, 7)}: ${n} causes`);
  }
  return out;
}

const empty = { origin: [], delivered: [], time: [], migration: [] };

describe('lineage invariants: seed data', () => {
  let fx: GraphFixture;
  beforeAll(async () => {
    fx = await graphFixture('clone');
  }, 180_000);
  afterAll(async () => {
    fx?.index.close();
    await cleanupTempDirs();
  });
  it('hold on a copy of the seed data', async () => {
    expect(await invariants(fx.index, createStorage(fx.git))).toEqual(empty);
  }, 120_000);
});

describe('lineage invariants: bad states', () => {
  let fx: GraphFixture;
  const git = (...a: string[]) => execFileSync('git', ['-C', fx.dir, ...a], { encoding: 'utf8' }).trim();
  const commit = (files: string[], message: string) => {
    git('add', ...files);
    execFileSync('git', ['-C', fx.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  };
  const edit = (file: string, f: (t: string) => string) => {
    const p = path.join(fx.dir, file);
    const t = readFileSync(p, 'utf8');
    const n = f(t);
    if (n === t) throw new Error(`no change in ${file}`);
    writeFileSync(p, n);
  };
  beforeAll(async () => {
    fx = await graphFixture('clone');
    const wos = execFileSync('ls', [path.join(fx.dir, 'work-orders')], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.md')).slice(0, 5);
    // A migration commit naming a cause.
    edit('specs/login-sso.md', (t) => t.replace(/\n## ([^\n]+)\n/, '\n## $1\n\nMigrated note.\n'));
    commit(['specs/login-sso.md'], 'spec(login-sso): migrate\n\nCaused-By: mandate://feedback/fb-0001\nMandate-Migration: yes');
    // A bulk rewrite of many work orders under one Work-Order trailer (the 748f3e6 shape).
    for (const f of wos) edit(`work-orders/${f}`, (t) => t.replace(/\nupdatedAt: [^\n]+/, '\nupdatedAt: 2030-01-01T00:00:00.000Z').replace(/^(---\ntitle: [^\n]+)/, '$1 (rewritten)'));
    commit(wos.map((f) => `work-orders/${f}`), `work order: migrate ${wos[0]!.replace('.md', '')}\n\nWork-Order: ${wos[0]!.replace('.md', '')}`);
    // A work order whose origin is only its reason.
    edit('work-orders/q-0002.md', (t) => t.replace('\nkind: update\n', '\nkind: update\nreason: [fb-0005]\n'));
    commit(['work-orders/q-0002.md'], 'work order: q-0002 reason');
    // Later work on the section fb-0005 targets, caused by the work order.
    edit('specs/usage-metering.md', (t) => t.replace(/(<!-- @section aggregation -->\n## [^\n]+\n\n)/, '$1Flushes are idempotent across restarts.\n\n'));
    commit(['specs/usage-metering.md'], 'spec(usage-metering): aggregation follow-up\n\nWork-Order: q-0002');
    await fx.index.ensureFresh();
  }, 180_000);
  afterAll(async () => {
    fx?.index.close();
    await cleanupTempDirs();
  });
  it('hold on a fixture modelled on the bad states', async () => {
    expect(await invariants(fx.index, createStorage(fx.git))).toEqual(empty);
  }, 120_000);
});
