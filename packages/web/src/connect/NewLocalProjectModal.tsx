import { ActionIcon, Button, Loader, Modal, Text, TextInput, Textarea } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconCheck, IconCloud, IconFolder, IconFolderPlus, IconGitBranch, IconHash, IconPlug, IconRocket, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { UiApiError } from '../lib/ui';
import { goTo, projectBase } from '../project';
import { LOCAL_STEPS, setupApi, tildify, type LocalProjectInput, type LocalStep } from '../setup/api';
import { ChoiceCard, FolderBrowser } from '../setup/widgets';
import { slugify } from './github';
import { Field, Notice, StepBar, SummaryRow } from './parts';
import { PostCreateConnect } from './PostCreateConnect';
import { devApiPort } from './snippets';

interface Draft {
  name: string;
  id: string;
  idTouched: boolean;
  description: string;
  mode: 'existing' | 'new';
  path: string;
  remote: string;
  branch: string;
}
const EMPTY: Draft = { name: '', id: '', idTouched: false, description: '', mode: 'existing', path: '', remote: '', branch: '' };

const STEPS = [
  { label: 'Repository', icon: IconFolder, subtitle: 'Add a git repository you already have, or start a new one.' },
  { label: 'Details', icon: IconFolderPlus, subtitle: 'Name the project. Its id becomes the MCP endpoint coding agents connect to.' },
  { label: 'Confirm', icon: IconRocket, subtitle: 'Review the setup. Mandate prepares the repository for you.' },
] as const;
const STEP_OF: Record<string, number> = { path: 0, remote: 0, branch: 0, id: 1, name: 1, description: 1 };
const PROGRESS: Record<LocalStep, string> = { init: 'Preparing the repository', register: 'Registering the project', key: 'Creating an agent key' };

const apiHost = () => {
  const port = devApiPort();
  return port ? `${window.location.hostname}:${port}` : window.location.host;
};
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? '';

/** Local mode "New project": an existing repository (prominent) or a new one in the projects folder. */
export function NewLocalProjectModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [browsing, setBrowsing] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Partial<Record<LocalStep, 'start' | 'done'>>>({});
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const setup = useQuery({ queryKey: ['setup', 'state'], queryFn: setupApi.state, enabled: opened, retry: false });
  const baseDir = setup.data?.config.local.baseDir ?? '~/mandate';
  const home = useQuery({ queryKey: ['fs', 'home'], queryFn: () => setupApi.fsList(), enabled: opened, retry: false }).data?.home ?? null;
  const inspect = useQuery({ queryKey: ['fs', 'inspect', draft.path], queryFn: () => setupApi.fsInspect(draft.path), enabled: opened && draft.mode === 'existing' && !!draft.path, retry: false });
  useEffect(() => {
    if (!opened) return;
    setStep(0);
    setDraft(EMPTY);
    setFieldErrors({});
    setProgress({});
    setCreated(null);
  }, [opened]);
  // Prefill remote / branch / name from the picked repository.
  useEffect(() => {
    const i = inspect.data;
    if (!i) return;
    setDraft((d) => {
      const name = d.name || basename(i.path).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      return { ...d, remote: d.remote || i.remote || '', branch: d.branch || i.branch || '', name, id: slugify(name).slice(0, 36).replace(/-+$/, '') };
    });
  }, [inspect.data]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const i = inspect.data;
  const repoOk = draft.mode === 'new' || (!!draft.path && !!i && !i.enclosingRepo);
  const canNext = [repoOk, !!draft.name.trim(), true][step]!;
  const target = draft.mode === 'new' ? `${baseDir.replace(/\/+$/, '')}/${draft.id || '<id>'}` : draft.path;

  const create = useMutation({
    mutationFn: () => {
      setProgress({});
      const body: LocalProjectInput = {
        name: draft.name.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        mode: draft.mode,
        ...(draft.mode === 'existing' ? { path: draft.path } : {}),
        ...(draft.remote.trim() ? { remote: draft.remote.trim() } : {}),
        ...(draft.branch.trim() ? { branch: draft.branch.trim() } : {}),
      };
      return setupApi.createLocalProject(body, (e) => setProgress((p) => ({ ...p, [e.step]: e.status })));
    },
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
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
  const err = create.error instanceof UiApiError ? create.error : create.error ? new UiApiError('error', (create.error as Error).message) : null;
  const next = () => {
    if (!canNext || busy) return;
    if (step < 2) setStep(step + 1);
    else create.mutate();
  };
  const Icon = STEPS[step]!.icon;

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
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            next();
          }}
          data-testid="new-project-modal"
        >
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
          <StepBar steps={STEPS.map((s) => s.label)} step={step} />
          <div className="np-body">
            {step === 0 && (
              <div className="np-stack">
                <div className="su-choices" role="radiogroup">
                  <ChoiceCard
                    selected={draft.mode === 'existing'}
                    onSelect={() => set({ mode: 'existing' })}
                    title="Add an existing repo"
                    description="A git repository (or plain folder) on this computer. Mandate keeps its specs in it."
                    icon={<IconFolder size={18} />}
                    recommended
                    testId="local-existing"
                  >
                    <div className="np-stack">
                      <Field label="Folder" error={fieldErrors.path || (i?.enclosingRepo ? `This folder is inside the repository ${tildify(i.enclosingRepo, home)}; pick its root instead.` : null)}>
                        <div className="su-pick" data-testid="local-path">
                          <code className={draft.path ? 'su-pick-value' : 'su-pick-value np-faint'}>{draft.path ? tildify(draft.path, home) : 'No folder chosen'}</code>
                          <Button type="button" size="xs" variant={draft.path ? 'default' : 'filled'} onClick={() => setBrowsing(true)} data-testid="local-browse">
                            {draft.path ? 'Change…' : 'Choose folder…'}
                          </Button>
                        </div>
                      </Field>
                      {inspect.isFetching && <Loader size={12} />}
                      {i && !i.enclosingRepo && (
                        <div className="su-card su-kv" data-testid="local-inspect">
                          <span>Repository</span>
                          <b>{i.isGitRepo ? 'git repository' : 'plain folder (Mandate runs git init)'}</b>
                          <span>Remote</span>
                          {i.remote ? <code>{i.remote}</code> : <span className="np-faint">none</span>}
                          <span>Branch</span>
                          {i.branch ? <code>{i.branch}</code> : <span className="np-faint">—</span>}
                          {i.hasMandateLayout && (
                            <>
                              <span>Specs</span>
                              <b>Mandate files found</b>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </ChoiceCard>
                  <ChoiceCard
                    selected={draft.mode === 'new'}
                    onSelect={() => set({ mode: 'new' })}
                    title="New repo"
                    description={`A fresh git repository in your projects folder (${tildify(baseDir, home)}).`}
                    icon={<IconFolderPlus size={18} />}
                    testId="local-new"
                  />
                </div>
                <Field label="Remote (optional)" hint="Mandate pushes here with your own git credentials. Leave empty to keep the project on this computer." error={fieldErrors.remote}>
                  <TextInput size="sm" value={draft.remote} onChange={(e) => set({ remote: e.currentTarget.value })} placeholder="git@github.com:you/specs.git" leftSection={<IconCloud size={14} />} className="np-mono-input" />
                </Field>
                <Field label="Branch" hint={draft.mode === 'existing' && i?.branch ? `Current branch: ${i.branch}` : 'Default: main'} error={fieldErrors.branch}>
                  <TextInput size="sm" value={draft.branch} onChange={(e) => set({ branch: e.currentTarget.value })} placeholder="main" leftSection={<IconGitBranch size={14} />} className="np-mono-input" />
                </Field>
              </div>
            )}
            {step === 1 && (
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
                <Field label="Id" htmlFor="np-id" error={fieldErrors.id} hint="Assigned by Mandate from the name (with a -2 suffix if it is taken); shown here as a preview.">
                  <div className="np-slug">
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
            {step === 2 && (
              <div className="np-stack">
                <div className="np-summary">
                  <SummaryRow icon={<IconFolderPlus size={14} />} label="Name" value={draft.name.trim()} />
                  <SummaryRow icon={<IconHash size={14} />} label="Id" value={draft.id} mono />
                  <SummaryRow icon={<IconPlug size={14} />} label="MCP URL" value={`http://${apiHost()}/p/${draft.id}/mcp`} mono />
                  <SummaryRow icon={<IconFolder size={14} />} label={draft.mode === 'new' ? 'New repository' : 'Repository'} value={tildify(target, home)} mono />
                  <SummaryRow icon={<IconCloud size={14} />} label="Remote" value={draft.remote.trim() || 'none (this computer only)'} mono={!!draft.remote.trim()} />
                  <SummaryRow icon={<IconGitBranch size={14} />} label="Branch" value={draft.branch.trim() || 'main'} mono />
                </div>
                {!create.isPending && !create.isSuccess && !err && (
                  <Text size="sm" className="np-muted">
                    {draft.mode === 'new' ? 'Mandate creates the folder and runs git init' : i?.isGitRepo ? 'Mandate registers the repository' : 'Mandate runs git init in the folder'}, then creates an agent key for this project. Your files are not changed.
                  </Text>
                )}
                {(create.isPending || create.isSuccess || (err && Object.keys(progress).length > 0)) && (
                  <ol className="np-progress" data-testid="create-progress">
                    {LOCAL_STEPS.map((s) => {
                      const st = progress[s];
                      const state = create.isSuccess || st === 'done' ? 'done' : err && st === 'start' ? 'failed' : st === 'start' ? 'active' : 'todo';
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
              data-testid={step < 2 ? 'new-project-next' : 'new-project-create'}
              leftSection={busy ? <Loader size={13} color="currentColor" /> : null}
              rightSection={step < 2 ? <IconArrowRight size={15} /> : null}
              className="np-primary"
            >
              {step < 2 ? 'Continue' : create.isSuccess ? 'Done' : busy ? 'Creating…' : err ? 'Try again' : 'Create project'}
            </Button>
          </footer>
        </form>
      )}
      <FolderBrowser opened={browsing} onClose={() => setBrowsing(false)} onPick={(p) => set({ path: p, remote: '', branch: '' })} initial={draft.path || undefined} title="Choose a repository" pickLabel="Use this folder" />
    </Modal>
  );
}
