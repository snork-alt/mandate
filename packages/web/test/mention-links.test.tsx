// @vitest-environment jsdom
/** A pasted `@mandate:mandate://...` mention is never shown or stored raw: it becomes a bare reference (a link chip). */
import { describe, expect, it } from 'vitest';
import { normalizeMentions } from '@mandate/shared/refs';
import { linkBareRefs } from '../src/components/Markdown';

describe('pasted mentions', () => {
  const raw = 'why is it outdated? @mandate:mandate://specs/firecracker-microvm-manager/sections/create-vm';
  it('are normalised to the bare reference', () => {
    expect(normalizeMentions(raw)).toBe('why is it outdated? mandate://specs/firecracker-microvm-manager/sections/create-vm');
  });
  it('render as an autolink (a chip), never as raw @mandate: text', () => {
    const md = linkBareRefs(raw);
    expect(md).toContain('<mandate://specs/firecracker-microvm-manager/sections/create-vm>');
    expect(md).not.toContain('@mandate:');
  });
});
