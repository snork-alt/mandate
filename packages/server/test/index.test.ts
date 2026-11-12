import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createSpecSchema, createStandardSchema } from '@mandate/shared';
import type { GitStore } from '../src/git/index.js';
import { FakeProvider } from '../src/index/embed/index.js';
import { identifierParts, normalizeSymbol } from '../src/index/identifiers.js';
import { IndexService, watchCommits } from '../src/index/service.js';
import { createStorage, type Storage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

const embedding = {
  provider: 'openai-compatible' as const,
  baseUrl: 'http://localhost:1/v1',
  model: 'fake',
  apiKeyEnv: null,
  dimensions: 64,
  maxInputTokens: 2048,
  batchSize: 16,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};
const indexCfg = (file: string) => ({ path: file, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 });

afterAll(cleanupTempDirs);

describe('identifiers', () => {
  it('splits camelCase, snake_case, dots, :: and paths', () => {
    expect(identifierParts('AuthService.login')).toEqual(['auth', 'service', 'login']);
    expect(identifierParts('session_tokens')).toEqual(['session', 'tokens']);
    expect(identifierParts('Foo::BarBaz::qux')).toEqual(['foo', 'bar', 'baz', 'qux']);
    expect(identifierParts('HTTPServer.listen')).toEqual(['http', 'server', 'listen']);
    expect(identifierParts('GET /v1/audit-events')).toEqual(['get', 'v1', 'audit', 'events']);
    expect(normalizeSymbol('Foo::Bar')).toBe('foo.bar');
  });
});

/* ------------------------------------------------------------------ seeded data */

describe('index on seeded data', () => {
  let dir: string;
  let git: GitStore;
  let storage: Storage;
  let index: IndexService;
  const provider = new FakeProvider(64, 'fake:64');

  beforeAll(async () => {
    // A clone of data/repo (the seed script follows the data model; the index tests read whatever data is there).
    const root = await tempDir();
    dir = path.join(root, 'repo');
    execFileSync('git', ['clone', '-q', path.resolve(__dirname, '../../../data/repo'), dir]);
    git = await newStore(dir);
    storage = createStorage(git);
    index = new IndexService({ git, storage, index: indexCfg(path.join(root, 'index.sqlite')), embedding, provider });
    await index.start();
    await index.idle();
  }, 60_000);
  afterAll(() => index.close());

  it('indexes history, docs, chunks and vectors', async () => {
    const s = await index.status();
    expect(s.upToDate).toBe(true);
    expect(s.commits).toBeGreaterThan(100);
    expect(s.docs).toBeGreaterThan(15);
    expect(s.sections).toBeGreaterThan(30);
    expect(s.embedding.pending).toBe(0);
    // `embedded` counts distinct chunk texts (identical texts share one embedding), so it can be < chunks.
    expect(s.embedding.embedded).toBeGreaterThan(0);
    expect(s.embedding.embedded).toBeLessThanOrEqual(s.chunks);
    expect(s.embedding.modelId).toBe('fake:64');
  });

  it('hybrid search finds refresh token rotation with line-anchored URIs and highlights', async () => {
    const r = await index.search({ q: 'refresh token rotation' });
    expect(r.semantic.used).toBe(true);
    const top = r.groups.slice(0, 3).map((g) => g.docUri);
    expect(top).toContain('mandate://specs/user-sessions');
    const hit = r.groups.flatMap((g) => g.hits).find((h) => h.uri.startsWith('mandate://specs/user-sessions/sections/overview'))!;
    expect(hit.uri).toMatch(/#L\d+(-L\d+)?$/);
    expect(hit.snippet).toContain('<mark>');
    expect(hit.matchedBy).toEqual(expect.arrayContaining(['text', 'semantic']));
    // The URI's lines contain the section text.
    const src = readFileSync(path.join(dir, 'specs/user-sessions.md'), 'utf8').split('\n');
    expect(src.slice(hit.lines!.start - 1, hit.lines!.end).join('\n')).toContain('refresh token');
    expect(r.facets.kinds.section).toBeGreaterThan(0);
  });

  it('boosts exact symbol hits and applies filters before ranking', async () => {
    const r = await index.search({ q: 'AuthService.login', mode: 'text' });
    expect(r.groups[0]!.hits[0]!.uri).toMatch(/^mandate:\/\/specs\/login-sso\/sections\/auth-flow/);
    expect(r.groups[0]!.hits[0]!.matchedBy).toContain('symbol');
    const stds = await index.search({ q: 'tokens', kinds: ['standard'] });
    expect(stds.groups.length).toBeGreaterThan(0);
    expect(stds.groups.every((g) => g.docKind === 'standard')).toBe(true);
    const within = await index.search({ q: 'token', within: 'mandate://specs/login-sso' });
    expect(within.groups.map((g) => g.docUri)).toEqual(['mandate://specs/login-sso']);
    const page1 = await index.search({ q: 'and', mode: 'text', limit: 2 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await index.search({ q: 'and', mode: 'text', limit: 2, cursor: page1.nextCursor! });
    expect(page2.groups[0]!.docUri).not.toBe(page1.groups[0]!.docUri);
  });

  it('semantic mode works without keyword overlap (fake model) and text mode skips vectors', async () => {
    const sem = await index.search({ q: 'session refresh rotate', mode: 'semantic' });
    expect(sem.groups.flatMap((g) => g.hits).every((h) => h.matchedBy.join() === 'semantic')).toBe(true);
    const text = await index.search({ q: 'refresh', mode: 'text' });
    expect(text.semantic.used).toBe(false);
  });

  it('text search: literal phrases and regexes with file line numbers', async () => {
    const r = await index.textSearch({ q: 'refresh token' });
    expect(r.total).toBeGreaterThan(0);
    for (const m of r.matches) {
      const file = m.docUri.replace('mandate://', '') + (m.kind === 'work_order' || m.kind === 'feedback' ? '' : '.md');
      if (file.startsWith('specs/') || file.startsWith('standards/')) {
        const line = readFileSync(path.join(dir, file), 'utf8').split('\n')[m.line - 1]!;
        expect(line.toLowerCase()).toContain('refresh token');
      }
      expect(m.text).toMatch(/<mark>refresh token<\/mark>/i);
    }
    const re = await index.textSearch({ q: 'AuthService\\.\\w+', regex: true });
    expect(re.matches.some((m) => m.text.includes('<mark>AuthService.login</mark>'))).toBe(true);
    const cs = await index.textSearch({ q: 'authservice.login', caseSensitive: true });
    expect(cs.total).toBe(0);
    await expect(index.textSearch({ q: '([', regex: true })).rejects.toBeInstanceOf(ZodError);
  });

  it('symbol search: exact, identifier part, prefix and fuzzy', async () => {
    const exact = await index.symbolSearch({ name: 'AuthService.login' });
    expect(exact.symbols[0]).toMatchObject({ name: 'AuthService.login', match: 'exact', uri: 'mandate://symbols/AuthService.login' });
    expect(exact.symbols[0]!.usedIn[0]!.sectionUri).toBe('mandate://specs/login-sso/sections/auth-flow');
    const part = await index.symbolSearch({ name: 'login' });
    expect(part.symbols.map((s) => [s.name, s.match])).toContainEqual(['AuthService.login', 'part']);
    const prefix = await index.symbolSearch({ name: 'SessionSt', match: 'prefix' });
    expect(prefix.symbols.map((s) => s.name)).toContain('SessionStore.create');
    const fuzzy = await index.symbolSearch({ name: 'AuthServce.lgin', match: 'fuzzy' });
    expect(fuzzy.symbols[0]!.name).toBe('AuthService.login');
  });

  it('code search by directory, glob and overlapping line range', async () => {
    const byDir = await index.codeSearch({ repo: 'app', path: 'src/auth' });
    expect(byDir.refs.map((r) => r.path)).toEqual(expect.arrayContaining(['src/auth/oidc.ts', 'src/auth/session.ts']));
    const overlap = await index.codeSearch({ path: 'src/auth/session.ts', lines: '30-35' });
    // Live data (cloned): other sections may also cover the range (user-sessions/storage refs the whole file).
    expect(overlap.refs.filter((r) => r.sectionUri.startsWith('mandate://specs/login-sso/'))).toHaveLength(1);
    expect(overlap.refs.find((r) => r.sectionUri.startsWith('mandate://specs/login-sso/'))).toMatchObject({ sectionUri: 'mandate://specs/login-sso/sections/callback', lines: { start: 22, end: 41 } });
    expect((await index.codeSearch({ path: 'src/auth/session.ts', lines: '50-60' })).refs.filter((r) => r.sectionUri.startsWith('mandate://specs/login-sso/'))).toHaveLength(0);
    const glob = await index.codeSearch({ glob: 'src/**/*.ts' });
    expect(glob.refs.length).toBeGreaterThanOrEqual(byDir.refs.length);
  });

  it('related returns nearest neighbours excluding itself, and similar_to edges exist', async () => {
    const r = await index.related({ uri: 'mandate://specs/user-sessions/sections/overview', limit: 5 });
    expect(r.items.length).toBe(5);
    expect(r.items.map((i) => i.uri)).not.toContain('mandate://specs/user-sessions/sections/overview');
    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1]!.score).toBeGreaterThanOrEqual(r.items[i]!.score);
  });

  it('metadata query with derived fields', async () => {
    const status = (index.db.prepare("SELECT status FROM docs WHERE kind = 'spec' GROUP BY status ORDER BY COUNT(*) DESC LIMIT 1").get() as { status: string }).status;
    const r = await index.metadataQuery({ kinds: ['spec'], status: [status] });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.kind === 'spec' && i.status === status)).toBe(true);
    const fb = await index.metadataQuery({ minOpenFeedback: 1 });
    expect(fb.items.every((i) => i.openFeedback >= 1)).toBe(true);
    expect(fb.items.length).toBeGreaterThan(0);
    const all = await index.metadataQuery({ kinds: ['spec'], limit: 200 });
    expect(all.items.every((i) => Array.isArray(i.outdatedSections))).toBe(true);
  });

  it('history search by uri, text, agent and change kind', async () => {
    const byUri = await index.historySearch({ uri: 'mandate://specs/login-sso' });
    expect(byUri.total).toBeGreaterThan(2);
    expect(byUri.commits.every((c) => c.uris.some((u) => u.startsWith('mandate://specs/login-sso')))).toBe(true);
    const status = await index.historySearch({ uri: 'mandate://specs/login-sso', changeKinds: ['status'] });
    expect(status.commits.every((c) => c.changeKinds.includes('status'))).toBe(true);
    const agentCommit = byUri.commits.find((c) => c.agent);
    if (agentCommit) {
      const byAgent = await index.historySearch({ agent: agentCommit.agent! });
      expect(byAgent.commits.every((c) => c.agent === agentCommit.agent)).toBe(true);
    }
    const text = await index.historySearch({ q: 'archive' });
    expect(text.commits.some((c) => /archive/i.test(c.subject))).toBe(true);
  });

  /* -------------------------------------------------------------- graph */

  it('path from a symbol to a standard', async () => {
    const r = await index.graphPath({ from: 'mandate://symbols/SessionStore.create', to: 'mandate://standards/security-baseline' });
    expect(r.found).toBe(true);
    expect(r.nodes[0]!.uri).toBe('mandate://symbols/SessionStore.create');
    expect(r.nodes.at(-1)!.uri).toBe('mandate://standards/security-baseline');
    expect(r.edges.length).toBe(r.nodes.length - 1);
    expect(r.edges[0]!.kind).toBe('mentions_symbol');
  });

  it('impact of a standard and of a code file', async () => {
    const std = await index.graphImpact({ uri: 'mandate://standards/security-baseline' });
    expect(std.groups.spec?.map((n) => n.uri)).toEqual(expect.arrayContaining(['mandate://specs/login-sso', 'mandate://specs/user-sessions']));
    const file = await index.graphImpact({ uri: 'mandate://code/app/src/auth/session.ts' });
    expect(file.groups.section?.map((n) => n.uri)).toContain('mandate://specs/login-sso/sections/callback');
    expect(file.groups.spec?.map((n) => n.uri)).toContain('mandate://specs/login-sso');
    // A range resolves by overlap.
    const range = await index.graphImpact({ uri: 'mandate://code/app/src/auth/session.ts#L30-L31' });
    expect(range.groups.section?.map((n) => n.uri)).toContain('mandate://specs/login-sso/sections/callback');
  });

  it('node: neighbours grouped by kind; a file aggregates its ranges', async () => {
    const n = await index.graphNode({ uri: 'mandate://specs/login-sso' });
    expect(n.node.kind).toBe('spec');
    const names = n.neighbors.map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(['has_section', 'uses_standard', 'changed_by']));
    const file = await index.graphNode({ uri: 'mandate://code/app/src/auth/oidc.ts' });
    expect(file.neighbors.find((g) => g.name === 'referenced_by')?.nodes.map((x) => x.uri)).toContain('mandate://specs/login-sso/sections/auth-flow');
    await expect(index.graphNode({ uri: 'mandate://specs/nope' })).rejects.toThrow(/unknown node/);
  });

  it('neighbors: BFS with depth, direction, kinds and pagination', async () => {
    const one = await index.graphNeighbors({ uri: 'mandate://standards/security-baseline', depth: 1, direction: 'in', kinds: ['uses_standard'] });
    expect(one.nodes.every((x) => x.props.depth === 1)).toBe(true);
    expect(one.edges.every((e) => e.kind === 'uses_standard' && e.to === 'mandate://standards/security-baseline')).toBe(true);
    const two = await index.graphNeighbors({ uri: 'mandate://standards/security-baseline', depth: 2, limit: 3 });
    expect(two.nodes).toHaveLength(3);
    expect(two.nextCursor).not.toBeNull();
    const next = await index.graphNeighbors({ uri: 'mandate://standards/security-baseline', depth: 2, limit: 3, cursor: two.nextCursor! });
    expect(next.nodes.map((x) => x.uri)).not.toContain(two.nodes[0]!.uri);
    await expect(index.graphNeighbors({ uri: 'mandate://specs/login-sso', depth: 4 } as never)).rejects.toBeInstanceOf(ZodError);
  });

  it('the deleted spec legacy-xml-export resolves at a past commit and shows its deletion', async () => {
    const now = await index.graphNode({ uri: 'mandate://specs/legacy-xml-export' });
    expect(now.node.deletedAt).toBeDefined();
    const hist = await index.graphHistory({ uri: 'mandate://specs/legacy-xml-export' });
    expect(hist.events[0]!.action).toBe('deleted');
    const before = hist.events[1]!.commit;
    const then = await index.graphNode({ uri: 'mandate://specs/legacy-xml-export', at: before.sha });
    expect(then.node.deletedAt).toBeUndefined();
    expect(then.at?.sha).toBe(before.sha);
    expect(then.neighbors.find((g) => g.name === 'has_section')!.count).toBeGreaterThan(0);
    // By date too.
    const byDate = await index.graphNode({ uri: 'mandate://specs/legacy-xml-export', at: before.date });
    expect(byDate.node.deletedAt).toBeUndefined();
  });

  it('a spec has fewer edges at an old commit than now', async () => {
    const hist = await index.graphHistory({ uri: 'mandate://specs/login-sso', limit: 200 });
    const created = hist.events.at(-1)!;
    expect(created.action).toBe('created');
    const then = await index.graphNode({ uri: 'mandate://specs/login-sso', at: created.commit.sha });
    const now = await index.graphNode({ uri: 'mandate://specs/login-sso' });
    const count = (r: typeof now, name: string) => r.neighbors.find((g) => g.name === name)?.count ?? 0;
    expect(count(then, 'has_section')).toBeLessThan(count(now, 'has_section'));
  });

  it('history for a symbol: changes of the sections mentioning it', async () => {
    const r = await index.graphHistory({ uri: 'mandate://symbols/AuthService.login' });
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.every((e) => e.target === 'mandate://specs/login-sso/sections/auth-flow')).toBe(true);
    expect(r.events.at(-1)!.action).toBe('created');
    expect(r.events[0]!.commit.uri).toMatch(/^mandate:\/\/commits\/[0-9a-f]{40}$/);
  });

  it('changes between two commits', async () => {
    const hist = await index.graphHistory({ uri: 'mandate://specs/legacy-xml-export' });
    const del = hist.events[0]!.commit;
    const parent = (index.db.prepare('SELECT parent FROM commit_parents WHERE sha = ? AND idx = 0').get(del.sha) as { parent: string }).parent;
    const r = await index.graphChanges({ from: parent, to: del.sha });
    expect(r.nodesRemoved.map((n) => n.uri)).toContain('mandate://specs/legacy-xml-export');
    expect(r.edgesRemoved.some((e) => e.from === 'mandate://specs/legacy-xml-export' && e.kind === 'has_section')).toBe(true);
    expect(r.content.find((c) => c.uri === 'mandate://specs/legacy-xml-export')?.action).toBe('deleted');
    const root = (index.db.prepare('SELECT sha FROM commits WHERE mainline = 1 ORDER BY seq LIMIT 1').get() as { sha: string }).sha;
    const whole = await index.graphChanges({ from: root, within: 'mandate://specs/login-sso' });
    expect(whole.content.find((c) => c.uri === 'mandate://specs/login-sso')?.summary?.sectionsAdded.length).toBeGreaterThan(0);
  });

  it('evolution lists when relationships appeared', async () => {
    const r = await index.graphEvolution({ uri: 'mandate://specs/login-sso' });
    expect(r.versions[0]!.version).toBe(1);
    const std = r.entries.find((e) => e.kind === 'uses_standard' && e.direction === 'out');
    expect(std?.from.version).toBeGreaterThanOrEqual(1);
    expect(r.entries.some((e) => e.name === 'has_section')).toBe(true);
  });

  it('graph search returns entry nodes', async () => {
    const r = await index.graphSearch({ q: 'AuthService.login' });
    expect(r.nodes[0]!.uri).toBe('mandate://symbols/AuthService.login');
  });

  it('rejects invalid input with zod errors', async () => {
    await expect(index.search({ q: '' })).rejects.toBeInstanceOf(ZodError);
    await expect(index.search({ q: 'x', bogus: 1 } as never)).rejects.toBeInstanceOf(ZodError);
    await expect(index.graphNode({ uri: 'https://example.com' })).rejects.toBeInstanceOf(ZodError);
    await expect(index.graphPath({ from: 'mandate://specs/a', to: 'mandate://specs/b', maxDepth: 7 })).rejects.toBeInstanceOf(ZodError);
    await expect(index.codeSearch({})).rejects.toBeInstanceOf(ZodError);
  });
});

/* ------------------------------------------------------------------ incremental + temporal */

describe('incremental and temporal indexing', () => {
  const spec = (title: string, body: string, extra: Record<string, unknown> = {}) =>
    createSpecSchema.parse({ title, sections: [{ id: 'overview', title: 'Overview', body, summary: 'What it is.' }], ...extra });

  it('picks up commits made through storage, re-indexes only changed files and reuses cached vectors', async () => {
    const dir = await tempDir();
    const git = await newStore(dir);
    const storage = createStorage(git);
    await storage.standards.create(createStandardSchema.parse({ title: 'Std A', sections: [] }));
    await storage.standards.create(createStandardSchema.parse({ title: 'Std B', sections: [] }));
    // Standards are linked from sections (here: the whole standard); the spec-level use is derived.
    await storage.specs.create(
      createSpecSchema.parse({
        title: 'Payments',
        sections: [{ id: 'overview', title: 'Overview', body: 'Card payments go through the gateway.', summary: 'What it is.', links: [{ to: 'mandate://standards/std-a', rel: 'follows' }] }],
      }),
    );
    await storage.specs.create(spec('Search', 'Full text search over specs.'));
    const provider = new FakeProvider(32, 'fake:32');
    const file = path.join(dir, '..', `${path.basename(dir)}.sqlite`);
    const index = new IndexService({ git, storage, index: indexCfg(file), embedding, provider });
    watchCommits(git, () => index.schedule());
    await index.start();
    await index.idle();
    const first = provider.embedded;
    expect(first).toBeGreaterThan(0);
    const v1 = (await index.status()).headCommit!;

    // A write through storage triggers an incremental sync.
    await storage.specs.update('payments', {
      sections: [
        { id: 'overview', title: 'Overview', body: 'Card payments go through the gateway.', summary: 'What it is.', links: [{ to: 'mandate://standards/std-b', rel: 'follows' }] },
        { id: 'refunds', title: 'Refunds', body: 'Refunds settle within five days.' },
      ] as never,
    });
    await new Promise((r) => setTimeout(r, 60));
    await index.idle();
    const s = await index.status();
    expect(s.upToDate).toBe(true);
    const hits = await index.search({ q: 'refunds settle', mode: 'text' });
    expect(hits.groups[0]!.hits[0]!.uri).toMatch(/^mandate:\/\/specs\/payments\/sections\/refunds#L\d+/);
    // Only new texts were embedded (unchanged chunks keep their vectors).
    const added = provider.embedded - first;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(first);

    // Temporal: the old standard edge is closed, the new one open.
    const then = await index.graphNode({ uri: 'mandate://specs/payments', at: v1 });
    const now = await index.graphNode({ uri: 'mandate://specs/payments' });
    const stds = (r: typeof now) => r.neighbors.find((g) => g.name === 'uses_standard')?.nodes.map((n) => n.uri);
    expect(stds(then)).toEqual(['mandate://standards/std-a']);
    expect(stds(now)).toEqual(['mandate://standards/std-b']);
    const diff = await index.graphChanges({ from: v1 });
    expect(diff.edgesAdded).toContainEqual(expect.objectContaining({ from: 'mandate://specs/payments', to: 'mandate://standards/std-b', kind: 'uses_standard' }));
    expect(diff.edgesRemoved).toContainEqual(expect.objectContaining({ from: 'mandate://specs/payments', to: 'mandate://standards/std-a', kind: 'uses_standard' }));
    expect(diff.nodesAdded.map((n) => n.uri)).toContain('mandate://specs/payments/sections/refunds');
    expect(diff.content.find((c) => c.uri === 'mandate://specs/payments')?.summary).toMatchObject({ sectionsAdded: ['refunds'] });
    const evo = await index.graphEvolution({ uri: 'mandate://specs/payments' });
    const a = evo.entries.find((e) => e.kind === 'uses_standard' && e.other.uri === 'mandate://standards/std-a')!;
    expect(a.from.version).toBe(1);
    expect(a.to?.version).toBe(2);
    const changedBy = await index.graphHistory({ uri: 'mandate://specs/payments/sections/refunds' });
    expect(changedBy.events[0]).toMatchObject({ action: 'created', changeKinds: ['text'] });

    // Full rebuild replays history and reuses every cached vector.
    const before = provider.embedded;
    await index.rebuild();
    await index.idle();
    expect(provider.embedded).toBe(before);
    expect((await index.status()).embedding.pending).toBe(0);
    index.close();

    // A different model never mixes vectors: everything is pending again for it.
    const p2 = new FakeProvider(32, 'fake:32:v2');
    const other = new IndexService({ git, storage, index: indexCfg(file), embedding, provider: p2 });
    await other.sync();
    await other.idle();
    const st = await other.status();
    expect(st.embedding.modelId).toBe('fake:32:v2');
    expect(st.embedding.pending).toBe(0);
    // Every text was embedded again for the new model: no vector of the old model was reused.
    expect(p2.embedded).toBe(st.chunks > 0 ? st.embedding.embedded : 0);
    expect(p2.embedded).toBeGreaterThan(0);
    other.close();
  });

  it('works text-only with provider none', async () => {
    const dir = await tempDir();
    const git = await newStore(dir);
    const storage = createStorage(git);
    await storage.specs.create(spec('Billing', 'Invoices are emailed monthly.'));
    const index = new IndexService({ git, storage, index: indexCfg(path.join(dir, '..', `${path.basename(dir)}-n.sqlite`)), embedding, provider: null });
    await index.start();
    const r = await index.search({ q: 'invoices monthly' });
    expect(r.semantic).toMatchObject({ used: false, reason: expect.stringMatching(/disabled/) });
    expect(r.groups[0]!.docUri).toBe('mandate://specs/billing');
    expect((await index.related({ uri: 'mandate://specs/billing' })).items).toEqual([]);
    index.close();
  });
});

describe('section links', () => {
  it('indexes one edge kind per link rel, derives doc-level uses_standard / spec_depends_on', async () => {
    const dir = await tempDir();
    const git = await newStore(dir);
    const storage = createStorage(git);
    await storage.standards.create(createStandardSchema.parse({ title: 'Sec', sections: [{ id: 'rules', title: 'Rules', body: 'Never log tokens.' }] }));
    await storage.specs.create(createSpecSchema.parse({ title: 'Base', sections: [{ id: 'core', title: 'Core', body: 'Core API.' }] }));
    await storage.specs.create(
      createSpecSchema.parse({
        title: 'Login',
        sections: [
          { id: 'logging', title: 'Logging', body: 'Logs redact tokens.', links: [{ to: 'mandate://standards/sec/sections/rules', rel: 'follows' }] },
          { id: 'debug', title: 'Debug', body: 'Debug mode logs raw requests.', links: [{ to: 'mandate://standards/sec/sections/rules', rel: 'deviates_from', note: 'local only' }] },
          { id: 'flow', title: 'Flow', body: 'Uses the core API.', links: [{ to: 'mandate://specs/base/sections/core', rel: 'depends_on' }] },
        ],
      }),
    );
    const index = new IndexService({ git, storage, index: indexCfg(path.join(dir, '..', `${path.basename(dir)}-l.sqlite`)), embedding, provider: null });
    await index.start();
    const rules = await index.graphNode({ uri: 'mandate://standards/sec/sections/rules' });
    const group = (name: string) => rules.neighbors.find((g) => g.name === name)?.nodes.map((n) => n.uri) ?? [];
    expect(group('followed_by')).toEqual(['mandate://specs/login/sections/logging']);
    // Section-level standards are links; the doc-level use is derived (marked) from them.
    expect(group('used_by')).toEqual([]);
    const login = await index.graphNeighbors({ uri: 'mandate://specs/login', direction: 'out', kinds: ['uses_standard', 'spec_depends_on', 'depends_on'] });
    expect(login.edges.map((e) => [e.kind, e.to, e.props?.via])).toEqual(
      expect.arrayContaining([
        ['uses_standard', 'mandate://standards/sec', ['links']],
        ['spec_depends_on', 'mandate://specs/base', 'links'],
      ]),
    );
    // P2: the derived document-level dependency never shares the authored section-link kind.
    expect(login.edges.some((e) => e.kind === 'depends_on' && e.from === 'mandate://specs/login')).toBe(false);
    expect(group('deviated_from_by')).toEqual(['mandate://specs/login/sections/debug']);
    // `links_to` (deprecated input) expands to the per-rel kinds.
    const links = await index.graphNeighbors({ uri: 'mandate://specs/login/sections/debug', kinds: ['links_to' as never], direction: 'out' });
    expect(links.edges.map((e) => e.kind)).toEqual(['deviates_from']);
    // G-2: the link's metadata (here the server-set author) stays on the edge; `rel` is kept for one release.
    expect(links.edges[0]!.props).toEqual({ rel: 'deviates_from', note: 'local only', by: 'local' });
    const impact = await index.graphImpact({ uri: 'mandate://specs/base/sections/core' });
    expect(impact.groups.section?.map((n) => n.uri)).toContain('mandate://specs/login/sections/flow');
    const stdImpact = await index.graphImpact({ uri: 'mandate://standards/sec' });
    expect(stdImpact.groups.section?.map((n) => n.uri)).toEqual(expect.arrayContaining(['mandate://specs/login/sections/logging']));
    index.close();
  });
});
