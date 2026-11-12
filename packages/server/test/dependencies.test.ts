import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DependencyTree, StoredSpec, WorkOrder } from '@mandate/shared';
import { computeDependencyTree } from '../src/storage/dependencies.js';
import { createStorage, type Storage } from '../src/storage/index.js';
import type { GitStore } from '../src/git/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

const S = (id: string, sid: string) => `mandate://specs/${id}/sections/${sid}`;
const node = (t: DependencyTree, key: string) => t.nodes.find((n) => n.key === key);
const keys = (t: DependencyTree) => t.nodes.map((n) => n.key);

describe('work-order dependency graph on seeded data', () => {
  let git: GitStore;
  let storage: Storage;
  const tree = async (id: string, opts: { at?: string; depth?: number } = {}) => (await storage.workOrderService.resolve(id, opts)).dependencies!;

  beforeAll(async () => {
    const root = await tempDir();
    const dir = path.join(root, 'repo');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, MANDATE_HOME: path.join(root, 'home'), MANDATE_DATA_DIR: dir, INIT_CWD: root },
      stdio: 'pipe',
    });
    git = await newStore(dir);
    storage = createStorage(git);
  }, 90_000);
  afterAll(cleanupTempDirs);

  it('follows depends_on transitively upstream (2 levels) and reverse downstream, with soft edges', async () => {
    const t = await tree('q-0004'); // stripe-checkout: checkout-flow, webhooks
    expect(t.root).toBe('mandate://work-orders/q-0004');
    expect(node(t, S('plans-and-pricing', 'tiers'))).toMatchObject({ side: 'upstream', depth: 1, state: 'implemented' });
    expect(node(t, S('usage-metering', 'aggregation'))).toMatchObject({ side: 'upstream', depth: 2 });
    expect(t.edges).toContainEqual(expect.objectContaining({ from: S('plans-and-pricing', 'tiers'), to: t.root, rel: 'depends_on', soft: false, via: 'webhooks' }));
    expect(t.edges).toContainEqual(expect.objectContaining({ from: S('usage-metering', 'aggregation'), to: S('plans-and-pricing', 'tiers'), rel: 'depends_on' }));
    // follows -> a whole standard: a soft (dashed) upstream edge to the standard node.
    expect(t.edges).toContainEqual(expect.objectContaining({ from: 'mandate://standards/api-conventions', to: t.root, rel: 'follows', soft: true }));
    expect(node(t, 'mandate://standards/api-conventions')).toMatchObject({ type: 'spec', docKind: 'standards', state: 'standard' });
    // No spec-level dependsOn nodes any more (spec dependencies are derived from section links).
    expect(node(t, 'mandate://specs/plans-and-pricing')).toBeUndefined();
    // Downstream: invoice-emails/template depends on webhooks; it has its own (seeded) work order and is blocked.
    const down = node(t, S('invoice-emails', 'template'))!;
    expect(down).toMatchObject({ side: 'downstream', depth: 1, blocked: true });
    expect(down.workOrders).toEqual([expect.objectContaining({ kind: 'implement', status: 'pending' })]);
    expect(down.workOrders[0]!.id).toMatch(/^q-\d{4}$/);
    expect(t.summary.dependentWorkOrders).toBe(1);
    expect(t.summary.blockedBySections).toBe(0);
  });

  it('flags unfinished upstream as blockers (the seeded blocked sections)', async () => {
    const t = await tree('q-0005'); // mfa-totp login-flow depends on login-sso callback (not implemented)
    expect(node(t, S('login-sso', 'callback'))).toMatchObject({ blocker: true, state: 'not_implemented' });
    expect(node(t, S('login-sso', 'callback'))!.workOrders.map((w) => w.id)).toContain('q-0001');
    expect(node(t, S('user-sessions', 'storage'))).toMatchObject({ depth: 2, state: 'implemented' });
    expect(node(t, S('user-sessions', 'storage'))!.blocker).toBeUndefined();
    expect(t.summary).toMatchObject({ blockedBySections: 1, blockedBySpecs: 1 });
    expect(t.nodes[0]).toMatchObject({ type: 'work_order', side: 'center', blocked: true });
  });

  it('dedups nodes and respects the depth limit', async () => {
    const t = await tree('q-0004');
    expect(new Set(keys(t)).size).toBe(t.nodes.length);
    const shallow = await tree('q-0004', { depth: 1 });
    expect(node(shallow, S('usage-metering', 'aggregation'))).toBeUndefined();
    expect(node(shallow, S('plans-and-pricing', 'tiers'))!.truncated).toBe(true);
  });

  it('computes the graph at an old commit', async () => {
    const log = await git.log(500);
    const i = log.findIndex((c) => c.message.startsWith('spec(plans-and-pricing): link related sections'));
    expect(i).toBeGreaterThan(-1);
    const before = log[i + 1]!.id;
    const t = await tree('q-0004', { at: before.slice(0, 7) });
    expect(t.commit).toBe(before);
    expect(node(t, S('plans-and-pricing', 'tiers'))).toBeDefined();
    expect(node(t, S('usage-metering', 'aggregation'))).toBeUndefined(); // the tiers -> aggregation link came later
    const head = await tree('q-0004');
    expect(head.commit).toBeNull();
    await expect(tree('q-0004', { at: 'ffffffff' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('computeDependencyTree', () => {
  const spec = (id: string, sections: { id: string; dependsOn?: string[] }[], extra: Partial<StoredSpec> = {}): StoredSpec =>
    ({
      id,
      title: id.toUpperCase(),
      status: 'ready',
      dependsOn: [],
      standards: [],
      tags: [],
      sections: sections.map((s) => ({
        id: s.id,
        title: s.id,
        type: 'markdown',
        body: '',
        standards: [],
        refs: [],
        symbols: [],
        verifiedBy: [],
        links: (s.dependsOn ?? []).map((to) => ({ to, rel: 'depends_on' })),
      })),
      ...extra,
    }) as unknown as StoredSpec;
  const order = (id: string, specId: string, sections: string[]): WorkOrder => ({
    id,
    spec: specId,
    specCommit: 'abcd123',
    kind: 'implement',
    status: 'pending',
    reason: [],
    sections: sections.map((s) => ({ id: s, status: 'pending' })),
    createdAt: '',
    updatedAt: '',
  });

  it('is cycle-safe and places every node once', async () => {
    // a.x -> b.y -> c.z -> a.x (a cycle the validator would reject, but stored data can still contain).
    const specs = [spec('a', [{ id: 'x', dependsOn: [S('b', 'y')] }]), spec('b', [{ id: 'y', dependsOn: [S('c', 'z')] }]), spec('c', [{ id: 'z', dependsOn: [S('a', 'x'), S('b', 'y')] }])];
    const wo = order('wo-1', 'a', ['x']);
    const t = await computeDependencyTree(wo, { specs, standards: [], workOrders: [wo] }, { depth: 8 });
    expect(keys(t).sort()).toEqual(['mandate://work-orders/wo-1', S('b', 'y'), S('c', 'z')].sort());
    // Repeated targets add edges, not nodes: c.z is upstream (via b.y) and also depends on the work order.
    expect(node(t, S('c', 'z'))!.side).toBe('upstream');
    expect(t.edges).toContainEqual(expect.objectContaining({ from: t.root, to: S('c', 'z'), rel: 'depends_on' }));
    const ids = new Set(keys(t));
    expect(t.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(new Set(t.edges.map((e) => `${e.from}|${e.to}|${e.rel}|${e.via}`)).size).toBe(t.edges.length);
  });

  it('links between the work order’s own sections are not nodes; a diamond shares its node', async () => {
    const specs = [
      spec('a', [{ id: 'x', dependsOn: [S('a', 'y'), S('b', 'p'), S('b', 'q')] }, { id: 'y' }]),
      spec('b', [{ id: 'p', dependsOn: [S('c', 'r')] }, { id: 'q', dependsOn: [S('c', 'r')] }]),
      spec('c', [{ id: 'r' }]),
    ];
    const wo = order('wo-2', 'a', ['x', 'y']);
    const t = await computeDependencyTree(wo, { specs, standards: [], workOrders: [wo] });
    expect(node(t, S('a', 'y'))).toBeUndefined();
    expect(node(t, S('c', 'r'))).toMatchObject({ depth: 2 });
    expect(t.edges.filter((e) => e.from === S('c', 'r'))).toHaveLength(2);
    expect(t.summary.blockedBySections).toBe(3); // p, q, r: none implemented
  });
});
