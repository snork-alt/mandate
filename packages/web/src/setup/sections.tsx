/**
 * Setup sections, shared by the first-run wizard (`/setup`) and Settings (`/settings`). Each section edits a draft and
 * registers a saver; the wizard's Continue and Settings' Save run it (PUT /ui/setup/config with the configVersion).
 */
import { Anchor, Button, Group, Loader, NumberInput, Switch, TagsInput, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconBrandGithub, IconCheck, IconCopy, IconPackage, IconTerminal2, IconExternalLink, IconRefresh, IconUsers, IconChevronDown, IconUserCircle, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Field, Notice } from '../connect/parts';
import { copyText } from '../lib/copy';
import { useAuth } from '../auth';
import { UiApiError } from '../lib/ui';
import { announceApplied, SECRET_DEFAULTS, serverStartedAt, setupApi, waitForRestart, type ConfigPatch, type GithubAppSettings, type SetupConfig, type SetupState } from './api';
import { ChoiceCard, CommandLine, CopyField, FolderBrowser, NextNote, SecretField, StepIntro, TestButton } from './widgets';

export type Saver = () => Promise<void>;
export interface SectionProps {
  state: SetupState;
  /** Register this section's saver (null: nothing to save). */
  register: (fn: Saver | null) => void;
  /** Settings shows compact intros. */
  variant: 'wizard' | 'settings';
}

/** Patch the config with the latest configVersion; 409 -> `config_changed`. */
export function usePatchConfig() {
  const qc = useQueryClient();
  return async (patch: ConfigPatch) => {
    const st = qc.getQueryData<SetupState>(['setup', 'state']) ?? (await setupApi.state());
    try {
      const r = await setupApi.patch(st.configVersion, patch);
      announceApplied(r.applied);
    } finally {
      await qc.invalidateQueries({ queryKey: ['setup', 'state'] });
    }
  };
}

/** Keep the latest saver registered without re-registering on every render. */
export function useSaver(register: SectionProps['register'], fn: Saver | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    register(() => (ref.current ? ref.current() : Promise.resolve()));
    return () => register(null);
  }, [register]);
}


export const configChangedMessage = (e: unknown) => (e instanceof UiApiError && e.code === 'config_changed' ? 'The config was edited outside Mandate. Reload to see the current values.' : null);

/* ------------------------------------------------------------------ server address (Settings, advanced) */

export function ChecksPanel() {
  const checks = useQuery({ queryKey: ['setup', 'checks'], queryFn: setupApi.checks, retry: false });
  return (
    <div className="su-checks" data-testid="setup-checks">
      <Group justify="space-between" mb={6}>
        <Text size="sm" fw={600}>
          System checks
        </Text>
        <Button type="button" size="compact-xs" variant="subtle" color="gray" leftSection={<IconRefresh size={12} />} loading={checks.isFetching} onClick={() => void checks.refetch()}>
          Re-run
        </Button>
      </Group>
      {checks.isError && <div className="np-error">{(checks.error as Error).message}</div>}
      <ul className="su-check-list">
        {(checks.data?.checks ?? []).map((c) => (
          <li key={c.id} data-ok={c.ok || undefined}>
            <span className="su-check-icon">{c.ok ? <IconCheck size={12} stroke={2.6} /> : <IconX size={12} stroke={2.6} />}</span>
            <span className="su-check-text">
              <span className="su-check-label">{c.label}</span>
              <span className="su-check-detail">{c.detail}</span>
              {!c.ok && c.fix && <span className="su-check-fix">Fix: {c.fix}</span>}
            </span>
          </li>
        ))}
        {checks.isLoading && <li className="np-faint">Checking…</li>}
      </ul>
    </div>
  );
}

const urlProblem = (v: string) => {
  try {
    const u = new URL(v.trim());
    if (!/^https?:$/.test(u.protocol)) return 'Start with https://';
    if (u.pathname !== '/' || u.search || u.hash) return 'Use the bare address, without a path';
    return null;
  } catch {
    return 'Enter a full address, e.g. https://mandate.example.com';
  }
};

/**
 * Settings → Server address (advanced): the URL people and agents use. The setup wizard saves the address it was
 * opened on; change it here for a domain or a reverse proxy. Listen address and proxy trust follow from it unless set.
 */
export function AddressSection({ state, variant }: SectionProps) {
  const cur = state.config.server;
  const current = cur.publicUrl ?? `http://localhost:${cur.port}`;
  const [url, setUrl] = useState(current);
  const [open, setOpen] = useState(false);
  const [bind, setBind] = useState(cur.bind);
  const [trustProxy, setTrustProxy] = useState(cur.trustProxy);
  const restart = useServerRestart();
  const problem = urlProblem(url);
  const normalized = problem ? url.trim() : new URL(url.trim()).origin;
  const advancedChanged = bind !== cur.bind || trustProxy !== cur.trustProxy;
  const changed = normalized !== current || advancedChanged;
  const change = useMutation({
    mutationFn: async () => {
      const before = await serverStartedAt();
      const r = await setupApi.setServer(state.configVersion, normalized, open && advancedChanged ? { bind, trustProxy } : {});
      await restart.run(before, r.url ?? null);
      return r;
    },
  });
  return (
    <div className="su-section">
      <StepIntro title="Server address">The address people and agents use. Change it when Mandate moves to a domain or behind a reverse proxy; Mandate restarts to apply it. The GitHub App must allow the new sign-in address.</StepIntro>
      <Field label="Address" hint={problem ? undefined : `Sign-in returns to ${normalized}/auth/github/callback`} error={url && problem ? problem : null}>
        <TextInput size="sm" value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://mandate.example.com" className="np-mono-input" data-testid="public-url" />
      </Field>
      <div>
        <Button type="button" size="compact-xs" variant="subtle" color="gray" leftSection={<IconChevronDown size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} />} onClick={() => setOpen((o) => !o)} data-testid="address-advanced">
          Advanced
        </Button>
        {open && (
          <Group grow mt={8} align="flex-start">
            <Field label="Listen on" hint="127.0.0.1 behind a proxy on this machine; 0.0.0.0 for direct access.">
              <TextInput size="sm" value={bind} onChange={(e) => setBind(e.currentTarget.value)} className="np-mono-input" />
            </Field>
            <Field label="Behind a reverse proxy" hint="Trust X-Forwarded-* headers.">
              <Switch checked={trustProxy} onChange={(e) => setTrustProxy(e.currentTarget.checked)} mt={6} />
            </Field>
          </Group>
        )}
      </div>
      {changed && !problem && (
        <Group gap={8}>
          <Button type="button" size="xs" loading={change.isPending} disabled={change.isSuccess} onClick={() => change.mutate()} data-testid="address-save">
            Save and restart
          </Button>
          <RestartStatus phase={restart.phase} />
        </Group>
      )}
      {change.isError && <div className="np-error">{(change.error as Error).message}</div>}
      {variant === 'settings' && <ChecksPanel />}
    </div>
  );
}

/* ------------------------------------------------------------------ restart after an address change */

export type RestartPhase =
  | { kind: 'idle' }
  | { kind: 'restarting' }
  | { kind: 'back'; to: string }
  /** Not restarted by itself (manual), or not back within the wait: the command to run, and the new address. */
  | { kind: 'manual'; command: string; url: string | null; timedOut: boolean };

/** Ask the server to restart, wait for the new process, then go to the new address (or reload). */
export function useServerRestart(o: { timeoutMs?: number; navigate?: (to: string) => void } = {}) {
  const [phase, setPhase] = useState<RestartPhase>({ kind: 'idle' });
  const run = async (before: number | null, url: string | null) => {
    const r = await setupApi.restart();
    const other = url && !url.startsWith(window.location.origin) ? url : null;
    if (!r.restarting) return setPhase({ kind: 'manual', command: r.command, url: other, timedOut: false });
    setPhase({ kind: 'restarting' });
    const back = await waitForRestart(before, { ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });
    if (!back) return setPhase({ kind: 'manual', command: r.command, url: other, timedOut: true });
    const to = other ?? window.location.pathname;
    setPhase({ kind: 'back', to });
    (o.navigate ?? ((t: string) => window.location.assign(t)))(to);
  };
  return { phase, run };
}

export function RestartStatus({ phase }: { phase: RestartPhase }) {
  if (phase.kind === 'idle') return null;
  if (phase.kind === 'restarting' || phase.kind === 'back')
    return (
      <Group gap={8} mt={8} data-testid="restart-progress">
        <Loader size={14} />
        <Text size="sm">{phase.kind === 'back' ? 'Mandate is back. Reloading…' : 'Mandate is restarting…'}</Text>
      </Group>
    );
  return (
    <div style={{ marginTop: 8 }} data-testid="restart-manual">
      <b>Saved.</b> {phase.timedOut ? 'Mandate did not come back within 30 seconds. ' : 'This Mandate cannot restart itself. '}
      Restart it: <code>{phase.command}</code>
      {phase.url && (
        <>
          , then open{' '}
          <Anchor href={phase.url} size="sm">
            {phase.url}
          </Anchor>
        </>
      )}
      .
    </div>
  );
}

/* ------------------------------------------------------------------ GitHub */

/** POST the manifest to GitHub as a top-level form (GitHub shows "Create GitHub App", then redirects back). */
export function submitManifest(action: string, manifest: string, doc: Document = document): void {
  const form = doc.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = doc.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  doc.body.appendChild(form);
  form.submit();
}

/** `?github=` after GitHub redirected back from the app creation. */
export const GITHUB_RESULT: Record<string, { tone: 'ok' | 'danger'; text: string }> = {
  created: { tone: 'ok', text: 'GitHub App created. Its secrets are saved on this server (secrets.env and a private key file), never in the config.' },
  cancelled: { tone: 'danger', text: 'GitHub did not create the app (cancelled). Try again.' },
  expired: { tone: 'danger', text: 'The GitHub code expired (it is valid for one hour). Create the app again.' },
  state_mismatch: { tone: 'danger', text: 'The request expired or was started in another browser. Create the app again from here.' },
  failed: { tone: 'danger', text: 'Mandate could not finish creating the app. Try again; the server log has details.' },
};

/** One-click GitHub App: personal account or an organization; then the app is installed where the projects live. */
function CreateGithubApp({ app }: { app: GithubAppSettings | null | undefined }) {
  const [owner, setOwner] = useState<'user' | 'org'>(app?.ownerType === 'Organization' ? 'org' : 'user');
  const [org, setOrg] = useState(app?.ownerType === 'Organization' ? (app.owner ?? '') : '');
  const result = new URLSearchParams(window.location.search).get('github');
  const create = useMutation({
    mutationFn: async () => {
      const r = await setupApi.githubManifest({ owner: owner === 'org' ? org.trim() : 'user' });
      submitManifest(r.action, r.manifest);
      return r;
    },
  });
  const orgOk = owner === 'user' || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org.trim());
  return (
    <div className="np-stack" data-testid="github-app">
      {result && GITHUB_RESULT[result] && (
        <Notice icon={result === 'created' ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />} tone={GITHUB_RESULT[result].tone} title={result === 'created' ? 'GitHub App created' : 'GitHub App not created'} testId="github-result">
          {GITHUB_RESULT[result].text}
        </Notice>
      )}
      {app ? (
        <div className="su-card su-kv" data-testid="github-app-info">
          <span>GitHub App</span>
          <b>
            {app.htmlUrl ? (
              <Anchor href={app.htmlUrl} target="_blank" rel="noreferrer" size="sm">
                {app.slug}
              </Anchor>
            ) : (
              app.slug
            )}
          </b>
          <span>Owner</span>
          <span>{app.owner ? `${app.owner}${app.ownerType === 'Organization' ? ' (organization)' : ''}` : 'unknown'}</span>
          <span>Private key</span>
          <span>{app.privateKeySet ? 'saved on this server' : 'missing'}</span>
        </div>
      ) : (
        <Text size="sm" className="np-muted">
          Mandate registers itself on GitHub in one click: you review it on GitHub and press <b>Create GitHub App</b>; GitHub sends the credentials back to this server. It asks only to read and write
          repository contents (and to read organization members when an organization owns it).
        </Text>
      )}
      <div className="su-choices" role="radiogroup">
        <ChoiceCard selected={owner === 'user'} onSelect={() => setOwner('user')} title="My GitHub account" description="The app belongs to you; it can still be installed on organizations." icon={<IconUserCircle size={18} />} testId="gh-owner-user" />
        <ChoiceCard selected={owner === 'org'} onSelect={() => setOwner('org')} title="An organization" description="The app belongs to the organization (you need to be an owner of it)." icon={<IconUsers size={18} />} testId="gh-owner-org">
          <Field label="Organization" error={org && !orgOk ? 'A GitHub organization login' : null}>
            <TextInput size="sm" value={org} onChange={(e) => setOrg(e.currentTarget.value)} placeholder="your-org" className="np-mono-input" data-testid="gh-org" />
          </Field>
        </ChoiceCard>
      </div>
      <Group gap={8}>
        <Button type="button" size="sm" leftSection={<IconBrandGithub size={15} />} loading={create.isPending} disabled={!orgOk || (owner === 'org' && !org.trim())} onClick={() => create.mutate()} data-testid="gh-create-app">
          {app ? 'Create a new GitHub App' : 'Create GitHub App'}
        </Button>
        {app && (
          <Button type="button" size="sm" variant="default" component="a" href={app.installUrl} target="_blank" rel="noreferrer" rightSection={<IconExternalLink size={12} />} data-testid="gh-install">
            Install on repositories
          </Button>
        )}
      </Group>
      {create.isError && <div className="np-error">{(create.error as Error).message}</div>}
    </div>
  );
}

/** Advanced fallback: an existing GitHub OAuth App (older setups keep working with it). */
export function OAuthAppFields({ g, suggested, clientId, setClientId, secretSet, setSecretSet }: { g: NonNullable<SetupConfig['github']>; suggested: { name: string; homepageUrl: string; callbackUrl: string }; clientId: string; setClientId: (v: string) => void; secretSet: boolean; setSecretSet: (v: boolean) => void }) {
  return (
    <ol className="su-steps" data-testid="oauth-app">
      <li>
        <Text size="sm" fw={600}>
          Create the OAuth App on GitHub
        </Text>
        <div className="su-copies">
          <CopyField label="Application name" value={suggested.name} />
          <CopyField label="Homepage URL" value={suggested.homepageUrl} />
          <CopyField label="Callback URL" value={suggested.callbackUrl} testId="gh-callback" />
        </div>
        <Button type="button" size="xs" mt={8} leftSection={<IconBrandGithub size={14} />} rightSection={<IconExternalLink size={12} />} component="a" href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
          Open GitHub
        </Button>
      </li>
      <li>
        <Text size="sm" fw={600}>
          Paste the credentials
        </Text>
        <div className="np-stack" style={{ marginTop: 8 }}>
          <Field label="Client ID" hint="Shown at the top of the app page, e.g. Ov23li…">
            <TextInput size="sm" value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} placeholder="Ov23li…" className="np-mono-input" data-testid="gh-client-id" />
          </Field>
          <SecretField name={g.clientSecretEnv || SECRET_DEFAULTS.github} isSet={secretSet} label="Client secret" placeholder="Generate a new client secret on GitHub and paste it" onSaved={setSecretSet} />
          <TestButton disabled={!clientId.trim() || !secretSet} run={() => setupApi.testGithub({ clientId: clientId.trim() })} label="Test credentials" testId="gh-test" />
        </div>
      </li>
    </ol>
  );
}

const EMPTY_GITHUB: NonNullable<SetupConfig['github']> = { clientId: null, clientSecretEnv: SECRET_DEFAULTS.github, clientSecretSet: false, allowedUsers: [], allowedOrgs: [], callbackUrl: null, kind: null, app: null };

/** GitHub sign-in: the one-click GitHub App (default) or, under Advanced, an existing OAuth App. */
export function GithubSection({ state, register, variant }: SectionProps) {
  const g = state.config.github ?? EMPTY_GITHUB;
  const suggested = g.suggested ?? { name: 'Mandate', homepageUrl: state.config.server.publicUrl ?? '', callbackUrl: `${state.config.server.publicUrl ?? ''}/auth/github/callback` };
  const [useOAuth, setUseOAuth] = useState(g.kind === 'oauth');
  const [clientId, setClientId] = useState(g.kind === 'oauth' ? (g.clientId ?? '') : '');
  const [secretSet, setSecretSet] = useState(!!g.clientSecretSet);
  const patch = usePatchConfig();
  useSaver(register, async () => {
    if (!useOAuth) {
      if (g.kind !== 'app') throw new UiApiError('invalid_input', 'Create the GitHub App first (or use an existing OAuth App under Advanced)', 'github');
      return;
    }
    if (!clientId.trim()) throw new UiApiError('invalid_input', 'Paste the Client ID of your GitHub OAuth App', 'github.clientId');
    if (!secretSet) throw new UiApiError('invalid_input', 'Save the client secret first', 'github.clientSecret');
    await patch({ github: { clientId: clientId.trim(), callbackUrl: g.callbackUrl ?? suggested.callbackUrl, clientSecretEnv: g.clientSecretEnv } });
  });
  return (
    <div className="su-section">
      <StepIntro title="GitHub">
        {variant === 'wizard' ? 'Everyone signs in with GitHub. ' : ''}A GitHub App gives Mandate access only to the repositories you install it on; people see a project when they can read its repository.
      </StepIntro>
      {!useOAuth && <CreateGithubApp app={g.app} />}
      <details className="su-advanced" open={useOAuth} data-testid="gh-advanced">
        <summary
          onClick={(e) => {
            e.preventDefault();
            setUseOAuth(!useOAuth);
          }}
        >
          <IconChevronDown size={13} /> Advanced: use an existing OAuth App{g.kind === 'oauth' ? ' (in use)' : ''}
        </summary>
        {useOAuth && (
          <>
            <Text size="sm" className="np-muted" mb={6}>
              OAuth Apps see every repository the person can access (no per-repository install). Existing setups keep working with them.
            </Text>
            <OAuthAppFields g={g} suggested={suggested} clientId={clientId} setClientId={setClientId} secretSet={secretSet} setSecretSet={setSecretSet} />
          </>
        )}
      </details>
      {variant === 'wizard' && <NextNote>Choose who may sign in and who administers this Mandate.</NextNote>}
    </div>
  );
}

/** Who may sign in (allow-list) and the admins. */
const avatarOf = (login: string) => `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`;

/** Look a GitHub login up (debounced) and show who it is before adding it. */
function AddAdmin({ existing, onAdd }: { existing: string[]; onAdd: (login: string) => void }) {
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(value.trim()), 350);
    return () => clearTimeout(t);
  }, [value]);
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(query);
  const lookup = useQuery({ queryKey: ['github-user', query.toLowerCase()], queryFn: () => setupApi.githubUser(query), enabled: valid, retry: false, staleTime: 60_000 });
  const already = !!lookup.data && existing.some((u) => u.toLowerCase() === lookup.data!.login.toLowerCase());
  const add = () => {
    if (!lookup.data || already) return;
    onAdd(lookup.data.login);
    setValue('');
    setQuery('');
  };
  return (
    <div className="su-admin-add" data-testid="admin-add">
      <TextInput
        size="sm"
        label="Add an admin"
        placeholder="GitHub login"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        error={query && !valid ? 'Not a GitHub login' : lookup.isError ? (lookup.error as Error).message.replace(/^.*no GitHub user/, 'No GitHub user') : null}
        rightSection={lookup.isFetching ? <Loader size={14} /> : null}
        data-testid="admin-login"
      />
      {lookup.data && value.trim() === query && (
        <div className="su-admin-row su-admin-found" data-testid="admin-found">
          <img src={lookup.data.avatarUrl ?? avatarOf(lookup.data.login)} alt="" width={28} height={28} className="su-admin-avatar" />
          <div className="su-admin-who">
            <Text size="sm" fw={600}>
              {lookup.data.login}
            </Text>
            {lookup.data.name && (
              <Text size="xs" c="dimmed">
                {lookup.data.name}
              </Text>
            )}
          </div>
          <Button type="button" size="xs" disabled={already} onClick={add} data-testid="admin-add-btn">
            {already ? 'Already an admin' : 'Add'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Settings → Admins (avatars and logins; add with a GitHub lookup) and the optional organization gate. */
export function AccessSection({ state, register }: SectionProps) {
  const g = state.config.github ?? EMPTY_GITHUB;
  const [users, setUsers] = useState<string[]>(g.allowedUsers);
  const [orgs, setOrgs] = useState<string[]>(g.allowedOrgs);
  const patch = usePatchConfig();
  const auth = useAuth();
  // Access comes from GitHub repo permissions; the allow-list is optional (older OAuth App installs: required).
  const repoAuth = auth?.repoAuth ?? !(state.legacy ?? auth?.legacy);
  const me = auth?.user?.login?.toLowerCase();
  useSaver(register, async () => {
    if (users.length === 0) throw new UiApiError('invalid_input', 'Keep at least one admin', 'github.allowedUsers');
    await patch({ github: { allowedUsers: users, allowedOrgs: orgs } });
  });
  return (
    <div className="su-section">
      <StepIntro title="Admins">
        {repoAuth
          ? 'Admins add projects and change settings. Everyone else sees a project when they can read its GitHub repository.'
          : 'Admins and only the people and organizations listed here can sign in.'}
      </StepIntro>
      <ul className="su-admins" data-testid="admins">
        {users.map((u) => (
          <li key={u} className="su-admin-row">
            <img src={avatarOf(u)} alt="" width={28} height={28} className="su-admin-avatar" loading="lazy" />
            <Text size="sm" fw={500} className="su-admin-who">
              {u}
              {u.toLowerCase() === me && (
                <Text span size="xs" c="dimmed" ml={6}>
                  you
                </Text>
              )}
            </Text>
            <Button type="button" size="compact-xs" variant="subtle" color="gray" disabled={users.length === 1} onClick={() => setUsers(users.filter((x) => x !== u))} aria-label={`Remove ${u}`}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <AddAdmin existing={users} onAdd={(l) => setUsers([...users, l])} />
      <Field label="Organizations" hint={repoAuth ? 'Optional: only members of these organizations (or the admins) can sign in.' : 'Every member of these organizations can sign in.'}>
        <TagsInput size="sm" value={orgs} onChange={setOrgs} placeholder="your-org" />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ semantic search */

export { SearchSection } from './SearchSection';

/* ------------------------------------------------------------------ git */

const dirname = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

function GitTestAccess({ backend, auth }: { backend: 'cli' | 'embedded'; auth?: () => NonNullable<Parameters<typeof setupApi.gitTest>[0]['auth']> }) {
  const [url, setUrl] = useState('');
  return (
    <Field label="Test access" hint="Optional: a remote you will push to, e.g. git@github.com:you/specs.git. Mandate runs a read-only ls-remote.">
      <Group gap={6} wrap="nowrap" align="flex-start">
        <TextInput size="sm" value={url} onChange={(ev) => setUrl(ev.currentTarget.value)} placeholder="git@github.com:you/specs.git" className="np-mono-input" style={{ flex: 1 }} data-testid="git-test-url" />
        <TestButton disabled={!url.trim()} run={() => setupApi.gitTest({ url: url.trim(), backend, ...(auth ? { auth: auth() } : {}) })} label="Test" testId="git-test" />
      </Group>
    </Field>
  );
}

function SystemGitInfo({ g }: { g: SetupState['config']['git'] }) {
  const sys = g.system;
  if (!sys.version)
    return (
      <Notice icon={<IconAlertTriangle size={16} />} tone="danger" title="git is not installed">
        Install git (git-scm.com/downloads) or use the embedded git below.
      </Notice>
    );
  const missing = !sys.userName || !sys.userEmail;
  return (
    <div className="np-stack">
      <div className="su-card su-kv">
        <span>Version</span>
        <code>{sys.version}</code>
        <span>user.name</span>
        {sys.userName ? <code>{sys.userName}</code> : <span className="np-error">not set</span>}
        <span>user.email</span>
        {sys.userEmail ? <code>{sys.userEmail}</code> : <span className="np-error">not set</span>}
      </div>
      {missing && (
        <Notice icon={<IconAlertTriangle size={16} />} tone="warn" title="Set your git identity">
          Commits need a name and email. Run:
          <div className="np-stack" style={{ gap: 4, marginTop: 6 }}>
            {!sys.userName && <CommandLine cmd={'git config --global user.name "Your Name"'} />}
            {!sys.userEmail && <CommandLine cmd={'git config --global user.email you@example.com'} />}
          </div>
        </Notice>
      )}
    </div>
  );
}

function EmbeddedGit({ g, draft, setDraft }: { g: SetupState['config']['git']; draft: EmbeddedDraft; setDraft: (d: EmbeddedDraft) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [passSet, setPassSet] = useState(g.auth.passphraseSet);
  const [tokenSet, setTokenSet] = useState(g.auth.tokenSet);
  const pub = useQuery({ queryKey: ['setup', 'pubkey', draft.sshKeyPath], queryFn: () => setupApi.gitPubkey(draft.sshKeyPath!), enabled: !!draft.sshKeyPath && !draft.useAgent, retry: false });
  return (
    <div className="np-stack">
      <div className="su-choices" role="radiogroup">
        <ChoiceCard selected={!draft.useAgent} onSelect={() => setDraft({ ...draft, useAgent: false })} title="SSH key file" description="A private key on this machine (e.g. ~/.ssh/id_ed25519)." testId="git-sshkey">
          <div className="np-stack">
            <Field label="Private key">
              <Group gap={6} wrap="nowrap">
                <TextInput size="sm" value={draft.sshKeyPath ?? ''} onChange={(ev) => setDraft({ ...draft, sshKeyPath: ev.currentTarget.value || null })} className="np-mono-input" style={{ flex: 1 }} placeholder="~/.ssh/id_ed25519" />
                <Button type="button" size="sm" variant="default" onClick={() => setBrowsing(true)}>
                  Browse…
                </Button>
              </Group>
            </Field>
            {pub.data && (
              <div className="su-card">
                <Group justify="space-between" wrap="nowrap" gap={8}>
                  <div style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">
                      Fingerprint
                    </Text>
                    <code className="su-fingerprint">{pub.data.fingerprint}</code>
                  </div>
                  <Button type="button" size="xs" variant="default" leftSection={<IconCopy size={13} />} onClick={() => void copyText(pub.data!.publicKey, 'Copied public key')}>
                    Copy public key
                  </Button>
                </Group>
                <div className="np-hint" style={{ marginTop: 6 }}>
                  Add it to GitHub / GitLab as an SSH key (or a deploy key with write access for one repository).
                </div>
              </div>
            )}
            {pub.isError && draft.sshKeyPath && <div className="np-hint">No matching .pub file next to this key.</div>}
            <SecretField name={g.auth.sshPassphraseEnv || SECRET_DEFAULTS.sshPassphrase} isSet={passSet} label="Passphrase" placeholder="Only if the key has a passphrase" onSaved={setPassSet} />
          </div>
        </ChoiceCard>
        {g.agentAvailable && (
          <ChoiceCard selected={draft.useAgent} onSelect={() => setDraft({ ...draft, useAgent: true })} title="Use the SSH agent" description="Keys already loaded in ssh-agent (SSH_AUTH_SOCK)." testId="git-agent" />
        )}
      </div>
      <Field label="HTTPS (optional)" hint="For https:// remotes: a username and a personal access token.">
        <TextInput size="sm" value={draft.username ?? ''} onChange={(ev) => setDraft({ ...draft, username: ev.currentTarget.value || null })} placeholder="username" />
      </Field>
      <SecretField name={g.auth.tokenEnv || SECRET_DEFAULTS.gitToken} isSet={tokenSet} label="Access token" placeholder="Personal access token with repo write access" onSaved={setTokenSet} />
      <Group grow gap={8}>
        <Field label="Commit author name">
          <TextInput size="sm" value={draft.authorName} onChange={(ev) => setDraft({ ...draft, authorName: ev.currentTarget.value })} />
        </Field>
        <Field label="Commit author email">
          <TextInput size="sm" value={draft.authorEmail} onChange={(ev) => setDraft({ ...draft, authorEmail: ev.currentTarget.value })} />
        </Field>
      </Group>
      <FolderBrowser opened={browsing} onClose={() => setBrowsing(false)} onPick={(p) => setDraft({ ...draft, sshKeyPath: p })} initial={draft.sshKeyPath ? dirname(draft.sshKeyPath) : undefined} files hidden title="SSH private key" />
    </div>
  );
}

interface EmbeddedDraft {
  sshKeyPath: string | null;
  useAgent: boolean;
  username: string | null;
  authorName: string;
  authorEmail: string;
}

export function GitSection({ state, register, variant }: SectionProps) {
  const g = state.config.git;
  const local = !state.config.server.publicUrl;
  // The wizard preselects the recommendation (system git when installed, with a localhost address); Settings shows the saved value.
  const [backend, setBackend] = useState<'cli' | 'embedded'>(variant === 'wizard' && local && g.system.version ? 'cli' : g.backend);
  const [auto, setAuto] = useState(g.autoPush);
  const [emb, setEmb] = useState<EmbeddedDraft>({
    sshKeyPath: g.auth.sshKeyPath ?? g.defaultKeys[0] ?? null,
    useAgent: !g.auth.sshKeyPath && g.agentAvailable && !g.defaultKeys.length,
    username: g.auth.username,
    authorName: g.author.name,
    authorEmail: g.author.email,
  });
  const patch = usePatchConfig();
  useSaver(register, async () => {
    const p: ConfigPatch['git'] = {};
    if (backend !== g.backend) p.backend = backend;
    if (JSON.stringify(auto) !== JSON.stringify(g.autoPush)) p.autoPush = auto;
    if (backend === 'embedded') {
      const sshKeyPath = emb.useAgent ? null : emb.sshKeyPath;
      if (sshKeyPath !== g.auth.sshKeyPath || emb.username !== g.auth.username) p.auth = { sshKeyPath, username: emb.username };
      if (emb.authorName !== g.author.name || emb.authorEmail !== g.author.email) p.author = { name: emb.authorName, email: emb.authorEmail };
    }
    if (Object.keys(p).length) await patch({ git: p });
  });
  return (
    <div className="su-section">
      <StepIntro title="Git">
        {variant === 'wizard'
          ? 'Mandate commits every change to your projects and pushes to their remotes. Using the git already on this machine is simplest: it reuses your SSH keys and credentials.'
          : 'How Mandate runs git, which credentials it pushes with, and when.'}
      </StepIntro>
      <div className="su-choices" role="radiogroup">
        <ChoiceCard
          selected={backend === 'cli'}
          onSelect={() => setBackend('cli')}
          title="System git"
          description="The installed git command, with your SSH keys and credential helper, exactly like the terminal."
          icon={<IconTerminal2 size={18} />}
          recommended={local}
          testId="git-cli"
        >
          <div className="np-stack">
            <SystemGitInfo g={g} />
            <GitTestAccess backend="cli" />
          </div>
        </ChoiceCard>
        <ChoiceCard
          selected={backend === 'embedded'}
          onSelect={() => setBackend('embedded')}
          title="Embedded git"
          description="Built in (libgit2): no git install needed; you give Mandate the credentials here."
          icon={<IconPackage size={18} />}
          recommended={!local}
          testId="git-embedded"
        >
          <div className="np-stack">
            <EmbeddedGit g={g} draft={emb} setDraft={setEmb} />
            <GitTestAccess backend="embedded" auth={() => (emb.useAgent ? { useAgent: true } : { ...(emb.sshKeyPath ? { sshKeyPath: emb.sshKeyPath } : {}), ...(emb.username ? { username: emb.username } : {}) })} />
          </div>
        </ChoiceCard>
      </div>
      <div className="su-card">
        <Switch label="Push automatically" description="After changes, push to the project's remote (projects without a remote are skipped)." checked={auto.enabled} onChange={(ev) => setAuto({ ...auto, enabled: ev.currentTarget.checked })} />
        {auto.enabled && (
          <Group grow mt="sm">
            <NumberInput size="sm" label="Wait after a change (s)" min={1} max={3600} value={auto.debounceSeconds} onChange={(v) => setAuto({ ...auto, debounceSeconds: Number(v) || 1 })} />
            <NumberInput size="sm" label="And at least every (s)" min={10} max={86400} value={auto.intervalSeconds} onChange={(v) => setAuto({ ...auto, intervalSeconds: Number(v) || 60 })} />
          </Group>
        )}
      </div>
      {variant === 'wizard' && <NextNote>Semantic search works with local embeddings and no key; change it later in Settings.</NextNote>}
    </div>
  );
}

/** Settings-only: the current server address. */
export function ServerInfo({ state }: { state: SetupState }) {
  const s = state.config.server;
  return (
    <div className="su-card su-kv">
      <span>Address</span>
      <code>{s.publicUrl ?? `http://localhost:${s.port}`}</code>
      <span>Listens on</span>
      <code>
        {s.bind}:{s.port}
      </code>
    </div>
  );
}
