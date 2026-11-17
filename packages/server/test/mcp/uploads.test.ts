/**
 * Section uploads with curl: the bearer PUT (`/p/<p>/sections/...`, primary) and the one-time URL fallback
 * (`upload_url_create` + `PUT /p/<p>/uploads/<token>`): tokens (single use, expiry, scope, principal, tampering),
 * content checks (size, type, UTF-8), the write path (commit, trailers, attribution, integrity, activity), local and
 * server mode, and a real curl run.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { ActivityBus } from '../../src/events/index.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { DocReadService } from '../../src/storage/read.js';
import { DocViewService } from '../../src/storage/views.js';
import { decodeUpload, keyEnvVar, typeOfContentType, UploadError, UploadService, uploadInfo } from '../../src/mcp/uploads.js';
import { logUrl } from '../../src/app.js';
import { KeyStore } from '../../src/auth/keys.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { AgentTokens } from '../../src/auth/agent-tokens.js';
import { registerMcp } from '../../src/mcp/index.js';
import { ProjectRegistry, type ProjectRuntime } from '../../src/projects/registry.js';
import type { ProjectConfig } from '../../src/config.js';
import type { ToolContext } from '../../src/mcp/define.js';
import { connect, serveProjects, type ServedProjects } from './fixture.js';
import { cleanupTempDirs, newStore, tempDir } from '../helpers.js';

/** Async: the server under test runs in this process (a sync child would block it). */
const run = async (file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => (await promisify(execFile)(file, args, { ...opts, timeout: 30_000 })).stdout;
const SOURCE = process.env.MANDATE_FIXTURE_REPO ?? path.resolve(__dirname, '../../../../data/repo');
const MAX = 64 * 1024;
const HTML = '<!doctype html>\n<html><body><h1>Checkout — mockup ✓</h1><script>alert(1)</script></body></html>\n';

/* ---------------------------------------------------------------- units */

describe('upload tokens', () => {
  const claims = { p: 'test', ag: 'agent-x', m: 'new_section' as const, k: 'specs' as const, d: 'spec-a', t: 'html' as const, ti: 'Mockup' };

  it('verifies its own tokens and rejects tampered ones', () => {
    const svc = new UploadService();
    const { token } = svc.sign(claims);
    expect(svc.verify(token)).toMatchObject({ p: 'test', d: 'spec-a', t: 'html' });
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), d: 'other-spec' })).toString('base64url');
    for (const bad of [`${forged}.${mac}`, `${payload}.${mac!.slice(0, -2)}xx`, `${payload}`, `${payload}.${mac}.x`, 'garbage']) {
      expect(() => svc.verify(bad)).toThrowError(expect.objectContaining({ status: 401, code: 'invalid_token' }));
    }
    // Another server secret: invalid.
    expect(() => new UploadService().verify(token)).toThrowError(expect.objectContaining({ code: 'invalid_token' }));
  });

  it('expires after 10 minutes', () => {
    let now = 1_000_000;
    const svc = new UploadService({ now: () => now });
    const { token, expiresAt } = svc.sign(claims);
    expect(expiresAt - now).toBe(10 * 60_000);
    now += 10 * 60_000 + 1;
    expect(() => svc.verify(token)).toThrowError(expect.objectContaining({ status: 410, code: 'expired' }));
  });

  it('is single use (released after a failed write)', async () => {
    const svc = new UploadService();
    const c = svc.verify(svc.sign(claims).token);
    expect(await svc.consume(c)).toBe(true);
    expect(await svc.consume(c)).toBe(false);
    await svc.release(c);
    expect(await svc.consume(c)).toBe(true);
  });

  it('checks content: size, UTF-8, binary; content types', () => {
    expect(decodeUpload(Buffer.from(HTML), MAX)).toBe(HTML);
    expect(decodeUpload(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')]), MAX)).toBe('x');
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as UploadError;
      }
      throw new Error('no error');
    };
    expect(err(() => decodeUpload(Buffer.alloc(MAX + 1, 'a'), MAX))).toMatchObject({ status: 413, code: 'too_large' });
    expect(err(() => decodeUpload(Buffer.from([0x3c, 0x68, 0xff, 0xfe, 0x00]), MAX))).toMatchObject({ status: 415, code: 'not_utf8' });
    expect(err(() => decodeUpload(Buffer.from('ab\u0000cd'), MAX))).toMatchObject({ status: 415, code: 'binary_content' });
    expect(err(() => decodeUpload(Buffer.alloc(0), MAX))).toMatchObject({ status: 400, code: 'empty_body' });
    expect(typeOfContentType('text/html; charset=utf-8')).toBe('html');
    expect(typeOfContentType('text/x-mermaid')).toBe('mermaid');
    expect(typeOfContentType('application/x-www-form-urlencoded')).toBeNull();
    expect(typeOfContentType('image/png')).toBe('image');
    expect(err(() => typeOfContentType('application/pdf'))).toMatchObject({ status: 415, code: 'unsupported_media_type' });
    expect(err(() => typeOfContentType('text/html; charset=latin1'))).toMatchObject({ status: 415, code: 'unsupported_charset' });
  });

  it('never logs upload tokens; env var names', () => {
    expect(logUrl('/p/x/uploads/abc.def?x=1')).toBe('/p/x/uploads/***');
    expect(keyEnvVar('my-proj')).toBe('MANDATE_KEY_MY_PROJ');
    const oauth = uploadInfo({ project: { id: 'p', name: 'p' }, baseUrl: 'https://m.example', principal: { kind: 'user', login: 'u', project: 'p', via: 'oauth', tokenId: 'c', tokenName: 'claude' } } as ToolContext);
    expect(oauth).toMatchObject({ envVar: null });
  });
});

/* ---------------------------------------------------------------- local mode (shared project key) */

describe('uploads end to end (local mode)', () => {
  let served: ServedProjects;
  let storage: Storage;
  let dir: string;
  let client: Client;
  let other: Client;
  let base: string;
  let specId: string;
  let mdSection: string;
  const uploads = new UploadService({ maxBytes: MAX });

  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: (r.structuredContent ?? {}) as Record<string, any> };
  };
  const put = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) => fetch(url, { method: 'PUT', body: body as BodyInit, headers });
  const auth = (project = 'test') => ({ Authorization: `Bearer ${served.key(project)}` });
  const commitMessage = (sha: string) => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B', sha]).toString();
  const sectionOf = async (id: string, sid: string) => (await storage.specs.get(id)).sections.find((s) => s.id === sid) as { type?: string; body?: string; title?: string } | undefined;

  beforeAll(async () => {
    const root = await tempDir();
    dir = path.join(root, 'repo');
    execFileSync('git', ['clone', '-q', SOURCE, dir]);
    const git = new EsGitStore({ dir, author: { name: 'Test', email: 'test@example.com' } });
    await git.open();
    storage = createStorage(git);
    const activity = new ActivityBus(git, { pollMs: 0 });
    await activity.start();
    const ctx: ToolContext = { storage, index: null, activity, reads: new DocReadService(storage), views: new DocViewService(storage) };
    // Two project ids over the same data (scope checks).
    served = await serveProjects({ test: ctx, other: ctx }, { uploads });
    base = served.url('test').origin;
    client = await connect(served.url('test'), 'upload-agent');
    other = await connect(served.url('other'), 'other-agent');
    const created = await call(client, 'spec_create', { title: 'Checkout flow', sections: [{ title: 'Overview', body: 'Checkout in one page.' }] });
    expect(created.isError).toBe(false);
    specId = created.body.document.id;
    mdSection = created.body.document.sections[0].id;
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await other?.close().catch(() => undefined);
    await served?.close();
    await cleanupTempDirs();
  });

  it('project_info tells the base URL and the env var', async () => {
    const r = await call(client, 'project_info', {});
    expect(r.body.upload).toMatchObject({ envVar: 'MANDATE_KEY_TEST', sectionsUrl: `${base}/p/test/sections/<kind>/<docId>/<sid>` });
    expect(r.body.upload.curl).toContain('$MANDATE_KEY_TEST');
    expect(r.body.upload.curl).not.toContain(served.key('test'));
  });

  it('upload_url_create → PUT creates the section (commit, trailers, integrity, activity); the URL is single use', async () => {
    const fb = await call(client, 'request_create', { kind: 'improvement', title: 'Mockup please', body: 'add a checkout mockup', target: `mandate://specs/${specId}` });
    const fbRef = fb.body.ref ?? `mandate://requests/${fb.body.feedback?.id ?? fb.body.id}`;
    const u = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html', title: 'Checkout mockup', after: mdSection, note: 'generated by the agent', ...(fb.isError ? {} : { cause: fbRef }) });
    expect(u.isError).toBe(false);
    expect(u.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'text/html' }, maxBytes: MAX });
    expect(u.body.url).toMatch(new RegExp(`^${base}/p/test/uploads/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    expect(u.body.curl).toBe(`curl -sS -X PUT --data-binary @mockup.html -H 'Content-Type: text/html' '${u.body.url}'`);
    expect(Date.parse(u.body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);

    const r = await put(u.body.url, HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    const out = (await r.json()) as Record<string, any>;
    expect(r.status).toBe(201);
    expect(out).toMatchObject({ ref: `mandate://specs/${specId}/sections/${out.section}`, type: 'html', created: true, url: `${base}/p/test/specs/${specId}#section-${out.section}` });
    expect(out.integrity).toHaveProperty('introduced');
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    const s = await sectionOf(specId, out.section);
    expect(s).toMatchObject({ type: 'html', title: 'Checkout mockup' });
    expect(s!.body!.trim()).toBe(HTML.trim()); // nothing stripped (the viewer sandboxes scripts)
    const ids = (await storage.specs.get(specId)).sections.map((x) => x.id);
    expect(ids.indexOf(out.section)).toBe(ids.indexOf(mdSection) + 1);
    const msg = commitMessage(out.commit);
    expect(msg).toMatch(/^Agent: upload-agent$/m);
    expect(msg).toMatch(/^Agent-Key: /m);
    expect(msg).toMatch(/^Uploaded-Via: curl$/m);
    expect(msg).toMatch(/^Upload-Note: generated by the agent$/m);
    if (!fb.isError) expect(msg).toMatch(/^Caused-By: mandate:\/\/feedback\//m);
    expect(msg).not.toContain(u.body.url.split('/uploads/')[1]);
    // History shows the upload; the activity feed has the section event.
    const h = await call(client, 'history_get', { ref: out.ref, limit: 5 });
    expect(h.body.entries[0].trailers['Uploaded-Via']).toBe('curl');
    const act = await call(client, 'activity_list', { ref: `mandate://specs/${specId}`, limit: 20 });
    expect(act.body.events.some((e: { commit?: string; type: string }) => e.commit === out.commit && /section/.test(e.type))).toBe(true);
    // Used: 410.
    const again = await put(u.body.url, HTML, { 'Content-Type': 'text/html' });
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: { code: 'used' } });
  });

  it('replace mode through a URL; text/plain becomes a fenced markdown block', async () => {
    const u = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}/sections/${mdSection}`, mode: 'replace_section', sectionType: 'markdown' });
    expect(u.isError).toBe(false);
    const r = await put(u.body.url, '# New overview\n\nOne page, three steps.\n'); // no Content-Type: the URL's type
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ section: mdSection, created: false });
    expect((await sectionOf(specId, mdSection))!.body).toContain('three steps');
    const t = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'json', title: 'Example payload' });
    const rt = await put(t.body.url, '{"a":1}', { 'Content-Type': 'application/json' });
    const body = (await rt.json()) as { section: string };
    expect(rt.status).toBe(201);
    expect((await sectionOf(specId, body.section))!.body).toBe('```json\n{"a":1}\n```');
  });

  it('token scope: project, type, principal, tampering; validation up front', async () => {
    const mk = async () => (await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html', title: 'Scoped' })).body.url as string;
    const url = await mk();
    const token = url.split('/uploads/')[1]!;
    // Another project's endpoint.
    expect((await put(`${base}/p/other/uploads/${token}`, HTML, { 'Content-Type': 'text/html' })).status).toBe(403);
    // Another type: 415, and the URL is not burnt.
    const wrong = await put(url, '# md', { 'Content-Type': 'text/markdown' });
    expect(wrong.status).toBe(415);
    expect(await wrong.json()).toMatchObject({ error: { code: 'type_mismatch' } });
    // A credential of another principal: refused.
    const mism = await put(url, HTML, { 'Content-Type': 'text/html', ...auth('other') });
    expect(mism.status).toBe(403);
    expect(await mism.json()).toMatchObject({ error: { code: 'principal_mismatch' } });
    // Tampered.
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), m: 'replace_section', s: mdSection })).toString('base64url');
    expect((await put(`${base}/p/test/uploads/${forged}.${mac}`, HTML, { 'Content-Type': 'text/html' })).status).toBe(401);
    // The same principal's credential is fine; the URL still works after the refusals.
    expect((await put(url, HTML, { 'Content-Type': 'text/html', ...auth('test') })).status).toBe(201);
    // Up-front validation: missing doc / section, wrong section type, missing title.
    expect((await call(client, 'upload_url_create', { target: 'mandate://specs/nope', mode: 'new_section', sectionType: 'html', title: 'x' })).body.error.code).toBe('not_found');
    expect((await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'replace_section', section: 'nope', sectionType: 'html' })).body.error.code).toBe('not_found');
    expect((await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'replace_section', section: mdSection, sectionType: 'html' })).body.error.code).toBe('type_mismatch');
    expect((await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html' })).body.error.code).toBe('validation');
  });

  it('content checks over HTTP: size limit, non-UTF-8', async () => {
    const big = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html', title: 'Big' });
    const r = await put(big.body.url, Buffer.alloc(MAX + 10, 'a'), { 'Content-Type': 'text/html' });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: { code: 'too_large' } });
    const bin = await put(big.body.url, Buffer.from([0x3c, 0x62, 0xff, 0xfe]), { 'Content-Type': 'text/html' });
    expect(bin.status).toBe(415);
    expect(await bin.json()).toMatchObject({ error: { code: 'not_utf8' } });
  });

  it('primary path: PUT /sections with the bearer key (replace, create with a server-assigned id, type mismatch, auth)', async () => {
    const url = `${base}/p/test/sections/specs/${specId}/${mdSection}`;
    const rep = await put(url, '# Overview v3\n', { 'Content-Type': 'text/markdown', ...auth() });
    expect(rep.status).toBe(200);
    const repBody = (await rep.json()) as Record<string, any>;
    expect(repBody).toMatchObject({ section: mdSection, created: false });
    expect(commitMessage(repBody.commit)).toMatch(/^Uploaded-Via: curl$/m);
    // Create: Mandate assigns the id from the title.
    const cr = await put(`${base}/p/test/sections/specs/${specId}?create=1&title=${encodeURIComponent('Payment form mockup')}&after=${mdSection}`, HTML, { 'Content-Type': 'text/html', ...auth() });
    expect(cr.status).toBe(201);
    const crBody = (await cr.json()) as Record<string, any>;
    expect(crBody.section).toMatch(/^payment-form-mockup/);
    expect((await sectionOf(specId, crBody.section))!.type).toBe('html');
    // ?ref= form, replacing the html section.
    const viaRef = await put(`${base}/p/test/sections?ref=${encodeURIComponent(crBody.ref)}`, '<p>v2</p>', { 'Content-Type': 'text/html', ...auth() });
    expect(viaRef.status).toBe(200);
    // Unknown sid without create: 404 with the hint.
    const missing = await put(`${base}/p/test/sections/specs/${specId}/nope`, HTML, { 'Content-Type': 'text/html', ...auth() });
    expect(missing.status).toBe(404);
    // Type mismatch: HTML into a markdown section.
    const mm = await put(url, HTML, { 'Content-Type': 'text/html', ...auth() });
    expect(mm.status).toBe(415);
    expect(await mm.json()).toMatchObject({ error: { code: 'type_mismatch' } });
    // Auth: none, another project's key.
    const none = await put(url, '# x', { 'Content-Type': 'text/markdown' });
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { hint: string } }).error.hint).toContain('$MANDATE_KEY_TEST');
    expect((await put(url, '# x', { 'Content-Type': 'text/markdown', ...auth('other') })).status).toBe(401);
  });

  it('frozen target: refused by upload_url_create and by the PUT', async () => {
    const created = await call(client, 'spec_create', { title: 'Old flow', sections: [{ title: 'Notes', body: 'n' }] });
    const id = created.body.document.id as string;
    const sid = created.body.document.sections[0].id as string;
    expect((await call(client, 'spec_archive', { ref: `mandate://specs/${id}`, reason: 'replaced' })).isError).toBe(false);
    const u = await call(client, 'upload_url_create', { target: `mandate://specs/${id}`, mode: 'new_section', sectionType: 'html', title: 'Mock' });
    expect(u.isError).toBe(true);
    expect(u.body.error.code).toBe('target_frozen');
    const r = await put(`${base}/p/test/sections/specs/${id}/${sid}`, '# x', { 'Content-Type': 'text/markdown', ...auth() });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: 'target_frozen' } });
  });

  it('curl smoke test: both paths with the real curl binary', async () => {
    const work = await tempDir();
    const file = path.join(work, 'mockup.html');
    writeFileSync(file, HTML);
    // Primary: bearer from the env var, never a literal key in the command.
    const env = { ...process.env, [keyEnvVar('test')]: served.key('test') };
    const cmd = `curl -sS -X PUT -H "Authorization: Bearer $${keyEnvVar('test')}" -H 'Content-Type: text/html' --data-binary @mockup.html '${base}/p/test/sections/specs/${specId}?create=1&title=Curl%20mockup'`;
    const out1 = JSON.parse(await run('sh', ['-c', cmd], { cwd: work, env })) as Record<string, any>;
    expect(out1).toMatchObject({ created: true, type: 'html' });
    expect(out1.section).toMatch(/^curl-mockup/);
    // Fallback: the curl string upload_url_create returned, run as is.
    const u = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html', title: 'Curl fallback' });
    const out2 = JSON.parse(await run('sh', ['-c', u.body.curl], { cwd: work })) as Record<string, any>;
    expect(out2).toMatchObject({ created: true, type: 'html', ref: expect.stringContaining(`/sections/${out2.section}`) });
    expect((await sectionOf(specId, out2.section))!.body!.trim()).toBe(HTML.trim());
    // Multipart fallback.
    const u3 = await call(client, 'upload_url_create', { target: `mandate://specs/${specId}`, mode: 'new_section', sectionType: 'html', title: 'Multipart' });
    const out3 = JSON.parse(await run('curl', ['-sS', '-X', 'PUT', '-F', 'file=@mockup.html;type=text/html', u3.body.url], { cwd: work })) as Record<string, any>;
    expect(out3).toMatchObject({ created: true });
    expect((await sectionOf(specId, out3.section))!.body!.trim()).toBe(HTML.trim());
  });
});

/* ---------------------------------------------------------------- server mode (per-user tokens) */

describe('uploads in server mode', () => {
  let app: FastifyInstance;
  let base: string;
  let keys: KeyStore;
  let tokens: AgentTokens;
  let storage: Storage;
  let git: Awaited<ReturnType<typeof newStore>>;

  beforeAll(async () => {
    const home = await tempDir();
    const store = new AuthStore(home, randomBytes(32), 3600_000);
    await store.saveToken('octo', 'gho_octo_token', ['repo']);
    tokens = new AgentTokens(home);
    keys = new KeyStore(path.join(home, 'keys.json'));
    keys.ensureProjectKeys(['specs']);
    const cfg: ProjectConfig = { id: 'specs', name: 'specs', dataDir: path.join(home, 'specs'), branch: 'main', author: { name: 'T', email: 't@x' }, git: { backend: 'embedded', cliPath: 'git', cliEnv: {} }, index: {} as ProjectConfig['index'], idempotencyFile: '', autoPush: { enabled: false, debounceSeconds: 10, intervalSeconds: 300 } };
    git = await newStore(cfg.dataDir);
    storage = createStorage(git);
    const activity = new ActivityBus(git, { pollMs: 0 });
    await activity.start();
    const registry = new ProjectRegistry([cfg], async (p) => ({ config: p, git, storage, index: null, activity, ctx: { project: { id: p.id, name: p.name }, storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), activity }, close: async () => activity.stop() }) as unknown as ProjectRuntime);
    app = Fastify({ logger: false });
    registerMcp(app, { projects: registry, auth: { keys, store, sharedKeys: false, agentTokens: tokens } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await cleanupTempDirs();
  });

  it('a personal token uploads (attributed to the user); shared project keys are refused', async () => {
    const t = (await tokens.create('octo', 'specs', 'laptop')).token;
    const c = new Client({ name: 'claude-code', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/p/specs/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
    const created = (await c.callTool({ name: 'spec_create', arguments: { title: 'Server spec', sections: [{ title: 'Intro', body: 'x' }] } })).structuredContent as Record<string, any>;
    const id = created.document.id as string;
    const info = (await c.callTool({ name: 'project_info', arguments: {} })).structuredContent as Record<string, any>;
    expect(info.upload.envVar).toBe('MANDATE_KEY_SPECS');
    const r = await fetch(`${base}/p/specs/sections/specs/${id}?create=1&title=Mock`, { method: 'PUT', body: HTML, headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${t}` } });
    expect(r.status).toBe(201);
    const out = (await r.json()) as Record<string, any>;
    const msg = await git.commitInfo(out.commit).then((i) => i.message);
    expect(msg).toMatch(/^Mandate-User: octo$/m);
    expect(msg).toMatch(/^Agent-Key: token:laptop$/m);
    // One-time URL: carries the user principal.
    const u = (await c.callTool({ name: 'upload_url_create', arguments: { target: `mandate://specs/${id}`, mode: 'new_section', sectionType: 'mermaid', title: 'Flow' } })).structuredContent as Record<string, any>;
    const r2 = await fetch(u.url, { method: 'PUT', body: 'graph TD; A-->B', headers: { 'Content-Type': 'text/x-mermaid' } });
    expect(r2.status).toBe(201);
    const msg2 = (await git.commitInfo(((await r2.json()) as { commit: string }).commit)).message;
    expect(msg2).toMatch(/^Mandate-User: octo$/m);
    expect(msg2).toMatch(/^Agent: claude-code$/m);
    // A shared project key: refused (per-user attribution).
    const shared = keys.list().find((k) => k.project === 'specs')!.key;
    const r3 = await fetch(`${base}/p/specs/sections/specs/${id}?create=1&title=Mock2`, { method: 'PUT', body: HTML, headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${shared}` } });
    expect(r3.status).toBe(401);
    await c.close();
  });
});
