import type { ReactNode } from 'react';
import type { NodeKind } from '@mandate/shared';
import { KIND_ICON } from '../refs/kinds';
import { initials } from '../../lib/specs';
import { FilterButton, type FilterOption } from '../FilterButton';
import type { ActivityFilters } from './types';
import { UserAvatar } from '../attribution/Attribution';

const famIcon = (k: NodeKind) => {
  const I = KIND_ICON[k];
  return <I size={14} stroke={1.6} />;
};
/** Icon per event family: the object-type icon (KIND_ICON). */
export const FAMILY_ICON: Record<string, ReactNode> = {
  spec: famIcon('spec'),
  standard: famIcon('standard'),
  work_order: famIcon('work_order'),
  feedback: famIcon('feedback'),
  verification: famIcon('verification'),
  audit: famIcon('audit'),
  finding: famIcon('finding'),
  component: famIcon('component'),
  question: famIcon('question'),
  comment: famIcon('comment'),
  git: famIcon('commit'),
  commit: famIcon('commit'),
};

/** Agent and event-type filters: the same menu buttons as the Specs toolbar (multi-select). */
export function ActivityFilterBar({ filters, onChange, agents, types, users = [] }: { filters: ActivityFilters; onChange: (f: ActivityFilters) => void; agents: string[]; types: string[]; users?: string[] }) {
  const agentOptions: FilterOption[] = agents.map((a) => ({ value: a, label: a, icon: <span className="claim-avatar activity-avatar">{initials(a)}</span> }));
  const typeOptions: FilterOption[] = types.map((t) => ({ value: t, label: t.replace(/_/g, ' '), icon: FAMILY_ICON[t] }));
  const userOptions: FilterOption[] = users.map((u) => ({ value: u, label: u, icon: <UserAvatar user={u} size={14} /> }));
  return (
    <div className="activity-filters">
      {userOptions.length > 0 && <FilterButton label="User" options={userOptions} selected={filters.users ?? []} onChange={(v) => onChange({ ...filters, users: v })} searchable clearable summary="colon" />}
      <FilterButton label="Agent" options={agentOptions} selected={filters.agents ?? []} onChange={(v) => onChange({ ...filters, agents: v })} searchable clearable summary="colon" />
      <FilterButton label="Type" options={typeOptions} selected={filters.types ?? []} onChange={(v) => onChange({ ...filters, types: v })} searchable clearable summary="colon" />
    </div>
  );
}
