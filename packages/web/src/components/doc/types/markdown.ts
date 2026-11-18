import { lazy } from 'react';
import { IconAlignLeft } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const markdownRenderer: SectionRenderer = {
  id: 'markdown',
  label: 'Markdown',
  icon: IconAlignLeft,
  Body: lazy(() => import('./MarkdownBody')),
};

/** Descriptive prose (introduction, background): rendered as markdown, never implementable. */
export const overviewRenderer: SectionRenderer = { ...markdownRenderer, id: 'overview', label: 'Overview' };
export const contextRenderer: SectionRenderer = { ...markdownRenderer, id: 'context', label: 'Context' };
