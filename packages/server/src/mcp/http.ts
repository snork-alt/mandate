/**
 * Streamable HTTP endpoints, one per project at `/p/<projectId>/mcp`: POST (JSON-RPC, JSON or SSE responses), GET
 * (the standalone SSE stream for server notifications) and DELETE (end session). One transport + McpServer per
 * session, bound to its project and to the principal that opened it (agent key or the web UI cookie).
 * Every request is authenticated again (a revoked key stops working mid-session). Unknown project → 404.
 * The unscoped `/mcp` exposes only `project_list` (the web UI home).
 * Also mounted here: `POST /ui/session` (web UI cookie) and `GET /ui/p/<id>/connect` (the "Connect agent" popup).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACTIVITY_NOTIFICATION, MCP_SERVER_NAME, type ActivityEvent } from '@mandate/shared';
import { z } from 'zod';
import { matchesFilter } from '../events/bus.js';
import { authenticate, LOOPBACK_HOSTS, hostName, rpcError, type AuthOptions, type Principal } from '../auth/http.js';
import { maskKey } from '../auth/keys.js';
import type { ProjectRegistry, ProjectRuntime } from '../projects/registry.js';
import { callTool, defineTool, describeTool, type SessionState, type ToolContext } from './define.js';
import { createMcpServer, MCP_VERSION } from './server.js';

export type { ActivityEvent };

export interface McpHub {
  /** Open sessions (all projects, unscoped included). */
  sessions(): string[];
  /** Send `notifications/mandate/activity` to the sessions of `project` whose subscription matches. */
  broadcastActivity(event: ActivityEvent, project?: string): Promise<void>;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  state: SessionState;
  /** null = the unscoped endpoint. */
  project: string | null;
  principal: Principal;
}

export interface McpRouteOptions {
  projects: ProjectRegistry;
  auth: AuthOptions;
  /** Extra hostnames accepted in the Host header (DNS-rebinding protection; local hosts are always allowed). */
  allowedHosts?: string[];
}

const samePrincipal = (a: Principal, b: Principal) => (a.kind === 'ui' ? b.kind === 'ui' : b.kind === 'key' && a.keyId === b.keyId);

export function registerMcp(app: FastifyInstance, opts: McpRouteOptions): McpHub {
  const { projects } = opts;
  const sessions = new Map<string, Session>();
  const allowed = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? [])]);
  const hostOk = (req: FastifyRequest) => allowed.has(hostName(req.headers.host ?? ''));

  const sessionOf = (req: FastifyRequest) => {
    const id = req.headers['mcp-session-id'];
    return typeof id === 'string' ? sessions.get(id) : undefined;
  };

  /** Host check, project lookup, authentication. Returns null after replying with the error. */
  const gate = (req: FastifyRequest, reply: FastifyReply, project: string | null): Principal | null => {
    if (!hostOk(req)) {
      rpcError(reply, 403, -32000, 'forbidden host');
      return null;
    }
    if (project !== null && !projects.config(project)) {
      rpcError(reply, 404, -32004, `unknown project '${project}'`);
      return null;
    }
    const auth = authenticate(req, project, opts.auth);
    if (!auth.ok) {
      rpcError(reply, auth.status, auth.status === 401 ? -32001 : -32000, auth.message);
      return null;
    }
    return auth.principal;
  };

  const newSession = async (project: string | null, principal: Principal): Promise<Session> => {
    const state: SessionState = { subscription: null };
    let server: McpServer;
    if (project === null) {
      server = createProjectListServer(projects, principal);
    } else {
      const rt = await projects.open(project);
      server = createMcpServer({ ...rt.ctx, principal }, state);
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session: Session = { transport, server, state, project, principal };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  };

  const post = (projectOf: (req: FastifyRequest) => string | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    const project = projectOf(req);
    const principal = gate(req, reply, project);
    if (!principal) return reply;
    let session = sessionOf(req);
    if (session && (session.project !== project || !samePrincipal(session.principal, principal))) {
      return rpcError(reply, 404, -32001, 'session not found; reinitialize');
    }
    if (!session) {
      if (req.headers['mcp-session-id']) return rpcError(reply, 404, -32001, 'session not found; reinitialize');
      if (!isInitializeRequest(req.body)) return rpcError(reply, 400, -32000, 'no session: send an initialize request first');
      try {
        session = await newSession(project, principal);
      } catch (e) {
        req.log.error(`mcp: ${(e as Error).message}`);
        return rpcError(reply, 503, -32000, `project '${project}' is unavailable: ${(e as Error).message}`);
      }
    }
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  const streamOrDelete = (projectOf: (req: FastifyRequest) => string | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    const project = projectOf(req);
    const principal = gate(req, reply, project);
    if (!principal) return reply;
    const session = sessionOf(req);
    if (!session || session.project !== project || !samePrincipal(session.principal, principal)) {
      return rpcError(reply, req.headers['mcp-session-id'] ? 404 : 400, -32001, 'unknown or missing mcp-session-id');
    }
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  };

  const scoped = (req: FastifyRequest) => (req.params as { projectId: string }).projectId;
  const unscoped = () => null;
  app.post('/p/:projectId/mcp', post(scoped));
  app.get('/p/:projectId/mcp', streamOrDelete(scoped));
  app.delete('/p/:projectId/mcp', streamOrDelete(scoped));
  app.post('/mcp', post(unscoped));
  app.get('/mcp', streamOrDelete(unscoped));
  app.delete('/mcp', streamOrDelete(unscoped));

  registerUiRoutes(app, opts, hostOk);

  const hub: McpHub = {
    sessions: () => [...sessions.keys()],
    async broadcastActivity(event, project) {
      await Promise.all(
        [...sessions.values()]
          .filter((s) => s.project !== null && (project === undefined || s.project === project))
          .filter((s) => !s.state.subscription || (s.state.subscription.enabled && matchesFilter(event, s.state.subscription)))
          .map((s) =>
            (s.server.server.notification as (n: { method: string; params: Record<string, unknown> }) => Promise<void>)({
              method: ACTIVITY_NOTIFICATION,
              params: event as unknown as Record<string, unknown>,
            }).catch(() => undefined),
          ),
      );
    },
    async close() {
      await Promise.all([...sessions.values()].map((s) => s.server.close().catch(() => undefined)));
      sessions.clear();
    },
  };
  // Each project's activity feed goes to that project's sessions only.
  const unsubs: (() => void)[] = [];
  const hook = (rt: ProjectRuntime) => {
    if (rt.activity) unsubs.push(rt.activity.subscribe((e) => void hub.broadcastActivity(e, rt.config.id)));
  };
  unsubs.push(projects.onOpened(hook));
  void projects.opened().then((rts) => rts.forEach(hook));
  app.addHook('onClose', async () => {
    unsubs.forEach((u) => u());
    await hub.close();
  });
  return hub;
}

/* ------------------------------------------------------------------ unscoped endpoint: project_list */

export const PROJECT_LIST_TOOL = defineTool({
  name: 'project_list',
  title: 'List projects',
  kind: 'read',
  description: `Projects on this Mandate server: id, name, description, data dir, branch, remote, MCP path (/p/<id>/mcp), counts and the last activity. An agent key sees only its own project.
Example: {}`,
  input: z.object({}).strict(),
  run: async () => ({}),
});

export async function projectSummary(rt: ProjectRuntime | null, info: NonNullable<ReturnType<ProjectRegistry['info']>>) {
  if (!rt) return { ...info, counts: null, lastActivity: null, error: 'unavailable' };
  const safe = async <T>(f: () => Promise<T>, d: T) => f().catch(() => d);
  const s = rt.storage;
  const [specs, standards, components, workOrders, feedback, act] = await Promise.all([
    safe(() => s.specs.list().then((x) => x.length), 0),
    safe(() => s.standards.list().then((x) => x.length), 0),
    safe(() => s.components.list().then((x) => x.length), 0),
    safe(() => s.workOrders.list().then((x) => x.length), 0),
    safe(() => s.feedback.list().then((x) => x.length), 0),
    safe(() => rt.activity.list({ limit: 1, includeHeartbeats: false }), null),
  ]);
  const last = (act as { events?: ActivityEvent[] } | null)?.events?.[0];
  return {
    ...info,
    counts: { specs, standards, components, workOrders, feedback },
    lastActivity: last ? { at: last.at, summary: last.summary, ...(last.agent ? { agent: last.agent } : {}) } : null,
  };
}

function createProjectListServer(projects: ProjectRegistry, principal: Principal): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, title: 'Mandate (projects)', version: MCP_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: 'Mandate projects. Each project has its own MCP endpoint at /p/<id>/mcp; connect there with that project\'s key.' },
  );
  const def = {
    ...PROJECT_LIST_TOOL,
    run: async () => {
      const ids = projects.list().map((p) => p.id).filter((id) => principal.kind === 'ui' || principal.project === id);
      await projects.refreshTokens(ids.flatMap((id) => projects.config(id)?.github?.connectedBy ?? [])).catch(() => undefined);
      const items = await Promise.all(ids.map(async (id) => projectSummary(await projects.open(id).catch(() => null), projects.info(id)!)));
      return { defaultProject: projects.defaultProject, items };
    },
  };
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [describeTool(def, def.description as string)] }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== def.name) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unknown_tool', message: `no tool '${req.params.name}' here`, path: 'name', hint: 'project tools live at /p/<id>/mcp' } }) }] };
    }
    return callTool(def, req.params.arguments, { principal } as ToolContext);
  });
  return mcp;
}

/* ------------------------------------------------------------------ web UI routes */

/** UI-only GETs: a signed-in session (never a bearer key) plus `X-Mandate-UI: 1` (a cross-origin page would need a CORS preflight, never granted). */
export function uiGate(req: FastifyRequest, reply: FastifyReply, opts: { auth: AuthOptions }, hostOk: (req: FastifyRequest) => boolean): Principal | null {
  if (!hostOk(req)) {
    rpcError(reply, 403, -32000, 'forbidden host');
    return null;
  }
  if (req.headers.authorization) {
    rpcError(reply, 403, -32000, 'forbidden: UI-only route (sign-in session, not agent keys)');
    return null;
  }
  if (req.headers['x-mandate-ui'] !== '1') {
    rpcError(reply, 403, -32000, 'forbidden: missing X-Mandate-UI header');
    return null;
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    rpcError(reply, 403, -32000, 'forbidden: cross-site request');
    return null;
  }
  const auth = authenticate(req, null, opts.auth);
  if (!auth.ok) {
    rpcError(reply, auth.status, -32001, auth.message);
    return null;
  }
  if (auth.principal.kind !== 'ui') {
    rpcError(reply, 403, -32000, 'forbidden');
    return null;
  }
  return auth.principal;
}

function registerUiRoutes(app: FastifyInstance, opts: McpRouteOptions, hostOk: (req: FastifyRequest) => boolean) {
  // The "Connect agent" popup: the project's MCP path and its first key, for signed-in users only.
  app.get('/ui/p/:projectId/connect', async (req, reply) => {
    const project = (req.params as { projectId: string }).projectId;
    if (!uiGate(req, reply, opts, hostOk)) return reply;
    const info = opts.projects.info(project);
    if (!info) return rpcError(reply, 404, -32004, `unknown project '${project}'`);
    const k = opts.auth.keys.list().find((x) => x.project === project) ?? null;
    reply.header('Cache-Control', 'no-store');
    return {
      project: { id: info.id, name: info.name },
      mcpPath: info.mcpPath,
      key: k ? { id: k.id, name: k.name, value: k.key, masked: maskKey(k.key), createdAt: k.createdAt } : null,
      keysFile: opts.auth.keys.file,
      cli: {
        create: `npm run mandate -- key create ${project} --name <name>`,
        list: 'npm run mandate -- key list',
        revoke: 'npm run mandate -- key revoke <key-id>',
      },
    };
  });
}
