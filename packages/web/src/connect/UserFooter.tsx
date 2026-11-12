import { ActionIcon, Avatar, Group, Text, Tooltip } from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { logout, useAuth } from '../auth';

/** Sidebar footer: the signed-in GitHub user and Logout. */
export function UserFooter() {
  const user = useAuth()?.user;
  if (!user) return null;
  return (
    <Group gap={8} wrap="nowrap" className="user-footer" data-testid="user-footer">
      <Avatar src={user.avatarUrl} size={22} radius="xl" alt="" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={500} truncate lh={1.2}>
          {user.name || user.login}
        </Text>
        {user.name && (
          <Text size="xs" c="var(--app-text-faint)" truncate lh={1.2}>
            @{user.login}
          </Text>
        )}
      </div>
      <Tooltip label="Log out">
        <ActionIcon
          size="sm"
          variant="subtle"
          aria-label="Log out"
          onClick={() =>
            void logout()
              .catch(() => undefined)
              .then(() => window.location.assign('/login'))
          }
        >
          <IconLogout size={15} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
