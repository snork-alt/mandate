/**
 * Who wrote recently (`mandate doctor`, Settings, MCP `writers_recent`): recent commits grouped by user, agent and
 * credential, so unattributed (older agent-only) and service-account writes are visible.
 */
import { SERVICE_USER_PREFIX, userOfTrailers, type WritersResponse } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { parseCommitMessage } from './history.js';

export async function recentWriters(git: Pick<GitStore, 'log'>, limit = 500): Promise<WritersResponse> {
  const commits = await git.log(limit).catch(() => []);
  const groups = new Map<string, WritersResponse['writers'][number]>();
  let unattributed = 0;
  let service = 0;
  for (const c of commits) {
    const { trailers } = parseCommitMessage(c.message);
    const find = (k: string) => Object.entries(trailers).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1] ?? null;
    const user = userOfTrailers(trailers) ?? null;
    const agent = find('Agent') ?? c.author.replace(/ <.*>$/, '');
    const source = find('Agent-Key');
    if (!user) unattributed++;
    if (user?.startsWith(SERVICE_USER_PREFIX)) service++;
    const key = `${user ?? ''}\u0000${agent ?? ''}\u0000${source ?? ''}`;
    const g = groups.get(key);
    if (g) {
      g.commits++;
      if (c.date > g.last) g.last = c.date;
    } else groups.set(key, { user, agent, source, commits: 1, last: c.date });
  }
  return { writers: [...groups.values()].sort((a, b) => b.last.localeCompare(a.last)), unattributed, service, scanned: commits.length };
}
