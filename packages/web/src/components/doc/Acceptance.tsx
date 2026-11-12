import { useState } from 'react';
import { Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronRight, IconExternalLink, IconGitBranch, IconGitCommit } from '@tabler/icons-react';
import type { CriterionState, CriterionStateName, Section, VerificationRecord } from '@mandate/shared';
import { absoluteTime, relativeTime } from '../../lib/time';
import { Markdown } from '../Markdown';
import { CommitHash, CopyRef, copyTargetProps } from '../copy';
import type { CopyTarget } from '../../lib/refs';
import { sectionAnchor } from './anchors';
import { CRITERION_STATE_META } from '../../lib/verification';


/** Linear-style criterion state glyph. */
export function CriterionStateIcon({ state, size = 14 }: { state: CriterionStateName; size?: number }) {
  const { color, label } = CRITERION_STATE_META[state];
  return (
    <Tooltip label={label}>
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" role="img" aria-label={label} style={{ flexShrink: 0 }}>
        {state === 'verified' && (
          <>
            <circle cx="7" cy="7" r="6.25" fill={color} />
            <path d="M4.4 7.2 6.2 9 9.7 5.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {state === 'failing' && (
          <>
            <circle cx="7" cy="7" r="6.25" fill={color} />
            <path d="M4.9 4.9 9.1 9.1 M9.1 4.9 4.9 9.1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
        {state === 'stale' && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />
            <path d="M7 4.2v3.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="7" cy="9.7" r="0.9" fill={color} />
          </>
        )}
        {state === 'unverified' && <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 1.6" />}
        {state === 'unknown' && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="1 1.4" />
            <path d="M5.6 5.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none" />
            <circle cx="7" cy="10" r="0.8" fill={color} />
          </>
        )}
        {state === 'waived' && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />
            <path d="M3.4 10.6 10.6 3.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
      </svg>
    </Tooltip>
  );
}

export function MethodBadge({ method }: { method?: string }) {
  if (!method) return null;
  return <span className="method-badge">{method}</span>;
}

/** "4/5" with a check, for lists and panels. */
export function VerificationCount({ verified, total, failing = 0, stale = 0 }: { verified: number; total: number; failing?: number; stale?: number }) {
  if (!total) return null;
  const state: CriterionStateName = verified === total ? 'verified' : failing ? 'failing' : stale ? 'stale' : 'unverified';
  return (
    <Tooltip label={`${verified} of ${total} criteria verified${failing ? ` · ${failing} failing` : ''}${stale ? ` · ${stale} stale` : ''}`}>
      <span className="verif-count" data-state={state}>
        <CriterionStateIcon state={state} size={12} />
        {verified}/{total}
      </span>
    </Tooltip>
  );
}

function ResultLine({ r }: { r: VerificationRecord }) {
  const link = r.evidence.ci ?? r.evidence.test;
  return (
    <div className="criterion-result">
      <span className="criterion-result-outcome" data-result={r.result}>
        {r.result}
      </span>
      <span className="inline-icon mono">
        <IconGitCommit size={12} />
        {r.code.repo}@<CommitHash sha={r.code.commit} />
      </span>
      {r.code.branch && (
        <span className="inline-icon mono">
          <IconGitBranch size={12} />
          {r.code.branch}
        </span>
      )}
      <span>{r.by}</span>
      <Tooltip label={absoluteTime(r.at)}>
        <span>{relativeTime(r.at)}</span>
      </Tooltip>
      {r.evidence.test && <span className="mono faint">{r.evidence.test}</span>}
      {link?.startsWith('http') && (
        <a href={link} target="_blank" rel="noreferrer" className="inline-icon">
          CI <IconExternalLink size={11} />
        </a>
      )}
      {r.evidence.note && <span className="faint">“{r.evidence.note}”</span>}
    </div>
  );
}

/** Compact card for an `acceptance` section: state, title, method, statement, last result, history. */
export function AcceptanceCard({ section, state, target }: { section: Section; state?: CriterionState; target?: CopyTarget }) {
  const [open, setOpen] = useState(false);
  const s = state?.state ?? 'unverified';
  return (
    <section id={sectionAnchor(section.id)} data-section-id={section.id} className="criterion-card has-copy-ref" data-state={state ? s : undefined} {...(target ? copyTargetProps(target) : {})}>
      <div className="criterion-head">
        {state ? <CriterionStateIcon state={s} /> : <span className="criterion-bullet" />}
        <span className="criterion-title">{section.title}</span>
        <MethodBadge method={section.method} />
        {section.threshold && (
          <span className="mono faint small">
            {section.threshold.metric}
            {section.threshold.max !== undefined && ` ≤ ${section.threshold.max}`}
            {section.threshold.min !== undefined && ` ≥ ${section.threshold.min}`}
          </span>
        )}
        <span className="section-actions">{target && <CopyRef target={target} />}</span>
      </div>
      {section.body.trim() && (
        <div className="criterion-body">
          <Markdown>{section.body}</Markdown>
        </div>
      )}
      {state?.last && (
        <div className="criterion-last">
          <ResultLine r={state.last} />
          {state.history.length > 1 && (
            <UnstyledButton className="criterion-history-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <IconChevronRight size={11} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> {state.history.length} results
            </UnstyledButton>
          )}
          {open && state.history.slice(1).map((r) => <ResultLine key={r.id} r={r} />)}
        </div>
      )}
      {state && !state.last && <div className="criterion-last faint small">No results yet</div>}
    </section>
  );
}
