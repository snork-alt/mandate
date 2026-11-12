import { ActionIcon, Avatar, Group, Menu, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconLogout, IconSettings } from '@tabler/icons-react';
import { goTo } from '../project';
import { logout, useAuth } from '../auth';

/** Sidebar footer: the signed-in GitHub user and Logout. */
export function UserFooter() {
  const auth = useAuth();
  const user = auth?.user;
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
      {auth?.isAdmin && (
        <Tooltip label="Settings">
          <ActionIcon size="sm" variant="subtle" aria-label="Settings" onClick={() => goTo('/settings')} data-testid="open-settings">
            <IconSettings size={15} />
          </ActionIcon>
        </Tooltip>
      )}
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

const doLogout = () =>
  void logout()
    .catch(() => undefined)
    .then(() => window.location.assign('/login'));

/** Home header: avatar menu with Settings (admins) and Log out. */
export function UserMenu() {
  const auth = useAuth();
  const user = auth?.user;
  if (!user) return null;
  return (
    <Menu position="bottom-end" width={220} withinPortal>
      <Menu.Target>
        <UnstyledButton className="user-menu-btn" aria-label="Account" data-testid="user-menu">
          <Avatar src={user.avatarUrl} size={24} radius="xl" alt="">
            {user.login.slice(0, 1).toUpperCase()}
          </Avatar>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          {user.name || user.login}
          {user.kind === 'local' ? ' · this computer' : ` · @${user.login}`}
        </Menu.Label>
        {auth?.isAdmin && (
          <Menu.Item leftSection={<IconSettings size={14} />} onClick={() => goTo('/settings')} data-testid="menu-settings">
            Settings
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconLogout size={14} />} onClick={doLogout}>
          Log out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
