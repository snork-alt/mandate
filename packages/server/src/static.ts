/**
 * Production: the server serves the built web UI (Vite `dist`) on its own port, so there is no Vite in production.
 * - Hashed assets (`/assets/*`) are immutable (1 year); `index.html` and other files revalidate (`no-cache`).
 * - SPA fallback: any other GET/HEAD that accepts HTML gets `index.html` (client routes like `/p/<id>/specs/...`).
 * - API paths (`/p/<id>/mcp`, `/mcp`, `/auth`, `/ui`, `/health`) are never shadowed: their routes are registered
 *   first and this is only the not-found handler.
 * Development has no web dir next to the server, so nothing is registered and Vite serves the UI.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** API prefixes that must never fall back to the SPA (a 404 there is a real 404). */
const API = /^\/(?:mcp|auth|ui|health)(?:[/?]|$)|^\/p\/[^/]+\/mcp(?:[/?]|$)/;

/**
 * The built UI directory: `MANDATE_WEB_DIR`, else `web/` next to the bundled server (the published package), else
 * `packages/web/dist` when running the compiled server (`dist/index.js`). Never under `tsx` (dev uses Vite).
 */
export function resolveWebDir(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): string | null {
  if (env.MANDATE_WEB_DIR) return existsSync(path.join(env.MANDATE_WEB_DIR, 'index.html')) ? path.resolve(env.MANDATE_WEB_DIR) : null;
  if (!moduleUrl.startsWith('file:') || moduleUrl.endsWith('.ts')) return null;
  const here = path.dirname(fileURLToPath(moduleUrl));
  for (const dir of [path.join(here, 'web'), path.join(here, '..', '..', 'web', 'dist')]) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export function cacheControl(rel: string): string {
  if (rel === 'index.html' || rel.endsWith('.html')) return 'no-cache';
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/** Register the UI under `root` as the not-found handler (keeps every existing route first). */
export function registerStaticUi(app: FastifyInstance, root: string): void {
  const base = path.resolve(root);
  const send = (req: FastifyRequest, reply: FastifyReply, file: string, rel: string) => {
    const st = statSync(file);
    reply
      .header('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('Cache-Control', cacheControl(rel))
      .header('Content-Length', st.size)
      .header('Last-Modified', st.mtime.toUTCString())
      .header('X-Content-Type-Options', 'nosniff');
    if (rel.endsWith('.html')) reply.header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin');
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(file));
  };

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0]!;
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API.test(url)) {
      return reply.code(404).send({ error: 'not found', path: url });
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url).replace(/^\/+/, '');
    } catch {
      return reply.code(400).send({ error: 'bad path' });
    }
    const file = path.resolve(base, rel);
    if (rel && (file === base || file.startsWith(base + path.sep)) && !rel.split('/').some((s) => s.startsWith('.'))) {
      if (existsSync(file) && statSync(file).isFile()) return send(req, reply, file, rel);
      // A missing hashed asset is a real 404 (never index.html served as JS).
      if (rel.startsWith('assets/') || path.extname(rel)) return reply.code(404).send({ error: 'not found', path: url });
    }
    const accept = String(req.headers.accept ?? '');
    if (accept && !accept.includes('text/html') && !accept.includes('*/*')) return reply.code(404).send({ error: 'not found', path: url });
    return send(req, reply, path.join(base, 'index.html'), 'index.html');
  });
}
