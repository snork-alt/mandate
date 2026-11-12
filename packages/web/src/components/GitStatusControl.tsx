import { ActionIcon, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconChevronRight, IconCloudOff, IconCloudUpload, IconGitBranch, IconRefresh } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { pushSummary } from '../lib/push';
import './integrity/integrity.css';

/**
 * Compact git status block for the sidebar footer: branch + head, one state word, the integrity issue count on its own
 * line, and a pull/refresh button. The block is a button opening the Integrity view (/integrity).
 */
export function GitStatusControl({ onNavigate }: { onNavigate?: () => void } = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['git', 'status'], queryFn: api.gitStatus, refetchInterval: 15_000 });
  const push = useMutation({
    mutationFn: api.gitPush,
    onSuccess: (res) => {
      if (res.state === 'ok' || res.state === 'idle') notifications.show({ color: 'teal', title: 'Pushed', message: res.message });
      else notifications.show({ color: res.state === 'error' ? 'red' : 'yellow', title: 'Push', message: res.message });
      void qc.invalidateQueries({ queryKey: ['git', 'status'] });
    },
    onError: (err) => notifications.show({ color: 'red', title: 'Push failed', message: err.message }),
  });
  const sync = useMutation({
    mutationFn: api.gitPull,
    onSuccess: (res) => {
      notifications.show({ color: 'teal', title: 'Refreshed', message: res.message });
      void qc.invalidateQueries();
    },
    onError: (err) => notifications.show({ color: 'red', title: 'Pull failed', message: err.message }),
  });

  const s = status.data;
  const dirty = s && !s.clean;
  const dotColor = status.isError
    ? 'var(--mantine-color-red-6)'
    : dirty
      ? 'var(--mantine-color-yellow-6)'
      : 'var(--mantine-color-teal-6)';
  const stateLabel = status.isError ? 'unreachable' : !s ? '…' : dirty ? `${s.files.length} uncommitted` : 'clean';

  const ap = s?.autoPush;
  const pushLine = pushSummary(ap);
  const tooltip = (
    <Stack gap={2}>
      <Text size="xs">Remote: {s?.remote ?? 'none (commits stay local)'}</Text>
      {s?.head && <Text size="xs">HEAD: {s.head.slice(0, 12)}</Text>}
      {ap && <Text size="xs">Auto-push: {ap.message}{ap.behind ? ` · ${ap.behind} behind` : ''}</Text>}
      {ap?.lastError && <Text size="xs" c="var(--mantine-color-red-4)">Last error: {ap.lastError}</Text>}
      {dirty && s.files.slice(0, 8).map((f) => <Text key={f.path} size="xs" ff="monospace">{f.status} {f.path}</Text>)}
    </Stack>
  );

  const issues = s?.integrity?.issues.length ?? 0;
  const label = `Git ${s?.branch ?? ''} ${stateLabel}${issues ? `, ${issues} integrity ${issues === 1 ? 'issue' : 'issues'}` : ''}. Open integrity view`;

  return (
    <Group gap={6} wrap="nowrap" px={8} py={6} align="flex-start" style={{ borderRadius: 6, border: '1px solid var(--app-border)' }}>
      <Tooltip label={tooltip} multiline position="top-start">
        <UnstyledButton
          className="git-box"
          aria-label={label}
          data-testid="git-box"
          onClick={() => {
            onNavigate?.();
            void navigate('/integrity');
          }}
        >
          <IconGitBranch size={14} color="var(--app-text-muted)" style={{ flexShrink: 0, marginTop: 3 }} />
          <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={500} truncate>
                {status.isError ? 'git' : (s?.branch ?? '…')}
              </Text>
              {s?.head && (
                <Text size="xs" ff="monospace" c="var(--app-text-faint)">
                  {s.head.slice(0, 7)}
                </Text>
              )}
            </Group>
            <Group gap={5} wrap="nowrap">
              <span style={{ width: 6, height: 6, borderRadius: 3, background: dotColor, flexShrink: 0 }} />
              <Text size="xs" c="var(--app-text-muted)" truncate>
                {stateLabel}
              </Text>
              {pushLine && ap?.state !== 'no_remote' && (
                <Text size="xs" c={pushLine.color} truncate>
                  · {pushLine.text}
                </Text>
              )}
            </Group>
            {issues > 0 && (
              <span className="git-box-integrity" data-testid="git-integrity-count">
                <IconAlertTriangle size={12} style={{ flexShrink: 0 }} />
                {issues} integrity {issues === 1 ? 'issue' : 'issues'}
                <IconChevronRight size={12} style={{ flexShrink: 0 }} />
              </span>
            )}
          </Stack>
        </UnstyledButton>
      </Tooltip>
      {ap && (ap.state === 'error' || (ap.ahead ?? 0) > 0) && ap.state !== 'no_remote' && ap.state !== 'refused' && ap.state !== 'reconnect' && (
        <Tooltip label={ap.state === 'error' ? 'Retry push' : 'Push now'}>
          <ActionIcon size="md" loading={push.isPending} onClick={() => push.mutate()} aria-label="Push now">
            <IconCloudUpload size={15} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label={s?.remote ? 'Pull from remote and refresh' : 'Refresh (no remote configured)'}>
        <ActionIcon size="md" loading={sync.isPending} onClick={() => sync.mutate()} aria-label="Pull and refresh">
          {s && !s.remote ? <IconCloudOff size={15} /> : <IconRefresh size={15} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
