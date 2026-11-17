import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Popover } from '@mantine/core';
import { Link } from 'react-router';
import { type MaturityOverlayKind, type SpecMaturity } from '@mandate/shared';
import { sectionHref } from '../../lib/links';
import { absoluteTime } from '../../lib/time';
import { plural } from '../../lib/audits';
import { refKind, fallbackLabel } from '../refs/kinds';
import { SPEC_STATUS_META } from '../../lib/specs';
import './maturity.css';

const OVERLAY_LABEL: Record<MaturityOverlayKind, string> = { archived: 'Archived', failing: 'Failing', outdated: 'Outdated', blocked: 'Blocked' };

/** Four-step segmented meter (filled up to the step). */
export function MaturityMeter({ stepIndex, tone }: { stepIndex: number; tone: SpecMaturity['tone'] }) {
  return (
    <span className="maturity-meter" data-tone={tone} aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className="maturity-seg" data-on={i <= stepIndex || undefined} />
      ))}
    </span>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

function RefLink({ uri }: { uri: string }) {
  const href = sectionHref(uri);
  const label = fallbackLabel(uri);
  return href && href !== '#' && refKind(uri) ? (
    <Link to={href} className="maturity-ref" onClick={stop}>
      {label}
    </Link>
  ) : (
    <span className="maturity-ref mono">{label}</span>
  );
}

/** Breakdown: sections, criteria, last audit, overlays (with links), stored status vs maturity. */
export function MaturityDetails({ m }: { m: SpecMaturity }) {
  const c = m.criteria;
  const extra = [c.failing && `failing ${c.failing}`, c.stale && `stale ${c.stale}`, c.waived && `waived ${c.waived}`].filter(Boolean).join(', ');
  const stored = SPEC_STATUS_META[m.storedStatus as keyof typeof SPEC_STATUS_META]?.label ?? m.storedStatus;
  return (
    <div className="maturity-details" onClick={stop}>
      <div className="maturity-details-head">
        <MaturityMeter stepIndex={m.stepIndex} tone={m.tone} />
        <strong>{m.label}</strong>
        <span className="faint">step {m.stepIndex}/4</span>
      </div>
      <dl className="maturity-facts">
        <dt>Sections</dt>
        <dd>
          {m.sections.implemented}/{m.sections.total} implemented{m.sections.inProgress ? ` · ${m.sections.inProgress} in progress` : ''}
        </dd>
        <dt>Criteria</dt>
        <dd>
          {c.total ? `${c.verified}/${c.total} verified` : 'none gating'}
          {extra && ` (${extra})`}
        </dd>
        <dt>Audit</dt>
        <dd>{m.audit ? `${absoluteTime(m.audit.at)} · ${m.audit.openFindings ? plural(m.audit.openFindings, 'open finding') : 'no open findings'}${m.audit.stale ? ' · stale' : ''}` : 'Never audited'}</dd>
      </dl>
      {m.overlays.length > 0 && (
        <div className="maturity-overlays">
          {m.overlays.map((o) => (
            <div key={o.kind} className="maturity-overlay" data-kind={o.kind}>
              <span className="maturity-overlay-kind">{OVERLAY_LABEL[o.kind]}</span> {o.reason}
              {o.refs.length > 0 && (
                <div className="maturity-refs">
                  {o.refs.slice(0, 6).map((r) => (
                    <RefLink key={r} uri={r} />
                  ))}
                  {o.refs.length > 6 && <span className="faint">+{o.refs.length - 6}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Maturity is the one user-facing state; the author-set status is only a secondary detail here (X1). */}
      <div className="maturity-stored faint" data-testid="maturity-stored">
        Set by the author: {stored}
      </div>
    </div>
  );
}

/**
 * The breakdown card: opens on hover, and on focus + Enter / Space or a click / tap (hover-only information is not
 * reachable by keyboard or touch). Clicks on the trigger do not reach an enclosing row link.
 */
function WithDetails({ m, children }: { m: SpecMaturity; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const later = (v: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpened(v), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const toggle = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer.current);
    setOpened((o) => !o);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') toggle(e);
    else if (e.key === 'Escape' && opened) (e.stopPropagation(), setOpened(false));
  };
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" withinPortal shadow="md" width={320} transitionProps={{ duration: 100 }}>
      <Popover.Target>
        <span
          className="maturity-trigger"
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          aria-expanded={opened}
          data-testid="maturity-trigger"
          onMouseEnter={() => later(true, 250)}
          onMouseLeave={() => later(false, 120)}
          onClick={toggle}
          onKeyDown={onKey}
        >
          {children}
        </span>
      </Popover.Target>
      <Popover.Dropdown onClick={stop} onMouseDown={stop} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={() => later(false, 120)}>
        <MaturityDetails m={m} />
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * The one maturity badge: segmented meter + label in the step tone; with an overlay, the overlay's tone and a
 * small marker naming it (the step label stays). Hover: the full breakdown.
 */
export function MaturityBadge({ m, size = 'md' }: { m: SpecMaturity; size?: 'sm' | 'md' }) {
  const o = m.overlays[0];
  return (
    <WithDetails m={m}>
      <span className="maturity-badge" role="img" data-tone={m.tone} data-size={size} data-step={m.step} aria-label={`Maturity: ${m.label}${o ? ` · ${OVERLAY_LABEL[o.kind]}` : ''}`}>
        <MaturityMeter stepIndex={m.stepIndex} tone={m.tone} />
        <span className="maturity-label">{m.label}</span>
        {o && (
          <span className="maturity-marker" data-kind={o.kind}>
            {OVERLAY_LABEL[o.kind]}
            {m.overlays.length > 1 ? ` +${m.overlays.length - 1}` : ''}
          </span>
        )}
      </span>
    </WithDetails>
  );
}

/** Meter only (graph nodes, chips, palette rows); hover shows the breakdown. */
export function MaturityDot({ m, details = true }: { m: SpecMaturity; details?: boolean }) {
  const o = m.overlays[0];
  const el = (
    <span className="maturity-dot" data-tone={m.tone} aria-label={`Maturity: ${m.label}${o ? ` · ${OVERLAY_LABEL[o.kind]}` : ''}`} role="img">
      <MaturityMeter stepIndex={m.stepIndex} tone={m.tone} />
    </span>
  );
  return details ? <WithDetails m={m}>{el}</WithDetails> : el;
}

export { OVERLAY_LABEL };
