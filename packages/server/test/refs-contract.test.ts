/**
 * Contract: every reference is a graph key.
 * Forward: every node in the index resolves from its own `ref`, which is canonical.
 * Reverse: every reference form the UI builders produce resolves to a node of the expected kind.
 */
import { sectionLineRange } from '@mandate/doc';
import {
  EDGE_KINDS,
  NODE_KINDS,
  REF_BUILDERS,
  REF_KINDS,
  canonicalRef,
  parseRef,
  refBuilders,
  type MandateRef,
} from '@mandate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { GraphError } from '../src/index/resolve.js';
import { cleanupTempDirs } from './helpers.js';
import { graphFixture, type GraphFixture } from './graph-fixture.js';

let fx: GraphFixture;
beforeAll(async () => {
  fx = await graphFixture();
}, 120_000);
afterAll(async () => {
  fx?.index.close();
  await cleanupTempDirs();
});

const kindsSeen = new Set<string>();
const buildersUsed = new Set<string>();
const counts = { nodes: 0, references: 0 };

/** Wrap every exported builder so coverage can be asserted. */
const B = Object.fromEntries(
  Object.entries({ ...REF_BUILDERS, ...Object.fromEntries(Object.entries(refBuilders).map(([k, f]) => [`refBuilders.${k}`, f])) }).map(([name, fn]) => [
    name,
    (...args: unknown[]) => {
      buildersUsed.add(name);
      return (fn as (...a: unknown[]) => string)(...args);
    },
  ]),
) as Record<string, (...args: never[]) => string>;
const build = (name: string, ...args: unknown[]) => (B[name] as (...a: unknown[]) => string)(...args);

async function expectNode(ref: string, kind: string | string[], at?: string) {
  const r = await fx.index.resolveRef({ ref, ...(at !== undefined ? { at } : {}) });
  counts.references++;
  kindsSeen.add(r.node.kind);
  expect([kind].flat(), ref).toContain(r.node.kind);
  expect(r.node.ref).toBe(canonicalRef(r.node.ref));
  return r;
}

const rows = <T>(sql: string, ...p: unknown[]) => fx.index.db.prepare(sql).all(...p) as T[];

describe('forward: every indexed node resolves from its ref', () => {
  it('resolveRef(node.ref) returns that node, and node.ref is canonical', async () => {
    const nodes = rows<{ uri: string; kind: string }>('SELECT DISTINCT uri, kind FROM nodes ORDER BY uri');
    expect(nodes.length).toBeGreaterThan(300);
    for (const n of nodes) {
      expect(canonicalRef(n.uri), n.uri).toBe(n.uri);
      const r = await fx.index.resolveRef({ ref: n.uri });
      expect(r.node.uri, n.uri).toBe(n.uri);
      expect(r.node.kind).toBe(n.kind);
      expect(r.node.ref).toBe(n.uri);
      kindsSeen.add(n.kind);
      counts.nodes++;
    }
  }, 60_000);
});

describe('reverse: every UI reference form resolves', () => {
  const docs = () =>
    rows<{ uri: string; kind: string }>("SELECT DISTINCT uri, kind FROM nodes WHERE kind IN ('spec', 'standard', 'component', 'section', 'work_order', 'feedback', 'audit')");
  const versionsOf = (live: string) =>
    rows<{ uri: string; sha: string; seq: number; action: string }>(
      `SELECT v.uri, v.sha, v.point AS seq, json_extract(n.props, '$.action') AS action
         FROM versions v JOIN nodes n ON n.uri = v.uri WHERE v.of_uri = ? ORDER BY abs(v.point)`,
      live,
    );

  it('docs, sections, work orders and feedback: plain, prefixed and versioned (full + short sha)', async () => {
    for (const d of docs()) {
      const m = parseRef(d.uri)!;
      const builder = `refBuilders.${m.kind}`;
      const { kind: _k, ...rest } = m;
      const plain = build(builder, rest);
      expect(plain).toBe(d.uri);
      await expectNode(plain, d.kind);
      await expectNode(build('refMention', m), d.kind);
      await expectNode(build('buildRef', m), d.kind);
      if (m.kind !== 'specs' && m.kind !== 'standards' && m.kind !== 'components' && m.kind !== 'audits' && m.kind !== 'work-orders') continue;
      for (const v of versionsOf(d.uri)) {
        for (const sha of [v.sha, v.sha.slice(0, 7)]) {
          const r = await expectNode(build(builder, { ...rest, commit: sha }), 'version');
          expect(r.node.uri).toBe(v.uri);
          expect(r.at?.sha).toBe(v.sha);
          const prefixed = await expectNode(build('refMention', { ...m, commit: sha }), 'version');
          expect(prefixed.node.uri).toBe(v.uri);
        }
      }
    }
  }, 120_000);

  it('excerpts: whole section, single line and a sub-range of a code block, at HEAD and an old version', async () => {
    const sections = rows<{ uri: string }>("SELECT uri FROM sections WHERE uri LIKE 'mandate://%/sections/%'");
    expect(sections.length).toBeGreaterThan(30);
    for (const { uri } of sections) {
      const m = parseRef(uri)! as MandateRef & { sectionId: string };
      const path = `${m.kind}/${m.id}.md`;
      const vers = versionsOf(uri).filter((v) => v.action !== 'deleted');
      const points: (string | null)[] = [null, vers[0]?.sha ?? null].filter((x, i) => i === 0 || x !== null);
      for (const sha of points) {
        const text = sha ? await fx.git.readFileAt(sha, path) : (await fx.git.readFileAt((await fx.git.head())!, path));
        if (!text) continue;
        const range = sectionLineRange(text, m.sectionId);
        if (!range) continue;
        const lines = text.split('\n');
        const fence = lines.findIndex((l, i) => i >= range.start - 1 && i < range.end && /^```/.test(l));
        const forms = [
          { start: range.start, end: range.end },
          { start: range.start + 1, end: range.start + 1 },
          ...(fence >= 0 && fence + 3 < range.end ? [{ start: fence + 2, end: fence + 3 }] : []),
        ];
        for (const l of forms) {
          const ref = build('buildRef', { ...m, ...(sha ? { commit: sha.slice(0, 7) } : {}), lines: l });
          const r = await expectNode(ref, 'excerpt');
          expect((r.node.props.sections as string[])).toContain(m.sectionId);
          const doc = build('buildRef', { kind: m.kind, id: m.id, ...(sha ? { commit: sha } : {}), lines: l });
          const rd = await expectNode(doc, 'excerpt');
          expect((rd.node.props.sections as string[])).toContain(m.sectionId);
        }
      }
    }
  }, 120_000);

  it('verifications, symbols, code files and ranges, commits, agents, repos and branches', async () => {
    const byKind = (k: string) => rows<{ uri: string; props: string }>('SELECT DISTINCT uri, props FROM nodes WHERE kind = ?', k);
    for (const n of byKind('verification')) await expectNode(n.uri, 'verification');
    // Audit findings: built, prefixed and canonical forms.
    const findings = byKind('finding');
    expect(findings.length).toBeGreaterThan(0);
    for (const n of findings) {
      const [, audit, id] = /^mandate:\/\/audits\/([^/]+)\/findings\/([^/]+)$/.exec(n.uri)!;
      const r = await expectNode(build('refBuilders.findings', { audit, id }), 'finding');
      expect(r.node.uri).toBe(n.uri);
      await expectNode(`@mandate:${n.uri}`, 'finding');
      await expectNode(build('buildNodeUri', { kind: 'findings', audit, id }), 'finding');
    }
    // Comments, pull requests and code commits (work-order delivery): built, prefixed and canonical forms.
    const comments = byKind('comment');
    expect(comments.length).toBeGreaterThan(0);
    for (const n of comments) {
      const id = n.uri.split('/').pop()!;
      expect((await expectNode(build('refBuilders.comments', id), 'comment')).node.uri).toBe(n.uri);
      await expectNode(`@mandate:${n.uri}`, 'comment');
      await expectNode(build('buildNodeUri', { kind: 'comments', id }), 'comment');
    }
    // Questions (question_ask): built, prefixed and canonical forms.
    const questions = byKind('question');
    expect(questions.length).toBeGreaterThan(0);
    for (const n of questions) {
      const id = n.uri.split('/').pop()!;
      expect((await expectNode(build('refBuilders.questions', id), 'question')).node.uri).toBe(n.uri);
      await expectNode(`@mandate:${n.uri}`, 'question');
      await expectNode(build('buildNodeUri', { kind: 'questions', id }), 'question');
    }
    const prs = byKind('pull_request');
    expect(prs.length).toBeGreaterThan(0);
    for (const n of prs) {
      const p = JSON.parse(n.props) as { repo: string; number: number };
      expect((await expectNode(build('refBuilders.prs', { repo: p.repo, number: p.number }), 'pull_request')).node.uri).toBe(n.uri);
      await expectNode(build('buildNodeUri', { kind: 'prs', repo: p.repo, number: p.number }), 'pull_request');
    }
    const codeCommits = byKind('code_commit');
    expect(codeCommits.length).toBeGreaterThan(0);
    for (const n of codeCommits) {
      const p = JSON.parse(n.props) as { repo: string; sha: string };
      expect((await expectNode(build('refBuilders.code-commits', { repo: p.repo, sha: p.sha }), 'code_commit')).node.uri).toBe(n.uri);
      await expectNode(build('buildNodeUri', { kind: 'code-commits', repo: p.repo, sha: p.sha }), 'code_commit');
    }
    for (const n of byKind('symbol')) {
      const name = JSON.parse(n.props).normalized ? decodeURIComponent(n.uri.split('/symbols/')[1]!) : '';
      const r = await expectNode(build('refBuilders.symbols', name), 'symbol');
      expect(r.node.uri).toBe(n.uri);
      await expectNode(build('buildNodeUri', { kind: 'symbols', name }), 'symbol');
    }
    for (const n of rows<{ repo: string; path: string; line_start: number | null; line_end: number | null; commit_sha: string | null }>('SELECT * FROM code_refs')) {
      const lines = n.line_start ? `${n.line_start}-${n.line_end ?? n.line_start}` : undefined;
      await expectNode(build('refBuilders.code', { repo: n.repo, path: n.path }), 'code_file');
      if (lines) {
        await expectNode(build('refBuilders.code', { repo: n.repo, path: n.path, lines }), 'code_range');
        await expectNode(build('refBuilders.code', { repo: n.repo, path: n.path, lines, commit: n.commit_sha ?? 'abc1234' }), 'code_range');
        // Any sub-range overlaps and resolves.
        await expectNode(build('refBuilders.code', { repo: n.repo, path: n.path, lines: `${n.line_start}` }), 'code_range');
      }
    }
    for (const c of rows<{ sha: string }>('SELECT sha FROM commits')) {
      const full = await expectNode(build('refBuilders.commits', c.sha), 'commit');
      const short = await expectNode(build('refBuilders.commits', c.sha.slice(0, 7)), 'commit');
      expect(short.node.uri).toBe(full.node.uri);
    }
    for (const k of ['agent', 'user', 'repo', 'branch'] as const) {
      for (const n of byKind(k)) {
        const r = await expectNode(n.uri, k);
        expect(build('canonicalRef', n.uri)).toBe(r.node.uri);
      }
    }
    // G-9 / P6: agent and user ids are case-folded; an old mixed-case reference resolves to the same node.
    const users = byKind('user');
    expect(users.length).toBeGreaterThan(0);
    for (const n of users) {
      const login = decodeURIComponent(n.uri.split('/users/')[1]!);
      expect((await expectNode(build('refBuilders.users', login.toUpperCase()), 'user')).node.uri).toBe(n.uri);
      await expectNode(build('buildNodeUri', { kind: 'users', login }), 'user');
    }
    for (const n of byKind('agent')) {
      expect(n.uri).toBe(n.uri.toLowerCase());
      const name = decodeURIComponent(n.uri.split('/agents/')[1]!);
      expect((await expectNode(`mandate://agents/${encodeURIComponent(name.toUpperCase())}`, 'agent')).node.uri).toBe(n.uri);
    }
  }, 120_000);

  it('work orders: the old mandate://queue/<id> form is an alias, and the file rename keeps history continuous', async () => {
    const wos = rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE kind = 'work_order'");
    expect(wos.length).toBeGreaterThan(0);
    for (const { uri } of wos) {
      const id = uri.split('/').pop()!;
      const r = await expectNode(`mandate://queue/${id}`, 'work_order');
      expect(r.node.uri).toBe(`mandate://work-orders/${id}`);
      await expectNode(`@mandate:mandate://queue/${id}`, 'work_order');
    }
    // The commit that renamed queue.jsonl -> work-orders.jsonl changed nothing in the graph.
    const rename = rows<{ seq: number }>("SELECT seq FROM commits WHERE subject LIKE 'work-orders: rename%'")[0];
    if (rename) {
      const closed = rows<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'work_order' AND valid_to = ?", rename.seq)[0]!.n;
      expect(closed).toBe(0);
      expect(rows<{ n: number }>("SELECT COUNT(*) AS n FROM edges WHERE kind = 'changed' AND from_uri = (SELECT 'mandate://commits/' || sha FROM commits WHERE seq = ? AND mainline = 1)", rename.seq)[0]!.n).toBe(0);
    }
  });

  it('work orders became documents: the migration commit keeps every work order node continuous', async () => {
    const mig = rows<{ seq: number }>("SELECT seq FROM commits WHERE subject LIKE 'work-orders: migrate%' AND mainline = 1")[0];
    if (!mig) return;
    const closed = rows<{ uri: string }>("SELECT uri FROM nodes WHERE kind = 'work_order' AND valid_to = ?", mig.seq).map((r) => r.uri);
    const opened = new Set(rows<{ uri: string }>("SELECT uri FROM nodes WHERE kind = 'work_order' AND valid_from = ?", mig.seq).map((r) => r.uri));
    expect(closed.filter((u) => !opened.has(u))).toEqual([]);
    // Work-order sections are graph keys (and versioned after the migration).
    const secs = rows<{ uri: string }>("SELECT uri FROM sections WHERE uri LIKE 'mandate://work-orders/%/sections/%'");
    expect(secs.length).toBeGreaterThan(0);
    await expectNode(secs[0]!.uri, 'section');
  });

  it('architecture: HEAD, pinned commit (full + short) and focus resolve to the virtual view node', async () => {
    const comps = rows<{ uri: string }>("SELECT DISTINCT uri FROM nodes WHERE kind = 'component'");
    expect(comps.length).toBeGreaterThan(0);
    const head = await expectNode(build('refBuilders.architecture', {}), 'architecture');
    expect(head.node.uri).toBe('mandate://architecture');
    const sha = rows<{ sha: string }>('SELECT sha FROM commits WHERE mainline = 1 ORDER BY seq DESC LIMIT 1')[0]!.sha;
    for (const c of [sha, sha.slice(0, 7)]) {
      const r = await expectNode(build('refBuilders.architecture', { commit: c }), 'architecture');
      expect(r.at?.sha).toBe(sha);
    }
    const focus = comps[0]!.uri.split('/').pop()!;
    const f = await expectNode(build('refBuilders.architecture', { focus }), 'architecture');
    expect(f.node.props.focus).toBe(focus);
    await expectNode(build('canonicalRef', head.node.uri), 'architecture');
  });

  it('the deleted spec resolves at old versions and as deleted at HEAD', async () => {
    const live = 'mandate://specs/legacy-xml-export';
    const vers = versionsOf(live);
    expect(vers.at(-1)!.action).toBe('deleted');
    const old = await expectNode(build('refBuilders.specs', { id: 'legacy-xml-export', commit: vers[0]!.sha.slice(0, 7) }), 'version');
    expect(old.node.props.of).toBe(live);
    const node = await fx.index.graphNode({ uri: live });
    expect(node.node.deletedAt?.sha).toBe(vers.at(-1)!.sha);
  });

  it('the kind registries are closed: every stored node and edge kind is registered', () => {
    const nodeKinds = rows<{ kind: string }>('SELECT DISTINCT kind FROM nodes').map((r) => r.kind);
    const edgeKinds = rows<{ kind: string }>('SELECT DISTINCT kind FROM edges').map((r) => r.kind);
    expect(nodeKinds.filter((k) => !(NODE_KINDS as readonly string[]).includes(k))).toEqual([]);
    expect(edgeKinds.filter((k) => !(EDGE_KINDS as readonly string[]).includes(k))).toEqual([]);
  });

  it('covers every node kind and every builder', () => {
    expect([...NODE_KINDS].filter((k) => !kindsSeen.has(k))).toEqual([]);
    expect([...REF_KINDS].filter((k) => !buildersUsed.has(`refBuilders.${k}`))).toEqual([]);
    expect(Object.keys(B).filter((k) => !buildersUsed.has(k))).toEqual([]);
    console.info(`refs contract: ${counts.nodes} nodes checked, ${counts.references} references checked, ${kindsSeen.size} kinds`);
  });
});

describe('negative cases give structured errors', () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof GraphError) return e.code;
      if (e instanceof ZodError) return 'validation';
      throw e;
    }
    return 'ok';
  };

  it('bad sha, missing section, malformed uri, conflicting @sha vs at', async () => {
    expect(await code(fx.index.resolveRef({ ref: 'mandate://specs/login-sso@deadbee' }))).toBe('unknown_commit');
    expect(await code(fx.index.resolveRef({ ref: 'mandate://specs/login-sso/sections/nope' }))).toBe('unknown_node');
    expect(await code(fx.index.resolveRef({ ref: 'mandate://specs/Login SSO' }))).toBe('validation');
    expect(await code(fx.index.resolveRef({ ref: 'mandate://specs/nope-nope' }))).toBe('unknown_node');
    const vers = rows<{ sha: string; seq: number }>(
      "SELECT sha, point AS seq FROM versions WHERE of_uri = 'mandate://specs/login-sso' ORDER BY abs(point)",
    );
    const [first, second] = vers;
    expect(await code(fx.index.resolveRef({ ref: `mandate://specs/login-sso@${first!.sha.slice(0, 7)}`, at: second!.sha }))).toBe('conflicting_versions');
    expect(await code(fx.index.resolveRef({ ref: `mandate://specs/login-sso@${first!.sha.slice(0, 7)}`, at: first!.sha }))).toBe('ok');
    // A section added later is not present at the first version: error with the nearest version as hint.
    const later = rows<{ uri: string }>(
      "SELECT DISTINCT to_uri AS uri FROM edges WHERE kind = 'has_section' AND from_uri = 'mandate://specs/login-sso' AND valid_from > ?",
      Math.abs(first!.seq),
    )[0]!;
    const sid = later.uri.split('/sections/')[1]!;
    let err: GraphError | undefined;
    try {
      await fx.index.resolveRef({ ref: `mandate://specs/login-sso@${first!.sha}/sections/${sid}` });
    } catch (e) {
      err = e as GraphError;
    }
    expect(err?.code).toBe('not_present_at_version');
    expect(err?.hint).toMatch(/nearest version where it exists: [0-9a-f]{7}/);
    expect(await code(fx.index.resolveRef({ ref: 'mandate://specs/login-sso#L99999' }))).toBe('lines_out_of_range');
  });
});
