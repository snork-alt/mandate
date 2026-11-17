import type { CriterionStateName } from '@mandate/shared';

export const CRITERION_STATE_META: Record<CriterionStateName, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'var(--mantine-color-teal-6)' },
  failing: { label: 'Failing', color: 'var(--mantine-color-red-6)' },
  stale: { label: 'Stale', color: 'var(--mantine-color-yellow-6)' },
  unverified: { label: 'Unverified', color: 'var(--app-text-faint)' },
  waived: { label: 'Waived via approval', color: 'var(--mantine-color-orange-6)' },
  unknown: { label: 'Unknown (pin lost)', color: 'var(--mantine-color-grape-6)' },
};
