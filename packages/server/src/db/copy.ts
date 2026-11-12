/**
 * `mandate db copy`: copy the server state from one backend to another (SQLite → Postgres when moving a server to
 * shared state). Rows already in the target are kept (insert-or-ignore); `replace` empties the target tables first.
 * The search index is not copied: it is derived from git and rebuilt (and published) by the target server.
 */
import { SERVER_MIGRATIONS } from './state.js';
import { migrate } from './migrate.js';
import type { Db, SqlValue } from './types.js';

export const SERVER_TABLES = ['state_meta', 'sessions', 'github_tokens', 'agent_tokens', 'oauth_clients', 'oauth_tokens', 'oauth_codes', 'login_tokens', 'idempotency'] as const;

export async function copyServerState(from: Db, to: Db, opts: { replace?: boolean } = {}): Promise<Record<string, { read: number; written: number }>> {
  await migrate(from, 'server', SERVER_MIGRATIONS);
  await migrate(to, 'server', SERVER_MIGRATIONS);
  const out: Record<string, { read: number; written: number }> = {};
  await to.tx(async (q) => {
    for (const t of SERVER_TABLES) {
      const rows = await from.all<Record<string, unknown>>(`SELECT * FROM ${from.dialect.table(t)}`);
      if (opts.replace) await q.run(`DELETE FROM ${to.dialect.table(t)}`);
      let written = 0;
      for (const r of rows) {
        const cols = Object.keys(r);
        written += (await q.run(to.dialect.insertIgnore(t, cols), cols.map((c) => r[c] as SqlValue))).changes;
      }
      out[t] = { read: rows.length, written };
    }
  });
  return out;
}
