/** No circular runtime imports inside @mandate/shared (an ESM cycle evaluates a re-exported module before its dependency). */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');

/** Relative runtime imports / re-exports of a module (`import type` and `export type` are erased and cannot cycle). */
function deps(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+'(\.\/[^']+)';/gms)) {
    if (m[2]) continue;
    out.push(m[3]!.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
  }
  return out;
}

describe('@mandate/shared module graph', () => {
  it('has no circular runtime imports', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    const graph = new Map(files.map((f) => [f, deps(f)]));
    const cycles: string[] = [];
    const visit = (f: string, stack: string[]) => {
      if (stack.includes(f)) {
        cycles.push([...stack.slice(stack.indexOf(f)), f].join(' -> '));
        return;
      }
      for (const d of graph.get(f) ?? []) visit(d, [...stack, f]);
    };
    for (const f of files) visit(f, []);
    expect([...new Set(cycles)]).toEqual([]);
  });

  it('loads fresh from the built package in a new process (no TDZ errors at import time)', () => {
    const dist = path.resolve(__dirname, '../dist/index.js');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(dist)}); console.log(JSON.stringify([m.PRIORITIES, typeof m.specUpdateMetaInputSchema.parse, typeof m.specListInputSchema.parse]))`], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([['p0', 'p1', 'p2', 'p3'], 'function', 'function']);
  });
});
