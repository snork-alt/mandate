import { describe, expect, it } from 'vitest';
import { codeBlockRange, locateQuote, sectionBodyRange, sectionLineRange, selectionRanges } from '../src/index.js';

const DOC = `---
title: T
sections:
  - id: tokens
    title: Tokens
    type: markdown
  - id: flow
    title: Flow
    type: mermaid
  - id: list
    title: List
    type: markdown
---

<!-- @section tokens -->
## Tokens

Tokens are **issued** by \`AuthService.login\` and stored
as a [SessionToken](https://example.com/st).

Refresh tokens rotate.

<!-- @section flow -->
## Flow

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

<!-- @section list -->
## List

- [x] Google sign-in works
- [ ] Refresh tokens rotate
> quoted *text*
`;

describe('locateQuote', () => {
  it('finds quotes across markdown syntax and line breaks', () => {
    expect(locateQuote(DOC, 'Tokens are issued by AuthService.login and stored as a SessionToken.', 'tokens')).toEqual({ start: 18, end: 19 });
    expect(locateQuote(DOC, '  stored\n as   a  SessionToken ')).toEqual({ start: 18, end: 19 });
  });

  it('matches single lines, list items and quotes', () => {
    expect(locateQuote(DOC, 'Google sign-in works')).toEqual({ start: 34, end: 34 });
    expect(locateQuote(DOC, 'Google sign-in works\nRefresh tokens rotate', 'list')).toEqual({ start: 34, end: 35 });
    expect(locateQuote(DOC, 'quoted text')).toEqual({ start: 36, end: 36 });
    expect(locateQuote(DOC, 'A-->B', 'flow')).toEqual({ start: 28, end: 28 });
    expect(locateQuote(DOC, 'tokens', 'tokens')).toBeNull(); // ambiguous within the section
  });

  it('requires a unique match', () => {
    // "Refresh tokens rotate" appears in two sections: ambiguous in the whole file...
    expect(locateQuote(DOC, 'Refresh tokens rotate')).toBeNull();
    // ...but unique within one section.
    expect(locateQuote(DOC, 'Refresh tokens rotate', 'tokens')).toEqual({ start: 21, end: 21 });
    expect(locateQuote(DOC, 'Refresh tokens rotate', 'list')).toEqual({ start: 35, end: 35 });
  });

  it('returns null for missing quotes, sections and trivial selections', () => {
    expect(locateQuote(DOC, 'not in the document')).toBeNull();
    expect(locateQuote(DOC, 'Tokens', 'ghost')).toBeNull();
    expect(locateQuote(DOC, ' a ')).toBeNull();
  });

  it('computes section line ranges', () => {
    expect(sectionLineRange(DOC, 'tokens')).toEqual({ start: 15, end: 21 });
    expect(sectionLineRange(DOC, 'list')).toEqual({ start: 31, end: 36 });
    expect(sectionLineRange(DOC, 'ghost')).toBeNull();
  });
});

describe('block and selection ranges', () => {
  const CODE = DOC.replace('Refresh tokens rotate.\n', 'Refresh tokens rotate.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n');
  it('finds a code block by its content and lines inside it', () => {
    // fence open .. close
    expect(codeBlockRange(CODE, 'tokens', 'const a = 1;\nconst b = 2;')).toEqual({ start: 23, end: 26 });
    expect(codeBlockRange(CODE, 'tokens', 'nope')).toBeNull();
    // partial selection inside the block: just the selected line
    expect(locateQuote(CODE, 'const b = 2;', 'tokens')).toEqual({ start: 25, end: 25 });
  });

  it('gives a diagram section its fence range', () => {
    expect(sectionBodyRange(DOC, 'flow')).toEqual({ start: 26, end: 29 });
    expect(codeBlockRange(DOC, 'flow')).toEqual({ start: 26, end: 29 });
  });

  it('maps a multi-section selection to one range per section', () => {
    expect(selectionRanges(DOC, [
      { sectionId: 'tokens', text: 'Refresh tokens rotate.' },
      { sectionId: 'list', text: 'Google sign-in works' },
    ])).toEqual([
      { sectionId: 'tokens', lines: { start: 21, end: 21 } },
      { sectionId: 'list', lines: { start: 34, end: 34 } },
    ]);
  });
});
