import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** All references must come from the shared builders in @mandate/shared/refs. */
const ROOT = path.resolve(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('reference literals', () => {
  it('no web source hand-assembles mandate:// URIs', () => {
    const offenders = files(ROOT).filter((f) => readFileSync(f, 'utf8').includes('mandate://'));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
