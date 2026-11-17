import { ActionIcon, Alert, Button, Center, Group, Loader, Text, TextInput, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { IconAlertTriangle, IconBrandGithubFilled, IconBuilding, IconCheck, IconCrown, IconExternalLink, IconMinus, IconMoon, IconShieldCheck, IconSun, IconUser } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { cli, type AuthStatus } from '../auth';
import { APP_NAME, Logo } from '../components/Logo';
import { UiApiError } from '../lib/ui';
import { APPLIED_EVENT, serverStartedAt, setupApi, useSetupState, waitForRestart, type AppliedSetting, type SetupState } from './api';
import { GITHUB_RESULT, OAuthAppFields, submitManifest, usePatchConfig } from './sections';
import { CommandLine, StepIntro } from './widgets';
import { SearchStep } from './WizardSearch';
import { DatabaseStep, GitStep } from './WizardSteps';
import { Chip, ContinueButton, Field, StepHead, WizardFooter, WzTabs } from './wizardKit';
import './wizard.css';

/**
 * The first-run wizard: a split card with the step rail on the left (a segmented bar on phones) and one task per step:
 * GitHub App → Git → Semantic search → Database → Sign in (the last three before it are optional, "Skip
 * for now"). The address it is opened on becomes the public URL (saved with the GitHub App). Whoever finishes here and
 * signs in becomes the first admin (a single-use claim; the login comes from GitHub). Everything is also in Settings.
 */

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
        <AppliedBanner />
        {children}
      </main>
    </div>
  );
}

const APPLIED_TEXT: Record<AppliedSetting, string> = { git: 'Git backend switched', database: 'Database switched' };

/** "Applied ✓" after a save the server applied live (git backend, database); fades after a few seconds. */
export function AppliedBanner() {
  const [applied, setApplied] = useState<AppliedSetting[] | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const f = (e: Event) => {
      setApplied((e as CustomEvent<AppliedSetting[]>).detail);
      clearTimeout(t);
      t = setTimeout(() => setApplied(null), 8000);
    };
    window.addEventListener(APPLIED_EVENT, f);
    return () => {
      clearTimeout(t);
      window.removeEventListener(APPLIED_EVENT, f);
    };
  }, []);
  if (!applied) return null;
  return (
    <Alert color="teal" variant="light" icon={<IconCheck size={16} />} mb="md" title="Applied ✓" data-testid="applied-banner">
      {applied.map((a) => APPLIED_TEXT[a]).join('; ')}. No restart needed.
    </Alert>
  );
}


/* ------------------------------------------------------------------ the wizard */

export const WIZARD_STEPS = [
  { id: 'github', label: 'GitHub App', optional: false, todo: 'Required' },
  { id: 'git', label: 'Git', optional: false, todo: 'Required' },
  { id: 'search', label: 'Semantic search', optional: true, todo: 'Optional' },
  { id: 'database', label: 'Database', optional: true, todo: 'Optional' },
  { id: 'ready', label: 'Sign in', optional: false, todo: 'Become the admin' },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];
export const wizardSteps = () => WIZARD_STEPS;

const githubReady = (st: SetupState) => {
  const g = st.config.github;
  return (g?.kind === 'app' && !!g.app) || (g?.kind === 'oauth' && !!g.clientSecretSet);
};

/** One line per step for the rail and the summary (null: nothing set up). */
export function stepSummary(id: WizardStepId, st: SetupState): string | null {
  const c = st.config;
  switch (id) {
    case 'github':
      return c.github?.app ? `${c.github.app.slug}${c.github.app.owner ? ` · ${c.github.app.owner}` : ''}` : c.github?.kind === 'oauth' && c.github.clientSecretSet ? `OAuth App ${c.github.clientId ?? ''}`.trim() : null;
    case 'git':
      return c.git.backend === 'cli' ? `System git${c.git.system.version ? ` ${c.git.system.version}` : ''}` : 'Built-in git';
    case 'search':
      return c.embedding.provider !== 'none' ? c.embedding.model : null;
    case 'database':
      return c.database?.driver === 'postgres' ? 'Postgres' : 'SQLite (built in)';
    default:
      return null;
  }
}

/** The step rail: done (tick + summary), current (raised), skipped (dash), progress bar. */
export function WizardRail({ step, onStep, skipped, st }: { step: number; onStep: (i: number) => void; skipped: Set<number>; st: SetupState | undefined }) {
  return (
    <aside className="wz-rail">
      <div className="wz-brand">
        <Logo size={28} />
        <div>
          <b>{APP_NAME}</b>
          <span>Setup</span>
        </div>
      </div>
      <div className="wz-rail-cap">Steps</div>
      <ol className="wz-steps" aria-label="Setup steps">
        {WIZARD_STEPS.map((s, i) => {
          const isSkipped = i < step && skipped.has(i);
          const state = i === step ? 'current' : isSkipped ? 'skipped' : i < step ? 'done' : 'todo';
          const summary = st ? stepSummary(s.id, st) : null;
          const meta = state === 'skipped' ? 'Skipped' : state === 'done' ? (summary ?? 'Done') : i === 0 && st && githubReady(st) ? summary : s.todo;
          return (
            <li key={s.id} className="wz-step" data-state={state} data-done={state === 'done' || state === 'skipped' || undefined}>
              <UnstyledButton className="wz-step-btn" onClick={() => i < step && onStep(i)} disabled={i >= step} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="wz-dot">{state === 'done' ? <IconCheck size={12} stroke={3} /> : state === 'skipped' ? <IconMinus size={12} stroke={3} /> : i + 1}</span>
                <span className="wz-step-text">
                  <span className="wz-step-label">{s.label}</span>
                  <span className="wz-step-meta">{meta}</span>
                </span>
              </UnstyledButton>
            </li>
          );
        })}
      </ol>
      <div className="wz-rail-foot">
        <div className="wz-prog">
          <span>Progress</span>
          <b data-testid="wz-progress">
            {step} of {WIZARD_STEPS.length}
          </b>
        </div>
        <div className="wz-bar">
          <i style={{ width: `${Math.round((step / WIZARD_STEPS.length) * 100)}%` }} />
        </div>
        <div className="wz-rail-note">You can change all of this later in Settings.</div>
      </div>
    </aside>
  );
}

/** Phones: logo, "Step n of 5" and a segmented progress bar instead of the rail. */
function PhoneTop({ step }: { step: number }) {
  return (
    <div className="wz-ph-top">
      <div className="wz-ph-row">
        <Logo size={24} />
        <b>Set up {APP_NAME}</b>
        <span className="wz-ph-cnt">
          Step {step + 1} of {WIZARD_STEPS.length}
        </span>
      </div>
      <div className="wz-ph-prog" data-testid="wz-phone-progress">
        {WIZARD_STEPS.map((s, i) => (
          <i key={s.id} data-state={i < step ? 'done' : i === step ? 'current' : undefined} />
        ))}
      </div>
    </div>
  );
}

const GH_TABS = [
  { value: 'user', label: 'My account', icon: <IconUser size={15} />, hint: 'The app belongs to your personal GitHub account. Good if you work alone.' },
  { value: 'org', label: 'An organization', icon: <IconBuilding size={15} />, hint: 'The app belongs to your organization, so your team can sign in and use its repos.' },
  { value: 'oauth', label: 'Existing OAuth App', icon: <IconShieldCheck size={15} />, hint: 'Already have a GitHub OAuth App? Use it for sign-in instead of creating a new app.', testId: 'wz-advanced' },
] as const;
type Owner = (typeof GH_TABS)[number]['value'];

/** Step 1: "Create GitHub App" for my account or an organization (or an existing OAuth App), then "Created ✓". */
function GithubStep({ state, onNext }: { state: SetupState; onNext: () => void }) {
  const g = state.config.github;
  const created = g?.kind === 'app' && !!g.app;
  const oauthReady = g?.kind === 'oauth' && !!g.clientSecretSet;
  const [org, setOrg] = useState('');
  const [owner, setOwner] = useState<Owner>(g?.kind === 'oauth' ? 'oauth' : g?.app?.ownerType === 'Organization' ? 'org' : 'user');
  const [clientId, setClientId] = useState(g?.kind === 'oauth' ? (g.clientId ?? '') : '');
  const [secretSet, setSecretSet] = useState(!!g?.clientSecretSet);
  const patch = usePatchConfig();
  const result = new URLSearchParams(window.location.search).get('github');
  const orgOk = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org.trim());
  const create = useMutation({
    mutationFn: async () => {
      const r = await setupApi.githubManifest({ owner: owner === 'org' ? org.trim() : 'user' });
      submitManifest(r.action, r.manifest);
      return r;
    },
  });
  const saveOAuth = useMutation({
    mutationFn: async () => {
      if (!clientId.trim()) throw new UiApiError('invalid_input', 'Paste the Client ID', 'clientId');
      if (!secretSet) throw new UiApiError('invalid_input', 'Save the client secret first', 'clientSecret');
      await patch({ github: { clientId: clientId.trim(), clientSecretEnv: g?.clientSecretEnv ?? 'MANDATE_GITHUB_CLIENT_SECRET' } });
    },
    onSuccess: onNext,
  });
  const failed = result && result !== 'created' && result !== 'installed' ? GITHUB_RESULT[result] : null;
  const oauth = owner === 'oauth';
  const showCreated = created && !oauth;
  return (
    <section className="wz-main" data-testid="wz-github">
      <div className="wz-body">
        <StepHead n={1} title="Connect GitHub">
          People sign in with GitHub, and {APP_NAME} reads and writes the repos you choose. Create a GitHub App for this in one click.
        </StepHead>
        {failed && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} mb="lg" data-testid="wz-github-error">
            {failed.text}
          </Alert>
        )}
        <WzTabs value={owner} onChange={setOwner} tabs={GH_TABS.map((t) => ({ ...t }))} testId="wz-owner" />
        <p className="wz-tabexp" data-testid="wz-owner-hint">
          {GH_TABS.find((t) => t.value === owner)!.hint}
        </p>
        {showCreated ? (
          <div className="wz-created" data-testid="wz-github-created">
            <span className="wz-bigtick">
              <IconCheck size={20} stroke={2.5} />
            </span>
            <div className="wz-created-text">
              <div className="wz-created-t">GitHub App created</div>
              <div className="wz-created-d">
                <span className="wz-mono">{g!.app!.slug}</span>
                {g!.app!.owner && (
                  <>
                    {' '}
                    · owned by <b>{g!.app!.owner}</b>
                  </>
                )}
              </div>
            </div>
            {g!.app!.htmlUrl && (
              <Button component="a" href={g!.app!.htmlUrl} target="_blank" rel="noreferrer" variant="default" size="compact-sm" className="wz-sec wz-sec-sm" rightSection={<IconExternalLink size={14} />}>
                View on GitHub
              </Button>
            )}
          </div>
        ) : oauth ? (
          <div className="wz-oauth">
            <OAuthAppFields g={g ?? { clientId: null, clientSecretEnv: 'MANDATE_GITHUB_CLIENT_SECRET', allowedUsers: [], allowedOrgs: [], callbackUrl: null }} suggested={g?.suggested ?? { name: APP_NAME, homepageUrl: window.location.origin, callbackUrl: `${window.location.origin}/auth/github/callback` }} clientId={clientId} setClientId={setClientId} secretSet={secretSet} setSecretSet={setSecretSet} />
            {saveOAuth.isError && <div className="wz-err">{(saveOAuth.error as Error).message}</div>}
          </div>
        ) : (
          <div className="wz-stack wz-g24 wz-mt24">
            {owner === 'org' && (
              <Field label="Organization" error={org && !orgOk ? 'Use the name from the organization’s GitHub URL, e.g. github.com/acme → acme' : null} hint="As in github.com/acme; you must be an owner.">
                <TextInput className="wz-input wz-mono-input wz-prefixed" leftSection={<span className="wz-pfx">github.com/</span>} leftSectionWidth={96} placeholder="acme" value={org} onChange={(e) => setOrg(e.currentTarget.value)} aria-label="Organization" data-testid="wz-org" />
              </Field>
            )}
            <div>
              <Button fullWidth className="wz-ink wz-ghbtn" leftSection={<IconBrandGithubFilled size={18} />} loading={create.isPending} disabled={owner === 'org' && !orgOk} onClick={() => create.mutate()} data-testid="wz-create-app">
                Create GitHub App
              </Button>
              <div className="wz-hint wz-center wz-mt10">Opens GitHub to confirm, then brings you back here.</div>
              {create.isError && <div className="wz-err wz-center">{(create.error as Error).message}</div>}
            </div>
          </div>
        )}
      </div>
      <WizardFooter>
        {oauth && !created ? <ContinueButton loading={saveOAuth.isPending} onClick={() => saveOAuth.mutate()} /> : <ContinueButton disabled={!created && !oauthReady} onClick={onNext} />}
      </WizardFooter>
    </section>
  );
}

/** Last step: what was set up (tick or "Skipped"), then "Sign in with GitHub" (marks setup complete). */
function ReadyStep({ state, onBack }: { state: SetupState; onBack: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'restarting'>('idle');
  const finish = useMutation({
    mutationFn: async () => {
      const before = await serverStartedAt();
      const r = await setupApi.complete();
      if (r.restarting) {
        setPhase('restarting');
        await waitForRestart(before, { timeoutMs: 30_000 });
      }
      window.location.assign('/auth/github/login?returnTo=%2F%3Fnew%3D1');
      return r;
    },
  });
  const c = state.config;
  const g = c.github;
  const items: { label: string; ok: boolean; detail: React.ReactNode }[] = [
    {
      label: g?.kind === 'oauth' ? 'GitHub OAuth App' : 'GitHub App',
      ok: githubReady(state),
      detail: g?.app ? (
        <>
          <span className="wz-mono">{g.app.slug}</span>
          {g.app.owner ? ` · owned by ${g.app.owner}` : ''}
        </>
      ) : (
        <span className="wz-mono">{g?.clientId ?? ''}</span>
      ),
    },
    { label: 'Git', ok: true, detail: `${stepSummary('git', state)}${c.git.autoPush.enabled ? ' · auto-push on' : ' · auto-push off'}` },
    { label: 'Semantic search', ok: c.embedding.provider !== 'none', detail: c.embedding.provider !== 'none' ? <span className="wz-mono">{c.embedding.model}</span> : 'Keyword search only' },
    { label: 'Database', ok: true, detail: stepSummary('database', state) },
  ];
  return (
    <section className="wz-main" data-testid="wz-ready">
      <div className="wz-body">
        <StepHead n={5} title="Ready to go">
          Here is what you set up. Sign in to finish.
        </StepHead>
        <div className="wz-sum" data-testid="setup-summary">
          {items.map((i) => (
            <div key={i.label} className="wz-sumrow" data-skipped={!i.ok || undefined}>
              <span className="wz-tk">{i.ok ? <IconCheck size={12} stroke={2.6} /> : <IconMinus size={12} stroke={2.6} />}</span>
              <span className="wz-sum-k">{i.label}</span>
              <span className="wz-sum-v">{i.detail}</span>
              {!i.ok && <Chip>Skipped</Chip>}
            </div>
          ))}
        </div>
        <div className="wz-admin">
          <span className="wz-ibox wz-ibox-accent">
            <IconCrown size={15} />
          </span>
          <span data-testid="wz-admin-note">
            <b>You&apos;ll be the admin.</b> Add more admins later in Settings.
          </span>
        </div>
        {finish.isError && <div className="wz-err wz-mt10">{(finish.error as Error).message}</div>}
        <Button fullWidth className="wz-ink wz-ghbtn wz-mt24" leftSection={phase === 'restarting' ? <Loader size={14} color="currentColor" /> : <IconBrandGithubFilled size={18} />} loading={finish.isPending && phase === 'idle'} disabled={finish.isPending} onClick={() => finish.mutate()} data-testid="setup-signin">
          {phase === 'restarting' ? 'Restarting…' : 'Sign in with GitHub'}
        </Button>
      </div>
      <WizardFooter onBack={onBack} />
    </section>
  );
}

/** `/setup`: the guided first-run wizard (setup cookie or an admin session). */
export function SetupWizard({ status: _status }: { status: AuthStatus }) {
  const state = useSetupState();
  const qc = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const [step, setStep] = useState(0);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const tokenError = params.get('error');
  useEffect(() => {
    document.title = `Setup · ${APP_NAME}`;
  }, []);
  const go = (i: number) => {
    setStep(i);
    window.scrollTo({ top: 0 });
  };
  /** Leave step `i` forward; `skip` marks it skipped in the rail and the summary. */
  const next = (i: number, skip = false) => {
    setSkipped((s) => {
      const n = new Set(s);
      if (skip) n.add(i);
      else n.delete(i);
      return n;
    });
    go(i + 1);
  };
  const st = state.data;
  return (
    <div className="wz-page" data-testid="setup-wizard">
      <div className="wz-theme">
        <ThemeToggle />
      </div>
      <main className="wz-card">
        <WizardRail step={step} onStep={go} skipped={skipped} st={st} />
        <PhoneTop step={step} />
        <div className="wz-col">
          {tokenError === 'invalid_token' && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} m="lg" mb={0}>
              That setup link is invalid or expired. Run <code>{cli('setup-url').npx}</code> again.
            </Alert>
          )}
          {state.isLoading ? (
            <Center h={320}>
              <Loader size="sm" />
            </Center>
          ) : !st ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} m="lg" title="Cannot load the setup">
              {(state.error as Error)?.message}{' '}
              <Button size="compact-xs" variant="default" onClick={() => void qc.invalidateQueries({ queryKey: ['setup'] })}>
                Retry
              </Button>
            </Alert>
          ) : step === 0 ? (
            <GithubStep state={st} onNext={() => next(0)} />
          ) : step === 1 ? (
            <GitStep state={st} onBack={() => go(0)} onNext={() => next(1)} />
          ) : step === 2 ? (
            <SearchStep state={st} onBack={() => go(1)} onNext={(skip) => next(2, skip)} />
          ) : step === 3 ? (
            <DatabaseStep state={st} onBack={() => go(2)} onNext={(skip) => next(3, skip)} />
          ) : (
            <ReadyStep state={st} onBack={() => go(3)} />
          )}
        </div>
      </main>
    </div>
  );
}

/** Setup mode without the setup cookie: only the CLI can hand out the setup link. */
export function FinishSetupPage({ status }: { status: AuthStatus }) {
  const err = new URLSearchParams(window.location.search).get('error');
  const server = !!status.publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(status.publicUrl);
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
            Run on the machine running Mandate:
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
