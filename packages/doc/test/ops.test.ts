import { describe, expect, it } from 'vitest';
import { DocError, deleteSection, getSection, insertSection, moveSection, updateSection } from '../src/index.js';
import { CANONICAL, fmt } from './fixtures.js';

const ids = (d: { sections: { id: string }[] }) => d.sections.map((s) => s.id);
const base = () => fmt.parse(CANONICAL);

describe('section ops', () => {
  it('gets a section by id', () => {
    expect(getSection(base(), 'auth-flow')?.type).toBe('mermaid');
    expect(getSection(base(), 'missing')).toBeUndefined();
  });

  it('inserts at the end, at an index, or relative to another section', () => {
    const d = base();
    expect(ids(insertSection(d, { id: 'n', title: 'N' }))).toEqual(['overview', 'auth-flow', 'button', 'n']);
    expect(ids(insertSection(d, { id: 'n', title: 'N' }, 0))).toEqual(['n', 'overview', 'auth-flow', 'button']);
    expect(ids(insertSection(d, { id: 'n', title: 'N' }, -2))).toEqual(['overview', 'auth-flow', 'n', 'button']);
    expect(ids(insertSection(d, { id: 'n', title: 'N' }, { before: 'button' }))).toEqual(['overview', 'auth-flow', 'n', 'button']);
    expect(ids(insertSection(d, { id: 'n', title: 'N' }, { after: 'overview' }))).toEqual(['overview', 'n', 'auth-flow', 'button']);
    expect(insertSection(d, { id: 'n', title: 'N' }).sections[3]).toEqual({
      id: 'n', title: 'N', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: '',
    });
    expect(ids(d)).toEqual(['overview', 'auth-flow', 'button']); // immutable
  });

  it('rejects duplicate ids, invalid sections and unknown anchors', () => {
    expect(() => insertSection(base(), { id: 'overview', title: 'x' })).toThrow(/already exists/);
    expect(() => insertSection(base(), { id: 'Nope!', title: 'x' })).toThrow(DocError);
    expect(() => insertSection(base(), { id: 'n', title: 'N' }, { after: 'ghost' })).toThrow(/ghost/);
  });

  it('updates fields and renames ids', () => {
    const d = updateSection(base(), 'overview', { title: 'Summary', body: 'new' });
    expect(getSection(d, 'overview')).toMatchObject({ title: 'Summary', body: 'new', type: 'markdown' });
    const renamed = updateSection(d, 'overview', { id: 'summary' });
    expect(ids(renamed)).toEqual(['summary', 'auth-flow', 'button']);
    expect(() => updateSection(d, 'overview', { id: 'button' })).toThrow(/already exists/);
    expect(() => updateSection(d, 'ghost', { title: 'x' })).toThrow(/not found/);
    expect(() => updateSection(d, 'overview', { type: 'Not A Type' })).toThrow(DocError);
    // Ops don't know the registry; unregistered types are caught when serializing.
    expect(() => fmt.serialize(updateSection(d, 'overview', { type: 'video' }))).toThrow(/unknown type "video"/);
    // Updated docs serialize with headings rewritten from the new title.
    expect(fmt.serialize(d)).toContain('<!-- @section overview -->\n## Summary\n\nnew\n');
  });

  it('moves sections', () => {
    expect(ids(moveSection(base(), 'button', 0))).toEqual(['button', 'overview', 'auth-flow']);
    expect(ids(moveSection(base(), 'overview', -1))).toEqual(['auth-flow', 'button', 'overview']);
    expect(ids(moveSection(base(), 'overview', { after: 'button' }))).toEqual(['auth-flow', 'button', 'overview']);
    expect(ids(moveSection(base(), 'button', { before: 'auth-flow' }))).toEqual(['overview', 'button', 'auth-flow']);
    expect(ids(moveSection(base(), 'button', { before: 'button' }))).toEqual(['overview', 'auth-flow', 'button']);
    expect(() => moveSection(base(), 'ghost', 0)).toThrow(/not found/);
  });

  it('deletes sections', () => {
    const d = deleteSection(base(), 'auth-flow');
    expect(ids(d)).toEqual(['overview', 'button']);
    expect(fmt.validate(fmt.serialize(d)).ok).toBe(true);
    expect(() => deleteSection(d, 'auth-flow')).toThrow(/not found/);
  });
});
