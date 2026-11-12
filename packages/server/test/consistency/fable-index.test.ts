/**
 * The "Fable scenarios → tests" index (plans/fable-data-review.md, last section): every finding marked fixed has a
 * test whose name starts with `<ID>:` somewhere under packages/server/test or packages/web.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const REVIEW = path.join(ROOT, 'plans/fable-data-review.md');
const TEST_DIRS = ['packages/server/test', 'packages/web/test', 'packages/web/src'].map((d) => path.join(ROOT, d));
const ID = String.raw`(?:D-[A-Z]+\d+x?|G-\d+|GQ-\d+|L-\d+|MW-\d+|DF-\d+)`;

function testFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Ids that have a test named `<ID>: ...` (it / test, any modifier). */
function testedIds(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = new RegExp(String.raw`\b(?:it|test)(?:\.\w+)?\(\s*['"\`](${ID}):`, 'g');
  for (const f of TEST_DIRS.flatMap((d) => testFiles(d))) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), path.relative(ROOT, f)]);
  }
  return out;
}

/** Rows of the index table: id -> status. */
function indexRows(): { id: string; status: string }[] {
  const text = readFileSync(REVIEW, 'utf8');
  const at = text.indexOf('\n## Fable scenarios → tests');
  expect(at, 'plans/fable-data-review.md has a "Fable scenarios → tests" section').toBeGreaterThan(0);
  const section = text.slice(at + 1).split(/\n## /)[0]!;
  const row = new RegExp(String.raw`^\|\s*(${ID})\s*\|\s*([a-z-]+(?: [a-z-]+)?)\s*\|`, 'gm');
  return [...section.matchAll(row)].map((m) => ({ id: m[1]!, status: m[2]! }));
}

describe('Fable scenarios index', () => {
  it('lists every finding once, with a known status', () => {
    const rows = indexRows();
    expect(rows.length).toBeGreaterThan(100);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) expect(['fixed', 'not fixed', 'data-only', 'pending'], r.id).toContain(r.status);
    // Every id family of the review is present.
    for (const p of ['D-', 'G-', 'GQ-', 'L-', 'MW-', 'DF-']) expect(ids.some((i) => i.startsWith(p)), p).toBe(true);
  });

  it('every finding marked fixed has a test whose name starts with "<ID>:"', () => {
    const tested = testedIds();
    const missing = indexRows()
      .filter((r) => r.status === 'fixed' && !tested.has(r.id))
      .map((r) => r.id);
    expect(missing, 'fixed findings without a test named "<ID>: ..."').toEqual([]);
  });
});
