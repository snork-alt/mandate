import { useMemo } from 'react';
import { Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleX, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { INTEGRITY_RULE, integritySeverity, refLabel, type GitStatus, type IntegrityIssue } from '@mandate/shared';
import { api } from '../api';
import { TopBar } from '../components/TopBar';
import { FilterButton } from '../components/FilterButton';
import { SearchInput } from '../components/SearchInput';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { refHref } from '../components/refs/kinds';
import { pushSummary } from '../lib/push';
import '../components/integrity/integrity.css';

export type Severity = 'error' | 'warning';
const SEVERITIES: Severity[] = ['error', 'warning'];
const SEV_LABEL: Record<Severity, string> = { error: 'Errors', warning: 'Warnings' };

export const severityOf = (i: IntegrityIssue): Severity => i.severity ?? integritySeverity(i.rule);
/** "dangling_link" → "Dangling link". */
export const ruleLabel = (rule: string) => {
  const s = rule.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export interface IntegrityFilter {
  severity: string[];
  kind: string[];
  q: string;
}

/** Issues matching the filters (severity, rule kind, text in message / hint / element / rule). */
export function filterIssues(issues: IntegrityIssue[], f: IntegrityFilter): IntegrityIssue[] {
  const q = f.q.trim().toLowerCase();
  return issues.filter(
    (i) =>
      (!f.severity.length || f.severity.includes(severityOf(i))) &&
      (!f.kind.length || f.kind.includes(i.rule)) &&
      (!q || [i.message, i.hint ?? '', i.uri, i.rule, safeLabel(i.uri)].some((s) => s.toLowerCase().includes(q))),
  );
}

/** Severity → rule → issues, errors first, rules alphabetical. */
export function groupIssues(issues: IntegrityIssue[]): { severity: Severity; rules: { rule: string; issues: IntegrityIssue[] }[] }[] {
  return SEVERITIES.map((severity) => {
    const byRule = new Map<string, IntegrityIssue[]>();
    for (const i of issues) if (severityOf(i) === severity) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
    return { severity, rules: [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rule, list]) => ({ rule, issues: list })) };
  }).filter((g) => g.rules.length > 0);
}

function safeLabel(uri: string) {
  try {
    return refLabel(uri);
  } catch {
    return uri;
  }
}

const SevIcon = ({ s }: { s: Severity }) =>
  s === 'error' ? <IconCircleX size={15} className="integ-sev" data-sev="error" aria-hidden /> : <IconAlertTriangle size={15} className="integ-sev" data-sev="warning" aria-hidden />;

function IssueRow({ issue }: { issue: IntegrityIssue }) {
  const href = refHref(issue.uri);
  const label = safeLabel(issue.uri);
  return (
    <li className="integ-issue" data-testid="integrity-issue">
      <div className="integ-issue-head">
        {href ? (
          <Link to={href} className="integ-target">
            {label}
          </Link>
        ) : (
          <span className="integ-target integ-target-plain">{label}</span>
        )}
      </div>
      <div className="integ-message">{issue.message}</div>
      {issue.hint && <div className="integ-hint">Fix: {issue.hint}</div>}
    </li>
  );
}

function RepoSummary({ s }: { s: GitStatus }) {
  const push = pushSummary(s.autoPush);
  return (
    <div className="integ-repo" data-testid="integrity-repo">
      <span>
        <b>{s.branch ?? 'detached'}</b>
        {s.head && <code> {s.head.slice(0, 7)}</code>}
      </span>
      <span>{s.clean ? 'clean' : `${s.files.length} uncommitted`}</span>
      <span>Remote: {s.remote ?? 'none (commits stay local)'}</span>
      {push && <span style={{ color: push.color }}>{push.text}</span>}
      {s.integrity?.at && <span>Checked {new Date(s.integrity.at).toLocaleString()}</span>}
    </div>
  );
}

/** All integrity issues of the repository (repo lint), grouped by severity and rule, with filters. */
export function IntegrityPage() {
  const status = useQuery({ queryKey: ['git', 'status'], queryFn: api.gitStatus, refetchInterval: 15_000 });
  const [params, setParams] = useSearchParams();
  const list = (k: string) => params.get(k)?.split(',').filter(Boolean) ?? [];
  const filter: IntegrityFilter = { severity: list('severity'), kind: list('kind'), q: params.get('q') ?? '' };
  const set = (k: string, v: string | string[]) => {
    const next = new URLSearchParams(params);
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s) next.set(k, s);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const all = useMemo(() => status.data?.integrity?.issues ?? [], [status.data]);
  const visible = filterIssues(all, filter);
  const groups = groupIssues(visible);
  const count = (pred: (i: IntegrityIssue) => boolean) => all.filter(pred).length;
  const rules = [...new Set(all.map((i) => i.rule))].sort();

  return (
    <>
      <TopBar crumbs={[{ label: 'Integrity' }]} />
      {status.data && <RepoSummary s={status.data} />}
      <div className="toolbar">
        <FilterButton
          label="Severity"
          options={SEVERITIES.map((s) => ({ value: s, label: s === 'error' ? 'Error' : 'Warning', icon: <SevIcon s={s} />, count: count((i) => severityOf(i) === s) }))}
          selected={filter.severity}
          onChange={(v) => set('severity', v)}
          clearable
        />
        <FilterButton
          label="Kind"
          options={rules.map((r) => ({ value: r, label: ruleLabel(r), count: count((i) => i.rule === r) }))}
          selected={filter.kind}
          onChange={(v) => set('kind', v)}
          searchable
          clearable
        />
        <SearchInput value={filter.q} onChange={(v) => set('q', v)} placeholder="Search issues…" />
      </div>

      {status.isPending && <RowsSkeleton rows={6} />}
      {status.isError && <ErrorState error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && all.length === 0 && (
        <EmptyView icon={<IconShieldCheck size={22} stroke={1.5} />} title="No integrity issues" description="The repository passes every integrity rule." />
      )}
      {status.data && all.length > 0 && visible.length === 0 && (
        <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matching issues" description="Try another filter or search term." />
      )}
      {groups.map((g) => (
        <section key={g.severity} className="integ-group" data-testid={`integrity-group-${g.severity}`}>
          <h2 className="integ-group-title">
            <SevIcon s={g.severity} />
            <span>{SEV_LABEL[g.severity]}</span>
            <Text component="span" size="sm" c="var(--app-text-muted)">
              {g.rules.reduce((n, r) => n + r.issues.length, 0)}
            </Text>
          </h2>
          {g.rules.map((r) => (
            <div key={r.rule} className="integ-rule">
              <h3 className="integ-rule-title">
                {ruleLabel(r.rule)} <span className="integ-rule-count">{r.issues.length}</span>
              </h3>
              {INTEGRITY_RULE[r.rule] && <p className="integ-rule-what">{INTEGRITY_RULE[r.rule]!.what}</p>}
              <ul className="integ-list">
                {r.issues.map((i, n) => (
                  <IssueRow key={`${i.uri}-${i.message}-${n}`} issue={i} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
