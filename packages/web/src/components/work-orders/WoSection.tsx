import { useState } from 'react';
import { IconChevronRight, IconGitFork } from '@tabler/icons-react';
import type { Section, TouchedFile } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { Markdown } from '../Markdown';
import { RefChip } from '../refs/RefChip';
import { SectionBlock } from '../doc';
import { sectionTarget } from '../../lib/refs';
import { UpdateDiff } from './UpdateDiff';
import { CommentList, TouchedChips, useWorkOrderView } from './parts';

type WoSectionMeta = Section & { target?: string; status?: 'pending' | 'done' | 'obsolete'; verifications?: string[]; codeRefs?: TouchedFile[]; deviations?: string[] };

const STATUS_LABEL = { pending: 'Pending', done: 'Done', obsolete: 'Obsolete' } as const;

/** Status accent next to a work-order section's title. */
export function WoSectionBadge({ section }: { section: Section }) {
  if (section.type !== 'wo-section') return null;
  const st = (section as WoSectionMeta).status ?? 'pending';
  return (
    <span className="wo-sec-status" data-status={st}>
      {STATUS_LABEL[st]}
    </span>
  );
}

/** The targeted spec section's text at the work order's spec version (collapsed). */
function SpecText({ sectionId }: { sectionId: string }) {
  const view = useWorkOrderView();
  const [open, setOpen] = useState(false);
  const r = view?.resolved.sections.find((s) => s.id === sectionId);
  if (!view || !r?.section) return null;
  const { item } = view.resolved;
  return (
    <div className="wo-spec-text">
      <button type="button" className="wo-thread-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        {item.kind === 'update' ? 'Spec changes to apply, as of' : 'Based on the spec as of'} <span className="mono">{item.specCommit.slice(0, 7)}</span>
        {r.headChanged && <span className="link-badge" data-tone="warn">changed since</span>}
        {r.blocked && <span className="link-badge" data-tone="danger">blocked</span>}
      </button>
      {open &&
        (item.kind === 'update' ? (
          <UpdateDiff spec={item.spec} specCommit={item.specCommit} section={r.section} badge={null} standardTitles={new Map()} />
        ) : (
          <SectionBlock section={r.section} target={sectionTarget('specs', item.spec, r.section, item.specCommit)} />
        ))}
    </div>
  );
}

/** Body of a `wo-section`: the spec section it implements, notes, verifications, code, deviations and its comment threads. */
export function WoSectionBody({ section }: { section: Section }) {
  const s = section as WoSectionMeta;
  const view = useWorkOrderView();
  const uri = view ? buildRef({ kind: 'work-orders', id: view.id, sectionId: section.id }) : '';
  const threads = (view?.threads ?? []).filter((t) => t.target === uri);
  return (
    <div className="wo-sec-body">
      {s.target && (
        <div className="wo-sec-target small">
          <span className="faint">Implements</span>
          <RefChip to={s.target} />
        </div>
      )}
      <SpecText sectionId={section.id} />
      {section.body.trim() ? (
        <Markdown>{section.body}</Markdown>
      ) : (
        <p className="faint small wo-sec-empty">
          {s.status === 'done' ? 'Done; the agent recorded no notes.' : s.status === 'obsolete' ? 'Obsolete: the targeted spec section was archived or superseded.' : 'Not started: the agent writes notes here when the section is done.'}
        </p>
      )}
      {(s.verifications?.length ?? 0) > 0 && (
        <div className="wo-sec-block">
          <span className="audit-finding-label">Verified by</span>
          <div className="wo-chips">
            {s.verifications!.map((v) => (
              <RefChip key={v} to={v} />
            ))}
          </div>
        </div>
      )}
      {(s.codeRefs?.length ?? 0) > 0 && (
        <div className="wo-sec-block">
          <span className="audit-finding-label">Code</span>
          <TouchedChips refs={s.codeRefs!} />
        </div>
      )}
      {(s.deviations?.length ?? 0) > 0 && (
        <div className="wo-sec-block wo-deviations">
          <span className="audit-finding-label">
            <IconGitFork size={11} /> Deviations
          </span>
          {s.deviations!.map((d, i) => (
            <div key={i} className="wo-deviation">
              <Markdown>{d}</Markdown>
            </div>
          ))}
        </div>
      )}
      {view && threads.length > 0 && (
        <div className="wo-sec-block">
          <span className="audit-finding-label">Comments</span>
          <CommentList threads={threads} workOrderId={view.id} anchor={() => true} />
        </div>
      )}
    </div>
  );
}
