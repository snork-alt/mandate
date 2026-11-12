import { lazy } from 'react';
import { IconListCheck } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const auditItemRenderer: SectionRenderer = {
  id: 'audit-item',
  label: 'Audit item',
  icon: IconListCheck,
  // The checked criterion / rule, the prose (how it was checked, why it passes or fails) and the findings.
  Body: lazy(() => import('./AuditItemBody')),
};
