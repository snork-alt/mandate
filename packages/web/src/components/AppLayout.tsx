import { ActionIcon, AppShell, Box, Burger, Group, ScrollArea, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useEffect } from 'react';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { installCopyHotkeys } from './copy';
import { IconGitMerge, IconLayoutDashboard, IconMessageQuestion, IconMoon, IconPlugConnected, IconSearch, IconSun } from '@tabler/icons-react';
import { NavLink, Outlet } from 'react-router';
import { useEntityList } from '../lib/queries';
import { SECTIONS, type SectionDef } from '../sections';
import { CommandPalette, openCommandPalette } from './CommandPalette';
import { GitStatusControl } from './GitStatusControl';
import { SearchField } from './SearchField';
import { AskProvider } from './ask/AskProvider';
import { Rail } from './rail/Rail';
import { RailProvider } from './rail/RailProvider';
import { useLiveQueries } from '../lib/liveQueries';
import { APP_NAME, Logo } from './Logo';
import { getCurrentProject } from '../project';
import { ProjectSwitcher } from '../connect/ProjectSwitcher';
import { FlowBadge } from './FlowBadge';
import { AccessBadge } from '../connect/AccessBadge';
import { useProjects } from '../connect/projects';
import { ConnectAgentModal, registerConnectAgentOpener } from '../connect/ConnectAgentModal';
import { UserFooter } from '../connect/UserFooter';
import { useWaitingCounts } from '../lib/waiting';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function NavItem({ section, onClick }: { section: SectionDef; onClick: () => void }) {
  const { kind, label, icon: Icon } = section;
  const list = useEntityList(kind);
  return (
    <NavLink to={`/${kind}`} onClick={onClick} className="nav-item">
      <Icon size={16} stroke={1.7} className="nav-icon" />
      <span>{label}</span>
      <span className="nav-count">{list.data ? (section.count ? section.count(list.data) : list.data.length) : ''}</span>
    </NavLink>
  );
}

/** What only the user can do (questions, approvals, plans to approve, comments to them), on the "Waiting for you" item; project health is not counted. */
function WaitingCount() {
  const c = useWaitingCounts();
  const n = c.total;
  if (!n) return <span className="nav-count" />;
  return (
    <Tooltip label={`${n} thing${n === 1 ? '' : 's'} only you can do (questions, approvals, plans, comments)`} openDelay={300} withinPortal>
      <span className="nav-count nav-count-alert" data-testid="nav-waiting" aria-label={`${n} item${n === 1 ? '' : 's'} waiting for you`}>
        {n}
      </span>
    </Tooltip>
  );
}

/** App shell with the right rail (Details / Activity / Ask) available on every page. */
export function AppLayout() {
  useLiveQueries();
  return (
    <RailProvider>
      <AskProvider>
        <AppLayoutShell />
      </AskProvider>
    </RailProvider>
  );
}

function AppLayoutShell() {
  const [opened, { toggle, close }] = useDisclosure();
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme('light');
  const toggleColorScheme = () => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
  const isMobile = useMediaQuery('(max-width: 48em)');
  const projectId = getCurrentProject() ?? '';
  const [connectOpened, connect] = useDisclosure();
  useEffect(() => installCopyHotkeys(), []);
  useEffect(() => registerConnectAgentOpener(connect.open), [connect.open]);

  return (
    <AppShell
      header={{ height: 48, collapsed: !isMobile }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header className="app-mobile-header" hiddenFrom="sm">
        <Group h="100%" px="md" gap="sm" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} size="sm" aria-label="Toggle navigation" />
          <Logo size={28} />
          <Text fw={600} size="md" style={{ letterSpacing: '-0.015em' }}>
            {APP_NAME}
          </Text>
          <ActionIcon ml="auto" onClick={() => openCommandPalette()} aria-label="Search">
            <IconSearch size={16} />
          </ActionIcon>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="app-navbar" p={10}>
        <AppShell.Section>
          <Group gap={4} h={40} wrap="nowrap">
            <ProjectSwitcher projectId={projectId} />
            <Tooltip label={colorScheme === 'dark' ? 'Light theme' : 'Dark theme'}>
              <ActionIcon size="sm" onClick={toggleColorScheme} aria-label="Toggle color scheme">
                {colorScheme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
              </ActionIcon>
            </Tooltip>
          </Group>
          <ProjectBadges projectId={projectId} />
          <Box mt={6}>
            <SearchField variant="button" label="Search" keys={[isMac ? '⌘' : 'Ctrl', 'K']} onClick={() => openCommandPalette()} />
          </Box>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt={4}>
          <div className="section-label">Workspace</div>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <NavLink to="/" end onClick={close} className="nav-item" data-testid="nav-overview">
              <IconLayoutDashboard size={16} stroke={1.7} className="nav-icon" />
              <span>Overview</span>
              <span className="nav-count" />
            </NavLink>
            {SECTIONS.map((section) => (
              <NavItem key={section.kind} section={section} onClick={close} />
            ))}
            <NavLink to="/waiting" onClick={close} className="nav-item" data-testid="nav-waiting-item">
              <IconMessageQuestion size={16} stroke={1.7} className="nav-icon" />
              <span>Waiting for you</span>
              <WaitingCount />
            </NavLink>
            <NavLink to="/lineage" onClick={close} className="nav-item" data-testid="nav-lineage">
              <IconGitMerge size={16} stroke={1.7} className="nav-icon" />
              <span>Lineage</span>
              <span className="nav-count" />
            </NavLink>
          </Box>
        </AppShell.Section>

        <AppShell.Section>
          <UnstyledButton className="nav-item connect-agent-button" onClick={connect.open} data-testid="connect-agent">
            <IconPlugConnected size={16} stroke={1.7} className="nav-icon" />
            <span>Connect agent</span>
          </UnstyledButton>
          <GitStatusControl onNavigate={close} />
          <UserFooter />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className="rail-main">
        <Outlet />
      </AppShell.Main>
      <Rail />
      <CommandPalette />
      <ConnectAgentModal projectId={projectId} opened={connectOpened} onClose={connect.close} />
    </AppShell>
  );
}

/** Second header row: what the user may do in this project and whether agents follow the Mandate flow. */
function ProjectBadges({ projectId }: { projectId: string }) {
  const access = useProjects().data?.items.find((p) => p.id === projectId)?.access;
  return (
    <Group gap={6} wrap="wrap" px={6} mt={2} className="project-badges">
      {access && <AccessBadge access={access} />}
      <FlowBadge projectId={projectId} />
    </Group>
  );
}
