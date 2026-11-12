/**
 * `defineTool`: the one way to declare an MCP tool. It enforces, on every call:
 *   1. schema: a strict zod input schema (also the source of the tool's JSON Schema);
 *   2. domain: the service function's own checks (references exist, ...), surfaced as structured errors;
 *   3. errors: anything thrown becomes `{ code, message, path, hint }` with `isError: true`, never a raw throw.
 * Write tools declare `kind: 'write'`: they get the common `agent` / `branch` / `idempotencyKey` inputs, a resolved
 * `ctx.commit` (agent identity falling back to the MCP clientInfo name, branch, trailers), idempotent replays and a
 * `warnings[]` passthrough. Content validation (`@mandate/doc`) lives in the storage services they call.
 */
import { z } from 'zod';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { IndexService } from '../index/service.js';
import type { Storage } from '../storage/index.js';
import type { DocReadService } from '../storage/read.js';
import type { DocViewService } from '../storage/views.js';
import type { ResolvedAskConfig } from '../config.js';
import type { AskModelOverride } from '../ask/model.js';
import type { ActivityBus, ActivityFilter } from '../events/bus.js';
import type { AutoPusher } from '../git/autopush.js';
import type { ConversationStore } from '../ask/agent.js';
import type { Principal } from '../auth/http.js';
import { ToolError, toToolError, toWriteError, type ToolErrorBody } from './errors.js';

export interface ToolContext {
  /** The project this context serves (every tool, resource and ref is relative to it). */
  project?: { id: string; name: string };
  /** Who is calling (agent key or the read-only web UI session); unset in-process (tests, the Ask agent's own calls). */
  principal?: Principal;
  /** Durable idempotency store of this project (falls back to the process-wide one). */
  idempotency?: IdempotencyStore;
  /** Ask conversations of this project. */
  conversations?: ConversationStore;
  storage: Storage;
  /** Null when the search index failed to open (search and graph tools then return `index_unavailable`). */
  index: IndexService | null;
  reads: DocReadService;
  /** Full derived payloads for the web UI. */
  views: DocViewService;
  /** Live activity feed (null when disabled). */
  activity?: ActivityBus | null;
  /** Background push of this project (git_status, git_push). */
  autoPush?: AutoPusher;
  /** Per-session state (Streamable HTTP session): the activity notification filter. */
  session?: SessionState;
  /** Per call: send a notification on this request's stream (progress of long tools such as ask). */
  notify?: (method: string, params: Record<string, unknown>) => Promise<void>;
  /** Per call: aborted when the client cancels the request. */
  signal?: AbortSignal;
  /** Override the configured Ask model (tests: an AI SDK mock model). */
  askModel?: AskModelOverride;
  /** `ask` config block (model for the Ask panel); the key never leaves the server. */
  ask?: ResolvedAskConfig;
  /** MCP clientInfo name of the caller (agent identity fallback for write tools). */
  clientName?: string;
  /** Write tools only: commit metadata for the storage layer (`Agent:` / `Branch:` and tool-specific trailers). */
  commit?: WriteMeta;
}

export interface SessionState {
  /** null = every event (default). */
  subscription: (ActivityFilter & { enabled: boolean }) | null;
}

export interface WriteMeta {
  agent: string;
  branch?: string;
  trailers: Record<string, string>;
  idempotencyKey?: string;
}

/** Inputs every write tool accepts (added to its schema by `defineTool`). */
export const WRITE_FIELDS = {
  /** Agent identity for claims and the `Agent:` commit trailer (default: the MCP clientInfo name). */
  agent: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, 'single line').optional(),
  /** Branch the agent works on (`Branch:` trailer). */
  branch: z.string().trim().min(1).max(200).regex(/^[^\s]+$/, 'no whitespace').optional(),
  /** Retry key: the same key with the same arguments replays the first result instead of writing twice. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, '8-128 chars of A-Z a-z 0-9 _ . : -').optional(),
};

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  /** Agent-oriented description; a function for descriptions built from live data (graph_query embeds graph_schema). */
  description: string | ((ctx: ToolContext) => Promise<string> | string);
  input: S;
  /**
   * read: no state change (the Ask agent may call it); write: a document write (commit metadata, idempotency);
   * ops: changes local state without a document commit (git_pull), so it is not read-only for MCP clients or Ask.
   */
  kind: 'read' | 'write' | 'ops';
  /** Ops tools only: refuse the web UI's read-only session (agent keys only). git_pull stays callable from the UI. */
  agentOnly?: boolean;
  /** Extra MCP annotations (readOnlyHint etc. are derived from `kind`). */
  annotations?: Partial<ToolAnnotations>;
  /** Write tools: extra commit trailers derived from the arguments (e.g. `{ Feedback: args.feedback }`). */
  trailers?: (args: z.output<S>) => Record<string, string | undefined>;
  run(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

export type AnyToolDef = ToolDef<z.ZodType>;

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): AnyToolDef {
  if (def.kind !== 'write') return def as unknown as AnyToolDef;
  const shape = (def.input as unknown as { shape?: z.ZodRawShape }).shape;
  if (!shape) throw new Error(`write tool ${def.name}: input must be a z.object (refine inside the service instead)`);
  for (const k of Object.keys(WRITE_FIELDS)) if (k in shape) throw new Error(`write tool ${def.name}: '${k}' is a reserved input`);
  return { ...def, input: z.object({ ...shape, ...WRITE_FIELDS }).strict() } as unknown as AnyToolDef;
}

/* ---------------------------------------------------------------- idempotency */

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IDEMPOTENCY_MAX = 1000;

/** Where completed idempotent results are kept (24 h). In memory by default; `setIdempotencyStore` makes them durable. */
export interface IdempotencyStore {
  get(key: string): { args: string; at: number; result: CallToolResult } | undefined;
  set(key: string, entry: { args: string; at: number; result: CallToolResult }): void;
  delete(key: string): void;
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, { args: string; at: number; result: CallToolResult }>();
  get(key: string) {
    const now = Date.now();
    for (const [k, v] of this.map) if (now - v.at > IDEMPOTENCY_TTL_MS || this.map.size > IDEMPOTENCY_MAX) this.map.delete(k);
    return this.map.get(key);
  }
  set(key: string, entry: { args: string; at: number; result: CallToolResult }) {
    this.map.set(key, entry);
  }
  delete(key: string) {
    this.map.delete(key);
  }
}

let idempotencyStore: IdempotencyStore = new MemoryIdempotencyStore();
export function setIdempotencyStore(store: IdempotencyStore): void {
  idempotencyStore = store;
}

/** Calls in flight per key (a concurrent retry waits for the first call instead of writing twice). */
const inFlight = new Map<string, { args: string; result: Promise<CallToolResult> }>();

function remember(key: string, args: string, run: () => Promise<CallToolResult>, store: IdempotencyStore = idempotencyStore): Promise<CallToolResult> | CallToolResult {
  const conflict = () =>
    errorResult({ code: 'idempotency_conflict', message: 'this idempotencyKey was used with different arguments', path: 'idempotencyKey', hint: 'use a new key for a different write' });
  const done = store.get(key);
  if (done && Date.now() - done.at <= IDEMPOTENCY_TTL_MS) return done.args === args ? done.result : conflict();
  const pending = inFlight.get(key);
  if (pending) return pending.args === args ? pending.result : conflict();
  const result = run()
    .then((r) => {
      // Failed writes can be retried with the same key; successful ones replay for 24 h.
      if (!r.isError) store.set(key, { args, at: Date.now(), result: r });
      return r;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, { args, result });
  return result;
}

/** The IndexService, or a structured `index_unavailable` error. */
export function needIndex(ctx: ToolContext): IndexService {
  if (!ctx.index) throw new ToolError('index_unavailable', 'the search index is not available on this server', 'check index_status and the server log (index path, sqlite-vec)');
  return ctx.index;
}

/** JSON Schema of a zod input schema (input side: defaults are optional). Always a top-level object. */
export function inputJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') return { type: 'object', ...js } as Tool['inputSchema'];
  return js as Tool['inputSchema'];
}

/** Top-level keys of an object schema (for "allowed keys" hints). */
function keysOf(schema: z.ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? (schema as unknown as { _zod?: { def?: { shape?: Record<string, unknown> } } })._zod?.def?.shape;
  if (shape) return Object.keys(shape);
  const inner = (schema as unknown as { _zod?: { def?: { in?: z.ZodType; schema?: z.ZodType } } })._zod?.def;
  if (inner?.in) return keysOf(inner.in);
  if (inner?.schema) return keysOf(inner.schema);
  return [];
}

const MAX_TEXT = 400_000;

export function okResult(value: unknown): CallToolResult {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  let text = JSON.stringify(structured);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… (truncated; use limit / cursor or narrower filters)`;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function errorResult(error: ToolErrorBody): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error } as unknown as Record<string, unknown> };
}

/** Validate and run one tool call. Never throws. */
export async function callTool(def: AnyToolDef, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const keys = keysOf(def.input);
  let args: unknown;
  try {
    args = def.input.parse(rawArgs ?? {});
  } catch (e) {
    return errorResult(toToolError(e, keys));
  }
  if (def.agentOnly && ctx.principal?.kind === 'ui') {
    return errorResult({ code: 'forbidden', message: 'the web UI session is read-only', path: 'name', hint: `${def.name} needs an agent key: Authorization: Bearer <key> on this project's endpoint` });
  }
  if (def.kind !== 'write') return runTool(def, args, ctx, keys);
  if (ctx.principal?.kind === 'ui') {
    return errorResult({ code: 'forbidden', message: 'the web UI session is read-only', path: 'name', hint: 'write tools need an agent key: Authorization: Bearer <key> on this project\'s endpoint' });
  }
  const { agent, branch, idempotencyKey, ...rest } = args as Record<string, unknown> & { agent?: string; branch?: string; idempotencyKey?: string };
  const who = agent ?? ctx.clientName;
  if (!who) return errorResult({ code: 'agent_required', message: 'no agent identity', path: 'agent', hint: 'pass agent (the agent name, e.g. "my-agent@host") or set clientInfo.name' });
  let trailers: Record<string, string> = {};
  try {
    trailers = Object.fromEntries(Object.entries(def.trailers?.(rest) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
  } catch (e) {
    return errorResult(toToolError(e, keys));
  }
  // The key's name records which agent credential made the write (activity `source`); never the key itself.
  if (ctx.principal?.kind === 'key') trailers = { ...trailers, 'Agent-Key': ctx.principal.keyName };
  const wctx: ToolContext = { ...ctx, commit: { agent: who, ...(branch ? { branch } : {}), trailers, ...(idempotencyKey ? { idempotencyKey } : {}) } };
  const run = () => runTool(def, rest, wctx, keys, true);
  return idempotencyKey ? remember(`${ctx.project ? `${ctx.project.id}:` : ''}${def.name}:${who}:${idempotencyKey}`, JSON.stringify(rest), run, ctx.idempotency) : run();
}

async function runTool(def: AnyToolDef, args: unknown, ctx: ToolContext, keys: string[], write = false): Promise<CallToolResult> {
  try {
    const value = await def.run(args, ctx);
    // Writes always report non-blocking warnings (passthrough from the service; [] when none).
    if (write && value && typeof value === 'object' && !Array.isArray(value) && !('warnings' in value)) return okResult({ ...value, warnings: [] });
    return okResult(value);
  } catch (e) {
    return errorResult(write ? toWriteError(e, keys) : toToolError(e, keys));
  }
}

export function describeTool(def: AnyToolDef, description: string): Tool {
  return {
    name: def.name,
    title: def.title,
    description,
    inputSchema: inputJsonSchema(def.input),
    annotations: {
      title: def.title,
      readOnlyHint: def.kind === 'read',
      destructiveHint: false,
      idempotentHint: def.kind === 'read',
      openWorldHint: false,
      ...def.annotations,
    },
  };
}
