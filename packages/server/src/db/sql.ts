/** SQL text helpers shared by both drivers. */
import type { SqlValue } from './types.js';

export const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const cache = new Map<string, string>();

/**
 * `?` placeholders → `$1, $2, …` (Postgres). Skips string literals, quoted identifiers, comments and dollar-quoted
 * bodies; `??` is a literal `?` (jsonb operators). Results are cached per SQL text.
 */
export function toDollarParams(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const j = endOfQuoted(sql, i, c);
      out += sql.slice(i, j);
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '$' && /[A-Za-z_$]/.test(sql[i + 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const end = j < 0 ? sql.length : j + tag.length;
        out += sql.slice(i, end);
        i = end;
      } else {
        out += c;
        i++;
      }
    } else if (c === '?') {
      if (sql[i + 1] === '?') {
        out += '?';
        i += 2;
      } else {
        out += `$${++n}`;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(sql, out);
  return out;
}

function endOfQuoted(sql: string, i: number, q: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === q) {
      if (sql[j + 1] === q) j += 2;
      else return j + 1;
    } else j++;
  }
  return sql.length;
}

/** Driver-neutral params: booleans → 0/1, Uint8Array → Buffer. */
export function normalizeParams(params: readonly SqlValue[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((p) => (p === true ? 1 : p === false ? 0 : p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p));
}

/** A stable 64-bit-ish lock id is computed server-side (hashtextextended); this only bounds the key length. */
export function lockKey(key: string): string {
  if (!key || key.length > 512) throw new Error('lock key: 1-512 chars');
  return key;
}
