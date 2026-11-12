import { ActionIcon, AppShell, Box, Burger, Group, ScrollArea, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useEffect } from 'react';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { installCopyHotkeys } from './copy';
import { IconMoon, IconPlugConnected, IconSearch, IconSun } from '@tabler/icons-react';
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
import { ConnectAgentModal } from '../connect/ConnectAgentModal';
import { UserFooter } from '../connect/UserFooter';

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

  return (
    <AppShell
      header={{ height: 48, collapsed: !isMobile }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header className="app-mobile-header" hiddenFrom="sm">
        <Group h="100%" px="md" gap="sm" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} size="sm" aria-label="Toggle navigation" />
          <Logo size={22} />
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
          <Box mt={6}>
            <SearchField variant="button" label="Search" keys={[isMac ? '⌘' : 'Ctrl', 'K']} onClick={() => openCommandPalette()} />
          </Box>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt={4}>
          <div className="section-label">Workspace</div>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {SECTIONS.map((section) => (
              <NavItem key={section.kind} section={section} onClick={close} />
            ))}
          </Box>
        </AppShell.Section>

        <AppShell.Section>
          <UnstyledButton className="nav-item connect-agent-button" onClick={connect.open} data-testid="connect-agent">
            <IconPlugConnected size={16} stroke={1.7} className="nav-icon" />
            <span>Connect agent</span>
          </UnstyledButton>
          <GitStatusControl />
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
