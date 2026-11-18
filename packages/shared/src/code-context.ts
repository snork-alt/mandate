/**
 * Code repositories of a project and the code context of claims about code.
 * - A project's CODE repositories are known by a stable short name (`web-app`). Mandate works through the agent, which
 *   has the code locally: the first time an agent reports an unknown short name it is registered automatically
 *   (optional `remote` URL the agent reports; who / when recorded). Older projects may link a GitHub repo
 *   (`owner/repo`). Code refs use the short name only: `mandate://code/<name>/<path>[#La-Lb]`.
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
    /** Legacy: `owner/repo` linked at project setup. */
    github: z.string().regex(GITHUB_REPO_RE, 'owner/repo').optional(),
    /** Remote URL as the agent reported it (`git remote get-url origin`, credentials stripped); optional. */
    remote: z.string().trim().min(1).max(500).optional(),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    /** Registered automatically when an agent first reported it (who / when). */
    auto: z.boolean().optional(),
    registeredBy: z.string().max(200).optional(),
    registeredAt: z.string().max(40).optional(),
  })
  .strict();
export type CodeRepo = z.infer<typeof codeRepoSchema>;

/** A remote URL an agent may report (`git remote get-url origin`). */
export const codeRemoteSchema = z.string().trim().min(1).max(500).regex(/^(https?:\/\/|ssh:\/\/|git:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:)\S+$/, 'a git remote URL');

/** A remote URL without credentials (`https://token@host/..` -> `https://host/..`), or null when it is not a usable URL. */
export function cleanRemote(raw: string | undefined | null): string | null {
  const r = codeRemoteSchema.safeParse(raw ?? '');
  if (!r.success) return null;
  return r.data.replace(/^([a-z+]+:\/\/)[^/@\s]*@/i, '$1');
}

/** Browsable web URL of a remote or `owner/repo` GitHub link (github.com only); null = no known remote, show the path only. */
export function codeRepoWebUrl(r: { github?: string | undefined; remote?: string | undefined }): string | null {
  if (r.github && GITHUB_REPO_RE.test(r.github)) return `https://github.com/${r.github}`;
  const remote = cleanRemote(r.remote);
  if (!remote) return null;
  const m = /^(?:https?:\/\/|ssh:\/\/(?:[^/@]+@)?|git:\/\/|[A-Za-z0-9_.-]+@)(github\.com)[:/]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(remote);
  if (m) return `https://github.com/${m[2]}/${m[3]}`;
  return /^https?:\/\//i.test(remote) ? remote.replace(/\.git\/?$/, '') : null;
}

/** Web link to a file of a code repo (at a commit when given), or null without a known remote. */
export function codeFileWebUrl(r: { github?: string | undefined; remote?: string | undefined }, path: string, ref?: string): string | null {
  const base = codeRepoWebUrl(r);
  return base && /github\.com/i.test(base) ? `${base}/blob/${ref ?? 'HEAD'}/${path.replace(/^\/+/, '')}` : null;
}

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
export function codeRepoProblems(list: { name: string; github?: string | undefined }[], specsRepo?: string | null): { index: number; field: 'name' | 'github'; message: string }[] {
  const out: { index: number; field: 'name' | 'github'; message: string }[] = [];
  const names = new Map<string, number>();
  const repos = new Map<string, number>();
  list.forEach((r, i) => {
    if (!CODE_REPO_NAME_RE.test(r.name) || r.name.length > CODE_REPO_NAME_MAX) out.push({ index: i, field: 'name', message: `'${r.name}': short names use lowercase letters, digits and dashes` });
    else if (names.has(r.name)) out.push({ index: i, field: 'name', message: `${r.name} is already used by ${list[names.get(r.name)!]!.github ?? 'another repository'}. Short names must be unique.` });
    else names.set(r.name, i);
    if (!r.github) return;
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
    /** Short name of the code repo (project_info.codeRepos; a new name is registered automatically). */
    repo: z.string().trim().min(1).max(200),
    commit: codeShaSchema,
    branch: z.string().trim().min(1).max(200).regex(/^[^\s]+$/, 'no whitespace').optional(),
    /** Uncommitted changes on top of commit (linked to the final commit when the work order completes). */
    dirty: z.boolean().optional(),
  })
  .strict();
export type CodeClaim = z.infer<typeof codeClaimSchema>;

/** The session's declared code context (`code_context_set`). */
/** `remote`: `git remote get-url origin`, when you know it (registers the repo with a link; optional). */
export const codeContextSetInputSchema = codeClaimSchema.extend({ remote: z.string().trim().max(500).optional() });
export interface CodeContext extends CodeClaim {
  remote?: string | undefined;
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
