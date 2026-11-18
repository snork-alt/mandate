import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_AGENTS, unsupportedAgentMessage } from '../../shared/src/supported-agents.js';
import { AGENTS, detectAgents } from '../src/agents.js';
import { pickAgents, supportedAgents } from '../src/install.js';
import { parseArgs } from '../src/args.js';
import { tempCtx } from './helpers.js';

const args = (...a: string[]) => parseArgs(['connect', ...a]);

describe('only Claude Code is supported (SUPPORTED_AGENTS)', () => {
  it('the switch lists claude-code only and the rest of the registry stays defined', () => {
    expect([...SUPPORTED_AGENTS]).toEqual(['claude-code']);
    expect(supportedAgents().map((a) => a.id)).toEqual(['claude-code']);
    expect(AGENTS.length).toBeGreaterThan(1);
  });

  it('detection and --all only see Claude Code, even when other agents are installed', () => {
    const ctx = tempCtx();
    for (const d of ['.claude', '.codex', '.cursor', '.gemini']) mkdirSync(path.join(ctx.home, d), { recursive: true });
    expect(detectAgents(ctx).map((a) => a.id)).toEqual(['claude-code']);
    expect(detectAgents(ctx, ['claude-code', 'codex']).map((a) => a.id)).toContain('codex');
    expect(detectAgents(ctx).every((a) => a.id === 'claude-code')).toBe(true);
    expect(pickAgents(ctx, args('--all')).map((a) => a.id)).toEqual(['claude-code']);
  });

  it('--agents <other> is refused; a supported one next to it still works (with a message)', () => {
    const ctx = tempCtx();
    expect(() => pickAgents(ctx, args('--agents', 'codex'))).toThrow(/not supported yet: Mandate currently supports Claude Code/);
    const lines: string[] = [];
    const picked = pickAgents(ctx, args('--agents', 'claude-code,codex,cursor'), { log: (l: string) => lines.push(l) });
    expect(picked.map((a) => a.id)).toEqual(['claude-code']);
    expect(lines.join('\n')).toMatch(/Codex: not supported yet/);
    expect(unsupportedAgentMessage('Codex')).toContain('Claude Code');
  });

  it('uninstall (cleanup) still resolves every agent; listing an agent in the switch re-enables it', () => {
    const ctx = tempCtx();
    expect(pickAgents(ctx, args('--all'), undefined, ['claude-code'], true).length).toBe(AGENTS.length);
    expect(pickAgents(ctx, args('--agents', 'codex'), undefined, ['claude-code'], true).map((a) => a.id)).toEqual(['codex']);
    expect(pickAgents(ctx, args('--agents', 'codex'), undefined, ['claude-code', 'codex']).map((a) => a.id)).toEqual(['codex']);
    expect(supportedAgents(['claude-code', 'codex']).map((a) => a.id)).toEqual(['claude-code', 'codex']);
  });
});
