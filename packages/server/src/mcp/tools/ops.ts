/** Ops tools: index status, git status and pull. */
import { gitPullInputSchema, gitStatusInputSchema, indexStatusInputSchema, type GitSyncResult } from '@mandate/shared';
import { z } from 'zod';
import { DEFAULT_ASK_CONFIG } from '../../config.js';
import { askStatus } from '../../ask/status.js';
import { liveAskConfig } from '../../ask/live.js';
import { defineTool, needIndex } from '../define.js';

const embeddingJobsInputSchema = z
  .object({
    status: z.array(z.enum(['pending', 'running', 'failed'])).min(1).optional().describe('default: failed and pending'),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();
const embeddingJobsRetryInputSchema = z.object({ contentHashes: z.array(z.string().min(1).max(128)).min(1).max(1000).optional().describe('default: every failed job') }).strict();

export const opsTools = [
  defineTool({
    name: 'index_status',
    title: 'Index status',
    kind: 'read',
    description: `Search index state: HEAD vs indexed commit, counts (docs, sections, chunks, nodes, edges, commits), embedding progress (provider, model, embedded, pending) and the last error. embedding.queue: job counts per status (pending, running, failed), the oldest pending age, whether the provider is paused, the last error and a few failed jobs (content hash + doc / section refs, never the text). Semantic search is partial while vectors are pending.
Example: {}`,
    input: indexStatusInputSchema,
    run: (_a, ctx) => needIndex(ctx).status({}),
  }),
  defineTool({
    name: 'embedding_jobs',
    title: 'Embedding jobs',
    kind: 'read',
    description: `Embedding jobs of the current model (the queue that turns chunk texts into vectors for semantic search), most urgent first: content hash, status, attempts, next attempt, last error and the docs / sections using the text (never the text). Default status: failed and pending. Failed jobs can be re-armed with embedding_jobs_retry.
Example: {"status":["failed"],"limit":10}`,
    input: embeddingJobsInputSchema,
    run: async (a, ctx) => needIndex(ctx).embeddingJobs(a),
  }),
  defineTool({
    name: 'embedding_jobs_retry',
    title: 'Retry embedding jobs',
    // Changes the local index (no document commit): ops, and agent keys only (not the web UI's read-only session).
    kind: 'ops',
    agentOnly: true,
    annotations: { idempotentHint: true },
    description: `Re-arm failed embedding jobs (all, or the given content hashes from embedding_jobs / index_status) with a fresh attempt budget, and wake the embedding worker. Returns how many were re-armed.
Example: {} or {"contentHashes":["3f2a..."]}`,
    input: embeddingJobsRetryInputSchema,
    run: async (a, ctx) => needIndex(ctx).retryEmbeddingJobs(a),
  }),
  defineTool({
    name: 'git_status',
    title: 'Git status',
    kind: 'read',
    description: `Status of the Mandate repository: branch, HEAD, remote, uncommitted files, the integrity report (repo lint after the last pull or startup) and autoPush (background push: state, ahead / behind, last push time and result, next scheduled push, last error).
Example: {}`,
    input: gitStatusInputSchema,
    run: async (_a, ctx) => ({ ...(await ctx.storage.git.status()), integrity: await ctx.storage.integrity.current(), ...(ctx.autoPush ? { autoPush: await ctx.autoPush.status() } : {}) }),
  }),
  defineTool({
    name: 'git_push',
    title: 'Git push',
    // Pushes local commits now (normally automatic, debounced after commits); never force. Not a document write.
    kind: 'ops',
    annotations: { idempotentHint: true, openWorldHint: true },
    description: `Push this project's local commits to its remote now (normally done automatically a few seconds after commits). Never force-pushes; if the remote moved it integrates like git_pull, then pushes. Returns the autoPush status (state, ahead, behind, lastPushAt, lastError). No-op without a remote.
Example: {}`,
    input: z.object({}).strict(),
    run: async (_a, ctx) => {
      if (!ctx.autoPush) return { state: 'disabled', message: 'auto-push is not available for this project' };
      return ctx.autoPush.pushNow('manual');
    },
  }),
  defineTool({
    name: 'git_pull',
    title: 'Git pull',
    // Fetch + pull only (never push); it changes the local checkout and reaches the remote, so it is not a read.
    kind: 'ops',
    annotations: { idempotentHint: true, openWorldHint: true },
    description: `Fetch and pull the configured remote (never pushes); the index re-syncs afterwards. No-op without a remote.
Example: {}`,
    input: gitPullInputSchema,
    run: async (_a, ctx): Promise<GitSyncResult> => {
      const { git, lock } = ctx.storage;
      if (!git.hasRemote()) return { pulled: false, pushed: false, message: 'No remote configured; nothing to pull.' };
      const r = await lock.run(async () => {
        const pulled = await git.pull();
        return { pulled, pushed: false, message: pulled ? 'Pulled new changes.' : 'Already up to date.' };
      });
      // Lint after every pull (merged clones may break write-time rules); git_status reports it.
      if (r.pulled) await ctx.storage.integrity.run();
      return r;
    },
  }),
  defineTool({
    name: 'ask_status',
    title: 'Ask model status',
    kind: 'read',
    description: `The models configured for answering in the web UI's Ask panel (\`ask\` block of ~/.mandate/config.json) and the default one: per model its id, label, provider, model, baseUrl, the env var name for the key and whether it is set (never the key), whether it is configured, what is missing (model | apiKey | baseUrl) and why. Without models: missing provider + model. Changes to the config file and ~/.mandate/secrets.env apply without a restart.
Example: {}`,
    input: z.object({}).strict(),
    run: async (_a, ctx) => askStatus(liveAskConfig(ctx.ask ?? DEFAULT_ASK_CONFIG)),
  }),
];
