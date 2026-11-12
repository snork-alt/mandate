/** A small durable idempotency store: completed write results by key, in one JSON file (pruned after 24 h). */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IdempotencyStore } from './define.js';

type Entry = { args: string; at: number; result: CallToolResult };
const TTL_MS = 24 * 3600_000;

export class FileIdempotencyStore implements IdempotencyStore {
  private entries: Record<string, Entry> = {};

  constructor(private readonly file: string) {
    try {
      this.entries = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
    } catch {
      this.entries = {};
    }
    this.prune();
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.entries)) if (now - v.at > TTL_MS) delete this.entries[k];
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries));
    renameSync(tmp, this.file);
  }

  get(key: string) {
    return this.entries[key];
  }
  set(key: string, entry: Entry) {
    this.prune();
    this.entries[key] = entry;
    this.save();
  }
  delete(key: string) {
    delete this.entries[key];
    this.save();
  }
}
