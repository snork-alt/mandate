import { useState } from 'react';
import { Skeleton, Switch } from '@mantine/core';
import type { StandardUsage } from '@mandate/shared';
import { Link } from 'react-router';
import { categoryLabel, isReopened } from '../lib/specs';
import { StatusIcon } from './doc';
import { PropGroup } from './PropertyList';
import { CopyRef } from './copy';
import { parseRef, refMention } from '@mandate/shared/refs';

const wholeStandard = (t: string) => !t.includes('/sections/');
const GROUPS: { key: 'whole' | 'follows' | 'applies' | 'exempt'; title: string; match: (u: StandardUsage) => boolean }[] = [
  { key: 'whole', title: 'Sections follow the whole standard', match: (u) => u.follows.some((f) => wholeStandard(f.target)) },
  { key: 'follows', title: 'Sections follow specific rules', match: (u) => u.follows.length > 0 && !u.follows.some((f) => wholeStandard(f.target)) },
  { key: 'applies', title: 'Applies automatically', match: (u) => !u.follows.length && u.appliesBy.length > 0 },
  { key: 'exempt', title: 'Exempt (approved)', match: (u) => !!u.exempt && !u.follows.length },
];

/** Specs using a standard, grouped by how they use it. Archived specs hidden behind a toggle. */
export function UsedByPanel({ usage, loading, action }: { usage?: StandardUsage[]; loading: boolean; action?: React.ReactNode }) {
  const [showArchived, setShowArchived] = useState(false);
  const all = usage ?? [];
  const archived = all.filter((u) => u.status === 'archived').length;
  const visible = showArchived ? all : all.filter((u) => u.status !== 'archived');
  return (
    <PropGroup
      title={`Used by${usage ? ` · ${visible.length}` : ''}`}
      action={
        action ??
        (visible.length > 0 && (
          <CopyRef
            visible
            size="xs"
            target={{
              label: 'list of specs',
              ref: visible.map((u) => refMention({ kind: 'specs', id: u.specId })).join('\n'),
              markdown: () => visible.map((u) => `- ${u.title} ${refMention({ kind: 'specs', id: u.specId })}`).join('\n'),
            }}
          />
        ))
      }
    >
      {loading && <Skeleton height={60} radius="md" />}
      {usage && visible.length === 0 && <span className="faint small">No spec uses this standard yet</span>}
      {GROUPS.map((g) => {
        const rows = visible.filter(g.match);
        if (!rows.length) return null;
        return (
          <div key={g.key} className="usedby-group">
            <div className="prop-subtitle">
              {g.title} · {rows.length}
            </div>
            {rows.map((u) => (
              <div key={u.specId} className="usedby-row">
                <Link to={`/specs/${u.specId}`} className="linked-item">
                  <StatusIcon status={u.status} reopened={isReopened({ status: u.status, implementedCommit: undefined })} withTooltip />
                  <span className="linked-title">{u.title}</span>
                  {u.category && <span className="linked-meta">{categoryLabel(u.category)}</span>}
                </Link>
                {g.key === 'applies' && <div className="usedby-sections faint">via {u.appliesBy.join(', ')}</div>}
                {(u.follows?.length ?? 0) > 0 && (
                  <div className="usedby-sections">
                    {u.follows.map((f) => (
                      <Link key={`${f.id}-${f.target}`} to={`/specs/${u.specId}#section-${f.id}`} className="usedby-section">
                        § {f.title} → {parseRef(f.target)?.sectionId ?? 'whole standard'}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
      {archived > 0 && (
        <Switch
          mt="xs"
          size="xs"
          label={`Show archived (${archived})`}
          checked={showArchived}
          onChange={(e) => setShowArchived(e.currentTarget.checked)}
        />
      )}
    </PropGroup>
  );
}

/** Spec sections that explicitly deviate from this standard (for reviews). */
export function DeviationsPanel({ usage }: { usage?: StandardUsage[] }) {
  const rows = (usage ?? []).flatMap((u) => (u.deviations ?? []).map((d) => ({ ...d, specId: u.specId, specTitle: u.title })));
  if (!rows.length) return null;
  return (
    <PropGroup title={`Deviations · ${rows.length}`}>
      {rows.map((d) => (
        <Link key={`${d.specId}-${d.id}-${d.target}`} to={`/specs/${d.specId}#section-${d.id}`} className="deviation-row">
          <span className="deviation-title">
            {d.specTitle} › {d.title}
          </span>
          <span className="deviation-target mono">from {parseRef(d.target)?.sectionId}</span>
          <span className="deviation-note">{d.note}</span>
        </Link>
      ))}
    </PropGroup>
  );
}
