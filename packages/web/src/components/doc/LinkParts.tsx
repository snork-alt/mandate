import { createContext, useContext, useState } from 'react';
import { Tooltip, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconArchive, IconArrowBackUp, IconCircleCheckFilled, IconCircleDashed, IconHelpCircle, IconLock, IconUnlink } from '@tabler/icons-react';
import type { DocLinks, ResolvedLink } from '@mandate/shared';
import type { SectionLink } from '@mandate/doc';
import { Link } from 'react-router';
import { REL_BACK, REL_META, sectionHref } from '../../lib/links';
import { uriTarget } from '../../lib/refs';
import { ChipCopy } from '../copy';
import { refLabel } from '@mandate/shared/refs';

/** Link information of the document on screen (from the spec / standard GET). */
export const DocLinksContext = createContext<DocLinks | undefined>(undefined);
export const useSectionLinks = (sectionId: string) => useContext(DocLinksContext)?.sections[sectionId];

const WAIVER_REASON: Record<string, string> = {
  no_feedback: 'not approved (no feedback linked)',
  feedback_missing: 'approval feedback is missing',
  not_accepted: 'approval feedback is not accepted yet',
  same_author: 'approved by its own author (needs someone else)',
  stale: 'lapsed: the criteria changed since approval',
};

/** A section link chip: relation icon, target doc › section, target state; hover shows the target summary. */
export function LinkChip({ link, resolved }: { link: SectionLink; resolved?: ResolvedLink }) {
  const meta = REL_META[link.rel] ?? REL_META.relates_to!;
  const Icon = meta.icon;
  const label = resolved ? (resolved.sectionId ? `${resolved.docTitle ?? resolved.docId} › ${resolved.sectionTitle ?? resolved.sectionId}` : `${resolved.docTitle ?? resolved.docId} (whole standard)`) : refLabel(link.to);
  const deviation = link.rel === 'deviates_from';
  const tip = (
    <div style={{ maxWidth: 300 }}>
      <div style={{ fontWeight: 600 }}>
        {meta.label} {label}
      </div>
      {resolved?.summary && <div>{resolved.summary}</div>}
      {link.note && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{link.note}</div>}
      {resolved?.upstreamChanged && <div style={{ marginTop: 4 }}>Changed since this section was implemented{link.seenAt ? ' (or acknowledged)' : ''}.</div>}
      {resolved?.pinLost && <div style={{ marginTop: 4 }}>Unknown (pin lost): the commit to compare with cannot be read.</div>}
      {resolved?.supersededBy && <div style={{ marginTop: 4 }}>Superseded by {refLabel(resolved.supersededBy)}.</div>}
      {resolved?.archived && <div style={{ marginTop: 4 }}>Target is archived{link.rel === 'depends_on' ? ' (broken dependency)' : ''}.</div>}
      {resolved?.waiver && (
        <div style={{ marginTop: 4 }}>
          {resolved.waiver.effective ? `Waived via feedback ${resolved.waiver.feedback}` : `Deviation ${WAIVER_REASON[resolved.waiver.reason ?? 'no_feedback']}`}
        </div>
      )}
      {resolved && !resolved.exists && <div>Target no longer exists.</div>}
    </div>
  );
  return (
    <ChipCopy target={uriTarget(link.to)}>
      <Tooltip label={tip} multiline>
        <Link to={sectionHref(link.to)} className="chip chip-link" data-rel={link.rel} data-tone={meta.tone} data-missing={resolved && !resolved.exists ? true : undefined}>
          <Icon size={12} />
          {deviation && <span className="chip-link-kind">{resolved?.waiver?.effective ? 'Waived' : 'Deviation'}</span>}
          <span className="chip-path">{label}</span>
          {resolved?.kind === 'specs' &&
            (resolved.implemented ? (
              <IconCircleCheckFilled size={12} className="chip-state" data-state="done" />
            ) : (
              <IconCircleDashed size={12} className="chip-state" />
            ))}
          {resolved?.upstreamChanged && <IconAlertTriangle size={12} className="chip-state" data-state="warn" />}
          {resolved?.pinLost && <IconHelpCircle size={12} className="chip-state" data-state="warn" />}
          {(resolved?.archived || resolved?.supersededBy) && <IconArchive size={12} className="chip-state" data-state="warn" />}
        </Link>
      </Tooltip>
    </ChipCopy>
  );
}

/** Header badges derived from links: blocked, upstream changed, superseded, conflicts. */
export function LinkBadges({ sectionId }: { sectionId: string }) {
  const info = useSectionLinks(sectionId);
  if (!info) return null;
  const superseded = info.backlinks.filter((b) => b.rel === 'supersedes');
  const conflicts = info.outgoing.some((o) => o.rel === 'conflicts_with') || info.backlinks.some((b) => b.rel === 'conflicts_with');
  return (
    <>
      {info.blocked && (
        <Tooltip label={`Waiting for: ${info.outgoing.filter((o) => o.rel === 'depends_on' && !o.implemented).map((o) => `${o.docTitle} › ${o.sectionTitle}`).join(', ')}`}>
          <span className="link-badge" data-tone="danger">
            <IconLock size={12} /> Blocked
          </span>
        </Tooltip>
      )}
      {info.broken && (
        <Tooltip label={`Depends on an archived or missing section: ${info.outgoing.filter((o) => o.rel === 'depends_on' && (o.archived || !o.exists)).map((o) => `${o.docTitle} › ${o.sectionTitle}`).join(', ')}`}>
          <span className="link-badge" data-tone="danger">
            <IconUnlink size={12} /> Broken dependency
          </span>
        </Tooltip>
      )}
      {info.pinLost && (
        <Tooltip label="A pinned commit (implementedCommit / seenAt) cannot be read; upstream changes are unknown.">
          <span className="link-badge" data-tone="muted">
            <IconHelpCircle size={12} /> Pin lost
          </span>
        </Tooltip>
      )}
      {info.supersededTargets.length > 0 && (
        <Tooltip label={`Links to superseded sections: ${info.supersededTargets.map(refLabel).join(', ')}`}>
          <span className="link-badge" data-tone="warn">
            <IconArchive size={12} /> Superseded target
          </span>
        </Tooltip>
      )}
      {info.upstreamChanged && (
        <Tooltip label={`Changed upstream since implemented: ${info.outgoing.filter((o) => o.upstreamChanged).map((o) => `${o.docTitle} › ${o.sectionTitle}`).join(', ')}`}>
          <span className="link-badge" data-tone="warn">
            <IconAlertTriangle size={12} /> Upstream changed
          </span>
        </Tooltip>
      )}
      {conflicts && (
        <span className="link-badge" data-tone="warn">
          <IconAlertTriangle size={12} /> Conflict
        </span>
      )}
      {superseded.length > 0 && (
        <Link to={sectionHref(superseded[0]!.from)} className="link-badge" data-tone="muted">
          Superseded by {superseded[0]!.docTitle} › {superseded[0]!.sectionTitle}
        </Link>
      )}
    </>
  );
}

/** Compact "Linked from" row under a section (collapsed beyond 3). */
export function Backlinks({ sectionId }: { sectionId: string }) {
  const info = useSectionLinks(sectionId);
  const [open, setOpen] = useState(false);
  if (!info?.backlinks.length) return null;
  const shown = open ? info.backlinks : info.backlinks.slice(0, 3);
  return (
    <div className="backlinks">
      <span className="backlinks-label">
        <IconArrowBackUp size={12} /> Linked from
      </span>
      {shown.map((b) => (
        <Tooltip key={`${b.from}-${b.rel}`} label={b.note ?? `${b.docTitle} › ${b.sectionTitle} ${REL_BACK[b.rel] ?? b.rel}`}>
          <Link to={sectionHref(b.from)} className="backlink" data-rel={b.rel}>
            <span className="backlink-rel">{(REL_META[b.rel]?.label ?? b.rel).toLowerCase()}</span>
            {b.docTitle} › {b.sectionTitle}
            {b.docStatus && <span className="faint"> · {b.docStatus.replace('_', ' ')}</span>}
          </Link>
        </Tooltip>
      ))}
      {info.backlinks.length > 3 && (
        <UnstyledButton className="backlinks-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'less' : `+${info.backlinks.length - 3} more`}
        </UnstyledButton>
      )}
    </div>
  );
}
