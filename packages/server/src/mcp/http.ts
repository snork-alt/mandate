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
import { QUESTION_ANSWERED_NOTIFICATION } from './tools/questions.js';
import { ACTIVITY_NOTIFICATION, MCP_SERVER_NAME, type ActivityEvent } from '@mandate/shared';
import { z } from 'zod';
import { matchesFilter } from '../events/bus.js';
import { authenticate, LOOPBACK_HOSTS, hostName, originOk, rpcError, type AuthOptions, type Principal } from '../auth/http.js';
import type { Access, RepoPermissions } from '../auth/github-perms.js';
import { resourceMetadataUrl } from '../auth/mcp-oauth.js';
import { maskKey } from '../auth/keys.js';
import type { ProjectRegistry, ProjectRuntime } from '../projects/registry.js';
import { callTool, defineTool, describeTool, type SessionState, type ToolContext } from './define.js';
import { registerUploadRoutes, UploadService } from './uploads.js';
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
  /** Current access (updated on every request). */
  access: Access;
  /** UI sessions: the signed-in user's own repo access (uiAllowed decision tools); updated on every request. */
  uiAccess: Access;
}

export interface McpRouteOptions {
  projects: ProjectRegistry;
  auth: AuthOptions;
  /** Extra hostnames accepted in the Host header (DNS-rebinding protection; local hosts are always allowed). */
  allowedHosts?: string[];
  /** Team: per-project access from GitHub repo permissions (users without access get 404). */
  perms?: RepoPermissions;
  /** Team: the public URL (401s point agents at the OAuth protected-resource metadata). */
  publicUrl?: string;
  /** Base URL agents reach this server at (upload URLs, UI links); default: from the request's Host. */
  baseUrl?: string;
  /** One-time section upload URLs (server secret, server-state db); default: a per-process key, in-memory use tracking. */
  uploads?: UploadService;
}

export const samePrincipal = (a: Principal, b: Principal) =>
  a.kind === 'ui' ? b.kind === 'ui' && b.user.login === a.user.login : a.kind === 'key' ? b.kind === 'key' && a.keyId === b.keyId : b.kind === 'user' && a.login === b.login && a.via === b.via && a.tokenId === b.tokenId;

/** The GitHub login a principal acts as (null for shared project keys). */
export const loginOf = (p: Principal): string | null => (p.kind === 'ui' ? p.user.login : p.kind === 'user' ? p.login : null);

export function registerMcp(app: FastifyInstance, opts: McpRouteOptions): McpHub {
  const { projects } = opts;
  const sessions = new Map<string, Session>();
  const allowed = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? [])]);
  const hostOk = (req: FastifyRequest) => allowed.has(hostName(req.headers.host ?? ''));

  const sessionOf = (req: FastifyRequest) => {
    const id = req.headers['mcp-session-id'];
    return typeof id === 'string' ? sessions.get(id) : undefined;
  };

  /** Host check, project lookup, authentication, GitHub permission. Returns null after replying with the error. */
  const gate = async (req: FastifyRequest, reply: FastifyReply, project: string | null): Promise<{ principal: Principal; access: Access; uiAccess: Access } | null> => {
    if (!hostOk(req)) {
      rpcError(reply, 403, -32000, 'forbidden host');
      return null;
    }
    const cfg = project !== null ? projects.config(project) : undefined;
    if (project !== null && !cfg) {
      rpcError(reply, 404, -32004, `unknown project '${project}'`);
      return null;
    }
    const auth = await authenticate(req, project, opts.auth);
    if (!auth.ok) {
      const meta = opts.publicUrl && project && opts.auth.oauth ? `Bearer resource_metadata="${resourceMetadataUrl(opts.publicUrl, project)}"` : undefined;
      rpcError(reply, auth.status, auth.status === 401 ? -32001 : -32000, auth.message, meta);
      return null;
    }
    const p = auth.principal;
    let access: Access = p.kind === 'ui' ? 'read' : 'write';
    // No GitHub permissions (local-folder projects of older installs): the signed-in user may record decisions.
    let uiAccess: Access = p.kind === 'ui' ? 'write' : 'none';
    const login = loginOf(p);
    if (project !== null && login && opts.perms) {
      access = await opts.perms.access(login, cfg);
      // No access: indistinguishable from an unknown project.
      if (access === 'none') {
        rpcError(reply, 404, -32004, `unknown project '${project}'`);
        return null;
      }
      if (p.kind === 'ui') {
        uiAccess = access;
        access = 'read';
      }
    }
    return { principal: p, access, uiAccess };
  };

  const uploads = opts.uploads ?? new UploadService();
  const newSession = async (project: string | null, principal: Principal, access: Access, baseUrl: string): Promise<Session> => {
    const state: SessionState = { subscription: null, asked: new Set() };
    let server: McpServer;
    if (project === null) {
      server = createProjectListServer(projects, principal, opts.perms);
    } else {
      const rt = await projects.open(project);
      // The access level is re-evaluated on every request (cached GitHub permissions), so read it live.
      const base = { ...rt.ctx, principal, uploads, baseUrl } as ToolContext;
      Object.defineProperty(base, 'access', { enumerable: true, get: () => session.access });
      Object.defineProperty(base, 'uiAccess', { enumerable: true, get: () => (session.principal.kind === 'ui' && session.uiAccess === 'write' ? 'write' : 'read') });
      server = createMcpServer(base, state);
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session: Session = { transport, server, state, project, principal, access, uiAccess: 'none' };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  };

  const post = (projectOf: (req: FastifyRequest) => string | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    const project = projectOf(req);
    const g = await gate(req, reply, project);
    if (!g) return reply;
    const { principal, access, uiAccess } = g;
    let session = sessionOf(req);
    if (session && (session.project !== project || !samePrincipal(session.principal, principal))) {
      return rpcError(reply, 404, -32001, 'session not found; reinitialize');
    }
    if (!session) {
      if (req.headers['mcp-session-id']) return rpcError(reply, 404, -32001, 'session not found; reinitialize');
      if (!isInitializeRequest(req.body)) return rpcError(reply, 400, -32000, 'no session: send an initialize request first');
      try {
        session = await newSession(project, principal, access, opts.baseUrl ?? `${req.protocol}://${req.headers.host}`);
      } catch (e) {
        req.log.error(`mcp: ${(e as Error).message}`);
        return rpcError(reply, 503, -32000, `project '${project}' is unavailable: ${(e as Error).message}`);
      }
    }
    session.access = access;
    session.uiAccess = uiAccess;
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  const streamOrDelete = (projectOf: (req: FastifyRequest) => string | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    const project = projectOf(req);
    const g = await gate(req, reply, project);
    if (!g) return reply;
    const { principal } = g;
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
  // Section uploads (curl): PUT /p/<id>/sections/... (bearer) and PUT /p/<id>/uploads/<token> (one-time URL).
  registerUploadRoutes(app, { projects, auth: opts.auth, ...(opts.perms ? { perms: opts.perms } : {}), uploads, hostOk, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), samePrincipal });

  const hub: McpHub = {
    sessions: () => [...sessions.keys()],
    async broadcastActivity(event, project) {
      // The session that asked a question hears about its answer, whatever its activity filter.
      if (event.type === 'question.answered') {
        const id = event.refs[0]?.split('/').pop() ?? '';
        await Promise.all(
          [...sessions.values()]
            .filter((s) => s.project === project && s.state.asked?.has(id))
            .map((s) => {
              s.state.asked!.delete(id);
              return (s.server.server.notification as (n: { method: string; params: Record<string, unknown> }) => Promise<void>)({
                method: QUESTION_ANSWERED_NOTIFICATION,
                params: { id, ref: event.refs[0]!, summary: event.summary, answers: (event.details as Record<string, unknown> | undefined)?.answers ?? {}, hint: 'question_get for the full answer; cite it as cause of the writes it decides' },
              }).catch(() => undefined);
            }),
        );
      }
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

function createProjectListServer(projects: ProjectRegistry, principal: Principal, perms?: RepoPermissions): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, title: 'Mandate (projects)', version: MCP_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: 'Mandate projects. Each project has its own MCP endpoint at /p/<id>/mcp; connect there with that project\'s key.' },
  );
  const def = {
    ...PROJECT_LIST_TOOL,
    run: async () => {
      const login = loginOf(principal);
      const candidates = projects.list().map((p) => p.id).filter((id) => principal.kind === 'ui' || principal.project === id);
      // Team: only projects the user can read (GitHub repo permissions); each item says read / write.
      const accessById = new Map<string, Access>();
      for (const id of candidates) accessById.set(id, login && perms ? await perms.access(login, projects.config(id)) : 'write');
      const ids = candidates.filter((id) => accessById.get(id) !== 'none');
      await projects.refreshTokens(ids.flatMap((id) => projects.config(id)?.github?.connectedBy ?? [])).catch(() => undefined);
      const items = await Promise.all(ids.map(async (id) => ({ ...(await projectSummary(await projects.open(id).catch(() => null), projects.info(id)!)), access: accessById.get(id) })));
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
export async function uiGate(req: FastifyRequest, reply: FastifyReply, opts: { auth: AuthOptions }, hostOk: (req: FastifyRequest) => boolean): Promise<Principal | null> {
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
  const auth = await authenticate(req, null, opts.auth);
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
  // The "Connect agent" popup, for signed-in users who can read the project (others: 404).
  const readable = async (req: FastifyRequest, reply: FastifyReply, project: string) => {
    const p = await uiGate(req, reply, opts, hostOk);
    if (!p || p.kind !== 'ui') return null;
    const cfg = opts.projects.config(project);
    const access: Access = !cfg ? 'none' : opts.perms ? await opts.perms.access(p.user.login, cfg) : 'write';
    if (access === 'none') {
      rpcError(reply, 404, -32004, `unknown project '${project}'`);
      return null;
    }
    return { user: p.user, access, cfg: cfg! };
  };

  app.get('/ui/p/:projectId/connect', async (req, reply) => {
    const project = (req.params as { projectId: string }).projectId;
    const r = await readable(req, reply, project);
    if (!r) return reply;
    const info = opts.projects.info(project)!;
    reply.header('Cache-Control', 'no-store');
    const perUser = !!opts.auth.agentTokens;
    const k = perUser ? null : (opts.auth.keys.list().find((x) => x.project === project) ?? null);
    return {
      project: { id: info.id, name: info.name },
      mcpPath: info.mcpPath,
      ...(opts.publicUrl ? { mcpUrl: `${opts.publicUrl}${info.mcpPath}` } : {}),
      /** 'oauth': agents sign in with GitHub (MCP OAuth) or use a personal token; 'key': the shared project key. */
      auth: perUser ? 'oauth' : 'key',
      access: r.access,
      key: k ? { id: k.id, name: k.name, value: k.key, masked: maskKey(k.key), createdAt: k.createdAt } : null,
      keysFile: perUser ? null : opts.auth.keys.file,
      cli: perUser
        ? { create: 'Connect dialog → Personal tokens', list: 'Connect dialog → Personal tokens', revoke: 'Connect dialog → Personal tokens' }
        : { create: `npm run mandate -- key create ${project} --name <name>`, list: 'npm run mandate -- key list', revoke: 'npm run mandate -- key revoke <key-id>' },
    };
  });

  // Team: the signed-in user's personal agent tokens for a project (shown once at creation; hashed at rest).
  if (opts.auth.agentTokens) {
    const tokens = opts.auth.agentTokens;
    app.get('/ui/p/:projectId/tokens', async (req, reply) => {
      const project = (req.params as { projectId: string }).projectId;
      const r = await readable(req, reply, project);
      if (!r) return reply;
      reply.header('Cache-Control', 'no-store');
      return { items: await tokens.list(r.user.login, project) };
    });
    app.post('/ui/p/:projectId/tokens', async (req, reply) => {
      const project = (req.params as { projectId: string }).projectId;
      if (!originOk(req, opts.auth.uiOrigins)) return rpcError(reply, 403, -32000, 'forbidden: Origin must be same-origin');
      const r = await readable(req, reply, project);
      if (!r) return reply;
      const name = String((req.body as { name?: unknown } | undefined)?.name ?? '').trim();
      try {
        const t = await tokens.create(r.user.login, project, name || 'agent');
        reply.header('Cache-Control', 'no-store');
        return reply.code(201).send({ token: t.token, record: t.record, access: r.access });
      } catch (e) {
        return reply.code(400).send({ error: { code: 'invalid_input', message: (e as Error).message, path: 'name' } });
      }
    });
    app.delete('/ui/p/:projectId/tokens/:tokenId', async (req, reply) => {
      const { projectId, tokenId } = req.params as { projectId: string; tokenId: string };
      if (!originOk(req, opts.auth.uiOrigins)) return rpcError(reply, 403, -32000, 'forbidden: Origin must be same-origin');
      const r = await readable(req, reply, projectId);
      if (!r) return reply;
      return (await tokens.revoke(r.user.login, tokenId)) ? reply.code(204).send() : reply.code(404).send({ error: { code: 'not_found', message: 'no such token' } });
    });
  }
}
