import { useSearchParams } from 'react-router';
import { useMemo, useState } from 'react';
import { SegmentedControl, Text } from '@mantine/core';
import { IconAlertTriangle, IconChevronRight, IconFileText, IconListCheck, IconSearch } from '@tabler/icons-react';
import type { WorkOrder, WorkOrderStatus, Spec } from '@mandate/shared';
import { Tooltip } from '@mantine/core';
import { IssuesBadge } from '../components/IssuesBadge';
import { ClaimAvatar, PriorityIcon } from '../components/doc';
import { categoryLabel, isStale, KIND_LABEL, useNow } from '../lib/specs';
import { WorkOrderGitSummary } from '../components/work-orders/parts';
import { useSpecs } from '../lib/queries';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { WORK_ORDER_STATUS_META, WORK_ORDER_STATUS_ORDER, WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { ListHeader, ListRow, RowTime, withNodes, type ColDef } from '../components/list/ListRow';
import { absoluteTime } from '../lib/time';
import { TopBar } from '../components/TopBar';
import { workOrderTarget } from '../lib/refs';
import { useWorkOrders } from '../lib/queries';
import { matches, useSearchQuery } from '../lib/useSearchQuery';
import type { SectionDef } from '../sections';
import { RowPeople } from '../components/people/People';
import { bareRef } from '../lib/lineage';

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

const WO_COLS: ColDef[] = [
  { key: 'flags', width: 72, hide: 'xl', label: 'Flags', tip: 'Blocked sections and validation issues' },
  { key: 'git', width: 120, hide: 'lg', label: 'Git', tip: 'Branch, commits and pull request' },
  { key: 'progress', width: 104, hide: 'md', label: 'Sections', tip: 'Sections done out of the sections in this work order' },
  { key: 'priority', width: 18, align: 'center', hide: 'xs', label: 'P', tip: 'Priority' },
  { key: 'claim', width: 40, align: 'center', hide: 'sm', label: 'Agent', tip: 'Agent: the agent that claimed it (ring: heartbeat freshness)' },
];

function WorkOrderListHeader() {
  return (
    <ListHeader
      list="work-orders"
      leadWidth={90}
      id={{ label: 'ID', tip: 'Work order id' }}
      idWidth={64}
      main={{ label: 'Work order', tip: 'Title and the spec it implements' }}
      cols={WO_COLS}
      people={{ label: 'People', tip: 'Who created it and who worked on it (people and agents)' }}
    />
  );
}

function WorkOrderRow({ item, spec, now }: { item: WorkOrder; spec?: Spec; now: number }) {
  const target = workOrderTarget(item);
  const blocked = item.sections.filter((x) => spec?.blockedSections?.includes(x.id));
  const issues = (item as { validationIssues?: string[] }).validationIssues;
  return (
    <ListRow
      to={`/work-orders/${item.id}`}
      list="work-orders"
      kind="work_order"
      copy={target}
      lead={
        <>
          <WorkOrderStatusIcon status={item.status} />
          <span className="kind-badge" data-kind={item.kind}>
            {KIND_LABEL[item.kind]}
          </span>
        </>
      }
      leadWidth={90}
      id={item.id}
      idWidth={64}
      title={item.title ?? spec?.title ?? item.spec}
      excerpt={item.title ? (spec?.title ?? item.spec) : spec?.category && categoryLabel(spec.category)}
      cols={withNodes(WO_COLS, {
        flags: (
          <>
            {blocked.length > 0 && (
              <Tooltip label={`Blocked: ${blocked.map((x) => x.id).join(', ')}`}>
                <span className="row-indicator" data-tone="warn">
                  Blocked
                </span>
              </Tooltip>
            )}
            {issues && <IssuesBadge issues={issues} />}
          </>
        ),
        git: <WorkOrderGitSummary item={item} compact />,
        progress: <SectionProgress item={item} />,
        priority: <PriorityIcon priority={item.priority} withTooltip />,
        claim: item.claim && <ClaimAvatar claim={item.claim} now={now} workOrder={item.id} />,
      })}
      people={<RowPeople refUri={bareRef(target.ref)} fallback={{ agent: item.createdBy ?? item.claim?.agent, at: item.createdAt, verb: 'Created' }} />}
      time={<RowTime iso={item.updatedAt} label={`Updated ${absoluteTime(item.updatedAt)}`} />}
    />
  );
}

const LIFECYCLE: WorkOrderStatus[] = ['pending', 'in_progress', 'done', 'failed', 'cancelled'];

/** True when the work order needs a human look: failed, or claimed with a stale heartbeat. */
const needsAttention = (i: WorkOrder, now: number) => i.status === 'failed' || (i.status === 'in_progress' && !!i.claim && isStale(i.claim, now));

/** Thin stacked bar + clickable counts per work-order status (same look as the spec list summary). */
function WorkOrderSummary({ items, now, selected, onToggle }: { items: WorkOrder[]; now: number; selected: string[]; onToggle: (v: string) => void }) {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  const attention = items.filter((i) => needsAttention(i, now)).length;
  const total = items.length || 1;
  return (
    <div className="status-summary">
      <div className="status-bar" aria-hidden="true">
        {LIFECYCLE.map((st) => (counts.get(st) ? <span key={st} style={{ flexGrow: counts.get(st), background: WORK_ORDER_STATUS_META[st].color, minWidth: 4 }} /> : null))}
      </div>
      <div className="status-counts">
        {LIFECYCLE.map((st) => (
          <button key={st} type="button" className="status-count" data-active={selected.includes(st) || undefined} data-empty={!counts.get(st) || undefined} onClick={() => onToggle(st)}>
            <WorkOrderStatusIcon status={st} size={13} />
            <span>{WORK_ORDER_STATUS_META[st].label}</span>
            <span className="status-count-n">{counts.get(st) ?? 0}</span>
            <span className="status-count-pct">{Math.round(((counts.get(st) ?? 0) / total) * 100)}%</span>
          </button>
        ))}
        <Tooltip label="Failed, or in progress with a stale claim (no heartbeat recently)">
          <button type="button" className="status-count status-count-attention" data-active={selected.includes('attention') || undefined} data-empty={!attention || undefined} onClick={() => onToggle('attention')}>
            <IconAlertTriangle size={13} />
            <span>Needs attention</span>
            <span className="status-count-n">{attention}</span>
          </button>
        </Tooltip>
      </div>
    </div>
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
  // `?show=attention|failed|pending` (links from the Overview) preselects the summary filter.
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<string[]>(() => (params.get('show') ?? '').split(',').filter(Boolean));
  const togglePicked = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  const all = query.data ?? [];
  const groups = useMemo(() => {
    const visible = all.filter(
      (i) =>
        matches(q, i.id, i.spec, i.kind, i.note, specById.get(i.spec)?.title, ...i.sections.map((s) => s.id)) &&
        (!picked.length || picked.includes(i.status) || (picked.includes('attention') && needsAttention(i, now))),
    );
    return FILTER_STATUSES[filter]
      .map((status) => ({ status, items: visible.filter((i) => i.status === status) }))
      .filter((g) => g.items.length > 0);
  }, [all, q, filter, specById, picked, now]);
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
            // Counts only once the list has loaded (no "All 0 · Active 0" while loading).
            { value: 'all', label: query.data ? `All ${counts.all}` : 'All' },
            { value: 'active', label: query.data ? `Active ${counts.active}` : 'Active' },
            { value: 'closed', label: query.data ? `Closed ${counts.closed}` : 'Closed' },
          ]}
        />
        <Text size="sm" c="var(--app-text-muted)" style={{ flex: 1, minWidth: 160 }} visibleFrom="md">
          {description}
        </Text>
        <SearchInput value={q} onChange={setQ} placeholder="Filter work orders…" />
      </div>

      {query.data && all.length > 0 && <WorkOrderSummary items={all} now={now} selected={picked} onToggle={togglePicked} />}

      {query.isPending && <RowsSkeleton />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && all.length === 0 && (
        <EmptyView
          icon={<IconListCheck size={22} stroke={1.5} />}
          title="No work orders yet"
          description="Work orders appear here once an agent creates one (work_order_create); each is a document in work-orders/<id>.md."
        />
      )}
      {query.data && all.length > 0 && groups.length === 0 && (
        <EmptyView
          icon={<IconSearch size={22} stroke={1.5} />}
          title="No matching items"
          description="Try another filter or search term."
        />
      )}

      {groups.length > 0 && <WorkOrderListHeader />}
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
