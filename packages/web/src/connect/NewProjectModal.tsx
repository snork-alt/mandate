import { ActionIcon, Autocomplete, Avatar, Button, Loader, Modal, Select, Skeleton, Switch, Text, TextInput, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBrandGithub,
  IconBuilding,
  IconCheck,
  IconExternalLink,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconHash,
  IconLock,
  IconLogin2,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { SearchField } from '../components/SearchField';
import { relativeTime } from '../lib/time';
import { goTo, projectBase } from '../project';
import { CREATE_STEPS, githubApi, normalizeSubpath, slugify, UiApiError, type CreateStep, type GithubOwner, type GithubRepo, type NewProjectInput, type RepoList } from './github';
import { devApiPort } from './snippets';
import { Field, Notice, StepBar, SummaryRow } from './parts';
import { PostCreateConnect } from './PostCreateConnect';

interface Draft {
  name: string;
  id: string;
  idTouched: boolean;
  description: string;
  repo: GithubRepo | null;
  branch: string;
  path: string;
  owner: string;
}

const EMPTY: Draft = { name: '', id: '', idTouched: false, description: '', repo: null, branch: '', path: '', owner: 'all' };
const DRAFT_KEY = 'mandate.newProject';

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}
function saveDraft(d: Draft | null) {
  try {
    if (d) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

const STEPS = [
  { label: 'Details', icon: IconFolderPlus, subtitle: 'Name the project. Its id becomes the MCP endpoint coding agents connect to.' },
  { label: 'Repository', icon: IconBrandGithub, subtitle: "Pick the GitHub repository that stores this project's specs." },
  { label: 'Branch', icon: IconGitBranch, subtitle: 'Choose the branch and, optionally, a folder inside the repository.' },
  { label: 'Confirm', icon: IconRocket, subtitle: 'Review the setup. Mandate prepares the repository for you.' },
] as const;

/** Which step a server error's `path` belongs to. */
const STEP_OF: Record<string, number> = { id: 0, name: 0, description: 0, repo: 1, owner: 1, branch: 2, path: 2 };

const PROGRESS: Record<CreateStep, string> = { clone: 'Cloning the repository', init: 'Initialising the project', push: 'Pushing the first commit', key: 'Creating an agent key' };

/** `localhost:4000` (where coding agents reach the API). */
function apiHost(): string {
  const port = devApiPort();
  if (typeof window === 'undefined') return 'localhost:4000';
  return port ? `${window.location.hostname}:${port}` : window.location.host;
}

/* ---------------------------------------------------------------- pieces */



const ownerLabel = (o: GithubOwner) => o.name || o.login;

function OwnerAvatar({ url, login, size = 20 }: { url?: string | null; login: string; size?: number }) {
  return (
    <Avatar src={url ?? undefined} size={size} radius={5} className="np-avatar" alt="">
      {login.slice(0, 1).toUpperCase()}
    </Avatar>
  );
}

function OwnerSwitcher({ owners, value, onChange }: { owners: GithubOwner[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="np-owners" role="tablist" aria-label="Repository owner" data-testid="owner-switcher">
      <button type="button" role="tab" className="np-owner" aria-selected={value === 'all'} onClick={() => onChange('all')} data-testid="owner-all">
        All
      </button>
      {owners.map((o) => (
        <Tooltip key={o.login} label={o.restricted ? `${ownerLabel(o)}: access not granted` : o.type === 'user' ? 'Your repositories' : ownerLabel(o)} openDelay={300}>
          <button
            type="button"
            role="tab"
            className="np-owner"
            aria-selected={value === o.login}
            data-restricted={o.restricted || undefined}
            onClick={() => onChange(o.login)}
            data-testid={`owner-${o.login}`}
          >
            <OwnerAvatar url={o.avatarUrl} login={o.login} size={16} />
            <span>{o.type === 'user' ? o.login : ownerLabel(o)}</span>
            {o.restricted && <IconLock size={11} className="np-owner-lock" />}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function RepoRow({ r, selected, onPick }: { r: GithubRepo; selected: boolean; onPick: () => void }) {
  return (
    <UnstyledButton type="button" className="np-repo" data-selected={selected || undefined} onClick={onPick} data-testid={`repo-${r.fullName}`} aria-pressed={selected}>
      <OwnerAvatar url={r.ownerAvatarUrl} login={r.owner} />
      <span className="np-repo-main">
        <span className="np-repo-name">
          <span className="np-repo-owner">{r.owner}/</span>
          <b>{r.name}</b>
        </span>
        {r.description && <span className="np-repo-desc">{r.description}</span>}
      </span>
      <span className="np-chip">
        {r.private ? <IconLock size={11} /> : <IconWorld size={11} />}
        {r.private ? 'Private' : 'Public'}
      </span>
      {r.empty && <span className="np-faint">Empty</span>}
      <span className="np-repo-time">{r.pushedAt ? relativeTime(r.pushedAt) : 'never'}</span>
      <span className="np-repo-check">{selected && <IconCheck size={14} stroke={2.4} />}</span>
    </UnstyledButton>
  );
}


/* ---------------------------------------------------------------- repository step */

function CreateRepo({ data, draft, onCreated, onCancel }: { data: RepoList | undefined; draft: Draft; onCreated: (r: GithubRepo) => void; onCancel: () => void }) {
  const owners = (data?.owners ?? []).filter((o) => o.type === 'user' || (o.canCreateRepos && !o.restricted));
  const me = owners.find((o) => o.type === 'user');
  const initialOwner = owners.some((o) => o.login === draft.owner) ? draft.owner : (me?.login ?? '');
  const [owner, setOwner] = useState(initialOwner);
  const [name, setName] = useState(draft.id || slugify(draft.name));
  const [isPrivate, setIsPrivate] = useState(true);
  const create = useMutation({
    mutationFn: () => {
      const o = owners.find((x) => x.login === owner);
      return githubApi.createRepo({ name: name.trim(), private: isPrivate, ...(draft.description.trim() ? { description: draft.description.trim() } : {}), ...(o && o.type === 'org' ? { owner: o.login } : {}) });
    },
    onSuccess: ({ repo }) => onCreated(repo),
  });
  const err = create.error instanceof UiApiError ? create.error : null;
  return (
    <div className="np-create" data-testid="create-repo-form">
      <div className="np-create-row">
        <Field label="Owner" error={err?.path === 'owner' ? err.message : null}>
          <Select
            size="sm"
            value={owner}
            onChange={(v) => v && setOwner(v)}
            allowDeselect={false}
            data={owners.map((o) => ({ value: o.login, label: o.type === 'user' ? `${o.login} (you)` : ownerLabel(o) }))}
            leftSection={<OwnerAvatar url={owners.find((o) => o.login === owner)?.avatarUrl} login={owner || '?'} size={18} />}
            comboboxProps={{ withinPortal: true }}
          />
        </Field>
        <span className="np-create-slash">/</span>
        <Field label="Repository name" error={err && err.path !== 'owner' ? err.message : null}>
          <TextInput size="sm" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="specs" data-autofocus className="np-mono-input" />
        </Field>
      </div>
      <div className="np-create-foot">
        <Switch size="sm" label="Private" checked={isPrivate} onChange={(e) => setIsPrivate(e.currentTarget.checked)} />
        <div className="np-create-actions">
          <Button type="button" size="xs" variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="xs" loading={create.isPending} disabled={!name.trim() || !owner} onClick={() => create.mutate()} data-testid="create-repo-submit">
            Create repository
          </Button>
        </div>
      </div>
      {err?.hint && <div className="np-hint">{err.hint}</div>}
      {create.isError && !err && <div className="np-error">{(create.error as Error).message}</div>}
    </div>
  );
}

function RepoStep({ draft, setOwner, onPick, error }: { draft: Draft; setOwner: (o: string) => void; onPick: (r: GithubRepo) => void; error?: string }) {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const owner = draft.owner || 'all';
  const repos = useQuery({ queryKey: ['github', 'repos', owner, debounced], queryFn: ({ signal }) => githubApi.repos(debounced, owner, signal), staleTime: 30_000, placeholderData: (prev) => prev });
  const [creating, setCreating] = useState(false);
  const data = repos.data;
  const owners = data?.owners ?? [];
  const selectedOwner = owners.find((o) => o.login === owner);

  if (data?.needsScope) {
    const upgrade = (url: string) => {
      saveDraft(draft);
      window.location.assign(url);
    };
    return (
      <Notice
        icon={<IconLock size={16} />}
        title="GitHub permission needed"
        testId="needs-scope"
        actions={
          <>
            <Button type="button" size="xs" leftSection={<IconBrandGithub size={14} />} onClick={() => upgrade(data.upgradeUrl)}>
              Grant repo access
            </Button>
            <Button type="button" size="xs" variant="default" onClick={() => upgrade(data.upgradeUrlPublic)}>
              Public repositories only
            </Button>
          </>
        }
      >
        To store projects in private repositories Mandate needs the GitHub <code>repo</code> scope (read/write to your repositories). Public-only: <code>public_repo</code>.
      </Notice>
    );
  }

  const restricted = selectedOwner?.restricted;
  return (
    <div className="np-repo-step">
      {owners.length > 0 && <OwnerSwitcher owners={owners} value={owner} onChange={(o) => (setOwner(o), setCreating(false))} />}
      {restricted ? (
        <Notice
          icon={<IconBuilding size={16} />}
          title={`${ownerLabel(selectedOwner)} needs to approve Mandate`}
          tone="warn"
          testId="org-restricted"
          actions={
            <>
              {data?.grantUrl && (
                <Button size="xs" variant="default" component="a" href={data.grantUrl} target="_blank" rel="noreferrer" rightSection={<IconExternalLink size={13} />}>
                  Grant access
                </Button>
              )}
              <Button type="button" size="xs" variant="subtle" color="gray" leftSection={<IconRefresh size={13} />} loading={repos.isFetching} onClick={() => void repos.refetch()}>
                Refresh
              </Button>
              {data?.reauthUrl && (
                <Button type="button"
                  size="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconLogin2 size={13} />}
                  onClick={() => {
                    saveDraft(draft);
                    window.location.assign(data.reauthUrl!);
                  }}
                >
                  Sign in again
                </Button>
              )}
            </>
          }
        >
          {ownerLabel(selectedOwner)} restricts OAuth Apps. An org owner must approve Mandate (or you can request access). After approval, refresh; signing in again shows GitHub&apos;s Grant / Request buttons for the organization.
        </Notice>
      ) : (
        <>
          <SearchField
            variant="input"
            value={q}
            onChange={setQ}
            ariaLabel="Search repositories"
            placeholder={owner === 'all' ? 'Search repositories' : `Search ${selectedOwner ? (selectedOwner.type === 'user' ? 'your' : `${ownerLabel(selectedOwner)}`) : owner} repositories`}
            loading={repos.isFetching}
            autoFocus
            // Enter in the search box never submits the step.
            onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            className="np-search"
          />
          <div className="np-repos" data-testid="repo-list">
            {repos.isLoading &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="np-repo np-repo-skeleton">
                  <Skeleton width={20} height={20} radius={5} />
                  <Skeleton height={10} width={`${40 + i * 9}%`} radius="xl" />
                  <Skeleton height={10} width={48} radius="xl" ml="auto" />
                </div>
              ))}
            {repos.isError && (
              <div className="np-repos-empty">
                <IconAlertTriangle size={18} />
                <div>Could not load repositories</div>
                <div className="np-faint">{(repos.error as Error).message}</div>
                <Button type="button" size="xs" variant="subtle" onClick={() => void repos.refetch()}>
                  Try again
                </Button>
              </div>
            )}
            {data && data.items.length === 0 && !repos.isError && (
              <div className="np-repos-empty">
                <IconSearch size={18} />
                <div>{q ? `No repositories match “${q}”` : 'No repositories here yet'}</div>
                <div className="np-faint">Create one below.</div>
              </div>
            )}
            {data?.items.map((r) => <RepoRow key={r.fullName} r={r} selected={draft.repo?.fullName === r.fullName} onPick={() => onPick(r)} />)}
          </div>
          {error && <div className="np-error">{error}</div>}
          {creating ? (
            <CreateRepo data={data} draft={draft} onCreated={(r) => (setCreating(false), onPick(r))} onCancel={() => setCreating(false)} />
          ) : (
            <UnstyledButton type="button" className="np-repo-new" onClick={() => setCreating(true)} data-testid="create-repo">
              <IconPlus size={14} />
              Create a new repo
            </UnstyledButton>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- modal */

type Progress = Partial<Record<CreateStep, 'start' | 'done'>>;

/** "Create a project": details, GitHub repository, branch + folder, confirm with live progress. Registers a project (no document writes). */
export function NewProjectModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Progress>({});
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!opened) return;
    const d = loadDraft();
    setDraft(d);
    setStep(d.repo ? 2 : d.name ? 1 : 0);
    setFieldErrors({});
    setProgress({});
    setCreated(null);
    saveDraft(null);
  }, [opened]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const idErr = null;
  const subpath = normalizeSubpath(draft.path);
  const canNext = [!!draft.name.trim(), !!draft.repo, !!draft.branch.trim() && subpath !== null, true][step]!;
  const mcpUrl = `${apiHost()}/p/${draft.id || '…'}/mcp`;

  const create = useMutation({
    mutationFn: () => {
      setProgress({});
      const body: NewProjectInput = {
        name: draft.name.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        repo: draft.repo!.fullName,
        ...(draft.branch.trim() ? { branch: draft.branch.trim() } : {}),
        ...(subpath ? { path: subpath } : {}),
      };
      return githubApi.createProjectStreaming(body, (e) => setProgress((p) => ({ ...p, [e.step]: e.status })));
    },
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      // A beat on the finished checklist, then the "connect your coding agent" step.
      setTimeout(() => setCreated({ id: project.id, name: project.name }), 600);
    },
    onError: (e) => {
      if (e instanceof UiApiError && e.path && e.path in STEP_OF) {
        setFieldErrors({ [e.path]: e.message });
        setStep(STEP_OF[e.path]!);
      }
    },
  });
  const busy = create.isPending || (create.isSuccess && !created);

  const pick = (r: GithubRepo) => {
    set({ repo: r, branch: r.defaultBranch ?? 'main' });
    setFieldErrors((f) => ({ ...f, repo: '' }));
  };
  const err = create.error instanceof UiApiError ? create.error : create.error ? new UiApiError('error', (create.error as Error).message) : null;
  const next = () => {
    if (!canNext || busy) return;
    if (step < 3) setStep(step + 1);
    else create.mutate();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    next();
  };
  const Icon = STEPS[step]!.icon;
  const branches = useMemo(() => [...new Set([draft.repo?.defaultBranch, 'main', draft.branch].filter((b): b is string => !!b))], [draft.repo, draft.branch]);

  return (
    <Modal
      opened={opened}
      onClose={() => !busy && onClose()}
      withCloseButton={false}
      padding={0}
      radius={14}
      size={created ? 760 : 640}
      centered
      overlayProps={{ backgroundOpacity: 0.28, blur: 3 }}
      classNames={{ content: 'np-modal', body: 'np-modal-body' }}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      aria-label="Create a project"
    >
      {created ? (
        <PostCreateConnect
          project={created}
          onOpen={() => {
            onClose();
            goTo(`${projectBase(created.id)}/`);
          }}
        />
      ) : (
      <form onSubmit={onSubmit} data-testid="new-project-modal">
        <header className="np-head">
          <div className="np-tile">
            <Icon size={17} stroke={1.8} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Text fw={600} size="md" className="np-title">
              Create a project
            </Text>
            <Text size="sm" className="np-subtitle">
              {STEPS[step]!.subtitle}
            </Text>
          </div>
          <ActionIcon type="button" variant="subtle" color="gray" onClick={onClose} aria-label="Close" style={busy ? { visibility: 'hidden' } : undefined}>
            <IconX size={16} />
          </ActionIcon>
        </header>
        <StepBar steps={STEPS.map((x) => x.label)} step={step} />

        <div className="np-body">
          {step === 0 && (
            <div className="np-stack">
              <Field label="Name" htmlFor="np-name" error={fieldErrors.name}>
                <TextInput
                  id="np-name"
                  size="sm"
                  placeholder="Billing platform"
                  value={draft.name}
                  data-autofocus
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    set({ name, id: slugify(name).slice(0, 36).replace(/-+$/, '') });
                  }}
                />
              </Field>
              <Field label="Id" htmlFor="np-id" error={fieldErrors.id || idErr} hint="Assigned by Mandate from the name (with a -2 suffix if it is taken); shown here as a preview.">
                <div className="np-slug" data-invalid={!!(fieldErrors.id || idErr) || undefined}>
                  <span className="np-slug-fix">{apiHost()}/p/</span>
                  <span id="np-id" className="np-slug-input" data-testid="np-id-preview" aria-readonly="true" style={{ opacity: 0.8 }}>{draft.id || 'billing-platform'}</span>
                  <span className="np-slug-fix">/mcp</span>
                </div>
              </Field>
              <Field label="Description" hint="Optional. Shown on the project card." error={fieldErrors.description}>
                <Textarea size="sm" placeholder="What does this project specify?" autosize minRows={2} maxRows={5} value={draft.description} onChange={(e) => set({ description: e.currentTarget.value })} />
              </Field>
            </div>
          )}

          {step === 1 && <RepoStep draft={draft} setOwner={(o) => set({ owner: o })} onPick={pick} error={fieldErrors.repo || fieldErrors.owner || undefined} />}

          {step === 2 && (
            <div className="np-stack">
              <Field label="Branch" error={fieldErrors.branch} hint={draft.repo?.defaultBranch ? `Default branch of ${draft.repo.fullName}: ${draft.repo.defaultBranch}` : 'The repository has no commits yet; Mandate creates this branch.'}>
                <Autocomplete
                  size="sm"
                  data={branches}
                  value={draft.branch}
                  onChange={(v) => set({ branch: v })}
                  leftSection={<IconGitBranch size={14} />}
                  className="np-mono-input"
                  comboboxProps={{ withinPortal: true }}
                  data-autofocus
                />
              </Field>
              <Field
                label="Folder"
                error={fieldErrors.path || (subpath === null ? 'Use a relative path without .. segments' : null)}
                hint="Optional. Several projects can share a repository, each in its own folder."
              >
                <TextInput size="sm" placeholder="repository root" value={draft.path} onChange={(e) => set({ path: e.currentTarget.value })} leftSection={<IconFolder size={14} />} className="np-mono-input" />
              </Field>
              <div className="np-path-preview" data-testid="path-preview">
                <IconBrandGithub size={13} />
                <span>
                  {draft.repo?.fullName}
                  <span className="np-faint">@</span>
                  {draft.branch || '…'}
                  <span className="np-faint">:</span>/{subpath ?? ''}
                </span>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="np-stack">
              <div className="np-summary">
                <SummaryRow icon={<IconFolderPlus size={14} />} label="Name" value={draft.name.trim()} />
                <SummaryRow icon={<IconHash size={14} />} label="Id" value={draft.id} mono />
                <SummaryRow icon={<IconPlug size={14} />} label="MCP URL" value={`http://${mcpUrl}`} mono />
                <SummaryRow
                  icon={<IconBrandGithub size={14} />}
                  label="Repository"
                  value={
                    <>
                      {draft.repo?.fullName}
                      <span className="np-chip np-chip-inline">
                        {draft.repo?.private ? <IconLock size={11} /> : <IconWorld size={11} />}
                        {draft.repo?.private ? 'Private' : 'Public'}
                      </span>
                    </>
                  }
                  mono
                />
                <SummaryRow icon={<IconGitBranch size={14} />} label="Branch" value={draft.branch} mono />
                <SummaryRow icon={<IconFolder size={14} />} label="Folder" value={subpath ? `/${subpath}` : '/ (repository root)'} mono />
              </div>
              {!create.isPending && !create.isSuccess && !err && (
                <Text size="sm" className="np-muted">
                  Mandate clones the repository, sets up {subpath ? <code>{subpath}/</code> : 'its root'} on <code>{draft.branch}</code>, pushes the first commit and creates an agent key for this project.
                </Text>
              )}
              {(create.isPending || create.isSuccess || (err && Object.keys(progress).length > 0)) && (
                <ol className="np-progress" data-testid="create-progress">
                  {CREATE_STEPS.map((s) => {
                    const st = progress[s];
                    const failed = !!err && st === 'start';
                    const state = create.isSuccess || st === 'done' ? 'done' : failed ? 'failed' : st === 'start' ? 'active' : 'todo';
                    return (
                      <li key={s} data-state={state}>
                        <span className="np-progress-icon">
                          {state === 'done' ? <IconCheck size={13} stroke={2.4} /> : state === 'active' ? <Loader size={12} /> : state === 'failed' ? <IconX size={13} stroke={2.4} /> : <span className="np-dot" />}
                        </span>
                        {PROGRESS[s]}
                      </li>
                    );
                  })}
                </ol>
              )}
              {err && (
                <Notice icon={<IconAlertTriangle size={16} />} title={err.message} tone="danger" testId="new-project-error">
                  {err.hint ?? `Error code: ${err.code}`}
                </Notice>
              )}
            </div>
          )}
        </div>

        <footer className="np-foot">
          <span className="np-muted np-foot-count">
            Step {step + 1} of {STEPS.length}
          </span>
          {step > 0 && !busy && (
            <Button type="button" variant="subtle" color="gray" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button
            type="submit"
            disabled={!canNext || busy}
            data-testid={step < 3 ? 'new-project-next' : 'new-project-create'}
            leftSection={busy ? <Loader size={13} color="currentColor" /> : null}
            rightSection={step < 3 ? <IconArrowRight size={15} /> : null}
            className="np-primary"
          >
            {step < 3 ? 'Continue' : create.isSuccess ? 'Opening project…' : busy ? 'Creating…' : err ? 'Try again' : 'Create project'}
          </Button>
        </footer>
      </form>
      )}
    </Modal>
  );
}

