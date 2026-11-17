/** Ops tools: index status, git status and pull. */
import { gitPullInputSchema, gitStatusInputSchema, indexStatusInputSchema, type GitSyncResult } from '@mandate/shared';
import { z } from 'zod';
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
    description: `Search index state: HEAD vs indexed commit, counts, embedding progress and queue (job counts, oldest pending, paused, failed jobs), last error. Semantic search is partial while vectors are pending.
Example: {}`,
    input: indexStatusInputSchema,
    run: (_a, ctx) => needIndex(ctx).status({}),
  }),
  defineTool({
    name: 'embedding_jobs',
    title: 'Embedding jobs',
    kind: 'read',
    description: `Embedding jobs of the current model, most urgent first (hash, status, attempts, next attempt, error, docs using the text). Default status: failed + pending. Retry with embedding_jobs_retry.
Example: {"status":["failed"]}`,
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
    description: `Re-arm failed embedding jobs (all, or the given contentHashes) and wake the worker. Returns the count.
Example: {}`,
    input: embeddingJobsRetryInputSchema,
    run: async (a, ctx) => needIndex(ctx).retryEmbeddingJobs(a),
  }),
  defineTool({
    name: 'git_status',
    title: 'Git status',
    kind: 'read',
    description: `Mandate repo status: branch, HEAD, remote, uncommitted files, integrity report and autoPush state (ahead / behind, last push, next push, last error).
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
    description: `Push local commits now (normally automatic). Never force-pushes; integrates like git_pull if the remote moved. Returns autoPush status; no-op without a remote.
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
    description: `Fetch and pull the remote (never pushes); the index re-syncs. No-op without a remote.
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
];
