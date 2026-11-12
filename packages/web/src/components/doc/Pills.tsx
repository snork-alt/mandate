import type { ReactNode } from 'react';
import type { Priority, SpecStatus } from '@mandate/shared';
import { PRIORITY_META, SPEC_STATUS_META } from '../../lib/specs';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';

/** Rounded outline pill used for status, priority and other properties. */
export function Pill({ icon, children, tone }: { icon?: ReactNode; children: ReactNode; tone?: 'warn' | 'danger' | 'accent' }) {
  return (
    <span className="pill" data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

export function StatusPill({ status, reopened }: { status: SpecStatus; reopened?: boolean }) {
  return <Pill icon={<StatusIcon status={status} reopened={reopened} />}>{SPEC_STATUS_META[status].label}</Pill>;
}

export function PriorityPill({ priority }: { priority?: Priority }) {
  return <Pill icon={<PriorityIcon priority={priority} />}>{priority ? PRIORITY_META[priority].label : 'No priority'}</Pill>;
}
