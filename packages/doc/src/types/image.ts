import { z } from 'zod';
import type { SectionTypeDef } from '../registry.js';

/** Image formats an image section may hold (SVG is served sandboxed and shown through <img> only). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
/** File extension stored for each format. */
export const IMAGE_EXT: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * Body of an `image` section (JSON in an ```image fence): the binary itself lives next to the document
 * (`<kind>/<docId>.assets/<file>`), versioned by git; the body holds what agents, search and Ask read (alt, caption)
 * and the facts of the stored file (mime, dimensions, size, sha256). The file facts are set by uploads only.
 */
export const imageMetaSchema = z
  .object({
    /** File name inside the document's `.assets` directory: `<section id>.<ext>`. */
    file: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpg|gif|webp|svg)$/, 'file must be <section id>.<png|jpg|gif|webp|svg>'),
    /** What the image shows (required): agents, search and Ask read this instead of the pixels. */
    alt: z.string().trim().min(1, 'alt text is required').max(2000),
    caption: z.string().trim().min(1).max(2000).optional(),
    mime: z.enum(IMAGE_MIME_TYPES),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 hex characters'),
  })
  .strict();
export type ImageMeta = z.output<typeof imageMetaSchema>;

/** The image metadata of a section body, or null when the body is not valid image JSON. */
export function parseImageBody(body: string): ImageMeta | null {
  try {
    const r = imageMetaSchema.safeParse(JSON.parse(body));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Problems with an image body (empty = valid). */
export function imageBodyProblems(body: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return ['an image section body is JSON metadata ({ file, alt, caption?, mime, width, height, bytes, sha256 }); upload images with curl'];
  }
  const r = imageMetaSchema.safeParse(json);
  return r.success ? [] : r.error.issues.map((i) => `image ${i.path.join('.') || 'body'}: ${i.message}`);
}

/** Canonical body text (stable key order, one field per line: readable git diffs). */
export function imageBody(meta: ImageMeta): string {
  const ordered: Record<string, unknown> = {};
  for (const k of ['file', 'alt', 'caption', 'mime', 'width', 'height', 'bytes', 'sha256'] as const) if (meta[k] !== undefined) ordered[k] = meta[k];
  return JSON.stringify(ordered, null, 2);
}

/** The fields that describe the stored file (only an upload may change them). */
export const IMAGE_FILE_FIELDS = ['file', 'mime', 'width', 'height', 'bytes', 'sha256'] as const;

/** An image (screenshot, mockup, diagram): JSON metadata in an ```image fence, the binary next to the document. */
export const imageType: SectionTypeDef = {
  id: 'image',
  label: 'Image',
  description: 'Image (PNG, JPEG, GIF, WebP, SVG) uploaded with curl; the body is JSON metadata (alt text required, caption) and the file is stored next to the document.',
  fence: 'image',
  diffMode: 'lines',
  validate: (body) => imageBodyProblems(body),
  toIndexText: (section) => {
    const m = parseImageBody(section.body);
    if (!m) return '';
    return [m.alt, m.caption].filter(Boolean).join('\n\n');
  },
};
