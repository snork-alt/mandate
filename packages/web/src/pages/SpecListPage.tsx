import { useMemo, useState } from 'react';
import { Button, Menu, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconChevronRight, IconFileText, IconFolder, IconLayoutList, IconSearch, IconX } from '@tabler/icons-react';
import type { Priority, Spec } from '@mandate/shared';
import { PriorityIcon, StatusIcon } from '../components/doc';
import { FilterButton } from '../components/FilterButton';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { SpecListHeader, SpecRow } from '../components/SpecRow';
import { TopBar } from '../components/TopBar';
import { SortMenu, sortItems } from '../components/SortMenu';
import { useSpecs } from '../lib/queries';
import { categoryLabel, isReopened, PRIORITY_META, PRIORITY_ORDER, priorityRank, SPEC_STATUS_META, SPEC_STATUS_ORDER, useNow } from '../lib/specs';
import { matches } from '../lib/useSearchQuery';
import { GROUP_BY, useSpecFilters, type GroupBy } from '../lib/useSpecFilters';
import { matchesAuditFilter } from '../lib/audits';
import { AuditDot } from '../components/audits/parts';
import { MaturityMeter } from '../components/maturity/MaturityBadge';
import { matchesMaturityFilter, maturityOptions } from '../lib/maturity';
import { MATURITY_LABELS, MATURITY_STEPS, STEP_TONE } from '@mandate/shared';

const STEP_INDEX: Record<string, number> = Object.fromEntries(MATURITY_STEPS.map((s, i) => [s, i + 1]));

const GROUP_LABEL: Record<GroupBy, string> = { category: 'Category', maturity: 'Maturity', priority: 'Priority', none: 'No grouping' };
const NO_CATEGORY = '__none__';

interface Group {
  key: string;
  label: string;
  icon?: React.ReactNode;
  specs: Spec[];
}

function countBy<T extends string>(specs: Spec[], key: (s: Spec) => T | T[] | undefined): Map<T, number> {
  const m = new Map<T, number>();
  for (const s of specs) {
    const v = key(s);
    for (const k of Array.isArray(v) ? v : v ? [v] : []) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const STEP_COLOR: Record<string, string> = {
  draft: 'var(--app-text-faint)',
  specified: 'var(--app-text-muted)',
  in_progress: 'var(--mantine-color-lilac-5, var(--mantine-primary-color-filled))',
  implemented: 'var(--mantine-color-blue-5)',
};

/**
 * Thin stacked bar + clickable counts per MATURITY step: the same ladder the rows show, so the summary and the
 * badges always agree. "Needs attention" counts specs with an overlay (failing, outdated, blocked).
 */
function MaturitySummary({ specs, selected, onToggle }: { specs: Spec[]; selected: string[]; onToggle: (v: string) => void }) {
  const live = specs.filter((s) => !s.maturity?.overlays.some((o) => o.kind === 'archived'));
  const counts = countBy(live, (s) => s.maturity?.step);
  const attention = live.filter((s) => s.maturity?.overlays.some((o) => o.kind !== 'archived')).length;
  const total = live.length || 1;
  return (
    <div className="status-summary">
      <div className="status-bar" aria-hidden="true">
        {MATURITY_STEPS.map((st) => (counts.get(st) ? <span key={st} style={{ flexGrow: counts.get(st), background: STEP_COLOR[st], minWidth: 4 }} /> : null))}
      </div>
      <div className="status-counts">
        {MATURITY_STEPS.map((st) => (
          <button
            key={st}
            type="button"
            className="status-count"
            data-active={selected.includes(st) || undefined}
            data-empty={!counts.get(st) || undefined}
            onClick={() => onToggle(st)}
          >
            <MaturityMeter stepIndex={STEP_INDEX[st]!} tone={STEP_TONE[st]} />
            <span>{MATURITY_LABELS[st]}</span>
            <span className="status-count-n">{counts.get(st) ?? 0}</span>
            <span className="status-count-pct">{Math.round(((counts.get(st) ?? 0) / total) * 100)}%</span>
          </button>
        ))}
        <button
          type="button"
          className="status-count status-count-attention"
          data-active={['failing', 'outdated', 'blocked'].every((k) => selected.includes(k)) || undefined}
          data-empty={!attention || undefined}
          onClick={() => onToggle('attention')}
        >
          <IconAlertTriangle size={13} />
          <span>Needs attention</span>
          <span className="status-count-n">{attention}</span>
        </button>
      </div>
    </div>
  );
}

export function SpecListPage() {
  const query = useSpecs();
  const now = useNow();
  const { filters, update, activeCount, clear } = useSpecFilters();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const all = query.data ?? [];
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const wide = useMemo(() => all.some((s) => !!s.maturity), [all]);

  const options = useMemo(() => {
    const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const status = countBy(all, (s) => s.status);
    const priority = countBy(all, (s) => s.priority ?? 'none');
    return {
      status: SPEC_STATUS_ORDER.map((s) => ({ value: s, label: SPEC_STATUS_META[s].label, icon: <StatusIcon status={s} size={13} />, count: status.get(s) ?? 0 })),
      priority: PRIORITY_ORDER.map((p) => ({
        value: p,
        label: p === 'none' ? 'No priority' : PRIORITY_META[p].label,
        icon: <PriorityIcon priority={p === 'none' ? undefined : p} size={13} />,
        count: priority.get(p) ?? 0,
      })),
      repo: sorted(countBy(all, (s) => s.repo)).map(([v, n]) => ({ value: v, label: v, count: n })),
      tag: sorted(countBy(all, (s) => s.tags)).map(([v, n]) => ({ value: v, label: v, count: n })),
      category: sorted(countBy(all, (s) => s.category ?? NO_CATEGORY)).map(([v, n]) => ({
        value: v,
        label: v === NO_CATEGORY ? 'General' : categoryLabel(v),
        count: n,
      })),
      // One state filter (X1/L5): maturity stages, then flags (overlays), in two groups.
      maturity: maturityOptions(all).map((o) => ({
        value: o.value,
        label: o.label,
        count: o.count,
        group: o.value in STEP_INDEX ? 'Stage' : 'Flags',
        icon: <MaturityMeter stepIndex={o.value in STEP_INDEX ? STEP_INDEX[o.value]! : 4} tone={o.tone} />,
      })),
      audit: [
        { value: 'passed', label: 'Audit passed', icon: <AuditDot tone="pass" />, count: all.filter((s) => matchesAuditFilter(s, ['passed'])).length },
        { value: 'findings', label: 'Audit has findings', icon: <AuditDot tone="fail" />, count: all.filter((s) => matchesAuditFilter(s, ['findings'])).length },
        { value: 'outdated', label: 'Audit outdated', icon: <AuditDot tone="stale" />, count: all.filter((s) => matchesAuditFilter(s, ['outdated'])).length },
        { value: 'never', label: 'Never audited', icon: <AuditDot tone="none" />, count: all.filter((s) => matchesAuditFilter(s, ['never'])).length },
      ],
    };
  }, [all]);

  // Search + every filter except status (the summary bar shows counts over this set).
  const base = useMemo(
    () =>
      all.filter(
        (s) =>
          matches(filters.q, s.title, s.id, s.summary, s.category, s.owner, ...s.tags) &&
          (!filters.priority.length || filters.priority.includes(s.priority ?? 'none')) &&
          (!filters.repo.length || (s.repo && filters.repo.includes(s.repo))) &&
          (!filters.tag.length || s.tags.some((t) => filters.tag.includes(t))) &&
          (!filters.category.length || filters.category.includes(s.category ?? NO_CATEGORY)) &&
          matchesAuditFilter(s, filters.audit) &&
          matchesMaturityFilter(s, filters.maturity),
      ),
    [all, filters.q, filters.priority.join(), filters.repo.join(), filters.tag.join(), filters.category.join(), filters.audit.join(), filters.maturity.join()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const visible = useMemo(() => {
    const list = base.filter((s) => !filters.status.length || filters.status.includes(s.status));
    if (filters.sort !== 'priority') return sortItems(list, filters.sort);
    // Default: active work first, then urgency, then recency.
    return list.sort(
      (a, b) =>
        SPEC_STATUS_ORDER.indexOf(a.status) - SPEC_STATUS_ORDER.indexOf(b.status) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [base, filters.status.join(), filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo<Group[]>(() => {
    const by = (key: (s: Spec) => string) => {
      const m = new Map<string, Spec[]>();
      for (const s of visible) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
      return m;
    };
    switch (filters.group) {
      case 'none':
        return [{ key: 'all', label: 'All specs', specs: visible }];
      case 'maturity': {
        // Stages in ladder order; archived specs last in their own group.
        const keyOf = (s: Spec) => (s.maturity?.overlays.some((o) => o.kind === 'archived') ? 'archived' : (s.maturity?.step ?? 'unknown'));
        const m = by(keyOf);
        return [...MATURITY_STEPS, 'archived', 'unknown']
          .filter((k) => m.has(k))
          .map((k) => ({
            key: k,
            label: k === 'archived' ? 'Archived' : k === 'unknown' ? 'No maturity data' : MATURITY_LABELS[k as keyof typeof MATURITY_LABELS],
            icon: k in STEP_INDEX ? <MaturityMeter stepIndex={STEP_INDEX[k]!} tone={STEP_TONE[k as keyof typeof STEP_TONE]} /> : undefined,
            specs: m.get(k)!,
          }));
      }
      case 'priority': {
        const m = by((s) => s.priority ?? 'none');
        return PRIORITY_ORDER.filter((p) => m.has(p)).map((p) => ({
          key: p,
          label: p === 'none' ? 'No priority' : PRIORITY_META[p as Priority].label,
          icon: <PriorityIcon priority={p === 'none' ? undefined : (p as Priority)} />,
          specs: m.get(p)!,
        }));
      }
      default: {
        const m = by((s) => s.category ?? NO_CATEGORY);
        return [...m.keys()]
          .sort((a, b) => (a === NO_CATEGORY ? 1 : b === NO_CATEGORY ? -1 : a.localeCompare(b)))
          .map((c) => ({
            key: c,
            label: c === NO_CATEGORY ? 'General' : categoryLabel(c),
            icon: <IconFolder size={14} stroke={1.7} color="var(--app-text-muted)" />,
            specs: m.get(c)!,
          }));
      }
    }
  }, [visible, filters.group]);

  const reopened = all.filter((s) => isReopened(s)).length;

  return (
    <>
      <TopBar crumbs={[{ label: 'Specs' }]}>
        {query.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {visible.length === all.length ? `${all.length} specs` : `${visible.length} of ${all.length}`}
            {reopened > 0 && ` · ${reopened} reopened`}
          </Text>
        )}
      </TopBar>

      <div className="toolbar">
        <FilterButton label="Maturity" options={options.maturity} selected={filters.maturity} onChange={(v) => update({ maturity: v })} maxHeight={480} width={240} />
        <FilterButton label="Priority" options={options.priority} selected={filters.priority} onChange={(v) => update({ priority: v })} />
        <FilterButton label="Repo" options={options.repo} selected={filters.repo} onChange={(v) => update({ repo: v })} />
        <FilterButton label="Tag" options={options.tag} selected={filters.tag} onChange={(v) => update({ tag: v })} />
        <FilterButton label="Audit" options={options.audit} selected={filters.audit} onChange={(v) => update({ audit: v })} />
        {/* Legacy links (`?status=`): the author-set status stays filterable, as an advanced filter, only while in use. */}
        {filters.status.length > 0 && (
          <FilterButton label="Set by author" options={options.status} selected={filters.status} onChange={(v) => update({ status: v })} />
        )}
        {filters.category.length > 0 && (
          <FilterButton label="Category" options={options.category} selected={filters.category} onChange={(v) => update({ category: v })} />
        )}
        {activeCount > 0 && (
          <Tooltip label="Clear all filters">
            <Button variant="subtle" color="gray" leftSection={<IconX size={12} />} onClick={() => clear()}>
              Clear
            </Button>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        <Menu position="bottom-end" width={190}>
          <Menu.Target>
            <Button variant="default" leftSection={<IconLayoutList size={14} />}>
              {filters.group === 'none' ? 'No grouping' : `Group: ${GROUP_LABEL[filters.group]}`}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Group by</Menu.Label>
            {GROUP_BY.map((g) => (
              <Menu.Item key={g} onClick={() => update({ group: g })} rightSection={filters.group === g ? <IconCheck size={14} /> : null}>
                {GROUP_LABEL[g]}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        <SortMenu value={filters.sort} options={['priority', 'updated', 'created', 'versions', 'title', 'audited', 'maturity']} onChange={(v) => update({ sort: v })} />
        <SearchInput value={filters.q} onChange={(q) => update({ q })} placeholder="Search specs…" />
      </div>

      {query.data && all.length > 0 && (
        <MaturitySummary
          specs={base}
          selected={filters.maturity}
          onToggle={(v) => {
            const group = v === 'attention' ? ['failing', 'outdated', 'blocked'] : [v];
            const on = group.every((k) => filters.maturity.includes(k));
            update({ maturity: on ? filters.maturity.filter((k) => !group.includes(k)) : [...new Set([...filters.maturity, ...group])] });
          }}
        />
      )}

      {query.isPending && <RowsSkeleton rows={7} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && all.length === 0 && (
        <EmptyView
          icon={<IconFileText size={22} stroke={1.5} />}
          title="No specs yet"
          description="Specs appear here once an agent commits them to the repository (specs/<id>.md). Run `npm run seed` for sample data."
        />
      )}
      {query.data && all.length > 0 && visible.length === 0 && (
        <EmptyView
          icon={<IconSearch size={22} stroke={1.5} />}
          title="No matching specs"
          description="Nothing matches the current search and filters."
          action={
            <Button variant="default" onClick={() => clear({ q: true })}>
              Clear filters
            </Button>
          }
        />
      )}

      {query.data && visible.length > 0 && <SpecListHeader wide={wide} />}

      {groups.map((g) => {
        const isCollapsed = !!collapsed[`${filters.group}:${g.key}`];
        return (
          <section key={g.key}>
            {filters.group !== 'none' && (
              <button
                type="button"
                className="group-header"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => ({ ...c, [`${filters.group}:${g.key}`]: !isCollapsed }))}
              >
                <IconChevronRight
                  size={12}
                  color="var(--app-text-faint)"
                  style={{ transform: isCollapsed ? undefined : 'rotate(90deg)', transition: 'transform 120ms ease' }}
                />
                {g.icon}
                <span>{g.label}</span>
                <Text component="span" size="sm" c="var(--app-text-faint)">
                  {g.specs.length}
                </Text>
              </button>
            )}
            {!isCollapsed && g.specs.map((s) => <SpecRow key={s.id} spec={s} byId={byId} now={now} wide={wide} />)}
          </section>
        );
      })}
    </>
  );
}
