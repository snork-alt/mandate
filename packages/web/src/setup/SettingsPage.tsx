import { Alert, Button, Center, Group, Loader, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft, IconCheck } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { APP_NAME } from '../components/Logo';
import { UiApiError } from '../lib/ui';
import { goTo } from '../project';
import { useSetupState, type SetupState } from './api';
import { AccessSection, AskSection, configChangedMessage, GitSection, GithubSection, SearchSection, ServerInfo, AddressSection, type Saver, type SectionProps } from './sections';
import { SetupShell } from './SetupWizard';
import { AgentFlowSection } from './AgentFlowSection';
import { CodeReposSection } from './CodeReposSection';
import { WritersSection } from './WritersSection';
import { DatabaseSection } from './DatabaseSection';

interface Entry {
  id: string;
  label: string;
  Section: (p: SectionProps) => React.ReactElement;
  /** No Save button (the section acts immediately). */
  instant?: boolean;
}

const sectionsFor = (_s: SetupState): Entry[] => [
  { id: 'github', label: 'GitHub', Section: GithubSection },
  { id: 'access', label: 'Who may sign in', Section: AccessSection },
  { id: 'git', label: 'Git', Section: GitSection },
  { id: 'ask', label: 'Ask models', Section: AskSection },
  { id: 'search', label: 'Semantic search', Section: SearchSection },
  { id: 'flow', label: 'Agent flow', Section: AgentFlowSection, instant: true },
  { id: 'code-repos', label: 'Code repositories', Section: CodeReposSection, instant: true },
  { id: 'writers', label: 'Recent writers', Section: WritersSection, instant: true },
  // Advanced: the server address (proxies, domains) and the server-state backend (SQLite default, Postgres).
  { id: 'address', label: 'Server address (advanced)', Section: AddressSection, instant: true },
  { id: 'database', label: 'Database (advanced)', Section: DatabaseSection },
];

function SettingsCard({ entry, state }: { entry: Entry; state: SetupState }) {
  const qc = useQueryClient();
  const saver = useRef<Saver | null>(null);
  const register = useCallback((fn: Saver | null) => {
    saver.current = fn;
  }, []);
  const [status, setStatus] = useState<{ saving?: boolean; saved?: boolean; error?: string; reload?: boolean }>({});
  const save = async () => {
    setStatus({ saving: true });
    try {
      await saver.current?.();
      setStatus({ saved: true });
    } catch (e) {
      const changed = configChangedMessage(e);
      setStatus({ error: changed ?? (e as Error).message + (e instanceof UiApiError && e.hint ? ` (${e.hint})` : ''), reload: !!changed });
    }
  };
  return (
    <section className="su-settings-card" id={`settings-${entry.id}`} data-testid={`settings-${entry.id}`}>
      <entry.Section state={state} register={register} variant="settings" />
      {!entry.instant && (
        <Group justify="flex-end" gap={8} className="su-settings-actions">
          {status.saved && (
            <Text size="xs" c="teal" className="su-saved">
              <IconCheck size={13} /> Saved
            </Text>
          )}
          {status.error && (
            <Text size="xs" c="red" style={{ flex: 1 }}>
              {status.error}{' '}
              {status.reload && (
                <Button type="button" size="compact-xs" variant="default" onClick={() => void qc.invalidateQueries({ queryKey: ['setup'] }).then(() => setStatus({}))}>
                  Reload
                </Button>
              )}
            </Text>
          )}
          <Button type="button" size="xs" onClick={() => void save()} loading={status.saving}>
            Save
          </Button>
        </Group>
      )}
    </section>
  );
}

/** `/settings`: the setup sections, editable later (admins). */
export function SettingsPage() {
  const auth = useAuth();
  const state = useSetupState();
  useEffect(() => {
    document.title = `Settings · ${APP_NAME}`;
  }, []);
  const back = (
    <Button type="button" variant="subtle" color="gray" size="xs" leftSection={<IconArrowLeft size={14} />} onClick={() => goTo('/')} mb="md">
      Projects
    </Button>
  );
  if (auth && auth.isAdmin === false)
    return (
      <SetupShell wide label="Settings">
        {back}
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Admins only">
          Settings change how this Mandate server runs. Ask an admin of this server.
        </Alert>
      </SetupShell>
    );
  if (state.isLoading)
    return (
      <SetupShell wide label="Settings">
        <Center h={300}>
          <Loader size="sm" />
        </Center>
      </SetupShell>
    );
  if (!state.data)
    return (
      <SetupShell wide label="Settings">
        {back}
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Cannot load the settings">
          {(state.error as Error)?.message}
        </Alert>
      </SetupShell>
    );
  const entries = sectionsFor(state.data);
  return (
    <SetupShell wide label="Settings">
      {back}
      <div className="su-settings" data-testid="settings-page">
        <nav className="su-settings-nav">
          <Text fw={600} size="lg" mb={8} style={{ letterSpacing: '-0.015em' }}>
            Settings
          </Text>
          {entries.map((e) => (
            <a key={e.id} href={`#settings-${e.id}`} className="su-settings-link">
              {e.label}
            </a>
          ))}
          <div className="su-settings-info">
            <ServerInfo state={state.data} />
          </div>
        </nav>
        <div className="su-settings-body">
          {entries.map((e) => (
            <SettingsCard key={e.id} entry={e} state={state.data!} />
          ))}
        </div>
      </div>
    </SetupShell>
  );
}
