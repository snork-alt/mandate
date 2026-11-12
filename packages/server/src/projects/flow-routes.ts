/**
 * Web UI endpoints for Settings → Agent flow and the sidebar badge (session cookie + X-Mandate-UI, Origin-checked
 * writes, allowed hosts only):
 * - GET  /ui/flow[?project=<id>]                       policy, my clients, and (server-mode admins) every client
 * - PUT  /ui/flow/:project/policy                      { flowPolicy?, approvalPolicy? }   admins only
 * - PUT  /ui/flow/:project/clients/:clientId           { flow?, approval? }  my own clients only (local: any)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, originOk, type AuthOptions } from '../auth/http.js';
import type { ProjectConfig } from '../config.js';
import type { ProjectRegistry } from './registry.js';
import { APPROVAL_POLICIES, QUESTIONS_VIA, effective, FLOW_POLICIES, flowChangedEvent, refusal, type ClientRecord, type Mode, type Policy, type ProjectSettings } from './settings.js';

export interface FlowRouteDeps {
  mode: Mode;
  auth: AuthOptions;
  hostOk: (req: FastifyRequest) => boolean;
  registry: ProjectRegistry;
  /** Settings of a project (policy + client store). */
  settings: (id: string) => ProjectSettings;
  /** Server mode: the user's access to a project (projects without access are hidden). */
  access?: (login: string, p: ProjectConfig) => Promise<'none' | 'read' | 'write'>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const row = (policy: Policy, r: ClientRecord, editable: boolean) => {
  const eff = effective(policy, r);
  return {
    ...r,
    effective: { flow: eff.flow, approval: eff.approval, questions: eff.questions },
    // Locked = enforced by the project policy (the UI also disables approval while this client's flow is off).
    locked: { flow: policy.flowPolicy !== 'optional', approval: policy.approvalPolicy === 'required' },
    editable,
  };
};

export function registerFlowRoutes(app: FastifyInstance, d: FlowRouteDeps): void {
  /** Signed-in UI user (or a reply with the error). */
  const gate = async (req: FastifyRequest): Promise<{ login: string; admin: boolean }> => {
    if (!d.hostOk(req)) throw new HttpError(403, 'forbidden', 'forbidden host');
    if (req.headers['x-mandate-ui'] !== '1') throw new HttpError(403, 'forbidden', 'missing X-Mandate-UI header');
    if (req.method !== 'GET' && !originOk(req, d.auth.uiOrigins)) throw new HttpError(403, 'forbidden', 'Origin must be same-origin');
    const a = await authenticate(req, null, d.auth);
    if (!a.ok || a.principal.kind !== 'ui') throw new HttpError(a.ok ? 403 : a.status, a.ok ? 'forbidden' : 'unauthorized', a.ok ? 'UI-only route (not for agent keys)' : a.message);
    const login = a.principal.user.login;
    return { login, admin: d.mode === 'local' || d.auth.isAdmin?.(login) !== false };
  };
  const visible = async (login: string, id: string): Promise<ProjectConfig> => {
    const p = d.registry.config(id);
    if (!p) throw new HttpError(404, 'not_found', `no project '${id}'`);
    if (d.mode === 'server' && d.access && (await d.access(login, p)) === 'none') throw new HttpError(404, 'not_found', `no project '${id}'`);
    return p;
  };
  /** My clients: server mode = the signed-in user's; local mode = every client (one person, many agents). */
  const mine = (s: ProjectSettings, login: string) => s.clients.list(s.project, d.mode === 'server' ? { user: login } : {});
  const emit = async (project: string, fields: string[], login: string) => {
    const rt = await d.registry.open(project).catch(() => null);
    const e = flowChangedEvent(project, fields, { agent: 'mandate-ui', ...(d.mode === 'server' ? { user: login } : {}) }, (await rt?.git.head().catch(() => null)) ?? '');
    if (e) rt?.activity.emit(e);
  };
  const handle =
    <T>(fn: (req: FastifyRequest, who: { login: string; admin: boolean }) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const who = await gate(req);
        reply.header('Cache-Control', 'no-store');
        return await fn(req, who);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
        if (e instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
        throw e;
      }
    };

  app.get(
    '/ui/flow',
    handle(async (req, who) => {
      const only = (req.query as { project?: string }).project;
      const ids = only ? [only] : d.registry.list().map((p) => p.id);
      const projects = [];
      for (const id of ids) {
        let p: ProjectConfig;
        try {
          p = await visible(who.login, id);
        } catch (e) {
          if (only) throw e;
          continue;
        }
        const s = d.settings(id);
        const policy = s.policy();
        const my = (await mine(s, who.login)).map((r) => row(policy, r, true));
        const all = d.mode === 'server' && who.admin ? (await s.clients.list(id)).map((r) => row(policy, r, r.user?.toLowerCase() === who.login.toLowerCase())) : undefined;
        projects.push({ id, name: p.name, policy, mine: my, ...(all ? { all } : {}) });
      }
      return { mode: d.mode, admin: who.admin, user: d.mode === 'server' ? who.login : null, projects };
    }),
  );

  app.put(
    '/ui/flow/:project/policy',
    handle(async (req, who) => {
      const { project } = req.params as { project: string };
      await visible(who.login, project);
      if (!who.admin) throw new HttpError(403, 'forbidden', 'only Mandate admins can change the project policy');
      const b = z.object({ flowPolicy: z.enum(FLOW_POLICIES).optional(), approvalPolicy: z.enum(APPROVAL_POLICIES).optional() }).strict().parse(req.body);
      if (!b.flowPolicy && !b.approvalPolicy) throw new HttpError(400, 'invalid_input', 'pass flowPolicy and/or approvalPolicy');
      const s = d.settings(project);
      const before = s.policy();
      const policy = await s.setPolicy(b);
      await emit(project, (['flowPolicy', 'approvalPolicy'] as const).filter((k) => before[k] !== policy[k]).map((k) => `${k === 'flowPolicy' ? 'flow policy' : 'approval policy'} ${policy[k]}`), who.login);
      return { policy };
    }),
  );

  app.put(
    '/ui/flow/:project/clients/:clientId',
    handle(async (req, who) => {
      const { project, clientId } = req.params as { project: string; clientId: string };
      await visible(who.login, project);
      const b = z.object({ flow: z.enum(['on', 'off']).optional(), approval: z.enum(['on', 'off']).optional(), questions: z.enum(QUESTIONS_VIA).optional() }).strict().parse(req.body);
      if (!b.flow && !b.approval && !b.questions) throw new HttpError(400, 'invalid_input', 'pass flow, approval and/or questions');
      const s = d.settings(project);
      const cur = await s.clients.get(project, clientId);
      if (!cur) throw new HttpError(404, 'not_found', `no client '${clientId}' on '${project}'`);
      // Server mode: only your own clients (an admin sees every client, read-only).
      if (d.mode === 'server' && cur.user?.toLowerCase() !== who.login.toLowerCase()) throw new HttpError(403, 'forbidden', "you can only change your own agents' flow");
      const policy = s.policy();
      const no = refusal(policy, b);
      if (no) throw new HttpError(409, no.code, no.message);
      const rec = await s.clients.set(project, cur, b, 'ui');
      await emit(project, (['flow', 'approval', 'questions'] as const).filter((k) => b[k] && (cur[k] ?? (k === 'questions' ? 'mandate' : 'on')) !== b[k]).map((k) => `${k} ${k === 'questions' ? `via ${b[k]}` : b[k]} for ${cur.label}`), who.login);
      return { client: row(policy, rec, true) };
    }),
  );
}
