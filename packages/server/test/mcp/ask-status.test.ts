/** `ask` config block and the ask_status tool. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { askModelStatus, askStatus } from '../../src/ask/status.js';
import { DEFAULT_ASK_CONFIG, loadConfig, type AskModelConfig } from '../../src/config.js';
import { callTool, type ToolContext } from '../../src/mcp/define.js';
import { TOOLS } from '../../src/mcp/index.js';

type Entry = Partial<AskModelConfig> & { provider: AskModelConfig['provider'] };
const entry = (c: Entry): AskModelConfig => ({ id: 'm1', model: null, baseUrl: null, apiKeyEnv: null, ...c });

describe('askModelStatus', () => {
  const cases: [string, Entry, NodeJS.ProcessEnv, string[]][] = [
    ['anthropic, no key env (default model)', { provider: 'anthropic' }, {}, ['apiKey']],
    ['anthropic, key env named but unset', { provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY' }, {}, ['apiKey']],
    ['anthropic, key env empty', { provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { ANTHROPIC_API_KEY: '' }, ['apiKey']],
    ['anthropic complete', { provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { ANTHROPIC_API_KEY: 'sk-secret' }, []],
    ['openai-compatible without baseUrl', { provider: 'openai-compatible', model: 'llama3' }, {}, ['baseUrl']],
    ['openai-compatible local (no key needed)', { provider: 'openai-compatible', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }, {}, []],
    ['openai-compatible with key env unset', { provider: 'openai-compatible', model: 'gpt', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'OPENAI_API_KEY' }, {}, ['apiKey']],
    ['openai without key env', { provider: 'openai', model: 'gpt-x' }, {}, ['apiKey']],
    ['openai, key env unset', { provider: 'openai', model: 'gpt-x', apiKeyEnv: 'OPENAI_KEY' }, {}, ['apiKey']],
    ['openai without model', { provider: 'openai', apiKeyEnv: 'OPENAI_KEY' }, { OPENAI_KEY: 'sk-secret' }, ['model']],
    ['openai complete (baseUrl optional)', { provider: 'openai', model: 'gpt-x', apiKeyEnv: 'OPENAI_KEY' }, { OPENAI_KEY: 'sk-secret' }, []],
    ['google, key env unset', { provider: 'google', model: 'gemini-x', apiKeyEnv: 'GOOGLE_KEY' }, {}, ['apiKey']],
    ['google complete', { provider: 'google', model: 'gemini-x', apiKeyEnv: 'GOOGLE_KEY' }, { GOOGLE_KEY: 'sk-secret' }, []],
  ];
  for (const [name, c, env, missing] of cases) {
    it(name, () => {
      const s = askModelStatus(entry(c), env);
      expect(s.missing).toEqual(missing);
      expect(s.configured).toBe(missing.length === 0);
      expect(!!s.reason).toBe(missing.length > 0);
      expect(JSON.stringify(s)).not.toContain('sk-secret');
    });
  }

  it('reports the env var name, whether it is set and why not, never the key', () => {
    expect(askModelStatus(entry({ id: 'o', label: 'Opus', provider: 'anthropic', model: 'm', apiKeyEnv: 'K' }), { K: 'sk-secret' })).toEqual({
      id: 'o',
      label: 'Opus',
      provider: 'anthropic',
      model: 'm',
      apiKeyEnv: 'K',
      apiKeySet: true,
      configured: true,
      missing: [],
    });
    const off = askModelStatus(entry({ provider: 'anthropic', apiKeyEnv: 'K' }), {});
    expect(off).toMatchObject({ label: 'm1', model: 'claude-opus-5-5', configured: false, reason: 'set K (environment or ~/.mandate/secrets.env)' });
  });
});

describe('askStatus', () => {
  it('nothing configured', () => {
    expect(askStatus(DEFAULT_ASK_CONFIG, {})).toEqual({ configured: false, default: null, models: [], missing: ['provider', 'model'] });
  });

  it('lists every model with the default; configured when any model is', () => {
    const models = [entry({ id: 'a', provider: 'openai', model: 'x', apiKeyEnv: 'NOPE' }), entry({ id: 'b', provider: 'openai-compatible', model: 'l', baseUrl: 'http://localhost:1/v1' })];
    const s = askStatus({ default: 'a', models }, {});
    expect(s).toMatchObject({ configured: true, default: 'a', missing: [] });
    expect(s.models.map((m) => [m.id, m.configured])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(askStatus({ default: null, models: [models[0]!] }, {})).toMatchObject({ configured: false, default: 'a' });
  });

  it('is exposed as the ask_status tool', async () => {
    const tool = TOOLS.find((t) => t.name === 'ask_status')!;
    const ctx = { ask: { default: 'm1', models: [{ ...entry({ provider: 'anthropic', model: 'm', apiKeyEnv: 'MANDATE_TEST_STATUS_UNSET' }), apiKey: 'sk-secret' }] } } as unknown as ToolContext;
    const r = await callTool(tool, {}, ctx);
    expect(r.structuredContent).toMatchObject({ configured: true, default: 'm1', models: [{ id: 'm1', apiKeySet: true, configured: true }] });
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    const none = await callTool(tool, {}, {} as ToolContext);
    expect(none.structuredContent).toMatchObject({ configured: false, missing: ['provider', 'model'] });
    expect((await callTool(tool, { x: 1 }, ctx)).isError).toBe(true);
  });
});

describe('ask config block', () => {
  it('is added (no models) to an existing config file without touching other values', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-ask-'));
    try {
      const file = path.join(dir, 'config.json');
      const before = { dataDir: dir, server: { port: 4321, host: '127.0.0.1' }, embedding: { provider: 'none' } };
      writeFileSync(file, JSON.stringify(before, null, 2));
      const c = loadConfig({ MANDATE_CONFIG: file, HOME: dir });
      expect(c.ask).toEqual(DEFAULT_ASK_CONFIG);
      const after = JSON.parse(readFileSync(file, 'utf8'));
      // Also migrated: the legacy top-level dataDir becomes the project `default`.
      const { dataDir: _legacy, ...rest } = before;
      expect(after).toEqual({ ...rest, ask: { models: [] }, projects: [{ id: 'default', name: 'Default', dataDir: dir }] });
      // The key comes only from the named env var, held in memory.
      writeFileSync(file, JSON.stringify({ ...after, ask: { provider: 'anthropic', model: 'm', baseUrl: null, apiKeyEnv: 'MY_KEY' } }));
      const c2 = loadConfig({ MANDATE_CONFIG: file, HOME: dir, MY_KEY: 'sk-1' });
      expect(c2.ask.models).toMatchObject([{ id: 'default', provider: 'anthropic', apiKey: 'sk-1' }]);
      expect(readFileSync(file, 'utf8')).not.toContain('sk-1');
      writeFileSync(file, JSON.stringify({ ...after, ask: { provider: 'anthropic', model: 'm', baseUrl: null, apiKeyEnv: 'MY_KEY', apiKey: 'inline' } }));
      expect(() => loadConfig({ MANDATE_CONFIG: file, HOME: dir })).toThrow(/apiKey/);
      // The multi-model shape: one key per model, unknown default rejected.
      writeFileSync(file, JSON.stringify({ ...after, ask: { default: 'b', models: [{ id: 'a', provider: 'anthropic', apiKeyEnv: 'KA' }, { id: 'b', label: 'B', provider: 'openai', model: 'gpt-x', apiKeyEnv: 'KB' }] } }));
      const c3 = loadConfig({ MANDATE_CONFIG: file, HOME: dir, KA: 'sk-a' });
      expect(c3.ask.default).toBe('b');
      expect(c3.ask.models.map((m) => [m.id, m.apiKey])).toEqual([
        ['a', 'sk-a'],
        ['b', undefined],
      ]);
      expect(readFileSync(file, 'utf8')).not.toContain('sk-a');
      writeFileSync(file, JSON.stringify({ ...after, ask: { default: 'zz', models: [] } }));
      expect(() => loadConfig({ MANDATE_CONFIG: file, HOME: dir })).toThrow(/ask\.default: no model with id 'zz'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
