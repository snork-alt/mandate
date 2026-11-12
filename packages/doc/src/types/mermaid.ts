import type { SectionTypeDef } from '../registry.js';
import { mermaidToLines } from '../split/extract.js';

/** A Mermaid diagram, stored in a ```mermaid fence. (A syntax check can be added via `validate` later.) */
export const mermaidType: SectionTypeDef = {
  id: 'mermaid',
  label: 'Diagram',
  description: 'Mermaid diagram source (flowchart, sequenceDiagram, stateDiagram-v2, ...), stored in a mermaid fence.',
  fence: 'mermaid',
  toIndexText: (section) => mermaidToLines(section.body),
};
