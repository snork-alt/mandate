import type { CriterionState, SpecVerification } from '@mandate/shared';
import { Link } from 'react-router';
import { Tooltip } from '@mantine/core';
import { parseRef } from '@mandate/shared/refs';
import { CriterionStateIcon, VerificationCount } from './doc';
import { PropGroup } from './PropertyList';
import { KindIcon } from './refs/KindIcon';

function Row({ c, href }: { c: CriterionState; href: string }) {
  const row = (
    <Link to={href} className="linked-item">
      <CriterionStateIcon state={c.state} />
      <KindIcon kind="section" />
      <span className="linked-title">{c.title}</span>
      <span className="linked-meta">{c.state === 'waived' ? `waived · ${c.waiver?.feedback ?? ''}` : c.state === 'unknown' ? 'pin lost' : c.method}</span>
    </Link>
  );
  const tip = [
    c.waiver &&
      (c.waiver.effective
        ? `Waived via approval ${c.waiver.feedback} (deviation in § ${c.waiver.section}: ${c.waiver.note})`
        : `Deviation in § ${c.waiver.section} not in effect (${c.waiver.reason?.replace('_', ' ')}): ${c.waiver.note}`),
    c.staleReason,
    c.path?.length ? `Applies via ${c.path.join(' → ')}` : '',
  ].filter(Boolean);
  return tip.length ? (
    <Tooltip label={<div>{tip.map((t) => <div key={t as string}>{t}</div>)}</div>} multiline maw={340}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}

/** Own criteria plus criteria inherited from standards, grouped by standard. */
export function VerificationPanel({ v, specId }: { v?: SpecVerification; specId: string }) {
  if (!v || !v.total) return null;
  return (
    <PropGroup title="Verification" action={<VerificationCount verified={v.verified} total={v.total} failing={v.failing} stale={v.stale} />}>
      {v.own.map((c) => (
        <Row key={c.uri} c={c} href={`/specs/${specId}#section-${c.sectionId}`} />
      ))}
      {v.inherited.map((g) => (
        <div key={g.standard}>
          <div className="prop-subtitle">{g.via ? `Inherited via ${g.via.slice(0, -1).join(' → ')} → extends ${g.title}` : `Inherited from ${g.title}`}</div>
          {g.criteria.map((c) => (
            <Row key={c.uri} c={c} href={`/standards/${parseRef(g.standard)?.id}#section-${c.sectionId}`} />
          ))}
        </div>
      ))}
    </PropGroup>
  );
}
