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

/** Descriptive prose (introduction, background): stored and rendered as markdown, never implementable (needs no criterion). */
export const overviewType: SectionTypeDef = { ...markdownType, id: 'overview', label: 'Overview', description: 'Descriptive markdown (introduction, background): not implementable, no acceptance criterion needed.' };
/** Alias of overview for context / background prose. */
export const contextType: SectionTypeDef = { ...markdownType, id: 'context', label: 'Context', description: 'Descriptive markdown (context, background): not implementable, no acceptance criterion needed.' };
