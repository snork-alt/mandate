/**
 * Work orders as markdown documents: `work-orders/<id>.md` (same doc format as specs and audits). Frontmatter: title,
 * spec + pinned specCommit (full sha), kind, status, priority, fastPath, dependencies, the current claim (agent, branch,
 * worktree, startedAt; heartbeats are NOT stored in git, they live in the server's runtime state) and past `claims`,
 * origin links (`reason` feedback ids, audit `findings`), createdBy / createdAt / updatedAt / completedAt, the code it
 * `touched` and its `git` context (branches, commits, PRs per code repo). Sections: `plan` (the implementation plan),
 * one `wo-section` per targeted spec section (meta: target, status, verifications, codeRefs, deviations; body:
 * implementation notes), `reconciliation` (what was updated in specs / components / code refs), `outcome` (summary on
 * completion) and, for migrated items, `history` (summary of the jsonl-era commits).
 *
 * The flat `WorkOrder` (index.ts) stays the projection every service and the UI lists use: `sections` there are the
 * targeted SPEC section ids with their status.
 */
import { z } from 'zod';
import { sectionSchema, touchedFileSchema, TOUCH_CHANGES, type TouchedFile } from '@mandate/doc';
import { idSchema, PRIORITIES, WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from './base.js';
import { docRefSchema, sectionRefSchema } from './read-schemas.js';
import { parseNodeUri, parseRef } from './refs.js';
import { codeClaimSchema, codeLinkSchema } from './code-context.js';
import { PLAN_STEP_STATUSES, planStepInputSchema, planStepSchema } from './plan-steps.js';

export { touchedFileSchema, TOUCH_CHANGES, type TouchedFile };

/** Sections every work order may have besides its `wo-section`s (markdown). */
export const WO_PLAN = 'plan';
export const WO_RECONCILIATION = 'reconciliation';
export const WO_OUTCOME = 'outcome';
export const WO_HISTORY = 'history';
export const WO_RESERVED_SECTIONS = [WO_PLAN, WO_RECONCILIATION, WO_OUTCOME, WO_HISTORY] as const;
/** Closed work orders: frozen except PR status / merge fields (409 `work_order_frozen`). */
export const FROZEN_WORK_ORDER_STATUSES = ['done', 'failed', 'cancelled'] as const;
/** How a past claim ended. */
export const CLAIM_END_REASONS = ['released', 'completed', 'failed', 'cancelled', 'taken_over', 'reclaimed', 'all_done'] as const;
export type ClaimEndReason = (typeof CLAIM_END_REASONS)[number];
export const PR_STATUSES = ['draft', 'open', 'merged', 'closed'] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

const sha = z.string().regex(/^[0-9a-f]{4,64}$/, 'a commit sha');
/** Code-repo shas given as input (MW-16): at least 7 characters (stored ones may be older and shorter). */
const inputSha = z.string().regex(/^[0-9a-f]{7,64}$/, 'a code commit sha (7-64 hex chars; may be short)');
const fullSha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character sha');

/** The claim as stored in git (no heartbeat: heartbeats live in the server's runtime state). */
export const storedClaimSchema = z.object({
  agent: z.string().min(1),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  startedAt: z.string().min(1),
});
export type StoredClaim = z.infer<typeof storedClaimSchema>;
/** A claim that ended (kept in `claims`, oldest first). */
export const pastClaimSchema = storedClaimSchema.extend({ endedAt: z.string().min(1), ended: z.enum(CLAIM_END_REASONS) });
export type PastClaim = z.infer<typeof pastClaimSchema>;

/** A pull request of a code repository. */
export const prSchema = z.object({
  url: z.string().min(1).optional(),
  number: z.number().int().min(1),
  status: z.enum(PR_STATUSES),
  /** The commit the PR was merged as (code repo). */
  mergedCommit: sha.optional(),
});
export type PullRequest = z.infer<typeof prSchema>;

/** Git context of a work order in one code repository. */
export const gitContextSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  baseCommit: sha.optional(),
  headCommit: sha.optional(),
  commits: z.array(sha).optional(),
  worktree: z.object({ path: z.string().min(1), host: z.string().min(1).optional() }).optional(),
  pr: prSchema.optional(),
  /** The branch the work was merged into (e.g. main). */
  mergedInto: z.string().min(1).optional(),
});
export type GitContext = z.infer<typeof gitContextSchema>;

/** A test the plan promises: its name or code ref, and the acceptance criteria (section ids of the spec) it proves. */
export const planTestSchema = z.object({
  name: z.string().trim().min(1).max(300),
  /** Where it will live: `repo:path#Lx-Ly` / `repo:path#symbol`, optional until written. */
  ref: z.string().trim().min(1).max(400).optional(),
  proves: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});
export type PlanTest = z.infer<typeof planTestSchema>;

/** Work-order frontmatter (server-maintained; agents write through the work_order_* tools). */
export const workOrderFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  spec: idSchema,
  /** The spec version the work order is pinned to (full sha). */
  specCommit: fullSha,
  kind: z.enum(WORK_ORDER_KINDS),
  status: z.enum(WORK_ORDER_STATUSES),
  priority: z.enum(PRIORITIES).optional(),
  /** Fast-path fix: kind `fix` with a single section; can be claimed without a plan. */
  fastPath: z.boolean().optional(),
  /** Tests promised by the plan, each mapped to the acceptance criteria it proves (checked at work_order_complete). */
  planTests: z.array(planTestSchema).optional(),
  /** The plan's steps as data (ids s1.. never reused; `planStepSeq` is the last id number given). Absent on older work orders: parsed from the plan text on read. */
  planSteps: z.array(planStepSchema).optional(),
  planStepSeq: z.number().int().optional(),
  /** Why the work order exists (free text; the plan lives in the `plan` section). */
  note: z.string().optional(),
  /** Work orders that must be done first (ids). */
  dependencies: z.array(idSchema).optional(),
  claim: storedClaimSchema.optional(),
  claims: z.array(pastClaimSchema).optional(),
  /** Feedback items this work order acts on. */
  reason: z.array(idSchema).default([]),
  /** Fix work orders: the audit findings it fixes. */
  findings: z.array(z.string().min(1)).optional(),
  createdBy: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  touched: z.array(touchedFileSchema).optional(),
  git: z.array(gitContextSchema).optional(),
  /** Claims made on uncommitted code (dirty) during this work order, linked to the commit that completed it. */
  codeLinks: z.array(codeLinkSchema).optional(),
});
export type WorkOrderFrontmatter = z.infer<typeof workOrderFrontmatterSchema>;
export const workOrderDocSchema = workOrderFrontmatterSchema.extend({ id: idSchema, sections: z.array(sectionSchema) });
/** A work order as stored: frontmatter + sections. */
export type StoredWorkOrderDoc = z.infer<typeof workOrderDocSchema>;

/** Fast path: a `fix` with exactly one targeted section and `fastPath: true` (no plan needed before claiming). */
export const isFastPath = (w: { kind: string; fastPath?: boolean; sections: unknown[] }, woSections = w.sections.length) => w.kind === 'fix' && w.fastPath === true && woSections === 1;

/* ---------------------------------------------------------------- touched / git merge (pure) */

/** Repo-relative, forward slashes, no `./`, no duplicate slashes; null when it escapes the repo. */
export function normalizeCodePath(p: string): string | null {
  const parts = p.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').split('/').filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

/** Merge line ranges (`N` / `N-M`): sorted, overlapping and adjacent ranges joined. */
export function mergeLineRanges(ranges: string[]): string[] {
  const rs = ranges
    .map((r) => r.split('-').map(Number))
    .filter(([a]) => Number.isFinite(a) && a! >= 1)
    .map(([a, b]) => [a!, Math.max(a!, Number.isFinite(b) ? b! : a!)] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const r of rs) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Merge touched files (idempotent): keyed by repo + normalized path; line ranges merged, symbols / commits unioned.
 * Change: `added` stays added when modified later, `deleted` wins, a rename keeps its `from` (a later change on the
 * renamed path keeps `renamed`). A rename also drops a plain entry of the old path (it moved).
 */
export function mergeTouched(existing: TouchedFile[], incoming: TouchedFile[]): TouchedFile[] {
  const out = existing.map((t) => ({ ...t }));
  const key = (t: { repo: string; path: string }) => `${t.repo}\u0000${t.path}`;
  for (const raw of incoming) {
    const path = normalizeCodePath(raw.path);
    if (!path) throw Object.assign(new Error(`invalid code path '${raw.path}' (repo-relative, no ..)`), { statusCode: 400, code: 'invalid_path' });
    const from = raw.from !== undefined ? normalizeCodePath(raw.from) : undefined;
    if (raw.from !== undefined && !from) throw Object.assign(new Error(`invalid code path '${raw.from}'`), { statusCode: 400, code: 'invalid_path' });
    if (raw.change === 'renamed' && !from) throw Object.assign(new Error(`${path}: a rename needs from (the previous path)`), { statusCode: 400, code: 'invalid_input' });
    const t: TouchedFile = { ...raw, path, ...(from ? { from } : {}) };
    if (t.change === 'renamed' && from) {
      const j = out.findIndex((x) => x.repo === t.repo && x.path === from);
      // added then renamed -> still added (at the new path); otherwise the rename keeps the original `from`.
      if (j >= 0) {
        const old = out[j]!;
        out.splice(j, 1);
        if (old.change === 'added') t.change = 'added';
        if (old.change === 'renamed' && old.from) t.from = old.from;
      }
    }
    const k = out.findIndex((x) => key(x) === key(t));
    if (k < 0) {
      out.push(clean(t));
      continue;
    }
    const cur = out[k]!;
    let change = t.change;
    if (cur.change === 'added' && t.change === 'modified') change = 'added';
    else if (cur.change === 'renamed' && t.change === 'modified') change = 'renamed';
    else if (cur.change === 'added' && t.change === 'renamed') change = 'added';
    out[k] = clean({
      repo: cur.repo,
      path: cur.path,
      lines: change === 'deleted' ? undefined : mergeLineRanges([...(cur.lines ?? []), ...(t.lines ?? [])]),
      symbols: uniq([...(cur.symbols ?? []), ...(t.symbols ?? [])]).sort(),
      change,
      from: change === 'renamed' ? (cur.from ?? t.from) : undefined,
      commits: uniq([...(cur.commits ?? []), ...(t.commits ?? [])]),
    });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

/** Drop empty arrays / undefined (the doc format prunes them; keeps round-trips stable). */
function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = Array.isArray(v) && k === 'lines' ? mergeLineRanges(v as string[]) : v;
  }
  return out as T;
}

/** Git fields an agent can report for one repo (merged into the work order's `git` list). */
export type GitContextPatch = Partial<Omit<GitContext, 'repo' | 'pr'>> & { repo: string; pr?: Partial<PullRequest> };

/** Merge a git context patch (idempotent): scalar fields replace, commits union (order kept), pr fields merge. */
export function mergeGit(existing: GitContext[], patch: GitContextPatch): GitContext[] {
  const out = existing.map((g) => ({ ...g }));
  const i = out.findIndex((g) => g.repo === patch.repo);
  const cur: GitContext = i >= 0 ? out[i]! : { repo: patch.repo };
  const pr = patch.pr ? { ...(cur.pr ?? {}), ...patch.pr } : cur.pr;
  if (pr && (pr.number === undefined || pr.status === undefined)) {
    throw Object.assign(new Error('pr needs number and status (draft|open|merged|closed) the first time it is recorded'), { statusCode: 400, code: 'invalid_input' });
  }
  const next = clean({
    ...cur,
    ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'commits' && k !== 'pr')),
    commits: uniq([...(cur.commits ?? []), ...(patch.commits ?? []), ...(patch.headCommit ? [patch.headCommit] : [])]),
    ...(pr ? { pr: clean(pr as Record<string, unknown>) as PullRequest } : {}),
  } as GitContext);
  if (i >= 0) out[i] = next;
  else out.push(next);
  return out;
}

/* ---------------------------------------------------------------- tool inputs */

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'single line');
const woRef = docRefSchema(['work-orders'], { sections: false });

/** A touched file as an agent reports it: `repo:path#Lx-Ly` or an object. */
export const touchedInputSchema = z.union([
  z
    .string()
    .trim()
    .max(600)
    .regex(/^([A-Za-z0-9_.-]+):([^#\s:][^#\s]*)(?:#L(\d+)(?:-L?(\d+))?)?$/, 'repo:path#Lx-Ly (e.g. app:src/auth/session.ts#L10-L40) or an object'),
  z
    .object({
      repo: line(200),
      path: line(500),
      lines: z.array(z.string().regex(/^\d+(?:-\d+)?$/, 'N or N-M')).max(100).optional(),
      symbols: z.array(line(200)).max(100).optional(),
      change: z.enum(TOUCH_CHANGES).default('modified'),
      from: line(500).optional(),
      commits: z.array(inputSha).max(200).optional(),
    })
    .strict(),
]);
export type TouchedInput = z.input<typeof touchedInputSchema>;
/** `repo:path#L10-L20` / object -> stored shape. */
export function touchedFromInput(t: TouchedInput): TouchedFile {
  if (typeof t === 'string') {
    const m = /^([A-Za-z0-9_.-]+):([^#\s:][^#\s]*)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(t.trim())!;
    return { repo: m[1]!, path: m[2]!, change: 'modified', ...(m[3] ? { lines: [m[4] ? `${m[3]}-${m[4]}` : m[3]] } : {}) };
  }
  return { ...t, change: t.change ?? 'modified' } as TouchedFile;
}

/** Git fields accepted by work_order_git_update and, optionally, by claim / heartbeat / section_done / complete. */
export const gitFieldsSchema = z
  .object({
    repo: line(200),
    branch: line(300).optional(),
    baseBranch: line(300).optional(),
    baseCommit: inputSha.optional(),
    headCommit: inputSha.optional(),
    commits: z.array(inputSha).max(500).optional(),
    worktree: z.object({ path: line(1000), host: line(300).optional() }).strict().optional(),
    pr: z.object({ url: line(1000).optional(), number: z.number().int().min(1).optional(), status: z.enum(PR_STATUSES).optional(), mergedCommit: inputSha.optional() }).strict().optional(),
    mergedInto: line(300).optional(),
  })
  .strict();
export type GitFieldsInput = z.input<typeof gitFieldsSchema>;

/** Optional extras of claim / heartbeat / section_done / complete: git context and touched code. */
export const woDeliveryExtras = {
  /** Git context per code repo (merged; see work_order_git_update). */
  git: z.array(gitFieldsSchema).max(10).optional(),
  /** Code touched (merged; see work_order_touch). */
  touched: z.array(touchedInputSchema).max(500).optional(),
};

export const workOrderPlanSetInputSchema = z
  .object({
    ref: woRef,
    /** The plan (markdown). Step lines `- [ ] **s1** text` keep their ids; a line without id is a new step (or matches a step with the same text). */
    plan: z.string().max(100_000).optional(),
    /** The steps as data (replaces the step lines of the plan): matched by id, new ones get ids; sections / proves link a step to the targets / criteria. */
    steps: z.array(planStepInputSchema).min(1).max(50).optional(),
  })
  .strict()
  .refine((v) => v.plan !== undefined || v.steps !== undefined, 'give plan and / or steps');
export const workOrderStepSetInputSchema = z
  .object({
    ref: woRef,
    /** One step id (`s2`), or several changes in one call. */
    step: z.string().regex(/^s\d+$/).optional(),
    status: z.enum(PLAN_STEP_STATUSES).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    codeRefs: z.array(touchedInputSchema).max(200).optional(),
    steps: z
      .array(
        z
          .object({ step: z.string().regex(/^s\d+$/), status: z.enum(PLAN_STEP_STATUSES), note: z.string().trim().min(1).max(2000).optional(), codeRefs: z.array(touchedInputSchema).max(200).optional() })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .strict()
  .refine((v) => (v.steps ? !v.step && !v.status : !!v.step && !!v.status), 'give step + status, or steps: [{ step, status }]');
export const workOrderTouchInputSchema = z
  .object({
    ref: woRef,
    /** The work-order section (spec section id or work-order section reference) the code belongs to. */
    section: z.string().trim().min(1).max(400).optional(),
    files: z.array(touchedInputSchema).min(1).max(500),
    /** Repo + commit (or dirty base) of files without their own commits. */
    code: codeClaimSchema.optional(),
  })
  .strict();
export const workOrderTouchFromCommitsInputSchema = z
  .object({
    ref: woRef,
    repo: line(200),
    section: z.string().trim().min(1).max(400).optional(),
    commits: z.array(inputSha).min(1).max(200).optional(),
    /** `base..head` (code repo revisions). */
    range: line(300).optional(),
  })
  .strict();
/** `branch` is the common write input (Branch trailer): work_order_git_update records it as the repo's branch. */
const { branch: _branch, ...gitUpdateFields } = gitFieldsSchema.shape;
export const workOrderGitUpdateInputSchema = z.object({ ref: woRef, ...gitUpdateFields }).strict();
export const workOrderSectionGetInputSchema = z
  .object({
    ref: sectionRefSchema(['work-orders']).optional(),
    doc: woRef.optional(),
    section: z.string().trim().min(1).max(120).optional(),
    at: z.string().regex(/^([0-9a-f]{4,40}|HEAD)$/, 'a commit sha or HEAD').optional(),
  })
  .strict();

/** A work-order section reference or a spec section id / reference -> the targeted spec section id (or the wo section id). */
export function woSectionKey(v: string): string {
  const r = parseRef(v);
  if (r?.sectionId) return r.sectionId;
  const n = parseNodeUri(v);
  return n && 'sectionId' in n && n.sectionId ? n.sectionId : v.trim();
}

/* ---------------------------------------------------------------- read payloads */

/** A comment thread on a work order (or one of its sections), as `work_order_get` / `comments_list` return it. */
export interface CommentView {
  id: string;
  uri: string;
  target: string;
  parent?: string;
  author: { agent: string; user?: string };
  body: string;
  mentions?: string[];
  blocking?: boolean;
  createdAt: string;
}
export interface CommentThread extends CommentView {
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  resolveNote?: string;
  /** Resolve / reopen records, oldest first. */
  events: { type: 'resolve' | 'reopen'; by: string; at: string; note?: string }[];
  replies: CommentView[];
}
export interface CommentCounts {
  open: number;
  openBlocking: number;
  resolved: number;
}
