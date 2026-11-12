import type { SectionTypeDef } from '../registry.js';
import { verifiedByEdges } from './acceptance.js';

/** Plain markdown, stored as-is. Headings of level 3+ inside the body are just content. */
export const markdownType: SectionTypeDef = {
  id: 'markdown',
  label: 'Markdown',
  description: 'GitHub-flavoured markdown, stored unfenced.',
  toIndexText: (section) => section.body,
  extractEdges: verifiedByEdges,
};
