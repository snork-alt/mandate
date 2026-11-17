/**
 * Temporal graph over merged history (C5) and history rewrites (C4).
 * Fixture: two clones of the data commit concurrently, B merges A and pushes, A fast-forwards to B's merge.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitStore } from '../src/git/index.js';
import { GraphError } from '../src/index/resolve.js';
import { createStorage } from '../src/storage/index.js';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
beforeAll(async () => {
  fx = await graphFixture('merged');
}, 120_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];
const git = (...args: string[]) => execFileSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8' }).trim();

describe('merged history', () => {
  it('indexes every commit individually, side-branch ones included', async () => {
    const all = git('rev-list', 'HEAD').split('\n');
    const indexed = new Set(rows<{ sha: string }>('SELECT sha FROM commits').map((r) => r.sha));
    expect(all.filter((c) => !indexed.has(c))).toEqual([]);
    const { sideCommits, merge } = fx.merged!;
    expect(git('rev-list', '--parents', '-n', '1', merge).split(' ')).toHaveLength(3); // a real merge
    for (const c of sideCommits) {
      expect(rows<{ mainline: number }>('SELECT mainline FROM commits WHERE sha = ?', c)[0]!.mainline).toBe(0);
    }
    // All parents are recorded.
    expect(rows<{ parent: string }>('SELECT parent FROM commit_parents WHERE sha = ? ORDER BY idx', merge).map((r) => r.parent)).toEqual(
      git('rev-list', '--parents', '-n', '1', merge).split(' ').slice(1),
    );
    // The index never exposes internal sequence numbers.
    const n = await fx.index.graphNode({ uri: `mandate://commits/${merge}` });
    expect(JSON.stringify(n)).not.toMatch(/"seq"/);
  });

  it('captures trailers of side-branch commits (agent, branch, feedback)', async () => {
    const { sideCommits, agentA, feedback } = fx.merged!;
    const first = sideCommits.at(-1)!; // oldest of A's two commits
    const node = await fx.index.graphNode({ uri: `mandate://commits/${first}`, limit: 50 });
    const out = (name: string) => node.neighbors.find((g) => g.direction === 'out' && g.name === name)?.nodes.map((x) => x.uri) ?? [];
    expect(out('authored_by')).toEqual([`mandate://agents/${encodeURIComponent(agentA)}`]);
    expect(out('on_branch')).toEqual(['mandate://branches/spec%2Fdevice-limits']);
    if (feedback) expect(out('resolves')).toEqual([`mandate://requests/${feedback}`]);
    expect(out('changed')).toEqual(expect.arrayContaining(['mandate://specs/user-sessions/sections/device-limits']));
    const byAgent = await fx.index.historySearch({ agent: agentA });
    expect(new Set(byAgent.commits.map((c) => c.sha))).toEqual(new Set(sideCommits));
  });

  it('`at` a side-branch sha is the state reachable at that commit', async () => {
    const { sideCommits, merge } = fx.merged!;
    const [aSecond, aFirst] = sideCommits;
    const sections = async (spec: string, at?: string) =>
      (await fx.index.graphNeighbors({ uri: `mandate://specs/${spec}`, direction: 'out', kinds: ['has_section'], limit: 100, ...(at ? { at } : {}) })).nodes.map((n) => n.uri);
    // A's first commit: its own section, not A's second commit, not B's work.
    expect(await sections('user-sessions', aFirst)).toContain('mandate://specs/user-sessions/sections/device-limits');
    expect(await sections('dark-mode', aFirst)).not.toContain('mandate://specs/dark-mode/sections/high-contrast');
    expect(await sections('rate-limiting', aFirst)).not.toContain('mandate://specs/rate-limiting/sections/burst-credits');
    expect(await sections('dark-mode', aSecond)).toContain('mandate://specs/dark-mode/sections/high-contrast');
    // The merge has both clones' work.
    expect(await sections('rate-limiting', merge)).toContain('mandate://specs/rate-limiting/sections/burst-credits');
    expect(await sections('user-sessions', merge)).toContain('mandate://specs/user-sessions/sections/device-limits');
    // The versioned reference resolves to that state too, and node(at) on the side branch works.
    const v = await fx.index.resolveRef({ ref: `mandate://specs/user-sessions@${aFirst!.slice(0, 7)}/sections/device-limits` });
    expect(v.node.kind).toBe('version');
    expect(v.at?.sha).toBe(aFirst);
    const before = await fx.index.graphNode({ uri: 'mandate://specs/user-sessions/sections/device-limits', at: aFirst! });
    expect(before.at?.sha).toBe(aFirst);
    // Cypher sees the same state.
    const cy = await fx.index.graphQuery({ query: "MATCH (d:Spec {ref: 'mandate://specs/rate-limiting'})-[:HAS_SECTION]->(s) RETURN s.ref", at: aFirst! });
    expect(cy.rows.map((r) => r[0])).not.toContain('mandate://specs/rate-limiting/sections/burst-credits');
  });

  it('history lists side-branch changes once (the merge does not repeat them), and changes() spans branches', async () => {
    const { sideCommits, merge } = fx.merged!;
    const h = await fx.index.graphHistory({ uri: 'mandate://specs/user-sessions/sections/device-limits' });
    expect(h.events.map((e) => e.commit.sha)).toEqual([sideCommits.at(-1)]);
    const c = await fx.index.graphChanges({ from: sideCommits.at(-1)!, to: merge });
    const added = c.nodesAdded.map((n) => n.uri);
    expect(added).toContain('mandate://specs/dark-mode/sections/high-contrast');
    expect(added).toContain('mandate://specs/rate-limiting/sections/burst-credits');
    expect(added).not.toContain('mandate://specs/user-sessions/sections/device-limits');
    expect(c.content.map((x) => x.uri)).toEqual(expect.arrayContaining(['mandate://specs/dark-mode/sections/high-contrast', 'mandate://specs/rate-limiting/sections/burst-credits']));
  });

  it('Cypher isAncestor follows all parents', async () => {
    const { sideCommits, merge } = fx.merged!;
    const r = await fx.index.graphQuery({
      query: 'MATCH (a:Commit {ref: $a}), (m:Commit {ref: $m}) RETURN isAncestor(a, m), isAncestor(m, a)',
      params: { a: `mandate://commits/${sideCommits[0]}`, m: `mandate://commits/${merge}` },
    });
    expect(r.rows).toEqual([[true, false]]);
  });
});

describe('history rewrite (C4)', () => {
  it('detects a rewrite, rebuilds (reusing vectors), records it and reports old pins as lost', async () => {
    const { sideCommits, merge } = fx.merged!;
    const before = (await fx.index.status()).embedding.embedded;
    // Rewrite the local branch: drop the merge and A's commits, then commit something else.
    // (Committed with the git CLI: an external rewrite, as a rebase / force-update would be.)
    git('reset', '-q', '--hard', `${merge}^1`);
    git('-c', 'user.name=Rewriter', '-c', 'user.email=r@x', 'commit', '-q', '--allow-empty', '-m', 'rewritten');
    await fx.index.sync();
    await fx.index.idle();
    const st = await fx.index.status();
    expect(st.upToDate).toBe(true);
    expect(st.historyRewrite).toMatchObject({ oldHead: merge, newHead: st.headCommit });
    expect(st.historyRewrite!.lostCommits).toBeGreaterThanOrEqual(3);
    expect(st.embedding.embedded).toBeGreaterThan(0);
    expect(st.embedding.pending).toBe(0);
    void before;
    for (const ref of [`mandate://commits/${merge}`, `mandate://specs/user-sessions@${sideCommits[0]!.slice(0, 7)}`, `mandate://commits/${sideCommits[1]}`]) {
      let err: unknown;
      try {
        await fx.index.resolveRef({ ref });
      } catch (e) {
        err = e;
      }
      expect(err, ref).toBeInstanceOf(GraphError);
      expect((err as GraphError).code).toBe('pin_lost');
      expect((err as GraphError).hint).toMatch(/history was rewritten/);
    }
    // Lost pins inside the data are listed (if the data pins any of the dropped commits).
    expect(Array.isArray(st.historyRewrite!.lostPins)).toBe(true);
    // The graph at HEAD no longer has the dropped work.
    const secs = await fx.index.graphNeighbors({ uri: 'mandate://specs/user-sessions', direction: 'out', kinds: ['has_section'], limit: 100 });
    expect(secs.nodes.map((n) => n.uri)).not.toContain('mandate://specs/user-sessions/sections/device-limits');
  }, 60_000);
});

describe('the git layer never force-pushes', () => {
  it.each(['embedded', 'cli'] as const)('%s backend: a diverged push is refused and the remote is unchanged', async (backend) => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const mk = async (name: string) => {
      const g = createGitStore({ dataDir: path.join(root, name), branch: 'main', remote: { url: remote, branch: 'main' }, author: { name: 'T', email: 't@x' }, git: { backend } });
      await g.openOrCreate();
      return g;
    };
    const a = await mk('a');
    const sa = createStorage(a);
    await sa.specs.create({ title: 'One', sections: [] } as never);
    await a.push();
    const b = await mk('b');
    const sb = createStorage(b);
    await sb.specs.create({ title: 'From B', sections: [] } as never);
    await b.push();
    const remoteHead = execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    // A diverged (did not pull): its push must be rejected, never forced.
    await sa.specs.create({ title: 'From A', sections: [] } as never);
    await expect(a.push()).rejects.toThrow();
    expect(execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead);
  }, 60_000);
});
