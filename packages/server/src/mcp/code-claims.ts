/**
 * Claims about code carry repo + commit, checked here (verification_record, work_order_complete, code locations of
 * work_order_touch / section_done / touch_from_commits / git context, audit_start / audit_record_item / audit_recheck).
 * - repo: a code repo short name (project_info.codeRepos); an unknown one is registered automatically on first report.
 * - commit: 7-40 hex (schema); dirty: true = uncommitted changes on top of commit (linked on work_order_complete).
 * - A claim that differs from the session's declared code context (code_context_set) is accepted with a note.
 * In-process callers without project settings (seeds, tests, the Ask agent's own calls) are not checked.
 */
import { CODE_REPO_NAME_RE, cleanRemote, defaultCodeRepoName, codeContextLabel, parseNodeUri, touchedFromInput, type CodeClaim, type CodeRepo, type TouchedInput } from '@mandate/shared';
import type { ToolContext } from './define.js';
import { ToolError } from './errors.js';

/** Registered code repos, or null when this context does not check claims. */
export function registeredCodeRepos(ctx: ToolContext): CodeRepo[] | null {
  if (!ctx.settings) return null;
  return ctx.settings.codeRepos?.() ?? [];
}

/** A repo a call reports: its short name and, when the agent knows it, the remote URL. */
export type RepoReport = string | { repo: string; remote?: string | undefined };

/**
 * Check the repos (and the session-context match) of claims. `path` names the input for errors. Returns warnings.
 * An unknown repo short name is registered automatically (Mandate works through the agent, which has the code locally):
 * name validated, remote URL (credentials stripped) and who / when recorded. Only a malformed short name is refused
 * (`unknown_code_repo`).
 */
export async function checkCodeRepos(ctx: ToolContext, repos: RepoReport[], path: string): Promise<string[]> {
  const reg = registeredCodeRepos(ctx);
  if (!reg || !ctx.settings) return [];
  const reports = new Map<string, string | undefined>();
  for (const r of repos) {
    const name = typeof r === 'string' ? r : r.repo;
    const remote = typeof r === 'string' ? undefined : r.remote;
    if (!name) continue;
    reports.set(name, reports.get(name) ?? remote);
  }
  if (!reports.size) return [];
  const warnings: string[] = [];
  for (const [name, remote] of reports) {
    const known = reg.find((r) => r.name === name);
    const clean = cleanRemote(remote) ?? undefined;
    if (known && (!clean || known.remote === clean)) continue;
    if (!known && !CODE_REPO_NAME_RE.test(name)) {
      const suggest = defaultCodeRepoName(name);
      throw new ToolError('unknown_code_repo', `'${name}' is not a valid code repo short name`, `use a short name of lowercase letters, digits and dashes, usually the folder name of your checkout (e.g. '${suggest}'); pass the URL as remote, not as the name`, path);
    }
    if (!ctx.settings.registerCodeRepo) continue;
    const by = ctx.principal?.kind === 'user' ? ctx.principal.login : (ctx.commit?.agent ?? 'agent');
    const r = await ctx.settings.registerCodeRepo({ name, ...(clean ? { remote: clean } : {}) }, by);
    if (r.created) warnings.push(`code_repo_registered: '${name}' was registered for this project${clean ? ` (${clean})` : ''}; an admin can rename it or set its URL in Settings → Code repositories`);
  }
  return warnings;
}

/** Check one claim (repo registered on first report; note a mismatch with the declared session context). */
export async function checkClaim(ctx: ToolContext, claim: Pick<CodeClaim, 'repo' | 'commit' | 'dirty'> & { remote?: string | undefined }, path: string): Promise<string[]> {
  const warnings = await checkCodeRepos(ctx, [{ repo: claim.repo, remote: claim.remote }], `${path}.repo`);
  const cur = ctx.session?.codeContext;
  if (cur && registeredCodeRepos(ctx) && (cur.repo !== claim.repo || !sameSha(cur.commit, claim.commit) || !!cur.dirty !== !!claim.dirty)) {
    warnings.push(`code_context_mismatch: ${path} is ${codeContextLabel(claim)} but this session declared ${codeContextLabel(cur)}; recorded as given (call code_context_set after each commit or branch switch)`);
  }
  return warnings;
}

/** Short and full shas of the same commit. */
export const sameSha = (a: string, b: string) => a.length <= b.length ? b.startsWith(a) : a.startsWith(b);

/** `code_commit_required` (refused when code repos are registered; a warning when none are). */
export function requireCommit(ctx: ToolContext, message: string, hint: string, path: string): string[] {
  const reg = registeredCodeRepos(ctx);
  if (!reg) return [];
  if (!reg.length) return [`code_commit_missing: ${message} (accepted: no code repositories are registered yet)`];
  throw new ToolError('code_commit_required', message, `${hint}; no commit yet or uncommitted changes: flow_next { request, code: { dirty: true } } (or { noHead: true }) gives the exact commit step for the project's commit policy`, path);
}

/** Repo of a code location input: `repo:path#L..` string, `{ repo, ... }` object or a mandate://code/<repo>/... ref. */
export function repoOfLocation(loc: unknown): string | null {
  if (typeof loc === 'string') {
    const n = parseNodeUri(loc) as { kind?: string; repo?: string } | null;
    if (n?.kind === 'code' && n.repo) return n.repo;
    const m = /^@?(?:mandate:\/\/code\/)?([A-Za-z0-9_.-]+)[:/]/.exec(loc.trim());
    return m ? m[1]! : null;
  }
  if (loc && typeof loc === 'object' && typeof (loc as { repo?: unknown }).repo === 'string') return (loc as { repo: string }).repo;
  return null;
}

/**
 * Code locations (touched files / codeRefs): every repo registered; each entry carries a commit: its own `commits`,
 * the call's `code` claim for that repo (stamped on the entry; dirty = left open, linked on completion), or a commit
 * the call records for that repo (`committed`, e.g. git[].headCommit).
 */
export async function stampLocations(
  ctx: ToolContext,
  lists: { files: TouchedInput[] | undefined; path: string }[],
  code: CodeClaim | undefined,
  committed: Set<string> = new Set(),
): Promise<{ lists: (TouchedInput[] | undefined)[]; warnings: string[] }> {
  const all = lists.flatMap((l) => l.files ?? []);
  if (!all.length && !code) return { lists: lists.map((l) => l.files), warnings: [] };
  const warnings = [...(await checkCodeRepos(ctx, all.map((f) => repoOfLocation(f)).filter((r): r is string => !!r), lists[0]?.path ?? 'files')), ...(code ? await checkClaim(ctx, code, 'code') : [])];
  const out = lists.map((l) =>
    l.files?.map((f): TouchedInput => {
      const t = touchedFromInput(f);
      if (t.commits?.length || !code || code.repo !== t.repo || code.dirty) return f;
      return { ...t, commits: [code.commit] } as TouchedInput;
    }),
  );
  const missing = [...new Set(out.flatMap((l) => l ?? []).map(touchedFromInput).filter((t) => !t.commits?.length && !(code && code.repo === t.repo) && !committed.has(t.repo)).map((t) => t.repo))];
  if (missing.length) {
    warnings.push(
      ...requireCommit(
        ctx,
        `code locations in ${missing.join(', ')} carry no commit`,
        `pass code: { repo, commit } (the commit you worked on; uncommitted changes: dirty: true with the base commit), or commits on each file`,
        'code',
      ),
    );
  }
  return { lists: out, warnings };
}
