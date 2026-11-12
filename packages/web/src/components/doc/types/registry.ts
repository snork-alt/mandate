import type { ComponentType } from 'react';
import type { Icon } from '@tabler/icons-react';
import type { Section } from '@mandate/shared';

export interface SectionBodyProps {
  section: Section;
}

/**
 * How the web UI renders one section type. `Body` should be a `React.lazy` component so
 * heavy renderers (e.g. mermaid) load only when a section of that type is shown.
 */
export interface SectionRenderer {
  /** Must match the section type id registered in @mandate/doc. */
  id: string;
  label: string;
  icon: Icon;
  Body: ComponentType<SectionBodyProps>;
}

const renderers = new Map<string, SectionRenderer>();

/**
 * Register (or, during development hot reloads, replace) the renderer for a section type.
 * In production a second registration of the same id is a bug and throws.
 */
export function registerSectionRenderer(renderer: SectionRenderer): void {
  if (renderers.has(renderer.id) && !import.meta.env.DEV) {
    throw new Error(`section renderer "${renderer.id}" is already registered`);
  }
  renderers.set(renderer.id, renderer);
}

export function getSectionRenderer(id: string): SectionRenderer | undefined {
  return renderers.get(id);
}
