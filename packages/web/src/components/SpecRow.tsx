import { memo } from 'react';
import { Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconLink, IconLock, IconRuler2, IconUnlink } from '@tabler/icons-react';
import type { Spec } from '@mandate/shared';
import { blockingDeps, isReopened, SPEC_STATUS_META } from '../lib/specs';
import { ClaimAvatar, PriorityIcon, StatusIcon, TagPill, VerificationCount } from './doc';
import { ListHeader, ListRow, RowTime, withNodes, type ChipItem, type ColDef, type HideAt } from './list/ListRow';
import { absoluteTime } from '../lib/time';
import { VersionMeta } from './VersionMeta';
import { docTarget } from '../lib/refs';
import { AuditIndicator } from './audits/panels';
import { MaturityBadge } from './maturity/MaturityBadge';
import { RowPeople } from './people/People';
import { bareRef } from '../lib/lineage';

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
          {sectionBlocked.length}
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
            {dep ? (dep.maturity?.label ?? SPEC_STATUS_META[dep.status].label) : 'Missing'} · {dep?.title ?? id}
          </div>
        );
      })}
    </div>
  );
  return (
    <Tooltip label={label} multiline maw={300}>
      <span className="row-indicator" data-tone={blocking.length ? 'warn' : undefined}>
        {blocking.length ? <IconLock size={13} /> : <IconLink size={13} />}
        {blocking.length ? blocking.length : (spec.dependsOn ?? []).length}
      </span>
    </Tooltip>
  );
}

/**
 * Spec list columns (shared by the header and the rows). Priorities (L3/L4): version and link counts go first (≤1400),
 * then the id; people before the maturity badge, which keeps its label (narrow form: label without the meter).
 */
export function specCols(wide: boolean): ColDef[] {
  return [
    { key: 'flags', width: 76, hide: '2xl', label: 'Flags', tip: 'Drift (no maturity data) and broken dependencies' },
    { key: 'deps', width: 40, hide: '2xl', label: 'Deps', tip: 'Depends on: specs it needs first (a lock means it is blocked)' },
    { key: 'standards', width: 40, hide: '2xl', label: 'Std', tip: 'Standards: how many standards it follows' },
    { key: 'claim', width: 40, hide: 'lg', align: 'center', label: 'Agent', tip: 'Agent: the agent currently working on it (claimed work order)' },
    { key: 'audit', width: 44, hide: 'sm', label: 'Audit', tip: 'Audit: last audit and whether it has open findings (red: open findings)' },
    wide
      ? { key: 'progress', width: 196, hide: 'xs', narrow: { at: 'xl', width: 164 }, label: 'Maturity', tip: 'Maturity: how far the spec is from draft to audited, plus flags (failing, drifted, blocked, stale)' }
      : { key: 'progress', width: 56, hide: 'md', label: 'Verified', tip: 'Acceptance criteria verified' },
    { key: 'version', width: 52, hide: '2xl', label: 'Version', tip: 'Version: number of committed versions and the last commit' },
  ];
}
const SPEC_ID_HIDE: HideAt = '2xl';
const SPEC_PEOPLE_HIDE: HideAt = 'lg';
const SPEC_CHIPS_W = 160;
const SPEC_ID_W = 130;

/** Column header for the spec list (same geometry as SpecRow). */
export function SpecListHeader({ wide }: { wide: boolean }) {
  return (
    <ListHeader
      list="specs"
      leadWidth={wide ? 18 : 38}
      id={{ label: 'ID', tip: 'Spec id (copy it with the button next to the title)' }}
      idWidth={SPEC_ID_W}
      idHide={SPEC_ID_HIDE}
      main={{ label: 'Spec', tip: 'Title and summary' }}
      chips={{ label: 'Tags', tip: 'Tags (hover "+N" for the rest)' }}
      chipsWidth={SPEC_CHIPS_W}
      cols={specCols(wide)}
      peopleHide={SPEC_PEOPLE_HIDE}
    />
  );
}

/** Dense Linear-style spec row (shared ListRow layout). `wide`: the list shows maturity badges (fixed wide column). */
export const SpecRow = memo(function SpecRow({ spec, byId, now, wide }: Props & { wide?: boolean }) {
  const reopened = isReopened(spec);
  const standards = (spec.standards ?? []).filter((s) => !s.exempt).length;
  const drifted = (spec.drift ?? []).length > 0;
  const broken = (spec.brokenSections ?? []).length > 0;
  const target = docTarget('specs', spec.id);
  const chips: ChipItem[] = spec.tags.map((t) => ({ key: t, node: <TagPill tag={t} /> }));
  return (
    <ListRow
      to={`/specs/${spec.id}`}
      list="specs"
      className="spec-row"
      copy={target}
      lead={
        <>
          <PriorityIcon priority={spec.priority} withTooltip />
          {!spec.maturity && <StatusIcon status={spec.status} reopened={reopened} withTooltip />}
        </>
      }
      leadWidth={wide ? 18 : 38}
      id={spec.id}
      idWidth={SPEC_ID_W}
      idHide={SPEC_ID_HIDE}
      title={spec.title}
      excerpt={spec.summary}
      chips={chips}
      chipsWidth={SPEC_CHIPS_W}
      peopleHide={SPEC_PEOPLE_HIDE}
      cols={withNodes(specCols(!!(spec.maturity || wide)), {
        flags: (
          <>
            {drifted && !spec.maturity && (
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
          </>
        ),
        deps: <DependencyIndicator spec={spec} byId={byId} />,
        standards: standards > 0 && (
          <Tooltip label={`Follows ${standards} standard${standards > 1 ? 's' : ''}`}>
            <span className="row-indicator">
              <IconRuler2 size={13} />
              {standards}
            </span>
          </Tooltip>
        ),
        claim: (spec.claims ?? []).slice(0, 1).map((c) => <ClaimAvatar key={c.workOrder} claim={c.claim} now={now} workOrder={c.workOrder} />),
        audit: spec.lastAudit !== undefined && <AuditIndicator last={spec.lastAudit} />,
        progress: spec.maturity ? <MaturityBadge m={spec.maturity} size="sm" /> : !wide && spec.verification && <VerificationCount {...spec.verification} />,
        version: <VersionMeta path={`/specs/${spec.id}`} count={spec.versionCount} lastCommit={spec.lastCommit} lastBy={spec.updatedBy} />,
      })}
      people={<RowPeople refUri={bareRef(target.ref)} fallback={{ user: spec.lastEditedBy?.user ?? spec.createdBy?.user, agent: spec.lastEditedBy?.agent ?? spec.createdBy?.agent ?? spec.updatedBy ?? undefined, at: spec.updatedAt, verb: spec.lastEditedBy ? 'Edited' : 'Created' }} />}
      time={<RowTime iso={spec.updatedAt} label={`Updated ${absoluteTime(spec.updatedAt)}`} />}
    />
  );
});
