/**
 * One-off lineage backfill: propose lineage annotations for past data-repo commits (history is never rewritten) from
 * evidence (commit messages, Feedback / Work-Order trailers on neighbouring commits, feedback resolutions and targets,
 * work-order claims and origins), each with a confidence (high / low) and the evidence, and measure cause coverage.
 *
 *   tsx scripts/lineage-backfill.ts --repo <data repo dir> [--index <sqlite file>] [--out <report.json>]
 *       [--apply high] [--via service | --via mcp --url http://localhost:4000/p/default/mcp --token-file <file>]
 *       [--agent lineage-backfill]
 *
 * Without --apply it only proposes. --apply high appends one annotation per high-confidence proposal THROUGH THE WRITE
 * PATH: `--via service` uses the storage service in-process (only for a copy, or when no server runs on the repo:
 * the write lock is in-process); `--via mcp` calls the running server's `lineage_annotate` tool (the token is read
 * from a file and never printed). The working tree must be clean.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EsGitStore } from '../src/git/EsGitStore.js';
import { lineageCoverage, proposeAnnotations, type BackfillProposal } from '../src/index/lineage-backfill.js';
import { IndexService } from '../src/index/service.js';
import { createStorage } from '../src/storage/index.js';

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repo = opt('repo');
if (!repo) {
  console.error('usage: tsx scripts/lineage-backfill.ts --repo <dir> [--index <file>] [--out <file>] [--apply high] [--via service|mcp] [--url <mcp url>] [--token-file <file>] [--agent <name>]');
  process.exit(2);
}
const indexFile = opt('index') ?? path.join(os.tmpdir(), `lineage-backfill-${Date.now()}.sqlite`);
const apply = opt('apply');
const via = opt('via') ?? 'service';
const agent = opt('agent') ?? 'lineage-backfill';

const git = new EsGitStore({ dir: path.resolve(repo), author: { name: 'Mandate', email: 'mandate@localhost' } });
await git.open();
const storage = createStorage(git);

const openIndex = () =>
  new IndexService({
    git,
    storage,
    index: { path: indexFile, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 },
    embedding: { provider: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'none', apiKeyEnv: null, dimensions: 8, maxInputTokens: 512, batchSize: 8, documentPrefix: '', queryPrefix: '' },
    provider: null,
  });

const index = openIndex();
await index.sync();
const before = lineageCoverage(index.db);
const annotated = new Set((await storage.lineageAnnotations.list()).map((a) => a.commit));
const proposals = proposeAnnotations(index.db, { feedback: await storage.feedback.list(), workOrders: await storage.workOrders.list(), annotated });
const high = proposals.filter((p) => p.confidence === 'high');
console.error(`coverage before: ${JSON.stringify(before)}`);
console.error(`proposals: ${proposals.length} (${high.length} high, ${proposals.length - high.length} low)`);

const applied: { commit: string; causes: string[]; id?: string; error?: string }[] = [];
if (apply === 'high') {
  const dirty = execFileSync('git', ['-C', path.resolve(repo), 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    console.error(`refusing to apply: the working tree of ${repo} is not clean`);
    process.exit(1);
  }
  const note = (p: BackfillProposal) => `backfill (high confidence): ${p.evidence.join('; ')}`.slice(0, 2000);
  if (via === 'service') {
    for (const p of high) {
      try {
        const rec = await storage.lineageAnnotationService.annotate({ commit: p.commit, causes: p.causes, note: note(p), by: agent }, { agent });
        applied.push({ commit: p.commit, causes: p.causes, id: rec.id });
      } catch (e) {
        applied.push({ commit: p.commit, causes: p.causes, error: (e as Error).message });
      }
    }
  } else if (via === 'mcp') {
    const url = opt('url');
    const tokenFile = opt('token-file');
    if (!url || !tokenFile) throw new Error('--via mcp needs --url and --token-file');
    const token = readFileSync(tokenFile, 'utf8').trim();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: agent, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      for (const p of high) {
        const r = (await client.callTool({ name: 'lineage_annotate', arguments: { commit: p.commit, causes: p.causes, note: note(p), agent } })) as { isError?: boolean; content: { type: string; text?: string }[] };
        const body = JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}') as { id?: string; error?: { code: string; message: string } };
        applied.push({ commit: p.commit, causes: p.causes, ...(r.isError ? { error: `${body.error?.code}: ${body.error?.message}` } : { id: body.id }) });
      }
    } finally {
      await client.close();
    }
  } else throw new Error(`unknown --via ${via}`);
  await index.sync();
}
const after = lineageCoverage(index.db);
if (apply) console.error(`coverage after: ${JSON.stringify(after)}; applied ${applied.filter((a) => a.id).length}, failed ${applied.filter((a) => a.error).length}`);
const report = { repo: path.resolve(repo), at: new Date().toISOString(), before, after, proposals, applied };
const out = opt('out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
else console.log(JSON.stringify(report, null, 2));
index.close();
