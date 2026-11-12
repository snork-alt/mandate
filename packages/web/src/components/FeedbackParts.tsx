import { SpecMaturityDot } from './maturity/SpecMaturity';
import { parseRef } from '@mandate/shared/refs';
import { Tooltip } from '@mantine/core';
import type { Feedback, FeedbackChange } from '@mandate/shared';
import { Link } from 'react-router';
import { FEEDBACK_KIND_META, FEEDBACK_STATUS_META, RESOLUTION_META, firstLine, targetLabel } from '../lib/feedback';

export function FeedbackKindIcon({ kind, size = 15 }: { kind: Feedback['kind']; size?: number }) {
  const { icon: Icon, color, label } = FEEDBACK_KIND_META[kind];
  return (
    <Tooltip label={label}>
      <span style={{ display: 'inline-flex', color, flexShrink: 0 }} aria-label={label}>
        <Icon size={size} stroke={1.8} />
      </span>
    </Tooltip>
  );
}

/** Linear-style status glyph: dashed ring = open, half = accepted, filled = closed (✓ applied, ✕ rejected, ⧉ duplicate). */
export function FeedbackStatusIcon({ status, resolution, size = 14 }: { status: Feedback['status']; resolution?: Feedback['resolution']; size?: number }) {
  const label = status === 'closed' && resolution ? `Closed · ${RESOLUTION_META[resolution].label}` : FEEDBACK_STATUS_META[status].label;
  const color =
    status === 'open'
      ? 'var(--mantine-color-yellow-6)'
      : status === 'accepted'
        ? 'var(--mantine-primary-color-filled)'
        : resolution === 'applied'
          ? 'var(--mantine-color-teal-6)'
          : 'var(--app-text-faint)';
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" role="img" aria-label={label} style={{ flexShrink: 0 }}>
      {status === 'open' && <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 1.6" />}
      {status === 'accepted' && (
        <>
          <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />
          <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill={color} />
        </>
      )}
      {status === 'closed' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill={color} />
          {resolution === 'applied' && <path d="M4.4 7.2 6.2 9 9.7 5.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
          {resolution === 'rejected' && <path d="M4.9 4.9 9.1 9.1 M9.1 4.9 4.9 9.1" stroke="var(--app-bg)" strokeWidth="1.5" strokeLinecap="round" />}
          {resolution === 'duplicate' && (
            <>
              <rect x="3.6" y="4.6" width="4.6" height="4.6" rx="1" stroke="var(--app-bg)" strokeWidth="1.2" />
              <rect x="5.8" y="3" width="4.6" height="4.6" rx="1" stroke="var(--app-bg)" strokeWidth="1.2" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

export function FeedbackStatus({ status, resolution }: { status: Feedback['status']; resolution?: Feedback['resolution'] }) {
  return (
    <span className="fb-status">
      <FeedbackStatusIcon status={status} resolution={resolution} />
      {FEEDBACK_STATUS_META[status].label}
      {status === 'closed' && resolution && <span className="faint">· {RESOLUTION_META[resolution].label}</span>}
    </span>
  );
}

const specIdOf = (target: string) => {
  const r = parseRef(target);
  return r?.kind === 'specs' ? r.id : undefined;
};

export function TargetChip({ target, titles, plain, short }: { target: string; titles?: Map<string, string>; /** Render as text (inside another link). */ plain?: boolean; /** Document title only (lists, when space is short); the full label in a tooltip. */ short?: boolean }) {
  const t = targetLabel(target, titles);
  if (plain && short) {
    return (
      <Tooltip label={t.label}>
        <span className="fb-target" data-kind={t.kind}>
          {t.title}
        </span>
      </Tooltip>
    );
  }
  if (plain) {
    return (
      <span className="fb-target" data-kind={t.kind}>
        {t.label}
      </span>
    );
  }
  return (
    <Link to={t.href} className="fb-target" onClick={(e) => e.stopPropagation()} data-kind={t.kind}>
      {t.label}
      {specIdOf(target) && <SpecMaturityDot id={specIdOf(target)!} />}
    </Link>
  );
}

export const ACTION_LABEL: Record<FeedbackChange['action'], string> = { created: 'Created', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

export function ActionBadge({ action }: { action: FeedbackChange['action'] }) {
  return (
    <span className="action-badge" data-action={action}>
      {ACTION_LABEL[action]}
    </span>
  );
}

/** Compact feedback list (panels on spec, standard and work-order pages). */
export function FeedbackList({ items }: { items: Feedback[] }) {
  if (!items.length) return <span className="faint small">No feedback yet</span>;
  return (
    <>
      {items.map((f) => (
        <Link key={f.id} to={`/feedback/${f.id}`} className="linked-item fb-linked">
          <FeedbackStatusIcon status={f.status} resolution={f.resolution} />
          <span className="linked-title">{firstLine(f.body)}</span>
          <FeedbackKindIcon kind={f.kind} size={13} />
        </Link>
      ))}
    </>
  );
}

/** An open work order acting on a feedback item (pending / in progress). */
export interface OpenWorkOrderRef {
  id: string;
  status: string;
  title?: string;
}

/**
 * The outcome column of the feedback list: "✓ 3 changes", "✕ rejected", "⧉ duplicate", or "→ q-0007" while an open
 * work order acts on it. Plain text (it sits inside the row link); details in a tooltip.
 */
export function FeedbackOutcome({ f, workOrder }: { f: Pick<Feedback, 'status' | 'resolution' | 'resolutionNote' | 'duplicateOf' | 'changes'>; workOrder?: OpenWorkOrderRef }) {
  const n = f.changes.length;
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  let glyph = '';
  let text = '';
  let tip: string = '';
  let tone: string | undefined;
  if (f.status === 'closed' && f.resolution === 'applied') {
    [glyph, text, tone, tip] = ['✓', n ? changes : 'applied', 'ok', `Applied${n ? ` · ${changes}` : ''}`];
  } else if (f.status === 'closed' && f.resolution === 'rejected') {
    [glyph, text, tone, tip] = ['✕', 'rejected', 'muted', f.resolutionNote ? `Rejected: ${f.resolutionNote}` : 'Rejected'];
  } else if (f.status === 'closed' && f.resolution === 'duplicate') {
    [glyph, text, tone, tip] = ['⧉', 'duplicate', 'muted', f.duplicateOf ? `Duplicate of ${f.duplicateOf}` : 'Duplicate'];
  } else if (workOrder) {
    [glyph, text, tone, tip] = ['→', workOrder.id, 'active', `Work order ${workOrder.id} · ${workOrder.status.replace('_', ' ')}${workOrder.title ? ` · ${workOrder.title}` : ''}`];
  } else if (n) {
    [glyph, text, tone, tip] = ['', changes, 'muted', changes];
  } else return null;
  return (
    <Tooltip label={tip} multiline maw={320}>
      <span className="fb-outcome" data-tone={tone} data-testid="fb-outcome">
        {glyph && <span className="fb-outcome-glyph">{glyph}</span>}
        <span className={workOrder && !f.resolution ? 'mono' : undefined}>{text}</span>
      </span>
    </Tooltip>
  );
}
