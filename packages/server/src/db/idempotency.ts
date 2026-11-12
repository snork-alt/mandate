/**
 * Durable idempotency results of write tools in the server-state database (`idempotency`, keyed by project + key,
 * 24 h). Several server instances on one Postgres replay each other's results. A project's legacy
 * `<index>.idempotency.json` is imported once.
 */
import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IdempotencyStore } from '../mcp/define.js';
import type { ServerState } from './state.js';

type Entry = { args: string; at: number; result: CallToolResult };
const TTL_MS = 24 * 3600_000;

export class DbIdempotencyStore implements IdempotencyStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly state: ServerState,
    private readonly project: string,
    legacyFile?: string,
  ) {
    this.ready = legacyFile ? this.importLegacy(legacyFile).catch(() => undefined) : Promise.resolve();
  }

  private async importLegacy(file: string): Promise<void> {
    const key = `import:idempotency:${this.project}`;
    if (await this.state.meta(key)) return;
    let entries: Record<string, Entry> = {};
    try {
      entries = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
    } catch {
      entries = {};
    }
    const d = this.state.db.dialect;
    const now = Date.now();
    await this.state.db.tx(async (q) => {
      for (const [k, v] of Object.entries(entries)) {
        if (!v || now - v.at > TTL_MS) continue;
        await q.run(d.insertIgnore('idempotency', ['project', 'key', 'args', 'at', 'result']), [this.project, k, v.args, v.at, JSON.stringify(v.result)]);
      }
      await this.state.setMeta(key, new Date(now).toISOString(), q);
    });
  }

  async get(key: string): Promise<Entry | undefined> {
    await this.ready;
    const r = await this.state.db.get<{ args: string; at: number; result: string }>(`SELECT args, at, result FROM ${this.state.t('idempotency')} WHERE project = ? AND key = ? AND at > ?`, [this.project, key, Date.now() - TTL_MS]);
    if (!r) return undefined;
    try {
      return { args: r.args, at: Number(r.at), result: JSON.parse(r.result) as CallToolResult };
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: Entry): Promise<void> {
    await this.ready;
    const d = this.state.db.dialect;
    await this.state.db.run(d.upsert('idempotency', ['project', 'key', 'args', 'at', 'result'], ['project', 'key'], ['args', 'at', 'result']), [this.project, key, entry.args, entry.at, JSON.stringify(entry.result)]);
  }

  async delete(key: string): Promise<void> {
    await this.state.db.run(`DELETE FROM ${this.state.t('idempotency')} WHERE project = ? AND key = ?`, [this.project, key]);
  }
}
