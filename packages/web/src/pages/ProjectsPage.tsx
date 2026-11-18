import { EmptyView } from '../components/ListStates';
import { ActionIcon, Alert, Box, Button, Group, Skeleton, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowRight, IconBrandGithub, IconClock, IconCode, IconFolder, IconGitBranch, IconMoon, IconPlus, IconStar, IconSun } from '@tabler/icons-react';
import { NewProjectModal } from '../connect/NewProjectModal';
import { clearDraft, isResumeSearch } from '../connect/newProjectDraft';
import { AccessBadge } from '../connect/AccessBadge';
import { UserMenu } from '../connect/UserFooter';
import { repoLabel } from '../connect/github';
import { githubLoginUrl, useAuth } from '../auth';
import { useEffect, useState } from 'react';
import { APP_NAME, Logo } from '../components/Logo';
import { TimeAgo } from '../components/TimeAgo';
import { useProjects, type ProjectSummary } from '../connect/projects';
import { goTo, lastProject, projectBase } from '../project';
import { AgentMark } from '../connect/AgentMark';
import { ALL_AGENT_DEFS } from '../connect/agentCatalog';
import { stripActor } from '../lib/activity';

const COUNTS: { key: 'specs' | 'standards' | 'components' | 'workOrders'; label: string }[] = [
  { key: 'specs', label: 'specs' },
  { key: 'standards', label: 'standards' },
  { key: 'components', label: 'components' },
  { key: 'workOrders', label: 'work orders' },
];

/** `/Users/me/x/y` -> `~/x/y` when under a home dir. */
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

/** A stable colour per project (band and avatar). */
const TONES = ['lilac', 'indigo', 'teal', 'amber', 'rose', 'slate'] as const;
export const projectTone = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
};

/** "claude-code@mbp" → the Claude Code mark and label (null for people and unknown clients). */
function agentOf(agent: string | undefined): { id: string; label: string } | null {
  const id = agent?.split('@')[0]?.toLowerCase();
  const a = id ? ALL_AGENT_DEFS.find((x) => x.id === id) : undefined;
  return a ? { id: a.id, label: a.label } : null;
}

const stop = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

function ProjectCard({ p, isDefault, isLast, canAddRepos }: { p: ProjectSummary; isDefault: boolean; isLast: boolean; canAddRepos: boolean }) {
  const href = `${projectBase(p.id)}/`;
  const active = p.counts?.activeWorkOrders;
  const repos = p.codeRepos;
  const actions = p.openActions ?? 0;
  const reconnect = p.github?.status === 'reconnect';
  const actor = agentOf(p.lastActivity?.agent);
  return (
    <a
      className="project-card"
      href={href}
      data-testid={`project-${p.id}`}
      data-tone={projectTone(p.id)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        goTo(href);
      }}
    >
      <span className="project-card-band" aria-hidden="true" />
      <div className="project-card-head">
        <span className="project-avatar project-avatar-lg" aria-hidden="true">
          {p.name.slice(0, 1).toUpperCase()}
        </span>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text fw={600} size="md" truncate className="project-card-name">
              {p.name}
            </Text>
            {isDefault && p.id !== 'default' && (
              <span className="pill project-pill">
                <IconStar size={10} /> default
              </span>
            )}
            {isLast && !isDefault && (
              <span className="pill project-pill">
                <IconClock size={10} /> recent
              </span>
            )}
          </Group>
          <Group gap={6} wrap="nowrap" mt={3}>
            <Text size="xs" c="var(--app-text-faint)" ff="monospace" truncate>
              {p.id}
            </Text>
            <AccessBadge access={p.access} />
          </Group>
        </Box>
        <span className="project-card-arrow" aria-hidden="true">
          <IconArrowRight size={15} />
        </span>
      </div>
      <Text size="sm" c="var(--app-text-muted)" lineClamp={2} className="project-card-desc">
        {p.description ?? ''}
      </Text>
      {p.counts ? (
        <div className="project-card-stats" data-testid={`stats-${p.id}`}>
          {COUNTS.map((c) => (
            <div key={c.key} className="project-card-stat">
              <b data-zero={!p.counts[c.key] || undefined}>{p.counts[c.key]}</b>
              <span>{c.label}</span>
              {c.key === 'workOrders' && active !== undefined && (
                <span className="project-card-stat-sub" data-none={!active || undefined} data-testid={`active-${p.id}`}>
                  {active ? `${active} active` : 'none active'}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Text size="xs" c="var(--app-text-faint)" className="project-card-unavailable">
          Counts unavailable: the project could not be opened.
        </Text>
      )}
      <div className="project-card-meta">
        {p.github ? (
          <Tooltip label={`Stored in github.com/${repoLabel(p.github)} · local checkout ${p.dataDir}`}>
            <span className="project-meta-item">
              <IconBrandGithub size={14} className="project-meta-ico" /> <span className="mono-trunc project-meta-strong">{repoLabel(p.github)}</span>
              <span className="mono-trunc project-meta-at">@{p.branch}</span>
              {p.remote ? <span className="project-meta-at">· remote</span> : null}
            </span>
          </Tooltip>
        ) : (
          <Tooltip label={p.dataDir}>
            <span className="project-meta-item">
              <IconFolder size={14} className="project-meta-ico" /> <span className="mono-trunc project-meta-strong">{shortPath(p.dataDir)}</span>
              <span className="mono-trunc project-meta-at">
                <IconGitBranch size={12} /> {p.branch}
              </span>
              {p.remote ? <span className="project-meta-at">· remote</span> : null}
            </span>
          </Tooltip>
        )}
        {repos && repos.length > 0 && (
          <span className="project-meta-item" data-testid={`code-repos-${p.id}`}>
            <IconCode size={14} className="project-meta-ico" />
            <span className="mono-trunc project-meta-strong">{repos.join(', ')}</span>
            <span className="project-meta-at">
              · {repos.length} code repo{repos.length === 1 ? '' : 's'}
            </span>
          </span>
        )}
      </div>
      {(reconnect || actions > 0) && (
        <div className="project-card-tags">
          {reconnect && (
            <Tooltip label={`The GitHub grant of ${p.github!.connectedBy} no longer works; the project keeps working locally.`}>
              <button
                type="button"
                className="project-reconnect"
                data-testid={`reconnect-${p.id}`}
                onClick={(e) => {
                  stop(e);
                  window.location.assign(githubLoginUrl('/'));
                }}
              >
                <IconBrandGithub size={13} /> Reconnect GitHub
              </button>
            </Tooltip>
          )}
          {actions > 0 && (
            <button
              type="button"
              className="project-actions-chip"
              data-testid={`actions-${p.id}`}
              onClick={(e) => {
                stop(e);
                goTo(`${projectBase(p.id)}/waiting`);
              }}
            >
              <IconAlertTriangle size={12} /> {actions} open action{actions === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
      <div className="project-card-activity">
        {p.lastActivity ? (
          <>
            {actor && <AgentMark agent={actor.id} size={14} />}
            <Text size="xs" c="var(--app-text-muted)" truncate style={{ flex: 1, minWidth: 0 }}>
              {actor ? (
                <>
                  <b className="project-activity-who">{actor.label}</b> {stripActor(p.lastActivity.summary, { agent: p.lastActivity.agent })}
                </>
              ) : (
                p.lastActivity.summary
              )}
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
  const [resume, setResume] = useState<string | null | undefined>(undefined);
  const auth = useAuth();
  // Only admins create projects (auth.github.allowedUsers).
  const canCreate = auth?.isAdmin !== false;
  useEffect(() => {
    document.title = `Projects · ${APP_NAME}`;
    // Back from GitHub (scope upgrade `/?new=1&resume=<nonce>`, App install `/?github=installed`): reopen the
    // New-project flow with the form the user had filled in.
    const back = isResumeSearch(window.location.search);
    if (back.resume) {
      if (canCreate) {
        setResume(back.nonce);
        newProject.open();
      }
      history.replaceState(null, '', '/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="projects-page">
      <header className="projects-header">
        <Group gap={10}>
          <Logo size={30} />
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
              Each project is a GitHub repository (or a folder in one), with its own index, activity feed and MCP endpoint.
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
          {projects.data?.items.map((p) => (
            <ProjectCard key={p.id} p={p} isDefault={p.id === projects.data.defaultProject} isLast={p.id === last} canAddRepos={canCreate} />
          ))}
        </div>
        {projects.data && projects.data.items.length === 0 && (
          <EmptyView
            icon={<IconFolder size={22} stroke={1.5} />}
            title="No projects yet"
            description={canCreate ? 'Create one backed by a GitHub repository; coding agents then connect to its MCP endpoint.' : 'You see projects whose GitHub repository you can read. Ask an admin to add one.'}
            action={canCreate ? (
              <Button size="xs" mt="xs" leftSection={<IconPlus size={14} />} onClick={newProject.open}>
                New project
              </Button>
            ) : undefined}
          />
        )}
      </main>
      <NewProjectModal
        opened={newOpened}
        resume={resume}
        onClose={() => {
          clearDraft();
          setResume(undefined);
          newProject.close();
        }}
      />
    </div>
  );
}
