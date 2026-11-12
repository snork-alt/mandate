import Fastify, { type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@mandate/shared';

export interface BuildAppOptions {
  /** Liveness payload (the default project's data dir and remote). */
  health: () => Promise<HealthResponse>;
  logger?: boolean;
}

/**
 * The HTTP server: MCP (`/p/<id>/mcp`, `/mcp`, mounted by `registerMcp`) is the only data interface; `/health` is a
 * bare liveness check; `/auth/*` and `/ui/*` serve the web UI's sign-in and project administration.
 */
export function buildApp({ health, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: logger ? loggerOptions() : false });
  app.get('/health', health);
  return app;
}

/** Path of a request URL for logs: no query string, upload tokens redacted. */
export const logUrl = (url: string) => url.split('?')[0]!.replace(/\/uploads\/[^/]+/, '/uploads/***');

/** Request logs never include query strings (the OAuth callback carries `code` / `state`) or headers (keys, cookies). */
export function loggerOptions(stream?: { write(line: string): void }) {
  return {
    level: 'info',
    serializers: { req: (req: { method: string; url: string; hostname?: string }) => ({ method: req.method, url: logUrl(req.url), hostname: req.hostname }) },
    ...(stream ? { stream } : {}),
  };
}
