import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { redirectToLogin } from '../auth';

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

/** One MCP Streamable HTTP connection (lazy, reconnecting) to `path`. */
class Connection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    readonly path: string,
    /** Notifications and connection changes fan out to the global subscribers (project connection only). */
    private readonly broadcast: boolean,
  ) {}

  private create(): Promise<Client> {
    const c = new Client({ name: 'mandate-web', version: '0.1.0' });
    if (this.broadcast) {
      // Server notifications (e.g. `notifications/mandate/activity`) fan out to onNotification() subscribers.
      c.fallbackNotificationHandler = async (n) => {
        if (this.client === c) for (const l of listeners) l(n as Notification);
      };
    }
    c.onclose = () => {
      if (this.client === c) {
        this.client = null;
        if (this.broadcast) emitConn(false);
      }
    };
    const p = c
      .connect(new StreamableHTTPClientTransport(new URL(this.path, window.location.origin), { requestInit: { credentials: 'same-origin' } }))
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

  async reset(): Promise<void> {
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
  project = id ? new Connection(projectMcpPath(id), true) : null;
  if (old) {
    void old.reset();
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
  /** Request timeout (the SDK default is 60 s; `ask` runs longer). */
  timeoutMs?: number;
  /** Reconnect and retry once on a lost session (default true; off for non-idempotent calls like `ask`). */
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
