import { useMemo, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconChevronRight, IconMessageReport, IconSearch, IconX } from '@tabler/icons-react';
import type { Feedback, FeedbackKind, FeedbackStatus, Question } from '@mandate/shared';
import { Menu } from '@mantine/core';
import { IconArrowsSort, IconCheck, IconLayoutList } from '@tabler/icons-react';
import { absoluteTime } from '../lib/time';
import { parseRef } from '@mandate/shared/refs';
import { useSearchParams } from 'react-router';
import { IssuesBadge } from '../components/IssuesBadge';
import { FeedbackKindIcon, FeedbackOutcome, FeedbackStatusIcon, TargetChip, type OpenWorkOrderRef } from '../components/FeedbackParts';
import { FilterButton } from '../components/FilterButton';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { TopBar } from '../components/TopBar';
import { FEEDBACK_KIND_META, FEEDBACK_SORTS, FEEDBACK_STATUS_META, FEEDBACK_STATUS_ORDER, RESOLUTION_META, firstLine, sortFeedback, type FeedbackSort } from '../lib/feedback';
import { changedDocs, questionsByRequest, workOrdersByRequest } from '../lib/requestLinks';
import { useOpenQuestions } from '../lib/questions';
import { QuestionChip, WorkOrderChip } from '../components/FeedbackParts';
import { useFeedback, useSpecs, useStandards, useWorkOrders } from '../lib/queries';
import { ListHeader, ListRow, RowTime, withNodes, type ChipItem, type ColDef } from '../components/list/ListRow';
import { feedbackTarget } from '../lib/refs';
import { matches } from '../lib/useSearchQuery';
import { RowPeople } from '../components/people/People';
import { bareRef } from '../lib/lineage';

const KEYS = ['kind', 'status', 'resolution', 'target'] as const;

const FEEDBACK_CHIPS_W = 300;
const FEEDBACK_COLS: ColDef[] = [
  { key: 'issues', width: 72, hide: 'xl', label: 'Issues', tip: 'Validation issues in the stored request' },
  { key: 'outcome', width: 104, hide: 'sm', label: 'Outcome', tip: 'Outcome: how it was resolved, or the work order handling it' },
];

function FeedbackListHeader() {
  return (
    <ListHeader
      list="feedback"
      leadWidth={36}
      id={{ label: 'ID', tip: 'Request id' }}
      idWidth={84}
      main={{ label: 'Request', tip: 'First line of the request' }}
      chips={{ label: 'Targets', tip: 'The sections it is about, the spec changes it caused, the work orders acting on it and its open questions (hover "+N" for the rest)' }}
      chipsWidth={FEEDBACK_CHIPS_W}
      cols={FEEDBACK_COLS}
      people={{ label: 'People', tip: 'Who filed it (person and agent) and who worked on it' }}
      time={{ label: 'When', tip: 'Created, or closed for closed requests' }}
      timeWidth={96}
    />
  );
}

function FeedbackRow({ f, titles, workOrder, workOrders = [], questions = [] }: { f: Feedback; titles: Map<string, string>; workOrder?: OpenWorkOrderRef; workOrders?: { id: string; status: string; title?: string }[]; questions?: Question[] }) {
  const target = feedbackTarget(f);
  const legacy = f.targets.some((t) => !parseRef(t)?.sectionId);
  const chips: ChipItem[] = [
    ...(legacy ? [{ key: '~legacy', node: <span className="legacy-badge">legacy</span> }] : []),
    ...f.targets.map((t) => ({ key: t, node: <TargetChip target={t} titles={titles} plain />, short: <TargetChip target={t} titles={titles} plain short /> })),
    // Spec / standard changes this request caused, the work orders acting on it and its open questions.
    ...changedDocs(f.changes).map((c) => ({ key: `chg:${c.key}`, node: <span className="fb-target fb-change-chip" data-kind={c.kind} title={`Changed ${c.title}`}>~ {c.title}</span> })),
    ...workOrders.map((w) => ({ key: `wo:${w.id}`, node: <WorkOrderChip w={w} plain /> })),
    ...questions.filter((x) => x.status === 'open').map((x) => ({ key: `q:${x.id}`, node: <QuestionChip q={x} plain /> })),
  ];
  return (
    <ListRow
      to={`/requests/${f.id}`}
      list="feedback"
      copy={target}
      lead={
        <>
          <FeedbackStatusIcon status={f.status} resolution={f.resolution} />
          <FeedbackKindIcon kind={f.kind} />
        </>
      }
      leadWidth={36}
      id={f.id}
      idWidth={84}
      title={<span className="fb-title">{firstLine(f.body)}</span>}
      chips={chips}
      chipsMax={legacy ? 4 : 3}
      chipsWidth={FEEDBACK_CHIPS_W}
      cols={withNodes(FEEDBACK_COLS, {
        issues: f.validationIssues ? <IssuesBadge issues={f.validationIssues} /> : null,
        outcome: <FeedbackOutcome f={f} workOrder={workOrder} />,
      })}
      people={<RowPeople refUri={bareRef(target.ref)} first fallback={{ user: f.createdByUser, agent: f.createdBy, at: f.createdAt, verb: 'Filed' }} />}
      time={
        <RowTime
          iso={f.closedAt ?? f.createdAt}
          prefix={f.closedAt ? 'closed' : undefined}
          label={f.closedAt ? `Closed ${absoluteTime(f.closedAt)} · created ${absoluteTime(f.createdAt)}` : `Created ${absoluteTime(f.createdAt)}`}
        />
      }
      timeWidth={96}
    />
  );
}

export function FeedbackListPage() {
  const query = useFeedback();
  const workOrders = useWorkOrders();
  const openQuestions = useOpenQuestions();
  const specs = useSpecs();
  const standards = useStandards();
  const [params, setParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const q = params.get('q') ?? '';
  const sel = (k: string) => (params.get(k) ?? '').split(',').filter(Boolean);
  const set = (k: string, v: string | string[]) =>
    setParams(
      (p) => {
        const value = Array.isArray(v) ? v.join(',') : v;
        if (value) p.set(k, value);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );

  // One URL update for all keys: separate `set` calls each start from the same render's params and overwrite each other.
  const clearFilters = () => setParams((p) => (KEYS.forEach((k) => p.delete(k)), p), { replace: true });

  const titles = useMemo(
    () =>
      new Map([
        ...(specs.data ?? []).map((s) => [`specs:${s.id}`, s.title] as const),
        ...(standards.data ?? []).map((s) => [`standards:${s.id}`, s.title] as const),
      ]),
    [specs.data, standards.data],
  );
  // Feedback id -> the open work order acting on it (work order `reason` lists feedback ids).
  const openWorkOrders = useMemo(() => {
    const m = new Map<string, OpenWorkOrderRef>();
    for (const w of workOrders.data ?? []) {
      if (w.status !== 'pending' && w.status !== 'in_progress') continue;
      for (const id of w.reason ?? []) if (!m.has(id)) m.set(id, { id: w.id, status: w.status, title: w.title });
    }
    return m;
  }, [workOrders.data]);
  const woByRequest = useMemo(() => workOrdersByRequest(workOrders.data ?? []), [workOrders.data]);
  const qByRequest = useMemo(() => questionsByRequest(openQuestions.data?.items ?? []), [openQuestions.data]);
  const all = query.data ?? [];
  const f = { kind: sel('kind'), status: sel('status'), resolution: sel('resolution'), target: sel('target') };
  const sort = (FEEDBACK_SORTS.some((x) => x.value === params.get('sort')) ? params.get('sort') : 'created-desc') as FeedbackSort;
  const groupNone = params.get('group') === 'none';
  const visible = all.filter(
    (x) =>
      matches(q, x.id, x.body, x.quote, ...x.targets) &&
      (!f.kind.length || f.kind.includes(x.kind)) &&
      (!f.status.length || f.status.includes(x.status)) &&
      (!f.target.length || x.targets.some((t) => f.target.includes(parseRef(t)?.kind ?? ''))) &&
      (!f.resolution.length || (!!x.resolution && f.resolution.includes(x.resolution))),
  );
  const sorted = sortFeedback(visible, sort);
  const count = (pred: (x: Feedback) => boolean) => all.filter(pred).length;
  const active = KEYS.some((k) => f[k].length);

  return (
    <>
      <TopBar crumbs={[{ label: 'Requests' }]}>
        {query.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {count((x) => x.status === 'open')} open · {all.length} total
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <FilterButton
          label="Kind"
          selected={f.kind}
          onChange={(v) => set('kind', v)}
          options={(Object.keys(FEEDBACK_KIND_META) as FeedbackKind[]).map((k) => ({ value: k, label: FEEDBACK_KIND_META[k].label, icon: <FeedbackKindIcon kind={k} size={13} />, count: count((x) => x.kind === k) }))}
        />
        <FilterButton
          label="Status"
          selected={f.status}
          onChange={(v) => set('status', v)}
          options={FEEDBACK_STATUS_ORDER.map((s) => ({ value: s, label: FEEDBACK_STATUS_META[s].label, count: count((x) => x.status === s) }))}
        />
        <FilterButton
          label="Target"
          selected={f.target}
          onChange={(v) => set('target', v)}
          options={[
            { value: 'specs', label: 'Specs', count: count((x) => x.targets.some((t) => parseRef(t)?.kind === 'specs')) },
            { value: 'standards', label: 'Standards', count: count((x) => x.targets.some((t) => parseRef(t)?.kind === 'standards')) },
          ]}
        />
        <FilterButton
          label="Resolution"
          selected={f.resolution}
          onChange={(v) => set('resolution', v)}
          options={(['applied', 'rejected', 'duplicate'] as const).map((r) => ({
            value: r,
            label: RESOLUTION_META[r].label,
            icon: <FeedbackStatusIcon status="closed" resolution={r} size={13} />,
            count: count((x) => x.resolution === r),
          }))}
        />
        {active && (
          <Button variant="subtle" color="gray" leftSection={<IconX size={12} />} onClick={clearFilters}>
            Clear
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Menu position="bottom-end" width={180}>
          <Menu.Target>
            <Button variant="default" leftSection={<IconLayoutList size={14} />}>
              {groupNone ? 'No grouping' : 'Group: Status'}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => set('group', '')} rightSection={!groupNone ? <IconCheck size={14} /> : null}>
              Status
            </Menu.Item>
            <Menu.Item onClick={() => set('group', 'none')} rightSection={groupNone ? <IconCheck size={14} /> : null}>
              None (chronological)
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu position="bottom-end" width={190}>
          <Menu.Target>
            <Button variant="default" leftSection={<IconArrowsSort size={14} />}>
              {FEEDBACK_SORTS.find((x) => x.value === sort)!.label}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Sort by</Menu.Label>
            {FEEDBACK_SORTS.map((o) => (
              <Menu.Item key={o.value} onClick={() => set('sort', o.value === 'created-desc' ? '' : o.value)} rightSection={o.value === sort ? <IconCheck size={14} /> : null}>
                {o.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search requests…" />
      </div>

      {query.isPending && <RowsSkeleton rows={6} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && all.length === 0 && (
        <EmptyView icon={<IconMessageReport size={22} stroke={1.5} />} title="No requests yet" description="Tell your coding agent what you want: it records a request here and works on it. No approval needed." />
      )}
      {query.data && all.length > 0 && visible.length === 0 && (
        <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matching requests" description="Try another filter or search term." />
      )}
      {visible.length > 0 && <FeedbackListHeader />}
      {groupNone && sorted.map((x) => <FeedbackRow key={x.id} f={x} titles={titles} workOrder={openWorkOrders.get(x.id)} workOrders={woByRequest.get(x.id)} questions={qByRequest.get(x.id)} />)}
      {!groupNone && FEEDBACK_STATUS_ORDER.map((status: FeedbackStatus) => {
        const items = sorted.filter((x) => x.status === status);
        if (!items.length) return null;
        const isCollapsed = !!collapsed[status];
        return (
          <section key={status}>
            <button type="button" className="group-header" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [status]: !isCollapsed }))}>
              <IconChevronRight size={12} color="var(--app-text-faint)" style={{ transform: isCollapsed ? undefined : 'rotate(90deg)', transition: 'transform 120ms ease' }} />
              <FeedbackStatusIcon status={status} resolution={status === 'closed' ? 'applied' : undefined} />
              <span>{FEEDBACK_STATUS_META[status].label}</span>
              <Text component="span" size="sm" c="var(--app-text-faint)">
                {items.length}
              </Text>
            </button>
            {!isCollapsed && items.map((x) => <FeedbackRow key={x.id} f={x} titles={titles} workOrder={openWorkOrders.get(x.id)} workOrders={woByRequest.get(x.id)} questions={qByRequest.get(x.id)} />)}
          </section>
        );
      })}
    </>
  );
}
