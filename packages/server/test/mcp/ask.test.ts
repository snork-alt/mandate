/** Ask: answer parsing, the AI SDK agent loop with a mock model, read-only enforcement, limits, abort, not configured, streaming. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_NOTIFICATION, parseAnswer, type AskEvent, type AskResult } from '@mandate/shared';
import { ASK_EXCLUDED_TOOLS, askToolset } from '../../src/mcp/tools/ask.js';
import { TOOLS } from '../../src/mcp/index.js';
import { describeTool, type ToolContext } from '../../src/mcp/define.js';
import { askSystemPrompt, cachedAskModel, clearAskModelCache, ConversationStore, createAskModel, liveAskConfig, runAsk, type AskModel } from '../../src/ask/index.js';
import { askConfigSchema, type AskModelConfig, type ResolvedAskConfig } from '../../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, mcpFixture, serveProjects, type McpFixture } from './fixture.js';
import { DocViewService } from '../../src/storage/views.js';
import { lastToolResults, ScriptedModel, userText, type Script } from './mock-model.js';

let fx: McpFixture;
const apps: FastifyInstance[] = [];
const clients: { close(): Promise<void> }[] = [];
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  for (const a of apps) await a.close();
  await fx?.close();
});

type AskCfg = Partial<ResolvedAskConfig>;
const entry = (m: Partial<AskModelConfig> & { id: string; provider: AskModelConfig['provider'] }): AskModelConfig => ({ model: null, baseUrl: null, apiKeyEnv: null, ...m });

/**
 * A separate /mcp app on the fixture data with a given ask config and either one scripted model for every choice,
 * or a factory per configured entry (`perModel`: configuration checks apply).
 */
async function askApp(script: Script | null, askCfg: AskCfg = {}, perModel?: (m: AskModelConfig) => AskModel) {
  const model = script ? new ScriptedModel(script) : undefined;
  const served = await serveProjects({
    ask: {
      storage: fx.storage,
      index: fx.index,
      reads: fx.reads,
      views: new DocViewService(fx.storage),
      ask: { default: null, models: [], ...askCfg },
      conversations: new ConversationStore(),
      ...(perModel ? { askModel: perModel } : model ? { askModel: model } : {}),
    },
  });
  apps.push(served.app);
  const client = await connect(served.url('ask'), 'ask-test');
  clients.push(client);
  const events: AskEvent[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === ASK_NOTIFICATION) events.push(n.params as unknown as AskEvent);
  };
  const ask = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: 'ask', arguments: args });
    return { isError: !!r.isError, body: r.structuredContent as Record<string, any> };
  };
  /** Events arrive as notifications; wait until `done`. */
  const settled = async () => {
    for (let i = 0; i < 80 && !events.some((e) => e.type === 'done'); i++) await new Promise((x) => setTimeout(x, 25));
    return events;
  };
  return { model, client, events, ask, settled };
}

const ANSWER = `Refresh tokens rotate on every use ([rotation](mandate://specs/user-sessions/sections/ac-refresh-rotates)), see also mandate://standards/security-baseline and [a ghost](mandate://specs/no-such-spec).

\`\`\`mandate-embed
ref: mandate://specs/user-sessions/sections/ac-refresh-rotates
\`\`\`

\`\`\`mandate-table
{"columns": ["spec", "symbols"], "rows": [["mandate://specs/login-sso", 4]]}
\`\`\`

\`\`\`mandate-graph
ref: mandate://specs/login-sso
ref: mandate://standards/security-baseline
depth: 2
\`\`\`

\`\`\`mandate-embed
nope
\`\`\``;

describe('answer parsing', () => {
  it('collects links, bare refs, embeds and table cells; flags invalid embeds', () => {
    const { embeds, refs } = parseAnswer(ANSWER);
    expect(refs.sort()).toEqual(
      ['mandate://specs/login-sso', 'mandate://specs/no-such-spec', 'mandate://specs/user-sessions/sections/ac-refresh-rotates', 'mandate://standards/security-baseline'].sort(),
    );
    expect(embeds.map((e) => e.kind)).toEqual(['mandate-embed', 'mandate-table', 'mandate-graph', 'invalid']);
    expect(embeds[2]).toMatchObject({ refs: ['mandate://specs/login-sso', 'mandate://standards/security-baseline'], depth: 2 });
    expect(parseAnswer('```mandate-table\nnot json\n```').embeds[0]).toMatchObject({ kind: 'invalid', block: 'mandate-table' });
    expect(parseAnswer('[x](@mandate:mandate://specs/login-sso@abc1234/sections/auth-flow#L1-L3).').refs).toEqual(['mandate://specs/login-sso@abc1234/sections/auth-flow#L1-L3']);
  });
});

describe('agent loop', () => {
  it('runs read tools, streams progress and checks every reference', async () => {
    const t = await askApp((_req, step) =>
      step === 1
        ? {
            text: 'Let me look.',
            toolCalls: [
              { id: 'c1', name: 'search', input: { q: 'refresh token rotation', limit: 3 } },
              { id: 'c2', name: 'graph_query', input: { query: 'MATCH (d:Spec)-[:HAS_SECTION]->(s) RETURN d.ref, count(s) AS n ORDER BY n DESC LIMIT 3' } },
            ],
          }
        : { text: ANSWER },
    );
    const r = await t.ask({ question: 'How do refresh tokens work?', context: ['@mandate:mandate://specs/user-sessions'] });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const res = r.body as AskResult;
    expect(res.stopReason).toBe('done');
    expect(res.answer).toBe(ANSWER);
    expect(res.provider).toBe('fake');
    expect(res.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['search', true],
      ['graph_query', true],
    ]);
    expect(res.toolCalls[0]!.summary).toMatch(/hits in \d+ documents/);
    expect(res.toolCalls[1]!.summary).toBe('3 rows');
    expect((res.toolCalls[1]!.result as { columns: string[] }).columns).toEqual(['d.ref', 'n']);
    const refs = Object.fromEntries(res.references.map((x) => [x.ref, x]));
    expect(refs['mandate://specs/user-sessions/sections/ac-refresh-rotates']).toMatchObject({ resolved: true, kind: 'section' });
    expect(refs['mandate://specs/no-such-spec']).toMatchObject({ resolved: false });
    expect(refs['mandate://specs/no-such-spec']!.error).toBeTruthy();
    expect(res.embeds).toHaveLength(4);
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    // The model saw the context refs and the tool results.
    const second = t.model!.requests[1]!;
    expect(userText(second, 0)).toContain('- @mandate:mandate://specs/user-sessions');
    expect(lastToolResults(second).map((x) => [x.id, x.type])).toEqual([
      ['c1', 'text'],
      ['c2', 'text'],
    ]);
    // Streamed progress, in order, all with the same askId.
    const events = await t.settled();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types[1]).toBe('text');
    expect(types.indexOf('tool_start')).toBeLessThan(types.indexOf('tool_end'));
    expect(types.at(-1)).toBe('done');
    expect(new Set(events.map((e) => e.askId)).size).toBe(1);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(`Let me look.${ANSWER}`);
  });

  it('streams events in order: text deltas, tool_start / tool_end per call, the answer, then done', async () => {
    const t = await askApp((_r, step) => (step === 1 ? { text: 'Checking.', toolCalls: [{ id: 's1', name: 'graph_schema', input: {} }] } : { text: 'Done: mandate://specs/login-sso' }));
    await t.ask({ question: 'order?' });
    const events = await t.settled();
    const seq = events.map((e) => (e.type === 'tool_start' ? `start:${e.id}` : e.type === 'tool_end' ? `end:${e.call.id}:${e.call.ok}` : e.type));
    expect(seq).toEqual(['start', 'text', 'start:s1', 'end:s1:true', 'text', 'text', 'done']);
    const start = events.find((e) => e.type === 'tool_start')!;
    expect(start).toMatchObject({ name: 'graph_schema', args: {} });
    const done = events.at(-1)!;
    expect(done.type === 'done' && done.result.toolCalls[0]!.summary).toBeTruthy();
  });

  it('offers only read tools and refuses anything else, even when the model asks', async () => {
    const offered = askToolset(TOOLS).map((x) => x.name);
    const head = await fx.git.head();
    const t = await askApp((_req, step) =>
      step === 1
        ? { toolCalls: [{ id: 'w1', name: 'spec_update_meta', input: { id: 'login-sso', title: 'pwned' } }, { id: 'w2', name: 'git_pull', input: {} }, { id: 'w3', name: 'ask', input: { question: 'loop' } }] }
        : { text: 'I cannot change specs.' },
    );
    const r = await t.ask({ question: 'Rename login-sso' });
    const res = r.body as AskResult;
    expect(res.toolCalls.map((c) => [c.id, c.error?.code])).toEqual([
      ['w1', 'tool_not_allowed'],
      ['w2', 'tool_not_allowed'],
      ['w3', 'tool_not_allowed'],
    ]);
    expect(res.answer).toBe('I cannot change specs.');
    // Exactly the read toolset reaches the model; every refusal goes back to it as an error result.
    expect((t.model!.requests[0]!.tools ?? []).map((x) => x.name).sort()).toEqual([...offered].sort());
    expect(lastToolResults(t.model!.requests[1]!).map((x) => [x.id, x.type])).toEqual([
      ['w1', 'error-text'],
      ['w2', 'error-text'],
      ['w3', 'error-text'],
    ]);
    expect(lastToolResults(t.model!.requests[1]!)[0]!.value).toContain("unavailable tool 'spec_update_meta'");
    expect(await fx.git.head()).toBe(head);
    const events = await t.settled();
    expect(events.filter((e) => e.type === 'tool_end').length).toBe(3);
  });

  it('validates the model tool inputs with the same schemas (structured errors back to the model)', async () => {
    const t = await askApp((_r, step) =>
      step === 1
        ? {
            toolCalls: [
              { id: 'b1', name: 'search', input: { q: 'x', bogus: 1 } },
              { id: 'b2', name: 'spec_get', input: { id: 42 } },
              { id: 'b3', name: 'search', input: '{not json' },
            ],
          }
        : { text: 'ok' },
    );
    const res = (await t.ask({ question: 'q' })).body as AskResult;
    expect(res.toolCalls.find((c) => c.id === 'b1')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(res.toolCalls.find((c) => c.id === 'b2')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(res.toolCalls.find((c) => c.id === 'b3')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const results = Object.fromEntries(lastToolResults(t.model!.requests[1]!).map((x) => [x.id, x]));
    expect(results.b1!.type).toBe('error-text');
    const err = JSON.parse(results.b1!.value).error;
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(err.message).toContain('bogus');
    expect(JSON.parse(results.b2!.value).error.path).toBe('ref');
    expect(results.b3!.type).toBe('error-text');
  });

  it('keeps the conversation for follow-ups', async () => {
    const t = await askApp((_r, step) => (step === 1 ? { toolCalls: [{ id: 'f1', name: 'graph_schema', input: {} }] } : { text: `answer ${step}` }));
    const first = (await t.ask({ question: 'first question' })).body as AskResult;
    const second = (await t.ask({ question: 'and then?', conversationId: first.conversationId })).body as AskResult;
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.answer).toBe('answer 3');
    const prompt = t.model!.requests[2]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    expect(userText(t.model!.requests[2]!, 0)).toBe('first question');
    expect(userText(t.model!.requests[2]!, 1)).toBe('and then?');
  });

  it('generates the tool list of the system prompt from the toolset', async () => {
    const t = await askApp(() => ({ text: 'x' }));
    await t.ask({ question: 'q' });
    const system = t.model!.requests[0]!.prompt[0]!;
    expect(system.role).toBe('system');
    const text = system.content as string;
    for (const name of askToolset(TOOLS).map((x) => x.name)) expect(text).toContain(`\n- ${name}: `);
    expect(text).not.toContain('- spec_create:');
    expect(askSystemPrompt([{ name: 'x', description: `first line\nExample: {}` }])).toContain('- x: first line\n');
  });
});

describe('toolset', () => {
  it('is every registered read-only tool minus the documented exclusions', () => {
    const readOnly = TOOLS.filter((t) => describeTool(t, '').annotations?.readOnlyHint === true).map((t) => t.name);
    const expected = readOnly.filter((n) => !(n in ASK_EXCLUDED_TOOLS)).sort();
    expect(askToolset(TOOLS).map((t) => t.name).sort()).toEqual(expected);
    // Each exclusion is a real read tool, with a reason.
    for (const [name, why] of Object.entries(ASK_EXCLUDED_TOOLS)) {
      expect(readOnly, name).toContain(name);
      expect(why.length).toBeGreaterThan(3);
    }
    expect(askToolset(TOOLS).map((t) => t.name)).toEqual(expect.arrayContaining(['search', 'graph_query', 'spec_get', 'history_get', 'activity_list', 'git_status', 'index_status', 'ask_status']));
  });

  it('never includes a write or ops tool', () => {
    const offered = askToolset(TOOLS);
    expect(offered.every((t) => t.kind === 'read')).toBe(true);
    for (const t of TOOLS.filter((x) => x.kind !== 'read')) expect(offered.map((x) => x.name), t.name).not.toContain(t.name);
    expect(TOOLS.filter((t) => t.kind === 'write').length).toBeGreaterThan(20);
  });

  it('classifies git_pull as ops: not read-only for MCP clients, never offered to Ask', async () => {
    const pull = TOOLS.find((t) => t.name === 'git_pull')!;
    expect(pull.kind).toBe('ops');
    const { tools } = await fx.client.listTools();
    expect(tools.find((t) => t.name === 'git_pull')!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(askToolset(TOOLS).map((t) => t.name)).not.toContain('git_pull');
  });
});

describe('limits', () => {
  const forever: Script = (_r, step) => ({ toolCalls: [{ id: `t${step}`, name: 'graph_schema', input: {} }] });

  it('stops after maxToolCalls when the model ignores the answer-now step', async () => {
    const t = await askApp(forever, { maxToolCalls: 2 });
    const r = await t.ask({ question: 'loop' });
    const res = r.body as AskResult;
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(res.stopReason).toBe('max_tool_calls');
    expect(res.toolCalls.filter((c) => c.ok)).toHaveLength(2);
    expect(res.toolCalls.slice(2).every((c) => c.error?.code === 'limit')).toBe(true);
    expect(t.model!.requests).toHaveLength(3);
    expect(t.model!.requests[2]!.toolChoice).toEqual({ type: 'none' });
  });

  it('asks for the answer once the limit is reached (answer-now step without tools)', async () => {
    const t = await askApp(
      (req, step) =>
        req.toolChoice?.type === 'none'
          ? { text: 'Best effort answer.' }
          : { toolCalls: [1, 2, 3].map((i) => ({ id: `p${step}-${i}`, name: 'graph_schema', input: {} })) },
      { maxToolCalls: 2 },
    );
    const res = (await t.ask({ question: 'many' })).body as AskResult;
    expect(res.stopReason).toBe('done');
    expect(res.answer).toBe('Best effort answer.');
    expect(res.toolCalls.map((c) => c.ok)).toEqual([true, true, false]);
    expect(res.toolCalls[2]!.error?.code).toBe('limit');
    const last = t.model!.requests.at(-1)!;
    expect(last.prompt[0]!.content as string).toContain('Write the final answer now');
    expect(JSON.parse(lastToolResults(last)[2]!.value).error.code).toBe('limit');
  });

  it('stops at the token budget', async () => {
    const t = await askApp((r, step) => ({ ...(forever(r, step) as object), usage: { inputTokens: 1500, outputTokens: 600 } }), { tokenBudget: 4000 });
    const res = (await t.ask({ question: 'loop' })).body as AskResult;
    expect(res.stopReason).toBe('token_budget');
    expect(t.model!.requests).toHaveLength(2);
    expect(res.usage).toEqual({ inputTokens: 3000, outputTokens: 1200 });
  });

  it('times out', async () => {
    const t = await askApp(
      (req) =>
        new Promise((_res, rej) => {
          req.abortSignal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
      { timeoutMs: 100 },
    );
    const res = (await t.ask({ question: 'slow' })).body as AskResult;
    expect(res.stopReason).toBe('timeout');
  });

  it('stops when the caller aborts, keeping what was streamed and a well-formed conversation', async () => {
    const ac = new AbortController();
    const model = new ScriptedModel((req, step) =>
      step === 1
        ? { text: 'Partial', toolCalls: [{ id: 'a1', name: 'graph_schema', input: {} }] }
        : new Promise((_res, rej) => {
            ac.abort();
            if (req.abortSignal?.aborted) rej(new DOMException('aborted', 'AbortError'));
            req.abortSignal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
          }),
    );
    const conversations = new ConversationStore();
    const ctx = { storage: fx.storage, index: fx.index } as unknown as ToolContext;
    const res = await runAsk({
      question: 'q',
      context: [],
      conversationId: 'abortconv',
      model,
      tools: askToolset(TOOLS),
      ctx,
      limits: { maxToolCalls: 5, timeoutMs: 60_000, tokenBudget: 100_000, maxOutputTokens: 1000 },
      conversations,
      signal: ac.signal,
    });
    expect(res.stopReason).toBe('aborted');
    expect(res.toolCalls.map((c) => c.name)).toEqual(['graph_schema']);
    expect(conversations.get('abortconv').at(-1)?.role).toBe('assistant');
  });

  it('reports max_tokens and refusal stops', async () => {
    const t = await askApp(() => ({ text: 'partial', finish: 'length' }));
    expect(((await t.ask({ question: 'q' })).body as AskResult).stopReason).toBe('max_tokens');
    const r = await askApp(() => ({ text: 'no', finish: 'content-filter' }));
    expect(((await r.ask({ question: 'q' })).body as AskResult).stopReason).toBe('refusal');
  });
});

describe('not configured and invalid input', () => {
  it('returns not_configured with the missing fields', async () => {
    const t = await askApp(null);
    const r = await t.ask({ question: 'hello' });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'not_configured', detail: { kind: 'ask', missing: ['provider', 'model'] } });
    expect(r.body.error.hint).toContain('config.json');
    const anth = await askApp(null, { models: [entry({ id: 'default', provider: 'anthropic', apiKeyEnv: 'MANDATE_TEST_UNSET_KEY' })] });
    expect((await anth.ask({ question: 'hello' })).body.error.detail).toMatchObject({ model: 'default', missing: ['apiKey'] });
    const oai = await askApp(null, { models: [entry({ id: 'gpt', provider: 'openai', model: 'gpt-x', apiKeyEnv: 'MANDATE_TEST_UNSET_KEY' })] });
    const err = (await oai.ask({ question: 'hello' })).body.error;
    expect(err.detail.missing).toEqual(['apiKey']);
    expect(err.message).toContain('MANDATE_TEST_UNSET_KEY');
  });

  it('validates the ask input', async () => {
    const t = await askApp(() => ({ text: 'x' }));
    expect((await t.ask({ question: '' })).body.error.path).toBe('question');
    expect((await t.ask({ question: 'q', context: ['not-a-ref'] })).body.error.path).toBe('context.0');
    expect((await t.ask({ question: 'q', conversationId: 'bad id!' })).body.error.path).toBe('conversationId');
    expect((await t.ask({ question: 'q', model: 'bad id!' })).body.error.path).toBe('model');
  });
});

describe('createAskModel', () => {
  it('uses only the key from apiKeyEnv, never the SDK env fallbacks', () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-from-sdk-env';
    process.env.OPENAI_API_KEY = 'sk-from-sdk-env';
    try {
      expect(() => createAskModel(entry({ id: 'a', provider: 'anthropic', apiKeyEnv: 'K' }), {})).toThrow(/ask model 'a'.*apiKeyEnv \(K\)/);
      expect(() => createAskModel(entry({ id: 'o', provider: 'openai', model: 'gpt-x' }), {})).toThrow(/no API key/);
      const m = createAskModel(entry({ id: 'a', provider: 'anthropic', apiKeyEnv: 'K' }), { K: 'sk-1' });
      expect(m).toMatchObject({ name: 'anthropic', model: 'claude-opus-5-5', providerOptions: { anthropic: { fallbacks: 'default' } } });
      expect(createAskModel(entry({ id: 'g', provider: 'google', model: 'gemini-x', apiKeyEnv: 'K' }), { K: 'g-1' })).toMatchObject({ name: 'google', model: 'gemini-x' });
      expect(createAskModel(entry({ id: 'l', provider: 'openai-compatible', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }), {})).toMatchObject({ name: 'openai-compatible', model: 'llama3' });
    } finally {
      process.env = saved;
    }
  });
});

describe('multiple models', () => {
  const two: AskCfg = {
    default: 'luna',
    models: [
      entry({ id: 'luna', label: 'GPT-6 Luna', provider: 'openai-compatible', model: 'gpt-6-luna', baseUrl: 'https://api.example.com/v1' }),
      entry({ id: 'opus', label: 'Opus 5.5', provider: 'anthropic', apiKeyEnv: 'MANDATE_TEST_OPUS_KEY' }),
      entry({ id: 'off', label: 'Not set up', provider: 'openai', model: 'gpt-x', apiKeyEnv: 'MANDATE_TEST_UNSET_KEY' }),
    ],
  };
  /** One scripted model per configured id, answering with its own name. */
  const perModel = () => {
    const models = new Map<string, ScriptedModel>();
    const factory = (m: AskModelConfig) => {
      if (!models.has(m.id)) models.set(m.id, new ScriptedModel((_r, step) => ({ text: `${m.id} answer ${step}` })));
      return models.get(m.id)!;
    };
    return { models, factory };
  };

  it('answers with the default model, or the one named; reports it in the start event and the result', async () => {
    process.env.MANDATE_TEST_OPUS_KEY = 'sk-test';
    try {
      const { models, factory } = perModel();
      const t = await askApp(null, two, factory);
      const first = (await t.ask({ question: 'who answers?' })).body as AskResult;
      expect(first).toMatchObject({ modelId: 'luna', modelLabel: 'GPT-6 Luna', answer: 'luna answer 1' });
      const events = await t.settled();
      expect(events[0]).toMatchObject({ type: 'start', model: { id: 'luna', label: 'GPT-6 Luna', provider: 'fake' } });
      const second = (await t.ask({ question: 'and you?', model: 'opus' })).body as AskResult;
      expect(second).toMatchObject({ modelId: 'opus', modelLabel: 'Opus 5.5', answer: 'opus answer 1' });
      expect([...models.keys()]).toEqual(['luna', 'opus']);
    } finally {
      delete process.env.MANDATE_TEST_OPUS_KEY;
    }
  });

  it('switches models mid-conversation, carrying the history over', async () => {
    process.env.MANDATE_TEST_OPUS_KEY = 'sk-test';
    try {
      const luna = new ScriptedModel((_r, step) => (step === 1 ? { toolCalls: [{ id: 'l1', name: 'graph_schema', input: {} }] } : { text: 'Luna says: see mandate://specs/login-sso' }));
      const opus = new ScriptedModel(() => ({ text: 'Opus follows up.' }));
      const t = await askApp(null, two, (m) => (m.id === 'opus' ? opus : luna));
      const first = (await t.ask({ question: 'first question' })).body as AskResult;
      expect(first.modelId).toBe('luna');
      const second = (await t.ask({ question: 'follow-up', conversationId: first.conversationId, model: 'opus' })).body as AskResult;
      expect(second).toMatchObject({ conversationId: first.conversationId, modelId: 'opus', answer: 'Opus follows up.' });
      // Opus received Luna's turns (tool call and result included) as provider-neutral messages.
      const prompt = opus.requests[0]!.prompt;
      expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
      expect(JSON.stringify(prompt)).toContain('Luna says: see mandate://specs/login-sso');
      expect(userText(opus.requests[0]!, 1)).toBe('follow-up');
      // And back to Luna.
      const third = (await t.ask({ question: 'back', conversationId: first.conversationId, model: 'luna' })).body as AskResult;
      expect(third.modelId).toBe('luna');
      expect(JSON.stringify(luna.requests.at(-1)!.prompt)).toContain('Opus follows up.');
    } finally {
      delete process.env.MANDATE_TEST_OPUS_KEY;
    }
  });

  it('rejects an unknown model id and reports an unconfigured one', async () => {
    const t = await askApp(null, two, perModel().factory);
    const unknown = (await t.ask({ question: 'q', model: 'nope' })).body.error;
    expect(unknown).toMatchObject({ code: 'invalid_input', path: 'model' });
    expect(unknown.hint).toContain('luna, opus, off');
    const off = (await t.ask({ question: 'q', model: 'off' })).body.error;
    expect(off).toMatchObject({ code: 'not_configured', detail: { kind: 'ask', model: 'off', missing: ['apiKey'] } });
    // opus without its key in the env.
    expect((await t.ask({ question: 'q', model: 'opus' })).body.error.detail.missing).toEqual(['apiKey']);
  });

  it('lists every model in ask_status with the default', async () => {
    process.env.MANDATE_TEST_OPUS_KEY = 'sk-test';
    try {
      const t = await askApp(null, two, perModel().factory);
      const r = await t.client.callTool({ name: 'ask_status', arguments: {} });
      const s = r.structuredContent as Record<string, any>;
      expect(s).toMatchObject({ configured: true, default: 'luna', missing: [] });
      expect(s.models.map((m: any) => [m.id, m.label, m.provider, m.model, m.configured, m.missing])).toEqual([
        ['luna', 'GPT-6 Luna', 'openai-compatible', 'gpt-6-luna', true, []],
        ['opus', 'Opus 5.5', 'anthropic', 'claude-opus-5-5', true, []],
        ['off', 'Not set up', 'openai', 'gpt-x', false, ['apiKey']],
      ]);
      expect(s.models[2].reason).toContain('MANDATE_TEST_UNSET_KEY');
      expect(JSON.stringify(s)).not.toContain('sk-test');
    } finally {
      delete process.env.MANDATE_TEST_OPUS_KEY;
    }
  });
});

describe('ask config', () => {
  it('reads the legacy single-model shape as one model with id default', () => {
    const c = askConfigSchema.parse({ provider: 'openai-compatible', model: 'gpt-6-luna', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'K', maxToolCalls: 5 });
    expect(c).toEqual({ default: 'default', maxToolCalls: 5, models: [{ id: 'default', provider: 'openai-compatible', model: 'gpt-6-luna', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'K' }] });
    expect(askConfigSchema.parse({ provider: null, model: null, baseUrl: null, apiKeyEnv: null })).toEqual({ default: null, models: [] });
    expect(askConfigSchema.safeParse({ provider: 'nope' }).success).toBe(false);
  });

  it('parses and strictly validates the multi-model shape', () => {
    const ok = askConfigSchema.parse({ default: 'b', models: [{ id: 'a', provider: 'anthropic' }, { id: 'b', label: 'B', provider: 'openai', model: 'gpt-x', apiKeyEnv: 'K', maxToolCalls: 3 }], tokenBudget: 9000 });
    expect(ok.default).toBe('b');
    expect(ok.models[0]).toEqual({ id: 'a', provider: 'anthropic', model: null, baseUrl: null, apiKeyEnv: null });
    const problems = (v: unknown) => {
      const r = askConfigSchema.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(problems({ models: [{ id: 'a', provider: 'anthropic' }, { id: 'a', provider: 'openai', model: 'x' }] })).toEqual(["models.1.id: duplicate model id 'a'"]);
    expect(problems({ default: 'zz', models: [{ id: 'a', provider: 'anthropic' }] })).toEqual(["default: no model with id 'zz'"]);
    expect(problems({ models: [{ id: 'a', provider: 'anthropic', apiKey: 'sk-inline' }] })[0]).toMatch(/models\.0/);
    expect(problems({ models: [{ id: 'bad id', provider: 'anthropic' }] })[0]).toMatch(/^models\.0\.id/);
    expect(problems({ models: [{ id: 'a', provider: 'anthropic', apiKeyEnv: 'sk-not-a-name!' }] })[0]).toMatch(/apiKeyEnv/);
    expect(problems({ models: [], extra: 1 })[0]).toMatch(/extra|Unrecognized/);
  });

  it('defaults to the first model when default is absent', () => {
    expect(askConfigSchema.parse({ models: [{ id: 'x', provider: 'anthropic' }, { id: 'y', provider: 'anthropic' }] }).default).toBe('x');
    expect(askConfigSchema.parse({ models: [] }).default).toBe(null);
    expect(askConfigSchema.parse({ default: null, models: [{ id: 'x', provider: 'anthropic' }] }).default).toBe('x');
  });

  it('hot-reloads the ask block and rebuilds a cached provider when its key changes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-ask-live-'));
    const file = path.join(dir, 'config.json');
    const warnings: string[] = [];
    try {
      writeFileSync(file, JSON.stringify({ ask: { models: [{ id: 'a', provider: 'anthropic', apiKeyEnv: 'MANDATE_TEST_LIVE_KEY' }] } }));
      const start: ResolvedAskConfig = { default: 'a', models: [], source: file };
      expect(liveAskConfig(start).models.map((m) => m.id)).toEqual(['a']);
      writeFileSync(file, JSON.stringify({ ask: { default: 'b', models: [{ id: 'a', provider: 'anthropic' }, { id: 'b', provider: 'openai', model: 'gpt-xx' }] } }));
      expect(liveAskConfig(start)).toMatchObject({ default: 'b', models: [{ id: 'a' }, { id: 'b' }] });
      // An invalid edit keeps the last good block.
      writeFileSync(file, JSON.stringify({ ask: { default: 'zzz', models: [] } }));
      expect(liveAskConfig(start, { warn: (m) => warnings.push(m) }).default).toBe('b');
      expect(warnings[0]).toContain("no model with id 'zzz'");

      clearAskModelCache();
      const m = entry({ id: 'k', provider: 'anthropic', apiKeyEnv: 'MANDATE_TEST_LIVE_KEY' });
      const one = cachedAskModel(m, { MANDATE_TEST_LIVE_KEY: 'sk-1' });
      expect(cachedAskModel(m, { MANDATE_TEST_LIVE_KEY: 'sk-1' })).toBe(one);
      expect(cachedAskModel(m, { MANDATE_TEST_LIVE_KEY: 'sk-2' })).not.toBe(one);
      expect(cachedAskModel({ ...m, model: 'claude-x' }, { MANDATE_TEST_LIVE_KEY: 'sk-2' }).model).toBe('claude-x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
