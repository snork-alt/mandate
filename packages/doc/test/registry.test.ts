import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDefaultRegistry, createDocFormat, createRegistry, DocError, type SectionTypeDef } from '../src/index.js';
import { CANONICAL, testSchema } from './fixtures.js';

/** A custom type: JSON stored in a ```json fence, checked with JSON.parse. */
const jsonType: SectionTypeDef = {
  id: 'json',
  label: 'JSON',
  fence: 'json',
  validate(body) {
    try {
      JSON.parse(body);
      return [];
    } catch (err) {
      return [`invalid JSON: ${(err as Error).message}`];
    }
  },
};

const registry = createDefaultRegistry().register(jsonType);
const fmt = createDocFormat(testSchema, { registry });

const JSON_DOC = `---
title: Config
status: draft
sections:
  - id: intro
    title: Intro
    type: markdown
  - id: config
    title: Config
    type: json
---

<!-- @section intro -->
## Intro

The default config.

<!-- @section config -->
## Config

\`\`\`json
{ "retries": 3 }
\`\`\`
`;

describe('section type registry', () => {
  it('registers built-ins through the public API', () => {
    expect(createDefaultRegistry().list().map((t) => [t.id, t.fence])).toEqual([
      ['markdown', undefined],
      ['mermaid', 'mermaid'],
      ['html', 'html'],
      ['acceptance', undefined],
      ['rule', undefined],
    ]);
  });

  it('rejects invalid and duplicate registrations', () => {
    expect(() => createRegistry().register({ id: 'Bad Id' })).toThrow(/invalid section type id/);
    expect(() => createDefaultRegistry().register({ id: 'mermaid' })).toThrow(/already registered/);
    expect(() => createRegistry().register({ id: 'x', fence: 'a b' })).toThrow(/invalid fence/);
  });

  it('parses, serializes and validates a custom type', () => {
    const doc = fmt.parse(JSON_DOC);
    expect(doc.sections[1]).toMatchObject({ id: 'config', type: 'json', body: '{ "retries": 3 }' });
    expect(fmt.serialize(doc)).toBe(JSON_DOC);
    expect(fmt.validate(JSON_DOC)).toMatchObject({ ok: true, issues: [] });

    const created = fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'c', title: 'C', type: 'json', body: '[1, 2]' }] });
    expect(created).toContain('```json\n[1, 2]\n```\n');
    expect(fmt.parse(created).sections[0]!.body).toBe('[1, 2]');
  });

  it('reports custom validation problems instead of crashing', () => {
    const bad = JSON_DOC.replace('{ "retries": 3 }', '{ retries: 3 }');
    const r = fmt.validate(bad);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'body-invalid', sectionId: 'config' });
    expect(() => fmt.parse(bad)).toThrow(DocError);
    expect(() =>
      fmt.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'c', title: 'C', type: 'json', body: 'nope' }] }),
    ).toThrow(/invalid JSON/);
    expect(fmt.validate(JSON_DOC.replace('```json', '```yaml')).issues[0]?.code).toBe('fence-mismatch');
  });

  it('treats types missing from the registry as validation errors', () => {
    const plain = createDocFormat(testSchema); // built-ins only
    const r = plain.validate(JSON_DOC);
    expect(r.issues).toEqual([expect.objectContaining({ code: 'unknown-type', sectionId: 'config' })]);
    expect(r.issues[0]!.message).toContain('registered: markdown, mermaid, html');
    expect(() => plain.serialize(fmt.parse(JSON_DOC))).toThrow(/unknown type "json"/);
    // Built-in documents still work with the custom registry.
    expect(fmt.serialize(fmt.parse(CANONICAL))).toBe(CANONICAL);
  });

  it('applies a body schema', () => {
    const shout = createDocFormat(testSchema, {
      registry: createRegistry().register({ id: 'shout', bodySchema: z.string().regex(/^[A-Z\s!]+$/, 'must be upper case') }),
    });
    const ok = shout.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'A', type: 'shout', body: 'HELLO!' }] });
    expect(ok).toContain('\nHELLO!\n'); // no fence: stored as raw markdown
    expect(() => shout.serialize({ frontmatter: { title: 'T' }, sections: [{ id: 'a', title: 'A', type: 'shout', body: 'hi' }] })).toThrow(
      /must be upper case/,
    );
  });
});
