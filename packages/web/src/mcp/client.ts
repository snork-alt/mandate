import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { redirectToLogin } from '../auth';
import { createPushLeader, type LeaderEnv, type PushLeader } from './pushLeader';

/** Structured failure of an MCP tool (`isError` result) or of the connection itself. */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path = '',
    readonly hint = '',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

type Notification = { method: string; params?: Record<string, unknown> };
type NotificationHandler = (n: Notification) => void;
type ConnectionHandler = (connected: boolean) => void;

const listeners = new Set<NotificationHandler>();
const connListeners = new Set<ConnectionHandler>();
const emitConn = (c: boolean) => connListeners.forEach((l) => l(c));

/** Request-scoped notifications (sent on a POST response stream to the tab that made the call): never relayed. */
const LOCAL_METHODS = new Set(['notifications/progress', 'notifications/cancelled']);

export interface StreamGate {
  /** The `fetch` for the transport: a GET (standalone SSE stream) is answered locally with 405 unless allowed. */
  fetch: typeof fetch;
  /** Abort the open stream (if any). */
  abort(): void;
  /** A stream is open or being opened. */
  busy(): boolean;
}

/**
 * Gate the SDK's standalone GET stream (opened automatically after `initialize`, and again on every reconnect).
 * Browsers allow 6 HTTP/1.1 connections per origin, so only the elected leader tab may hold one (see pushLeader).
 * A refused GET gets a synthetic 405, which the SDK treats as "server has no stream" without retrying.
 * At most one GET at a time; `onUp` / `onDown` report the stream's life.
 */
export function createStreamGate(opts: { allow: () => boolean; onUp?: () => void; onDown?: () => void; fetch?: typeof fetch }): StreamGate {
  let ctl: AbortController | null = null;
  const base = (...a: Parameters<typeof fetch>) => (opts.fetch ?? fetch)(...a);
  const gated = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return base(input, init);
    if (!opts.allow() || ctl) return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    const mine = new AbortController();
    ctl = mine;
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) mine.abort();
      else outer.addEventListener('abort', () => mine.abort(), { once: true });
    }
    let ended = false;
    const end = (wasUp: boolean) => {
      if (ended) return;
      ended = true;
      if (ctl === mine) ctl = null;
      if (wasUp) opts.onDown?.();
    };
    let res: Response;
    try {
      res = await base(input, { ...init, signal: mine.signal });
    } catch (e) {
      end(false);
      throw e;
    }
    if (!res.ok || !res.body) {
      end(false);
      return res;
    }
    opts.onUp?.();
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            end(true);
            c.close();
          } else c.enqueue(r.value);
        } catch (e) {
          end(true);
          c.error(e);
        }
      },
      cancel(reason) {
        end(true);
        return reader.cancel(reason);
      },
    });
    mine.signal.addEventListener('abort', () => end(true), { once: true });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return {
    fetch: gated as typeof fetch,
    abort: () => ctl?.abort(),
    busy: () => ctl !== null,
  };
}

/** Push-stream state as seen by this tab (own stream or the leader tab's), for the reconnect backfill. */
let pushUp: 'unknown' | 'up' | 'down' = 'unknown';
let pushSrc: string | null = null;
function pushStreamUp(src: string) {
  // A new stream after a gap (a drop, or another leader taking over): events may have been missed → reconnect.
  const gap = pushUp === 'down' || (pushSrc !== null && pushSrc !== src);
  pushUp = 'up';
  pushSrc = src;
  if (gap) emitConn(true);
}
function pushStreamDown() {
  if (pushUp === 'up') emitConn(false);
  pushUp = 'down';
}

/** Leader-election environment (tests inject fakes). */
let leaderEnv: LeaderEnv | undefined;
export function __setLeaderEnv(env: LeaderEnv | undefined): void {
  leaderEnv = env;
}

/** One MCP Streamable HTTP connection (lazy, reconnecting) to `path`. */
class Connection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly gate: StreamGate;
  private leader: PushLeader | null = null;
  private streamSeq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 1_000;
  private closed = false;
  private lastSrc = '';

  constructor(
    readonly path: string,
    /**
     * Project connection: holds the push stream (when this tab is the elected leader), and notifications and
     * connection changes fan out to the global subscribers. Others (unscoped, side) never open a stream.
     */
    private readonly broadcast: boolean,
  ) {
    this.gate = createStreamGate({
      allow: () => !this.closed && !!this.leader?.isLeader(),
      onUp: () => {
        this.retryMs = 1_000;
        const src = `${this.leader?.id ?? 'local'}:${++this.streamSeq}`;
        this.leader?.publish({ t: 'up', src });
        this.lastSrc = src;
        pushStreamUp(src);
      },
      onDown: () => {
        this.leader?.publish({ t: 'down', src: this.lastSrc });
        pushStreamDown();
        if (this.leader?.isLeader()) this.scheduleStream();
      },
    });
    if (broadcast) {
      this.leader = createPushLeader(
        path,
        {
          onLead: () => this.scheduleStream(0),
          onFollow: () => {
            if (this.retryTimer) clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
            if (this.gate.busy()) this.gate.abort();
          },
          onMessage: (m) => {
            if (this.closed) return;
            if (m.t === 'ev') for (const l of listeners) l(m.n);
            else if (m.t === 'up') pushStreamUp(m.src);
            else pushStreamDown();
          },
        },
        leaderEnv,
      );
    }
  }

  /** Leader: (re)open the push stream after `ms` (backoff on repeated failures). */
  private scheduleStream(ms = this.retryMs) {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureStream();
    }, ms);
  }

  private async ensureStream() {
    if (this.closed || !this.leader?.isLeader() || this.gate.busy()) return;
    try {
      const c = await this.get();
      if (this.closed || !this.leader?.isLeader()) return;
      // The SDK opens the stream itself right after initialize; give that GET a moment before opening our own.
      await new Promise((r) => setTimeout(r, 50));
      if (this.gate.busy() || this.client !== c) return;
      await (c.transport as StreamableHTTPClientTransport).resumeStream('');
    } catch (e) {
      if (this.closed || !this.leader?.isLeader()) return;
      // Session gone (server restart): start a new session (its initialize opens the stream).
      if ((e as { code?: unknown }).code === 404) await this.reset(false);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
      this.scheduleStream();
    }
  }

  private create(): Promise<Client> {
    const c = new Client({ name: 'mandate-web', version: '0.1.0' });
    if (this.broadcast) {
      // Server notifications (e.g. `notifications/mandate/activity`) fan out to onNotification() subscribers,
      // and the leader relays the stream's notifications to the other tabs.
      c.fallbackNotificationHandler = async (n) => {
        if (this.client !== c) return;
        for (const l of listeners) l(n as Notification);
        if (!LOCAL_METHODS.has(n.method)) this.leader?.publish({ t: 'ev', n: n as Notification });
      };
    }
    c.onclose = () => {
      if (this.client === c) {
        this.client = null;
        if (this.broadcast) emitConn(false);
      }
    };
    const p = c
      .connect(new StreamableHTTPClientTransport(new URL(this.path, window.location.origin), { requestInit: { credentials: 'same-origin' }, fetch: this.gate.fetch }))
      .then(() => {
        this.client = c;
        if (this.broadcast) emitConn(true);
        return c;
      })
      .finally(() => {
        this.connecting = null;
      });
    this.connecting = p;
    return p;
  }

  get(): Promise<Client> {
    return this.client ? Promise.resolve(this.client) : (this.connecting ?? this.create());
  }

  sessionId(): string | undefined {
    return (this.client?.transport as StreamableHTTPClientTransport | undefined)?.sessionId;
  }

  async reset(final = false): Promise<void> {
    if (final) {
      this.closed = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.leader?.stop();
    }
    this.gate.abort();
    const old = this.client;
    this.client = null;
    this.connecting = null;
    try {
      await old?.close();
    } catch {
      /* already gone */
    }
  }
}

/** Unscoped endpoint (`/mcp`: `project_list` only), used by the project picker. */
const root = new Connection('/mcp', false);
let projectId: string | null = null;
let project: Connection | null = null;

/** MCP endpoint of a project. */
export const projectMcpPath = (id: string) => `/p/${encodeURIComponent(id)}/mcp`;

/** Scope the shared client to a project (call before rendering its pages). Switching closes the old session. */
export function setMcpProject(id: string | null): void {
  if (id === projectId) return;
  const old = project;
  projectId = id;
  pushUp = 'unknown';
  pushSrc = null;
  project = id ? new Connection(projectMcpPath(id), true) : null;
  if (old) {
    void old.reset(true);
    // Deferred: this runs while the new project tree renders; subscribers set React state.
    queueMicrotask(() => emitConn(false));
  }
}

/** The project the client is scoped to. */
export const getMcpProject = () => projectId;

function current(): Connection {
  if (!project) throw new McpToolError('no_project', 'no project selected', '', 'open a project first');
  return project;
}

/** Subscribe to connect / disconnect of the project session (the activity feed backfills on reconnect). */
export function onConnectionChange(handler: ConnectionHandler): () => void {
  connListeners.add(handler);
  return () => connListeners.delete(handler);
}

/** The connected client of the current project (connects lazily on first use). */
export function getMcpClient(): Promise<Client> {
  return current().get();
}

/** Session id of the current connection, if connected. */
export function getMcpSessionId(): string | undefined {
  return project?.sessionId();
}

/** Subscribe to server notifications; returns the unsubscribe function. */
export function onNotification(handler: NotificationHandler): () => void {
  listeners.add(handler);
  if (project) void project.get().catch(() => undefined);
  return () => listeners.delete(handler);
}

/** Transport/session failures (server restart, 404 session not found) as opposed to JSON-RPC errors. */
const isTransportError = (e: unknown) => !(e instanceof McpToolError) && !(e instanceof McpError && e.code !== -32000 && e.code !== -32001);

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

/** Call a tool and return its `structuredContent`; throws `McpToolError` for failures. */
export interface CallOptions {
  /** Request timeout (the SDK default is 60 s). */
  timeoutMs?: number;
  /** Reconnect and retry once on a lost session (default true; off for non-idempotent calls like `ask_post`). */
  retry?: boolean;
}

export async function callTool<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal, opts: CallOptions = {}): Promise<T> {
  return callOn<T>(current(), name, args, signal, opts);
}

/** Side connections to other projects (Settings runs outside a project; never broadcasts notifications). */
const side = new Map<string, Connection>();
/** Call a tool of a given project without changing the current project scope. */
export function callProjectTool<T>(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let c = side.get(id);
  if (!c) side.set(id, (c = new Connection(projectMcpPath(id), false)));
  return callOn<T>(c, name, args, signal, {});
}

/** Call a tool of the unscoped endpoint (`project_list`). */
export function callRootTool<T>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  return callOn<T>(root, name, args, signal, {});
}

async function callOn<T>(conn: Connection, name: string, args: Record<string, unknown>, signal?: AbortSignal, opts: CallOptions = {}): Promise<T> {
  let result: ToolResult;
  const reqOpts = { signal, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) };
  try {
    result = (await (await conn.get()).callTool({ name, arguments: args }, undefined, reqOpts)) as ToolResult;
  } catch (e) {
    if (isUnauthorized(e)) return unauthorized();
    if (signal?.aborted || opts.retry === false || !isTransportError(e)) throw toToolError(e);
    // Session lost (e.g. server restart): reconnect once and retry.
    await conn.reset();
    try {
      result = (await (await conn.get()).callTool({ name, arguments: args }, undefined, reqOpts)) as ToolResult;
    } catch (e2) {
      if (isUnauthorized(e2)) return unauthorized();
      throw toToolError(e2);
    }
  }
  if (result.isError) {
    const err = (result.structuredContent as { error?: Record<string, string> } | undefined)?.error;
    throw new McpToolError(err?.code ?? 'tool_error', err?.message ?? result.content?.[0]?.text ?? `${name} failed`, err?.path, err?.hint, (err as { detail?: unknown } | undefined)?.detail);
  }
  return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null')) as T;
}

/** HTTP 401 from the MCP endpoint (no or expired sign-in). */
export function isUnauthorized(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === 401 || (typeof err?.message === 'string' && /\(HTTP 401\)|\b401 Unauthorized\b/.test(err.message));
}

function unauthorized(): never {
  redirectToLogin();
  throw new McpToolError('unauthorized', 'not signed in', '', 'sign in with GitHub');
}

function toToolError(e: unknown): Error {
  if (e instanceof McpToolError || (e instanceof DOMException && e.name === 'AbortError')) return e as Error;
  const msg = e instanceof Error ? e.message : String(e);
  return new McpToolError('connection_error', `MCP server unreachable: ${msg}`, '', 'check that the Mandate server is running');
}
