import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EsGitStore } from '../src/git/EsGitStore.js';
import type { GitStore } from '../src/git/GitStore.js';
import { FakeProvider } from '../src/index/embed/index.js';
import { IndexService } from '../src/index/service.js';
import { createStorage, type Storage } from '../src/storage/index.js';
import { tempDir } from './helpers.js';
import { PostgresDb } from '../src/db/postgres.js';
import { indexDb } from '../src/db/pg-index/mirror.js';

/**
 * Index backend of the contract suites: SQLite (default) or Postgres (MANDATE_INDEX_BACKEND=pglite, or =postgres with
 * MANDATE_TEST_PG_URL). On Postgres the SQLite build is published to a fresh project schema and graph_query runs there.
 */
export async function fixturePostgres(): Promise<{ db: PostgresDb; projectId: string } | undefined> {
  const kind = process.env.MANDATE_INDEX_BACKEND;
  if (!kind || kind === 'sqlite') return undefined;
  const projectId = `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let base: PostgresDb;
  if (kind === 'pglite') {
    const { pglitePoolConfig } = await import('./db/backends.js');
    base = await PostgresDb.connect({ poolConfig: await pglitePoolConfig(), embedded: true, schema: 'mandate_server' });
  } else {
    if (!process.env.MANDATE_TEST_PG_URL) throw new Error('MANDATE_INDEX_BACKEND=postgres needs MANDATE_TEST_PG_URL');
    base = await PostgresDb.connect({ connectionString: process.env.MANDATE_TEST_PG_URL, schema: 'mandate_server' });
  }
  return { db: indexDb(base, projectId, true), projectId };
}

/** The repository the contract suites run against (a clone of data/repo, or MANDATE_FIXTURE_REPO). */
const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../data/repo');

export interface GraphFixture {
  dir: string;
  git: GitStore;
  index: IndexService;
  /** Merged fixture only: commits made on each clone, the merge, and the agent names used. */
  merged?: { sideCommits: string[]; merge: string; agentA: string; agentB: string; feedback: string | null };
}

const AUTHOR = { name: 'Test', email: 'test@example.com' };

export function makeIndex(git: GitStore, storage: Storage | undefined, file: string, opts: { queryTimeoutMs?: number; postgres?: { db: PostgresDb; projectId: string } } = {}): IndexService {
  return new IndexService({
    ...(opts.postgres ? { postgres: opts.postgres } : {}),
    git,
    storage,
    index: { path: file, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600, queryTimeoutMs: opts.queryTimeoutMs },
    embedding: {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1/v1',
      model: 'fake',
      apiKeyEnv: null,
      dimensions: 64,
      maxInputTokens: 2048,
      batchSize: 64,
      documentPrefix: '',
      queryPrefix: '',
    },
    provider: new FakeProvider(64, 'fake:64'),
  });
}

/**
 * `clone` (default): a clone of the seeded data. `merged` (MANDATE_FIXTURE_KIND=merged): two clones of it commit
 * concurrently (with Agent / Branch / Feedback trailers), B merges A and pushes, then A fast-forwards to B's merge,
 * so A's own commits end up on a side branch.
 */
export async function graphFixture(kind = process.env.MANDATE_FIXTURE_KIND ?? 'clone'): Promise<GraphFixture> {
  const root = await tempDir();
  if (kind === 'merged') return mergedFixture(root);
  const dir = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', SOURCE, dir]);
  const git = new EsGitStore({ dir, author: AUTHOR });
  await git.open();
  const storage = createStorage(git);
  await seedQuestion(storage);
  const pgx = await fixturePostgres();
  const index = makeIndex(git, storage, path.join(root, 'index.sqlite'), pgx ? { postgres: pgx } : {});
  await index.start();
  await index.idle();
  return { dir, git, index };
}

export async function mergedFixture(root: string): Promise<GraphFixture> {
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', SOURCE, remote]);
  const store = async (name: string) => {
    const g = new EsGitStore({ dir: path.join(root, name), branch: 'main', remote: { url: remote, branch: 'main' }, author: AUTHOR });
    await g.openOrCreate();
    return g;
  };
  const a = await store('a');
  const b = await store('b');
  const sa = createStorage(a);
  const sb = createStorage(b);
  const agentA = 'agent-a@clone-a';
  const agentB = 'agent-b@clone-b';
  // An open feedback item to reference from a side-branch commit trailer.
  const fbLine = readFileSync(path.join(root, 'a', 'feedback.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; status: string })
    .find((f) => f.status === 'open');
  const feedback = fbLine?.id ?? null;

  const addSection = async (s: Storage, spec: string, id: string, body: string, meta: Record<string, unknown>) => {
    const cur = await s.specs.get(spec);
    await s.specs.update(spec, { sections: [...cur.sections, { id, title: id.replace(/-/g, ' '), type: 'markdown', body, summary: body }] } as never, meta);
  };
  // Clone A: two commits (trailers on the side branch-to-be).
  await addSection(sa, 'user-sessions', 'device-limits', 'A user keeps at most five concurrent sessions.', {
    agent: agentA,
    branch: 'spec/device-limits',
    ...(feedback ? { trailers: { Feedback: feedback } } : {}),
  });
  await addSection(sa, 'dark-mode', 'high-contrast', 'A high-contrast theme is available from settings.', { agent: agentA });
  // Clone B: concurrent commits on other specs.
  await addSection(sb, 'rate-limiting', 'burst-credits', 'Unused requests accumulate as burst credits up to 200.', { agent: agentB });
  await addSection(sb, 'audit-log', 'export', 'Audit events can be exported as CSV for a date range.', { agent: agentB, branch: 'spec/audit-export' });
  await seedQuestion(sb);
  const sideCommits = (await a.log(2)).map((c) => c.id);
  await a.push();
  await b.pull(); // true merge: B's head is the first parent
  await b.push();
  await a.pull(); // fast-forward to B's merge: A's commits are now on the side branch
  const merge = (await a.head())!;
  const pgx = await fixturePostgres();
  const index = makeIndex(a, sa, path.join(root, 'index.sqlite'), pgx ? { postgres: pgx } : {});
  await index.start();
  await index.idle();
  return { dir: path.join(root, 'a'), git: a, index, merged: { sideCommits, merge, agentA, agentB, feedback } };
}

/** One answered question (`questions.jsonl`) about a spec section, so question nodes and refs are covered. */
export async function seedQuestion(s: Storage): Promise<void> {
  const spec = (await s.specs.list()).find((x) => x.status !== 'archived' && x.sections.length)!;
  const q = await s.questionService.ask(
    {
      purpose: 'decision',
      blocking: false,
      context: [`mandate://specs/${spec.id}/sections/${spec.sections[0]!.id}`],
      questions: [{ header: 'Scope', question: 'Include this section in the release?', options: [{ label: 'Yes', description: 'Ship it' }, { label: 'No', description: 'Later' }], recommended: 'Yes', multiSelect: false }],
    },
    { agent: 'fixture-agent' },
    { agent: 'fixture-agent' },
  );
  await s.questionService.answer(q.id, { q1: 'Yes' }, { agent: 'mandate-ui', user: 'ada' }, { via: 'ui' }, { agent: 'mandate-ui' });
}

/** Small seeded PRNG (mulberry32) for deterministic sampling. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
