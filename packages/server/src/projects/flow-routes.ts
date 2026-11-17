/**
 * Web UI endpoints for Settings → Agent flow and the sidebar badge (session cookie + X-Mandate-UI, Origin-checked
 * writes, allowed hosts only):
 * - GET  /ui/flow[?project=<id>]                       policy, my clients, and (team admins) every client
 * - PUT  /ui/flow/:project/policy                      { flowPolicy? }   admins only
 * Client preferences (flow, questions) are read-only here: only the agent changes them (flow_set,
 * /mandate-flow), so the user's switch and the agent's memory never disagree.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, originOk, type AuthOptions } from '../auth/http.js';
import type { ProjectConfig } from '../config.js';
import type { ProjectRegistry } from './registry.js';
import { effective, flowChangedEvent, policyChanges, policyPatchSchema, type ClientRecord, type Policy, type ProjectSettings } from './settings.js';

export interface FlowRouteDeps {
  auth: AuthOptions;
  hostOk: (req: FastifyRequest) => boolean;
  registry: ProjectRegistry;
  /** Settings of a project (policy + client store). */
  settings: (id: string) => ProjectSettings;
  /** Team: the user's access to a project (projects without access are hidden). */
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

const row = (policy: Policy, r: ClientRecord) => {
  const eff = effective(policy, r);
  return {
    ...r,
    effective: { flow: eff.flow, questions: eff.questions },
    // Locked = enforced by the project policy (the client preference has no effect).
    locked: { flow: policy.flowPolicy !== 'optional' },
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
    return { login, admin: d.auth.isAdmin?.(login) !== false };
  };
  const visible = async (login: string, id: string): Promise<ProjectConfig> => {
    const p = d.registry.config(id);
    if (!p) throw new HttpError(404, 'not_found', `no project '${id}'`);
    if (d.access && (await d.access(login, p)) === 'none') throw new HttpError(404, 'not_found', `no project '${id}'`);
    return p;
  };
  /** My clients: the signed-in user's. */
  const mine = (s: ProjectSettings, login: string) => s.clients.list(s.project, { user: login });
  const emit = async (project: string, fields: string[], login: string) => {
    const rt = await d.registry.open(project).catch(() => null);
    const e = flowChangedEvent(project, fields, { agent: 'mandate-ui', user: login }, (await rt?.git.head().catch(() => null)) ?? '');
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
        const my = (await mine(s, who.login)).map((r) => row(policy, r));
        const all = who.admin ? (await s.clients.list(id)).map((r) => row(policy, r)) : undefined;
        projects.push({ id, name: p.name, policy, mine: my, ...(all ? { all } : {}) });
      }
      return { admin: who.admin, user: who.login, projects };
    }),
  );

  app.put(
    '/ui/flow/:project/policy',
    handle(async (req, who) => {
      const { project } = req.params as { project: string };
      await visible(who.login, project);
      if (!who.admin) throw new HttpError(403, 'forbidden', 'only Mandate admins can change the project policy');
      const b = policyPatchSchema.parse(req.body);
      if (!Object.values(b).some((v) => v !== undefined)) throw new HttpError(400, 'invalid_input', 'pass flowPolicy, strictFlow, commit, branch, push or components');
      const s = d.settings(project);
      const before = s.policy();
      const policy = await s.setPolicy(b);
      await emit(project, policyChanges(before, policy), who.login);
      return { policy };
    }),
  );
}
