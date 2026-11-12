import { Menu, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBrandGithub, IconCheck, IconLayoutGrid, IconSelector } from '@tabler/icons-react';
import { githubLoginUrl } from '../auth';
import { Logo } from '../components/Logo';
import { goTo, projectBase } from '../project';
import { useProjects } from './projects';
import { AccessBadge } from './AccessBadge';

/** Sidebar header: the current project, a menu with the other projects and the picker. */
export function ProjectSwitcher({ projectId }: { projectId: string }) {
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  const current = items.find((p) => p.id === projectId);
  return (
    <Menu position="bottom-start" width={248} offset={4} withinPortal>
      <Menu.Target>
        <UnstyledButton className="project-switcher" aria-label="Switch project" data-testid="project-switcher">
          <Logo size={22} />
          <span className="project-switcher-text">
            <Text fw={600} size="sm" truncate lh={1.2}>
              {current?.name ?? projectId}
            </Text>
            <Text size="xs" c="var(--app-text-faint)" truncate lh={1.2} component="div" className="switcher-sub">
              Mandate · {projectId}
            </Text>
          </span>
          {current?.github?.status === 'reconnect' && (
            <Tooltip label="GitHub needs reconnecting" openDelay={300}>
              <span className="reconnect-dot" role="img" aria-label="GitHub needs reconnecting" />
            </Tooltip>
          )}
          <IconSelector size={14} color="var(--app-text-faint)" style={{ flexShrink: 0 }} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Projects</Menu.Label>
        {items.map((p) => (
          <Menu.Item
            key={p.id}
            data-testid={`switch-${p.id}`}
            leftSection={<span className="project-avatar project-avatar-sm">{p.name.slice(0, 1).toUpperCase()}</span>}
            rightSection={p.id === projectId ? <IconCheck size={14} /> : p.access ? <AccessBadge access={p.access} compact /> : null}
            onClick={() => p.id !== projectId && goTo(`${projectBase(p.id)}/`)}
          >
            <Text size="sm" truncate>
              {p.name}
            </Text>
          </Menu.Item>
        ))}
        {projects.isLoading && <Menu.Item disabled>Loading…</Menu.Item>}
        {current?.github?.status === 'reconnect' && (
          <>
            <Menu.Divider />
            <Menu.Item color="yellow" leftSection={<IconBrandGithub size={14} />} onClick={() => window.location.assign(githubLoginUrl('/'))} data-testid="switcher-reconnect">
              Reconnect GitHub
            </Menu.Item>
          </>
        )}
        <Menu.Divider />
        <Menu.Item leftSection={<IconLayoutGrid size={14} />} onClick={() => goTo('/')}>
          All projects
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
