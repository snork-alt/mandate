import { useState } from 'react';
import { Modal, UnstyledButton } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';
import type { Section } from '@mandate/shared';
import { getMcpProject } from '../../../mcp/client';
import { useDocSource, type DocSource } from '../DocSourceContext';
import type { SectionBodyProps } from './registry';

/** Body of an `image` section: JSON metadata; the file is served by `GET /p/<project>/images/...`. */
export interface ImageMeta {
  file: string;
  alt: string;
  caption?: string;
  mime: string;
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
}

export function parseImageMeta(body: string): ImageMeta | null {
  try {
    const m = JSON.parse(body) as Partial<ImageMeta>;
    return typeof m.alt === 'string' && typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) && typeof m.mime === 'string' ? (m as ImageMeta) : null;
  } catch {
    return null;
  }
}

const IMAGE_KINDS = new Set(['specs', 'standards', 'components']);

/** URL of a section's image, pinned to its content hash (immutable: any version / diff side shows its own bytes). */
export function imageSrc(doc: Pick<DocSource, 'kind' | 'id'> | null, sectionId: string, meta: ImageMeta, project = getMcpProject()): string | null {
  if (!doc || !project || !IMAGE_KINDS.has(doc.kind)) return null;
  return `/p/${encodeURIComponent(project)}/images/${doc.kind}/${encodeURIComponent(doc.id)}/${encodeURIComponent(sectionId)}?h=${meta.sha256}`;
}

const FORMAT: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' };
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The picture (or its alt text when it cannot be shown). */
function Picture({ src, meta, className, onOpen }: { src: string | null; meta: ImageMeta; className?: string; onOpen?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="image-section-missing" role="img" aria-label={meta.alt}>
        <IconPhotoOff size={18} />
        <span>{meta.alt}</span>
      </div>
    );
  }
  const img = <img src={src} alt={meta.alt} title={meta.alt} width={meta.width} height={meta.height} loading="lazy" decoding="async" className={className} onError={() => setFailed(true)} />;
  return onOpen ? (
    <UnstyledButton className="image-section-open" onClick={onOpen} aria-label={`Enlarge image: ${meta.alt}`}>
      {img}
    </UnstyledButton>
  ) : (
    img
  );
}

/** A small rendering of an image section (diff views: before / after). */
export function ImageThumb({ section, label }: { section: Section; label: string }) {
  const doc = useDocSource();
  const meta = parseImageMeta(section.body);
  return (
    <figure className="image-thumb" data-testid={`image-thumb-${label.toLowerCase()}`}>
      <figcaption>{label}</figcaption>
      {meta ? <Picture src={imageSrc(doc, section.id, meta)} meta={meta} className="image-thumb-img" /> : <div className="image-section-missing">No image</div>}
    </figure>
  );
}

export default function ImageBody({ section }: SectionBodyProps) {
  const doc = useDocSource();
  const [open, setOpen] = useState(false);
  const meta = parseImageMeta(section.body);
  if (!meta) return <p className="section-empty">This image section has no valid metadata.</p>;
  const src = imageSrc(doc, section.id, meta);
  const facts = [FORMAT[meta.mime] ?? meta.mime, meta.width && meta.height ? `${meta.width}×${meta.height}` : null, size(meta.bytes)].filter(Boolean).join(' · ');
  return (
    <figure className="image-section" data-testid="image-section">
      <Picture src={src} meta={meta} className="image-section-img" onOpen={() => setOpen(true)} />
      <figcaption>
        {meta.caption && <span className="image-section-caption">{meta.caption}</span>}
        <span className="image-section-meta">{facts}</span>
      </figcaption>
      {src && (
        <Modal opened={open} onClose={() => setOpen(false)} title={section.title} size="auto" centered>
          <img src={src} alt={meta.alt} className="image-lightbox-img" />
          <p className="image-lightbox-alt">{meta.alt}</p>
        </Modal>
      )}
    </figure>
  );
}
