import { lazy } from 'react';
import { IconPhoto } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const imageRenderer: SectionRenderer = {
  id: 'image',
  label: 'Image',
  icon: IconPhoto,
  Body: lazy(() => import('./ImageBody')),
};
