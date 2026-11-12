/**
 * Claim heartbeats are runtime state, NOT git history: a heartbeat every few minutes per agent would flood the data
 * repository with commits. They live in a small per-project SQLite file next to the search index
 * (`<index path>.runtime.sqlite`), or in memory (tests, in-memory index).
 *
 * Staleness: a claim's effective heartbeat is the latest of its `startedAt` (stored in git), the last runtime heartbeat
 * of the claiming agent and, as a grace period, the time this server process started. The grace applies only to claims
 * that were still fresh when the previous process was last alive (or when that is unknown: a fresh clone without the
 * runtime file, an in-memory store): agents get a full window to heartbeat again after downtime, but a claim that had
 * already gone stale before a restart stays stale (DF-3: frequent restarts never revive abandoned claims).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CLAIM_STALE_AFTER_MS, type StoredClaim } from '@mandate/shared';

export interface HeartbeatStore {
  /** When this store (server process) started (ms). */
  readonly startedAt: number;
  /** When the PREVIOUS process using this store was last alive (ms); undefined when unknown. */
  readonly previousAliveAt?: number;
  get(workOrder: string): { agent: string; at: string } | undefined;
  set(workOrder: string, agent: string, at: string): void;
  clear(workOrder: string): void;
  close?(): void;
}

export class MemoryHeartbeats implements HeartbeatStore {
  private readonly map = new Map<string, { agent: string; at: string }>();
  /** Mutable for tests (simulate a process that started long ago). */
  constructor(public startedAt = Date.now()) {}
  get(id: string) {
    return this.map.get(id);
  }
  set(id: string, agent: string, at: string) {
    this.map.set(id, { agent, at });
  }
  clear(id: string) {
    this.map.delete(id);
  }
}

/** Heartbeats in a SQLite file (survive restarts; never committed). */
export class SqliteHeartbeats implements HeartbeatStore {
  private readonly db: Database.Database;
  readonly previousAliveAt?: number;
  private readonly timer: NodeJS.Timeout;
  constructor(
    file: string,
    readonly startedAt = Date.now(),
  ) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS claim_heartbeats (work_order TEXT PRIMARY KEY, agent TEXT NOT NULL, at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const prev = this.db.prepare("SELECT value FROM runtime_meta WHERE key = 'alive_at'").get() as { value: string } | undefined;
    if (prev && Number.isFinite(Number(prev.value))) this.previousAliveAt = Number(prev.value);
    this.alive();
    // "Last alive" for the next process (decides whether a claim was still fresh when this one stopped).
    this.timer = setInterval(() => this.alive(), 60_000);
    this.timer.unref();
  }
  private alive() {
    try {
      this.db.prepare("INSERT INTO runtime_meta (key, value) VALUES ('alive_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
    } catch {
      /* closed */
    }
  }
  get(id: string) {
    return this.db.prepare('SELECT agent, at FROM claim_heartbeats WHERE work_order = ?').get(id) as { agent: string; at: string } | undefined;
  }
  set(id: string, agent: string, at: string) {
    this.db.prepare('INSERT INTO claim_heartbeats (work_order, agent, at) VALUES (?, ?, ?) ON CONFLICT(work_order) DO UPDATE SET agent = excluded.agent, at = excluded.at').run(id, agent, at);
  }
  clear(id: string) {
    this.db.prepare('DELETE FROM claim_heartbeats WHERE work_order = ?').run(id);
  }
  close() {
    clearInterval(this.timer);
    this.alive();
    this.db.close();
  }
}

/**
 * The effective heartbeat of a stored claim (ISO): max(startedAt, the agent's runtime heartbeat), plus the process start
 * as a grace period unless the claim was already stale when the previous process was last alive.
 */
export function effectiveHeartbeat(store: HeartbeatStore, workOrder: string, claim: StoredClaim): string {
  const hb = store.get(workOrder);
  const times = [Date.parse(claim.startedAt)];
  if (hb && hb.agent === claim.agent) times.push(Date.parse(hb.at));
  const last = Math.max(...times.filter((x) => Number.isFinite(x)));
  const staleBeforeRestart = store.previousAliveAt !== undefined && Number.isFinite(last) && store.previousAliveAt - last > CLAIM_STALE_AFTER_MS && last < store.startedAt;
  const t = staleBeforeRestart ? last : Math.max(...[last, store.startedAt].filter((x) => Number.isFinite(x)));
  return new Date(t).toISOString();
}
