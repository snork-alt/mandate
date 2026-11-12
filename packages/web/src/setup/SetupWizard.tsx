import { ActionIcon, Alert, Button, Center, Group, Loader, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconBrandGithub, IconCheck, IconCircleDashed, IconMoon, IconPlus, IconSun, IconTerminal2 } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cli, type AuthStatus } from '../auth';
import { APP_NAME, Logo } from '../components/Logo';
import { StepBar } from '../connect/parts';
import { UiApiError } from '../lib/ui';
import { goTo } from '../project';
import { setupApi, tildify, useSetupState, type SetupState } from './api';
import { AskSection, configChangedMessage, restartNeeded, RESTART_EVENT, GitSection, GithubSection, ModeSection, ProjectsFolderSection, SearchSection, type Saver, type SectionProps } from './sections';
import { CommandLine, StepIntro } from './widgets';
import { DatabaseSection } from './DatabaseSection';

interface WizardStep {
  id: string;
  label: string;
  optional?: boolean;
  Section: (p: SectionProps) => React.ReactElement;
}

const LOCAL_STEPS: WizardStep[] = [
  { id: 'welcome', label: 'Welcome', Section: ModeSection },
  { id: 'folder', label: 'Projects folder', Section: ProjectsFolderSection },
  { id: 'git', label: 'Git', Section: GitSection, optional: true },
  { id: 'ask', label: 'Ask model', Section: AskSection, optional: true },
  { id: 'search', label: 'Search', Section: SearchSection, optional: true },
];
const SERVER_STEPS: WizardStep[] = [
  { id: 'welcome', label: 'Welcome', Section: ModeSection },
  { id: 'github', label: 'GitHub sign-in', Section: GithubSection },
  { id: 'ask', label: 'Ask model', Section: AskSection, optional: true },
  { id: 'search', label: 'Search', Section: SearchSection, optional: true },
  // Advanced, optional: SQLite needs nothing; Postgres for several server instances.
  { id: 'database', label: 'Database', Section: DatabaseSection, optional: true },
];

export const wizardSteps = (mode: 'local' | 'server') => (mode === 'local' ? LOCAL_STEPS : SERVER_STEPS);

function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  return (
    <Tooltip label={scheme === 'dark' ? 'Light theme' : 'Dark theme'}>
      <ActionIcon type="button" size="sm" variant="subtle" color="gray" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
        {scheme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
      </ActionIcon>
    </Tooltip>
  );
}

export function SetupShell({ children, wide, label = 'Setup' }: { children: React.ReactNode; wide?: boolean; label?: string }) {
  return (
    <div className="su-page">
      <header className="su-top">
        <Group gap={10}>
          <Logo size={24} />
          <Text fw={600} size="md" style={{ letterSpacing: '-0.015em' }}>
            {APP_NAME}
          </Text>
          <span className="su-top-sep">/</span>
          <Text size="sm" c="var(--app-text-muted)">
            {label}
          </Text>
        </Group>
        <ThemeToggle />
      </header>
      <main className={`su-main${wide ? ' su-main-wide' : ''}`}>
        <RestartBanner />
        {children}
      </main>
    </div>
  );
}

/** "Restart to apply" after a saved change that needs it (embedding provider, git backend). */
function RestartBanner() {
  const [on, setOn] = useState(restartNeeded.value);
  useEffect(() => {
    const f = () => setOn(restartNeeded.value);
    window.addEventListener(RESTART_EVENT, f);
    return () => window.removeEventListener(RESTART_EVENT, f);
  }, []);
  if (!on) return null;
  return (
    <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Restart Mandate to apply" data-testid="restart-banner">
      Some saved changes take effect after a restart: <code>{cli('restart').npx}</code> (in a development checkout, restart <code>npm run dev</code>).
    </Alert>
  );
}

/** Finish: summary checklist, mark setup complete, then the next action. */
function FinishStep({ state, status, onBack }: { state: SetupState; status: AuthStatus; onBack: () => void }) {
  const c = state.config;
  const local = c.server.mode === 'local';
  const complete = useMutation({ mutationFn: setupApi.complete });
  const done = complete.data ?? (state.complete ? { next: local ? ('local' as const) : ('github' as const) } : null);
  const items: { ok: boolean; label: string; detail: string; optional?: boolean }[] = local
    ? [
        { ok: true, label: 'Runs on this computer', detail: 'Sign in with a one-time link from the terminal.' },
        { ok: !!c.local.baseDir, label: 'Projects folder', detail: tildify(c.local.baseDir, null) },
        { ok: !!c.git.system.version || c.git.backend === 'embedded', label: 'Git', detail: c.git.backend === 'cli' ? `System git ${c.git.system.version ?? '(not found)'}` : 'Embedded git' },
      ]
    : [
        { ok: !!c.server.publicUrl, label: 'Public URL', detail: c.server.publicUrl ?? 'not set' },
        { ok: !!c.github?.clientId && !!c.github.clientSecretSet && (!!status.repoAuth || c.github.allowedUsers.length + c.github.allowedOrgs.length > 0), label: 'GitHub sign-in', detail: c.github?.clientId ? (status.repoAuth ? `access from GitHub repo permissions; admins: ${c.github.allowedUsers.join(', ') || 'none yet'}` : `${[...(c.github.allowedUsers ?? []), ...(c.github.allowedOrgs ?? [])].join(', ') || 'no one allowed yet'}`) : 'not configured' },
      ];
  items.push(
    { ok: c.ask.models.length > 0, label: 'Ask model', detail: c.ask.models.length ? c.ask.models.map((m) => m.model).join(', ') : 'skipped (add later in Settings)', optional: true },
    { ok: c.embedding.provider !== 'none', label: 'Semantic search', detail: c.embedding.provider !== 'none' ? `${c.embedding.model} via ${c.embedding.remote ? new URL(c.embedding.baseUrl).host : /:11434(\/|$)/.test(c.embedding.baseUrl) ? 'Ollama' : c.embedding.baseUrl}` : 'keyword search only', optional: true },
  );
  const blocking = items.filter((i) => !i.ok && !i.optional);
  return (
    <div className="su-section">
      <StepIntro title={done ? 'Mandate is ready' : 'Review and finish'}>
        {done ? 'Setup is complete. Next, create your first project, then connect your coding agent to it.' : 'Everything below can be changed later in Settings.'}
      </StepIntro>
      <ul className="su-summary" data-testid="setup-summary">
        {items.map((i) => (
          <li key={i.label} data-ok={i.ok || undefined} data-optional={(!i.ok && i.optional) || undefined}>
            <span className="su-check-icon">{i.ok ? <IconCheck size={12} stroke={2.6} /> : i.optional ? <IconCircleDashed size={13} /> : <IconAlertTriangle size={12} />}</span>
            <span className="su-check-label">{i.label}</span>
            <span className="su-check-detail">{i.detail}</span>
          </li>
        ))}
      </ul>
      {complete.isError && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {(complete.error as Error).message}
        </Alert>
      )}
      {!done ? (
        <Group justify="space-between">
          <Button type="button" variant="subtle" color="gray" onClick={onBack}>
            Back
          </Button>
          <Button type="button" onClick={() => complete.mutate()} loading={complete.isPending} disabled={blocking.length > 0} data-testid="setup-complete">
            Finish setup
          </Button>
        </Group>
      ) : done.next === 'github' ? (
        <div className="su-next-card">
          <Text fw={600} size="sm">
            Sign in with GitHub
          </Text>
          <Text size="sm" className="np-muted">
            Use an account on the allow-list. After signing in, create your first project from one of your repositories.
          </Text>
          <Button type="button" mt="sm" leftSection={<IconBrandGithub size={15} />} onClick={() => window.location.assign('/auth/github/login?returnTo=%2F%3Fnew%3D1')} data-testid="setup-signin">
            Sign in with GitHub
          </Button>
        </div>
      ) : status.authenticated || complete.isSuccess ? (
        <div className="su-next-card">
          <Text fw={600} size="sm">
            Create your first project
          </Text>
          <Text size="sm" className="np-muted">
            Add a repository you already have, or start a new one in {tildify(c.local.baseDir, null)}.
          </Text>
          <Button type="button" mt="sm" leftSection={<IconPlus size={15} />} onClick={() => window.location.assign('/?new=1')} data-testid="setup-first-project">
            Create your first project
          </Button>
        </div>
      ) : (
        <div className="su-next-card">
          <Group gap={8}>
            <IconTerminal2 size={16} />
            <Text fw={600} size="sm">
              Open Mandate
            </Text>
          </Group>
          <Text size="sm" className="np-muted" mb={8}>
            Run this in a terminal on this computer; it opens Mandate signed in, ready to create your first project.
          </Text>
          <CommandLine cmd={cli('open').npx} />
          <Text size="xs" className="np-faint" mt={6}>
            In a development checkout: <code>{cli('open').dev}</code>
          </Text>
        </div>
      )}
    </div>
  );
}

/** `/setup`: the guided first-run wizard (setup cookie or an admin session). */
export function SetupWizard({ status }: { status: AuthStatus }) {
  const state = useSetupState();
  const qc = useQueryClient();
  const [stepIdx, setStepIdx] = useState(0);
  const [visited, setVisited] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; reload?: boolean } | null>(null);
  const saver = useRef<Saver | null>(null);
  const register = useCallback((fn: Saver | null) => {
    saver.current = fn;
  }, []);
  const tokenError = new URLSearchParams(window.location.search).get('error');
  useEffect(() => {
    document.title = `Setup · ${APP_NAME}`;
  }, []);

  if (state.isLoading) return <SetupShell>{<Center h={300}><Loader size="sm" /></Center>}</SetupShell>;
  if (state.isError || !state.data)
    return (
      <SetupShell>
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Cannot load the setup">
          {(state.error as Error)?.message}
        </Alert>
      </SetupShell>
    );
  const st = state.data;
  const steps = wizardSteps(st.config.server.mode);
  const labels = [...steps.map((s) => s.label), 'Finish'];
  const onFinish = stepIdx >= steps.length;
  const step = steps[Math.min(stepIdx, steps.length - 1)]!;

  const go = (i: number) => {
    setError(null);
    setStepIdx(i);
    setVisited((v) => Math.max(v, i));
    window.scrollTo({ top: 0 });
  };
  const next = async (skip = false) => {
    setError(null);
    if (!skip && saver.current) {
      setSaving(true);
      try {
        await saver.current();
      } catch (e) {
        setSaving(false);
        const changed = configChangedMessage(e);
        setError({ message: changed ?? (e as Error).message + (e instanceof UiApiError && e.hint ? ` (${e.hint})` : ''), reload: !!changed });
        return;
      }
      setSaving(false);
    }
    go(stepIdx + 1);
  };

  return (
    <SetupShell>
      {tokenError === 'invalid_token' && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} mb="md">
          That setup link is invalid or expired. Run <code>{cli('setup-url').npx}</code> again.
        </Alert>
      )}
      <div className="su-card-main" data-testid="setup-wizard">
        <StepBar steps={labels} step={stepIdx} onStep={(i) => i <= visited && !saving && go(i)} />
        <div className="su-body" key={onFinish ? 'finish' : step.id}>
          {onFinish ? <FinishStep state={st} status={status} onBack={() => go(steps.length - 1)} /> : <step.Section state={st} register={register} variant="wizard" />}
        </div>
        {error && (
          <div className="su-error" data-testid="setup-error">
            <IconAlertTriangle size={15} />
            <span>{error.message}</span>
            {error.reload && (
              <Button type="button" size="compact-xs" variant="default" onClick={() => void qc.invalidateQueries({ queryKey: ['setup'] }).then(() => setError(null))}>
                Reload
              </Button>
            )}
          </div>
        )}
        {!onFinish && (
          <footer className="np-foot su-foot">
            <span className="np-muted np-foot-count">
              Step {stepIdx + 1} of {labels.length}
            </span>
            {stepIdx > 0 && (
              <Button type="button" variant="subtle" color="gray" onClick={() => go(stepIdx - 1)} disabled={saving}>
                Back
              </Button>
            )}
            {step.optional && (
              <Button type="button" variant="subtle" color="gray" onClick={() => void next(true)} disabled={saving} data-testid="setup-skip">
                Skip
              </Button>
            )}
            <Button type="button" onClick={() => void next()} loading={saving} rightSection={<IconArrowRight size={15} />} data-testid="setup-continue">
              Continue
            </Button>
          </footer>
        )}
      </div>
    </SetupShell>
  );
}

/** Setup mode without the setup cookie: only the CLI can hand out the setup link. */
export function FinishSetupPage({ status }: { status: AuthStatus }) {
  const err = new URLSearchParams(window.location.search).get('error');
  const server = status.mode === 'server';
  return (
    <SetupShell>
      <div className="su-card-main su-pad" data-testid="finish-setup">
        <StepIntro title="Finish setting up Mandate">
          Setup is not finished yet. For safety, the setup page opens only from a link printed by the command line on the machine running Mandate.
        </StepIntro>
        {err === 'invalid_token' && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            That setup link is invalid or has expired. Run the command again for a new one.
          </Alert>
        )}
        <div className="np-stack" style={{ gap: 6 }}>
          <Text size="sm" fw={500}>
            Run on {server ? 'the server' : 'this computer'}:
          </Text>
          <CommandLine cmd={cli('setup-url').npx} />
          <Text size="xs" className="np-faint">
            In a development checkout: <code>{cli('setup-url').dev}</code>
          </Text>
        </div>
        <Text size="sm" className="np-muted">
          It prints a one-time link; open it in this browser.{server ? ' On a remote server, open it through an SSH tunnel until HTTPS works: ssh -L 4000:localhost:4000 you@server.' : ''}
        </Text>
      </div>
    </SetupShell>
  );
}
