import { ActionIcon, CopyButton, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconGitBranch } from '@tabler/icons-react';
import type { Claim } from '@mandate/shared';
import type { ReactNode } from 'react';
import { absoluteTime, relativeTime } from '../../lib/time';
import { initials, isStale } from '../../lib/specs';

/** Small round agent avatar with initials; red-tinted when the claim is stale. */
export function ClaimAvatar({ claim, now, size = 20 }: { claim: Claim; now: number; size?: number }) {
  const stale = isStale(claim, now);
  return (
    <Tooltip
      multiline
      label={
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {claim.agent}
          </Text>
          {claim.branch && (
            <Text size="sm" ff="monospace">
              {claim.branch}
            </Text>
          )}
          <Text size="sm" c={stale ? 'red.3' : undefined}>
            {stale ? 'Stale · ' : ''}heartbeat {relativeTime(claim.heartbeatAt, now)}
          </Text>
        </Stack>
      }
    >
      <span className="claim-avatar" data-stale={stale || undefined} style={{ width: size, height: size, fontSize: size * 0.42 }}>
        {initials(claim.agent)}
      </span>
    </Tooltip>
  );
}

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="claim-row">
      <span className="claim-label">{label}</span>
      <Tooltip label={value} openDelay={500}>
        <Text size="sm" ff={mono ? 'monospace' : undefined} truncate="start" style={{ minWidth: 0, flex: 1 }}>
          {value}
        </Text>
      </Tooltip>
      <CopyButton value={value} timeout={1400}>
        {({ copied, copy }) => (
          <ActionIcon size="sm" onClick={copy} aria-label={`Copy ${label}`}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </ActionIcon>
        )}
      </CopyButton>
    </div>
  );
}

/** Who is working on the spec, where, and whether the claim is still alive. */
/** `via`: an optional first row, e.g. the work order holding the claim. */
export function ClaimCard({ claim, now, via }: { claim: Claim; now: number; via?: ReactNode }) {
  const stale = isStale(claim, now);
  return (
    <div className="claim-card" data-stale={stale || undefined}>
      <div className="claim-head">
        <ClaimAvatar claim={claim} now={now} size={26} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="md" fw={600} truncate>
            {claim.agent}
          </Text>
          <span className="live" data-stale={stale || undefined}>
            <span className="live-dot" />
            {stale ? 'Stale' : 'Live'} · heartbeat {relativeTime(claim.heartbeatAt, now)}
          </span>
        </div>
      </div>
      {via}
      {claim.branch && (
        <div className="claim-row">
          <span className="claim-label">Branch</span>
          <IconGitBranch size={13} color="var(--app-text-muted)" />
          <CopyRowInline value={claim.branch} />
        </div>
      )}
      {claim.worktree && <CopyRow label="Worktree" value={claim.worktree} />}
      <div className="claim-row">
        <span className="claim-label">Started</span>
        <Tooltip label={absoluteTime(claim.startedAt)}>
          <Text size="sm">{relativeTime(claim.startedAt, now)}</Text>
        </Tooltip>
      </div>
    </div>
  );
}

function CopyRowInline({ value }: { value: string }) {
  return (
    <>
      <Text size="sm" ff="monospace" truncate style={{ minWidth: 0, flex: 1 }}>
        {value}
      </Text>
      <CopyButton value={value} timeout={1400}>
        {({ copied, copy }) => (
          <ActionIcon size="sm" onClick={copy} aria-label="Copy branch">
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </ActionIcon>
        )}
      </CopyButton>
    </>
  );
}
