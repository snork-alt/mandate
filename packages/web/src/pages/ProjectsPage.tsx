import { ActionIcon, Alert, Box, Button, Group, Skeleton, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowRight, IconBrandGithub, IconFolder, IconGitBranch, IconMoon, IconPlus, IconSun } from '@tabler/icons-react';
import { NewProjectModal } from '../connect/NewProjectModal';
import { NewLocalProjectModal } from '../connect/NewLocalProjectModal';
import { AccessBadge } from '../connect/AccessBadge';
import { UserMenu } from '../connect/UserFooter';
import { repoLabel } from '../connect/github';
import { githubLoginUrl, isLocalMode, useAuth } from '../auth';
import { useEffect } from 'react';
import { APP_NAME, Logo } from '../components/Logo';
import { TimeAgo } from '../components/TimeAgo';
import { useProjects, type ProjectSummary } from '../connect/projects';
import { goTo, lastProject, projectBase } from '../project';

const COUNTS: { key: keyof ProjectSummary['counts']; label: string }[] = [
  { key: 'specs', label: 'specs' },
  { key: 'standards', label: 'standards' },
  { key: 'components', label: 'components' },
  { key: 'workOrders', label: 'work orders' },
];

/** `/Users/me/x/y` -> `~/x/y` when under a home dir. */
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

function ProjectCard({ p, isDefault, isLast }: { p: ProjectSummary; isDefault: boolean; isLast: boolean }) {
  const href = `${projectBase(p.id)}/`;
  return (
    <a
      className="project-card"
      href={href}
      data-testid={`project-${p.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        goTo(href);
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap={8}>
        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className="project-avatar" aria-hidden="true">
            {p.name.slice(0, 1).toUpperCase()}
          </span>
          <Box style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              <Text fw={600} size="md" truncate>
                {p.name}
              </Text>
              {isDefault && p.id !== 'default' && <span className="pill project-pill">default</span>}
              <AccessBadge access={p.access} />
              {isLast && !isDefault && <span className="pill project-pill">recent</span>}
            </Group>
            <Text size="xs" c="var(--app-text-faint)" ff="monospace">
              {p.id}
            </Text>
          </Box>
        </Group>
        <IconArrowRight size={16} className="project-card-arrow" />
      </Group>
      {p.description && (
        <Text size="sm" c="var(--app-text-muted)" mt={10} lineClamp={2} className="project-card-desc">
          {p.description}
        </Text>
      )}
      <div className="project-card-counts">
        {COUNTS.map((c) => (
          <span key={c.key}>
            <b>{p.counts[c.key]}</b> {c.label}
          </span>
        ))}
      </div>
      <div className="project-card-meta">
        {p.github ? (
          <Tooltip label={`Stored in github.com/${repoLabel(p.github)} · local checkout ${p.dataDir}`}>
            <span className="project-meta-item">
              <IconBrandGithub size={13} /> <span className="mono-trunc">{repoLabel(p.github)}</span>
            </span>
          </Tooltip>
        ) : (
          <Tooltip label={p.dataDir}>
            <span className="project-meta-item">
              <IconFolder size={13} /> <span className="mono-trunc">{shortPath(p.dataDir)}</span>
            </span>
          </Tooltip>
        )}
        <span className="project-meta-item">
          <IconGitBranch size={13} /> {p.branch}
          {p.remote ? ' · remote' : ''}
        </span>
      </div>
      {p.github?.status === 'reconnect' && (
        <Tooltip label={`The GitHub grant of ${p.github.connectedBy} no longer works; the project keeps working locally.`}>
          <button
            type="button"
            className="project-reconnect"
            data-testid={`reconnect-${p.id}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.location.assign(githubLoginUrl('/'));
            }}
          >
            <IconBrandGithub size={13} /> Reconnect GitHub
          </button>
        </Tooltip>
      )}
      <div className="project-card-activity">
        {p.lastActivity ? (
          <>
            <Text size="xs" c="var(--app-text-muted)" truncate>
              {p.lastActivity.summary}
            </Text>
            <Text size="xs" c="var(--app-text-faint)" style={{ flexShrink: 0 }}>
              <TimeAgo iso={p.lastActivity.at} />
            </Text>
          </>
        ) : (
          <Text size="xs" c="var(--app-text-faint)">
            No activity yet
          </Text>
        )}
      </div>
    </a>
  );
}

/** Home: pick a project, or create one backed by a GitHub repository ("New project"). */
export function ProjectsPage() {
  const projects = useProjects();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const last = lastProject();
  const [newOpened, newProject] = useDisclosure(false);
  const auth = useAuth();
  const local = isLocalMode(auth);
  // Only admins create projects (server mode: auth.github.allowedUsers).
  const canCreate = auth?.isAdmin !== false;
  useEffect(() => {
    document.title = `Projects · ${APP_NAME}`;
    // Back from a GitHub scope upgrade (`/?new=1`): reopen the New-project flow.
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === '1') {
      if (canCreate) newProject.open();
      history.replaceState(null, '', '/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="projects-page">
      <header className="projects-header">
        <Group gap={10}>
          <Logo size={24} />
          <Text fw={600} size="lg" style={{ letterSpacing: '-0.015em' }}>
            {APP_NAME}
          </Text>
        </Group>
        <Group gap={6}>
        <UserMenu />
        <Tooltip label={scheme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <ActionIcon size="sm" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
            {scheme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          </ActionIcon>
        </Tooltip>
        </Group>
      </header>
      <main className="projects-main">
        <Group justify="space-between" align="flex-end" mb="lg" gap="md">
          <div>
            <Text component="h1" fw={600} size="xl" style={{ letterSpacing: '-0.02em' }}>
              Projects
            </Text>
            <Text size="sm" c="var(--app-text-muted)" mt={4}>
              {local ? 'Each project is a git repository on this computer, with its own index, activity feed and MCP endpoint.' : 'Each project has its own git repository, index, activity feed and MCP endpoint.'}
            </Text>
          </div>
          {canCreate && (
          <Button leftSection={<IconPlus size={15} />} onClick={newProject.open} data-testid="new-project">
            New project
          </Button>
          )}
        </Group>
        {projects.isError && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Cannot list projects">
            {(projects.error as Error).message}
          </Alert>
        )}
        <div className="project-grid">
          {projects.isLoading && [0, 1].map((i) => <Skeleton key={i} height={196} radius="md" />)}
          {projects.data && projects.data.items.length === 0 && (
            <div className="project-empty">
              <Text fw={600}>No projects yet</Text>
              <Text size="sm" c="var(--app-text-muted)" mt={4} mb="md">
                {local ? 'Add a git repository you already have, or start a new one; coding agents then connect to its MCP endpoint.' : 'Create one backed by a GitHub repository; coding agents then connect to its MCP endpoint.'}
              </Text>
              {canCreate ? (
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={newProject.open}>
                  New project
                </Button>
              ) : (
                <Text size="xs" c="var(--app-text-faint)">You see projects whose GitHub repository you can read. Ask an admin to add one.</Text>
              )}
            </div>
          )}
          {projects.data?.items.map((p) => (
            <ProjectCard key={p.id} p={p} isDefault={p.id === projects.data.defaultProject} isLast={p.id === last} />
          ))}
        </div>
      </main>
      {local ? <NewLocalProjectModal opened={newOpened} onClose={newProject.close} /> : <NewProjectModal opened={newOpened} onClose={newProject.close} />}
    </div>
  );
}
