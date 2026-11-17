import { useMemo } from 'react';
import { Text, Tooltip } from '@mantine/core';
import { IconRuler2, IconSearch, IconTarget } from '@tabler/icons-react';
import type { Standard } from '@mandate/shared';
import { TagPill } from '../components/doc';
import { KindIcon } from '../components/refs';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { ListHeader, ListRow, RowTime, withNodes, type ColDef } from '../components/list/ListRow';
import { absoluteTime } from '../lib/time';
import { VersionMeta } from '../components/VersionMeta';
import { SortMenu, sortItems, type SortKey } from '../components/SortMenu';
import { docTarget } from '../lib/refs';
import { useSearchParams } from 'react-router';
import { TopBar } from '../components/TopBar';
import { useStandards } from '../lib/queries';
import { matches, useSearchQuery } from '../lib/useSearchQuery';
import { FilterButton } from '../components/FilterButton';
import { AuditIndicator } from '../components/audits/panels';
import { AuditDot } from '../components/audits/parts';
import { matchesAuditFilter } from '../lib/audits';
import { RowPeople } from '../components/people/People';
import { bareRef } from '../lib/lineage';

const STD_COLS: ColDef[] = [
  { key: 'applies', width: 40, hide: '2xl', label: 'Auto', tip: 'Applies automatically to specs with these tags or paths' },
  { key: 'lifecycle', width: 84, hide: 'lg', label: 'Lifecycle', tip: 'Proposed or deprecated (empty: active)' },
  { key: 'rules', width: 176, hide: 'xl', label: 'Rules', tip: 'Rules by level: MUST, SHOULD, MAY' },
  { key: 'sections', width: 40, hide: '2xl', label: 'Sect.', tip: 'Number of sections' },
  { key: 'audit', width: 44, hide: 'sm', label: 'Audit', tip: 'Audit: last audit and whether it has open findings (red: open findings)' },
  { key: 'usedby', width: 100, hide: 'lg', label: 'Used by', tip: 'Specs that follow this standard' },
  { key: 'version', width: 52, hide: '2xl', label: 'Version', tip: 'Version: number of committed versions and the last commit' },
];

function StandardListHeader() {
  return (
    <ListHeader
      list="standards"
      id={{ label: 'ID', tip: 'Standard id' }}
      idWidth={150}
      main={{ label: 'Standard', tip: 'Title and summary' }}
      chips={{ label: 'Tags', tip: 'Tags (hover "+N" for the rest)' }}
      chipsWidth={180}
      cols={STD_COLS}
    />
  );
}

function StandardRow({ std }: { std: Standard }) {
  const target = docTarget('standards', std.id);
  return (
    <ListRow
      to={`/standards/${std.id}`}
      list="standards"
      className="spec-row"
      copy={target}
      lead={<KindIcon kind="standard" size={15} />}
      id={std.id}
      idWidth={150}
      title={std.title}
      excerpt={std.summary}
      chips={std.tags.map((t) => ({ key: t, node: <TagPill tag={t} /> }))}
      chipsWidth={180}
      cols={withNodes(STD_COLS, {
        applies: std.appliesTo.length > 0 && (
          <Tooltip label={`Applies automatically to ${std.appliesTo.join(', ')}`}>
            <span className="row-indicator">
              <IconTarget size={13} />
              {std.appliesTo.length}
            </span>
          </Tooltip>
        ),
        lifecycle: std.status && std.status !== 'active' && (
          <span className="lifecycle-badge" data-status={std.status}>
            {std.status === 'draft' ? 'Proposed' : 'Deprecated'}
          </span>
        ),
        rules: std.ruleCounts && (
          <Tooltip label={`Rules: ${std.ruleCounts.must} must, ${std.ruleCounts.should} should, ${std.ruleCounts.may} may`}>
            <span className="rule-counts">
              {(['must', 'should', 'may'] as const).map((l) =>
                std.ruleCounts![l] ? (
                  <span key={l} className="level-badge" data-level={l}>
                    {std.ruleCounts![l]} {l.toUpperCase()}
                  </span>
                ) : null,
              )}
            </span>
          </Tooltip>
        ),
        sections: (
          <Tooltip label={`${std.sections.length} sections`}>
            <span className="row-indicator">
              <KindIcon kind="section" size={13} />
              {std.sections.length}
            </span>
          </Tooltip>
        ),
        audit: std.lastAudit !== undefined && <AuditIndicator last={std.lastAudit} />,
        usedby: (
          <span className="usedby-count" data-zero={!std.usedBy || undefined}>
            used by {std.usedBy ?? 0} spec{std.usedBy === 1 ? '' : 's'}
          </span>
        ),
        version: <VersionMeta path={`/standards/${std.id}`} count={std.versionCount} lastCommit={std.lastCommit} lastBy={std.updatedBy} />,
      })}
      people={<RowPeople refUri={bareRef(target.ref)} fallback={{ user: std.lastEditedBy?.user ?? std.createdBy?.user, agent: std.lastEditedBy?.agent ?? std.createdBy?.agent ?? std.updatedBy ?? undefined, at: std.updatedAt, verb: std.lastEditedBy ? 'Edited' : 'Created' }} />}
      time={<RowTime iso={std.updatedAt} label={`Updated ${absoluteTime(std.updatedAt)}`} />}
    />
  );
}

export function StandardListPage() {
  const query = useStandards();
  const [q, setQ] = useSearchQuery();
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as SortKey | null) ?? 'title';
  const audit = (params.get('audit') ?? '').split(',').filter(Boolean);
  const items = useMemo(
    () => sortItems((query.data ?? []).filter((s) => matches(q, s.title, s.id, s.summary, ...s.tags, ...s.appliesTo) && matchesAuditFilter(s, audit)), sort),
    [query.data, q, sort, audit.join()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const all = query.data ?? [];
  const auditOptions = [
    { value: 'never', label: 'Never audited', icon: <AuditDot tone="none" />, count: all.filter((s) => matchesAuditFilter(s, ['never'])).length },
    { value: 'stale', label: 'Stale', icon: <AuditDot tone="stale" />, count: all.filter((s) => matchesAuditFilter(s, ['stale'])).length },
    { value: 'open', label: 'Has open findings', icon: <AuditDot tone="fail" />, count: all.filter((s) => matchesAuditFilter(s, ['open'])).length },
  ];
  const total = query.data?.length ?? 0;
  return (
    <>
      <TopBar crumbs={[{ label: 'Standards' }]}>
        {query.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {items.length !== total ? `${items.length} of ${total}` : `${total} standards`}
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <Text size="sm" c="var(--app-text-muted)" style={{ flex: 1, minWidth: 180 }}>
          Reusable rule sets and patterns that specs follow.
        </Text>
        <FilterButton
          label="Audit"
          options={auditOptions}
          selected={audit}
          onChange={(v) => setParams((p) => (v.length ? p.set('audit', v.join(',')) : p.delete('audit'), p), { replace: true })}
        />
        <SortMenu
          value={sort}
          options={['title', 'updated', 'created', 'versions', 'usedBy', 'audited']}
          onChange={(v) => setParams((p) => (v === 'title' ? p.delete('sort') : p.set('sort', v), p), { replace: true })}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Filter standards…" />
      </div>
      {query.isPending && <RowsSkeleton rows={4} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && total === 0 && (
        <EmptyView
          icon={<IconRuler2 size={22} stroke={1.5} />}
          title="No standards yet"
          description="Standards appear here once an agent commits them to the repository (standards/<id>.md)."
        />
      )}
      {query.data && total > 0 && items.length === 0 && (
        <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matches" description={q ? `Nothing matches "${q}".` : 'Nothing matches the audit filter.'} />
      )}
      {items.length > 0 && <StandardListHeader />}
      {items.map((s) => (
        <StandardRow key={s.id} std={s} />
      ))}
    </>
  );
}
