import type { ReactNode } from 'react';
import { Badge, HoverCard } from '@mantine/core';
import { IconAlertTriangle, IconPointer } from '@tabler/icons-react';
import type { NodeKind } from '@mandate/shared';
import { isServiceUser, serviceName } from '../../lib/attribution';
import { useContributors } from '../../lib/people';
import { absoluteTime, relativeTime } from '../../lib/time';
import { AvatarStack } from '../people/People';
import type { SpecMaturity } from '@mandate/shared';
import { MaturityBadge } from '../maturity/MaturityBadge';
import { KIND_ICON } from './kinds';

const KIND_LABEL: Partial<Record<NodeKind, string>> = { work_order: 'Work order', code_file: 'Code file', code_range: 'Code range', pull_request: 'Pull request', code_commit: 'Code commit' };
/** "Section", "Work order", "Pull request". */
export const kindLabel = (kind: string) => KIND_LABEL[kind as NodeKind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');

const PEOPLE_LABEL: Partial<Record<string, string>> = { code_file: 'Touched by', code_range: 'Touched by', repo: 'Touched by', commit: 'Committed by', code_commit: 'Implemented by', pull_request: 'Worked on by', branch: 'Worked on by', agent: 'Used by', symbol: 'Mentioned by' };

const MAX_NAMES = 3;

/**
 * Footer of a ref preview: avatars + readable names (max 3, then "+N") and the last update. Renders nothing without
 * contributors (lazy: mounts only while the card is open).
 */
export function RefPeople({ uri, kind, updated, testId = 'ref-people' }: { uri: string; kind?: string; updated?: string; testId?: string }) {
  const q = useContributors(uri);
  const cs = q.data ?? [];
  const last = updated ?? cs.reduce<string | undefined>((m, c) => (c.lastAt && (!m || c.lastAt > m) ? c.lastAt : m), undefined);
  if (!cs.length && !last) return null;
  const names = cs.slice(0, MAX_NAMES).map((c) => (isServiceUser(c.user) ? serviceName(c.user) : c.user));
  const more = cs.length - names.length;
  return (
    <div className="ref-card-people" data-testid={testId}>
      {cs.length > 0 && (
        <>
          {kind && PEOPLE_LABEL[kind] && <span className="ref-card-faint">{PEOPLE_LABEL[kind]}</span>}
          <AvatarStack contributors={cs} max={MAX_NAMES} size="xs" />
          <span className="ref-card-names" title={`${PEOPLE_LABEL[kind ?? ''] ?? 'Contributors'}: ${cs.map((c) => c.user).join(', ')}`}>
            {names.join(', ')}
            {more > 0 && <span className="ref-card-faint"> +{more}</span>}
          </span>
        </>
      )}
      {last && relativeTime(last) && (
        <span className="ref-card-time" title={absoluteTime(last)}>
          {cs.length ? '· ' : 'Updated '}
          {relativeTime(last)}
        </span>
      )}
    </div>
  );
}

export interface RefPreviewProps {
  uri: string;
  kind: NodeKind | null;
  /** Full label (a "Parent › Child" label is split into breadcrumb + title). */
  label: string;
  status?: string;
  maturity?: SpecMaturity;
  summary?: string;
  updated?: string;
  unresolved?: boolean;
  error?: string;
  /** Click action hint ("Click to open", "Click to copy"...); omitted when the chip does nothing. */
  hint?: string;
  /** Kind-specific extra lines (code rules...). */
  extra?: ReactNode;
}

/** Card body of a reference preview (kind header + breadcrumb, title, status, excerpt, people, hint). */
export function RefPreviewBody({ uri, kind, label, status, maturity, summary, updated, unresolved, error, hint, extra }: RefPreviewProps) {
  if (unresolved || !kind) {
    return (
      <div className="ref-card" data-testid="ref-preview">
        <div className="ref-card-head" data-tone="error">
          <IconAlertTriangle size={14} stroke={1.7} />
          <span className="ref-card-kind">{kind ? 'Unresolved reference' : 'Invalid reference'}</span>
        </div>
        <div className="ref-card-mono">{uri}</div>
        {error && <div className="ref-card-excerpt">{error}</div>}
      </div>
    );
  }
  const Icon = KIND_ICON[kind];
  const parts = label.split(' › ');
  const title = parts.length > 1 ? parts.pop()! : label;
  const parent = parts.length && label.includes(' › ') ? parts.join(' › ') : undefined;
  return (
    <div className="ref-card" data-testid="ref-preview">
      <div className="ref-card-head">
        <Icon size={14} stroke={1.7} className="ref-card-icon" />
        <span className="ref-card-kind" data-testid="ref-preview-kind">
          {kindLabel(kind)}
        </span>
        {parent && (
          <span className="ref-card-crumb" data-testid="ref-preview-crumb" title={parent}>
            <span aria-hidden> · </span>
            {parent}
          </span>
        )}
      </div>
      <div className="ref-card-title" title={title}>
        {title}
      </div>
      {(maturity || status) && (
        <div className="ref-card-badges">
          {maturity ? (
            <MaturityBadge m={maturity} size="sm" />
          ) : (
            <Badge size="xs" variant="light" color="gray" radius="sm" tt="none">
              {status!.replace(/_/g, ' ')}
            </Badge>
          )}
        </div>
      )}
      {summary && (
        <div className="ref-card-excerpt" data-testid="ref-preview-excerpt">
          {summary}
        </div>
      )}
      {extra}
      <RefPeople uri={uri} kind={kind} updated={updated} />
      {hint && (
        <div className="ref-card-hint">
          <IconPointer size={12} stroke={1.6} />
          {hint}
        </div>
      )}
    </div>
  );
}

/** Light hover card around a reference trigger (opens after 300 ms, stays open while the card is hovered). */
export function RefHoverCard({ children, disabled, ...preview }: RefPreviewProps & { children: ReactNode; disabled?: boolean }) {
  return (
    <HoverCard openDelay={300} closeDelay={150} width={340} position="bottom-start" shadow="md" radius="md" withinPortal disabled={disabled}>
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown p={0} className="ref-card-dropdown" style={{ maxWidth: 'calc(100vw - 16px)' }}>
        <RefPreviewBody {...preview} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
