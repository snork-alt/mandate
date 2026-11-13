/**
 * Image sections: content checks (magic bytes, dimensions, size cap, SVG policy), upload by both curl paths (bearer
 * PUT, one-time URL), storage next to the document in the same commit, the serving route (access, headers, versions),
 * section get metadata / includeImage, and the write guard (file fields change only by upload).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { ActivityBus } from '../../src/events/index.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { UploadService } from '../../src/mcp/uploads.js';
import { checkImage, ImageError, sniffRaster, sniffSvg } from '../../src/mcp/images.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { AgentTokens } from '../../src/auth/agent-tokens.js';
import type { RepoPermissions } from '../../src/auth/github-perms.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, type ProjectRuntime } from '../../src/projects/registry.js';
import type { ProjectConfig } from '../../src/config.js';
import type { ToolContext } from '../../src/mcp/define.js';
import { connect, serveProjects, type ServedProjects } from './fixture.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';

const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../../data/repo');

/* ---------------------------------------------------------------- test images */

/** A real 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** PNG header claiming w×h (sniffing reads the IHDR only). */
const pngOf = (w: number, h: number) => {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
/** JPEG: SOI, an APP0 segment, then SOF0 with height 2 and width 3. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x05, 0x00, 0x07, 0x00]), Buffer.alloc(10)]);
const WEBP = (() => {
  const b = Buffer.alloc(34);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(26, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(640 - 1, 24, 3);
  b.writeUIntLE(480 - 1, 27, 3);
  return b;
})();
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- diagram -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>\n');

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as ImageError;
  }
  throw new Error('no error');
};

describe('image content checks', () => {
  it('detects formats by magic bytes and decodes dimensions', () => {
    expect(sniffRaster(PNG)).toEqual({ mime: 'image/png', width: 1, height: 1 });
    expect(sniffRaster(pngOf(1280, 720))).toEqual({ mime: 'image/png', width: 1280, height: 720 });
    expect(sniffRaster(JPEG)).toEqual({ mime: 'image/jpeg', width: 3, height: 2 });
    expect(sniffRaster(GIF)).toEqual({ mime: 'image/gif', width: 5, height: 7 });
    expect(sniffRaster(WEBP)).toEqual({ mime: 'image/webp', width: 640, height: 480 });
    expect(sniffRaster(SVG)).toBeNull();
    expect(sniffSvg(SVG)).toEqual({ mime: 'image/svg+xml', width: 40, height: 20 });
    expect(sniffSvg(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(checkImage(PNG, 1000).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses non-images, mislabelled bytes, oversize files and unsafe SVG', () => {
    expect(err(() => checkImage(Buffer.from('<p>not an image</p>'), 1000, 'image/png'))).toMatchObject({ status: 415, code: 'not_an_image' });
    expect(err(() => checkImage(JPEG, 1000, 'image/png'))).toMatchObject({ status: 415, code: 'type_mismatch' });
    expect(checkImage(JPEG, 1000, 'image/jpg').mime).toBe('image/jpeg');
    expect(err(() => checkImage(PNG, 10))).toMatchObject({ status: 413, code: 'too_large' });
    expect(err(() => checkImage(Buffer.alloc(0), 10))).toMatchObject({ status: 400, code: 'empty_body' });
    expect(err(() => checkImage(PNG.subarray(0, 12), 1000))).toMatchObject({ code: 'invalid_image' });
    expect(err(() => checkImage(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>'), 1000))).toMatchObject({ code: 'svg_unsafe' });
  });
});

/* ---------------------------------------------------------------- end to end (local mode) */

describe('image sections end to end', () => {
  let served: ServedProjects;
  let storage: Storage;
  let dir: string;
  let client: Client;
  let base: string;
  let specId: string;
  let mdSection: string;
  const uploads = new UploadService({ maxBytes: 64 * 1024, imageMaxBytes: 4096 });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: (r.structuredContent ?? {}) as Record<string, any>, content: r.content as { type: string; data?: string; mimeType?: string }[] };
  };
  const put = (url: string, body: Uint8Array | string, headers: Record<string, string> = {}) => fetch(url, { method: 'PUT', body: body as BodyInit, headers });
  const auth = () => ({ Authorization: `Bearer ${served.key('test')}` });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args]).toString();
  const sectionOf = async (sid: string) => (await storage.specs.get(specId)).sections.find((s) => s.id === sid)!;
  const create = (title: string, body: Uint8Array | string, q = '', headers: Record<string, string> = { 'Content-Type': 'image/png' }) =>
    put(`${base}/p/test/sections/specs/${specId}?create=1&title=${encodeURIComponent(title)}${q}`, body, { ...headers, ...auth() });

  beforeAll(async () => {
    const root = await tempDir();
    dir = path.join(root, 'repo');
    execFileSync('git', ['clone', '-q', SOURCE, dir]);
    const g = new EsGitStore({ dir, author: { name: 'Test', email: 'test@example.com' } });
    await g.open();
    storage = createStorage(g);
    const activity = new ActivityBus(g, { pollMs: 0 });
    await activity.start();
    const ctx: ToolContext = { storage, index: null, activity, reads: new DocReadService(storage), views: new DocViewService(storage) };
    served = await serveProjects({ test: ctx }, { uploads });
    base = served.url('test').origin;
    client = await connect(served.url('test'), 'image-agent');
    const created = await call('spec_create', { title: 'Checkout screens', sections: [{ title: 'Overview', body: 'Checkout in one page.' }] });
    specId = created.body.document.id;
    mdSection = created.body.document.sections[0].id;
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await served?.close();
    await cleanupTempDirs();
  });

  it('uploads a PNG as a new image section: metadata body, binary next to the document, one commit', async () => {
    const r = await create('Checkout screenshot', PNG, `&alt=${encodeURIComponent('Checkout page, pay button bottom right')}&caption=v1`);
    expect(r.status).toBe(201);
    const out = (await r.json()) as Record<string, any>;
    expect(out).toMatchObject({ type: 'image', created: true, image: { alt: 'Checkout page, pay button bottom right', caption: 'v1', mime: 'image/png', width: 1, height: 1, bytes: PNG.length } });
    expect(out.image.url).toBe(`${base}/p/test/images/specs/${specId}/${out.section}?h=${out.image.sha256}`);
    const s = await sectionOf(out.section);
    expect(s.type).toBe('image');
    expect(JSON.parse(s.body)).toMatchObject({ file: `${out.section}.png`, alt: 'Checkout page, pay button bottom right', sha256: out.image.sha256 });
    // Same commit: the document and the binary.
    const files = git('show', '--name-only', '--format=', out.commit).trim().split('\n').sort();
    expect(files).toEqual([`specs/${specId}.assets/${out.section}.png`, `specs/${specId}.md`]);
    expect(git('log', '-1', '--format=%B', out.commit)).toMatch(/^Uploaded-Via: curl$/m);
    // The document listing ignores the assets directory.
    expect((await storage.specs.list()).some((x) => x.id.includes('assets'))).toBe(false);
  });

  it('validation: alt required, magic bytes, size cap, image into a text section', async () => {
    const noAlt = await create('No alt', PNG);
    expect(noAlt.status).toBe(400);
    expect(await noAlt.json()).toMatchObject({ error: { code: 'alt_required' } });
    const fake = await create('Fake', Buffer.from('hello'), '&alt=x');
    expect(fake.status).toBe(415);
    expect(await fake.json()).toMatchObject({ error: { code: 'not_an_image' } });
    const mislabelled = await create('Mislabelled', JPEG, '&alt=x');
    expect(((await mislabelled.json()) as any).error.code).toBe('type_mismatch');
    const big = await create('Big', Buffer.concat([PNG, Buffer.alloc(5000)]), '&alt=x');
    expect(big.status).toBe(413);
    const intoMd = await put(`${base}/p/test/sections/specs/${specId}/${mdSection}`, PNG, { 'Content-Type': 'image/png', ...auth() });
    expect(intoMd.status).toBe(415);
    expect(await intoMd.json()).toMatchObject({ error: { code: 'type_mismatch' } });
  });

  it('curl without a Content-Type: detected from the bytes; replace keeps alt, swaps the file; old versions stay servable', async () => {
    const r = await create('Detected', PNG, '&alt=Detected%20image', {});
    expect(r.status).toBe(201);
    const first = (await r.json()) as Record<string, any>;
    // Replace with a JPEG (no alt: kept); the .png is removed in the same commit.
    const rep = await put(`${base}/p/test/sections/specs/${specId}/${first.section}`, JPEG, { 'Content-Type': 'image/jpeg', ...auth() });
    expect(rep.status).toBe(200);
    const second = (await rep.json()) as Record<string, any>;
    expect(second.image).toMatchObject({ alt: 'Detected image', mime: 'image/jpeg', width: 3, height: 2 });
    expect(git('show', '--name-status', '--format=', second.commit)).toMatch(new RegExp(`D\\s+specs/${specId}.assets/${first.section}.png`));
    expect(existsSync(path.join(dir, `specs/${specId}.assets/${first.section}.jpg`))).toBe(true);

    // Serving: current, by content hash (an older version from history), by version.
    const get = (q: string, headers: Record<string, string> = auth()) => fetch(`${base}/p/test/images/specs/${specId}/${first.section}${q}`, { headers });
    const cur = await get('');
    expect(cur.status).toBe(200);
    expect(cur.headers.get('content-type')).toBe('image/jpeg');
    expect(cur.headers.get('x-content-type-options')).toBe('nosniff');
    expect(cur.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(cur.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(cur.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await cur.arrayBuffer()).equals(JPEG)).toBe(true);
    const etag = cur.headers.get('etag')!;
    expect((await get('', { ...auth(), 'If-None-Match': etag })).status).toBe(304);
    const old = await get(`?h=${first.image.sha256}`);
    expect(old.status).toBe(200);
    expect(old.headers.get('content-type')).toBe('image/png');
    expect(old.headers.get('cache-control')).toMatch(/immutable/);
    expect(Buffer.from(await old.arrayBuffer()).equals(PNG)).toBe(true);
    const atVersion = await get(`?version=${first.commit}`);
    expect(atVersion.headers.get('content-type')).toBe('image/png');
    expect((await get(`?h=${'0'.repeat(64)}`)).status).toBe(404);
    expect((await get('', {})).status).toBe(401);
    expect((await fetch(`${base}/p/test/images/specs/${specId}/${mdSection}`, { headers: auth() })).status).toBe(404);
  });

  it('section get: metadata + url; includeImage returns an MCP image block; spec_get carries image too', async () => {
    const r = (await (await create('For agents', PNG, '&alt=Login%20form')).json()) as Record<string, any>;
    const ref = `mandate://specs/${specId}/sections/${r.section}`;
    const g = await call('spec_section_get', { ref });
    expect(g.body.section.image).toMatchObject({ alt: 'Login form', mime: 'image/png', url: r.image.url });
    expect(g.content.filter((c) => c.type === 'image')).toHaveLength(0);
    const withImg = await call('spec_section_get', { ref, includeImage: true });
    const block = withImg.content.find((c) => c.type === 'image')!;
    expect(block).toMatchObject({ mimeType: 'image/png', data: PNG.toString('base64') });
    // Versioned ref: the image at that commit.
    const v = await call('spec_section_get', { ref: `mandate://specs/${specId}@${r.commit}/sections/${r.section}`, includeImage: true });
    expect(v.content.some((c) => c.type === 'image')).toBe(true);
    const doc = await call('spec_get', { ref: specId, sections: [r.section] });
    expect(doc.body.sections[0].image).toMatchObject({ alt: 'Login form' });
    const md = await call('spec_section_get', { ref: `mandate://specs/${specId}/sections/${mdSection}`, includeImage: true });
    expect(md.body.imageOmitted).toBe('not an image section');
  });

  it('write guard: alt / caption editable in the body, file fields only by upload; leaving the type removes the file', async () => {
    const r = (await (await create('Guarded', GIF, '&alt=Spinner', { 'Content-Type': 'image/gif' })).json()) as Record<string, any>;
    const ref = `mandate://specs/${specId}/sections/${r.section}`;
    const meta = JSON.parse((await sectionOf(r.section)).body);
    const edited = await call('spec_section_update', { ref, body: JSON.stringify({ ...meta, alt: 'Loading spinner', caption: 'shown while paying' }) });
    expect(edited.isError).toBe(false);
    expect(JSON.parse((await sectionOf(r.section)).body)).toMatchObject({ alt: 'Loading spinner', caption: 'shown while paying', sha256: meta.sha256 });
    const forged = await call('spec_section_update', { ref, body: JSON.stringify({ ...meta, sha256: 'b'.repeat(64) }) });
    expect(forged.body.error.code).toBe('image_upload_required');
    const inline = await call('spec_section_insert', { doc: specId, section: { title: 'Inline image', type: 'image', body: JSON.stringify(meta) } });
    expect(inline.body.error.code).toBe('image_upload_required');
    const asMd = await call('spec_section_update', { ref, type: 'markdown', body: 'No image any more.' });
    expect(asMd.isError).toBe(false);
    expect(existsSync(path.join(dir, `specs/${specId}.assets/${r.section}.gif`))).toBe(false);
  });

  it('one-time URL: alt required up front, generic Content-Type, SVG served sandboxed', async () => {
    const noAlt = await call('upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'image', title: 'Diagram' });
    expect(noAlt.body.error.code).toBe('alt_required');
    const u = await call('upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'image', title: 'Diagram', alt: 'Payment state machine' });
    expect(u.isError).toBe(false);
    expect(u.body).toMatchObject({ headers: { 'Content-Type': 'application/octet-stream' }, maxBytes: 4096 });
    expect(u.body.curl).toContain('--data-binary @image.png');
    const r = await put(u.body.url, SVG, { 'Content-Type': 'application/octet-stream' });
    expect(r.status).toBe(201);
    const out = (await r.json()) as Record<string, any>;
    expect(out.image).toMatchObject({ mime: 'image/svg+xml', width: 40, height: 20, alt: 'Payment state machine' });
    const svg = await fetch(out.image.url, { headers: auth() });
    expect(svg.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(svg.headers.get('content-security-policy')).toMatch(/sandbox/);
    const inline = await call('spec_section_get', { ref: out.ref, includeImage: true });
    expect(inline.body.imageOmitted).toMatch(/SVG/);
    // WebP through the bearer path.
    expect((await create('WebP', WEBP, '&alt=w', { 'Content-Type': 'image/webp' })).status).toBe(201);
  });
});

/* ---------------------------------------------------------------- serving: per-user project access */

describe('image serving access (server mode)', () => {
  let app: FastifyInstance;
  let base: string;
  let store: AuthStore;
  let tokens: AgentTokens;

  beforeAll(async () => {
    const home = await tempDir();
    store = new AuthStore(home, randomBytes(32), 3600_000);
    await store.saveToken('octo', 'gho_octo_token', ['repo']);
    tokens = new AgentTokens(home);
    const keys = new KeyStore(path.join(home, 'keys.json'));
    keys.ensureProjectKeys(['specs']);
    const cfg: ProjectConfig = { id: 'specs', name: 'specs', dataDir: path.join(home, 'specs'), branch: 'main', author: { name: 'T', email: 't@x' }, git: { backend: 'embedded', cliPath: 'git', cliEnv: {} }, index: {} as ProjectConfig['index'], idempotencyFile: '', autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 } };
    const git = await newStore(cfg.dataDir);
    const storage = createStorage(git);
    const activity = new ActivityBus(git, { pollMs: 0 });
    await activity.start();
    const registry = new ProjectRegistry([cfg], async (p) => ({ config: p, git, storage, index: null, activity, ctx: { project: { id: p.id, name: p.name }, storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), activity }, close: async () => activity.stop() }) as unknown as ProjectRuntime);
    const perms = { access: async (login: string) => (login === 'octo' ? 'write' : 'none') } as unknown as RepoPermissions;
    app = Fastify({ logger: false });
    registerMcp(app, { projects: registry, auth: { keys, store, sharedKeys: false, agentTokens: tokens }, perms });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await cleanupTempDirs();
  });

  it('the web UI cookie of a user with access gets the image; without access: 404', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const t = (await tokens.create('octo', 'specs', 'laptop')).token;
    const c = new Client({ name: 'claude-code', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/p/specs/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
    const created = (await c.callTool({ name: 'spec_create', arguments: { title: 'Server spec', sections: [{ title: 'Intro', body: 'x' }] } })).structuredContent as Record<string, any>;
    const id = created.document.id as string;
    await c.close();
    const r = await fetch(`${base}/p/specs/sections/specs/${id}?create=1&title=Shot&alt=Screenshot`, { method: 'PUT', body: PNG, headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${t}` } });
    expect(r.status).toBe(201);
    const out = (await r.json()) as Record<string, any>;
    const path_ = `/p/specs/images/specs/${id}/${out.section}?h=${out.image.sha256}`;
    const octo = await store.createSession({ login: 'octo', avatarUrl: '' });
    const stranger = await store.createSession({ login: 'stranger', avatarUrl: '' });
    const asOcto = await fetch(`${base}${path_}`, { headers: { Cookie: `mandate_session=${octo}` } });
    expect(asOcto.status).toBe(200);
    expect(asOcto.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const asStranger = await fetch(`${base}${path_}`, { headers: { Cookie: `mandate_session=${stranger}` } });
    expect(asStranger.status).toBe(404);
    expect((await fetch(`${base}${path_}`)).status).toBe(401);
  });
});
