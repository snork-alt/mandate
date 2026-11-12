/**
 * The Ask agent: an AI SDK `ToolLoopAgent` answers a question using ONLY Mandate's read tools. Each AI SDK tool wraps a
 * Mandate tool and runs it in-process through the same `defineTool` / `callTool` validation as MCP calls (the AI SDK
 * does no validation of its own: `jsonSchema()` without `validate`). Limits are `stopWhen` conditions, a `prepareStep`
 * "answer now" step and an abort signal. Progress is streamed as AskEvents; references in the final answer are
 * checked with resolveRef (unresolved ones are reported, never dropped).
 */
import { randomUUID } from 'node:crypto';
import { dynamicTool, jsonSchema, ToolChoiceViolationError, ToolLoopAgent, type ModelMessage, type StopCondition, type ToolSet } from 'ai';
import { ANSWER_FORMAT_GUIDE, parseAnswer, type AskEvent, type AskResult, type AskToolCall, type ReferenceCheck } from '@mandate/shared';
import { callTool, inputJsonSchema, type AnyToolDef, type ToolContext } from '../mcp/define.js';
import type { AskModel } from './model.js';

/** An AskEvent without its askId (distributes over the union). */
type AskEventBody = AskEvent extends infer E ? (E extends AskEvent ? Omit<E, 'askId'> : never) : never;

export interface AskLimits {
  maxToolCalls: number;
  timeoutMs: number;
  tokenBudget: number;
  maxOutputTokens: number;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_REFS_CHECKED = 100;
const MAX_TOOL_LINE = 200;

/** One line per tool for the system prompt: the first line of its description. */
export interface AskToolLine {
  name: string;
  description: string;
}

/** The system prompt; the tool list is generated from the toolset, so new read tools reach the agent automatically. */
export function askSystemPrompt(tools: AskToolLine[]): string {
  const lines = tools.map((t) => {
    const first = t.description.split('\n')[0]!.trim();
    return `- ${t.name}: ${first.length > MAX_TOOL_LINE ? `${first.slice(0, MAX_TOOL_LINE - 1)}…` : first}`;
  });
  return `You answer questions about a Mandate repository: specs (what to build) and standards (rules specs follow) split into typed sections, work orders (agents implementing / reviewing sections of a spec at a pinned commit), feedback items, verification results of acceptance criteria, and their git history. mandate:// references are the keys of everything.
You have read-only tools (start with search; the graph_* tools and graph_query with Cypher navigate relations):
${lines.join('\n')}
You cannot change anything; if asked to, explain what an agent would need to do and cite the references.
Use the tools to ground every statement; prefer a few targeted calls (search, then get or graph) over many. Do not guess ids: find them.

${ANSWER_FORMAT_GUIDE}`;
}

const ANSWER_NOW = 'The tool call limit is reached: no more tools are available. Write the final answer now with what you have, and say what you could not check.';

/** Conversations kept in memory for follow-ups (bounded): AI SDK model messages, tool results included. */
export class ConversationStore {
  private readonly map = new Map<string, { messages: ModelMessage[]; at: number }>();
  constructor(
    private readonly maxConversations = 50,
    private readonly maxMessages = 60,
  ) {}
  get(id: string): ModelMessage[] {
    return this.map.get(id)?.messages ?? [];
  }
  save(id: string, messages: ModelMessage[]): void {
    let m = messages;
    // Trim whole exchanges from the front: keep from a user question onwards.
    while (m.length > this.maxMessages) {
      const next = m.findIndex((x, i) => i > 0 && x.role === 'user');
      m = next > 0 ? m.slice(next) : m.slice(-this.maxMessages);
    }
    this.map.delete(id);
    this.map.set(id, { messages: m, at: Date.now() });
    while (this.map.size > this.maxConversations) this.map.delete(this.map.keys().next().value!);
  }
}

/** One line per tool result for the step list ("6 hits", "12 rows"). */
export function summarizeToolResult(name: string, body: Record<string, any>): string {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case 'search':
      return `${body.total ?? 0} hits in ${n(body.groups)} documents`;
    case 'text_search':
      return `${body.total ?? n(body.matches)} matches`;
    case 'symbol_search':
      return `${n(body.symbols)} symbols`;
    case 'code_search':
      return `${n(body.refs)} code references`;
    case 'related':
      return `${n(body.items)} related items`;
    case 'graph_query':
      return `${n(body.rows)} rows${body.truncated ? ' (truncated)' : ''}`;
    case 'graph_neighbors':
      return `${n(body.nodes) || n(body.groups)} neighbours`;
    case 'graph_search':
      return `${n(body.nodes) || n(body.items)} entry points`;
    default:
      if (Array.isArray(body.items)) return `${body.total ?? body.items.length} items`;
      if (Array.isArray(body.events)) return `${body.total ?? body.events.length} events`;
      if (Array.isArray(body.entries)) return `${body.total ?? body.entries.length} commits`;
      if (body.node?.label) return String(body.node.label);
      if (body.frontmatter?.title) return String(body.frontmatter.title);
      if (body.section?.title) return String(body.section.title);
      return 'done';
  }
}

/** A size-bounded copy of a result for rich rendering in the UI. */
export function trimForUi(name: string, body: Record<string, any>): unknown {
  const cap = (v: unknown) => {
    const s = JSON.stringify(v);
    return s.length <= 16_000 ? v : undefined;
  };
  switch (name) {
    case 'search':
      return { total: body.total, groups: (body.groups ?? []).slice(0, 6).map((g: any) => ({ ...g, hits: (g.hits ?? []).slice(0, 3) })) };
    case 'graph_query':
      return cap({ columns: body.columns, rows: (body.rows ?? []).slice(0, 50), truncated: body.truncated || (body.rows ?? []).length > 50 });
    case 'text_search':
      return { total: body.total, matches: (body.matches ?? []).slice(0, 20) };
    default:
      return cap(body);
  }
}

export interface RunAskOptions {
  question: string;
  context: string[];
  conversationId?: string;
  model: AskModel;
  /** Configured model id and label (reported in the start event and the result). */
  choice?: { id: string; label: string };
  /** Read tools the model may call (anything else is never offered nor executed). */
  tools: AnyToolDef[];
  ctx: ToolContext;
  limits: AskLimits;
  conversations: ConversationStore;
  emit?: (e: AskEvent) => void;
  signal?: AbortSignal;
  /** Reference check (resolveRef); null means the index is unavailable. */
  resolve?: ((ref: string) => Promise<{ kind: string; label: string }>) | null;
}

/** What a wrapped tool returns to the AI SDK: the text for the model and whether it is an error. */
interface ToolOutcome {
  content: string;
  isError: boolean;
}

const errorJson = (code: string, message: string) => JSON.stringify({ error: { code, message } });

export async function runAsk(o: RunAskOptions): Promise<AskResult> {
  const conversationId = o.conversationId ?? randomUUID().replace(/-/g, '').slice(0, 24);
  const history = o.conversations.get(conversationId);
  const askId = `${conversationId}:${history.filter((m) => m.role === 'user').length + 1}`;
  const emit = (e: AskEventBody) => o.emit?.({ askId, ...e } as AskEvent);
  const { maxToolCalls, tokenBudget, maxOutputTokens, timeoutMs } = o.limits;
  const choice = o.choice ?? { id: 'default', label: o.model.model };
  emit({ type: 'start', model: { id: choice.id, label: choice.label, provider: o.model.name, model: o.model.model } });

  // Read-only enforcement: only read tools become AI SDK tools; a call to anything else is a NoSuchToolError that the
  // SDK reports back to the model without executing anything.
  const allowed = new Map(o.tools.filter((t) => t.kind === 'read').map((t) => [t.name, t]));
  const calls: AskToolCall[] = [];
  const executed = new Set<string>();

  /** Run one model tool call through callTool (validation, structured errors), recording it in order. */
  const runTool = async (def: AnyToolDef, id: string, input: unknown): Promise<ToolOutcome> => {
    executed.add(id);
    const overLimit = calls.length >= maxToolCalls;
    const slot = calls.push(undefined as unknown as AskToolCall) - 1;
    emit({ type: 'tool_start', id, name: def.name, args: input });
    const t0 = Date.now();
    let call: AskToolCall;
    let content: string;
    if (overLimit) {
      call = { id, name: def.name, args: input, ok: false, summary: 'skipped: tool call limit reached', error: { code: 'limit', message: 'tool call limit reached' }, ms: 0 };
      content = errorJson('limit', `tool call limit (${maxToolCalls}) reached: write the answer now with what you have`);
    } else {
      const r = await callTool(def, input, o.ctx);
      const body = (r.structuredContent ?? {}) as Record<string, any>;
      const text = (r.content?.[0] as { text?: string } | undefined)?.text ?? JSON.stringify(body);
      content = text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… (truncated: narrow the query or use limit)` : text;
      call = r.isError
        ? { id, name: def.name, args: input, ok: false, summary: `${body.error?.code}: ${body.error?.message}`, error: { code: body.error?.code ?? 'error', message: body.error?.message ?? '' }, ms: Date.now() - t0 }
        : { id, name: def.name, args: input, ok: true, summary: summarizeToolResult(def.name, body), result: trimForUi(def.name, body), ms: Date.now() - t0 };
    }
    calls[slot] = call;
    emit({ type: 'tool_end', call });
    return { content, isError: !call.ok };
  };

  /** A call the SDK refused before execution (unknown / write tool, unparsable input, or after the limit). */
  let nudged = false;
  const recordRefused = (id: string, name: string, input: unknown, error: unknown) => {
    const e = nudged
      ? { code: 'limit', message: 'tool call limit reached' }
      : allowed.has(name)
        ? { code: 'invalid_input', message: error instanceof Error ? error.message : String(error) }
        : { code: 'tool_not_allowed', message: `'${name}' is not available: Ask can only use Mandate's read tools` };
    const call: AskToolCall = { id, name, args: input, ok: false, summary: `refused: ${e.code}`, error: e, ms: 0 };
    calls.push(call);
    emit({ type: 'tool_start', id, name, args: input });
    emit({ type: 'tool_end', call });
  };

  const tools: ToolSet = {};
  const toolLines: AskToolLine[] = [];
  for (const def of allowed.values()) {
    const description = typeof def.description === 'function' ? await def.description(o.ctx) : def.description;
    toolLines.push({ name: def.name, description });
    tools[def.name] = dynamicTool({
      description,
      // The same JSON Schema the MCP tool advertises; no SDK-side validation (callTool does it with the zod schema).
      inputSchema: jsonSchema(inputJsonSchema(def.input) as Parameters<typeof jsonSchema>[0]),
      execute: (input, { toolCallId }) => runTool(def, toolCallId, input),
      toModelOutput: ({ output }) => {
        const r = output as ToolOutcome;
        return r.isError ? { type: 'error-text', value: r.content } : { type: 'text', value: r.content };
      },
    });
  }
  const system = askSystemPrompt(toolLines);

  const userText = o.context.length ? `${o.question}\n\nContext (the user is looking at these):\n${o.context.map((r) => `- ${r}`).join('\n')}` : o.question;
  const input: ModelMessage[] = [...history, { role: 'user', content: userText }];

  const usage = { inputTokens: 0, outputTokens: 0 };
  const overBudget = () => usage.inputTokens + usage.outputTokens >= tokenBudget;
  // Evaluated after every step that has tool results (all conditions are evaluated; any true stops the loop).
  const stopWhen: StopCondition<ToolSet>[] = [
    // Every step but the last calls at least one tool: a safety bound on the steps.
    ({ steps }) => steps.length >= maxToolCalls + 2,
    () => overBudget(),
  ];

  const agent = new ToolLoopAgent({
    model: o.model.languageModel,
    instructions: system,
    tools,
    maxOutputTokens,
    stopWhen,
    // Errors surface from the stream and are rethrown below (the SDK would otherwise log them).
    onError: () => undefined,
    ...(o.model.providerOptions ? { providerOptions: o.model.providerOptions } : {}),
    // Limit reached: one more step without tools, told to answer now (a tool call there is a ToolChoiceViolationError).
    prepareStep: () => {
      if (calls.length < maxToolCalls) return {};
      nudged = true;
      return { toolChoice: 'none', instructions: `${system}\n\n${ANSWER_NOW}` };
    },
  });

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const responseMessages: ModelMessage[] = [];
  let answer = '';
  let stepText = '';
  let stepHadToolCalls = false;
  let finishReason: string | undefined;
  let failure: unknown;

  try {
    const result = await agent.stream({
      messages: input,
      abortSignal: signal,
      onStepEnd: (step) => {
        responseMessages.push(...step.response.messages);
      },
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step':
          stepText = '';
          stepHadToolCalls = false;
          break;
        case 'text-delta':
          stepText += part.text;
          answer = stepText;
          emit({ type: 'text', delta: part.text });
          break;
        case 'tool-call':
          stepHadToolCalls = true;
          break;
        case 'tool-error':
          // Our tools never throw, so an error for a call we did not execute was refused by the SDK.
          if (!executed.has(part.toolCallId)) recordRefused(part.toolCallId, part.toolName, part.input, part.error);
          break;
        case 'finish-step':
          usage.inputTokens += part.usage.inputTokens ?? 0;
          usage.outputTokens += part.usage.outputTokens ?? 0;
          finishReason = part.finishReason;
          answer = stepText;
          break;
        case 'error':
          failure ??= part.error;
          break;
      }
    }
  } catch (e) {
    failure ??= e;
  }

  let stopReason: string;
  if (signal.aborted) stopReason = timeout.aborted && !o.signal?.aborted ? 'timeout' : 'aborted';
  // The model ignored the answer-now step and asked for more tools: stop instead of looping.
  else if (nudged && ToolChoiceViolationError.isInstance(failure)) stopReason = 'max_tool_calls';
  else if (failure !== undefined) throw failure;
  // The loop ended right after tool results: a stop condition fired.
  else if (stepHadToolCalls) stopReason = overBudget() ? 'token_budget' : 'max_tool_calls';
  else stopReason = finishReason === 'length' ? 'max_tokens' : finishReason === 'content-filter' ? 'refusal' : finishReason === 'stop' || finishReason === undefined ? 'done' : finishReason;

  // Keep the conversation well formed for follow-ups: it ends with an assistant message.
  const saved = [...input, ...responseMessages];
  if (saved.at(-1)?.role !== 'assistant') saved.push({ role: 'assistant', content: answer || `(no answer: ${stopReason})` });
  o.conversations.save(conversationId, saved);

  const { embeds, refs } = parseAnswer(answer);
  const references: ReferenceCheck[] = await Promise.all(
    refs.slice(0, MAX_REFS_CHECKED).map(async (ref) => {
      if (!o.resolve) return { ref, resolved: false, error: 'search index unavailable' };
      try {
        const n = await o.resolve(ref);
        return { ref, resolved: true, kind: n.kind, label: n.label };
      } catch (e) {
        return { ref, resolved: false, error: (e as Error).message };
      }
    }),
  );
  const result: AskResult = { conversationId, answer, embeds, references, toolCalls: calls, usage, stopReason, provider: o.model.name, model: o.model.model, modelId: choice.id, modelLabel: choice.label };
  emit({ type: 'done', result });
  return result;
}
