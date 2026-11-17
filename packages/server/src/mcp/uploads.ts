/**
 * Section uploads: large generated section content (HTML mockups, diagrams, long markdown) goes up with ONE `curl`,
 * so the file never passes through the agent's context or an MCP tool argument.
 *
 * - `PUT /p/<project>/sections/<kind>/<docId>[/<sid>]` (or `?ref=<section ref>`): the primary path, authenticated with
 *   the agent's own bearer credential (`Authorization: Bearer $MANDATE_KEY_<PROJECT>`). An existing section is
 *   replaced; `?create=1&title=…[&after=<sid>]` inserts a new one (Mandate assigns its id). `?cause=<ref>` optional.
 * - `upload_url_create` (MCP) + `PUT /p/<project>/uploads/<token>`: the fallback for agents whose MCP auth is OAuth
 *   only (no token in the shell). The URL embeds a single-use, 10-minute token signed with the server secret and bound
 *   to the principal, project, target, mode and type; it is never a long-lived key.
 *
 * Images (PNG, JPEG, GIF, WebP, SVG) go up the same two ways as an `image` section (`?alt=…[&caption=…]`): checked
 * by content (magic bytes, dimensions, size cap `MANDATE_UPLOAD_IMAGE_MAX_BYTES`, default 10 MB), stored next to the
 * document and served by `GET /p/<project>/images/...` (images.ts).
 *
 * Both write through the SAME path as `<kind>_section_insert` / `_update`: `callTool` (attribution, `Caused-By`,
 * `Agent-Key`, `Mandate-User`, idempotent-safe trailers, integrity delta, warnings) over `DocWriteService` (write lock,
 * validation, commit); activity events and the index follow the commit as for every write. Commits carry
 * `Uploaded-Via: curl` (the history shows "Uploaded via curl by …").
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildRef, parseRef } from '@mandate/shared';
import { parseImageBody, slugSchema } from '@mandate/doc';
import { z } from 'zod';
import { DocWriteService, type DocKind, type ImageUpload } from '../storage/doc-writes.js';
import { checkImage, DEFAULT_IMAGE_MAX_BYTES, IMAGE_MEDIA, ImageError, imageUrl, readSectionImage, sniffRaster } from './images.js';
import type { ServerState } from '../db/state.js';
import { authenticate, type AuthOptions, type Principal } from '../auth/http.js';
import type { RepoPermissions } from '../auth/github-perms.js';
import type { ProjectRegistry } from '../projects/registry.js';
import { callTool, defineTool, type AnyToolDef, type ToolContext } from './define.js';
import { ToolError, type ToolErrorBody } from './errors.js';

/* ---------------------------------------------------------------- types and content */

/** Section types an upload can write (`text` / `json` become a markdown section holding one fenced block). */
export const UPLOAD_TYPES = ['html', 'markdown', 'mermaid', 'text', 'json', 'image'] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];
const DOC_KINDS = ['specs', 'standards', 'components'] as const;

/** Content-Type (media type, lower case, no parameters) → upload type. */
const MEDIA: Record<string, UploadType> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/x-mermaid': 'mermaid',
  'text/vnd.mermaid': 'mermaid',
  'application/vnd.mermaid': 'mermaid',
  'text/plain': 'text',
  'application/json': 'json',
  ...Object.fromEntries([...IMAGE_MEDIA].map((m) => [m, 'image' as const])),
};
/** Media types curl and friends send by default: they do not select a type (the target / token decides). */
const GENERIC_MEDIA = new Set(['', 'application/x-www-form-urlencoded', 'application/octet-stream']);
export const CONTENT_TYPE_OF: Record<UploadType, string> = { html: 'text/html', markdown: 'text/markdown', mermaid: 'text/x-mermaid', text: 'text/plain', json: 'application/json', image: 'image/png' };
/** The stored section type of an upload type. */
const storedType = (t: UploadType) => (t === 'text' || t === 'json' ? 'markdown' : t);

export const DEFAULT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_TTL_MS = 10 * 60_000;

/** An upload failure: an HTTP status and a JSON `{ error: { code, message, hint } }` body. */
export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Media type of a Content-Type header and its charset parameter. */
function parseContentType(header: string | undefined): { media: string; charset?: string } {
  const [media = '', ...params] = (header ?? '').split(';').map((s) => s.trim());
  const cs = params.map((p) => /^charset\s*=\s*"?([^";]+)"?$/i.exec(p)?.[1]).find(Boolean);
  return { media: media.toLowerCase(), ...(cs ? { charset: cs.toLowerCase() } : {}) };
}

/** The upload type a Content-Type names (null = generic: decided by the target). Unknown or non-UTF-8 → 415. */
export function typeOfContentType(header: string | undefined): UploadType | null {
  const { media, charset } = parseContentType(header);
  if (IMAGE_MEDIA.has(media)) return 'image';
  if (charset && charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii') throw new UploadError(415, 'unsupported_charset', `charset ${charset} is not supported; uploads are UTF-8`, 'convert the file to UTF-8 and send charset=utf-8 (or no charset)');
  if (GENERIC_MEDIA.has(media)) return null;
  const t = MEDIA[media];
  if (!t) throw new UploadError(415, 'unsupported_media_type', `Content-Type ${media} is not a section type`, `send one of: ${Object.keys(MEDIA).join(', ')}`);
  return t;
}

/**
 * Decode and check uploaded bytes: UTF-8 only (a BOM is dropped), no binary content (NUL or other C0 control bytes
 * besides tab / newline / carriage return / form feed), non-empty, within the size limit. Nothing else is stripped:
 * html sections render in a sandboxed iframe, which isolates scripts.
 */
export function decodeUpload(buf: Buffer, maxBytes: number): string {
  if (buf.length === 0) throw new UploadError(400, 'empty_body', 'the request body is empty', "send the file as the raw body: --data-binary @file.html");
  if (buf.length > maxBytes) throw new UploadError(413, 'too_large', `the upload is ${buf.length} bytes; the limit is ${maxBytes}`, 'split the content into several sections, or raise MANDATE_UPLOAD_MAX_BYTES on the server');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw new UploadError(415, 'not_utf8', 'the body is not valid UTF-8 (binary files cannot be section content)', 'upload text (HTML, markdown, mermaid) encoded as UTF-8');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) throw new UploadError(415, 'binary_content', 'the body contains binary control characters', 'upload text (HTML, markdown, mermaid); images belong in the HTML as links or data URIs');
  return text;
}

/** The section body stored for an upload (text / json: one fenced block, fence longer than any backtick run inside). */
function bodyOf(type: UploadType, text: string): string {
  if (type !== 'text' && type !== 'json') return text;
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${type === 'json' ? 'json' : 'text'}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/** First file part of a multipart/form-data body (the fallback for `curl -F file=@mockup.html`). */
export function multipartFile(buf: Buffer, header: string): { data: Buffer; contentType?: string } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(header);
  const b = boundary?.[1] ?? boundary?.[2]?.trim();
  if (!b) throw new UploadError(400, 'bad_multipart', 'multipart body without a boundary', "send the raw file instead: --data-binary @file.html -H 'Content-Type: text/html'");
  const delim = Buffer.from(`--${b}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.subarray(start, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    if (/content-disposition:[^\r\n]*\b(filename=|name="?(file|content|body)"?)/i.test(head)) {
      const ct = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
      return { data: buf.subarray(headEnd + 4, end), ...(ct ? { contentType: ct } : {}) };
    }
    pos = next;
  }
  throw new UploadError(400, 'bad_multipart', 'no file part in the multipart body', 'send -F file=@mockup.html, or the raw body with --data-binary');
}

/* ---------------------------------------------------------------- target checks */

type Doc = { id: string; status?: string; sections: { id: string; type?: string; archived?: boolean }[] };

const repoOf = (ctx: ToolContext, kind: DocKind) => (kind === 'specs' ? ctx.storage.specs : kind === 'standards' ? ctx.storage.standards : ctx.storage.components) as unknown as { get(id: string): Promise<Doc> };

/** Lifecycle states whose documents take no new content: archived specs / components, deprecated standards. */
const FROZEN: Record<DocKind, string[]> = { specs: ['archived'], components: ['archived'], standards: ['deprecated'] } as Record<DocKind, string[]>;

/**
 * Up-front checks of an upload target (also re-checked by the write itself): the document exists and is not frozen,
 * the section exists for a replace (not archived, an uploadable type matching the content), `after` exists.
 * Returns the upload type to use (`type` or, when null, the existing section's).
 */
export async function checkTarget(ctx: ToolContext, t: { kind: DocKind; docId: string; mode: 'new_section' | 'replace_section'; section?: string; after?: string; type: UploadType | null }): Promise<UploadType> {
  let doc: Doc;
  try {
    doc = await repoOf(ctx, t.kind).get(t.docId);
  } catch {
    throw new UploadError(404, 'not_found', `${t.kind}/${t.docId} does not exist`, `check the id (list { of: "${t.kind}" })`);
  }
  if (doc.status && FROZEN[t.kind].includes(doc.status)) {
    throw new UploadError(409, 'target_frozen', `${t.kind}/${t.docId} is ${doc.status}; it takes no new content`, t.kind === 'standards' ? 'write to its successor (supersededBy)' : 'restore it first (status active) or write to another document');
  }
  if (t.after && !doc.sections.some((s) => s.id === t.after)) throw new UploadError(404, 'not_found', `section '${t.after}' (after) is not in ${t.kind}/${t.docId}`, 'pass an existing section id, or omit after (appends)');
  if (t.mode === 'new_section') {
    if (!t.type) throw new UploadError(415, 'type_required', 'a new section needs a type', "send -H 'Content-Type: text/html' (or text/markdown, text/x-mermaid, text/plain, application/json, image/png|jpeg|gif|webp|svg+xml)");
    return t.type;
  }
  const s = doc.sections.find((x) => x.id === t.section);
  if (!s) throw new UploadError(404, 'not_found', `section '${t.section}' is not in ${t.kind}/${t.docId}`, 'pass create=1&title=… to insert a new section (Mandate assigns its id)');
  if (s.archived) throw new UploadError(409, 'section_archived', `section '${t.section}' is archived; archived sections are kept as they were`, 'insert a new section instead (create=1&title=…)');
  const current = s.type ?? 'markdown';
  if (!['html', 'markdown', 'mermaid', 'image'].includes(current)) throw new UploadError(415, 'type_mismatch', `section '${t.section}' is a ${current} section; uploads replace html, markdown, mermaid or image sections`, `edit it with ${t.kind === 'specs' ? 'spec' : t.kind === 'standards' ? 'standard' : 'component'}_section_update`);
  // text/plain is what generic tools send for any text: it takes the existing markdown / mermaid section's type.
  const type = !t.type || (t.type === 'text' && current !== 'html' && current !== 'image') ? (current as UploadType) : t.type;
  if (storedType(type) !== current) throw new UploadError(415, 'type_mismatch', `section '${t.section}' is ${current}; the upload is ${type} (${CONTENT_TYPE_OF[type]})`, `send Content-Type ${CONTENT_TYPE_OF[current as UploadType]}, or change the section type first with the section_update tool`);
  return type;
}

/* ---------------------------------------------------------------- the write (same path as the section tools) */

const SINGULAR: Record<DocKind, string> = { specs: 'spec', standards: 'standard', components: 'component' } as Record<DocKind, string>;

/** Write tools used by uploads: the section insert / update service calls under the public tool names, with the upload size limit for `body`. */
function uploadWriteTool(kind: DocKind, mode: 'new_section' | 'replace_section', maxBytes: number, image?: ImageUpload): AnyToolDef {
  const k = SINGULAR[kind];
  return defineTool({
    name: `${k}_section_${mode === 'new_section' ? 'insert' : 'update'}`,
    title: `Upload a ${k} section`,
    kind: 'write',
    description: 'internal: REST section uploads',
    input: z
      .object({
        doc: z.string().min(1),
        section: slugSchema.optional(),
        title: z.string().trim().min(1).max(300).optional(),
        type: z.enum(['html', 'markdown', 'mermaid', 'image']),
        body: z.string().max(maxBytes).optional(),
        alt: z.string().max(2000).optional(),
        caption: z.string().max(2000).optional(),
        after: slugSchema.optional(),
        note: z.string().max(500).optional(),
      })
      .strict(),
    trailers: (a) => ({ 'Uploaded-Via': 'curl', 'Upload-Note': a.note?.replace(/[\r\n]+/g, ' ') }),
    run: async (a, ctx) => {
      const c = ctx.commit!;
      const commits: string[] = [];
      const meta = { agent: c.agent, ...(c.branch ? { branch: c.branch } : {}), trailers: c.trailers, onCommit: (sha: string) => commits.push(sha) };
      const writes = new DocWriteService(ctx.storage, { sectionSoftLimitTokens: 600 });
      let sid: string;
      let warnings: string[];
      // Images: the bytes come from the route (closure), alt / caption from the arguments.
      const opts = a.type === 'image' && image ? { image: { ...image, ...(a.alt !== undefined ? { alt: a.alt } : {}), ...(a.caption !== undefined ? { caption: a.caption } : {}) } } : {};
      if (a.type === 'image' && !image) throw new ToolError('validation', 'image uploads need the image bytes', undefined, 'type');
      if (mode === 'new_section') {
        const out = await writes.sectionInsert(kind, a.doc, { title: a.title!, type: a.type, body: a.body ?? '' }, a.after ? { after: a.after } : { position: 'last' }, meta, opts);
        sid = out.sectionId;
        warnings = out.warnings;
      } else {
        sid = a.section!;
        const out = await writes.sectionUpdate(kind, buildRef({ kind, id: a.doc, sectionId: sid }), { type: a.type, body: a.body ?? '' }, meta, opts);
        warnings = out.warnings;
      }
      // Long mockups exceed the prose soft limit by design: that warning is noise here.
      return { kind, docId: a.doc, section: sid, commit: commits.at(-1) ?? null, commits, warnings: warnings.filter((w) => !/tokens|soft limit|too long/i.test(w)) };
    },
  });
}

export interface UploadWrite {
  kind: DocKind;
  docId: string;
  mode: 'new_section' | 'replace_section';
  section?: string;
  title?: string;
  after?: string;
  type: UploadType;
  /** Text uploads. */
  text: string;
  /** Image uploads: the checked bytes (alt / caption included). */
  image?: ImageUpload;
  agent: string;
  branch?: string;
  cause?: string[];
  note?: string;
}

/** Status of a tool error code on the REST surface. */
function statusOf(code: string): number {
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  if (code === 'unauthorized') return 401;
  if (/^(validation|invalid_input|invalid_cause|agent_required)$/.test(code)) return 400;
  if (code === 'internal' || code === 'internal_error') return 500;
  return 409;
}

/** Run the upload write through `callTool` (same attribution, trailers, causes and integrity as the MCP tools). */
export async function runUploadWrite(ctx: ToolContext, w: UploadWrite, maxBytes: number, baseUrl: string) {
  const def = uploadWriteTool(w.kind, w.mode, Math.max(maxBytes * 2, maxBytes + 1024), w.image);
  const args = {
    doc: w.docId,
    ...(w.section && w.mode === 'replace_section' ? { section: w.section } : {}),
    ...(w.title ? { title: w.title } : {}),
    type: storedType(w.type),
    ...(w.type === 'image' ? { ...(w.image?.alt !== undefined ? { alt: w.image.alt } : {}), ...(w.image?.caption !== undefined ? { caption: w.image.caption } : {}) } : { body: bodyOf(w.type, w.text) }),
    ...(w.after ? { after: w.after } : {}),
    ...(w.note ? { note: w.note } : {}),
    agent: w.agent,
    ...(w.branch ? { branch: w.branch } : {}),
    ...(w.cause?.length ? { cause: w.cause } : {}),
  };
  const r = await callTool(def, args, ctx);
  const body = (r.structuredContent ?? {}) as Record<string, unknown>;
  if (r.isError) {
    const e = body.error as ToolErrorBody;
    throw new UploadError(statusOf(e.code), e.code, e.message, e.hint);
  }
  const sid = body.section as string;
  const project = ctx.project?.id ?? '';
  let image: Record<string, unknown> | undefined;
  if (w.type === 'image') {
    const s = (await repoOf(ctx, w.kind).get(w.docId)).sections.find((x) => x.id === sid) as { body?: string } | undefined;
    const m = s?.body ? parseImageBody(s.body) : null;
    if (m) image = { alt: m.alt, ...(m.caption ? { caption: m.caption } : {}), mime: m.mime, width: m.width, height: m.height, bytes: m.bytes, sha256: m.sha256, url: imageUrl({ ...ctx, baseUrl }, w.kind, w.docId, sid, m) };
  }
  return {
    ref: buildRef({ kind: w.kind, id: w.docId, sectionId: sid }),
    section: sid,
    type: storedType(w.type),
    created: w.mode === 'new_section',
    commit: body.commit ?? null,
    url: `${baseUrl}/p/${encodeURIComponent(project)}/${w.kind}/${encodeURIComponent(w.docId)}#section-${sid}`,
    ...(image ? { image } : {}),
    integrity: body.integrity ?? { introduced: [], resolved: [] },
    warnings: body.warnings ?? [],
  };
}

/* ---------------------------------------------------------------- one-time upload URLs */

/** Who the token acts for (a copy of the principal; never a secret). */
type PrincipalClaim = Exclude<Principal, { kind: 'ui' }>;

export interface UploadClaims {
  v: 1;
  /** Project id. */
  p: string;
  pr?: PrincipalClaim;
  /** Agent identity, branch and resolved causes of the `upload_url_create` call. */
  ag: string;
  br?: string;
  c?: string[];
  m: 'new_section' | 'replace_section';
  k: DocKind;
  d: string;
  s?: string;
  t: UploadType;
  ti?: string;
  af?: string;
  n?: string;
  /** Images: alt text and caption. */
  al?: string;
  ca?: string;
  /** Expiry (epoch ms) and nonce (single use). */
  x: number;
  j: string;
}

export interface UploadServiceOptions {
  /** HMAC key material (server secret); a random per-process key when absent (tests). */
  secret?: Buffer;
  /** Server-state database: used tokens are recorded there (several instances, restarts); else in memory. */
  state?: ServerState;
  maxBytes?: number;
  /** Size cap of image uploads (default `MANDATE_UPLOAD_IMAGE_MAX_BYTES`, else 10 MB). */
  imageMaxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Signs, verifies and consumes one-time upload tokens. */
export class UploadService {
  readonly maxBytes: number;
  readonly imageMaxBytes: number;
  readonly ttlMs: number;
  private readonly key: Buffer;
  private readonly used = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: UploadServiceOptions = {}) {
    this.key = createHmac('sha256', opts.secret ?? randomBytes(32)).update('mandate-upload-url-v1').digest();
    const envMax = Number(process.env.MANDATE_UPLOAD_MAX_BYTES);
    this.maxBytes = opts.maxBytes ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_UPLOAD_MAX_BYTES);
    const envImg = Number(process.env.MANDATE_UPLOAD_IMAGE_MAX_BYTES);
    this.imageMaxBytes = opts.imageMaxBytes ?? (Number.isFinite(envImg) && envImg > 0 ? envImg : DEFAULT_IMAGE_MAX_BYTES);
    this.ttlMs = opts.ttlMs ?? UPLOAD_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  sign(claims: Omit<UploadClaims, 'v' | 'x' | 'j'>): { token: string; expiresAt: number } {
    const full: UploadClaims = { v: 1, ...claims, x: this.now() + this.ttlMs, j: randomBytes(16).toString('base64url') };
    const payload = b64(JSON.stringify(full));
    return { token: `${payload}.${this.mac(payload)}`, expiresAt: full.x };
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  /** Verify signature, shape and expiry (not single use: `consume`). */
  verify(token: string): UploadClaims {
    const bad = () => new UploadError(401, 'invalid_token', 'this upload URL is not valid', 'call upload_url_create again and use the URL exactly as returned');
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined) throw bad();
    const want = Buffer.from(this.mac(payload));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad();
    let c: UploadClaims;
    try {
      c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaims;
    } catch {
      throw bad();
    }
    if (c.v !== 1 || typeof c.x !== 'number' || typeof c.j !== 'string') throw bad();
    if (this.now() > c.x) throw new UploadError(410, 'expired', 'this upload URL has expired (10 minutes)', 'call upload_url_create again');
    return c;
  }

  /** Mark the token used; false when it already was. */
  async consume(c: UploadClaims): Promise<boolean> {
    const h = sha(`upload:${c.j}`);
    const now = this.now();
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
    const st = this.opts.state;
    if (st) {
      const r = await st.db.run(st.db.dialect.insertIgnore('login_tokens', ['hash', 'exp']), [h, c.x]);
      return r.changes === 1;
    }
    if (this.used.has(h)) return false;
    this.used.set(h, c.x);
    return true;
  }

  /** A write that failed (validation, conflict) gives the token back, so the agent can fix the file and retry. */
  async release(c: UploadClaims): Promise<void> {
    const h = sha(`upload:${c.j}`);
    this.used.delete(h);
    const st = this.opts.state;
    if (st) await st.db.run(`DELETE FROM ${st.t('login_tokens')} WHERE hash = ?`, [h]).catch(() => undefined);
  }
}

/** `MANDATE_KEY_<PROJECT>`: the env var `mandate connect` / env.sh export for a project's agent credential. */
export const keyEnvVar = (project: string) => `MANDATE_KEY_${project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Where this client can upload (`project_info.upload`): base URL, env var (null for OAuth-only sessions) and the curl form. */
export function uploadInfo(ctx: ToolContext) {
  const project = ctx.project?.id;
  if (!project || !ctx.baseUrl) return null;
  const base = `${ctx.baseUrl}/p/${encodeURIComponent(project)}/sections`;
  const envVar = ctx.principal?.kind === 'user' && ctx.principal.via === 'oauth' ? null : keyEnvVar(project);
  return {
    sectionsUrl: `${base}/<kind>/<docId>/<sid>`,
    envVar,
    curl: envVar
      ? `curl -sS -X PUT -H "Authorization: Bearer $${envVar}" -H 'Content-Type: text/html' --data-binary @<file> '${base}/specs/<id>/<sid>?cause=<ref>'  (new section: '${base}/specs/<id>?create=1&title=<title>&cause=<ref>')`
      : 'no token in your shell (MCP sign-in): call upload_url_create and run the curl it returns',
    ...(envVar ? { image: `curl -sS -X PUT -H "Authorization: Bearer $${envVar}" -H 'Content-Type: image/png' --data-binary @<file.png> '${base}/specs/<id>?create=1&title=<title>&alt=<what it shows>&cause=<ref>'` } : {}),
  };
}

const docKindOf = (k: string): DocKind | null => {
  const map: Record<string, DocKind> = { specs: 'specs', spec: 'specs', standards: 'standards', standard: 'standards', components: 'components', component: 'components' } as Record<string, DocKind>;
  return map[k] ?? null;
};

/** The MCP tool: validate the target up front and return a one-time PUT URL plus a ready curl command. */
export const uploadUrlTool = defineTool({
  name: 'upload_url_create',
  title: 'Create a section upload URL',
  kind: 'write',
  description: `One-time URL (10 min, single use) to upload a generated file (HTML mockup, mermaid, markdown, text / json example; image: PNG/JPEG/GIF/WebP/SVG screenshot, mockup or diagram with alt) as a section with curl, so its content never passes through a tool call. target: spec / standard / component ref; mode new_section (title, after?) | replace_section (section). Returns url, curl, expiresAt, maxBytes; the PUT returns ref, section, commit, integrity. With the env var named in project_info.upload in your shell, PUT directly (its curl). The URL is the credential: do not store or share it.
Example: {"target":"mandate://specs/checkout","mode":"new_section","sectionType":"html","title":"Checkout mockup"}`,
  input: z
    .object({
      target: z.string().trim().min(1).max(400),
      mode: z.enum(['new_section', 'replace_section']),
      sectionType: z.enum(UPLOAD_TYPES),
      title: z.string().trim().min(1).max(300).regex(/^[^\r\n]*$/, 'single line').optional(),
      section: slugSchema.optional(),
      after: slugSchema.optional(),
      note: z.string().trim().min(1).max(500).regex(/^[^\r\n]*$/, 'single line').optional(),
      alt: z.string().trim().min(1).max(1000).optional(),
      caption: z.string().trim().min(1).max(1000).optional(),
    })
    .strict(),
  run: async (a, ctx) => {
    if (!ctx.uploads || !ctx.project || !ctx.baseUrl) throw new ToolError('unavailable', 'uploads need the per-project HTTP endpoint', 'connect to /p/<project>/mcp');
    const ref = parseRef(a.target);
    const kind = ref ? docKindOf(ref.kind) : 'specs';
    if (!kind) throw new ToolError('validation', `uploads target specs, standards or components, not ${ref!.kind}`, 'pass e.g. mandate://specs/<id>', 'target');
    const docId = ref?.id ?? a.target;
    const section = a.section ?? ref?.sectionId;
    if (a.mode === 'new_section' && !a.title) throw new ToolError('validation', 'a new section needs a title', 'pass title (Mandate assigns the section id from it)', 'title');
    if (a.mode === 'replace_section' && !section) throw new ToolError('validation', 'replace_section needs the section id', 'pass section (or a section ref as target)', 'section');
    if (a.sectionType === 'image' && a.mode === 'new_section' && !a.alt) throw new ToolError('alt_required', 'an image section needs alt text', 'pass alt: what the image shows (agents, search and Ask read it)', 'alt');
    if ((a.alt || a.caption) && a.sectionType !== 'image') throw new ToolError('validation', 'alt / caption are for image uploads', 'drop them, or use sectionType image', 'alt');
    try {
      await checkTarget(ctx, { kind, docId, mode: a.mode, ...(section ? { section } : {}), ...(a.after ? { after: a.after } : {}), type: a.sectionType });
    } catch (e) {
      if (e instanceof UploadError) throw new ToolError(e.code, e.message, e.hint, e.code === 'type_mismatch' ? 'sectionType' : 'target');
      throw e;
    }
    const p = ctx.principal;
    const c = ctx.commit!;
    const { token, expiresAt } = ctx.uploads.sign({
      p: ctx.project.id,
      ...(p && p.kind !== 'ui' ? { pr: p } : {}),
      ag: c.agent,
      ...(c.branch ? { br: c.branch } : {}),
      ...(c.causes?.length ? { c: c.causes } : {}),
      m: a.mode,
      k: kind,
      d: docId,
      ...(a.mode === 'replace_section' ? { s: section } : {}),
      t: a.sectionType,
      ...(a.title ? { ti: a.title } : {}),
      ...(a.after ? { af: a.after } : {}),
      ...(a.note ? { n: a.note } : {}),
      ...(a.alt ? { al: a.alt } : {}),
      ...(a.caption ? { ca: a.caption } : {}),
    });
    const url = `${ctx.baseUrl}/p/${encodeURIComponent(ctx.project.id)}/uploads/${token}`;
    // Images: a generic Content-Type, so the server tells PNG / JPEG / GIF / WebP / SVG from the bytes.
    const contentType = a.sectionType === 'image' ? 'application/octet-stream' : CONTENT_TYPE_OF[a.sectionType];
    const file = a.sectionType === 'image' ? 'image.png' : a.sectionType === 'html' ? 'mockup.html' : a.sectionType === 'mermaid' ? 'diagram.mmd' : a.sectionType === 'json' ? 'example.json' : a.sectionType === 'text' ? 'example.txt' : 'section.md';
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(expiresAt).toISOString(),
      maxBytes: a.sectionType === 'image' ? ctx.uploads.imageMaxBytes : ctx.uploads.maxBytes,
      curl: `curl -sS -X PUT --data-binary @${file} -H 'Content-Type: ${contentType}' '${url}'`,
      warnings: [],
    };
  },
});

/* ---------------------------------------------------------------- REST routes */

export interface UploadRouteDeps {
  projects: ProjectRegistry;
  auth: AuthOptions;
  perms?: RepoPermissions;
  uploads: UploadService;
  hostOk: (req: FastifyRequest) => boolean;
  /** Public base URL (a team: server.publicUrl); else derived from the request. */
  baseUrl?: string;
  samePrincipal: (a: Principal, b: Principal) => boolean;
}

const send = (reply: FastifyReply, e: unknown) => {
  if (e instanceof UploadError || e instanceof ImageError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
  const msg = (e as Error)?.message ?? String(e);
  reply.log?.error?.(`upload: ${msg}`);
  return reply.code(500).send({ error: { code: 'internal', message: 'the upload failed', hint: 'retry; if it keeps failing, check the server log' } });
};

/** Raw (or multipart) body bytes and the effective Content-Type. */
function requestFile(req: FastifyRequest): { data: Buffer; contentType: string | undefined } {
  const raw = req.body;
  const ct = req.headers['content-type'];
  if (!Buffer.isBuffer(raw)) throw new UploadError(400, 'empty_body', 'the request body is empty', "send the file as the raw body: --data-binary @file.html -H 'Content-Type: text/html'");
  if (parseContentType(ct).media === 'multipart/form-data') {
    const f = multipartFile(raw, ct!);
    return { data: f.data, contentType: f.contentType };
  }
  return { data: raw, contentType: ct };
}

const one = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
const many = (v: unknown): string[] => (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? (v as string[]) : []).map((s) => s.trim()).filter(Boolean);

const safeSniff = (b: Buffer) => {
  try {
    return sniffRaster(b) !== null;
  } catch {
    return true; // a truncated image header: the image check reports it
  }
};

/** Checked image bytes (magic bytes, size cap, dimensions; the declared Content-Type must agree) for the write. */
function imageUpload(data: Buffer, maxBytes: number, contentType: string | undefined, alt: string | undefined, caption: string | undefined): ImageUpload {
  const media = parseContentType(contentType).media;
  const img = checkImage(data, maxBytes, IMAGE_MEDIA.has(media) ? media : undefined);
  return { data, mime: img.mime, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}), sha256: img.sha256, ...(alt !== undefined ? { alt } : {}), ...(caption !== undefined ? { caption } : {}) };
}

/** `PUT /p/:projectId/sections/...` and `PUT /p/:projectId/uploads/:token`. */
export function registerUploadRoutes(app: FastifyInstance, d: UploadRouteDeps): void {
  const baseOf = (req: FastifyRequest) => d.baseUrl ?? `${req.protocol}://${req.headers.host}`;
  const ctxFor = async (project: string, principal: Principal | undefined, access: 'read' | 'write', req: FastifyRequest): Promise<ToolContext> => {
    let rt;
    try {
      rt = await d.projects.open(project);
    } catch (e) {
      throw new UploadError(503, 'unavailable', `project '${project}' is unavailable: ${(e as Error).message}`, 'retry later');
    }
    return { ...rt.ctx, ...(principal ? { principal } : {}), access, uploads: d.uploads, baseUrl: baseOf(req) } as ToolContext;
  };
  const accessOf = async (login: string | null, project: string): Promise<'none' | 'read' | 'write'> => {
    if (!login || !d.perms) return 'write';
    return (await d.perms.access(login, d.projects.config(project))) as 'none' | 'read' | 'write';
  };
  const loginOf = (p: Principal) => (p.kind === 'user' ? p.login : p.kind === 'ui' ? p.user.login : null);

  void app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    const bodyLimit = Math.max(d.uploads.maxBytes, d.uploads.imageMaxBytes) + 256 * 1024;
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (_req, body, done) => done(null, body));
    sub.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
      if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return send(reply, new UploadError(413, 'too_large', `the upload exceeds the limit (${d.uploads.maxBytes} bytes for text, ${d.uploads.imageMaxBytes} for images)`, 'split the content into several sections or compress the image, or raise MANDATE_UPLOAD_MAX_BYTES / MANDATE_UPLOAD_IMAGE_MAX_BYTES on the server'));
      if (err.statusCode && err.statusCode < 500) return send(reply, new UploadError(err.statusCode, 'bad_request', err.message, "send the raw file: --data-binary @file -H 'Content-Type: text/html'"));
      return send(reply, err);
    });

    /* ---- primary: the agent's own bearer credential */
    const sectionPut = async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { projectId: string; kind?: string; docId?: string; sid?: string };
      const q = req.query as Record<string, unknown>;
      const project = params.projectId;
      try {
        if (!d.hostOk(req)) throw new UploadError(403, 'forbidden', 'forbidden host', 'call the server by its configured host name');
        if (!d.projects.config(project)) throw new UploadError(404, 'not_found', `unknown project '${project}'`, 'check the project id (project_list)');
        const auth = await authenticate(req, project, d.auth);
        if (!auth.ok) throw new UploadError(auth.status, auth.status === 401 ? 'unauthorized' : 'forbidden', auth.message, `send -H "Authorization: Bearer $${keyEnvVar(project)}" (the variable mandate connect exports); no token in your shell → upload_url_create`);
        const principal = auth.principal;
        if (principal.kind === 'ui') throw new UploadError(403, 'forbidden', 'the web UI session is read-only', 'uploads need an agent credential: Authorization: Bearer <token>');
        const access = await accessOf(loginOf(principal), project);
        if (access === 'none') throw new UploadError(404, 'not_found', `unknown project '${project}'`, 'check the project id (project_list)');
        if (access === 'read') throw new UploadError(403, 'forbidden', 'uploads need GitHub push (write) permission on this project\'s repository', 'ask a repository admin for write access');
        // Target: path segments or ?ref=<section ref>.
        let kind: DocKind | null = params.kind ? docKindOf(params.kind) : null;
        let docId = params.docId;
        let sid = params.sid;
        const refQ = one(q.ref);
        if (refQ) {
          const r = parseRef(refQ);
          if (!r) throw new UploadError(400, 'validation', `ref '${refQ}' is not a mandate:// reference`, 'pass ?ref=mandate://specs/<id>/sections/<sid> (URL-encoded)');
          kind = docKindOf(r.kind);
          docId = r.id;
          sid = r.sectionId;
          if (r.commit) throw new UploadError(400, 'validation', 'drop @sha from the ref: uploads write the current version', 'pass the ref without @sha');
        }
        if (!kind || !docId) throw new UploadError(400, 'validation', 'the target must be a spec, standard or component', 'PUT /p/<project>/sections/specs/<id>/<sid> (or ?ref=…)');
        if (!slugSchema.safeParse(docId).success || (sid !== undefined && !slugSchema.safeParse(sid).success)) throw new UploadError(400, 'validation', 'ids are lowercase slugs', 'copy the ids from a ref');
        const create = /^(1|true|yes)$/i.test(one(q.create) ?? '');
        const title = one(q.title);
        const after = one(q.after);
        if (after && !slugSchema.safeParse(after).success) throw new UploadError(400, 'validation', 'after must be a section id', 'copy it from a ref');
        const ctx = await ctxFor(project, principal, access, req);
        // An existing section is replaced; otherwise create=1&title=… inserts a new one (Mandate assigns the id).
        let mode: 'new_section' | 'replace_section' = 'replace_section';
        if (!sid) mode = 'new_section';
        else {
          const doc = await repoOf(ctx, kind).get(docId).catch(() => null);
          if (doc && !doc.sections.some((s) => s.id === sid) && create) mode = 'new_section';
        }
        if (mode === 'new_section' && !create) throw new UploadError(400, 'validation', 'no section id: pass create=1&title=… to insert a new section', "e.g. '…/sections/specs/<id>?create=1&title=Checkout%20mockup'");
        if (mode === 'new_section' && !title) throw new UploadError(400, 'validation', 'a new section needs a title', 'add &title=… (URL-encoded); Mandate assigns the section id from it');
        const body = requestFile(req);
        const queryType = one(q.type);
        if (queryType && !(UPLOAD_TYPES as readonly string[]).includes(queryType)) throw new UploadError(400, 'validation', `type must be one of ${UPLOAD_TYPES.join(', ')}`, 'or send a matching Content-Type');
        let ctType = typeOfContentType(body.contentType);
        if (queryType && ctType && queryType !== ctType) throw new UploadError(415, 'type_mismatch', `type=${queryType} but Content-Type says ${ctType}`, 'make them agree (or drop type=)');
        // A generic Content-Type (curl's default) with PNG / JPEG / GIF / WebP bytes: an image.
        if (!ctType && !queryType && safeSniff(body.data)) ctType = 'image';
        const type = await checkTarget(ctx, { kind, docId, mode, ...(sid && mode === 'replace_section' ? { section: sid } : {}), ...(after ? { after } : {}), type: (queryType as UploadType | undefined) ?? ctType });
        const alt = one(q.alt);
        const caption = one(q.caption);
        let image: ImageUpload | undefined;
        if (type === 'image') {
          if (mode === 'new_section' && !alt?.trim()) throw new UploadError(400, 'alt_required', 'an image section needs alt text', 'add &alt=<what the image shows> (URL-encoded): agents, search and Ask read it instead of the pixels');
          image = imageUpload(body.data, d.uploads.imageMaxBytes, body.contentType, alt, caption);
        } else if (alt || caption) throw new UploadError(400, 'validation', 'alt / caption are for image uploads', 'drop them, or upload an image');
        const text = image ? '' : decodeUpload(body.data, d.uploads.maxBytes);
        const agent = one(q.agent) ?? one(req.headers['x-mandate-agent']) ?? (principal.kind === 'user' ? principal.tokenName : principal.keyName) ?? 'curl';
        const cause = many(q.cause);
        const out = await runUploadWrite(
          ctx,
          { kind, docId, mode, ...(mode === 'replace_section' ? { section: sid } : {}), ...(title ? { title } : {}), ...(after ? { after } : {}), type, text, ...(image ? { image } : {}), agent: agent.slice(0, 200), ...(one(q.branch) ? { branch: one(q.branch) } : {}), ...(cause.length ? { cause } : {}), ...(one(q.note) ? { note: one(q.note) } : {}) },
          d.uploads.maxBytes,
          baseOf(req),
        );
        return reply.code(out.created ? 201 : 200).send(out);
      } catch (e) {
        return send(reply, e);
      }
    };
    sub.put('/p/:projectId/sections/:kind/:docId/:sid', sectionPut);
    sub.put('/p/:projectId/sections/:kind/:docId', sectionPut);
    sub.put('/p/:projectId/sections', sectionPut);

    /* ---- fallback: the one-time URL from upload_url_create */
    // A wildcard, not a :param: signed tokens are longer than the router's parameter limit (100 chars).
    sub.put('/p/:projectId/uploads/*', async (req, reply) => {
      const { projectId: project, '*': token } = req.params as { projectId: string; '*': string };
      let claims: UploadClaims | null = null;
      let consumed = false;
      try {
        if (!d.hostOk(req)) throw new UploadError(403, 'forbidden', 'forbidden host', 'call the server by its configured host name');
        if (!d.projects.config(project)) throw new UploadError(404, 'not_found', `unknown project '${project}'`, 'use the URL exactly as upload_url_create returned it');
        claims = d.uploads.verify(token);
        if (claims.p !== project) throw new UploadError(403, 'scope_mismatch', 'this upload URL belongs to another project', 'use the URL exactly as returned');
        // The token carries the principal; a credential sent along must be that same principal.
        if (req.headers.authorization) {
          const auth = await authenticate(req, project, d.auth);
          if (!auth.ok || !claims.pr || !d.samePrincipal(claims.pr, auth.principal)) throw new UploadError(403, 'principal_mismatch', 'this upload URL was issued to another credential', 'drop the Authorization header (the URL authorizes the upload) or create your own URL');
        }
        const principal = claims.pr;
        const access = await accessOf(principal ? loginOf(principal) : null, project);
        if (access !== 'write') throw new UploadError(403, 'forbidden', 'the user of this upload URL no longer has write access to the project', 'ask a repository admin for write access');
        const body = requestFile(req);
        const ctType = typeOfContentType(body.contentType);
        if (ctType && ctType !== claims.t && !(ctType === 'text' && (claims.t === 'markdown' || claims.t === 'mermaid'))) throw new UploadError(415, 'type_mismatch', `this URL uploads ${claims.t} (${CONTENT_TYPE_OF[claims.t]}); the request sent ${CONTENT_TYPE_OF[ctType]}`, `send -H 'Content-Type: ${CONTENT_TYPE_OF[claims.t]}', or create a URL with sectionType ${ctType}`);
        const q = req.query as Record<string, unknown>;
        const image = claims.t === 'image' ? imageUpload(body.data, d.uploads.imageMaxBytes, body.contentType, claims.al ?? one(q.alt), claims.ca ?? one(q.caption)) : undefined;
        if (image && claims.m === 'new_section' && !image.alt?.trim()) throw new UploadError(400, 'alt_required', 'an image section needs alt text', 'add &alt=<what the image shows> to the URL, or create the URL with alt');
        const text = image ? '' : decodeUpload(body.data, d.uploads.maxBytes);
        if (!(await d.uploads.consume(claims))) throw new UploadError(410, 'used', 'this upload URL was already used', 'call upload_url_create again (one URL per upload)');
        consumed = true;
        const ctx = await ctxFor(project, principal, access, req);
        await checkTarget(ctx, { kind: claims.k, docId: claims.d, mode: claims.m, ...(claims.s ? { section: claims.s } : {}), ...(claims.af ? { after: claims.af } : {}), type: claims.t });
        const out = await runUploadWrite(
          ctx,
          { kind: claims.k, docId: claims.d, mode: claims.m, ...(claims.s ? { section: claims.s } : {}), ...(claims.ti ? { title: claims.ti } : {}), ...(claims.af ? { after: claims.af } : {}), type: claims.t, text, ...(image ? { image } : {}), agent: claims.ag, ...(claims.br ? { branch: claims.br } : {}), ...(claims.c?.length ? { cause: claims.c } : {}), ...(claims.n ? { note: claims.n } : {}) },
          d.uploads.maxBytes,
          baseOf(req),
        );
        return reply.code(out.created ? 201 : 200).send(out);
      } catch (e) {
        // A failed write gives the URL back (fix the file, retry); a successful one never does.
        if (consumed && claims) await d.uploads.release(claims);
        return send(reply, e);
      }
    });

    /* ---- image sections: the stored bytes (web UI cookie or an agent credential; same project access) */
    sub.get('/p/:projectId/images/:kind/:docId/:sid', async (req, reply) => {
      const { projectId: project, kind: kindParam, docId, sid } = req.params as { projectId: string; kind: string; docId: string; sid: string };
      const q = req.query as Record<string, unknown>;
      // Errors never reveal more than "not found" to a caller without access.
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      try {
        if (!d.hostOk(req)) throw new UploadError(403, 'forbidden', 'forbidden host', 'call the server by its configured host name');
        if (!d.projects.config(project)) throw new UploadError(404, 'not_found', `unknown project '${project}'`, 'check the project id');
        const auth = await authenticate(req, project, d.auth);
        if (!auth.ok) throw new UploadError(auth.status, auth.status === 401 ? 'unauthorized' : 'forbidden', auth.message, 'sign in (web UI) or send Authorization: Bearer <your agent token>');
        const access = await accessOf(loginOf(auth.principal), project);
        if (access === 'none') throw new UploadError(404, 'not_found', `unknown project '${project}'`, 'check the project id');
        const kind = docKindOf(kindParam);
        if (!kind || !slugSchema.safeParse(docId).success || !slugSchema.safeParse(sid).success) throw new UploadError(404, 'not_found', 'no such image', 'GET /p/<project>/images/<specs|standards|components>/<docId>/<sid>');
        const h = one(q.h);
        const version = one(q.version);
        if (h && !/^[0-9a-f]{64}$/.test(h)) throw new UploadError(400, 'validation', 'h must be the image sha256 (64 hex characters)', 'use the url from the section (image.url)');
        if (version && !/^[0-9a-f]{4,64}$/.test(version)) throw new UploadError(400, 'validation', 'version must be a commit sha', 'pass ?version=<sha>');
        const ctx = await ctxFor(project, auth.principal, access === 'write' ? 'write' : 'read', req);
        const img = await readSectionImage(ctx, kind, docId, sid, { ...(h ? { h } : {}), ...(version ? { version } : {}) }).catch((e) => {
          if (e instanceof ImageError || e instanceof UploadError) throw e;
          if (/not exist|not found|unknown/i.test((e as Error)?.message ?? '')) throw new UploadError(404, 'not_found', `no image at ${kind}/${docId}/${sid}`, 'check the reference');
          throw e;
        });
        const etag = `"${img.meta.sha256}"`;
        reply.header('ETag', etag);
        reply.header('Cache-Control', img.pinned ? 'private, max-age=31536000, immutable' : 'private, no-cache');
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        reply.header('Cross-Origin-Resource-Policy', 'same-origin');
        reply.header('Content-Disposition', `inline; filename="${img.meta.file}"`);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        return reply.code(200).type(img.meta.mime).send(img.data);
      } catch (e) {
        return send(reply, e);
      }
    });
  });
}
