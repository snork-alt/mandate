/** Production UI serving: cache headers, SPA fallback, API paths never shadowed, no traversal. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { cacheControl, registerStaticUi, resolveWebDir } from '../src/static.js';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'logo.svg'), '<svg/>');
  writeFileSync(path.join(os.tmpdir(), 'mandate-secret.txt'), 'TOPSECRETCONTENT');
  app = Fastify();
  app.get('/health', async () => ({ ok: true }));
  app.post('/mcp', async () => ({ rpc: true }));
  registerStaticUi(app, dir);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(os.tmpdir(), 'mandate-secret.txt'), { force: true });
});

const get = (url: string, accept = 'text/html') => app.inject({ method: 'GET', url, headers: { accept } });

describe('static UI', () => {
  it('serves index.html with no-cache and hashed assets as immutable', async () => {
    const i = await get('/');
    expect(i.statusCode).toBe(200);
    expect(i.headers['content-type']).toContain('text/html');
    expect(i.headers['cache-control']).toBe('no-cache');
    const a = await get('/assets/index-abc123.js', '*/*');
    expect(a.headers['content-type']).toContain('text/javascript');
    expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/logo.svg', 'image/*')).headers['content-type']).toBe('image/svg+xml');
  });

  it('falls back to index.html for client routes', async () => {
    for (const u of ['/p/web/specs/login', '/setup?token=x', '/login']) {
      const r = await get(u);
      expect(r.statusCode, u).toBe(200);
      expect(r.body).toContain('id="root"');
    }
  });

  it('keeps API routes and real 404s', async () => {
    expect((await get('/health', 'application/json')).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: '/mcp' })).json()).toEqual({ rpc: true });
    for (const u of ['/mcp', '/p/web/mcp', '/auth/nope', '/ui/p/x/connect', '/assets/missing.js', '/missing.png']) expect((await get(u)).statusCode, u).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/p/web/specs' })).statusCode).toBe(404);
    expect((await get('/some/route', 'application/json')).statusCode).toBe(404);
  });

  it('never serves files outside the web dir or dotfiles', async () => {
    for (const u of ['/../mandate-secret.txt', '/%2e%2e/mandate-secret.txt', '/assets/..%2f..%2fmandate-secret.txt', '/.env']) {
      const r = await get(u);
      expect(r.body, u).not.toContain('TOPSECRETCONTENT');
    }
  });

  it('resolves the web dir only for built code', () => {
    expect(resolveWebDir({}, 'file:///x/src/static.ts')).toBeNull();
    expect(resolveWebDir({ MANDATE_WEB_DIR: dir })).toBe(dir);
    expect(resolveWebDir({ MANDATE_WEB_DIR: '/nonexistent' })).toBeNull();
    expect(cacheControl('favicon.ico')).toBe('public, max-age=3600');
  });
});
