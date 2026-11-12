/**
 * Setup sections, shared by the first-run wizard (`/setup`) and Settings (`/settings`). Each section edits a draft and
 * registers a saver; the wizard's Continue and Settings' Save run it (PUT /ui/setup/config with the configVersion).
 */
import { Anchor, Button, Group, NumberInput, Select, Switch, TagsInput, Text, TextInput } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBrain,
  IconBrandGithub,
  IconCheck,
  IconChevronRight,
  IconCloud,
  IconCopy,
  IconPackage,
  IconTerminal2,
  IconDeviceLaptop,
  IconExternalLink,
  IconFolder,
  IconRefresh,
  IconServer,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Field, Notice } from '../connect/parts';
import { copyText } from '../lib/copy';
import { useAuth } from '../auth';
import { UiApiError } from '../lib/ui';
import { ASK_LIMITS, ASK_PRESETS, PER_TOOL_FIELD, modelConfigId, SECRET_DEFAULTS, setupApi, tildify, type AskModelConfig, type AskProvider, type ConfigPatch, type ServerMode, type SetupState } from './api';
import { ChoiceCard, CommandLine, CopyField, FolderBrowser, NextNote, Recommended, SecretField, StepIntro, TestButton } from './widgets';

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
      if (r.restartRequired) restartNeeded.value = true;
      window.dispatchEvent(new Event(RESTART_EVENT));
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

/** Set once a saved change needs a restart (embedding provider, git backend). */
export const restartNeeded = { value: false };
export const RESTART_EVENT = 'mandate:restart-needed';

export const configChangedMessage = (e: unknown) => (e instanceof UiApiError && e.code === 'config_changed' ? 'The config was edited outside Mandate. Reload to see the current values.' : null);

/* ------------------------------------------------------------------ welcome / mode */

const MODE_TEXT: Record<ServerMode, { title: string; body: string }> = {
  local: {
    title: 'This computer',
    body: 'Projects are git repositories in a folder on this machine. Sign in with a one-time link from the terminal; pushes use your own git credentials. No GitHub app needed.',
  },
  server: {
    title: 'A remote server',
    body: 'Several people reach Mandate at a public URL. Sign-in with GitHub is required (with an allow-list) and projects come from GitHub repositories.',
  },
};

export function ChecksPanel({ mode }: { mode: ServerMode }) {
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
      {mode === 'server' && (
        <div className="np-hint" style={{ marginTop: 8 }}>
          Until HTTPS works, reach the server through an SSH tunnel: <code>ssh -L 4000:localhost:4000 you@server</code>, then open http://localhost:4000.
        </div>
      )}
    </div>
  );
}

export function ModeSection({ state, variant }: SectionProps) {
  const current = state.config.server.mode;
  const [mode, setMode] = useState<ServerMode>(current);
  const [publicUrl, setPublicUrl] = useState(state.config.server.publicUrl ?? '');
  const change = useMutation({ mutationFn: () => setupApi.setMode(state.configVersion, mode, mode === 'server' ? publicUrl.trim() : undefined) });
  const urlOk = /^https?:\/\/[^\s/]+/.test(publicUrl.trim());
  return (
    <div className="su-section">
      {variant === 'wizard' ? (
        <StepIntro title="Welcome to Mandate">
          Mandate keeps your specs in git and serves them to coding agents over MCP. First, where does it run? Most people run it on their own computer; pick a remote server only if a team will share
          it over the network.
        </StepIntro>
      ) : (
        <StepIntro title="Mode">How this Mandate runs. Switching changes how the server listens and signs people in, and needs a restart.</StepIntro>
      )}
      <div className="su-choices" role="radiogroup">
        <ChoiceCard selected={mode === 'local'} onSelect={() => setMode('local')} title={MODE_TEXT.local.title} description={MODE_TEXT.local.body} icon={<IconDeviceLaptop size={18} />} recommended testId="mode-local" />
        <ChoiceCard selected={mode === 'server'} onSelect={() => setMode('server')} title={MODE_TEXT.server.title} description={MODE_TEXT.server.body} icon={<IconServer size={18} />} testId="mode-server">
          <Field label="Public URL" hint="The HTTPS address people and agents use, e.g. https://mandate.example.com." error={publicUrl && !urlOk ? 'Enter a full URL starting with https://' : null}>
            <TextInput size="sm" value={publicUrl} onChange={(e) => setPublicUrl(e.currentTarget.value)} placeholder="https://mandate.example.com" className="np-mono-input" />
          </Field>
        </ChoiceCard>
      </div>
      {mode !== current && (
        <Notice
          icon={<IconAlertTriangle size={16} />}
          tone="warn"
          title={`Switch to “${MODE_TEXT[mode].title}”?`}
          testId="mode-warning"
          actions={
            change.data?.restartRequired ? null : (
              <Button type="button" size="xs" loading={change.isPending} disabled={mode === 'server' && !urlOk} onClick={() => change.mutate()}>
                Switch mode
              </Button>
            )
          }
        >
          This changes how the server listens ({mode === 'server' ? 'on all interfaces, behind your HTTPS proxy' : 'on this machine only'}) and how people sign in. It takes effect after a restart.
          {change.data?.restartRequired && (
            <>
              <br />
              <b>Saved.</b> Restart Mandate now: <code>npx getmandate restart</code> (or stop and start <code>npm run dev</code>).
            </>
          )}
          {change.isError && <div className="np-error">{(change.error as Error).message}</div>}
        </Notice>
      )}
      {variant === 'wizard' && <ChecksPanel mode={current} />}
      {variant === 'wizard' && (
        <NextNote>{current === 'local' ? 'Choose the folder for your projects. Every other step is optional.' : 'Set up GitHub sign-in so only your team can get in.'}</NextNote>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ projects folder (local) */

export function ProjectsFolderSection({ state, register, variant }: SectionProps) {
  const [dir, setDir] = useState(state.config.local.baseDir);
  const [browsing, setBrowsing] = useState(false);
  const patch = usePatchConfig();
  const home = useQuery({ queryKey: ['fs', 'home'], queryFn: () => setupApi.fsList(), retry: false }).data?.home;
  // The config may hold `~/…`; the folder API wants absolute paths.
  const abs = home && (dir === '~' || dir.startsWith('~/')) ? `${home}${dir.slice(1)}` : dir;
  const inspect = useQuery({ queryKey: ['fs', 'inspect', abs], queryFn: () => setupApi.fsInspect(abs), enabled: !!abs && (!dir.startsWith('~') || !!home), retry: false });
  useSaver(register, async () => {
    if (!dir.trim()) throw new UiApiError('invalid_input', 'Choose a folder for your projects', 'local.baseDir');
    if (inspect.isError) {
      try {
        await setupApi.fsMkdir(abs.trim());
      } catch (e) {
        if (!(e instanceof UiApiError && /exist/i.test(`${e.code} ${e.message}`))) throw e;
      }
    }
    if (dir.trim() !== state.config.local.baseDir) await patch({ local: { baseDir: dir.trim() } });
  });
  const exists = inspect.isSuccess;
  return (
    <div className="su-section">
      <StepIntro title="Projects folder">
        {variant === 'wizard'
          ? 'Each Mandate project is a git repository. New projects are created in this folder; you can also add repositories that already exist anywhere in your home folder. The default works for most people.'
          : 'Where new projects are created. Existing repositories can live anywhere in your home folder.'}
      </StepIntro>
      <Field
        label={
          <>
            Folder {dir === state.config.local.baseDir && variant === 'wizard' && <Recommended />}
          </>
        }
        hint={exists ? (inspect.data?.enclosingRepo ? `Inside the repository ${inspect.data.enclosingRepo}; pick a folder outside it.` : inspect.data?.isGitRepo ? 'This folder is itself a git repository; projects usually go in a plain folder.' : 'Folder exists.') : `Mandate creates it when you ${variant === 'wizard' ? 'continue' : 'save'}.`}
      >
        <Group gap={6} wrap="nowrap">
          <TextInput size="sm" value={dir} onChange={(e) => setDir(e.currentTarget.value)} leftSection={<IconFolder size={14} />} className="np-mono-input" style={{ flex: 1 }} data-testid="projects-folder" />
          <Button type="button" variant="default" size="sm" onClick={() => setBrowsing(true)}>
            Browse…
          </Button>
        </Group>
      </Field>
      <Notice icon={<IconCloud size={16} />} title="Remotes are optional">
        A project can push to any git remote (GitHub, GitLab, your own server). Mandate uses your own git credentials (SSH keys or the credential helper), like the git command line; nothing is stored in
        Mandate.
      </Notice>
      {variant === 'wizard' && <NextNote>Check how Mandate runs git and pushes. The defaults work if git already works in your terminal.</NextNote>}
      <FolderBrowser opened={browsing} onClose={() => setBrowsing(false)} onPick={(p) => setDir(home ? tildify(p, home) : p)} initial={inspect.isSuccess ? abs : undefined} title="Projects folder" />
    </div>
  );
}

/* ------------------------------------------------------------------ GitHub sign-in (server) */

export function GithubSection({ state, register, variant }: SectionProps) {
  const g = state.config.github ?? { clientId: null, clientSecretEnv: SECRET_DEFAULTS.github, allowedUsers: [], allowedOrgs: [], callbackUrl: null };
  const suggested = g.suggested ?? { name: 'Mandate', homepageUrl: state.config.server.publicUrl ?? '', callbackUrl: `${state.config.server.publicUrl ?? ''}/auth/github/callback` };
  const [clientId, setClientId] = useState(g.clientId ?? '');
  const [users, setUsers] = useState<string[]>(g.allowedUsers);
  const [orgs, setOrgs] = useState<string[]>(g.allowedOrgs);
  const [secretSet, setSecretSet] = useState(!!g.clientSecretSet);
  const patch = usePatchConfig();
  // Explicit server mode: access comes from GitHub repo permissions, the allow-list is optional.
  const auth = useAuth();
  const repoAuth = auth?.repoAuth ?? (state.config.server.mode === 'server' && !auth?.legacy);
  useSaver(register, async () => {
    if (!clientId.trim()) throw new UiApiError('invalid_input', 'Paste the Client ID of your GitHub OAuth App', 'github.clientId');
    if (!secretSet) throw new UiApiError('invalid_input', 'Save the client secret first', 'github.clientSecret');
    if (!repoAuth && users.length + orgs.length === 0) throw new UiApiError('invalid_input', 'Add at least one GitHub login or organization to the allow-list', 'github.allowedUsers');
    await patch({ github: { clientId: clientId.trim(), allowedUsers: users, allowedOrgs: orgs, callbackUrl: g.callbackUrl ?? suggested.callbackUrl, clientSecretEnv: g.clientSecretEnv } });
  });
  return (
    <div className="su-section">
      <StepIntro title="GitHub sign-in">
        {variant === 'wizard' ? 'Required for a server: anyone who can reach the URL could otherwise get in. ' : ''}
        {repoAuth
          ? 'Access comes from GitHub: people see a project if they can read its repo; their agents can write if they can push. The allow-list optionally restricts who can sign in; people in allowedUsers are Mandate admins (create projects, change settings). '
          : 'People sign in with GitHub, and only the logins and organizations in the allow-list get in. '}
        You register Mandate once as a GitHub OAuth App.
      </StepIntro>
      <ol className="su-steps">
        <li>
          <Text size="sm" fw={600}>
            Create the OAuth App on GitHub
          </Text>
          <Text size="sm" className="np-muted">
            Use these exact values (or create it in your organization&apos;s developer settings).
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
        <li>
          <Text size="sm" fw={600}>
            {repoAuth ? 'Admins and sign-in allow-list' : 'Who may sign in'} {repoAuth && <span className="su-badge">Optional</span>}
          </Text>
          <div className="np-stack" style={{ marginTop: 8 }}>
            <Field label={repoAuth ? 'Admins (GitHub logins)' : 'GitHub logins'} hint={repoAuth ? 'They create projects and change settings. Add yourself. Press Enter after each login.' : 'Press Enter after each login.'}>
              <TagsInput size="sm" value={users} onChange={setUsers} placeholder="your-login" />
            </Field>
            <Field label="Organizations" hint={repoAuth ? 'Optional: only members of these organizations (or the admins) may sign in. Empty: anyone with GitHub access to a project repo.' : 'Every member of these organizations may sign in.'}>
              <TagsInput size="sm" value={orgs} onChange={setOrgs} placeholder="your-org" />
            </Field>
          </div>
        </li>
      </ol>
      {variant === 'wizard' && <NextNote>After setup you sign in with GitHub, then pick repositories (personal or organization) for your projects.</NextNote>}
    </div>
  );
}

/* ------------------------------------------------------------------ Ask models */

const isEmbeddingModel = (m: string) => /embed|bge|minilm|e5-/i.test(m);
/** The suggested model unless it is an embedding model (Ollama lists those too); else the first chat model. */
export const pickChatModel = (models: string[], suggested: string | null) =>
  (suggested && !isEmbeddingModel(suggested) ? suggested : models.find((m) => !isEmbeddingModel(m))) ?? suggested ?? models[0] ?? null;

function AddModel({ onAdded, existing }: { onAdded: (m: AskModelConfig) => void; existing: AskModelConfig[] }) {
  const [presetId, setPresetId] = useState('anthropic');
  const preset = ASK_PRESETS.find((p) => p.id === presetId)!;
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(preset.apiKeyEnv ?? '');
  const [keySet, setKeySet] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const st = useQuery({ queryKey: ['setup', 'state'], queryFn: setupApi.state });
  useEffect(() => {
    setBaseUrl(preset.baseUrl ?? '');
    setApiKeyEnv(preset.apiKeyEnv ?? '');
    setModel(null);
    // A key stored for another model with the same env var counts as set.
    setKeySet(!!st.data?.config.ask.models.some((m) => m.apiKeyEnv && m.apiKeyEnv === preset.apiKeyEnv && m.apiKeySet));
  }, [presetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const conn = { provider: preset.provider as AskProvider, ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) };
  const models = useMutation({
    mutationFn: () => setupApi.askModels(conn),
    onSuccess: (r) => setModel((m) => m ?? pickChatModel(r.models, r.suggested)),
  });
  const needsKey = !!preset.apiKeyEnv;
  const ready = (!needsKey || keySet) && (preset.provider !== 'openai-compatible' || !!baseUrl);
  useEffect(() => {
    if (ready) models.mutate();
  }, [ready, presetId, baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = model ? modelConfigId(presetId, model) : '';
  return (
    <div className="su-add-model" data-testid="add-model">
      <div className="su-presets" role="radiogroup">
        {ASK_PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === presetId} className="su-preset" onClick={() => setPresetId(p.id)} data-testid={`preset-${p.id}`}>
            <span className="su-preset-title">
              {p.label}
              {p.id === 'anthropic' && <Recommended />}
            </span>
            <span className="su-preset-hint">{p.hint}</span>
          </button>
        ))}
      </div>
      <div className="np-stack" style={{ marginTop: 14 }}>
        {preset.provider === 'openai-compatible' && (
          <Field label="Base URL" hint={presetId === 'ollama' ? 'Ollama’s OpenAI-compatible endpoint. Install Ollama from ollama.com, then `ollama pull llama3.1`.' : 'The server’s /v1 endpoint.'}>
            <TextInput size="sm" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} placeholder="http://localhost:8000/v1" className="np-mono-input" />
          </Field>
        )}
        {needsKey && (
          <SecretField
            name={apiKeyEnv}
            isSet={keySet}
            label="API key"
            onSaved={setKeySet}
            placeholder={preset.keyUrl ? `Paste a key from ${new URL(preset.keyUrl).host}` : 'Paste the API key'}
          />
        )}
        {needsKey && preset.keyUrl && (
          <Anchor size="xs" href={preset.keyUrl} target="_blank" rel="noreferrer" mt={-10}>
            Get a key <IconExternalLink size={11} style={{ verticalAlign: -1 }} />
          </Anchor>
        )}
        <Field
          label="Model"
          hint={models.data ? models.data.message : ready ? 'Loading the available models…' : 'Save the key to list the models.'}
          error={models.data && !models.data.ok ? models.data.message : models.isError ? (models.error as Error).message : null}
          right={
            <Button type="button" size="compact-xs" variant="subtle" color="gray" leftSection={<IconRefresh size={12} />} disabled={!ready} loading={models.isPending} onClick={() => models.mutate()}>
              Reload
            </Button>
          }
        >
          <Select size="sm" searchable data={models.data ? [...models.data.models].sort((x, y) => Number(isEmbeddingModel(x)) - Number(isEmbeddingModel(y))) : model ? [model] : []} value={model} onChange={setModel} placeholder={ready ? 'Choose a model' : '—'} disabled={!ready} comboboxProps={{ withinPortal: true }} />
        </Field>
        <Group gap={8} justify="space-between">
          <TestButton disabled={!model} run={() => setupApi.askTest({ ...conn, model: model! })} label="Test model" testId="ask-test" />
          <Button
            type="button"
            size="xs"
            disabled={!model || existing.some((m) => m.id === id)}
            onClick={() => onAdded({ id, provider: preset.provider, model: model!, baseUrl: baseUrl || null, apiKeyEnv: apiKeyEnv || null })}
            data-testid="add-model-submit"
          >
            Add model
          </Button>
        </Group>
      </div>
    </div>
  );
}

type LimitKey = 'maxToolCalls' | 'tokenBudget' | 'timeoutMs' | 'maxOutputTokens';
const LIMIT_KEYS: LimitKey[] = ['maxToolCalls', 'tokenBudget', 'timeoutMs', 'maxOutputTokens'];

interface LimitsDraft {
  values: Record<LimitKey, number | null>;
  maxToolResultTokens: number | null;
  perTool: { tool: string; tokens: number | null }[];
}

const limitsOf = (ask: SetupState['config']['ask']): LimitsDraft => ({
  values: Object.fromEntries(LIMIT_KEYS.map((k) => [k, ask[k] ?? null])) as Record<LimitKey, number | null>,
  maxToolResultTokens: ask.limits?.maxToolResultTokens ?? null,
  perTool: Object.entries(ask.limits?.[PER_TOOL_FIELD] ?? {}).map(([tool, tokens]) => ({ tool, tokens })),
});

/** Range error for a limit (null = ok or unset). */
export function limitError(key: keyof typeof ASK_LIMITS, v: number | null): string | null {
  if (v === null) return null;
  const r = ASK_LIMITS[key];
  if (!Number.isInteger(v) || v < r.min || v > r.max) return `Between ${r.min.toLocaleString('en')} and ${r.max.toLocaleString('en')}`;
  return null;
}

function AskAdvanced({ draft, setDraft }: { draft: LimitsDraft; setDraft: (d: LimitsDraft) => void }) {
  const [open, setOpen] = useState(false);
  const num = (v: string | number) => (v === '' || v === null ? null : Number(v));
  return (
    <div className="su-advanced" data-open={open || undefined}>
      <button type="button" className="su-advanced-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="ask-advanced">
        <IconChevronRight size={14} className="su-advanced-chevron" />
        Advanced
        <span className="np-faint">limits per question</span>
      </button>
      {open && (
        <div className="su-advanced-body">
          <div className="su-limits">
            {LIMIT_KEYS.map((k) => {
              const r = ASK_LIMITS[k];
              return (
                <Field key={k} label={r.label} hint={`${r.help} Default ${r.def.toLocaleString('en')}.`} error={limitError(k, draft.values[k])}>
                  <NumberInput size="sm" min={r.min} max={r.max} step={k === 'maxToolCalls' ? 1 : 1000} thousandSeparator="," placeholder={r.def.toLocaleString('en')} value={draft.values[k] ?? ''} onChange={(v) => setDraft({ ...draft, values: { ...draft.values, [k]: num(v) } })} />
                </Field>
              );
            })}
            <Field label={ASK_LIMITS.maxToolResultTokens.label} hint={`${ASK_LIMITS.maxToolResultTokens.help} Default ${ASK_LIMITS.maxToolResultTokens.def.toLocaleString('en')}.`} error={limitError('maxToolResultTokens', draft.maxToolResultTokens)}>
              <NumberInput size="sm" min={ASK_LIMITS.maxToolResultTokens.min} max={ASK_LIMITS.maxToolResultTokens.max} step={500} thousandSeparator="," placeholder={ASK_LIMITS.maxToolResultTokens.def.toLocaleString('en')} value={draft.maxToolResultTokens ?? ''} onChange={(v) => setDraft({ ...draft, maxToolResultTokens: num(v) })} />
            </Field>
          </div>
          <Field label="Per-tool overrides" hint="A different result limit for specific tools, e.g. spec_get 12,000 or graph_query 3,000.">
            <div className="np-stack" style={{ gap: 6 }}>
              {draft.perTool.map((row, i) => (
                <Group key={i} gap={6} wrap="nowrap">
                  <TextInput size="sm" placeholder="tool name" value={row.tool} className="np-mono-input" style={{ flex: 1 }} onChange={(e) => setDraft({ ...draft, perTool: draft.perTool.map((r, j) => (j === i ? { ...r, tool: e.currentTarget.value } : r)) })} />
                  <NumberInput size="sm" placeholder="tokens" min={ASK_LIMITS.maxToolResultTokens.min} max={ASK_LIMITS.maxToolResultTokens.max} thousandSeparator="," w={140} value={row.tokens ?? ''} error={limitError('maxToolResultTokens', row.tokens) ? true : undefined} onChange={(v) => setDraft({ ...draft, perTool: draft.perTool.map((r, j) => (j === i ? { ...r, tokens: num(v) } : r)) })} />
                  <button type="button" className="su-icon-btn" aria-label="Remove override" onClick={() => setDraft({ ...draft, perTool: draft.perTool.filter((_, j) => j !== i) })}>
                    <IconTrash size={14} />
                  </button>
                </Group>
              ))}
              <Button type="button" size="compact-xs" variant="subtle" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft({ ...draft, perTool: [...draft.perTool, { tool: '', tokens: null }] })}>
                Add override
              </Button>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

export function AskSection({ state, register, variant }: SectionProps) {
  const [models, setModels] = useState<AskModelConfig[]>(state.config.ask.models);
  const [def, setDef] = useState<string | null>(state.config.ask.default);
  const [adding, setAdding] = useState(state.config.ask.models.length === 0);
  const initialLimits = limitsOf(state.config.ask);
  const [limits, setLimits] = useState<LimitsDraft>(initialLimits);
  const patch = usePatchConfig();
  const changed = JSON.stringify(models) !== JSON.stringify(state.config.ask.models) || def !== state.config.ask.default;
  useSaver(register, async () => {
    const bad =
      LIMIT_KEYS.map((k) => limitError(k, limits.values[k]) && ASK_LIMITS[k].label).find(Boolean) ??
      (limitError('maxToolResultTokens', limits.maxToolResultTokens) ? ASK_LIMITS.maxToolResultTokens.label : null) ??
      (limits.perTool.some((r) => (r.tool.trim() && r.tokens === null) || limitError('maxToolResultTokens', r.tokens)) ? 'Per-tool overrides' : null);
    if (bad) throw new UiApiError('invalid_input', `Check the advanced limit “${bad}”`, 'ask');
    const limitsChanged = JSON.stringify(limits) !== JSON.stringify(initialLimits);
    const p: NonNullable<ConfigPatch['ask']> = {};
    if (changed) Object.assign(p, { models: models.map(({ apiKeySet: _s, ...m }) => m), default: def && models.some((m) => m.id === def) ? def : (models[0]?.id ?? null) });
    if (limitsChanged) {
      Object.assign(p, limits.values);
      const perTool = Object.fromEntries(limits.perTool.filter((r) => r.tool.trim() && r.tokens !== null).map((r) => [r.tool.trim(), r.tokens!]));
      p.limits = { ...(limits.maxToolResultTokens !== null ? { maxToolResultTokens: limits.maxToolResultTokens } : {}), ...(Object.keys(perTool).length ? { [PER_TOOL_FIELD]: perTool } : {}) };
    }
    if (Object.keys(p).length) await patch({ ask: p });
  });
  return (
    <div className="su-section">
      <StepIntro title="Ask model" optional>
        The Ask panel answers questions about your specs with an AI model that reads them through Mandate&apos;s tools. Coding agents don&apos;t need this; it&apos;s only for asking in the web UI.
        Keys stay on this server.
      </StepIntro>
      {models.length > 0 && (
        <div className="su-model-list" data-testid="model-list">
          {models.map((m) => (
            <div key={m.id} className="su-model">
              <input type="radio" name="ask-default" checked={(def ?? models[0]?.id) === m.id} onChange={() => setDef(m.id)} aria-label={`Use ${m.model} by default`} />
              <IconBrain size={15} className="np-faint" />
              <span className="su-model-name">{m.model}</span>
              <span className="np-chip">{ASK_PRESETS.find((p) => p.provider === m.provider && (p.baseUrl ?? null) === (m.provider === 'openai-compatible' ? m.baseUrl : null))?.label ?? m.provider}</span>
              {(def ?? models[0]?.id) === m.id && <span className="su-badge">Default</span>}
              <button type="button" className="su-icon-btn" aria-label={`Remove ${m.model}`} onClick={() => setModels(models.filter((x) => x.id !== m.id))}>
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <AddModel existing={models} onAdded={(m) => (setModels([...models, m]), setDef(def ?? m.id), setAdding(false))} />
      ) : (
        <Button type="button" variant="default" size="xs" onClick={() => setAdding(true)} style={{ alignSelf: 'flex-start' }}>
          Add a model
        </Button>
      )}
      <AskAdvanced draft={limits} setDraft={setLimits} />
      {variant === 'wizard' && <NextNote>{models.length ? 'The Ask panel uses the default model; people can pick another one per question.' : 'Skip this if you only use coding agents. Add a model later in Settings.'}</NextNote>}
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
  const local = state.config.server.mode === 'local';
  // The wizard preselects the recommendation (system git when installed, in local mode); Settings shows the saved value.
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
          ? 'Mandate commits every change to your projects and pushes to their remotes. Using the git already on this computer is simplest: it reuses your SSH keys and credentials.'
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
      {variant === 'wizard' && <NextNote>Optionally connect an AI model for the Ask panel and local semantic search.</NextNote>}
    </div>
  );
}

/** Settings-only: the current server address. */
export function ServerInfo({ state }: { state: SetupState }) {
  const s = state.config.server;
  return (
    <div className="su-card su-kv">
      <span>Mode</span>
      <b>{MODE_TEXT[s.mode].title}</b>
      {s.mode === 'server' && (
        <>
          <span>Public URL</span>
          <code>{s.publicUrl ?? 'not set'}</code>
        </>
      )}
      <span>Listens on</span>
      <code>
        {s.bind}:{s.port}
      </code>
      {s.mode === 'local' && (
        <>
          <span>Projects folder</span>
          <code>{tildify(state.config.local.baseDir, null)}</code>
        </>
      )}
    </div>
  );
}
