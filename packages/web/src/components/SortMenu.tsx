import { Button, Menu } from '@mantine/core';
import { IconArrowsSort, IconCheck } from '@tabler/icons-react';
import type { Priority, SpecMaturity } from '@mandate/shared';
import { compareMaturity } from '../lib/maturity';
import { priorityRank } from '../lib/specs';

export type SortKey = 'updated' | 'created' | 'priority' | 'versions' | 'title' | 'usedBy' | 'audited' | 'maturity';

export const SORT_LABEL: Record<SortKey, string> = {
  updated: 'Updated',
  created: 'Created',
  priority: 'Priority',
  versions: 'Versions',
  title: 'Title',
  usedBy: 'Used by',
  audited: 'Last audited',
  maturity: 'Maturity',
};

interface Sortable {
  title: string;
  updatedAt: string;
  createdAt: string;
  versionCount: number;
  priority?: Priority;
  usedBy?: number;
  /** Specs: the last completed audit (`audited` sort: never audited first, then oldest first). */
  lastAudit?: { at: string } | null;
  /** Specs: derived maturity (`maturity` sort: needs-attention overlays first, then least mature). */
  maturity?: SpecMaturity;
}

/** Sort a copy of `items`: dates and counts descending, title ascending, priority urgent first. */
export function sortItems<T extends Sortable>(items: T[], key: SortKey): T[] {
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    priority: (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
    versions: (a, b) => b.versionCount - a.versionCount || b.updatedAt.localeCompare(a.updatedAt),
    title: (a, b) => a.title.localeCompare(b.title),
    usedBy: (a, b) => (b.usedBy ?? 0) - (a.usedBy ?? 0) || a.title.localeCompare(b.title),
    maturity: compareMaturity,
    audited: (a, b) => (a.lastAudit?.at ?? '').localeCompare(b.lastAudit?.at ?? '') || a.title.localeCompare(b.title),
  };
  return [...items].sort(cmp[key]);
}

export function SortMenu({ value, options, onChange }: { value: SortKey; options: SortKey[]; onChange: (v: SortKey) => void }) {
  return (
    <Menu position="bottom-end" width={170}>
      <Menu.Target>
        <Button variant="default" leftSection={<IconArrowsSort size={14} />}>
          {SORT_LABEL[value]}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Sort by</Menu.Label>
        {options.map((o) => (
          <Menu.Item key={o} onClick={() => onChange(o)} rightSection={o === value ? <IconCheck size={14} /> : null}>
            {SORT_LABEL[o]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
