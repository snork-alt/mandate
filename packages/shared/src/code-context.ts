/**
 * Code repositories of a project and the code context of claims about code.
 * - A project registers its CODE repositories (read-only for Mandate) by a stable short name (`web-app`), linked to a
 *   GitHub repo (`owner/repo`). Code refs use the short name only: `mandate://code/<name>/<path>[#La-Lb]`. Renaming the
 *   GitHub repo changes the link, never the name.
 * - Claims about code (verifications, work-order completion, code locations, audits) carry repo + commit; uncommitted
 *   work is `dirty: true` with the base commit ("at a1b2c3 + uncommitted changes").
 * - A session declares its code context (`code_context_set`); every write of that session is stamped with it
 *   (`Code-Context: web-app@a1b2c3d[+dirty]` commit trailer).
 */
import { z } from 'zod';

/** Short name of a code repository: lowercase letters, digits and single dashes (max 60). */
export const CODE_REPO_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CODE_REPO_NAME_MAX = 60;
export const codeRepoNameSchema = z.string().trim().max(CODE_REPO_NAME_MAX).regex(CODE_REPO_NAME_RE, 'lowercase letters, digits and dashes (e.g. web-app)');
/** `owner/repo` on GitHub. */
export const GITHUB_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** A registered code repository of a project. */
export const codeRepoSchema = z
  .object({
    name: codeRepoNameSchema,
    github: z.string().regex(GITHUB_REPO_RE, 'owner/repo'),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CodeRepo = z.infer<typeof codeRepoSchema>;

/** Default short name of a GitHub repo: its name, slugified. */
export function defaultCodeRepoName(github: string): string {
  const name = github.split('/').pop() ?? github;
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, CODE_REPO_NAME_MAX)
      .replace(/-+$/, '') || 'repo'
  );
}

/** Problems of a code repo list (empty = valid): slug names, unique names and repos, not the specs repo. */
export function codeRepoProblems(list: { name: string; github: string }[], specsRepo?: string | null): { index: number; field: 'name' | 'github'; message: string }[] {
  const out: { index: number; field: 'name' | 'github'; message: string }[] = [];
  const names = new Map<string, number>();
  const repos = new Map<string, number>();
  list.forEach((r, i) => {
    if (!CODE_REPO_NAME_RE.test(r.name) || r.name.length > CODE_REPO_NAME_MAX) out.push({ index: i, field: 'name', message: `'${r.name}': short names use lowercase letters, digits and dashes` });
    else if (names.has(r.name)) out.push({ index: i, field: 'name', message: `${r.name} is already used by ${list[names.get(r.name)!]!.github}. Short names must be unique.` });
    else names.set(r.name, i);
    const g = r.github.toLowerCase();
    if (!GITHUB_REPO_RE.test(r.github)) out.push({ index: i, field: 'github', message: `'${r.github}' is not owner/repo` });
    else if (specsRepo && g === specsRepo.toLowerCase()) out.push({ index: i, field: 'github', message: `${r.github} is the specs repository; it can't also be a code repository` });
    else if (repos.has(g)) out.push({ index: i, field: 'github', message: `${r.github} is already linked as ${list[repos.get(g)!]!.name}` });
    else repos.set(g, i);
  });
  return out;
}

/** A code commit sha (7..40 hex; short shas allowed). */
export const codeShaSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{7,40}$/, 'a code commit sha (7-40 hex chars)');

/** Repo + commit of a claim about code. dirty: uncommitted changes on top of `commit` (the base). */
export const codeClaimSchema = z
  .object({
    /** Short name of the code repo (project_info.codeRepos). */
    repo: z.string().trim().min(1).max(200),
    commit: codeShaSchema,
    branch: z.string().trim().min(1).max(200).regex(/^[^\s]+$/, 'no whitespace').optional(),
    /** Uncommitted changes on top of commit (linked to the final commit when the work order completes). */
    dirty: z.boolean().optional(),
  })
  .strict();
export type CodeClaim = z.infer<typeof codeClaimSchema>;

/** The session's declared code context (`code_context_set`). */
export const codeContextSetInputSchema = codeClaimSchema;
export interface CodeContext extends CodeClaim {
  /** When it was declared (ISO). */
  at: string;
}

/** Commit trailer stamped on every write of a session that declared its code context. */
export const CODE_CONTEXT_TRAILER = 'Code-Context';

/** `web-app@a1b2c3d` / `web-app@a1b2c3d+dirty`. */
export function codeContextLabel(c: Pick<CodeClaim, 'repo' | 'commit' | 'dirty'>): string {
  return `${c.repo}@${c.commit.slice(0, 7)}${c.dirty ? '+dirty' : ''}`;
}

/** A dirty claim resolved to the commit that completed the work order. */
export const codeLinkSchema = z.object({
  /** The record (e.g. mandate://verifications/vr-0003) or `touched` for the work order's own code locations. */
  ref: z.string().min(1),
  repo: z.string().min(1),
  /** The base commit the dirty claim was made at. */
  base: z.string().min(4),
  /** The commit that contains the work. */
  commit: z.string().min(4),
});
export type CodeLink = z.infer<typeof codeLinkSchema>;
