/**
 * Work-order document tools (plan, touched code, git context, sections) and comment threads. Work orders are markdown
 * documents (`work-orders/<id>.md`); every write is a commit with a `Work-Order:` trailer (heartbeats excepted).
 * Comments live append-only in `comments.jsonl` (never inside the work order).
 */
import { commentViewOf } from '../../comments/view.js';
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
  workOrderTaskSetInputSchema,
  taskChangesOf,
  workOrderSectionGetInputSchema,
  workOrderTouchFromCommitsInputSchema,
  workOrderTouchInputSchema,
} from '@mandate/shared';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';
import { clientIdentity } from '../../projects/settings.js';
import { deliverComment, newsOfProject } from '../../comments/route.js';
import { checkCodeRepos, stampLocations } from '../code-claims.js';

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
/** The author of a comment: the agent identity plus the user it acts as. */
// The user is the write's attributed user (a GitHub login or service:<name>).
const author = (ctx: ToolContext) => ({ agent: ctx.commit!.agent, ...(ctx.commit!.user ? { user: ctx.commit!.user } : {}) });

/** Write boilerplate lives once in the server INSTRUCTIONS. */
const COMMON = '';
const TOUCHED = 'files: "repo:path#Lx-Ly" or { repo, path, lines: ["10-20"], symbols, change: added|modified|deleted|renamed, from (renames), commits }';

const taskSetTool = defineTool({
    name: 'work_order_task_set',
    title: 'Set task status',
    kind: 'write',
    description: `Set the status of tasks: pending | in_progress | done | skipped. Set a task in_progress when you start it and done when finished (with codeRefs: they go on the task and into touched); skipped needs a note (why). One task in_progress at a time. Needs the claim (or no claim with every section done). Several: tasks: [{task, status, note?, codeRefs?}]. A spec section is implemented when every task covering it is done: it is then recorded on the spec section (implementedCommit, implementedBy, code refs) automatically. work_order_complete refuses while a task is pending or in progress.${COMMON}
Example: {"ref":"wo-01jc...","task":"t2","status":"done","codeRefs":["app:src/auth/callback.ts#L40-L80"]}`,
    input: workOrderTaskSetInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      const changes = taskChangesOf(a);
      const { warnings } = await ctx.storage.workOrderService.stepSet(id, ctx.commit!.agent, changes, metaOf(ctx, commits));
      return woResult(ctx, id, commits, {}, warnings);
    },
  });

export const workOrderDocTools: AnyToolDef[] = [
  defineTool({
    name: 'work_order_plan_set',
    title: 'Write the work-order plan',
    kind: 'write',
    description: `Write (replace) the plan of an open work order (plan markdown, versions kept in git). This is THE plan: no local plan files when the flow is on. Tasks are data with stable ids (t1, t2, ...): task lines "- [ ] **t1** text" keep their ids, a line without id is a new task; tasks: [text | {id?, text, sections, proves}] sets the task list directly (matched by id, new ones get ids; sections = spec sections it implements, proves = criteria it proves). Keep the plan current when it changes (ids are kept). A done task cannot be removed. Status changes go through work_order_task_set, not checkboxes.${COMMON}
Example: {"ref":"mandate://work-orders/wo-01jc...","plan":"**Tasks**\\n- [ ] **t1** Add the callback route\\n- [ ] Write the tests"}`,
    input: workOrderPlanSetInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.planSet(id, ctx.commit!.agent, a.plan, metaOf(ctx, commits), a.tasks ?? a.steps);
      return woResult(ctx, id, commits);
    },
  }),
  taskSetTool,
  // Old name (hidden, callable).
  { ...taskSetTool, name: 'work_order_step_set' } as AnyToolDef,
  defineTool({
    name: 'work_order_touch',
    title: 'Record touched code',
    kind: 'write',
    description: `Record the code you changed for a work order (idempotent merge: paths normalized, line ranges merged, symbols / commits unioned; renames keep from): into touched and, with section (spec section id or work-order section reference), that section's codeRefs. Call it at least per section and before completion. ${TOUCHED}; code { repo, commit, dirty } covers files without commits.${COMMON}
Example: {"ref":"wo-01jc...","section":"auth-flow","files":["app:src/auth/callback.ts#L40-L80",{"repo":"app","path":"src/auth/old.ts","change":"deleted"}]}`,
    input: workOrderTouchInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // Code locations carry repo + commit: code (stamped on files without commits; dirty: linked on completion) or per-file commits.
      const st = stampLocations(ctx, [{ files: a.files, path: 'files' }], a.code);
      await ctx.storage.workOrderService.touch(id, ctx.commit!.agent, { section: a.section, files: st.lists[0]! }, metaOf(ctx, commits));
      return woResult(ctx, id, commits, {}, st.warnings);
    },
  }),
  defineTool({
    name: 'work_order_touch_from_commits',
    title: 'Touched code from commits',
    kind: 'write',
    description: `Compute touched files (paths, changed line ranges, renames) and commits from code commits (commits: [sha] or range: "base..head") and merge them like work_order_touch + work_order_git_update (commits, headCommit). Only works when the server can read a local checkout of the code repo (Mandate on this computer, repo wired with \`mandate connect\`); otherwise it fails with code_repo_unavailable: then report the files yourself (work_order_touch).${COMMON}
Example: {"ref":"wo-01jc...","repo":"app","range":"main..HEAD"}`,
    input: workOrderTouchFromCommitsInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      const cw = checkCodeRepos(ctx, [a.repo], 'repo');
      const r = await ctx.storage.workOrderService.touchFromCommits(id, ctx.commit!.agent, a, ctx.codeRepos, metaOf(ctx, commits));
      return woResult(ctx, id, commits, { files: r.files, codeCommits: r.commits }, cw);
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
      const cw = checkCodeRepos(ctx, [patch.repo], 'repo');
      await ctx.storage.workOrderService.gitUpdate(id, ctx.commit!.agent, { ...patch, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}) }, metaOf(ctx, commits));
      return woResult(ctx, id, commits, {}, cw);
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
    uiAllowed: true,
    description: `Comment on ANY object: a spec / standard / component / request / work order, one of its sections (#Lx-Ly line range ok) or a work-order step; or reply (parent: comment id). target: mandate://specs/<id>/sections/<sid>, mandate://work-orders/<id>/steps/s1, mandate://requests/<id>. blocking: must be resolved before work_order_complete (on a request: flow_next stops on it). to / @mentions address an agent or user, else the responsible agent (claim holder, else the request's agent) is woken; to: any = queue for the next agent. asRequest: handle it as a change request. A reply on a resolved thread reopens it. Stored with view (the target's UI state, badges, selected text): answer from it. Replies: max 3 short sentences, act on the obvious intent, ask only if truly ambiguous. Result: routing { via, wakes }. Append-only; on a closed work order only replies.${COMMON}
Example: {"target":"mandate://specs/login/sections/auth-flow#L3-L8","body":"@claude-code should this also cover SSO?"}`,
    input: commentAddInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const svc = ctx.storage.commentService;
      const parentThread = a.parent ? (await svc.threadOf(a.parent)) : null;
      // The target's displayed state (and the selected text) travels with the comment: the receiver need not guess what the UI shows.
      const { selectedText, ...input } = a;
      const view = await commentViewOf(ctx.storage, a.parent && parentThread ? parentThread.target : a.target, selectedText);
      const c = await svc.add({ ...input, ...(view ? { view } : {}) }, author(ctx), metaOf(ctx, commits));
      if (parentThread?.status === 'resolved') await svc.setState(parentThread.id, 'reopen', ctx.commit!.agent, undefined, metaOf(ctx, commits)).catch(() => undefined);
      const threads = await svc.threads(c.target);
      const thread = threads.find((t) => t.id === c.id || t.replies.some((r) => r.id === c.id)) ?? null;
      const routing = thread ? await deliverComment(ctx, c, thread) : { via: 'none' as const, clients: [] };
      // Replying in a thread reads the events it raised for this client.
      const news = ctx.principal && ctx.principal.kind !== 'ui' ? newsOfProject(ctx) : null;
      if (news && thread) await news.markReadRefs(clientIdentity(ctx).id, [thread, ...thread.replies].map((m) => m.uri)).catch(() => 0);
      return {
        ref: buildCommentRef(c.id),
        uri: buildCommentRef(c.id),
        ...commitsOf(commits),
        warnings: routing.via === 'none' ? ['not routed: no addressee, no responsible agent (it stays visible on the object; address it with to / @mention)'] : [],
        comment: c,
        thread,
        routing: { via: routing.via, wakes: routing.clients },
      };
    },
  }),
  defineTool({
    name: 'comment_resolve',
    title: 'Resolve a comment thread',
    kind: 'write',
    uiAllowed: true,
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
    uiAllowed: true,
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
    description: `Comment threads on any object (a work order / spec / standard / component / request with its sections and steps) or on one section / step: root comment, replies, status open | resolved (resolvedBy / resolvedAt / note), blocking, mentions; open ones only unless includeResolved. Check them when you pick up or resume a work order and before work_order_complete.
Example: {"target":"mandate://work-orders/wo-01jc..."}`,
    input: commentsListInputSchema,
    run: async (a, ctx) => {
      if (!a.target) {
        const mine = await ctx.storage.commentService.openAddressedTo(a.addressedTo!);
        return { target: null, addressedTo: a.addressedTo, counts: { open: mine.length, openBlocking: mine.filter((t) => t.blocking).length, resolved: 0 }, threads: mine };
      }
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
