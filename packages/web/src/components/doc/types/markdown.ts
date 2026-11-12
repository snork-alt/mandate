import { lazy } from 'react';
import { IconAlignLeft } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const markdownRenderer: SectionRenderer = {
  id: 'markdown',
  label: 'Markdown',
  icon: IconAlignLeft,
  Body: lazy(() => import('./MarkdownBody')),
};
