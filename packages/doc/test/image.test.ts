import { describe, expect, it } from 'vitest';
import { imageBody, imageBodyProblems, imageType, parseImageBody, type ImageMeta } from '../src/index.js';
import { fmt } from './fixtures.js';

const META: ImageMeta = { file: 'checkout.png', alt: 'Checkout page with the pay button', caption: 'v2 mockup', mime: 'image/png', width: 800, height: 600, bytes: 1234, sha256: 'a'.repeat(64) };

describe('image section type', () => {
  it('body: canonical JSON, parsed back; problems for bad bodies', () => {
    const body = imageBody(META);
    expect(body.split('\n')[1]).toBe('  "file": "checkout.png",');
    expect(parseImageBody(body)).toEqual(META);
    expect(imageBodyProblems(body)).toEqual([]);
    expect(imageBodyProblems('not json')[0]).toMatch(/JSON metadata/);
    expect(imageBodyProblems(JSON.stringify({ ...META, alt: ' ' })).join()).toMatch(/alt/);
    expect(imageBodyProblems(JSON.stringify({ ...META, file: '../x.png' })).join()).toMatch(/file/);
    expect(imageBodyProblems(JSON.stringify({ ...META, extra: 1 })).length).toBeGreaterThan(0);
  });

  it('indexes alt and caption only', () => {
    expect(imageType.toIndexText!({ id: 's', title: 'S', type: 'image', body: imageBody(META), refs: [], symbols: [], links: [], verifiedBy: [] })).toBe('Checkout page with the pay button\n\nv2 mockup');
  });

  it('round-trips in an ```image fence and is validated', () => {
    const md = fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'checkout', title: 'Checkout', type: 'image', body: imageBody(META) }] });
    expect(md).toContain('```image\n{');
    expect(fmt.parse(md).sections[0]!.body).toBe(imageBody(META));
    expect(fmt.validate(md).ok).toBe(true);
    expect(() => fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'checkout', title: 'Checkout', type: 'image', body: '{"alt":"x"}' }] })).toThrow(/image/);
    expect(fmt.validate(md.replace('"alt": "Checkout page with the pay button"', '"alt": ""')).ok).toBe(false);
  });
});
