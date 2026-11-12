/**
 * Read-only access to local CODE repositories (never the Mandate data repo), for `work_order_touch_from_commits`.
 * Mandate normally never reads code: this only works when the server runs on the developer's machine (local mode) and
 * the code repo was registered with `mandate connect` (recorded in `~/.mandate/wiring.json`, matched by folder name =
 * the repo name used in code refs). Otherwise the agent reports the files itself (work_order_touch).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mergeTouched, type TouchedFile } from '@mandate/shared';

const run = promisify(execFile);

/** Resolves a code repo name (as used in code refs, e.g. `app`) to a local checkout, or null. */
export type CodeRepoResolver = (repo: string) => string | null;

/** Repos wired to `project` by `mandate connect` (folder name = repo name). */
export function wiringResolver(mandateHome: string, project: string): CodeRepoResolver {
  return (repo) => {
    try {
      const m = JSON.parse(readFileSync(path.join(mandateHome, 'wiring.json'), 'utf8')) as { repos?: { repo: string; project: string }[] };
      const hit = (m.repos ?? []).find((r) => r.project === project && path.basename(r.repo) === repo && existsSync(path.join(r.repo, '.git')));
      return hit?.repo ?? null;
    } catch {
      return null;
    }
  };
}

const git = async (dir: string, args: string[]) => (await run('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** Files (with changed line ranges on the new side) and commits of the given commits or `base..head` range. */
export async function codeChanges(dir: string, repo: string, input: { commits?: string[]; range?: string }): Promise<{ commits: string[]; files: TouchedFile[] }> {
  const ok = (s: string) => /^[0-9A-Za-z._/~^@{}-]+$/.test(s) && !s.startsWith('-');
  let commits: string[] = [];
  if (input.range) {
    if (!/^[^\s.]+\.\.\.?[^\s.]+$/.test(input.range) || !input.range.split(/\.\.\.?/).every(ok)) throw Object.assign(new Error(`range must look like base..head`), { statusCode: 400, code: 'invalid_input' });
    commits = (await git(dir, ['rev-list', '--reverse', '--no-merges', input.range])).split('\n').filter(Boolean);
  }
  for (const c of input.commits ?? []) {
    if (!ok(c)) throw Object.assign(new Error(`invalid commit '${c}'`), { statusCode: 400, code: 'invalid_input' });
    const full = (await git(dir, ['rev-parse', '--verify', `${c}^{commit}`]).catch(() => '')).trim();
    if (!full) throw Object.assign(new Error(`commit ${c} is not in the local ${repo} checkout (fetch it first)`), { statusCode: 404, code: 'unknown_commit' });
    if (!commits.includes(full)) commits.push(full);
  }
  let files: TouchedFile[] = [];
  for (const sha of commits) {
    const status = await git(dir, ['show', '--format=', '--name-status', '-M', sha]);
    const lines = new Map<string, string[]>();
    let cur: string | null = null;
    for (const l of (await git(dir, ['show', '--format=', '-U0', '-M', '--no-color', sha])).split('\n')) {
      if (l.startsWith('+++ ')) cur = l === '+++ /dev/null' ? null : l.slice(6);
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m && cur) {
        const start = Number(m[1]);
        const n = m[2] === undefined ? 1 : Number(m[2]);
        if (n > 0) lines.set(cur, [...(lines.get(cur) ?? []), n === 1 ? `${start}` : `${start}-${start + n - 1}`]);
      }
    }
    const batch: TouchedFile[] = [];
    for (const row of status.split('\n').filter(Boolean)) {
      const [st, a, b] = row.split('\t') as [string, string, string | undefined];
      const p = st.startsWith('R') ? b! : a;
      const change: TouchedFile['change'] = st.startsWith('A') ? 'added' : st.startsWith('D') ? 'deleted' : st.startsWith('R') ? 'renamed' : 'modified';
      const l = change === 'deleted' ? [] : (lines.get(p) ?? []);
      batch.push({ repo, path: p, change, ...(st.startsWith('R') ? { from: a } : {}), ...(l.length ? { lines: l } : {}), commits: [sha] });
    }
    files = mergeTouched(files, batch);
  }
  return { commits, files };
}
