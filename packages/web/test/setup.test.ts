import { describe, expect, it } from 'vitest';
import { modelConfigId, tildify } from '../src/setup/api';
import { limitError, pickChatModel } from '../src/setup/sections';
import { splitNdjson } from '../src/lib/ui';
import { cli } from '../src/auth';

describe('setup helpers', () => {
  it('validates Ask limits against their ranges', () => {
    expect(limitError('maxToolCalls', null)).toBeNull();
    expect(limitError('maxToolCalls', 12)).toBeNull();
    expect(limitError('maxToolCalls', 0)).toContain('Between 1 and 50');
    expect(limitError('maxToolCalls', 51)).not.toBeNull();
    expect(limitError('tokenBudget', 1999)).not.toBeNull();
    expect(limitError('timeoutMs', 600_000)).toBeNull();
    expect(limitError('maxOutputTokens', 12.5)).not.toBeNull();
  });
  it('prefers chat models over embedding models', () => {
    expect(pickChatModel(['nomic-embed-text:latest', 'llama3.1:8b'], 'nomic-embed-text:latest')).toBe('llama3.1:8b');
    expect(pickChatModel(['claude-sonnet', 'claude-haiku'], 'claude-haiku')).toBe('claude-haiku');
    expect(pickChatModel(['bge-m3'], null)).toBe('bge-m3');
    expect(pickChatModel([], null)).toBeNull();
  });
  it('formats paths and ids', () => {
    expect(tildify('/home/me/mandate', '/home/me')).toBe('~/mandate');
    expect(tildify('/home/meow/x', '/home/me')).toBe('/home/meow/x');
    expect(modelConfigId('openai-compatible', 'llama3.1:8b')).toBe('openai-compatible-llama3-1-8b');
    expect(cli('open')).toEqual({ npx: 'npx getmandate open', dev: 'npm run mandate -- open' });
  });
  it('splits NDJSON streams across chunk boundaries', () => {
    const a = splitNdjson('{"step":"init","status":"start"}\n{"step":"in');
    expect(a.items).toEqual([{ step: 'init', status: 'start' }]);
    const b = splitNdjson(`${a.rest}it","status":"done"}\nnot json\n\n`);
    expect(b.items).toEqual([{ step: 'init', status: 'done' }]);
    expect(b.rest).toBe('');
  });
});
