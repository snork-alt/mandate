import { Group, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { NodeKind } from '@mandate/shared';
import { KindIcon } from './refs/KindIcon';

export interface Crumb {
  label: ReactNode;
  to?: string;
  /** The crumb is a Mandate object: its type icon (KIND_ICON) shows before the label. */
  kind?: NodeKind;
}

/** Sticky 44px page header with breadcrumbs on the left and actions on the right. */
export function TopBar({ crumbs, children }: { crumbs: Crumb[]; children?: ReactNode }) {
  return (
    <div className="topbar">
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {crumbs.map((c, i) => (
          <Group key={i} gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            {i > 0 && <IconChevronRight size={12} color="var(--app-text-faint)" style={{ flexShrink: 0 }} />}
            {c.kind && <KindIcon kind={c.kind} />}
            {c.to ? (
              <Text component={Link} to={c.to} size="md" c="var(--app-text-muted)" fw={500} truncate>
                {c.label}
              </Text>
            ) : (
              <Text size="md" fw={500} truncate component="div">
                {c.label}
              </Text>
            )}
          </Group>
        ))}
      </Group>
      <Group gap={8} wrap="nowrap">
        {children}
      </Group>
    </div>
  );
}
