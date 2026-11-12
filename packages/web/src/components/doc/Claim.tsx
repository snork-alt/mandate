import { ActionIcon, CopyButton, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconGitBranch } from '@tabler/icons-react';
import type { Claim } from '@mandate/shared';
import type { ReactNode } from 'react';
import { absoluteTime, relativeTime } from '../../lib/time';
import { initials, isStale } from '../../lib/specs';
import { buildRef } from '@mandate/shared/refs';
import { useContributors } from '../../lib/people';
import { UserAvatar } from '../people/People';

/** Team: the user who claimed a work order (its `claimed` contributor), else null. */
function useClaimer(workOrder?: string): string | null {
  const q = useContributors(workOrder ? buildRef({ kind: 'work-orders', id: workOrder }) : null);
  const direct = (q.data ?? []).filter((c) => c.kind === 'direct');
  return (direct.find((c) => c.roles.includes('claimed')) ?? null)?.user ?? null;
}

/**
 * Small round avatar of a claim: in a team (with `workOrder`) the user who claimed it, "via <agent>" in its hover
 * card; otherwise the agent's initials. Red ring when the claim is stale.
 */
export function ClaimAvatar({ claim, now, size = 20, workOrder }: { claim: Claim; now: number; size?: number; workOrder?: string }) {
  const stale = isStale(claim, now);
  const user = useClaimer(workOrder);
  // One look for every claim: the avatar plus a small live / stale dot (no ring, so nothing gets clipped).
  const dot = <span className="claim-dot" data-stale={stale || undefined} aria-label={stale ? 'Stale claim' : 'Live claim'} />;
  if (user)
    return (
      <span className="claim-user">
        <UserAvatar user={user} size={size} agent={claim.agent} at={claim.heartbeatAt} />
        {dot}
      </span>
    );
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
      <span className="claim-user">
        <span className="claim-avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
          {initials(claim.agent)}
        </span>
        {dot}
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
export function ClaimCard({ claim, now, via, workOrder }: { claim: Claim; now: number; via?: ReactNode; workOrder?: string }) {
  const stale = isStale(claim, now);
  const user = useClaimer(workOrder);
  return (
    <div className="claim-card" data-stale={stale || undefined}>
      <div className="claim-head">
        <ClaimAvatar claim={claim} now={now} size={26} workOrder={workOrder} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="md" fw={600} truncate>
            {user ? (
              <>
                {user} <span className="faint">via {claim.agent}</span>
              </>
            ) : (
              claim.agent
            )}
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
