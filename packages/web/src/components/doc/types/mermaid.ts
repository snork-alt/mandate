import { lazy } from 'react';
import { IconSitemap } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const mermaidRenderer: SectionRenderer = {
  id: 'mermaid',
  label: 'Diagram',
  icon: IconSitemap,
  Body: lazy(() => import('./MermaidBody')),
};
