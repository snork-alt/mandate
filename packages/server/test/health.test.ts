/** The HTTP surface is MCP plus a bare /health; no REST routes remain. */
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createStorage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  const git = createStorage(await newStore(path.join(await tempDir(), 'repo'))).git;
  app = buildApp({ health: async () => ({ ok: true, version: '0.1.0', dataDir: git.dir, remote: (await git.status()).remote }) });
});
afterAll(async () => {
  await app.close();
  await cleanupTempDirs();
});

it('serves /health', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true, remote: null, version: '0.1.0' });
});

it('has no REST API', async () => {
  for (const [method, url] of [['GET', '/api/health'], ['GET', '/api/specs'], ['POST', '/api/specs'], ['GET', '/api/git/status'], ['POST', '/api/git/pull']] as const) {
    expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
  }
});
