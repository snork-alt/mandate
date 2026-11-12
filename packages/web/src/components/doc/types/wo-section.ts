import { lazy } from 'react';
import { IconListDetails } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const woSectionRenderer: SectionRenderer = {
  id: 'wo-section',
  label: 'Work-order section',
  icon: IconListDetails,
  // The targeted spec section, implementation notes, verifications, code touched, deviations and comment threads.
  Body: lazy(() => import('./WoSectionBody')),
};
