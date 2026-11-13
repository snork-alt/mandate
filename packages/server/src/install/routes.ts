/**
 * Public installer routes (no sign-in: the scripts hold no secret):
 * - `GET /install.sh`, `GET /p/<project>/install.sh` (+ `.ps1` for Windows PowerShell), `Cache-Control: no-store`;
 * - `GET /uninstall.sh` / `/uninstall.ps1`: `getmandate uninstall`, then removes the CLI;
 * - `GET /getmandate.tgz`: this server's own CLI package (its exact version) that the installer `npm install -g`s;
 * - `GET …/<file>.sha256`: `<hex>  <file>` for people (and the installer) who verify before running.
 * Host-checked like the other routes. Served over HTTPS only (plain http is refused unless the client is on this
 * machine); a Mandate whose URL is localhost serves them to this machine only.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientIsLoopback, requestIsHttps } from '../setup/routes.js';
import type { CliTarball } from './cli-package.js';
import { renderInstallPs1, renderInstallSh, renderUninstallPs1, renderUninstallSh, sha256Hex, type InstallScriptInput } from './script.js';

export interface InstallRouteDeps {
  /** The URL agents use (server.publicUrl, or http://localhost:<port> on this computer). */
  url: string;
  /** Version the scripts install (the tarball's version when `cli` is set). */
  version: string;
  trustProxy: boolean;
  hostOk: (req: FastifyRequest) => boolean;
  /** Known project ids (unknown → 404). */
  hasProject: (id: string) => boolean;
  /** This server's CLI package as a tarball; null when not available (running from source without a built CLI). */
  cli?: CliTarball | null;
}

type Kind = 'sh' | 'ps1';

const forbidden = (reply: FastifyReply, message: string) => reply.code(403).send({ error: { code: 'forbidden', message } });

export function registerInstallRoutes(app: FastifyInstance, d: InstallRouteDeps): void {
  const version = d.cli?.version ?? d.version;
  /** The same rules for every file here: allowed host; HTTPS unless on this machine; localhost Mandate → this machine. */
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    reply.header('Cache-Control', 'no-store');
    if (!d.hostOk(req)) { forbidden(reply, 'forbidden host'); return false; }
    const local = clientIsLoopback(req, d.trustProxy);
    const loopbackUrl = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(d.url);
    if (loopbackUrl && !local) { forbidden(reply, 'this Mandate runs on localhost; the installer works only on this machine'); return false; }
    if (!local && !requestIsHttps(req, d.trustProxy)) { forbidden(reply, `use HTTPS: curl -fsSL ${d.url}${req.url}`); return false; }
    return true;
  };
  /** The tarball's checksum, embedded in install scripts (null: not available; the script then asks the route). */
  const cliSha = async (log: FastifyRequest['log']): Promise<string | null> => {
    if (!d.cli) return null;
    try {
      return (await d.cli.get()).sha256;
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'install: CLI tarball unavailable');
      return null;
    }
  };
  const sendScript = (reply: FastifyReply, name: string, text: string, checksum: boolean) =>
    checksum ? reply.type('text/plain; charset=utf-8').send(`${sha256Hex(text)}  ${name}\n`) : reply.type(name.endsWith('.sh') ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8').send(text);

  const install = (kind: Kind, checksum: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guard(req, reply)) return reply;
    const project = (req.params as { projectId?: string }).projectId ?? null;
    if (project !== null && !d.hasProject(project)) return reply.code(404).send({ error: { code: 'not_found', message: `unknown project '${project}'` } });
    const input: InstallScriptInput = { url: d.url, project, version, cliSha256: await cliSha(req.log) };
    return sendScript(reply, `install.${kind}`, kind === 'sh' ? renderInstallSh(input) : renderInstallPs1(input), checksum);
  };
  const uninstall = (kind: Kind, checksum: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guard(req, reply)) return reply;
    return sendScript(reply, `uninstall.${kind}`, kind === 'sh' ? renderUninstallSh({ url: d.url }) : renderUninstallPs1({ url: d.url }), checksum);
  };
  const tarball = (checksum: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guard(req, reply)) return reply;
    if (!d.cli) return reply.code(503).send({ error: { code: 'unavailable', message: 'this Mandate has no built CLI package to serve (running from source: npm run build)' } });
    let t;
    try {
      t = await d.cli.get();
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'install: CLI tarball unavailable');
      return reply.code(503).send({ error: { code: 'unavailable', message: 'could not package the Mandate CLI on this server (see its log)' } });
    }
    if (checksum) return reply.type('text/plain; charset=utf-8').send(`${t.sha256}  getmandate.tgz\n`);
    return reply
      .type('application/gzip')
      .header('Content-Length', String(t.size))
      .header('Content-Disposition', `attachment; filename="getmandate-${t.version}.tgz"`)
      .header('X-Mandate-Version', t.version)
      .send(createReadStream(t.path));
  };

  for (const kind of ['sh', 'ps1'] as const) {
    app.get(`/install.${kind}`, install(kind, false));
    app.get(`/install.${kind}.sha256`, install(kind, true));
    app.get(`/p/:projectId/install.${kind}`, install(kind, false));
    app.get(`/p/:projectId/install.${kind}.sha256`, install(kind, true));
    app.get(`/uninstall.${kind}`, uninstall(kind, false));
    app.get(`/uninstall.${kind}.sha256`, uninstall(kind, true));
  }
  app.get('/getmandate.tgz', tarball(false));
  app.get('/getmandate.tgz.sha256', tarball(true));
}
