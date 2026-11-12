/**
 * Runs compiled Cypher on the project's Postgres index: a READ ONLY transaction with `SET LOCAL statement_timeout`
 * (2 s default), rows as arrays. JSON values come back like SQLite's: arrays / objects as JSON text, scalars as values,
 * so the hydration in cypher/index.ts is shared. Timeouts and write attempts map to the same Cypher errors.
 */
import type pg from 'pg';
import type { PostgresDb } from '../../../db/postgres.js';
import { VAR_LENGTH_ROW_BUDGET } from '../compile.js';
import { CypherError } from '../parser.js';
import { budgetError } from '../runner.js';
import type { SqlTarget } from '../target.js';
import { pgTarget } from './target.js';

/** jsonb arrays / objects as JSON text (like SQLite's json1), scalars as values. */
const asSqliteJson = (v: unknown): unknown => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v);

/**
 * `@b12` names → `$n` positions (order of first appearance). Quoted identifiers (`"x@b1"`, user aliases) and string
 * literals are copied as they are: only binds outside quotes are rewritten.
 */
export function positional(sql: string, binds: Record<string, unknown>): { text: string; values: unknown[] } {
  const order = new Map<string, number>();
  // A quoted run ("…" / '…', doubled quotes inside) or a bind.
  const text = sql.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|@(b\d+)\b/g, (m, name: string | undefined) => {
    if (!name) return m;
    if (!order.has(name)) order.set(name, order.size + 1);
    return `$${order.get(name)}`;
  });
  return { text, values: [...order.keys()].map((k) => binds[k] ?? null) };
}

export class PgCypherRunner {
  readonly target: SqlTarget;
  /** Variable-length expansion budget the compiler uses with this runner. */
  varLengthBudget = VAR_LENGTH_ROW_BUDGET;
  constructor(
    private readonly db: PostgresDb,
    private readonly timeoutMs = 2000,
  ) {
    this.target = pgTarget(db.dialect);
  }

  async run(sql: string, binds: Record<string, unknown>, explain = false): Promise<unknown[]> {
    const { text, values } = positional(explain ? `EXPLAIN ${sql}` : sql, binds);
    const c = await this.db.pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(this.timeoutMs))}`);
      const r = await c.query({ text, values, ...(explain ? {} : { rowMode: 'array' }) } as pg.QueryConfig);
      await c.query('COMMIT');
      return explain ? (r.rows as { 'QUERY PLAN': string }[]).map((x) => ({ detail: x['QUERY PLAN'] })) : (r.rows as unknown[][]).map((row) => row.map(asSqliteJson));
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code === '57014') throw new CypherError(`query timed out after ${this.timeoutMs} ms`, null, 'add labels, a $ref anchor or a smaller hop range', 'cypher_timeout');
      if (code === '22P02' && (e as Error).message.includes('CYPHER_BUDGET')) throw budgetError(this.varLengthBudget);
      if (code === '25006') throw new CypherError('only read statements are allowed', null, undefined, 'cypher_read_only');
      if (code === '2201B') throw new CypherError(`invalid regular expression: ${(e as Error).message}`, null);
      throw e;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {}
}
