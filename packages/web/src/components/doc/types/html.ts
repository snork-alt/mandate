import { lazy } from 'react';
import { IconBrowser } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const htmlRenderer: SectionRenderer = {
  id: 'html',
  label: 'HTML',
  icon: IconBrowser,
  Body: lazy(() => import('./HtmlBody')),
};
