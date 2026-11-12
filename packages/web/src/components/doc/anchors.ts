import { getSectionRenderer } from './types';

/** DOM id of a section block (`#section-<id>`). */
export const sectionAnchor = (id: string) => `section-${id}`;

/** Human label of a section type (falls back to the id for unknown types). */
export function sectionTypeLabel(type: string): string {
  return getSectionRenderer(type)?.label ?? type;
}
