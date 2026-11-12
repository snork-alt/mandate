import { DocError } from './errors.js';
import { sectionSchema, type Doc, type Section, type SectionInput } from './schema.js';

/** Where to put a section: an index (negative counts from the end) or relative to another section. */
export type SectionPosition = number | { before: string } | { after: string };

function notFound(id: string): DocError {
  return new DocError([{ code: 'section-not-found', message: `section "${id}" not found`, sectionId: id }]);
}

function indexOf<F>(doc: Doc<F>, id: string): number {
  const i = doc.sections.findIndex((s) => s.id === id);
  if (i < 0) throw notFound(id);
  return i;
}

function resolve(sections: Section[], at: SectionPosition | undefined): number {
  if (at === undefined) return sections.length;
  if (typeof at === 'number') {
    const i = at < 0 ? sections.length + at + 1 : at;
    return Math.max(0, Math.min(sections.length, i));
  }
  const ref = 'before' in at ? at.before : at.after;
  const i = sections.findIndex((s) => s.id === ref);
  if (i < 0) throw notFound(ref);
  return 'before' in at ? i : i + 1;
}

function toSection(input: SectionInput): Section {
  const r = sectionSchema.safeParse(input);
  if (!r.success) {
    throw new DocError(
      r.error.issues.map((i) => ({ code: 'sections-invalid' as const, message: `section.${i.path.join('.')}: ${i.message}`, sectionId: input.id })),
    );
  }
  return r.data;
}

function assertUnique(sections: Section[], id: string, except?: number): void {
  if (sections.some((s, i) => s.id === id && i !== except)) {
    throw new DocError([{ code: 'duplicate-id', message: `section "${id}" already exists`, sectionId: id }]);
  }
}

export function getSection<F>(doc: Doc<F>, id: string): Section | undefined {
  return doc.sections.find((s) => s.id === id);
}

/** Insert a new section (default: at the end). Returns a new document. */
export function insertSection<F>(doc: Doc<F>, input: SectionInput, at?: SectionPosition): Doc<F> {
  const section = toSection(input);
  assertUnique(doc.sections, section.id);
  const sections = [...doc.sections];
  sections.splice(resolve(sections, at), 0, section);
  return { ...doc, sections };
}

/** Patch a section's fields (including renaming its id). Returns a new document. */
export function updateSection<F>(doc: Doc<F>, id: string, patch: Partial<SectionInput>): Doc<F> {
  const i = indexOf(doc, id);
  const section = toSection({ ...doc.sections[i]!, ...patch });
  assertUnique(doc.sections, section.id, i);
  const sections = [...doc.sections];
  sections[i] = section;
  return { ...doc, sections };
}

/** Move a section to a new position (index in the resulting list, or before/after another section). */
export function moveSection<F>(doc: Doc<F>, id: string, to: SectionPosition): Doc<F> {
  const i = indexOf(doc, id);
  if (typeof to === 'object' && ('before' in to ? to.before : to.after) === id) return doc;
  const sections = [...doc.sections];
  const [section] = sections.splice(i, 1);
  sections.splice(resolve(sections, to), 0, section!);
  return { ...doc, sections };
}

/** Remove a section. Returns a new document. */
export function deleteSection<F>(doc: Doc<F>, id: string): Doc<F> {
  const i = indexOf(doc, id);
  return { ...doc, sections: doc.sections.filter((_, j) => j !== i) };
}
