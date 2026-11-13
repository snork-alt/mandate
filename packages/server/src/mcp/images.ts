/**
 * Image sections: content sniffing of uploads (magic bytes, dimensions, SVG policy), reading the stored bytes (current
 * or at a version / content hash) and the metadata + URL that read tools return.
 *
 * Storage: `<kind>/<docId>.assets/<sid>.<ext>` next to the document, written in the same commit as the section body
 * (`DocWriteService`); the body is JSON metadata (alt, caption, mime, width, height, bytes, sha256).
 * Serving: `GET /p/<project>/images/<kind>/<docId>/<sid>[?h=<sha256>|&version=<commit>]` (registered with the upload
 * routes): same per-user project access as the rest (no access → 404), nosniff, `CSP: sandbox`, immutable caching
 * when the URL pins the content (h / version).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseImageBody, type ImageMeta, type ImageMime } from '@mandate/doc';
import { assetDirOf, type DocKind } from '../storage/doc-writes.js';
import { parseRef } from '@mandate/shared';
import { EXTRA_CONTENT, type ToolContext } from './define.js';

export const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Largest image returned inline as an MCP image block (`includeImage`). */
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Image media types an upload may declare (`image/jpg` is a common misspelling of image/jpeg). */
export const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

export class ImageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface SniffedImage {
  mime: ImageMime;
  width?: number;
  height?: number;
}

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

/** Format and dimensions of a raster image from its magic bytes and header (null: not PNG / JPEG / GIF / WebP). */
export function sniffRaster(b: Buffer): SniffedImage | null {
  // PNG: signature + IHDR (width, height: big-endian u32 at 16 / 20).
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') throw new ImageError(415, 'invalid_image', 'the PNG header is truncated or invalid');
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF: GIF87a / GIF89a, logical screen width / height (little-endian u16 at 6 / 8).
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk.
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { mime: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    throw new ImageError(415, 'invalid_image', 'the WebP header is truncated or invalid');
  }
  // JPEG: SOI, then segments up to a start-of-frame marker (height / width big-endian u16 at +5 / +7).
  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      if (m === 0xd9 || m === 0xda) break;
      i += 2 + len;
    }
    throw new ImageError(415, 'invalid_image', 'the JPEG has no frame header (truncated or invalid)');
  }
  return null;
}

/** A CSS length in px (`120`, `120px`, `120.5`) as a positive integer; other units: undefined. */
const px = (v: string | undefined) => {
  const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(v) : null;
  const n = m ? Math.round(Number(m[1])) : NaN;
  return n > 0 ? n : undefined;
};

/**
 * SVG: UTF-8 text whose root element is <svg>. Served only as image/svg+xml with `CSP: sandbox` and shown through
 * <img> (no script runs), so the markup itself is not rewritten; DTDs / entities are refused (entity expansion).
 */
export function sniffSvg(b: Buffer): SniffedImage | null {
  const head = b.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  if (/<svg[\s>/]/i.test(head) && /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(head)) throw new ImageError(415, 'svg_unsafe', 'SVG with a DTD / entity declarations is not accepted', 'export the SVG without a DOCTYPE, or convert it to PNG');
  // Prolog: XML declaration, comments, processing instructions, whitespace; then the root element.
  const rest = head.replace(/^(\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*>)*/i, '');
  if (!/^<svg[\s>/]/i.test(rest)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new ImageError(415, 'invalid_image', 'the SVG is not valid UTF-8');
  }
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) throw new ImageError(415, 'svg_unsafe', 'SVG with a DTD / entity declarations is not accepted', 'export the SVG without a DOCTYPE, or convert it to PNG');
  const tag = /^<svg\b[^>]*>/i.exec(rest)?.[0] ?? '';
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  let width = px(attr('width'));
  let height = px(attr('height'));
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if ((!width || !height) && vb?.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) {
    width ??= Math.round(vb[2]!);
    height ??= Math.round(vb[3]!);
  }
  return { mime: 'image/svg+xml', ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

const LABEL: Record<ImageMime, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' };

/**
 * Check uploaded image bytes: non-empty, within the size cap, a PNG / JPEG / GIF / WebP / SVG by its CONTENT (magic
 * bytes; the Content-Type must agree when it names an image type), dimensions decoded.
 */
export function checkImage(buf: Buffer, maxBytes: number, declared?: string): SniffedImage & { sha256: string } {
  if (buf.length === 0) throw new ImageError(400, 'empty_body', 'the request body is empty', "send the file as the raw body: --data-binary @screenshot.png -H 'Content-Type: image/png'");
  if (buf.length > maxBytes) throw new ImageError(413, 'too_large', `the image is ${buf.length} bytes; the limit is ${maxBytes}`, 'resize or compress it (e.g. a smaller PNG or a JPEG / WebP), or raise MANDATE_UPLOAD_IMAGE_MAX_BYTES on the server');
  const s = sniffRaster(buf) ?? sniffSvg(buf);
  if (!s) throw new ImageError(415, 'not_an_image', `the body is not a PNG, JPEG, GIF, WebP or SVG image${declared ? ` (Content-Type said ${declared})` : ''}`, 'upload the image file itself (--data-binary @file.png), not a link or a base64 text');
  const want = declared === 'image/jpg' || declared === 'image/pjpeg' ? 'image/jpeg' : declared;
  if (want && IMAGE_MEDIA.has(want) && want !== s.mime) throw new ImageError(415, 'type_mismatch', `the body is a ${LABEL[s.mime]} image but Content-Type says ${declared}`, `send -H 'Content-Type: ${s.mime}'`);
  if ((s.width ?? 1) > 50_000 || (s.height ?? 1) > 50_000) throw new ImageError(415, 'invalid_image', `implausible image dimensions ${s.width}×${s.height}`, 'upload a normal image file');
  return { ...s, sha256: createHash('sha256').update(buf).digest('hex') };
}

/* ---------------------------------------------------------------- reading stored images */

const repoOf = (ctx: ToolContext, kind: DocKind) => (kind === 'specs' ? ctx.storage.specs : kind === 'standards' ? ctx.storage.standards : ctx.storage.components);

/** Content-hash lookups in history (immutable: cached forever per document / section / hash). */
const historyHits = new Map<string, { commit: string; meta: ImageMeta }>();

export interface StoredImage {
  meta: ImageMeta;
  data: Buffer;
  /** True when the request pinned the content (h or version): cacheable forever. */
  pinned: boolean;
}

/**
 * The image of section `sid` of `<kind>/<docId>`: at HEAD (working tree), at `version` (a commit), or the version whose
 * content hash is `h` (the current one, else the latest commit of the document whose section held it).
 */
export async function readSectionImage(ctx: ToolContext, kind: DocKind, docId: string, sid: string, opts: { version?: string; h?: string } = {}): Promise<StoredImage> {
  const repo = repoOf(ctx, kind);
  const docPath = repo.pathOf(docId);
  const dir = assetDirOf(docPath);
  const metaAt = async (commit: string | null) => {
    const { doc } = await ctx.reads.readDoc(kind, docId, commit);
    const s = doc.sections.find((x) => x.id === sid);
    if (!s) throw new ImageError(404, 'not_found', `no section '${sid}' in ${kind}/${docId}${commit ? ` at ${commit.slice(0, 7)}` : ''}`);
    if (s.type !== 'image') throw new ImageError(404, 'not_found', `section '${sid}' is a ${s.type} section, not an image`);
    const m = parseImageBody(s.body);
    if (!m) throw new ImageError(404, 'not_found', `section '${sid}' has no valid image metadata`);
    return m;
  };
  const blobAt = async (commit: string, m: ImageMeta) => {
    const data = await ctx.storage.git.readBlobAt(commit, `${dir}/${m.file}`);
    if (!data) throw new ImageError(404, 'not_found', `the image file of '${sid}' is missing at ${commit.slice(0, 7)}`);
    return data;
  };
  if (opts.version) {
    const commit = await ctx.storage.git.resolveCommit(opts.version).catch(() => null);
    if (!commit) throw new ImageError(404, 'not_found', `unknown version '${opts.version}'`);
    const meta = await metaAt(commit);
    if (opts.h && opts.h !== meta.sha256) throw new ImageError(404, 'not_found', 'the image at this version has another content hash');
    return { meta, data: await blobAt(commit, meta), pinned: true };
  }
  let current: ImageMeta | null = null;
  try {
    current = await metaAt(null);
  } catch (e) {
    if (!opts.h) throw e;
  }
  if (current && (!opts.h || opts.h === current.sha256)) {
    let data: Buffer;
    try {
      data = await readFile(path.join(ctx.storage.git.dir, dir, current.file));
    } catch {
      throw new ImageError(404, 'not_found', `the image file of '${sid}' is missing`);
    }
    return { meta: current, data, pinned: !!opts.h };
  }
  // An older version (diff / history views): the newest commit of the document whose section held this hash.
  const h = opts.h!;
  const key = `${ctx.storage.git.dir}|${docPath}|${sid}|${h}`;
  let hit = historyHits.get(key);
  if (!hit) {
    for (const c of await ctx.storage.history.fileCommits(docPath)) {
      const raw = await ctx.storage.git.readFileAt(c.id, docPath).catch(() => null);
      if (!raw?.includes(h)) continue;
      const meta = await metaAt(c.id).catch(() => null);
      if (meta?.sha256 === h) {
        hit = { commit: c.id, meta };
        if (historyHits.size > 5000) historyHits.clear();
        historyHits.set(key, hit);
        break;
      }
    }
  }
  if (!hit) throw new ImageError(404, 'not_found', `no version of '${sid}' holds image ${h.slice(0, 12)}`);
  return { meta: hit.meta, data: await blobAt(hit.commit, hit.meta), pinned: true };
}

/** URL of a section's image (content-pinned with h). */
export function imageUrl(ctx: Pick<ToolContext, 'baseUrl' | 'project'>, kind: string, docId: string, sid: string, meta: ImageMeta): string | null {
  if (!ctx.project) return null;
  return `${ctx.baseUrl ?? ''}/p/${encodeURIComponent(ctx.project.id)}/images/${kind}/${encodeURIComponent(docId)}/${encodeURIComponent(sid)}?h=${meta.sha256}`;
}

type SectionLike = { id: string; type: string; body?: string; image?: unknown };

/** Add `image` ({ alt, caption, mime, width, height, bytes, sha256, url }) to the image sections of a read result. */
export function withImageMeta<T>(result: T, ctx: ToolContext, kind: string, docId: string): T {
  const r = result as { section?: SectionLike; sections?: SectionLike[] };
  const add = (s: SectionLike | undefined) => {
    if (!s || s.type !== 'image' || typeof s.body !== 'string') return s;
    const m = parseImageBody(s.body);
    if (!m) return s;
    const { file: _file, ...rest } = m;
    const url = imageUrl(ctx, kind, docId, s.id, m);
    return { ...s, image: { ...rest, ...(url ? { url } : {}) } };
  };
  if (!r || typeof r !== 'object') return result;
  return { ...r, ...(r.section ? { section: add(r.section) } : {}), ...(Array.isArray(r.sections) ? { sections: r.sections.map(add) } : {}) } as T;
}

/**
 * A section_get result with image metadata + URL; `includeImage`: also the image as an MCP image block (raster up to
 * INLINE_IMAGE_MAX_BYTES; SVG and larger files: `imageOmitted` with the reason, fetch `image.url`).
 */
export async function sectionGetWithImage<T>(result: T, ctx: ToolContext, includeImage: boolean | undefined): Promise<T> {
  const r = result as { section?: SectionLike & { uri?: string } };
  const ref = r?.section?.uri ? parseRef(r.section.uri) : null;
  if (!ref || r.section?.type !== 'image') return includeImage && r?.section ? ({ ...r, imageOmitted: 'not an image section' } as T) : result;
  const out = withImageMeta(result, ctx, ref.kind, ref.id) as T & { section: { image?: { mime: string; bytes: number; sha256: string } } };
  const img = out.section.image;
  if (!includeImage || !img) return out;
  if (img.mime === 'image/svg+xml') return { ...out, imageOmitted: 'SVG is not returned inline; read alt / caption or fetch image.url' };
  if (img.bytes > INLINE_IMAGE_MAX_BYTES) return { ...out, imageOmitted: `the image is ${img.bytes} bytes (inline limit ${INLINE_IMAGE_MAX_BYTES}); read alt / caption or fetch image.url` };
  try {
    const stored = await readSectionImage(ctx, ref.kind as DocKind, ref.id, ref.sectionId!, { h: img.sha256, ...(ref.commit ? { version: ref.commit } : {}) });
    return Object.assign({ ...out }, { [EXTRA_CONTENT]: [{ type: 'image', data: stored.data.toString('base64'), mimeType: stored.meta.mime }] });
  } catch (e) {
    return { ...out, imageOmitted: `the image could not be read: ${(e as Error).message}` };
  }
}
