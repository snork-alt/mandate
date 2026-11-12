import { describe, expect, it } from 'vitest';
import { applyChanges, change, hasComments, jsonRemove, jsonSet, JsoncError, removeBlock, upsertBlock } from '../src/edits.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { capture, tempCtx, write } from './helpers.js';

describe('JSON merge', () => {
  const original = '{\n\t"theme": "dark",\n\t"mcpServers": {\n\t\t"other": { "command": "x" }\n\t}\n}\n';
  it('sets one key, keeping other keys, order and indentation', () => {
    const out = jsonSet('f', original, ['mcpServers', 'mandate-a'], { url: 'u' });
    const j = JSON.parse(out);
    expect(Object.keys(j)).toEqual(['theme', 'mcpServers']);
    expect(Object.keys(j.mcpServers)).toEqual(['other', 'mandate-a']);
    expect(out).toContain('\n\t"theme"');
    expect(out.endsWith('\n')).toBe(true);
  });
  it('removes the key and prunes parents it emptied', () => {
    const one = jsonSet('f', '{\n  "a": 1\n}\n', ['mcp', 'servers', 'mandate-a'], { url: 'u' });
    expect(jsonRemove('f', one, ['mcp', 'servers', 'mandate-a'])).toBe('{\n  "a": 1\n}\n');
  });
  it('round-trips a stringify-formatted file exactly', () => {
    const f = `${JSON.stringify({ x: [1, 2], mcpServers: { y: {} } }, null, 2)}\n`;
    expect(jsonRemove('f', jsonSet('f', f, ['mcpServers', 'mandate-p'], { a: 1 }), ['mcpServers', 'mandate-p'])).toBe(f);
  });
  it('refuses JSONC (comments would be lost)', () => {
    expect(hasComments('{ "a": "http://x" }')).toBe(false);
    expect(hasComments('{ // hi\n "a": 1 }')).toBe(true);
    expect(() => jsonSet('f', '{ /* c */ "a": 1 }', ['b'], 1)).toThrow(JsoncError);
  });
});

describe('marker blocks', () => {
  it('appends, replaces in place, and removes cleanly', () => {
    const base = '# Title\n\nUser text.\n';
    const one = upsertBlock(base, 'section', 'v1', 'html');
    expect(one).toContain('User text.\n\n<!-- mandate:begin section');
    const two = upsertBlock(`${one}\nMore user text.\n`, 'section', 'v2', 'html');
    expect(two).toContain('v2');
    expect(two).not.toContain('v1');
    expect(two).toContain('More user text.');
    expect(upsertBlock(two, 'section', 'v2', 'html')).toBe(two);
    expect(removeBlock(one, 'section', 'html')).toBe(base);
    expect(removeBlock(base, 'section', 'html')).toBe(base);
  });
  it('hash style for TOML / shell', () => {
    const t = upsertBlock('[x]\na = 1\n', 'mandate-p', '[mcp_servers.mandate-p]\nurl = "u"', 'hash');
    expect(t).toMatch(/# >>> mandate:begin mandate-p .*\n\[mcp_servers\.mandate-p\]/);
    expect(removeBlock(t, 'mandate-p', 'hash')).toBe('[x]\na = 1\n');
  });
});

describe('applyChanges', () => {
  it('dry-run prints the diff and writes nothing', () => {
    const ctx = tempCtx();
    const f = path.join(ctx.home, 'a.json');
    write(f, '{}\n');
    const out = capture();
    applyChanges([change(f, '{\n  "k": "mnd_proj_SECRETSECRETSECRET"\n}\n', 'test'), change(path.join(ctx.home, 'new.md'), 'x\n', 'new')], { dryRun: true, out, home: ctx.home });
    expect(readFileSync(f, 'utf8')).toBe('{}\n');
    expect(existsSync(path.join(ctx.home, 'new.md'))).toBe(false);
    expect(out.text()).toContain('would update ~/a.json');
    expect(out.text()).toContain('would create ~/new.md');
    expect(out.text()).not.toContain('SECRETSECRET');
  });
});
