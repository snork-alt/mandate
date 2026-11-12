import type { DriftCriterion, DriftDetail } from '@mandate/shared';
import { parseRef } from '@mandate/shared/refs';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Link } from 'react-router';
import { CriterionStateIcon } from './doc';
import { CommitHash } from './copy';
import { TimeAgo } from './TimeAgo';

const REASON_LABEL: Record<DriftCriterion['reasons'][number], string> = { added: 'New', changed: 'Changed', unverified: 'Unverified' };

function criterionHref(uri: string): string {
  const r = parseRef(uri);
  return r ? `/${r.kind}/${r.id}${r.sectionId ? `#section-${r.sectionId}` : ''}` : '#';
}

/** "Drifted since done": what changed since the spec passed its done gate, one row per criterion. */
export function DriftPanel({ d }: { d: DriftDetail }) {
  const count = (r: DriftCriterion['reasons'][number]) => d.criteria.filter((c) => c.reasons.includes(r)).length;
  const summary = [
    count('added') && `${count('added')} new`,
    count('changed') && `${count('changed')} changed`,
    d.removed && `${d.removed} removed`,
    count('unverified') && `${count('unverified')} unverified`,
  ].filter(Boolean);
  return (
    <div className="drift-panel">
      <div className="drift-head">
        <IconAlertTriangle size={15} className="drift-icon" />
        <span className="drift-title">Drifted since done</span>
        {d.gate && (
          <span className="drift-gate">
            done <TimeAgo iso={d.gate.at} />
            {d.gate.commit && (
              <>
                {' '}at <CommitHash sha={d.gate.commit} />
              </>
            )}
          </span>
        )}
      </div>
      {summary.length > 0 && <div className="drift-summary">{summary.join(' · ')} criteria</div>}
      {d.noSnapshot && <div className="drift-note">Marked done before gate snapshots were recorded.</div>}
      {d.dependencies.includes('broken') && <div className="drift-note">A dependency is archived or missing.</div>}
      {d.dependencies.includes('blocked') && <div className="drift-note">A dependency is not implemented yet.</div>}
      {d.criteria.length > 0 && (
        <div className="drift-rows">
          {d.criteria.map((c) => (
            <Link key={c.uri} to={criterionHref(c.uri)} className="drift-row">
              <CriterionStateIcon state={c.state} />
              <span className="drift-row-title">{c.title}</span>
              <span className="drift-tags">
                {c.reasons.map((r) => (
                  <span key={r} className="drift-tag" data-reason={r}>
                    {REASON_LABEL[r]}
                  </span>
                ))}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
