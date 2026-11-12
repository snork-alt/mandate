import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Tooltip } from '@mantine/core';
import { IconArrowUpRight, IconCircleCheck, IconCircleDashed, IconCircleHalf2, IconCircleOff, IconCircleX, IconClipboardList, IconHistory, IconMessageReport } from '@tabler/icons-react';
import { AUDIT_ITEM_RESULTS, AUDIT_LEVELS, type AuditFinding, type AuditItemResult, type AuditLevel, type AuditOutcome, type AuditSummary, type FindingSeverity, type FindingStatus, type LevelCounts } from '@mandate/shared';
import { CodeRefChip } from '../doc';
import { CodeBlock } from '../CodeBlock';
import { Markdown } from '../Markdown';
import { CopyRef, copyTargetProps } from '../copy';
import { TimeAgo } from '../TimeAgo';
import { absoluteTime } from '../../lib/time';
import {
  CLASSIFICATION_LABEL,
  FINDING_STATUS_LABEL,
  LEVEL_LABEL,
  OUTCOME_META,
  RESULT_LABEL,
  SEVERITY_LABEL,
  auditPath,
  auditorLabel,
  codeRefOf,
  findingTarget,
  plural,
  refId,
  type AuditTone,
} from '../../lib/audits';
import { Contributors } from '../people/People';
import './audits.css';

/** Small status dot: solid for pass / warn / fail, grey dashed ring when stale. */
export function AuditDot({ tone, size = 8, label }: { tone: AuditTone; size?: number; label?: string }) {
  return <span className="audit-dot" data-tone={tone} style={{ width: size, height: size }} aria-label={label} role={label ? 'img' : undefined} />;
}

export function ItemResultIcon({ result, size = 14 }: { result?: AuditItemResult; size?: number }) {
  const common = { size, stroke: 1.7, 'aria-label': RESULT_LABEL[result ?? 'pending'] };
  switch (result) {
    case 'pass':
      return <IconCircleCheck {...common} color="var(--mantine-color-teal-6)" />;
    case 'fail':
      return <IconCircleX {...common} color="var(--mantine-color-red-6)" />;
    case 'partial':
      return <IconCircleHalf2 {...common} color="var(--mantine-color-orange-6)" />;
    case 'n_a':
      return <IconCircleOff {...common} color="var(--app-text-faint)" />;
    default:
      return <IconCircleDashed {...common} color="var(--app-text-muted)" />;
  }
}

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return (
    <span className="audit-badge" data-severity={severity}>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return (
    <span className="audit-badge" data-status={status}>
      {FINDING_STATUS_LABEL[status]}
    </span>
  );
}

export function OutcomeBadge({ outcome, stale }: { outcome: AuditOutcome; stale?: boolean }) {
  return (
    <span className="audit-badge" data-tone={OUTCOME_META[outcome].tone} data-stale={stale || undefined}>
      <AuditDot tone={OUTCOME_META[outcome].tone} size={7} />
      {OUTCOME_META[outcome].label}
    </span>
  );
}

/** "stale · 5 commits since" with the reasons as tooltip. */
export function StaleBadge({ commitsSince, reasons = [] }: { commitsSince: number; reasons?: string[] }) {
  const badge = (
    <span className="audit-badge" data-tone="stale">
      Stale{commitsSince > 0 ? ` · ${plural(commitsSince, 'commit')} since` : ''}
    </span>
  );
  return reasons.length ? (
    <Tooltip label={<div>{reasons.map((r) => <div key={r}>{r}</div>)}</div>} multiline maw={360}>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}

/** pass / fail / partial / n_a / pending per level (rows without any item are hidden). */
export function LevelCountsTable({ counts }: { counts: Record<AuditLevel, LevelCounts> }) {
  const cols = [...AUDIT_ITEM_RESULTS, 'pending'] as const;
  const levels = AUDIT_LEVELS.filter((l) => cols.some((c) => counts[l]?.[c]));
  if (!levels.length) return <span className="faint small">No checklist items</span>;
  return (
    <table className="audit-counts">
      <thead>
        <tr>
          <th />
          {cols.map((c) => (
            <th key={c}>
              <Tooltip label={RESULT_LABEL[c]} openDelay={300}>
                <span>
                  <ItemResultIcon result={c === 'pending' ? undefined : c} size={13} />
                  <span className="audit-counts-label">{RESULT_LABEL[c]}</span>
                </span>
              </Tooltip>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {levels.map((l) => (
          <tr key={l}>
            <th scope="row">{LEVEL_LABEL[l]}</th>
            {cols.map((c) => (
              <td key={c} data-zero={!counts[l][c] || undefined} data-result={c}>
                {counts[l][c]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Outcome dots, oldest to newest (each links to its audit), plus a sparkline of open findings. */
export function AuditTrend({ history }: { history: AuditSummary[] }) {
  const list = [...history].reverse().slice(-20);
  if (!list.length) return null;
  const max = Math.max(1, ...list.map((a) => a.findings.open));
  const w = Math.max(40, list.length * 10);
  const pts = list.map((a, i) => `${list.length === 1 ? w / 2 : (i / (list.length - 1)) * (w - 4) + 2},${16 - (a.findings.open / max) * 13}`).join(' ');
  return (
    <span className="audit-trend" aria-label="Audit trend">
      <span className="audit-trend-dots">
        {list.map((a) => (
          <Tooltip key={a.id} label={`${absoluteTime(a.at)} · ${OUTCOME_META[a.outcome].label} · ${plural(a.findings.open, 'open finding')}`}>
            <Link to={auditPath(a.id)} className="audit-trend-dot" aria-label={`Audit ${a.id}`}>
              <AuditDot tone={OUTCOME_META[a.outcome].tone} size={8} />
            </Link>
          </Tooltip>
        ))}
      </span>
      {list.length > 1 && (
        <Tooltip label="Open findings per audit">
          <svg className="audit-spark" width={w} height={18} viewBox={`0 0 ${w} 18`} aria-hidden="true">
            <polyline points={pts} fill="none" strokeWidth={1.5} />
          </svg>
        </Tooltip>
      )}
    </span>
  );
}

/** Work order / feedback created from a finding, and the re-check that resolved it. */
function Resolution({ f }: { f: AuditFinding }) {
  const r = f.resolution;
  const items: ReactNode[] = [];
  if (r.workOrder) {
    const id = refId(r.workOrder);
    items.push(
      <Link key="wo" to={`/work-orders/${id}`} className="audit-link">
        <IconClipboardList size={13} /> Fix work order <span className="mono">{id}</span>
        {r.workOrderStatus && <span className="faint"> · {r.workOrderStatus.replace(/_/g, ' ')}</span>}
      </Link>,
    );
  }
  if (r.feedback) {
    const id = refId(r.feedback);
    items.push(
      <Link key="fb" to={`/feedback/${id}`} className="audit-link">
        <IconMessageReport size={13} /> Feedback <span className="mono">{id}</span>
        {r.feedbackStatus && <span className="faint"> · {r.feedbackStatus.replace(/_/g, ' ')}</span>}
      </Link>,
    );
  }
  if (!items.length && !f.rechecks.length && !r.notes) return null;
  return (
    <div className="audit-resolution">
      {items}
      {r.status !== 'open' && r.notes && (
        <div className="small">
          <span className="faint">{FINDING_STATUS_LABEL[r.status]}{r.by ? ` by ${r.by}` : ''}{r.commit ? ` @${r.commit.slice(0, 7)}` : ''}:</span> {r.notes}
        </div>
      )}
      {f.rechecks.length > 0 && (
        <div className="audit-rechecks">
          <span className="faint small inline-icon">
            <IconHistory size={12} /> Re-checks
          </span>
          {f.rechecks.map((c, i) => (
            <div key={`${c.at}-${i}`} className="audit-recheck small">
              <ItemResultIcon result={c.result === 'wont_fix' ? 'n_a' : c.result} size={12} />
              <span>{c.result === 'wont_fix' ? "won't fix" : c.result}</span>
              <span className="faint">
                <TimeAgo iso={c.at} /> by {c.by}
                {c.commit ? ` @${c.commit.slice(0, 7)}` : ''}
              </span>
              {c.notes && <span className="audit-recheck-notes">{c.notes}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A finding: title, badges, item, description, evidence, code refs and resolution. `compact` hides evidence. */
export function FindingCard({ f, code, compact, showAudit }: { f: AuditFinding; code?: { repo: string; commit: string }; compact?: boolean; showAudit?: boolean }) {
  const target = findingTarget(f, code);
  const refs = f.codeRefs.map((r) => ({ raw: r, chip: codeRefOf(r, code?.commit) }));
  return (
    <div className="audit-finding has-copy-ref" id={`finding-${f.id}`} data-status={f.status} {...copyTargetProps(target)}>
      <div className="audit-finding-head">
        <SeverityBadge severity={f.severity} />
        <span className="audit-finding-title">{f.title}</span>
        <span className="section-people finding-people" data-testid="finding-people">
          <Contributors refUri={f.uri} size="xs" max={3} form="compact" />
        </span>
        <span className="audit-finding-actions">
          <CopyRef target={target} size="xs" />
        </span>
      </div>
      <div className="audit-finding-meta small">
        <FindingStatusBadge status={f.status} />
        <span className="audit-badge" data-classification={f.classification}>
          {CLASSIFICATION_LABEL[f.classification]}
        </span>
        <span className="faint">
          {LEVEL_LABEL[f.level]} · {f.itemTitle}
        </span>
        {showAudit && (
          <Link to={auditPath(f.audit.includes('/') ? refId(f.audit) : f.audit, f.id)} className="faint audit-link">
            <IconArrowUpRight size={12} /> open in audit
          </Link>
        )}
      </div>
      {f.description && (
        <div className="audit-finding-desc">
          <Markdown>{f.description}</Markdown>
        </div>
      )}
      {!compact && f.suggestedFix && (
        <div className="audit-finding-fix">
          <span className="audit-finding-label">Suggested fix</span>
          <Markdown>{f.suggestedFix}</Markdown>
        </div>
      )}
      {refs.length > 0 && (
        <div className="audit-coderefs">
          {refs.map((r) =>
            r.chip ? (
              <CodeRefChip key={r.raw} codeRef={r.chip} />
            ) : (
              <span key={r.raw} className="mono small">
                {r.raw}
              </span>
            ),
          )}
        </div>
      )}
      {!compact && f.evidence && (
        <div className="audit-evidence">
          <span className="audit-finding-label">Evidence</span>
          {/^\s*```/.test(f.evidence) ? <Markdown>{f.evidence}</Markdown> : <CodeBlock code={f.evidence} />}
        </div>
      )}
      <Resolution f={f} />
    </div>
  );
}

export function AuditorLine({ a }: { a: { agent: string; user?: string } }) {
  return <span>{auditorLabel(a)}</span>;
}
