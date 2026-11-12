import { lazy } from 'react';
import { IconScale } from '@tabler/icons-react';
import type { SectionRenderer } from './registry';

export const ruleRenderer: SectionRenderer = {
  id: 'rule',
  label: 'Rule',
  icon: IconScale,
  // Level, rationale, scope, check and Do / Don't blocks (standard pages group rules by level).
  Body: lazy(() => import('./RuleBody')),
};
