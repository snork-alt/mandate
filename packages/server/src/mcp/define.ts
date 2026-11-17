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
import { clientIdentity, effective, FLOW_OFF_ALLOWED, flowInstructions, flowOffMessage, type ProjectSettings } from '../projects/settings.js';
import { newsFallback, readRefs, WATCH_TOOLS, type NewsService } from '../news/index.js';
import { ToolError, toToolError, toWriteError, withHint, type ToolErrorBody } from './errors.js';
import { newsOfProject } from '../comments/route.js';
import { gateSummary, parseRef, CAUSE_TRAILER, CODE_CONTEXT_TRAILER, codeContextLabel, type CodeContext, LEGACY_USER_TRAILER, SERVICE_USER_PREFIX, USER_TRAILER, causeInputSchema } from '@mandate/shared';
import { CauseError, resolveCauses } from '../storage/causes.js';
import { collectIntegrity } from '../storage/integrity.js';
import { takePresetIds, withPresetIds } from '../storage/preset-ids.js';
import { userDirectory } from '../auth/users.js';

/** Agent name of decisions recorded from the web UI. */
export const UI_AGENT = 'mandate-ui';

export interface ToolContext {
  /** The project this context serves (every tool, resource and ref is relative to it). */
  project?: { id: string; name: string };
  /** Who is calling (agent key or the read-only web UI session); unset in-process (tests, the Ask agent's own calls). */
  principal?: Principal;
  /** Access of the caller on this project ('read': write tools refused; team: from GitHub repo permissions). */
  access?: 'read' | 'write';
  /**
   * Web UI sessions: the signed-in user's own access to the repository (GitHub push permission; local-folder projects
   * mode: write). The session itself stays read-only except for the `uiAllowed` human-decision tools, which need 'write'.
   */
  uiAccess?: 'read' | 'write';
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
  /** Per call: a progress notification (only when the request carried a progressToken): keeps long waits alive. */
  progress?: (progress: number, message?: string) => Promise<void>;
  /** Per-client news feed of this project (news/index.ts); a memory one per activity bus when unset. */
  news?: NewsService | null;
  /** Override the configured Ask model (tests: an AI SDK mock model). */
  askModel?: AskModelOverride;
  /** `ask` config block (model for the Ask panel); the key never leaves the server. */
  ask?: ResolvedAskConfig;
  /** MCP clientInfo name of the caller (agent identity fallback for write tools). */
  clientName?: string;
  /** MCP clientInfo version of the caller. */
  clientVersion?: string;
  /** Per-project agent settings (flow on/off, approval) and who uses the server; unset in tests without a registry. */
  settings?: ProjectSettings;
  /** Local checkouts of code repos the server may read (work_order_touch_from_commits); unset = none (a team). */
  codeRepos?: (repo: string) => string | null;
  /**
   * IN-PROCESS ONLY (test fixtures, seeds): create tools accept explicit ids (storage/preset-ids.ts). Never set by the
   * project opener, so no MCP / HTTP client can choose an id.
   */
  presetIds?: boolean;
  /** Write tools only: commit metadata for the storage layer (`Agent:` / `Branch:` and tool-specific trailers). */
  commit?: WriteMeta;
  /** One-time section upload URLs (`upload_url_create`); unset in-process. */
  uploads?: import('./uploads.js').UploadService;
  /** Public base URL of this server as the caller reaches it (upload URLs, UI links); unset in-process. */
  baseUrl?: string;
}

export interface SessionState {
  /** null = every event (default). */
  subscription: (ActivityFilter & { enabled: boolean }) | null;
  /** Questions this session asked (`question_ask`): it is notified when one is answered. */
  asked?: Set<string>;
  /** MCP session id (Streamable HTTP `mcp-session-id`): routes news to the session that asked / claimed. */
  id?: string;
  /** Set when the transport closed (its unread news moves to the client's next session). */
  closed?: boolean;
  /** A news_list wait is in progress (one per session). */
  waiting?: boolean;
  /** The code the agent works on (`code_context_set`): stamped on every write of this session (Code-Context trailer). */
  codeContext?: CodeContext;
  /** Tool sets listed to this session (tool-sets.ts; unset = the default `core`): `?tools=` and `tools_enable`. */
  toolSets?: Set<string>;
}

export interface WriteMeta {
  agent: string;
  /** The user who triggered the write (from the authenticated principal, never from client input). */
  user?: string;
  /** Canonical cause references of the write (`cause` input; `Caused-By:` trailer). */
  causes?: string[];
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
  /**
   * Why this write happens: one or more references (request, audit finding, work order, spec / standard section,
   * ...). Recorded as a `Caused-By:` trailer and `caused_by` lineage edges; always pass it in the Mandate flow.
   */
  cause: causeInputSchema.optional(),
};

/** Trailers only the server sets (a tool's `trailers()` can never produce them). */
const RESERVED_TRAILERS = new Set([USER_TRAILER, LEGACY_USER_TRAILER, 'Agent-Key', CAUSE_TRAILER, CODE_CONTEXT_TRAILER, 'Agent', 'Branch', 'Co-authored-by'].map((k) => k.toLowerCase()));

/** `Co-authored-by:` trailers for the causes' contributors (GitHub noreply addresses), unless MANDATE_CO_AUTHORS=0. */
export function coAuthorsEnabled(ctx: Pick<ToolContext, 'settings'>): boolean {
  return !!ctx.settings && process.env.MANDATE_CO_AUTHORS !== '0';
}

/** `login <noreply>` of the direct contributors of the causes (never the acting user; never private emails). */
async function coAuthorLines(ctx: ToolContext, causes: string[], actingUser: string): Promise<string[]> {
  const dir = userDirectory();
  if (!dir) return [];
  const users = new Set<string>();
  // From git history (no index needed, never stale): users of the commits on each cause document / section.
  for (const cause of causes) {
    if (!parseRef(cause)) continue;
    try {
      const h = (await ctx.reads.historyGet({ ref: cause, limit: 200 })) as { entries: { user?: string }[] };
      for (const e of h.entries) if (e.user) users.add(e.user);
    } catch {
      /* not a document with history (e.g. a finding): no co-authors from it */
    }
  }
  users.delete(actingUser);
  return [...users]
    .map((u) => ({ u, mail: dir.noreply(u) }))
    .filter((x): x is { u: string; mail: string } => !!x.mail)
    .slice(0, 10)
    .map((x) => `${x.u} <${x.mail}>`);
}

/**
 * The user who triggered a write, from the authenticated principal only: the GitHub login, or `service:<name>` for a
 * service-account key (never from client input).
 */
export function principalUser(ctx: Pick<ToolContext, 'principal'>): string | undefined {
  const p = ctx.principal;
  if (p?.kind === 'user') return p.login;
  // A human decision recorded from the web UI (uiAllowed tools): the signed-in user.
  if (p?.kind === 'ui') return p.user.login;
  if (p?.kind === 'key' && p.service) return `${SERVICE_USER_PREFIX}${p.keyName}`;
  return undefined;
}

/**
 * Write tools that are steps of the Mandate flow: without a `cause` they succeed with a warning (the agent should pass
 * the request / finding / work order it acts on). Origins (request_create, audits, claims, heartbeats) are not.
 */
export const FLOW_CAUSE_TOOLS = /^(spec|standard|component)_(create|update_meta|status_set|archive|section_(insert|update|move|archive|link_add|link_remove))$|^(work_order_create|work_order_section_done|work_order_complete|verification_record)$/;

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
  /** The inverse: only the signed-in web UI (an admin action such as flow_policy_set); agents are refused. */
  uiOnly?: boolean;
  /**
   * Write tools a web UI session may call: pure HUMAN decisions (accept / reject feedback, approve a waiver, release a
   * stale claim, snooze an integrity warning), never document content. Same validation, gates, commits and activity
   * as for agents; the commit is attributed to the signed-in user via the `mandate-ui` agent. Needs the
   * user's own write access (`uiAccess`). Every other write tool stays refused for the UI session.
   */
  uiAllowed?: boolean;
  /** Extra MCP annotations (readOnlyHint etc. are derived from `kind`). */
  annotations?: Partial<ToolAnnotations>;
  /** Write tools: extra commit trailers derived from the arguments (e.g. `{ Feedback: args.feedback }`). */
  trailers?: (args: z.output<S>) => Record<string, string | undefined>;
  /** Write tools: causes implied by the arguments (e.g. a work order's `reason`), recorded with `cause` (L-2). */
  causes?: (args: z.output<S>) => string[] | undefined;
  run(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
  /** Merged tools (tool-sets.ts): the listed input schema (the targets' schemas merged). */
  jsonSchema?: Tool['inputSchema'];
  /** Merged tools: the per-type tool and arguments a call runs (validation, errors and results are that tool's). */
  route?: (args: unknown) => { def: AnyToolDef; args: unknown } | { error: ToolErrorBody };
}

export type AnyToolDef = ToolDef<z.ZodType>;

export function defineTool<S extends z.ZodType>(input: ToolDef<S>): AnyToolDef {
  // Status-changing tools carry their one-line gate summary from the lifecycle registry.
  const gate = input.uiOnly ? '' : gateSummary(input.name);
  const def: ToolDef<S> = gate && typeof input.description === 'string' ? { ...input, description: `${input.description}\n${gate}` } : input;
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
  get(key: string): { args: string; at: number; result: CallToolResult } | undefined | Promise<{ args: string; at: number; result: CallToolResult } | undefined>;
  set(key: string, entry: { args: string; at: number; result: CallToolResult }): void | Promise<void>;
  delete(key: string): void | Promise<void>;
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

async function remember(key: string, args: string, run: () => Promise<CallToolResult>, store: IdempotencyStore = idempotencyStore): Promise<CallToolResult> {
  const conflict = () =>
    errorResult({ code: 'idempotency_conflict', message: 'this idempotencyKey was used with different arguments', path: 'idempotencyKey', hint: 'use a new key for a different write' });
  // A store failure (database down) only loses the replay, never the write.
  const done = await Promise.resolve(store.get(key)).catch(() => undefined);
  // No await between the in-flight check and its registration: concurrent retries see each other.
  if (done && Date.now() - done.at <= IDEMPOTENCY_TTL_MS) return done.args === args ? done.result : conflict();
  const pending = inFlight.get(key);
  if (pending) return pending.args === args ? pending.result : conflict();
  const result = run()
    .then(async (r) => {
      // Failed writes can be retried with the same key; successful ones replay for 24 h.
      if (!r.isError) await Promise.resolve(store.set(key, { args, at: Date.now(), result: r })).catch(() => undefined);
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

/** The input schema a tool is listed with (merged tools: their merged schema). */
export const toolJsonSchema = (def: AnyToolDef): Tool['inputSchema'] => def.jsonSchema ?? inputJsonSchema(def.input);

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

/**
 * Extra MCP content blocks of a result (e.g. an image block for `includeImage`), kept under a symbol so they never
 * enter the JSON text / structuredContent; spreading the result object keeps them.
 */
export const EXTRA_CONTENT = Symbol('mandate.extraContent');
type ExtraBlock = CallToolResult['content'][number];

export function okResult(value: unknown): CallToolResult {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  let text = JSON.stringify(structured);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… (truncated; use limit / cursor or narrower filters)`;
  const extra = (structured as { [EXTRA_CONTENT]?: ExtraBlock[] })[EXTRA_CONTENT];
  if (!extra) return { content: [{ type: 'text', text }], structuredContent: structured };
  // The symbol stays out of structuredContent (the SDK validates its keys).
  return { content: [{ type: 'text', text }, ...extra], structuredContent: Object.fromEntries(Object.entries(structured)) };
}

export function errorResult(body: ToolErrorBody): CallToolResult {
  const error = withHint(body);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error } as unknown as Record<string, unknown> };
}

/** Get tools whose results carry `contributors` (derived; the doc kind for bare ids, null = the ref is a full reference). */
const CONTRIBUTOR_TOOLS: Record<string, string | null> = {
  spec_get: 'specs',
  standard_get: 'standards',
  component_get: 'components',
  work_order_get: 'work-orders',
  request_get: 'feedback',
  feedback_get: 'feedback',
  audit_get: 'audits',
  doc_get: null,
  spec_section_get: 'specs',
  standard_section_get: 'standards',
  component_section_get: 'components',
  audit_section_get: 'audits',
  work_order_section_get: 'work-orders',
};

/** Add `contributors` (direct + via causes; users, else agents for older agent-only commits) to a successful get result. */
async function withContributors(name: string, args: Record<string, unknown>, res: CallToolResult, ctx: ToolContext): Promise<CallToolResult> {
  const body = res.structuredContent as Record<string, unknown> | undefined;
  if (res.isError || !ctx.index || !body || 'contributors' in body) return res;
  const raw = typeof args.ref === 'string' ? args.ref : typeof args.uri === 'string' ? args.uri : typeof args.kind === 'string' && typeof args.id === 'string' ? `mandate://${args.kind}/${args.id}` : null;
  if (!raw) return res;
  const kind = CONTRIBUTOR_TOOLS[name];
  const ref = /mandate:\/\//.test(raw) ? raw : kind ? `mandate://${kind}/${raw}` : raw;
  try {
    const c = await ctx.index.contributors({ refs: [ref], depth: 2 });
    const list = Object.values(c.contributors)[0] ?? [];
    const out = okResult({ ...body, contributors: list });
    return { ...out, content: [...out.content, ...(res.content ?? []).slice(1)] };
  } catch {
    return res; // a ref the index does not know yet (just written): the result stays as it is
  }
}

/**
 * Server-enforced flow switch: while the Mandate flow is off for the calling agent client (project policy off, or the
 * client's own preference), every write tool is refused with `flow_off`, except switching the flow itself
 * (`FLOW_OFF_ALLOWED`). Read and ops tools (git_pull / git_push sync, embedding retries) stay available. Only agent
 * principals (personal tokens / MCP OAuth, agent keys) on an endpoint with settings: the web UI and in-process callers
 * (seeds, tests, the Ask agent) are not affected.
 */
async function flowOffRefusal(def: AnyToolDef, ctx: ToolContext): Promise<ToolErrorBody | null> {
  if (def.kind !== 'write' || def.uiOnly || FLOW_OFF_ALLOWED.has(def.name) || !ctx.settings) return null;
  const kind = ctx.principal?.kind;
  if (kind !== 'user' && kind !== 'key') return null;
  const s = ctx.settings;
  const policy = s.policy();
  const pref = policy.flowPolicy === 'optional' ? await s.clients.get(s.project, clientIdentity(ctx).id).catch(() => undefined) : undefined;
  const eff = effective(policy, pref);
  if (eff.flow !== 'off') return null;
  return {
    code: 'flow_off',
    message: flowOffMessage(eff),
    path: 'name',
    hint: eff.flowByPolicy ? 'work directly in the code; read Mandate for context only. A Mandate admin changes the project policy in Settings → Agent flow.' : 'work directly in the code; read Mandate for context only. To use Mandate again the user runs /mandate-flow on (flow_set {"flow":"on"}).',
  };
}

/** The news feed of an agent client's call (null: the web UI, in-process callers, endpoints without settings). */
export function newsOf(ctx: ToolContext): NewsService | null {
  const kind = ctx.principal?.kind;
  if ((kind !== 'user' && kind !== 'key') || !ctx.settings) return null;
  return ctx.news ?? (ctx.activity ? newsFallback(ctx.settings.project, ctx.activity) : null);
}

/** Tools whose replies carry no news notice (the news tools themselves). */
const NO_NOTICE = new Set(['news_list', 'news_ack']);
const FLOW_SET_TOOLS = new Set(['flow_set', 'project_flow_set']);

/**
 * News bookkeeping around an agent client's call (never fails the call): record what it now owns (WATCH_TOOLS), mark
 * news read when it reads the referenced item, detect flow changes, and add the unread items as `news` to the reply.
 */
async function withNews(def: AnyToolDef, rawArgs: unknown, ctx: ToolContext, res: CallToolResult): Promise<CallToolResult> {
  notePresence(ctx, rawArgs);
  const news = newsOf(ctx);
  if (!news) return res;
  try {
    const me = clientIdentity(ctx);
    const session = ctx.session?.id ?? null;
    news.touch(session, ctx.session);
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    const body = res.structuredContent as Record<string, any> | undefined;
    if (!res.isError && body) {
      const w = WATCH_TOOLS[def.name];
      if (w) {
        const refs = w.refs(body, args).filter((r): r is string => typeof r === 'string' && r.length > 0);
        const watch = async (ref: string, role: string) => news.watch({ client: me.id, ref, session, agent: (typeof args.agent === 'string' && args.agent) || ctx.clientName || me.client, user: principalUser(ctx) ?? null, role });
        if (w.unwatch) await news.unwatch(me.id, refs);
        else for (const ref of refs) await watch(ref, w.role);
        if (w.then) for (const ref of w.then.refs(body).filter((r): r is string => typeof r === 'string' && r.length > 0)) await watch(ref, w.then.role);
      }
      if (def.kind === 'read' || def.name === 'comment_add') await news.markReadRefs(me.id, readRefs(def.name, args, body));
    }
    if (NO_NOTICE.has(def.name)) return res;
    const notice = await news.notice(me.id, session);
    if (!notice) return res;
    const structured = { ...(body ?? {}), news: notice };
    const text = JSON.stringify(structured);
    const first = res.content?.[0];
    const prevText = first && first.type === 'text' ? first.text : '';
    return { ...res, content: [{ type: 'text', text: text.length <= MAX_TEXT ? text : `${prevText}\n${JSON.stringify({ news: notice })}` }, ...(res.content ?? []).slice(1)], structuredContent: structured };
  } catch {
    return res;
  }
}

/** Agent presence: this client called a tool (it is online, under this agent name, on this code repo). Never fails the call. */
function notePresence(ctx: ToolContext, rawArgs: unknown): void {
  try {
    const kind = ctx.principal?.kind;
    if (kind !== 'user' && kind !== 'key') return;
    const news = newsOfProject(ctx);
    if (!news) return;
    const a = (rawArgs as { agent?: unknown } | null)?.agent;
    news.presence.note(clientIdentity(ctx), (typeof a === 'string' && a) || ctx.clientName, ctx.session?.codeContext?.repo);
  } catch {
    // presence is best effort
  }
}

/** Flow settings: a change since this client's last call is client-wide news (its own flow_set is not). Before the call, so news_ack can clear it. */
async function flowNews(def: AnyToolDef, ctx: ToolContext): Promise<void> {
  const news = newsOf(ctx);
  if (!news) return;
  try {
    const me = clientIdentity(ctx);
    const s = ctx.settings!;
    const policy = s.policy();
    const eff = effective(policy, await s.clients.get(s.project, me.id).catch(() => undefined));
    const sig = `${eff.flow}|${eff.questions}`;
    const prev = await news.store.flowSig(s.project, me.id);
    if (prev !== sig) {
      await news.store.setFlowSig(s.project, me.id, sig);
      if (prev !== undefined && !FLOW_SET_TOOLS.has(def.name)) await news.addClientWide(me.id, 'flow_changed', `mandate://projects/${s.project}`, `Mandate flow settings changed (${eff.reason}). New instructions: ${flowInstructions(eff)}`);
    }
  } catch {
    // never fails the call
  }
}

/** Stale claims (no event): swept on agent calls, throttled in the news service. Never fails the call. */
async function claimNews(ctx: ToolContext): Promise<void> {
  const news = newsOf(ctx);
  if (!news) return;
  await news.sweepStaleClaims(() => ctx.storage.workOrders.list()).catch(() => undefined);
}

/** Validate and run one tool call (agent clients: with their news). Never throws. */
export async function callTool(def: AnyToolDef, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  // A merged tool runs the per-type tool its ref / `of` selects, exactly as a direct call of that tool.
  if (def.route) {
    const r = def.route(rawArgs);
    return 'error' in r ? errorResult(r.error) : callTool(r.def, r.args, ctx);
  }
  await flowNews(def, ctx);
  await claimNews(ctx);
  const res = await runCall(def, rawArgs, ctx);
  // Its own flow change: record the new setting silently.
  if (FLOW_SET_TOOLS.has(def.name)) await flowNews(def, ctx);
  return withNews(def, rawArgs, ctx, res);
}

async function runCall(def: AnyToolDef, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  if (ctx.presetIds && def.kind === 'write') {
    const { args, presets } = takePresetIds(def.name, rawArgs);
    if (presets) return withPresetIds(presets, () => runCall(def, args, { ...ctx, presetIds: false }));
  }
  // Before validation: an agent whose flow is off learns that, not a schema detail.
  const off = await flowOffRefusal(def, ctx);
  if (off) return errorResult(off);
  const keys = keysOf(def.input);
  let args: unknown;
  try {
    args = def.input.parse(rawArgs ?? {});
  } catch (e) {
    return errorResult(toToolError(e, keys));
  }
  if (def.uiOnly) {
    if (ctx.principal?.kind !== 'ui') return errorResult({ code: 'forbidden', message: `${def.name} is an admin action of the web UI; agents cannot call it`, path: 'name', hint: 'ask the user to change it in Settings → Agent flow' });
    if (!(ctx.settings?.isAdmin(ctx.principal.user.login) ?? false)) return errorResult({ code: 'forbidden', message: 'only Mandate admins can change the project policy', path: 'name', hint: 'ask an admin (auth.github.allowedUsers)' });
    return runTool(def, args, ctx, keys);
  }
  if (def.agentOnly && ctx.principal?.kind === 'ui') {
    return errorResult({ code: 'forbidden', message: 'the web UI session is read-only', path: 'name', hint: `${def.name} needs an agent key: Authorization: Bearer <key> on this project's endpoint` });
  }
  if (def.kind !== 'write') {
    const res = await runTool(def, args, ctx, keys);
    return CONTRIBUTOR_TOOLS[def.name] !== undefined ? withContributors(def.name, args as Record<string, unknown>, res, ctx) : res;
  }
  const ui = ctx.principal?.kind === 'ui';
  if (ui && !def.uiAllowed) {
    return errorResult({ code: 'forbidden', message: 'the web UI session is read-only', path: 'name', hint: 'write tools need an agent key: Authorization: Bearer <key> on this project\'s endpoint' });
  }
  if (ui && (ctx.uiAccess ?? 'read') !== 'write') {
    return errorResult({ code: 'forbidden', message: 'recording a decision needs write (push) permission on this project\'s repository; you have read access', path: 'name', hint: 'ask a repository admin for write access (push), then retry' });
  }
  if (!ui && ctx.access === 'read') {
    return errorResult({ code: 'forbidden', message: 'write tools need GitHub push (write) permission on this project\'s repository; you have read access', path: 'name', hint: 'ask a repository admin for write access (push), then retry' });
  }
  const { agent, branch, idempotencyKey, cause, ...rest } = args as Record<string, unknown> & { agent?: string; branch?: string; idempotencyKey?: string; cause?: string | string[] };
  // UI decisions are always recorded as the web UI (never an agent name the browser picked).
  const who = ui ? UI_AGENT : (agent ?? ctx.clientName);
  if (!who) return errorResult({ code: 'agent_required', message: 'no agent identity', path: 'agent', hint: 'pass agent (the agent name, e.g. "my-agent@host") or set clientInfo.name' });
  let trailers: Record<string, string> = {};
  try {
    trailers = Object.fromEntries(
      Object.entries(def.trailers?.(rest) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0 && !RESERVED_TRAILERS.has(e[0].toLowerCase())),
    );
  } catch (e) {
    return errorResult(toToolError(e, keys));
  }
  let causes: string[] = [];
  try {
    const implied = def.causes?.(rest as never) ?? [];
    const given = cause === undefined ? [] : Array.isArray(cause) ? cause : [cause];
    causes = [...new Set(await resolveCauses(ctx.storage, implied.length ? [...given, ...implied] : cause))];
  } catch (e) {
    if (e instanceof CauseError) return errorResult({ code: 'invalid_cause', message: e.message, path: e.path, hint: 'pass existing references: a request, audit finding, work order, spec / standard section, ...' });
    return errorResult(toToolError(e, keys));
  }
  if (causes.length) trailers = { ...trailers, [CAUSE_TRAILER]: causes.join(', ') };
  // The key's name records which agent credential made the write (activity `source`); never the key itself.
  if (ctx.principal?.kind === 'key') trailers = { ...trailers, 'Agent-Key': ctx.principal.keyName };
  // Personal tokens / MCP OAuth: which credential of the acting user made the write.
  if (ctx.principal?.kind === 'user') trailers = { ...trailers, 'Agent-Key': `${ctx.principal.via === 'oauth' ? 'oauth' : 'token'}:${ctx.principal.tokenName}` };
  // The code the session works on (code_context_set): every write records it, intent statements included.
  if (ctx.session?.codeContext) trailers = { ...trailers, [CODE_CONTEXT_TRAILER]: codeContextLabel(ctx.session.codeContext) };
  // Attribution: the triggering user, from the principal only (`Agent-User` kept for compatibility).
  const user = principalUser(ctx);
  if (user) trailers = { ...trailers, [USER_TRAILER]: user, [LEGACY_USER_TRAILER]: user };
  // Team: the users who contributed to the causes are co-authors (GitHub shows them when the repo is pushed).
  if (user && causes.length && coAuthorsEnabled(ctx)) {
    const lines = await coAuthorLines(ctx, causes, user);
    if (lines.length) trailers = { ...trailers, 'Co-authored-by': lines.join('\nCo-authored-by: ') };
  }
  const wctx: ToolContext = { ...ctx, commit: { agent: who, ...(user ? { user } : {}), ...(causes.length ? { causes } : {}), ...(branch ? { branch } : {}), trailers, ...(idempotencyKey ? { idempotencyKey } : {}) } };
  const flowWarning =
    !causes.length && FLOW_CAUSE_TOOLS.test(def.name) && !!ctx.settings && ctx.settings.policy().flowPolicy !== 'off'
      ? `missing_cause: ${def.name} is a step of the Mandate flow; pass cause (the request, audit finding, work order or section this write acts on, e.g. "cause": "mandate://requests/<id>") so lineage records why`
      : null;
  // L-5: a `Request:` trailer (addresses) is recorded as the change's cause; warn when the item targets nothing in
  // the changed document (a wrong cause cannot be removed from history later).
  const addrWarning = await addressesWarning(ctx, rest).catch(() => null);
  const warns = [flowWarning, addrWarning].filter((w): w is string => !!w);
  const run = () => runTool(def, rest, wctx, keys, true, warns.length > 1 ? warns : (warns[0] ?? null));
  // MW-24: the branch is part of the replayed arguments (the same key on another branch is a conflict, not a replay).
  return idempotencyKey ? remember(`${ctx.project ? `${ctx.project.id}:` : ''}${def.name}:${who}:${idempotencyKey}`, JSON.stringify({ ...rest, ...(cause === undefined ? {} : { cause }), ...(branch === undefined ? {} : { branch }) }), run, ctx.idempotency) : run();
}

/** `request_target_mismatch` when a doc edit `addresses` feedback that targets nothing in the edited document (L-5). */
async function addressesWarning(ctx: ToolContext, args: Record<string, unknown>): Promise<string | null> {
  const list = Array.isArray(args.addresses) ? (args.addresses as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const doc = typeof args.ref === 'string' ? parseRef(args.ref) : null;
  if (!list.length || !doc || !['specs', 'standards', 'components'].includes(doc.kind)) return null;
  const docUri = `mandate://${doc.kind}/${doc.id}`;
  const off: string[] = [];
  for (const a of list) {
    const id = parseRef(a)?.id ?? a;
    const fb = await ctx.storage.feedback.get(id).catch(() => null);
    // An intake request filed without targets is linked by the changes that address it (no mismatch).
    if (fb && ((fb.targets ?? []) as string[]).length && !((fb.targets ?? []) as string[]).some((t) => t === docUri || t.startsWith(`${docUri}/`))) off.push(id);
  }
  return off.length ? `request_target_mismatch: ${off.join(', ')} target${off.length === 1 ? 's' : ''} nothing in ${docUri.replace('mandate://', '')}; addresses records it as the cause of this change (lineage), so pass only the request this edit applies` : null;
}

async function runTool(def: AnyToolDef, args: unknown, ctx: ToolContext, keys: string[], write = false, extraWarning: unknown = null): Promise<CallToolResult> {
  try {
    if (!write) return okResult(await def.run(args, ctx));
    // Writes collect the integrity delta of every commit they make (checked inside the write lock, after the gate).
    const { value, integrity } = await collectIntegrity(() => def.run(args, ctx));
    // Writes always report non-blocking warnings (passthrough from the service; [] when none) and `integrity`.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      const warnings = Array.isArray(v.warnings) ? v.warnings : [];
      const more = integrity.introduced.map((i) => `integrity: ${i.rule} at ${i.uri}: ${i.message}${i.hint ? ` (fix: ${i.hint})` : ''}`);
      return okResult({ ...v, warnings: [...warnings, ...(Array.isArray(extraWarning) ? extraWarning : extraWarning ? [extraWarning] : []), ...more], integrity });
    }
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
    inputSchema: toolJsonSchema(def),
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
