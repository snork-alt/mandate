/** defineTool plumbing for future write tools: agent identity, trailers, warnings passthrough, idempotency. */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { callTool, defineTool, inputJsonSchema, type ToolContext } from '../../src/mcp/define.js';

const ctx = (clientName?: string) => ({ storage: {}, index: null, reads: {}, clientName }) as unknown as ToolContext;

let writes = 0;
const tool = defineTool({
  name: 'test_write',
  title: 'Test write',
  kind: 'write',
  description: 'test',
  input: z.object({ id: z.string().min(1), feedback: z.string().optional() }).strict(),
  trailers: (a) => ({ Feedback: a.feedback }),
  run: async (a, c) => {
    writes++;
    return { id: a.id, commit: c.commit, ...(a.id === 'warn' ? { warnings: ['section has no summary'] } : {}) };
  },
});

describe('write tool plumbing', () => {
  it('adds agent / branch / idempotencyKey to the schema', () => {
    const js = inputJsonSchema(tool.input) as unknown as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(js.properties)).toEqual(['id', 'feedback', 'agent', 'branch', 'idempotencyKey', 'cause']);
    expect(js.additionalProperties).toBe(false);
  });

  it('resolves the agent (argument, else clientInfo name) and trailers', async () => {
    const a = await callTool(tool, { id: 'x', agent: 'claude', branch: 'feat/x', feedback: 'fb-0001' }, ctx('client'));
    expect((a.structuredContent as any).commit).toEqual({ agent: 'claude', branch: 'feat/x', trailers: { Feedback: 'fb-0001' } });
    const b = await callTool(tool, { id: 'x' }, ctx('client'));
    expect((b.structuredContent as any).commit.agent).toBe('client');
    const c = await callTool(tool, { id: 'x' }, ctx());
    expect((c.structuredContent as any).error).toMatchObject({ code: 'agent_required', path: 'agent' });
  });

  it('passes warnings through and defaults them to []', async () => {
    expect((await callTool(tool, { id: 'warn', agent: 'a' }, ctx())).structuredContent).toMatchObject({ warnings: ['section has no summary'] });
    expect((await callTool(tool, { id: 'ok', agent: 'a' }, ctx())).structuredContent).toMatchObject({ warnings: [] });
  });

  it('replays an idempotent retry and rejects a reused key with other arguments', async () => {
    const before = writes;
    const key = 'retry-key-0001';
    const r1 = await callTool(tool, { id: 'once', agent: 'a', idempotencyKey: key }, ctx());
    const r2 = await callTool(tool, { id: 'once', agent: 'a', idempotencyKey: key }, ctx());
    expect(r2).toEqual(r1);
    expect(writes).toBe(before + 1);
    const r3 = await callTool(tool, { id: 'other', agent: 'a', idempotencyKey: key }, ctx());
    expect((r3.structuredContent as any).error.code).toBe('idempotency_conflict');
    const bad = await callTool(tool, { id: 'x', agent: 'a', idempotencyKey: 'short' }, ctx());
    expect((bad.structuredContent as any).error.path).toBe('idempotencyKey');
  });

  it('rejects reserved inputs and non-object schemas at definition time', () => {
    expect(() => defineTool({ name: 'w', title: 'w', kind: 'write', description: 'w', input: z.object({ agent: z.string() }), run: async () => ({}) })).toThrow(/reserved/);
    expect(() => defineTool({ name: 'w', title: 'w', kind: 'write', description: 'w', input: z.string(), run: async () => ({}) })).toThrow(/z.object/);
  });
});
