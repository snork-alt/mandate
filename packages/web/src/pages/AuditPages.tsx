import { useEffect, useMemo, useState } from 'react';
import { Skeleton, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconBrandGit, IconFileOff, IconListCheck, IconSearch } from '@tabler/icons-react';
import { KindIcon } from '../components/refs/KindIcon';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { FINDING_STATUSES, type Audit, type AuditSummary, type StoredAudit } from '@mandate/shared';
import { api } from '../api';
import { useMcpTool } from '../mcp/queries';
import { DocPage } from '../components/doc';
import { useTrackedChanges } from '../components/doc/tracked';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { TimeAgo } from '../components/TimeAgo';
import { ListHeader, ListRow, RowTime, withNodes, type ColDef } from '../components/list/ListRow';
import { absoluteTime } from '../lib/time';
import { TopBar } from '../components/TopBar';
import { CommitHash, CopyRef, copyTargetProps } from '../components/copy';
import { RefChip } from '../components/refs/RefChip';
import { AuditViewContext } from '../components/audits/context';
import { AuditItemBadge } from '../components/audits/AuditItem';
import { AuditDot, ItemResultIcon, LevelCountsTable, OutcomeBadge, SeverityBadge, StaleBadge } from '../components/audits/parts';
import { useHistory } from '../lib/queries';
import { FINDING_STATUS_LABEL, OUTCOME_META, auditorLabel, plural } from '../lib/audits';
import { docTarget } from '../lib/refs';
import { useNow, withFrontmatter } from '../lib/specs';
import { useSearchQuery, matches } from '../lib/useSearchQuery';
import { SearchInput } from '../components/SearchInput';
import { RowPeople } from '../components/people/People';
import { bareRef } from '../lib/lineage';

/** `doc_get {kind:'audits'}`: the stored document plus git meta and the derived view. */
export type AuditDoc = StoredAudit & {
  audit?: Audit;
  lastCommit?: string | null;
  updatedAt?: string;
  versionCount?: number;
};

/** Scroll to `#finding-<fid>` once the (lazy) section bodies have rendered. */
function useFindingAnchor(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash.startsWith('#finding-')) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el || ++tries > 30) {
        clearInterval(t);
        el?.scrollIntoView({ block: 'center' });
        el?.setAttribute('data-highlight', 'true');
      }
    }, 100);
    return () => clearInterval(t);
  }, [ready, hash]);
}

/** Header: target, outcome, auditor, dates, commits, staleness. */
function AuditHeader({ doc, view }: { doc: AuditDoc; view?: Audit }) {
  const stale = view?.staleness;
  return (
    <>
      <h1 className="doc-title">{doc.title}</h1>
      {doc.summary && <p className="doc-summary">{doc.summary}</p>}
      <div className="doc-pills">
        {view ? <OutcomeBadge outcome={view.outcome} /> : <span className="audit-badge">{doc.status.replace('_', ' ')}</span>}
        {stale?.stale && <StaleBadge commitsSince={stale.commitsSince} reasons={stale.reasons} />}
        <span className="audit-header-target">
          <span className="faint small">Audit of</span>
          <RefChip to={doc.target} />
        </span>
        <span className="doc-updated">
          {doc.completedAt ? (
            <>
              Completed <TimeAgo iso={doc.completedAt} />
            </>
          ) : doc.abandonedAt ? (
            <>
              Abandoned <TimeAgo iso={doc.abandonedAt} />
            </>
          ) : (
            <>
              Started <TimeAgo iso={doc.startedAt} />
            </>
          )}{' '}
          by {auditorLabel(doc.auditor)}
        </span>
      </div>
      {doc.abandonReason && <p className="faint small">Abandoned: {doc.abandonReason}</p>}
    </>
  );
}

function AuditPanels({ doc, view }: { doc: AuditDoc; view?: Audit }) {
  const findings = (view?.items ?? []).flatMap((i) => i.findings);
  return (
    <>
      <PropGroup title="Audit">
        <Prop label="Outcome">{view ? <OutcomeBadge outcome={view.outcome} /> : <span className="faint">{doc.status}</span>}</Prop>
        <Prop label="Auditor">{auditorLabel(doc.auditor)}</Prop>
        <Prop label="Started">
          <TimeAgo iso={doc.startedAt} />
        </Prop>
        {doc.completedAt && (
          <Prop label="Completed">
            <TimeAgo iso={doc.completedAt} />
          </Prop>
        )}
        <Prop label="Mandate">
          <Tooltip label="Mandate commit the checklist was taken at">
            <span>
              <CommitHash sha={doc.commit} />
            </span>
          </Tooltip>
        </Prop>
        <Prop label="Code">
          {doc.code ? (
            <span className="inline-icon">
              <IconBrandGit size={14} className="prop-icon" />
              <span className="mono small">
                {doc.code.repo}@{doc.code.commit.slice(0, 7)}
                {doc.code.branch ? ` (${doc.code.branch})` : ''}
              </span>
            </span>
          ) : (
            <span className="faint">Not recorded</span>
          )}
        </Prop>
        {view?.staleness && (
          <Prop label="Freshness">
            {view.staleness.stale ? <StaleBadge commitsSince={view.staleness.commitsSince} reasons={view.staleness.reasons} /> : <span className="faint">Up to date</span>}
          </Prop>
        )}
      </PropGroup>
      {view && (
        <PropGroup title="Checklist">
          <LevelCountsTable counts={view.counts} />
        </PropGroup>
      )}
      {findings.length > 0 && (
        <PropGroup title={`Findings · ${view!.findings.open} open`}>
          {FINDING_STATUSES.map((st) => {
            const list = findings.filter((f) => f.status === st);
            return list.length ? (
              <div key={st}>
                <div className="prop-subtitle">{FINDING_STATUS_LABEL[st]}</div>
                {list.map((f) => (
                  <a key={f.id} href={`#finding-${f.id}`} className="linked-item">
                    <SeverityBadge severity={f.severity} />
                    <KindIcon kind="finding" />
                    <span className="linked-title">{f.title}</span>
                  </a>
                ))}
              </div>
            ) : null;
          })}
        </PropGroup>
      )}
    </>
  );
}

/** One audit report, shown like a spec: overview + one section per checklist item (history, versions, copy refs). */
export function AuditDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useQuery({ queryKey: ['audits', id], queryFn: () => api.get('audits', id) as unknown as Promise<AuditDoc> });
  const history = useHistory('audits', id);
  const tracked = useTrackedChanges('audits', id);
  const now = useNow();
  const after = tracked.commit ? tracked.data?.diff.after : undefined;
  const doc = query.data && after ? withFrontmatter(query.data, 'audits', after.frontmatter as Record<string, unknown>) : query.data;
  const view = tracked.commit ? undefined : doc?.audit;
  const crumbs = [{ label: 'Audits', to: '/audits' }, { label: <span className="mono">{id}</span>, kind: 'audit' as const }];
  useFindingAnchor(!!doc);
  const outlineStatus = useMemo(
    () => new Map((doc?.sections ?? []).filter((s) => s.type === 'audit-item').map((s) => [s.id, <ItemResultIcon key={s.id} result={s.result && s.result !== 'pending' ? s.result : undefined} size={12} />])),
    [doc?.sections],
  );

  if (query.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="doc-main" style={{ margin: '0 auto' }}>
          <Skeleton height={30} width="50%" mb="md" />
          <Skeleton height={14} width="70%" mb="xl" />
          <Skeleton height={160} />
        </div>
      </>
    );
  }
  if (!doc) {
    const notFound = /not found/i.test(query.error?.message ?? '');
    return (
      <>
        <TopBar crumbs={crumbs} />
        {notFound ? (
          <EmptyView
            icon={<IconFileOff size={22} stroke={1.5} />}
            title="Audit not found"
            description={`There is no audit with id "${id}".`}
            action={
              <Text component={Link} to="/audits" size="md" c="var(--mantine-primary-color-filled)">
                Back to audits
              </Text>
            }
          />
        ) : (
          <ErrorState error={query.error ?? new Error('Unknown error')} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  return (
    <AuditViewContext.Provider value={view ?? null}>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'audits', id: doc.id, title: doc.title }}
        header={<AuditHeader doc={doc} view={view} />}
        sections={doc.sections}
        history={{ entries: history.data, loading: history.isPending, now }}
        tracked={tracked}
        topPanels={<AuditPanels doc={doc} view={view} />}
        headCommit={doc.lastCommit ?? null}
        outlineStatus={outlineStatus}
        sectionBadge={(section) => <AuditItemBadge section={section} />}
      />
    </AuditViewContext.Provider>
  );
}

/* ---------------------------------------------------------------- list */

const AUDIT_COLS: ColDef[] = [
  { key: 'findings', width: 112, hide: 'sm', label: 'Findings', tip: 'Open findings (red: at least one MUST rule broken)' },
  { key: 'stale', width: 132, hide: 'xl', label: 'Freshness', tip: 'Stale: commits touched the target or its standards since this audit' },
  { key: 'auditor', width: 120, hide: 'lg', label: 'Auditor', tip: 'The agent that ran the audit' },
];

function AuditListHeader() {
  return (
    <ListHeader
      list="audits"
      id={{ label: 'ID', tip: 'Audit id' }}
      idWidth={96}
      main={{ label: 'Target', tip: 'The audited spec or standard, and the audit summary' }}
      cols={AUDIT_COLS}
      people={{ label: 'People', tip: 'Who ran the audit (person and agent)' }}
      time={{ label: 'Audited', tip: 'When the audit ran' }}
    />
  );
}

function AuditRow({ a }: { a: AuditSummary }) {
  const target = docTarget('audits', a.id);
  const tone = a.stale && a.outcome === 'pass' ? 'stale' : OUTCOME_META[a.outcome].tone;
  return (
    <ListRow
      to={`/audits/${a.id}`}
      list="audits"
      kind="audit"
      className="audit-row"
      copy={target}
      lead={<AuditDot tone={tone} label={OUTCOME_META[a.outcome].label} />}
      id={a.id}
      idWidth={96}
      title={a.targetTitle ?? a.target}
      excerpt={a.summary}
      cols={withNodes(AUDIT_COLS, {
        findings: a.findings.open > 0 && (
          <span className="row-indicator" data-tone={a.findings.openMust ? 'danger' : 'warn'}>
            {plural(a.findings.open, 'open finding')}
          </span>
        ),
        stale: a.stale && (
          <Tooltip label={`${plural(a.commitsSince, 'commit')} touched the target or its standards since this audit`}>
            <span className="row-indicator">stale · {plural(a.commitsSince, 'commit')}</span>
          </Tooltip>
        ),
        auditor: (
          <Tooltip label={`Audited by ${auditorLabel(a.auditor)}`}>
            <span className="row-indicator lr-ellipsis">{a.auditor.agent}</span>
          </Tooltip>
        ),
      })}
      people={<RowPeople refUri={bareRef(target.ref)} fallback={{ user: a.auditor.user, agent: a.auditor.agent, at: a.at, verb: 'Audited' }} />}
      time={<RowTime iso={a.at} label={`Audited ${absoluteTime(a.at)}`} />}
    />
  );
}

/** Every audit, newest first (`audit_list`). */
const OUTCOME_ORDER = ['in_progress', 'pass', 'warn', 'fail', 'abandoned'] as const;
const OUTCOME_COLOR: Record<(typeof OUTCOME_ORDER)[number], string> = {
  in_progress: 'var(--mantine-color-lilac-5, var(--mantine-primary-color-filled))',
  pass: 'var(--mantine-color-teal-6)',
  warn: 'var(--mantine-color-orange-6)',
  fail: 'var(--mantine-color-red-6)',
  abandoned: 'var(--app-text-faint)',
};

/** Thin stacked bar + clickable counts per audit outcome, plus stale audits (same look as the spec / work-order lists). */
function AuditSummaryBar({ audits, selected, onToggle }: { audits: AuditSummary[]; selected: string[]; onToggle: (v: string) => void }) {
  const counts = new Map<string, number>();
  for (const a of audits) counts.set(a.outcome, (counts.get(a.outcome) ?? 0) + 1);
  const stale = audits.filter((a) => a.stale).length;
  const total = audits.length || 1;
  return (
    <div className="status-summary">
      <div className="status-bar" aria-hidden="true">
        {OUTCOME_ORDER.map((o) => (counts.get(o) ? <span key={o} style={{ flexGrow: counts.get(o), background: OUTCOME_COLOR[o], minWidth: 4 }} /> : null))}
      </div>
      <div className="status-counts">
        {OUTCOME_ORDER.map((o) => (
          <button key={o} type="button" className="status-count" data-active={selected.includes(o) || undefined} data-empty={!counts.get(o) || undefined} onClick={() => onToggle(o)}>
            <AuditDot tone={OUTCOME_META[o].tone} size={8} />
            <span>{OUTCOME_META[o].label}</span>
            <span className="status-count-n">{counts.get(o) ?? 0}</span>
            <span className="status-count-pct">{Math.round(((counts.get(o) ?? 0) / total) * 100)}%</span>
          </button>
        ))}
        <Tooltip label="The audited code, criteria or rules changed after the audit: run it again">
          <button type="button" className="status-count status-count-attention" data-active={selected.includes('stale') || undefined} data-empty={!stale || undefined} onClick={() => onToggle('stale')}>
            <IconAlertTriangle size={13} />
            <span>Stale</span>
            <span className="status-count-n">{stale}</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function AuditListPage() {
  const q = useMcpTool<{ audits: AuditSummary[]; total: number }>('audit_list', { limit: 200 });
  const [search, setSearch] = useSearchQuery();
  const all = q.data?.audits ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const visible = all.filter(
    (a) => matches(search, a.id, a.targetTitle, a.target, a.summary, a.auditor.agent) && (!picked.length || picked.includes(a.outcome) || (picked.includes('stale') && a.stale)),
  );
  return (
    <>
      <TopBar crumbs={[{ label: 'Audits' }]}>
        {q.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {visible.length === all.length ? plural(all.length, 'audit') : `${visible.length} of ${all.length}`}
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <div style={{ flex: 1 }} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search audits…" />
      </div>
      {q.data && all.length > 0 && <AuditSummaryBar audits={all} selected={picked} onToggle={toggle} />}
      {q.isPending && <RowsSkeleton rows={5} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && all.length === 0 && (
        <EmptyView
          icon={<IconListCheck size={22} stroke={1.5} />}
          title="No audits yet"
          description="A coding agent audits a spec or standard against the code with the audit_* tools; each audit is kept as a report here."
        />
      )}
      {q.data && all.length > 0 && visible.length === 0 && <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matching audits" description="Nothing matches the search." />}
      {visible.length > 0 && <AuditListHeader />}
      {visible.map((a) => (
        <AuditRow key={a.id} a={a} />
      ))}
    </>
  );
}
