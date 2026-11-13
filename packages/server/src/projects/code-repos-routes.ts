/**
 * Web UI endpoints for Settings → Code repositories (session cookie + X-Mandate-UI, Origin-checked writes):
 * - GET /ui/code-repos[?project=<id>]   per visible project: specs repo, registered code repos, and repo names already
 *                                       used in its data that are not registered yet (`unlinked`)
 * - PUT /ui/code-repos/:project         { codeRepos: [{ name, github, defaultBranch? }] }   admins only
 * The short name is the stable key (code refs use it); renaming a GitHub repo only changes `github`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { codeRepoSchema } from '@mandate/shared';
import { authenticate, originOk, type AuthOptions } from '../auth/http.js';
import type { ProjectConfig } from '../config.js';
import type { ProjectRegistry } from './registry.js';
import { flowChangedEvent, type ProjectSettings } from './settings.js';
import { codeRepoUsage } from '../storage/code-repo-usage.js';

export interface CodeRepoRouteDeps {
  auth: AuthOptions;
  hostOk: (req: FastifyRequest) => boolean;
  registry: ProjectRegistry;
  settings: (id: string) => ProjectSettings;
  access?: (login: string, p: ProjectConfig) => Promise<'none' | 'read' | 'write'>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export function registerCodeRepoRoutes(app: FastifyInstance, d: CodeRepoRouteDeps): void {
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
  const handle =
    <T>(fn: (req: FastifyRequest, who: { login: string; admin: boolean }) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const who = await gate(req);
        reply.header('Cache-Control', 'no-store');
        return await fn(req, who);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) } });
        if (e instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
        const x = e as { statusCode?: number; code?: string; path?: string; message: string };
        if (x.statusCode === 400) return reply.code(400).send({ error: { code: x.code ?? 'invalid_input', message: x.message, ...(x.path ? { path: x.path } : {}) } });
        throw e;
      }
    };
  /** One project's view. */
  const view = async (p: ProjectConfig) => {
    const s = d.settings(p.id);
    const codeRepos = s.codeRepos?.() ?? [];
    const names = new Set(codeRepos.map((r) => r.name));
    const rt = await d.registry.open(p.id).catch(() => null);
    const usage = rt ? await codeRepoUsage(rt.storage).catch(() => new Map<string, number>()) : new Map<string, number>();
    const unlinked = [...usage].filter(([n]) => !names.has(n)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, uses]) => ({ name, uses }));
    return { id: p.id, name: p.name, specsRepo: s.specsRepo?.() ?? (p.github?.repo ?? null), codeRepos, unlinked };
  };

  app.get(
    '/ui/code-repos',
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
        projects.push(await view(p));
      }
      return { admin: who.admin, projects };
    }),
  );

  app.put(
    '/ui/code-repos/:project',
    handle(async (req, who) => {
      const { project } = req.params as { project: string };
      const p = await visible(who.login, project);
      if (!who.admin) throw new HttpError(403, 'forbidden', 'only Mandate admins can change code repositories');
      const b = z.object({ codeRepos: z.array(codeRepoSchema).max(50) }).strict().parse(req.body);
      const s = d.settings(project);
      if (!s.setCodeRepos) throw new HttpError(501, 'unavailable', 'code repositories cannot be changed on this server');
      const before = (s.codeRepos?.() ?? []).map((r) => `${r.name}=${r.github}`).join(',');
      await s.setCodeRepos(b.codeRepos);
      const after = (s.codeRepos?.() ?? []).map((r) => `${r.name}=${r.github}`).join(',');
      if (before !== after) {
        const rt = await d.registry.open(project).catch(() => null);
        const e = flowChangedEvent(project, ['code repositories'], { agent: 'mandate-ui', user: who.login }, (await rt?.git.head().catch(() => null)) ?? '');
        if (e) rt?.activity.emit(e);
      }
      return view(p);
    }),
  );
}
