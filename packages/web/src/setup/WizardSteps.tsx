/**
 * The setup wizard's Git and Database steps. They write through the same APIs and validation as Settings: config.json
 * via PUT /ui/setup/config, secrets only as env var names plus write-only values in ~/.mandate/secrets.env (never shown).
 */
import { Button, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconBrandGithubFilled, IconCheck, IconChevronDown, IconDatabase, IconPackage, IconTerminal2, IconUpload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { UiApiError } from '../lib/ui';
import { setupApi, type DatabaseProbe, type SetupState } from './api';
import { configChangedMessage, usePatchConfig } from './sections';
import { Chip, ContinueButton, ENV_RE, Field, ResultLine, SECRET_HINT, SecretInput, StepHead, TestBtn, WizardFooter, WzTabs } from './wizardKit';

export const errText = (e: unknown) => configChangedMessage(e) ?? (e as Error).message + (e instanceof UiApiError && e.hint ? ` (${e.hint})` : '');

function Advanced({ open, setOpen, children, testId }: { open: boolean; setOpen: (o: boolean) => void; children: React.ReactNode; testId?: string }) {
  return (
    <>
      <button type="button" className="wz-adv-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={testId}>
        <IconChevronDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }} />
        Advanced
      </button>
      {open && children}
    </>
  );
}

/* ------------------------------------------------------------------ Git */

type PushMethod = 'app' | 'key' | 'agent';

/**
 * Step: which git commits and pushes (system git, or the built-in one). The built-in git pushes with the GitHub App
 * (`git.auth.method: 'app'`); an SSH key or the SSH agent is under Advanced (`method: 'ssh'`). Servers that do not
 * report `auth.method` yet only get the SSH key path.
 */
export function GitStep({ state, onBack, onNext }: { state: SetupState; onBack: () => void; onNext: () => void }) {
  const g = state.config.git;
  const auth = g.auth;
  const methodSupported = 'method' in auth;
  const [backend, setBackend] = useState<'cli' | 'embedded'>(g.backend === 'embedded' && !g.system.version ? 'embedded' : g.system.version ? (g.backend === 'embedded' && state.complete ? 'embedded' : 'cli') : g.backend);
  // The wizard's default is the GitHub App (no key); a saved SSH setup stays.
  const initial: PushMethod = (auth.method ?? (auth.sshKeyPath ? 'ssh' : 'app')) === 'app' ? 'app' : auth.sshKeyPath || !g.agentAvailable ? 'key' : 'agent';
  const [method, setMethod] = useState<PushMethod>(initial);
  const [keyPath, setKeyPath] = useState(auth.sshKeyPath ?? g.defaultKeys[0] ?? '');
  const [advanced, setAdvanced] = useState(initial !== 'app');
  const [autoPush, setAutoPush] = useState(g.autoPush.enabled);
  const patch = usePatchConfig();
  const save = useMutation({
    mutationFn: async () => {
      if (backend === 'cli' && !g.system.version) throw new UiApiError('invalid_input', 'git is not installed on this server; choose the built-in git or install git');
      const p: Record<string, unknown> = {};
      if (backend !== g.backend) p.backend = backend;
      if (backend === 'embedded') {
        const a: Record<string, unknown> = {};
        if (method === 'key' && !keyPath.trim()) throw new UiApiError('invalid_input', 'Enter the path of the SSH private key', 'git.auth.sshKeyPath');
        if (method !== 'app') {
          const sshKeyPath = method === 'agent' ? null : keyPath.trim();
          if (sshKeyPath !== auth.sshKeyPath) a.sshKeyPath = sshKeyPath;
        }
        if (methodSupported) {
          const m = method === 'app' ? 'app' : 'ssh';
          if (m !== auth.method) a.method = m;
        }
        if (Object.keys(a).length) p.auth = a;
      }
      if (autoPush !== g.autoPush.enabled) p.autoPush = { enabled: autoPush };
      if (Object.keys(p).length) await patch({ git: p as never });
    },
    onSuccess: onNext,
  });
  const cliPath = g.cliPath && g.cliPath.includes('/') ? g.cliPath : null;
  const opts: { v: PushMethod; t: string; d: string; disabled?: boolean }[] = [
    { v: 'app', t: 'GitHub App', d: `Default. ${'Mandate'} pushes with the app, no key to manage.` },
    { v: 'key', t: 'SSH key', d: 'Push with a private key file stored on this server.' },
    { v: 'agent', t: 'SSH agent', d: g.agentAvailable ? "Push with the keys already loaded in this server's ssh-agent." : 'No ssh-agent is running on this server.', disabled: !g.agentAvailable },
  ];
  return (
    <section className="wz-main" data-testid="wz-git">
      <div className="wz-body">
        <StepHead n={2} title="Git">
          Mandate keeps your specs in a git repo and pushes them to GitHub.
        </StepHead>
        <WzTabs
          value={backend}
          onChange={setBackend}
          testId="wz-git-tabs"
          tabs={[
            { value: 'cli', label: 'System git', icon: <IconTerminal2 size={15} />, chip: g.system.version ? <Chip tone="accent">Recommended</Chip> : undefined },
            { value: 'embedded', label: 'Built-in git', icon: <IconPackage size={15} /> },
          ]}
        />
        <p className="wz-tabexp" data-testid="wz-git-hint">
          {backend === 'cli' ? (g.system.version ? 'Uses the git installed on this server.' : 'git is not installed on this server. Install it, or use the built-in git.') : 'Comes with Mandate. Nothing to install.'}
        </p>
        <div className="wz-stack wz-g16 wz-mt20">
          {backend === 'cli' ? (
            <div className="wz-panel">
              <div className="wz-srow">
                <span className="wz-ibox">
                  <IconTerminal2 size={15} />
                </span>
                <div className="wz-grow">
                  <div className="wz-srow-t">
                    <span className="wz-mono">{g.system.version ? `git ${g.system.version}` : 'git'}</span>
                  </div>
                  <div className="wz-srow-d">
                    {g.system.version ? (
                      cliPath ? (
                        <>
                          Found at <span className="wz-mono-s">{cliPath}</span>
                        </>
                      ) : (
                        "Found on this server's PATH"
                      )
                    ) : (
                      'Not found on this server'
                    )}
                  </div>
                </div>
                {g.system.version ? (
                  <Chip tone="ok" icon={<IconCheck size={12} stroke={2.4} />}>
                    Detected
                  </Chip>
                ) : (
                  <Chip tone="warn" icon={<IconAlertTriangle size={12} />}>
                    Not found
                  </Chip>
                )}
              </div>
            </div>
          ) : (
            <div className="wz-panel">
              <div className="wz-srow">
                <span className="wz-ibox wz-ibox-ink">{method === 'app' ? <IconBrandGithubFilled size={16} /> : <IconTerminal2 size={15} />}</span>
                <div className="wz-grow">
                  <div className="wz-srow-t">{method === 'app' ? 'Pushes with the GitHub App' : method === 'key' ? 'Pushes with an SSH key' : 'Pushes with the SSH agent'}</div>
                  <div className="wz-srow-d">{method === 'app' ? 'No key needed.' : method === 'key' ? 'The key GitHub knows, stored on this server.' : 'The keys loaded in ssh-agent.'}</div>
                </div>
              </div>
              <div className="wz-adv-row">
                <Advanced open={advanced} setOpen={setAdvanced} testId="wz-git-advanced">
                  <div className="wz-adv-body">
                    <div className="wz-opts" role="radiogroup">
                      {opts.map((o) => (
                        <button key={o.v} type="button" role="radio" aria-checked={method === o.v} disabled={o.disabled} className="wz-opt" onClick={() => setMethod(o.v)} data-testid={`wz-push-${o.v}`}>
                          <span className="wz-radio" data-on={method === o.v || undefined} />
                          <span>
                            <span className="wz-opt-t">{o.t}</span>
                            <span className="wz-opt-d">{o.d}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {method === 'key' && (
                      <Field label="SSH private key" hint="The key GitHub knows, e.g. ~/.ssh/id_ed25519.">
                        <TextInput className="wz-input wz-mono-input" placeholder="~/.ssh/id_ed25519" value={keyPath} onChange={(e) => setKeyPath(e.currentTarget.value)} aria-label="SSH private key" data-testid="wz-ssh-key" />
                      </Field>
                    )}
                  </div>
                </Advanced>
              </div>
            </div>
          )}
          <div className="wz-panel">
            <div className="wz-srow">
              <span className="wz-ibox">
                <IconUpload size={15} />
              </span>
              <div className="wz-grow">
                <div className="wz-srow-t">Push to GitHub automatically</div>
                <div className="wz-srow-d">Changes are pushed a few seconds after they are saved.</div>
              </div>
              <Switch size="md" className="wz-switch" checked={autoPush} onChange={(e) => setAutoPush(e.currentTarget.checked)} aria-label="Push to GitHub automatically" data-testid="wz-autopush" />
            </div>
          </div>
        </div>
        {save.isError && <div className="wz-err wz-mt16">{errText(save.error)}</div>}
      </div>
      <WizardFooter onBack={onBack}>
        <ContinueButton loading={save.isPending} onClick={() => save.mutate()} />
      </WizardFooter>
    </section>
  );
}

/* ------------------------------------------------------------------ Database */

type Ssl = 'disable' | 'require' | 'verify-full';

/** Step (optional): where server state lives. SQLite needs nothing; Postgres is shared by several instances. */
export function DatabaseStep({ state, onBack, onNext }: { state: SetupState; onBack: () => void; onNext: (skipped?: boolean) => void }) {
  const cur = state.config.database;
  const [driver, setDriver] = useState<'sqlite' | 'postgres'>(cur?.driver ?? 'sqlite');
  const [urlEnv, setUrlEnv] = useState(cur?.urlEnv ?? 'MANDATE_DATABASE_URL');
  const [urlSet, setUrlSet] = useState(!!cur?.urlSet);
  const [url, setUrl] = useState('');
  const [ssl, setSsl] = useState<Ssl | ''>(cur?.ssl ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [poolMax, setPoolMax] = useState<number>(cur?.pool.max ?? 10);
  const [extSchema, setExtSchema] = useState(cur?.extensionsSchema ?? '');
  const [probe, setProbe] = useState<DatabaseProbe | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; sub?: string } | null>(null);
  const [tested, setTested] = useState(false);
  const patch = usePatchConfig();
  const envOk = ENV_RE.test(urlEnv);
  const reset = () => (setTested(false), setResult(null));
  /** A typed URL goes to secrets.env first (write-only). */
  const storeUrl = async () => {
    if (!url.trim()) return;
    if (!envOk) throw new UiApiError('invalid_input', 'The variable name uses capital letters, digits and _ (e.g. MANDATE_DATABASE_URL)', 'database.urlEnv');
    const r = await setupApi.secret(urlEnv, url.trim());
    setUrl('');
    setUrlSet(r.set);
  };
  const test = useMutation({
    mutationFn: async (createExtensions: boolean) => {
      await storeUrl();
      return setupApi.databaseTest({ urlEnv, ssl: ssl || null, extensionsSchema: extSchema.trim() || null, ...(createExtensions ? { createExtensions } : {}) });
    },
    onSuccess: (r) => {
      setProbe(r.details);
      setTested(r.ok);
      setResult(r.ok ? { ok: true, text: 'Connected', sub: r.details?.version ? `PostgreSQL ${r.details.version}` : undefined } : { ok: false, text: r.message });
    },
    onError: (e) => setResult({ ok: false, text: errText(e) }),
  });
  const missing = probe ? Object.entries(probe.extensions).filter(([, e]) => !e.installed) : [];
  const save = useMutation({
    mutationFn: async () => {
      if (!cur) return;
      if (driver === 'sqlite') {
        if (cur.driver !== 'sqlite') await patch({ database: { driver: 'sqlite' } });
        return;
      }
      if (!envOk) throw new UiApiError('invalid_input', 'The variable name uses capital letters, digits and _ (e.g. MANDATE_DATABASE_URL)', 'database.urlEnv');
      if (!urlSet && !url.trim()) throw new UiApiError('invalid_input', 'Save the connection URL first (or keep SQLite)', 'database.url');
      if (!tested) throw new UiApiError('invalid_input', 'Press “Test connection” first', 'database');
      await patch({ database: { driver: 'postgres', urlEnv, ssl: ssl || null, extensionsSchema: extSchema.trim() || null, pool: { ...cur.pool, max: poolMax } } });
    },
    onSuccess: () => onNext(false),
  });
  return (
    <section className="wz-main" data-testid="wz-database">
      <div className="wz-body">
        <StepHead n={5} title="Database" optional>
          Where Mandate keeps its own data, like users and the search index. Specs stay in git.
        </StepHead>
        <WzTabs
          value={driver}
          onChange={(v) => (setDriver(v), reset())}
          testId="wz-db-tabs"
          tabs={[
            { value: 'sqlite', label: 'SQLite (built in)', icon: <IconDatabase size={15} />, chip: <Chip>Default</Chip> },
            { value: 'postgres', label: 'Postgres', icon: <IconDatabase size={15} /> },
          ]}
        />
        {driver === 'sqlite' ? (
          <div className="wz-nothing" data-testid="wz-db-hint">
            <span className="wz-bigtick wz-bigtick-accent">
              <IconCheck size={20} stroke={2.5} />
            </span>
            <div>
              <div className="wz-created-t">Nothing to set up</div>
              <div className="wz-created-d">Data is kept in a file on this server. Right for a single server.</div>
            </div>
          </div>
        ) : (
          <>
            <p className="wz-tabexp" data-testid="wz-db-hint">
              Use your own Postgres server (14+ with pgvector and pg_trgm), for example to run several Mandate servers.
            </p>
            <div className="wz-stack wz-g20 wz-mt20">
              <div className="wz-grid2">
                <Field label="URL variable" hint="The environment variable that holds the URL." error={!envOk ? 'Capital letters, digits and _' : null}>
                  <TextInput className="wz-input wz-mono-input" value={urlEnv} onChange={(ev) => (setUrlEnv(ev.currentTarget.value.toUpperCase()), setUrlSet(ev.currentTarget.value.toUpperCase() === cur?.urlEnv && !!cur?.urlSet), reset())} aria-label="URL variable" data-testid="wz-db-urlenv" />
                </Field>
                <div data-testid="wz-db-url">
                  <Field label="Connection URL" aside={urlSet ? <Chip tone="ok" icon={<IconCheck size={12} stroke={2.4} />}>Saved</Chip> : null} hint={SECRET_HINT}>
                    <SecretInput value={url} onChange={(v) => (setUrl(v), reset())} saved={urlSet} placeholder="postgresql://user:password@host:5432/postgres" savedLabel="Saved · paste a new URL to replace it" />
                  </Field>
                </div>
              </div>
              <Field label="TLS">
                <Select className="wz-input" value={ssl} onChange={(v) => (setSsl((v ?? '') as Ssl | ''), reset())} allowDeselect={false} data={[{ value: '', label: 'From the URL (sslmode)' }, { value: 'require', label: 'Require (Supabase)' }, { value: 'verify-full', label: 'Verify certificate' }, { value: 'disable', label: 'Off (local only)' }]} aria-label="TLS" />
              </Field>
              <div>
                <Advanced open={advanced} setOpen={setAdvanced}>
                  <div className="wz-grid2 wz-mt10">
                    <Field label="Pool size">
                      <NumberInput className="wz-input" min={1} max={200} value={poolMax} onChange={(v) => setPoolMax(typeof v === 'number' ? v : 10)} aria-label="Pool size" />
                    </Field>
                    <Field label="Extensions schema" hint="Default: extensions (Supabase) when it exists, else public.">
                      <TextInput className="wz-input wz-mono-input" placeholder="extensions" value={extSchema} onChange={(ev) => (setExtSchema(ev.currentTarget.value), reset())} aria-label="Extensions schema" />
                    </Field>
                  </div>
                </Advanced>
              </div>
              <div className="wz-panel wz-clip">
                <div className="wz-srow">
                  <TestBtn label="Test connection" loading={test.isPending && !test.variables} disabled={!urlSet && !url.trim()} onClick={() => test.mutate(false)} testId="wz-db-test" />
                  <ResultLine result={result} />
                </div>
                {missing.length > 0 && (
                  <div className="wz-srow wz-srow-warn">
                    <span className="wz-warn-ic">
                      <IconAlertTriangle size={16} />
                    </span>
                    <div className="wz-grow">
                      <div className="wz-srow-t wz-13">
                        {missing.length} extension{missing.length === 1 ? ' is' : 's are'} missing
                      </div>
                      <div className="wz-srow-d">
                        {missing.map(([n], i) => (
                          <span key={n}>
                            {i > 0 && ', '}
                            <span className="wz-mono-s">{n}</span>
                          </span>
                        ))}
                        . Search needs them.
                      </div>
                    </div>
                    {missing.some(([, e]) => e.available) && (
                      <Button variant="default" size="compact-sm" className="wz-sec wz-sec-sm" loading={test.isPending && !!test.variables} onClick={() => test.mutate(true)} data-testid="wz-db-create-ext">
                        Enable missing extensions
                      </Button>
                    )}
                  </div>
                )}
                {probe && [...probe.errors, ...probe.warnings].length > 0 && (
                  <div className="wz-srow wz-srow-notes">
                    <ul className="wz-notes">
                      {probe.errors.map((e) => (
                        <li key={e} data-tone="danger">
                          {e}
                        </li>
                      ))}
                      {probe.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {save.isError && (
          <div className="wz-err wz-mt16" data-testid="wz-db-error">
            {errText(save.error)}
          </div>
        )}
      </div>
      <WizardFooter onBack={onBack} onSkip={driver === 'postgres' ? () => onNext(true) : undefined}>
        <ContinueButton loading={save.isPending} onClick={() => save.mutate()} />
      </WizardFooter>
    </section>
  );
}
