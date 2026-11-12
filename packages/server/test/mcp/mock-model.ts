/** A scripted Ask model for tests: the AI SDK's MockLanguageModelV4 (no real model API). */
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type { AskModel } from '../../src/ask/index.js';

/** What the model receives on one step (prompt, tools, toolChoice, abortSignal, ...). */
export type StepRequest = Parameters<MockLanguageModelV4['doStream']>[0];
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

export interface StepScript {
  text?: string;
  /** `input` is sent as JSON, or verbatim when it is a string (e.g. broken JSON). */
  toolCalls?: { id: string; name: string; input: unknown }[];
  finish?: 'stop' | 'length' | 'content-filter' | 'tool-calls';
  usage?: { inputTokens: number; outputTokens: number };
}
export type Script = (req: StepRequest, step: number) => StepScript | Promise<StepScript>;

function parts(r: StepScript): StreamPart[] {
  const out: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (r.text) {
    out.push({ type: 'text-start', id: 't' });
    for (const delta of r.text.match(/.{1,20}/gs) ?? []) out.push({ type: 'text-delta', id: 't', delta });
    out.push({ type: 'text-end', id: 't' });
  }
  for (const c of r.toolCalls ?? []) out.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input) });
  const u = r.usage ?? { inputTokens: 100, outputTokens: 20 };
  const unified = r.finish ?? (r.toolCalls?.length ? 'tool-calls' : 'stop');
  out.push({
    type: 'finish',
    finishReason: { unified, raw: unified },
    usage: { inputTokens: { total: u.inputTokens, noCache: u.inputTokens, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: u.outputTokens, text: u.outputTokens, reasoning: 0 } },
  });
  return out;
}

export class ScriptedModel implements AskModel {
  readonly name = 'fake';
  readonly model = 'scripted';
  readonly requests: StepRequest[] = [];
  readonly languageModel: MockLanguageModelV4;
  constructor(script: Script) {
    this.languageModel = new MockLanguageModelV4({
      doStream: async (req) => {
        this.requests.push(req);
        return { stream: convertArrayToReadableStream(parts(await script(req, this.requests.length))) };
      },
    });
  }
}

/** Answers immediately with one cited reference (the default fixture model). */
export const simpleModel = () => new ScriptedModel(() => ({ text: 'See [Login with SSO](mandate://specs/login-sso).' }));

/** Text of the user message at `index` among the user messages of a step's prompt. */
export function userText(req: StepRequest, index: number): string {
  const m = req.prompt.filter((x) => x.role === 'user')[index];
  return m && Array.isArray(m.content) ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
}

/** Tool results sent back to the model in the last message of a step's prompt. */
export function lastToolResults(req: StepRequest): { id: string; type: string; value: string }[] {
  const m = req.prompt.at(-1);
  if (m?.role !== 'tool') return [];
  return m.content.flatMap((p) => (p.type === 'tool-result' ? [{ id: p.toolCallId, type: p.output.type, value: 'value' in p.output ? (typeof p.output.value === 'string' ? p.output.value : JSON.stringify(p.output.value)) : '' }] : []));
}
