import { Link } from 'react-router';
import { Tooltip } from '@mantine/core';
import { IconListCheck } from '@tabler/icons-react';
import { KindIcon } from '../refs/KindIcon';
import { FINDING_STATUSES, type AuditFinding, type AuditSummary, type LastAudit, type SpecAudits, type StandardAudits } from '@mandate/shared';
import { TimeAgo } from '../TimeAgo';
import { CommitHash } from '../copy';
import { absoluteTime } from '../../lib/time';
import { sectionHref } from '../../lib/links';
import { FINDING_STATUS_LABEL, OUTCOME_META, RESULT_LABEL, auditPath, auditorLabel, lastAuditTone, plural } from '../../lib/audits';
import { AuditDot, AuditTrend, FindingCard, ItemResultIcon, LevelCountsTable, OutcomeBadge, StaleBadge } from './parts';

/* ---------------------------------------------------------------- spec header + row */

/** Spec header line: "Last audited 3 days ago by codex · 2 open findings · stale (5 commits since)", or a faint "Never audited". */
export function LastAuditLine({ last }: { last?: LastAudit | null }) {
  if (!last) return <span className="audit-line faint">Never audited</span>;
  const tone = lastAuditTone(last);
  return (
    <Link to={auditPath(last.id)} className="audit-line" data-tone={tone}>
      <AuditDot tone={tone} size={7} />
      <span>
        Last audited <TimeAgo iso={last.at} /> by {auditorLabel(last.auditor)}
      </span>
      {last.openFindings > 0 && <span className="audit-line-open">· {plural(last.openFindings, 'open finding')}</span>}
      {last.stale && <span className="audit-line-stale">· stale ({plural(last.commitsSince, 'commit')} since)</span>}
    </Link>
  );
}

/** "5m", "3h", "3d", "2w", "4mo", "1y". */
function shortAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  const steps: [number, string][] = [[365 * 86400, 'y'], [30 * 86400, 'mo'], [7 * 86400, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, u] of steps) if (s >= secs) return `${Math.floor(s / secs)}${u}`;
  return 'now';
}

/** Compact spec row indicator: dot + "audited 3d ago" (faint "never audited"); tooltip with the details. */
export function AuditIndicator({ last }: { last?: LastAudit | null }) {
  if (!last) {
    return (
      <Tooltip label="Never audited">
        <span className="row-indicator audit-indicator" data-tone="none" aria-label="Never audited">
          <AuditDot tone="none" size={7} />
        </span>
      </Tooltip>
    );
  }
  const tone = lastAuditTone(last);
  const tip = (
    <div>
      <div style={{ fontWeight: 600 }}>Audited · {OUTCOME_META[last.result].label}</div>
      <div>
        {absoluteTime(last.at)} · {auditorLabel(last.auditor)}
      </div>
      <div>{last.openFindings ? `${plural(last.openFindings, 'open finding')} (${last.openMust} must, ${last.openShould} should)` : 'No open findings'}</div>
      {last.stale && <div>Stale: {plural(last.commitsSince, 'commit')} since</div>}
    </div>
  );
  return (
    <Tooltip label={tip} multiline maw={300}>
      <span className="row-indicator audit-indicator" data-tone={tone} aria-label={`Audited ${shortAge(last.at)} ago`}>
        <AuditDot tone={tone} size={7} />
        {shortAge(last.at)}
      </span>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- spec page panel */

function SummaryHead({ a }: { a: AuditSummary }) {
  return (
    <div className="audit-latest">
      <div className="audit-latest-line">
        <OutcomeBadge outcome={a.outcome} />
        {a.stale && <StaleBadge commitsSince={a.commitsSince} reasons={a.staleReasons} />}
        <Link to={auditPath(a.id)} className="audit-link">
          <TimeAgo iso={a.at} />
        </Link>
        <span className="faint small">by {auditorLabel(a.auditor)}</span>
        <span className="faint small inline-icon">
          Mandate <CommitHash sha={a.commit} />
        </span>
        {a.code && (
          <span className="faint small mono">
            {a.code.repo}@{a.code.commit.slice(0, 7)}
          </span>
        )}
      </div>
      {a.summary && <p className="audit-latest-summary">{a.summary}</p>}
    </div>
  );
}

function FindingGroups({ findings, code }: { findings: AuditFinding[]; code?: { repo: string; commit: string } }) {
  if (!findings.length) return <p className="faint small">No findings.</p>;
  return (
    <>
      {FINDING_STATUSES.map((st) => {
        const list = findings.filter((f) => f.status === st);
        return list.length ? (
          <div key={st} className="audit-finding-group" data-status={st}>
            <div className="audit-group-title">
              {FINDING_STATUS_LABEL[st]} <span className="faint">{list.length}</span>
            </div>
            {list.map((f) => (
              <FindingCard key={f.uri} f={f} code={code} compact showAudit />
            ))}
          </div>
        ) : null;
      })}
    </>
  );
}

function HistoryList({ history }: { history: AuditSummary[] }) {
  return (
    <div className="audit-history">
      {history.map((a) => (
        <Link key={a.id} to={auditPath(a.id)} className="linked-item">
          <AuditDot tone={a.stale && a.outcome === 'pass' ? 'stale' : OUTCOME_META[a.outcome].tone} />
          <KindIcon kind="audit" />
          <span className="linked-title">
            <TimeAgo iso={a.at} /> · {auditorLabel(a.auditor)}
          </span>
          <span className="linked-meta">
            {a.status === 'completed' ? (a.findings.open ? plural(a.findings.open, 'open finding') : OUTCOME_META[a.outcome].label) : OUTCOME_META[a.outcome].label}
          </span>
        </Link>
      ))}
    </div>
  );
}

/** Spec / standard page: latest audit that targeted it, counts per level, findings by status, history with a trend. */
export function AuditsPanel({ audits, kind = 'spec' }: { audits?: Pick<SpecAudits, 'latest' | 'history' | 'findings'>; kind?: 'spec' | 'standard' }) {
  if (!audits) return null;
  const { latest, history, findings } = audits;
  return (
    <section className="audits-panel" aria-label="Audits">
      <h2 className="criteria-group-title">
        <IconListCheck size={18} /> Audits
        {history.length > 1 && <AuditTrend history={history} />}
      </h2>
      {!latest ? (
        <p className="section-empty">
          {kind === 'spec'
            ? 'Never audited. A coding agent can audit this spec against the code with the audit tools.'
            : 'This standard was never audited as a whole. A coding agent can audit it across the code it applies to with the audit tools.'}
        </p>
      ) : (
        <>
          <SummaryHead a={latest} />
          <LevelCountsTable counts={latest.counts} />
          <h3 className="audit-subtitle">Findings</h3>
          <FindingGroups findings={findings ?? []} code={latest.code ? { repo: latest.code.repo, commit: latest.code.commit } : undefined} />
          {history.length > 0 && (
            <>
              <h3 className="audit-subtitle">History · {history.length}</h3>
              <HistoryList history={history} />
            </>
          )}
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- standard page */

/** Standard page: per rule, the latest result in every spec (or whole-standard) audit that checked it; each cell opens that audit. */
export function ComplianceView({ audits }: { audits?: StandardAudits }) {
  if (!audits) return null;
  const { compliance } = audits;
  return (
    <section className="verif-matrix audits-panel compliance-panel" aria-label="Compliance">
      <h2 className="criteria-group-title">
        <IconListCheck size={18} /> Compliance by spec
      </h2>
      {!compliance.rows.length || !compliance.rules.length ? (
        <p className="section-empty">No audit of a spec following this standard checked its rules yet.</p>
      ) : (
        <div className="verif-matrix-scroll">
          <table className="compliance-table">
            <thead>
              <tr>
                <th>Audited</th>
                {compliance.rules.map((r) => {
                  const sid = r.ref.split('/sections/')[1];
                  return (
                    <th key={r.ref}>
                      <Tooltip label={`${r.title} (${r.level})`} multiline maw={320} openDelay={300}>
                        <a href={sid ? `#section-${sid}` : undefined}>{r.title}</a>
                      </Tooltip>
                      <span className="compliance-level" data-level={r.level}>
                        {r.level}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {compliance.rows.map((row) => (
                <tr key={`${row.subject}-${row.audit.id}`}>
                  <td>
                    <span className="compliance-subject">
                      <Link to={row.kind === 'spec' ? sectionHref(row.subject) : auditPath(row.audit.id)}>{row.kind === 'standard' ? 'Whole standard' : row.title}</Link>
                      <Link to={auditPath(row.audit.id)} className="faint small audit-link">
                        <TimeAgo iso={row.audit.at} />
                      </Link>
                      {row.audit.stale && (
                        <span className="audit-badge" data-tone="stale">
                          stale
                        </span>
                      )}
                    </span>
                  </td>
                  {compliance.rules.map((r) => {
                    const res = row.results[r.ref];
                    const open = row.openFindings[r.ref] ?? 0;
                    return (
                      <td key={r.ref} className="verif-cell" data-result={res ?? 'none'}>
                        {res ? (
                          <Tooltip label={`${RESULT_LABEL[res]}${open ? ` · ${plural(open, 'open finding')}` : ''} · open the audit`}>
                            <Link to={auditPath(row.audit.id)} className="compliance-cell" aria-label={`${r.title}: ${RESULT_LABEL[res]}`}>
                              <ItemResultIcon result={res} size={14} />
                              {open > 0 && <span className="compliance-open">{open}</span>}
                            </Link>
                          </Tooltip>
                        ) : (
                          <span className="compliance-none" aria-label="Not audited">
                            not audited
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
