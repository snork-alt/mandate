import { ActionIcon, Anchor, Autocomplete, Button, Group, CloseButton, Loader, Modal, Select, Skeleton, Switch, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBrandGithub,
  IconBuilding,
  IconCheck,
  IconCode,
  IconExternalLink,
  IconFileText,
  IconFolderPlus,
  IconGitBranch,
  IconHash,
  IconLock,
  IconLogin2,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { relativeTime } from '../lib/time';
import { goTo, projectBase } from '../project';
import { clearDraft, restoreDraft, stashDraft, withResume } from './newProjectDraft';
import { CREATE_STEPS, githubApi, slugify, UiApiError, type CreateStep, type GithubRepo, type NewProjectInput, type RepoList } from './github';
import { devApiPort } from './snippets';
import { Notice, SummaryRow } from './parts';
import { OwnerAvatar, OwnerTabs, ownerLabel } from './ownerTabs';
import { PostCreateConnect } from './PostCreateConnect';
import { buildCodeRef } from '@mandate/shared';
import './newProject.css';

interface Draft {
  name: string;
  id: string;
  idTouched: boolean;
  description: string;
  repo: GithubRepo | null;
  branch: string;
  owner: string;
}

const EMPTY: Draft = { name: '', id: '', idTouched: false, description: '', repo: null, branch: '', owner: 'all' };
/** One line per step, shown above its fields. */
const STEPS = [
  { label: 'Details', lead: 'Give the project a name. Coding agents connect to it by its id.' },
  { label: 'Specs repository', lead: 'Choose the repository for the specs, then its branch.' },
  { label: 'Confirm', lead: 'Check the setup. Mandate prepares the specs repository when you create the project.' },
] as const;

/** Which step a server error's `path` belongs to. */
const STEP_OF: Record<string, number> = { id: 0, name: 0, description: 0, repo: 1, owner: 1, branch: 1, path: 1 };

const PROGRESS: Record<CreateStep, string> = { clone: 'Cloning the repository', init: 'Initialising the project', push: 'Pushing the first commit', key: 'Creating an agent key' };

/** `localhost:4000` (where coding agents reach the API). */
function apiHost(): string {
  const port = devApiPort();
  if (typeof window === 'undefined') return 'localhost:4000';
  return port ? `${window.location.hostname}:${port}` : window.location.host;
}


/* ---------------------------------------------------------------- pieces */

function Stepper({ step, onStep }: { step: number; onStep: (i: number) => void }) {
  return (
    <ol className="pj-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.flatMap((s, i) => {
        const state = i === step ? 'current' : i < step ? 'done' : 'next';
        const item = (
          <li key={s.label} className="pj-step" data-state={state}>
            <UnstyledButton type="button" className="pj-step-btn" onClick={() => i < step && onStep(i)} disabled={i >= step} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="pj-dot">{i < step ? <IconCheck size={12} stroke={3} /> : i + 1}</span>
              <span className="pj-step-label">{s.label}</span>
            </UnstyledButton>
          </li>
        );
        return i < STEPS.length - 1 ? [item, <li key={`${s.label}-line`} className="pj-line" data-done={i < step || undefined} aria-hidden="true" />] : [item];
      })}
    </ol>
  );
}

function RepoRow({ r, selected, onPick }: { r: GithubRepo; selected: boolean; onPick: () => void }) {
  return (
    <UnstyledButton type="button" className="np-repo pj-repo" data-selected={selected || undefined} onClick={onPick} data-testid={`repo-${r.fullName}`} aria-pressed={selected}>
      <OwnerAvatar url={r.ownerAvatarUrl} login={r.owner} size={24} />
      <span className="np-repo-main">
        <span className="np-repo-name">
          <span className="np-repo-owner">{r.owner}/</span>
          <b>{r.name}</b>
        </span>
        {r.description && <span className="np-repo-desc">{r.description}</span>}
      </span>
      {r.empty && <span className="np-chip pj-hide-phone">Empty</span>}
      <span className="np-chip">
        {r.private ? <IconLock size={11} /> : <IconWorld size={11} />}
        <span className="pj-hide-phone">{r.private ? 'Private' : 'Public'}</span>
      </span>
      <span className="np-repo-time pj-hide-phone">{r.pushedAt ? relativeTime(r.pushedAt) : 'never pushed'}</span>
      <span className="pj-radio" aria-hidden="true">
        {selected && <IconCheck size={12} stroke={3} />}
      </span>
    </UnstyledButton>
  );
}

function InstallLink({ url, onLeave }: { url: string | null; onLeave: () => void }) {
  if (!url) return null;
  return (
    <Anchor href={url} onClick={() => onLeave()} target="_blank" rel="noreferrer" size="sm" className="pj-install" data-testid="install-app">
      Install the GitHub App on more repositories
      <IconExternalLink size={13} />
    </Anchor>
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
  const nameErr = name && !/^[A-Za-z0-9._-]+$/.test(name.trim()) ? 'Use letters, digits, dots, dashes and underscores' : null;
  return (
    <div className="pj-create" data-testid="create-repo-form">
      <Text fw={600} size="sm">
        New GitHub repository
      </Text>
      <div className="pj-create-row">
        <Select
          size="md"
          label="Owner"
          value={owner}
          onChange={(v) => v && setOwner(v)}
          allowDeselect={false}
          data={owners.map((o) => ({ value: o.login, label: o.type === 'user' ? `${o.login} (you)` : ownerLabel(o) }))}
          leftSection={<OwnerAvatar url={owners.find((o) => o.login === owner)?.avatarUrl} login={owner || '?'} size={20} />}
          comboboxProps={{ withinPortal: true }}
          error={err?.path === 'owner' ? err.message : null}
        />
        <TextInput
          size="md"
          label="Repository name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="specs"
          data-autofocus
          className="np-mono-input"
          error={nameErr || (err && err.path !== 'owner' ? err.message : null)}
        />
      </div>
      <Switch size="md" label="Private repository" description="Only people you give access on GitHub can see it." checked={isPrivate} onChange={(e) => setIsPrivate(e.currentTarget.checked)} />
      {err?.hint && <Text size="sm" className="np-muted">{err.hint}</Text>}
      {create.isError && !err && <Text size="sm" c="red">{(create.error as Error).message}</Text>}
      <div className="pj-create-actions">
        <Button type="button" size="sm" variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" loading={create.isPending} disabled={!name.trim() || !owner || !!nameErr} onClick={() => create.mutate()} data-testid="create-repo-submit">
          Create repository
        </Button>
      </div>
    </div>
  );
}

function RepoStep({ draft, setOwner, onPick, onLeave, error }: { draft: Draft; setOwner: (o: string) => void; onPick: (r: GithubRepo) => void; /** Stash the form before going to GitHub; returns the resume nonce. */ onLeave: () => string; error?: string }) {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const owner = draft.owner || 'all';
  const repos = useQuery({ queryKey: ['github', 'repos', owner, debounced], queryFn: ({ signal }) => githubApi.repos(debounced, owner, signal), staleTime: 30_000, placeholderData: (prev) => prev });
  const [creating, setCreating] = useState(false);
  const data = repos.data;
  const owners = data?.owners ?? [];
  const selectedOwner = owners.find((o) => o.login === owner);
  const installUrl = data?.app?.installUrl ?? null;

  if (data?.needsScope) {
    const upgrade = (url: string) => {
      window.location.assign(withResume(url, onLeave()));
    };
    return (
      <Notice
        icon={<IconLock size={16} />}
        title="GitHub permission needed"
        testId="needs-scope"
        actions={
          <>
            <Button type="button" size="sm" leftSection={<IconBrandGithub size={15} />} onClick={() => upgrade(data.upgradeUrl)}>
              Grant repo access
            </Button>
            <Button type="button" size="sm" variant="default" onClick={() => upgrade(data.upgradeUrlPublic)}>
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
  const placeholder = owner === 'all' ? 'Search repositories' : selectedOwner?.type === 'user' ? 'Search your repositories' : `Search ${selectedOwner ? ownerLabel(selectedOwner) : owner} repositories`;
  return (
    <div className="pj-repo-step">
      {owners.length > 0 && <OwnerTabs owners={owners} value={owner} onChange={(o) => (setOwner(o), setCreating(false))} addUrl={installUrl ?? data?.grantUrl} app={!!installUrl} onLeave={() => onLeave()} />}
      {restricted ? (
        <Notice
          icon={<IconBuilding size={16} />}
          title={`${ownerLabel(selectedOwner)} needs to approve Mandate`}
          tone="warn"
          testId="org-restricted"
          actions={
            <>
              {data?.grantUrl && (
                <Button size="sm" variant="default" component="a" href={data.grantUrl} onClick={onLeave} target="_blank" rel="noreferrer" rightSection={<IconExternalLink size={13} />}>
                  Grant access
                </Button>
              )}
              <Button type="button" size="sm" variant="subtle" color="gray" leftSection={<IconRefresh size={14} />} loading={repos.isFetching} onClick={() => void repos.refetch()}>
                Refresh
              </Button>
              {data?.reauthUrl && (
                <Button
                  type="button"
                  size="sm"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconLogin2 size={14} />}
                  onClick={() => {
                    window.location.assign(withResume(data.reauthUrl!, onLeave()));
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
      ) : creating ? (
        <CreateRepo data={data} draft={draft} onCreated={(r) => (setCreating(false), onPick(r))} onCancel={() => setCreating(false)} />
      ) : (
        <>
          <TextInput
            size="md"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            aria-label="Search repositories"
            placeholder={placeholder}
            leftSection={<IconSearch size={16} />}
            rightSection={repos.isFetching && !repos.isLoading ? <Loader size={14} /> : q ? <CloseButton size="sm" aria-label="Clear search" onClick={() => setQ('')} /> : null}
            autoFocus
            // Enter in the search box never submits the step; Esc clears it before closing the dialog.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
              if (e.key === 'Escape' && q) (e.preventDefault(), e.stopPropagation(), setQ(''));
            }}
            data-testid="repo-search"
          />
          <div className="np-repos pj-repos" data-testid="repo-list" aria-busy={repos.isFetching || undefined}>
            {repos.isLoading &&
              [0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="np-repo pj-repo np-repo-skeleton" aria-hidden="true">
                  <Skeleton width={24} height={24} radius={6} />
                  <span className="np-repo-main" style={{ gap: 6 }}>
                    <Skeleton height={10} width={`${36 + ((i * 13) % 30)}%`} radius="xl" />
                    <Skeleton height={8} width={`${50 + ((i * 7) % 25)}%`} radius="xl" />
                  </span>
                  <Skeleton height={10} width={56} radius="xl" />
                </div>
              ))}
            {repos.isError && (
              <div className="np-repos-empty pj-empty">
                <span className="pj-empty-icon" data-tone="danger">
                  <IconAlertTriangle size={18} />
                </span>
                <Text size="sm" fw={500}>
                  Could not load repositories
                </Text>
                <Text size="sm" className="np-muted">
                  {(repos.error as Error).message}
                </Text>
                <Button type="button" size="sm" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => void repos.refetch()} mt={6}>
                  Try again
                </Button>
              </div>
            )}
            {data && data.items.length === 0 && !repos.isError && (
              <div className="np-repos-empty pj-empty" data-testid="repo-empty">
                <span className="pj-empty-icon">
                  <IconSearch size={18} />
                </span>
                <Text size="sm" fw={500}>
                  {q ? `No repositories match “${q}”` : 'No repositories here yet'}
                </Text>
                <Text size="sm" className="np-muted">
                  {installUrl ? 'Mandate only sees repositories where its GitHub App is installed.' : q ? 'Check the spelling. If it belongs to an organization that isn’t listed, give Mandate access to it, then refresh.' : 'Create a new repository to get started.'}
                </Text>
                {!installUrl && q && data?.grantUrl && (
                  <Group gap="xs" justify="center" mt={6}>
                    <Button component="a" href={data.grantUrl} onClick={onLeave} target="_blank" rel="noreferrer" size="sm" variant="default" leftSection={<IconBrandGithub size={15} />} rightSection={<IconExternalLink size={13} />}>
                      Give access to an organization
                    </Button>
                    <Button type="button" size="sm" variant="subtle" color="gray" leftSection={<IconRefresh size={14} />} loading={repos.isFetching} onClick={() => void repos.refetch()}>
                      Refresh
                    </Button>
                  </Group>
                )}
                {installUrl && (
                  <Button component="a" href={installUrl} onClick={onLeave} target="_blank" rel="noreferrer" size="sm" variant="default" leftSection={<IconBrandGithub size={15} />} rightSection={<IconExternalLink size={13} />} mt={6}>
                    Install the GitHub App
                  </Button>
                )}
              </div>
            )}
            {data?.items.map((r) => <RepoRow key={r.fullName} r={r} selected={draft.repo?.fullName === r.fullName} onPick={() => onPick(r)} />)}
          </div>
          {error && (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          )}
          <div className="pj-repo-actions">
            <Button type="button" size="sm" variant="default" leftSection={<IconPlus size={15} />} onClick={() => setCreating(true)} data-testid="create-repo">
              Create a new repository
            </Button>
            {!!data?.items.length && <InstallLink url={installUrl} onLeave={onLeave} />}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- modal */

type Progress = Partial<Record<CreateStep, 'start' | 'done'>>;

/** "New project": details, GitHub repository, branch + folder, confirm with live progress. Registers a project (no document writes). */
export function NewProjectModal({ opened, onClose, resume }: { opened: boolean; onClose: () => void; /** Nonce of a form stashed before a GitHub round trip (restored on open). */ resume?: string | null }) {
  const qc = useQueryClient();
  const phone = useMediaQuery('(max-width: 36em)');
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Steps whose Continue was pressed while invalid: their missing fields show inline errors. */
  const [tried, setTried] = useState<Record<number, boolean>>({});
  const [progress, setProgress] = useState<Progress>({});
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!opened) return;
    const back = resume !== undefined ? restoreDraft<Draft>(resume) : null;
    const d: Draft = back ? { ...EMPTY, ...back.draft } : EMPTY;
    setDraft(d);
    setStep(back ? Math.min(back.step, d.name ? 1 : 0) : 0);
    if (back) void qc.invalidateQueries({ queryKey: ['github'] });
    setFieldErrors({});
    setTried({});
    setProgress({});
    setCreated(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const canNext = [!!draft.name.trim(), !!draft.repo && !!draft.branch.trim(), true][step]!;
  const mcpUrl = `${apiHost()}/p/${draft.id || '…'}/mcp`;

  const create = useMutation({
    mutationFn: () => {
      setProgress({});
      const body: NewProjectInput = {
        name: draft.name.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        repo: draft.repo!.fullName,
        ...(draft.branch.trim() ? { branch: draft.branch.trim() } : {}),
      };
      return githubApi.createProjectStreaming(body, (e) => setProgress((p) => ({ ...p, [e.step]: e.status })));
    },
    onSuccess: ({ project }) => {
      clearDraft();
      void qc.invalidateQueries({ queryKey: ['projects'] });
      // A beat on the finished checklist, then the "connect your coding agent" step.
      setTimeout(() => setCreated({ id: project.id, name: project.name }), 900);
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
    if (busy) return;
    if (!canNext) {
      setTried((t) => ({ ...t, [step]: true }));
      return;
    }
    if (step < 2) setStep(step + 1);
    else create.mutate();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    next();
  };
  const branches = useMemo(() => [...new Set([draft.repo?.defaultBranch, 'main', draft.branch].filter((b): b is string => !!b))], [draft.repo, draft.branch]);
  const shown = tried[step];
  const nameErr = fieldErrors.name || (shown && !draft.name.trim() ? 'Give the project a name' : null);
  const branchErr = fieldErrors.branch || (shown && !draft.branch.trim() ? 'Enter a branch name' : null);
  const repoErr = fieldErrors.repo || fieldErrors.owner || (shown && !draft.repo ? 'Pick a repository to continue' : undefined);

  return (
    <Modal
      opened={opened}
      onClose={() => !busy && onClose()}
      withCloseButton={false}
      padding={0}
      radius={phone ? 0 : 14}
      size={created ? 760 : 640}
      fullScreen={!!phone}
      centered
      overlayProps={{ backgroundOpacity: 0.32, blur: 3 }}
      classNames={{ content: 'np-modal pj-modal', body: 'np-modal-body pj-modal-body' }}
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
        <form onSubmit={onSubmit} data-testid="new-project-modal" className="pj-form" noValidate>
          <header className="pj-head">
            <div className="pj-tile">
              <IconFolderPlus size={20} stroke={1.7} />
            </div>
            <div className="pj-head-text">
              <Text component="h2" className="pj-title">
                New project
              </Text>
              <Text size="sm" className="np-muted">
                A project keeps your specs in a GitHub repository and links the code they describe.
              </Text>
            </div>
            <ActionIcon type="button" variant="subtle" color="gray" size="md" onClick={onClose} aria-label="Close" style={busy ? { visibility: 'hidden' } : undefined}>
              <IconX size={17} />
            </ActionIcon>
          </header>
          <Stepper step={step} onStep={(i) => !busy && setStep(i)} />

          <div className="pj-body">
            <Text size="sm" className="pj-lead">
              {STEPS[step]!.lead ?? (
                <>
                  The repositories where the code lives. Coding agents reference them by short name, like <code>{buildCodeRef({ repo: 'web-app', path: 'src/auth.ts' })}</code>, and record the commit they worked on.
                </>
              )}
            </Text>

            {step === 0 && (
              <div className="pj-stack">
                <TextInput
                  id="np-name"
                  size="md"
                  label="Name"
                  description="Shown in the sidebar and on the project card."
                  placeholder="Billing platform"
                  value={draft.name}
                  data-autofocus
                  error={nameErr}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    set({ name, id: slugify(name).slice(0, 36).replace(/-+$/, '') });
                    setFieldErrors((f) => ({ ...f, name: '', id: '' }));
                  }}
                />
                <div className="pj-field">
                  <label className="pj-label" htmlFor="np-id">
                    Agent endpoint
                  </label>
                  <Text size="sm" className="pj-desc">
                    Made from the name. If the id is taken, Mandate adds <code>-2</code>.
                  </Text>
                  <div className="pj-endpoint" data-invalid={!!fieldErrors.id || undefined}>
                    <IconPlug size={16} className="pj-endpoint-icon" />
                    <span className="np-faint">{apiHost()}/p/</span>
                    <span id="np-id" className="pj-endpoint-id" data-empty={!draft.id || undefined} data-testid="np-id-preview" aria-readonly="true">
                      {draft.id || 'billing-platform'}
                    </span>
                    <span className="np-faint">/mcp</span>
                  </div>
                  {fieldErrors.id && (
                    <Text size="sm" c="red">
                      {fieldErrors.id}
                    </Text>
                  )}
                </div>
                <Textarea
                  size="md"
                  label="Description"
                  description="Optional. Shown on the project card."
                  placeholder="What does this project specify?"
                  autosize
                  minRows={2}
                  maxRows={5}
                  value={draft.description}
                  error={fieldErrors.description}
                  onChange={(e) => set({ description: e.currentTarget.value })}
                />
              </div>
            )}

            {step === 1 && (
              <div className="pj-stack">
                <Notice icon={<IconFileText size={16} />} title={<>Use a dedicated repository for specs.</>} testId="specs-dedicated">
                  Mandate writes to it.
                </Notice>
                <RepoStep
                  draft={draft}
                  setOwner={(o) => set({ owner: o })}
                  onPick={(r) => {
                    pick(r);
                    setFieldErrors((f) => ({ ...f, owner: '' }));
                  }}
                  onLeave={() => stashDraft(draft, 1)}
                  error={repoErr || undefined}
                />
                {draft.repo && (
                  <Autocomplete
                    size="md"
                    label="Branch"
                    description={draft.repo.defaultBranch ? `The repository's default branch is ${draft.repo.defaultBranch}.` : 'The repository has no commits yet; Mandate creates this branch.'}
                    data={branches}
                    value={draft.branch}
                    onChange={(v) => (set({ branch: v }), setFieldErrors((f) => ({ ...f, branch: '' })))}
                    leftSection={<IconGitBranch size={16} />}
                    className="np-mono-input pj-branch"
                    comboboxProps={{ withinPortal: true }}
                    error={branchErr}
                    data-testid="specs-branch"
                  />
                )}
              </div>
            )}

            {step === 2 && (
              <div className="pj-stack">
                <div className="np-summary">
                  <SummaryRow icon={<IconFolderPlus size={14} />} label="Name" value={draft.name.trim()} />
                  <SummaryRow icon={<IconHash size={14} />} label="Id" value={draft.id} mono />
                  <SummaryRow icon={<IconPlug size={14} />} label="MCP URL" value={`http://${mcpUrl}`} mono />
                  <SummaryRow
                    icon={<IconFileText size={14} />}
                    label="Specs repository"
                    value={
                      <>
                        {draft.repo?.fullName}
                        <span className="np-faint">@</span>
                        {draft.branch}
                        <span className="np-chip np-chip-inline">
                          {draft.repo?.private ? <IconLock size={11} /> : <IconWorld size={11} />}
                          {draft.repo?.private ? 'Private' : 'Public'}
                        </span>
                      </>
                    }
                    mono
                  />
                </div>
                {!create.isPending && !create.isSuccess && !err && (
                  <Text size="sm" className="np-muted">
                    Mandate clones <code>{draft.repo?.fullName}</code>, sets it up on <code>{draft.branch}</code>, pushes the first commit and creates an agent key for this project.
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
                {create.isSuccess && (
                  <Notice icon={<IconCheck size={16} />} title="Project created" tone="ok" testId="new-project-success">
                    Next: connect your coding agent.
                  </Notice>
                )}
                {err && (
                  <Notice icon={<IconAlertTriangle size={16} />} title={err.message} tone="danger" testId="new-project-error">
                    {err.hint ?? `Error code: ${err.code}`}
                  </Notice>
                )}
              </div>
            )}
          </div>

          <footer className="pj-foot">
            {busy ? (
              <span />
            ) : step === 0 ? (
              <Button type="button" size="sm" variant="default" onClick={onClose} data-testid="new-project-cancel">
                Cancel
              </Button>
            ) : (
              <Button type="button" size="sm" variant="subtle" color="gray" leftSection={<IconArrowLeft size={15} />} onClick={() => setStep(step - 1)} className="pj-back">
                Back
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={busy || !canNext}
              data-busy={busy || undefined}
              data-testid={step < 2 ? 'new-project-next' : 'new-project-create'}
              leftSection={busy ? <Loader size={14} color="currentColor" /> : step === 2 && !err ? <IconBrandGithub size={15} /> : err && step === 2 ? <IconRefresh size={15} /> : null}
              rightSection={step < 2 ? <IconArrowRight size={15} /> : null}
              className="np-primary"
            >
              {step < 2 ? 'Continue' : create.isSuccess ? 'Opening project…' : busy ? 'Creating…' : err ? 'Try again' : 'Create project'}
            </Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
