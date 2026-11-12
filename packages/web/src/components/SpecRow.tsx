import { memo } from 'react';
import { Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconLink, IconLock, IconRuler2, IconUnlink } from '@tabler/icons-react';
import type { Spec } from '@mandate/shared';
import { Link } from 'react-router';
import { blockingDeps, isReopened, SPEC_STATUS_META } from '../lib/specs';
import { ClaimAvatar, PriorityIcon, StatusIcon, TagPill, VerificationCount } from './doc';
import { TimeAgo } from './TimeAgo';
import { VersionMeta } from './VersionMeta';
import { CopyRef, copyTargetProps } from './copy';
import { docTarget } from '../lib/refs';

interface Props {
  spec: Spec;
  byId: Map<string, Spec>;
  now: number;
}

function DependencyIndicator({ spec, byId }: { spec: Spec; byId: Map<string, Spec> }) {
  const sectionBlocked = spec.blockedSections ?? [];
  if (!(spec.dependsOn ?? []).length && !sectionBlocked.length) return null;
  if (!(spec.dependsOn ?? []).length) {
    return (
      <Tooltip label={`Blocked sections: ${sectionBlocked.join(', ')} (depends_on target not implemented)`}>
        <span className="row-indicator" data-tone="warn">
          <IconLock size={13} />
          Blocked
        </span>
      </Tooltip>
    );
  }
  const blocking = [...blockingDeps(spec, byId), ...sectionBlocked.map((s) => `§${s}`)];
  const label = (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{blocking.length ? `Blocked by ${blocking.length}` : 'Dependencies done'}</div>
      {(spec.dependsOn ?? []).map((id) => {
        const dep = byId.get(id);
        return (
          <div key={id}>
            {dep ? SPEC_STATUS_META[dep.status].label : 'Missing'} · {dep?.title ?? id}
          </div>
        );
      })}
    </div>
  );
  return (
    <Tooltip label={label} multiline maw={300}>
      <span className="row-indicator" data-tone={blocking.length ? 'warn' : undefined}>
        {blocking.length ? <IconLock size={13} /> : <IconLink size={13} />}
        {blocking.length ? 'Blocked' : (spec.dependsOn ?? []).length}
      </span>
    </Tooltip>
  );
}

/** Dense Linear-style spec row. */
export const SpecRow = memo(function SpecRow({ spec, byId, now }: Props) {
  const reopened = isReopened(spec);
  const standards = (spec.standards ?? []).filter((s) => !s.exempt).length;
  const drifted = (spec.drift ?? []).length > 0;
  const broken = (spec.brokenSections ?? []).length > 0;
  const target = docTarget('specs', spec.id);
  return (
    <Link to={`/specs/${spec.id}`} className="row spec-row has-copy-ref" {...copyTargetProps(target)}>
      <PriorityIcon priority={spec.priority} withTooltip />
      <span className="row-id spec-row-id">{spec.id}</span>
      <StatusIcon status={spec.status} reopened={reopened} withTooltip />
      <span className="spec-row-text">
        <span className="row-title">{spec.title}</span>
        {spec.summary && <span className="row-excerpt">{spec.summary}</span>}
      </span>
      <span className="row-meta">
        <span className="row-copy">
          <CopyRef target={target} size="xs" />
        </span>
        {spec.tags.length > 0 && (
          <span className="row-tags">
            {spec.tags.slice(0, 2).map((t) => (
              <TagPill key={t} tag={t} />
            ))}
            {spec.tags.length > 2 && (
              <Tooltip label={spec.tags.slice(2).join(', ')}>
                <span className="tag-pill">+{spec.tags.length - 2}</span>
              </Tooltip>
            )}
          </span>
        )}
        {drifted && (
          <Tooltip label={<div>{spec.drift!.map((d) => <div key={d}>{d}</div>)}</div>} multiline maw={340}>
            <span className="row-indicator" data-tone="warn">
              <IconAlertTriangle size={13} />
              Drifted
            </span>
          </Tooltip>
        )}
        {broken && (
          <Tooltip label={`Broken dependency: ${spec.brokenSections!.join(', ')} (depends_on target archived or missing)`}>
            <span className="row-indicator" data-tone="danger">
              <IconUnlink size={13} />
              Broken
            </span>
          </Tooltip>
        )}
        <span className="row-slot row-slot-deps">
          <DependencyIndicator spec={spec} byId={byId} />
        </span>
        <span className="row-slot row-slot-standards">
          {standards > 0 && (
            <Tooltip label={`Follows ${standards} standard${standards > 1 ? 's' : ''}`}>
              <span className="row-indicator">
                <IconRuler2 size={13} />
                {standards}
              </span>
            </Tooltip>
          )}
        </span>
        <span className="row-claim">
          {(spec.claims ?? []).slice(0, 2).map((c) => (
            <ClaimAvatar key={c.workOrder} claim={c.claim} now={now} />
          ))}
        </span>
        <span className="row-slot row-slot-verif">{spec.verification && <VerificationCount {...spec.verification} />}</span>
        <VersionMeta path={`/specs/${spec.id}`} count={spec.versionCount} lastCommit={spec.lastCommit} lastBy={spec.updatedBy} />
        <span className="row-time">
          <TimeAgo iso={spec.updatedAt} />
        </span>
      </span>
    </Link>
  );
});
