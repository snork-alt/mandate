import type { ReactNode } from 'react';
import { IconFileText, IconGitCommit, IconClipboardList, IconMessageReport, IconRuler2, IconShieldCheck } from '@tabler/icons-react';
import { initials } from '../../lib/specs';
import { FilterButton, type FilterOption } from '../FilterButton';
import type { ActivityFilters } from './types';

const FAMILY_ICON: Record<string, ReactNode> = {
  spec: <IconFileText size={14} stroke={1.6} />,
  standard: <IconRuler2 size={14} stroke={1.6} />,
  work_order: <IconClipboardList size={14} stroke={1.6} />,
  feedback: <IconMessageReport size={14} stroke={1.6} />,
  verification: <IconShieldCheck size={14} stroke={1.6} />,
  git: <IconGitCommit size={14} stroke={1.6} />,
  commit: <IconGitCommit size={14} stroke={1.6} />,
};

/** Agent and event-type filters: the same menu buttons as the Specs toolbar (multi-select). */
export function ActivityFilterBar({ filters, onChange, agents, types }: { filters: ActivityFilters; onChange: (f: ActivityFilters) => void; agents: string[]; types: string[] }) {
  const agentOptions: FilterOption[] = agents.map((a) => ({ value: a, label: a, icon: <span className="claim-avatar activity-avatar">{initials(a)}</span> }));
  const typeOptions: FilterOption[] = types.map((t) => ({ value: t, label: t.replace(/_/g, ' '), icon: FAMILY_ICON[t] }));
  return (
    <div className="activity-filters">
      <FilterButton label="Agent" options={agentOptions} selected={filters.agents ?? []} onChange={(v) => onChange({ ...filters, agents: v })} searchable clearable summary="colon" />
      <FilterButton label="Type" options={typeOptions} selected={filters.types ?? []} onChange={(v) => onChange({ ...filters, types: v })} searchable clearable summary="colon" />
    </div>
  );
}
