import { useMemo } from 'react';
import { Text, Tooltip } from '@mantine/core';
import { IconFileText, IconRuler2, IconSearch, IconTarget } from '@tabler/icons-react';
import type { Standard } from '@mandate/shared';
import { Link } from 'react-router';
import { TagPill } from '../components/doc';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { TimeAgo } from '../components/TimeAgo';
import { VersionMeta } from '../components/VersionMeta';
import { CopyRef, copyTargetProps } from '../components/copy';
import { SortMenu, sortItems, type SortKey } from '../components/SortMenu';
import { docTarget } from '../lib/refs';
import { useSearchParams } from 'react-router';
import { TopBar } from '../components/TopBar';
import { useStandards } from '../lib/queries';
import { matches, useSearchQuery } from '../lib/useSearchQuery';

function StandardRow({ std }: { std: Standard }) {
  const target = docTarget('standards', std.id);
  return (
    <Link to={`/standards/${std.id}`} className="row spec-row has-copy-ref" {...copyTargetProps(target)}>
      <IconRuler2 size={15} stroke={1.6} color="var(--app-text-muted)" style={{ flexShrink: 0 }} />
      <span className="row-id spec-row-id">{std.id}</span>
      <span className="spec-row-text">
        <span className="row-title">{std.title}</span>
        {std.summary && <span className="row-excerpt">{std.summary}</span>}
      </span>
      <span className="row-meta">
        <span className="row-copy">
          <CopyRef target={target} size="xs" />
        </span>
        {std.appliesTo.length > 0 && (
          <Tooltip label={`Applies automatically to ${std.appliesTo.join(', ')}`}>
            <span className="row-indicator">
              <IconTarget size={13} />
              {std.appliesTo.length}
            </span>
          </Tooltip>
        )}
        <span className="row-tags">
          {std.tags.map((t) => (
            <TagPill key={t} tag={t} />
          ))}
        </span>
        {std.status && std.status !== 'active' && (
          <span className="lifecycle-badge" data-status={std.status}>
            {std.status === 'draft' ? 'Draft' : 'Deprecated'}
          </span>
        )}
        {std.ruleCounts && (
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
        )}
        <Tooltip label={`${std.sections.length} sections`}>
          <span className="row-indicator">
            <IconFileText size={13} />
            {std.sections.length}
          </span>
        </Tooltip>
        <span className="usedby-count" data-zero={!std.usedBy || undefined}>
          used by {std.usedBy ?? 0} spec{std.usedBy === 1 ? '' : 's'}
        </span>
        <VersionMeta path={`/standards/${std.id}`} count={std.versionCount} lastCommit={std.lastCommit} lastBy={std.updatedBy} />
        <span className="row-time">
          <TimeAgo iso={std.updatedAt} />
        </span>
      </span>
    </Link>
  );
}

export function StandardListPage() {
  const query = useStandards();
  const [q, setQ] = useSearchQuery();
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as SortKey | null) ?? 'title';
  const items = useMemo(
    () => sortItems((query.data ?? []).filter((s) => matches(q, s.title, s.id, s.summary, ...s.tags, ...s.appliesTo)), sort),
    [query.data, q, sort],
  );
  const total = query.data?.length ?? 0;
  return (
    <>
      <TopBar crumbs={[{ label: 'Standards' }]}>
        {query.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {q ? `${items.length} of ${total}` : `${total} standards`}
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <Text size="sm" c="var(--app-text-muted)" style={{ flex: 1, minWidth: 180 }}>
          Reusable rule sets and patterns that specs follow.
        </Text>
        <SortMenu
          value={sort}
          options={['title', 'updated', 'created', 'versions', 'usedBy']}
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
        <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matches" description={`Nothing matches "${q}".`} />
      )}
      {items.map((s) => (
        <StandardRow key={s.id} std={s} />
      ))}
    </>
  );
}
