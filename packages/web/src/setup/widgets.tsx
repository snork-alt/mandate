/** Guided-setup widgets: intro, recommended choice cards, Test button, copy fields, write-only secrets, folder browser. */
import { ActionIcon, Button, Code, Group, Loader, Modal, PasswordInput, Skeleton, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconArrowUp, IconCheck, IconCopy, IconFile, IconFolder, IconFolderPlus, IconGitBranch, IconHome, IconPlayerPlay, IconX } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { copyText } from '../lib/copy';
import { Notice } from '../connect/parts';
import { setupApi, tildify } from './api';

/** The one-paragraph "what and why" at the top of a step. */
export function StepIntro({ title, children, optional }: { title: string; children: ReactNode; optional?: boolean }) {
  return (
    <div className="su-intro">
      <Group gap={8} align="center">
        <Text component="h2" fw={600} size="lg" className="su-intro-title">
          {title}
        </Text>
        {optional && <span className="su-badge">Optional</span>}
      </Group>
      <Text size="sm" className="su-intro-body">
        {children}
      </Text>
    </div>
  );
}

export const Recommended = () => <span className="su-badge su-badge-rec">Recommended</span>;

/** A radio card (the recommended one is preselected by the caller). */
export function ChoiceCard({ selected, onSelect, title, description, icon, recommended, testId, children }: { selected: boolean; onSelect: () => void; title: ReactNode; description: ReactNode; icon?: ReactNode; recommended?: boolean; testId?: string; children?: ReactNode }) {
  return (
    <div className="su-choice" data-selected={selected || undefined} data-testid={testId}>
      <UnstyledButton type="button" className="su-choice-head" onClick={onSelect} role="radio" aria-checked={selected}>
        <span className="su-radio" aria-hidden="true" />
        {icon && <span className="su-choice-icon">{icon}</span>}
        <span className="su-choice-text">
          <span className="su-choice-title">
            {title}
            {recommended && <Recommended />}
          </span>
          <span className="su-choice-desc">{description}</span>
        </span>
      </UnstyledButton>
      {selected && children && <div className="su-choice-body">{children}</div>}
    </div>
  );
}

/** "What happens next" footnote of a step. */
export function NextNote({ children }: { children: ReactNode }) {
  return (
    <div className="su-next">
      <span className="su-next-label">What happens next</span>
      <span>{children}</span>
    </div>
  );
}

/** A value to paste somewhere else, with a copy button. */
export function CopyField({ label, value, testId }: { label?: string; value: string; testId?: string }) {
  return (
    <div className="su-copy" data-testid={testId}>
      {label && <span className="su-copy-label">{label}</span>}
      <code className="su-copy-value">{value}</code>
      <Tooltip label="Copy">
        <ActionIcon type="button" variant="subtle" color="gray" size="sm" aria-label={`Copy ${label ?? 'value'}`} onClick={() => void copyText(value, 'Copied')}>
          <IconCopy size={14} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}

/** A shell command with copy (getmandate first, the dev script second). */
export function CommandLine({ cmd }: { cmd: string }) {
  return <CopyField value={cmd} />;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/** "Test" button with a clear success / fix message under it. */
export function TestButton({ run, label = 'Test', disabled, testId }: { run: () => Promise<TestResult>; label?: string; disabled?: boolean; testId?: string }) {
  const m = useMutation({ mutationFn: run });
  const r = m.data;
  return (
    <div className="su-test">
      <Button type="button" size="xs" variant="default" leftSection={<IconPlayerPlay size={13} />} loading={m.isPending} disabled={disabled} onClick={() => m.mutate()} data-testid={testId}>
        {label}
      </Button>
      {r && (
        <span className="su-test-result" data-ok={r.ok || undefined}>
          {r.ok ? <IconCheck size={14} stroke={2.4} /> : <IconX size={14} stroke={2.4} />}
          {r.message}
        </span>
      )}
      {m.isError && (
        <span className="su-test-result">
          <IconX size={14} stroke={2.4} />
          {(m.error as Error).message}
        </span>
      )}
    </div>
  );
}

/**
 * Write-only secret stored by the server (`~/.mandate/secrets.env`). Never shows the value: "Set ✓ · Replace ·
 * Remove", or an input when not set (or replacing). `onSaved` after a change.
 */
export function SecretField({ name, isSet, label, placeholder, onSaved, testId }: { name: string; isSet: boolean; label: string; placeholder?: string; onSaved?: (set: boolean) => void; testId?: string }) {
  const [editing, setEditing] = useState(!isSet);
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: (v: string | null) => setupApi.secret(name, v),
    onSuccess: (r) => {
      setValue('');
      setEditing(!r.set);
      onSaved?.(r.set);
    },
  });
  return (
    <div className="np-field" data-testid={testId}>
      <div className="np-label-row">
        <span className="np-label">{label}</span>
        <code className="su-env">{name}</code>
      </div>
      {isSet && !editing ? (
        <div className="su-secret-set">
          <span className="su-secret-ok">
            <IconCheck size={14} stroke={2.4} /> Set
          </span>
          <span className="np-faint">·</span>
          <Button type="button" size="compact-xs" variant="subtle" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <span className="np-faint">·</span>
          <Button type="button" size="compact-xs" variant="subtle" color="red" loading={save.isPending} onClick={() => save.mutate(null)}>
            Remove
          </Button>
        </div>
      ) : (
        <Group gap={6} wrap="nowrap">
          <PasswordInput size="sm" value={value} onChange={(e) => setValue(e.currentTarget.value)} placeholder={placeholder ?? 'Paste the secret'} style={{ flex: 1 }} autoComplete="off" />
          <Button type="button" size="sm" variant="default" disabled={!value.trim()} loading={save.isPending} onClick={() => save.mutate(value.trim())}>
            Save
          </Button>
          {isSet && (
            <Button type="button" size="sm" variant="subtle" color="gray" onClick={() => (setEditing(false), setValue(''))}>
              Cancel
            </Button>
          )}
        </Group>
      )}
      <div className="np-hint">Stored in ~/.mandate/secrets.env (mode 0600), never in config.json and never shown again.</div>
      {save.isError && <div className="np-error">{(save.error as Error).message}</div>}
    </div>
  );
}

/** Folder picker confined to the home directory (directories only; git repos marked). */
export function FolderBrowser({ opened, onClose, onPick, initial, title = 'Choose a folder', pickLabel, files = false, hidden = false }: { opened: boolean; onClose: () => void; onPick: (path: string) => void; initial?: string; title?: string; pickLabel?: string; files?: boolean; hidden?: boolean }) {
  const [path, setPath] = useState<string | undefined>(initial);
  const [file, setFile] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['fs', 'list', path ?? '', files, hidden], queryFn: () => setupApi.fsList(path, { files, hidden }), enabled: opened, retry: false });
  const mkdir = useMutation({
    mutationFn: (name: string) => setupApi.fsMkdir(`${list.data!.path}/${name}`),
    onSuccess: (r) => {
      setNewName(null);
      setPath(r.path);
    },
  });
  const d = list.data;
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>{title}</Text>} size={560} radius={14} centered overlayProps={{ backgroundOpacity: 0.28, blur: 3 }} zIndex={400}>
      <div className="su-fs-bar">
        <ActionIcon type="button" variant="subtle" color="gray" disabled={!d?.parent} onClick={() => d?.parent && setPath(d.parent)} aria-label="Parent folder">
          <IconArrowUp size={15} />
        </ActionIcon>
        <ActionIcon type="button" variant="subtle" color="gray" onClick={() => setPath(d?.home)} aria-label="Home folder">
          <IconHome size={15} />
        </ActionIcon>
        <code className="su-fs-path" data-testid="fs-path">
          {d ? tildify(d.path, d.home) : '…'}
        </code>
      </div>
      <div className="su-fs-list" data-testid="fs-list">
        {list.isLoading && [0, 1, 2, 3].map((i) => <Skeleton key={i} height={30} radius="sm" mb={4} />)}
        {list.isError && (
          <Notice icon={<IconAlertTriangle size={16} />} title="Cannot open this folder" tone="danger">
            {(list.error as Error).message}
          </Notice>
        )}
        {d && d.entries.length === 0 && <div className="su-fs-empty">No folders here.</div>}
        {d?.entries.map((e) => (
          <UnstyledButton
            type="button"
            key={e.path}
            className="su-fs-row"
            data-selected={file === e.path || undefined}
            onClick={() => (e.isDir === false ? setFile(e.path) : (setPath(e.path), setFile(null)))}
            onDoubleClick={() => e.isDir === false && (onPick(e.path), onClose())}
            data-testid={`fs-${e.name}`}
          >
            {e.isDir === false ? <IconFile size={15} /> : e.isGitRepo ? <IconGitBranch size={15} className="su-fs-git" /> : <IconFolder size={15} />}
            <span className="su-fs-name">{e.name}</span>
            {e.isGitRepo && <span className="np-chip">git repo</span>}
          </UnstyledButton>
        ))}
      </div>
      {newName !== null ? (
        <Group gap={6} mt="sm" wrap="nowrap">
          <TextInput size="sm" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="new-folder" style={{ flex: 1 }} data-autofocus />
          <Button type="button" size="sm" variant="default" disabled={!newName.trim() || /[/\\]/.test(newName)} loading={mkdir.isPending} onClick={() => mkdir.mutate(newName.trim())}>
            Create
          </Button>
          <Button type="button" size="sm" variant="subtle" color="gray" onClick={() => setNewName(null)}>
            Cancel
          </Button>
        </Group>
      ) : null}
      {mkdir.isError && <div className="np-error">{(mkdir.error as Error).message}</div>}
      <Group justify="space-between" mt="md">
        <Button type="button" size="xs" variant="subtle" color="gray" leftSection={<IconFolderPlus size={14} />} onClick={() => setNewName('')} disabled={!d}>
          New folder
        </Button>
        <Group gap={6}>
          <Button type="button" variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!d || (files && !file)} onClick={() => d && (onPick(files ? file! : d.path), onClose())} data-testid="fs-pick">
            {pickLabel ?? (files ? 'Use this file' : 'Use this folder')}
          </Button>
        </Group>
      </Group>
    </Modal>
  );
}

/** Small spinner + label (inline). */
export const Working = ({ label }: { label: string }) => (
  <Group gap={6}>
    <Loader size={12} />
    <Text size="xs" c="dimmed">
      {label}
    </Text>
  </Group>
);

export { Code };
