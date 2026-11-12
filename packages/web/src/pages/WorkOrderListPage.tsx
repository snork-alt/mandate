import { useMemo, useState } from 'react';
import { SegmentedControl, Text } from '@mantine/core';
import { IconChevronRight, IconFileText, IconListCheck, IconSearch } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { WorkOrder, WorkOrderStatus, Spec } from '@mandate/shared';
import { Tooltip } from '@mantine/core';
import { IssuesBadge } from '../components/IssuesBadge';
import { ClaimAvatar, PriorityIcon } from '../components/doc';
import { categoryLabel, KIND_LABEL, useNow } from '../lib/specs';
import { useSpecs } from '../lib/queries';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { WORK_ORDER_STATUS_META, WORK_ORDER_STATUS_ORDER, WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { CopyRef, copyTargetProps } from '../components/copy';
import { workOrderTarget } from '../lib/refs';
import { useWorkOrders } from '../lib/queries';
import { matches, useSearchQuery } from '../lib/useSearchQuery';
import type { SectionDef } from '../sections';

type Filter = 'all' | 'active' | 'closed';
const FILTER_STATUSES: Record<Filter, WorkOrderStatus[]> = {
  all: WORK_ORDER_STATUS_ORDER,
  active: ['in_progress', 'pending'],
  closed: ['failed', 'done', 'cancelled'],
};


function SectionProgress({ item }: { item: WorkOrder }) {
  const done = item.sections.filter((s) => s.status === 'done').length;
  const total = item.sections.length;
  return (
    <Tooltip label={item.sections.map((s) => `${s.status === 'done' ? '✓' : '○'} ${s.id}`).join('\n')} multiline style={{ whiteSpace: 'pre' }}>
      <span className="q-progress">
        <span className="q-progress-text">
          {done}/{total} sections
        </span>
        <span className="q-progress-bar">
          <span style={{ width: `${(done / total) * 100}%` }} />
        </span>
      </span>
    </Tooltip>
  );
}

function WorkOrderRow({ item, spec, now }: { item: WorkOrder; spec?: Spec; now: number }) {
  const target = workOrderTarget(item);
  return (
    <Link to={`/work-orders/${item.id}`} className="row has-copy-ref" {...copyTargetProps(target)}>
      <WorkOrderStatusIcon status={item.status} />
      <span className="row-id" style={{ width: 64 }}>
        {item.id}
      </span>
      <span className="kind-badge" data-kind={item.kind}>
        {KIND_LABEL[item.kind]}
      </span>
      <span className="spec-row-text">
        <span className="row-title">{spec?.title ?? item.spec}</span>
        {spec?.category && <span className="row-excerpt">{categoryLabel(spec.category)}</span>}
      </span>
      <span className="row-meta">
        <span className="row-copy">
          <CopyRef target={target} size="xs" />
        </span>
        {item.sections.some((x) => spec?.blockedSections?.includes(x.id)) && (
          <Tooltip label={`Blocked: ${item.sections.filter((x) => spec?.blockedSections?.includes(x.id)).map((x) => x.id).join(', ')}`}>
            <span className="row-indicator" data-tone="warn">
              Blocked
            </span>
          </Tooltip>
        )}
        {(item as { validationIssues?: string[] }).validationIssues && <IssuesBadge issues={(item as { validationIssues?: string[] }).validationIssues!} />}
        <SectionProgress item={item} />
        <PriorityIcon priority={item.priority} withTooltip />
        <span className="row-claim">{item.claim && <ClaimAvatar claim={item.claim} now={now} />}</span>
        <span className="row-time">
          <TimeAgo iso={item.updatedAt} />
        </span>
      </span>
    </Link>
  );
}

/** Work orders grouped by status (Linear-style), with collapsible group headers. Rows keep file order. */
export function WorkOrderListPage({ section }: { section: SectionDef }) {
  const { label, description } = section;
  const query = useWorkOrders();
  const specs = useSpecs();
  const now = useNow();
  const specById = useMemo(() => new Map((specs.data ?? []).map((s) => [s.id, s])), [specs.data]);
  const [q, setQ] = useSearchQuery();
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Partial<Record<WorkOrderStatus, boolean>>>({});

  const all = query.data ?? [];
  const groups = useMemo(() => {
    const visible = all.filter((i) => matches(q, i.id, i.spec, i.kind, i.note, specById.get(i.spec)?.title, ...i.sections.map((s) => s.id)));
    return FILTER_STATUSES[filter]
      .map((status) => ({ status, items: visible.filter((i) => i.status === status) }))
      .filter((g) => g.items.length > 0);
  }, [all, q, filter, specById]);
  const counts = useMemo(() => {
    const c = { all: all.length, active: 0, closed: 0 };
    for (const i of all) c[FILTER_STATUSES.active.includes(i.status) ? 'active' : 'closed']++;
    return c;
  }, [all]);

  return (
    <>
      <TopBar crumbs={[{ label }]}>
        {query.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {counts.active} active · {counts.closed} closed
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'active', label: `Active ${counts.active}` },
            { value: 'closed', label: `Closed ${counts.closed}` },
          ]}
        />
        <Text size="sm" c="var(--app-text-muted)" style={{ flex: 1, minWidth: 160 }} visibleFrom="md">
          {description}
        </Text>
        <SearchInput value={q} onChange={setQ} placeholder="Filter work orders…" />
      </div>

      {query.isPending && <RowsSkeleton />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && all.length === 0 && (
        <EmptyView
          icon={<IconListCheck size={22} stroke={1.5} />}
          title="No work orders yet"
          description="Work orders on spec sections show up here once they are added to work-orders.jsonl."
        />
      )}
      {query.data && all.length > 0 && groups.length === 0 && (
        <EmptyView
          icon={<IconSearch size={22} stroke={1.5} />}
          title="No matching items"
          description="Try another filter or search term."
        />
      )}

      {groups.map(({ status, items }) => {
        const isCollapsed = !!collapsed[status];
        return (
          <section key={status}>
            <button
              type="button"
              className="group-header"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => ({ ...c, [status]: !isCollapsed }))}
            >
              <IconChevronRight
                size={12}
                color="var(--app-text-faint)"
                style={{ transform: isCollapsed ? undefined : 'rotate(90deg)', transition: 'transform 120ms ease' }}
              />
              <WorkOrderStatusIcon status={status} />
              <span>{WORK_ORDER_STATUS_META[status].label}</span>
              <Text component="span" size="sm" c="var(--app-text-faint)">
                {items.length}
              </Text>
            </button>
            {!isCollapsed && items.map((item) => <WorkOrderRow key={item.id} item={item} spec={specById.get(item.spec)} now={now} />)}
          </section>
        );
      })}
    </>
  );
}
