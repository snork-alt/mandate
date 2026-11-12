import type {
  AuditFinding,
  AuditItemResult,
  AuditLevel,
  AuditOutcome,
  AuditSummary,
  FindingClassification,
  FindingSeverity,
  FindingStatus,
  LastAudit,
} from '@mandate/shared';
import { parseAuditCodeRef } from '@mandate/shared';
import { mentionOf, parseNodeUri } from '@mandate/shared/refs';
import { appOrigin } from '../project';
import type { CopyTarget } from './refs';

export const OUTCOME_META: Record<AuditOutcome, { label: string; tone: AuditTone }> = {
  pass: { label: 'Pass', tone: 'pass' },
  warn: { label: 'Open should findings', tone: 'warn' },
  fail: { label: 'Open must findings', tone: 'fail' },
  in_progress: { label: 'In progress', tone: 'progress' },
  abandoned: { label: 'Abandoned', tone: 'none' },
};
export type AuditTone = 'pass' | 'warn' | 'fail' | 'stale' | 'progress' | 'none';

export const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Info' };
export const CLASSIFICATION_LABEL: Record<FindingClassification, string> = { code_deviates: 'Code deviates', spec_wrong: 'Spec wrong', ambiguous: 'Ambiguous' };
export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', resolved: 'Resolved', wont_fix: "Won't fix" };
export const RESULT_LABEL: Record<AuditItemResult | 'pending', string> = { pass: 'Pass', fail: 'Fail', partial: 'Partial', n_a: 'N/A', pending: 'Pending' };
export const LEVEL_LABEL: Record<AuditLevel, string> = { must: 'Must', should: 'Should', may: 'May' };

/**
 * Tone of a completed audit for indicators: red = open must findings, orange = open should findings,
 * green = all pass, grey dashed = stale (a stale pass no longer says anything; open findings keep their colour).
 */
export function lastAuditTone(a: Pick<LastAudit, 'result' | 'stale'>): AuditTone {
  const t = OUTCOME_META[a.result].tone;
  return a.stale && (t === 'pass' || t === 'none') ? 'stale' : t;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "codex" / "codex (octocat)". */
export const auditorLabel = (a: { agent: string; user?: string }) => (a.user ? `${a.agent} (${a.user})` : a.agent);

/** UI path of an audit (optionally scrolled to a finding). */
export const auditPath = (id: string, findingId?: string) => `/audits/${id}${findingId ? `#finding-${findingId}` : ''}`;

/** Audit id and finding id of a finding reference. */
export function findingIds(uri: string): { audit: string; id: string } | null {
  const r = parseNodeUri(uri.replace(/^@mandate:/, ''));
  return r?.kind === 'findings' ? { audit: r.audit, id: r.id } : null;
}

/** The last path segment of a reference (`.../work-orders/wo-1` -> `wo-1`). */
export const refId = (uri: string) => {
  const r = parseNodeUri(uri.replace(/^@mandate:/, ''));
  return r && 'id' in r ? r.id : uri.split('/').pop()!;
};

export function findingMarkdown(f: AuditFinding, code?: { repo: string; commit: string }): string {
  const lines = [
    `### ${f.title}`,
    '',
    `${mentionOf(f.uri)} · ${f.severity} · ${CLASSIFICATION_LABEL[f.classification]} · ${FINDING_STATUS_LABEL[f.status]}`,
    `Item: ${mentionOf(f.ref)} (${f.level})`,
  ];
  if (f.description) lines.push('', f.description);
  if (f.codeRefs.length) lines.push('', `Code: ${f.codeRefs.join(', ')}${code ? ` @ ${code.repo}@${code.commit.slice(0, 7)}` : ''}`);
  if (f.evidence) lines.push('', '```', f.evidence, '```');
  return `${lines.join('\n')}\n`;
}

export function findingTarget(f: AuditFinding, code?: { repo: string; commit: string }): CopyTarget {
  const ids = findingIds(f.uri);
  return {
    label: 'finding',
    ref: mentionOf(f.uri),
    markdown: () => findingMarkdown(f, code),
    link: `${appOrigin()}${auditPath(ids?.audit ?? refId(f.audit), f.id)}`,
    extras: [{ label: 'Copy finding id', value: () => f.id }],
  };
}

/** `repo:path#L10-L40` -> code chip input (pinned to the audited commit when known). */
export function codeRefOf(v: string, commit?: string) {
  const p = parseAuditCodeRef(v);
  if (!p) return null;
  return { repo: p.repo, path: p.path, ...(p.lines ? { lines: p.lines.end > p.lines.start ? `${p.lines.start}-${p.lines.end}` : `${p.lines.start}` } : {}), ...(commit ? { commit } : {}) };
}

/** Open findings of a summary (lists and history rows). */
export const openFindings = (s: Pick<AuditSummary, 'findings'>) => s.findings.open;

/** Sort comparator for "Last audited": never audited first, then oldest first. */
export const byLastAudited = (a: { lastAudit?: LastAudit | null }, b: { lastAudit?: LastAudit | null }) =>
  (a.lastAudit?.at ?? '').localeCompare(b.lastAudit?.at ?? '');

export type AuditFilter = 'never' | 'stale' | 'open';
export function matchesAuditFilter(s: { lastAudit?: LastAudit | null }, f: string[]): boolean {
  if (!f.length) return true;
  const la = s.lastAudit;
  return f.some((x) => (x === 'never' ? !la : x === 'stale' ? !!la?.stale : x === 'open' ? (la?.openFindings ?? 0) > 0 : false));
}
