import { lazy } from 'react';
import { IconCircleCheck } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const acceptanceRenderer: SectionRenderer = {
  id: 'acceptance',
  label: 'Criterion',
  icon: IconCircleCheck,
  // Inside DocPage, acceptance sections render as grouped criterion cards; elsewhere the body is markdown.
  Body: lazy(() => import('./MarkdownBody')),
};
