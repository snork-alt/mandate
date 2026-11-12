import { ActionIcon, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCloudOff, IconCloudUpload, IconGitBranch, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { pushSummary } from '../lib/push';

/** Compact git status block for the sidebar footer: branch, head, clean/dirty and a pull/refresh button. */
export function GitStatusControl() {
  const qc = useQueryClient();
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
      <Text size="xs">Remote: {s?.remote ?? 'none configured'}</Text>
      {s?.head && <Text size="xs">HEAD: {s.head.slice(0, 12)}</Text>}
      {ap && <Text size="xs">Auto-push: {ap.message}{ap.behind ? ` · ${ap.behind} behind` : ''}</Text>}
      {ap?.lastError && <Text size="xs" c="var(--mantine-color-red-4)">Last error: {ap.lastError}</Text>}
      {dirty && s.files.slice(0, 8).map((f) => <Text key={f.path} size="xs" ff="monospace">{f.status} {f.path}</Text>)}
    </Stack>
  );

  return (
    <Group gap={6} wrap="nowrap" px={8} py={6} style={{ borderRadius: 6, border: '1px solid var(--app-border)' }}>
      <Tooltip label={tooltip} multiline position="top-start">
        <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0, cursor: 'default' }}>
          <IconGitBranch size={14} color="var(--app-text-muted)" style={{ flexShrink: 0 }} />
          <Stack gap={0} style={{ minWidth: 0 }}>
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
              {pushLine && (
                <Tooltip label={ap!.lastError ?? ap!.message} multiline maw={360}>
                  <Text size="xs" c={pushLine.color} truncate>
                    · {pushLine.text}
                  </Text>
                </Tooltip>
              )}
              {(s?.integrity?.issues.length ?? 0) > 0 && (
                <Tooltip
                  label={<div>{s!.integrity!.issues.slice(0, 8).map((i) => <div key={`${i.rule}-${i.uri}-${i.message}`}>{i.message}</div>)}</div>}
                  multiline
                  maw={360}
                >
                  <Text size="xs" c="var(--mantine-color-orange-7)" truncate>
                    · {s!.integrity!.issues.length} integrity {s!.integrity!.issues.length === 1 ? 'issue' : 'issues'}
                  </Text>
                </Tooltip>
              )}
            </Group>
          </Stack>
        </Group>
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
