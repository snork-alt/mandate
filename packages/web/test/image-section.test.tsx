// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Section } from '@mandate/shared';
import { installDom, Wrap } from './dom';
import { DocSourceProvider, type DocSource } from '../src/components/doc/DocSourceContext';
import { SectionBlock } from '../src/components/doc/SectionBlock';
import { TrackedSection } from '../src/components/doc/tracked/TrackedSection';
import { imageSrc, parseImageMeta } from '../src/components/doc/types/ImageBody';
import '../src/components/doc/types';

vi.mock('../src/mcp/client', () => ({
  getMcpProject: () => 'acme',
  callTool: vi.fn(async () => ({})),
  McpToolError: class extends Error {},
}));

installDom();
afterEach(cleanup);

const SHA = 'a'.repeat(64);
const meta = { file: 'shot.png', alt: 'Checkout page with the pay button', caption: 'Mockup v2', mime: 'image/png', width: 800, height: 600, bytes: 20480, sha256: SHA };
const section = (body: object | string, id = 'shot'): Section => ({ id, title: 'Checkout screenshot', type: 'image', body: typeof body === 'string' ? body : JSON.stringify(body), refs: [], symbols: [], links: [], verifiedBy: [] }) as unknown as Section;
const doc: DocSource = { kind: 'specs', id: 'checkout', source: () => null, lib: () => null };
const inDoc = (ui: React.ReactNode, d: DocSource | null = doc) => render(<Wrap><DocSourceProvider value={d}>{ui}</DocSourceProvider></Wrap>);

describe('image sections in the web UI', () => {
  it('parses metadata and builds a content-pinned URL', () => {
    expect(parseImageMeta(JSON.stringify(meta))).toMatchObject({ alt: meta.alt });
    expect(parseImageMeta('{"alt":"x"}')).toBeNull();
    expect(parseImageMeta('nope')).toBeNull();
    expect(imageSrc(doc, 'shot', meta, 'acme')).toBe(`/p/acme/images/specs/checkout/shot?h=${SHA}`);
    expect(imageSrc({ kind: 'audits', id: 'a' }, 'shot', meta, 'acme')).toBeNull();
  });

  it('renders the picture with alt, caption and facts; click opens the lightbox', async () => {
    inDoc(<SectionBlock section={section(meta)} />);
    const img = (await screen.findByAltText(meta.alt)) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/p/acme/images/specs/checkout/shot?h=${SHA}`);
    expect(img.getAttribute('width')).toBe('800');
    expect(screen.getByText('Mockup v2')).toBeTruthy();
    expect(screen.getByText('PNG · 800×600 · 20 KB')).toBeTruthy();
    expect(screen.getByText('Image')).toBeTruthy(); // type chip
    fireEvent.click(screen.getByRole('button', { name: `Enlarge image: ${meta.alt}` }));
    await waitFor(() => expect(screen.getAllByAltText(meta.alt).length).toBe(2));
  });

  it('falls back to the alt text without a document context or when the file fails to load', async () => {
    inDoc(<SectionBlock section={section(meta)} />, null);
    expect((await screen.findByRole('img', { name: meta.alt })).textContent).toContain(meta.alt);
    cleanup();
    inDoc(<SectionBlock section={section(meta)} />);
    fireEvent.error(await screen.findByAltText(meta.alt));
    expect(screen.getByRole('img', { name: meta.alt }).tagName).toBe('DIV');
    cleanup();
    inDoc(<SectionBlock section={section('not json')} />);
    expect(await screen.findByText(/no valid metadata/)).toBeTruthy();
  });

  it('diff view: "Image changed" with before / after thumbnails', async () => {
    const before = section(meta);
    const after = section({ ...meta, sha256: 'b'.repeat(64), alt: 'New checkout' });
    const diff = { id: 'shot', status: 'modified', moved: false, before, after, meta: [], body: { mode: 'lines', ops: [{ op: 'equal', text: 'x' }] } };
    inDoc(<TrackedSection diff={diff as never} />);
    expect(await screen.findByText('Image changed')).toBeTruthy();
    expect(screen.getByAltText(meta.alt).getAttribute('src')).toContain(`h=${SHA}`);
    expect(screen.getByAltText('New checkout').getAttribute('src')).toContain(`h=${'b'.repeat(64)}`);
    expect(screen.getByTestId('image-thumb-before')).toBeTruthy();
    expect(screen.getByTestId('image-thumb-after')).toBeTruthy();
  });
});
