/**
 * Public installer routes (no sign-in: the scripts hold no secret):
 * - `GET /install.sh`, `GET /p/<project>/install.sh` (+ `.ps1` for Windows PowerShell), `Cache-Control: no-store`;
 * - `GET …/install.sh.sha256` / `…/install.ps1.sha256`: `<hex>  install.sh` for people who verify before running.
 * Host-checked like the other routes. Served over HTTPS only (plain http is refused unless the client is on this
 * machine); a Mandate whose URL is localhost serves them to this machine only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientIsLoopback, requestIsHttps } from '../setup/routes.js';
import { renderInstallPs1, renderInstallSh, sha256Hex, type InstallScriptInput } from './script.js';

export interface InstallRouteDeps {
  /** The URL agents use (server.publicUrl, or http://localhost:<port> on this computer). */
  url: string;
  version: string;
  trustProxy: boolean;
  hostOk: (req: FastifyRequest) => boolean;
  /** Known project ids (unknown → 404). */
  hasProject: (id: string) => boolean;
}

type Kind = 'sh' | 'ps1';

export function registerInstallRoutes(app: FastifyInstance, d: InstallRouteDeps): void {
  const render = (kind: Kind, project: string | null) => {
    const input: InstallScriptInput = { url: d.url, project, version: d.version };
    return kind === 'sh' ? renderInstallSh(input) : renderInstallPs1(input);
  };
  const serve = (kind: Kind, checksum: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (!d.hostOk(req)) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden host' } });
    const local = clientIsLoopback(req, d.trustProxy);
    const loopbackUrl = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(d.url);
    if (loopbackUrl && !local) return reply.code(403).send({ error: { code: 'forbidden', message: 'this Mandate runs on localhost; the installer works only on this machine' } });
    if (!local && !requestIsHttps(req, d.trustProxy)) return reply.code(403).send({ error: { code: 'forbidden', message: `use HTTPS: curl -fsSL ${d.url}${req.url}` } });
    const project = (req.params as { projectId?: string }).projectId ?? null;
    if (project !== null && !d.hasProject(project)) return reply.code(404).send({ error: { code: 'not_found', message: `unknown project '${project}'` } });
    const text = render(kind, project);
    if (checksum) return reply.type('text/plain; charset=utf-8').send(`${sha256Hex(text)}  install.${kind}\n`);
    return reply.type(kind === 'sh' ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8').send(text);
  };
  for (const kind of ['sh', 'ps1'] as const) {
    app.get(`/install.${kind}`, serve(kind, false));
    app.get(`/install.${kind}.sha256`, serve(kind, true));
    app.get(`/p/:projectId/install.${kind}`, serve(kind, false));
    app.get(`/p/:projectId/install.${kind}.sha256`, serve(kind, true));
  }
}
