/**
 * Work-order document tools (plan, touched code, git context, sections) and comment threads. Work orders are markdown
 * documents (`work-orders/<id>.md`); every write is a commit with a `Work-Order:` trailer (heartbeats excepted).
 * Comments live append-only in `comments.jsonl` (never inside the work order).
 */
import {
  buildCommentRef,
  buildRef,
  commentAddInputSchema,
  commentReopenInputSchema,
  commentResolveInputSchema,
  commentsListInputSchema,
  parseRef,
  workOrderGitUpdateInputSchema,
  workOrderPlanSetInputSchema,
  workOrderSectionGetInputSchema,
  workOrderTouchFromCommitsInputSchema,
  workOrderTouchInputSchema,
} from '@mandate/shared';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const idOf = (refOrId: string) => parseRef(refOrId)?.id ?? refOrId;
function metaOf(ctx: ToolContext, commits: string[], extra: Record<string, string> = {}): CommitMeta {
  const c = ctx.commit!;
  return { agent: c.agent, ...(c.branch ? { branch: c.branch } : {}), trailers: { ...c.trailers, ...extra }, onCommit: (sha) => commits.push(sha) };
}
const commitsOf = (commits: string[]) => ({ commit: commits.at(-1) ?? null, commits });
const woResult = async (ctx: ToolContext, id: string, commits: string[], extra: Record<string, unknown> = {}, warnings: string[] = []) => ({
  ref: buildRef({ kind: 'work-orders', id }),
  ...commitsOf(commits),
  warnings,
  ...extra,
  workOrder: (await ctx.reads.workOrderGet({ ref: id })) as unknown,
});
/** The author of a comment: the agent identity plus, in server mode, the GitHub user it acts as. */
// The user is the write's attributed user (server mode: login or service:<name>; local mode: none).
const author = (ctx: ToolContext) => ({ agent: ctx.commit!.agent, ...(ctx.commit!.user ? { user: ctx.commit!.user } : {}) });

/** Write boilerplate lives once in the server INSTRUCTIONS. */
const COMMON = '';
const TOUCHED = 'files: "repo:path#Lx-Ly" or { repo, path, lines: ["10-20"], symbols, change: added|modified|deleted|renamed, from (renames), commits }';

export const workOrderDocTools: AnyToolDef[] = [
  defineTool({
    name: 'work_order_plan_set',
    title: 'Write the work-order plan',
    kind: 'write',
    description: `Write (replace) the implementation plan of an open work order: the plan section of work-orders/<id>.md (markdown; every version is kept in git). Required before claiming (except fast-path fixes). Keep it updated while you work; this is THE plan: do not keep implementation plans in local files when the Mandate flow is on.${COMMON}
Example: {"ref":"mandate://work-orders/wo-01jc...","plan":"1. Add the callback route...\\n2. ..."}`,
    input: workOrderPlanSetInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.planSet(id, ctx.commit!.agent, a.plan, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_touch',
    title: 'Record touched code',
    kind: 'write',
    description: `Record the code you changed for a work order (idempotent merge: paths normalized, line ranges merged, symbols / commits unioned; renames keep from): into touched and, with section (spec section id or work-order section reference), that section's codeRefs. Call it at least per section and before completion. ${TOUCHED}.${COMMON}
Example: {"ref":"wo-01jc...","section":"auth-flow","files":["app:src/auth/callback.ts#L40-L80",{"repo":"app","path":"src/auth/old.ts","change":"deleted"}]}`,
    input: workOrderTouchInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.touch(id, ctx.commit!.agent, { section: a.section, files: a.files }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_touch_from_commits',
    title: 'Touched code from commits',
    kind: 'write',
    description: `Compute touched files (paths, changed line ranges, renames) and commits from code commits (commits: [sha] or range: "base..head") and merge them like work_order_touch + work_order_git_update (commits, headCommit). Only works when the server can read a local checkout of the code repo (local mode, repo wired with \`mandate connect\`); otherwise it fails with code_repo_unavailable: then report the files yourself (work_order_touch).${COMMON}
Example: {"ref":"wo-01jc...","repo":"app","range":"main..HEAD"}`,
    input: workOrderTouchFromCommitsInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      const r = await ctx.storage.workOrderService.touchFromCommits(id, ctx.commit!.agent, a, ctx.codeRepos, metaOf(ctx, commits));
      return woResult(ctx, id, commits, { files: r.files, codeCommits: r.commits });
    },
  }),
  defineTool({
    name: 'work_order_git_update',
    title: 'Update work-order git context',
    kind: 'write',
    description: `Record the git context of a work order in one code repo (idempotent merge per repo; several repos possible): branch (the common branch input), baseBranch, baseCommit, headCommit, commits (unioned), worktree { path, host }, pr { url, number, status draft|open|merged|closed, mergedCommit }, mergedInto. Call it on claim (repo, branch, base, worktree), as you commit (headCommit / commits), when you open the PR and with the final head / merge. After completion only pr.status, pr.mergedCommit and mergedInto can change.${COMMON}
Example: {"ref":"wo-01jc...","repo":"app","branch":"wo/login-callback","baseBranch":"main","headCommit":"3f2a9c1","pr":{"number":42,"status":"open","url":"https://github.com/acme/app/pull/42"}}`,
    input: workOrderGitUpdateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const { ref, ...patch } = a;
      const id = idOf(ref);
      // `branch` (the common write input) is the code branch of this repo.
      await ctx.storage.workOrderService.gitUpdate(id, ctx.commit!.agent, { ...patch, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}) }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_section_get',
    title: 'Get a work-order section',
    kind: 'read',
    description: `One section of a work order: plan, reconciliation, outcome, or a work-order section (target spec section, status, implementation notes, codeRefs, deviations, verifications). @sha / at read an old version.
Example: {"ref":"mandate://work-orders/wo-01jc.../sections/plan"} or {"doc":"wo-01jc...","section":"auth-flow"}`,
    input: workOrderSectionGetInputSchema,
    run: async (a, ctx) => {
      if (!a.ref && !(a.doc && a.section)) throw new ToolError('invalid_input', 'give either ref, or doc and section', 'ref: mandate://work-orders/<id>/sections/<sid>');
      return ctx.reads.workOrderSectionGet(a);
    },
  }),
  defineTool({
    name: 'comment_add',
    title: 'Add a comment',
    kind: 'write',
    description: `Comment on a work order or one of its sections (target: mandate://work-orders/<id>[/sections/<sid>]), or reply to a thread (parent: comment id or mandate://comments/<id>). blocking: true marks a must-fix issue (blocks work_order_complete until resolved). Append-only; on a closed work order only replies. @name mentions are recorded.${COMMON}
Example: {"target":"mandate://work-orders/wo-01jc.../sections/auth-flow","body":"The callback does not check state.","blocking":true}`,
    input: commentAddInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = await ctx.storage.commentService.add(a, author(ctx), metaOf(ctx, commits));
      const threads = await ctx.storage.commentService.threads(c.target);
      const thread = threads.find((t) => t.id === c.id || t.replies.some((r) => r.id === c.id)) ?? null;
      return { ref: buildCommentRef(c.id), uri: buildCommentRef(c.id), ...commitsOf(commits), warnings: [], comment: c, thread };
    },
  }),
  defineTool({
    name: 'comment_resolve',
    title: 'Resolve a comment thread',
    kind: 'write',
    description: `Resolve a comment thread (id of its root or of any reply), with an optional note. Appends a resolve record (no-op when already resolved).${COMMON}
Example: {"id":"c-01jc...","note":"Fixed in 3f2a9c1."}`,
    input: commentResolveInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const { thread, changed } = await ctx.storage.commentService.setState(a.id, 'resolve', ctx.commit!.agent, a.note, metaOf(ctx, commits));
      return { ref: buildCommentRef(thread.id), uri: buildCommentRef(thread.id), ...commitsOf(commits), warnings: changed ? [] : ['already resolved'], thread };
    },
  }),
  defineTool({
    name: 'comment_reopen',
    title: 'Reopen a comment thread',
    kind: 'write',
    description: `Reopen a resolved comment thread (not on closed work orders). Appends a reopen record (no-op when already open).${COMMON}
Example: {"id":"c-01jc..."}`,
    input: commentReopenInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const { thread, changed } = await ctx.storage.commentService.setState(a.id, 'reopen', ctx.commit!.agent, undefined, metaOf(ctx, commits));
      return { ref: buildCommentRef(thread.id), uri: buildCommentRef(thread.id), ...commitsOf(commits), warnings: changed ? [] : ['already open'], thread };
    },
  }),
  defineTool({
    name: 'comments_list',
    title: 'List comment threads',
    kind: 'read',
    description: `Comment threads on a work order (all its sections included) or on one section: root comment, replies, status open | resolved (resolvedBy / resolvedAt / note), blocking, mentions; open ones only unless includeResolved. Check them when you pick up or resume a work order and before work_order_complete.
Example: {"target":"mandate://work-orders/wo-01jc..."}`,
    input: commentsListInputSchema,
    run: async (a, ctx) => {
      const target = ctx.storage.commentService.canonical(a.target);
      const all = await ctx.storage.commentService.threads(target);
      const threads = a.includeResolved ? all : all.filter((t) => t.status === 'open');
      return {
        target,
        counts: { open: all.filter((t) => t.status === 'open').length, openBlocking: all.filter((t) => t.status === 'open' && t.blocking).length, resolved: all.filter((t) => t.status === 'resolved').length },
        threads,
      };
    },
  }),
];
