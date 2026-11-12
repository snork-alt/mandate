import { Group, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** Sticky 44px page header with breadcrumbs on the left and actions on the right. */
export function TopBar({ crumbs, children }: { crumbs: Crumb[]; children?: ReactNode }) {
  return (
    <div className="topbar">
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {crumbs.map((c, i) => (
          <Group key={i} gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            {i > 0 && <IconChevronRight size={12} color="var(--app-text-faint)" style={{ flexShrink: 0 }} />}
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
