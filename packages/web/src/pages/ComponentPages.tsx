import { useMemo } from 'react';
import { KindIcon } from '../components/refs/KindIcon';
import { SegmentedControl, Skeleton, Tooltip } from '@mantine/core';
import { IconFileOff, IconFolder } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { Component } from '@mandate/shared';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ArchitectureView, KIND_ICON } from '../components/architecture/ArchitectureView';
import { ClaimAvatar, DocPage, TagPill, TldrCard } from '../components/doc';
import { TrackedValue, useTrackedChanges } from '../components/doc/tracked';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { TimeAgo } from '../components/TimeAgo';
import { ListHeader, ListRow, RowTime, withNodes, type ChipItem, type ColDef } from '../components/list/ListRow';
import { absoluteTime } from '../lib/time';
import { TopBar } from '../components/TopBar';
import { CopyRef, copyTargetProps } from '../components/copy';
import { LevelBadge } from '../components/rules/RuleParts';
import { WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { useEntityList, useHistory, useStandards } from '../lib/queries';
import { docTarget } from '../lib/refs';
import { useNow, withFrontmatter } from '../lib/specs';
import { RowPeople } from '../components/people/People';
import { bareRef } from '../lib/lineage';

export const useComponents = () => useEntityList('components') as ReturnType<typeof useEntityList> & { data?: Component[] };

function StatusBadge({ c }: { c: Pick<Component, 'status'> }) {
  return c.status === 'deprecated' || c.status === 'archived' ? (
    <span className="lifecycle-badge" data-status={c.status}>
      {c.status === 'archived' ? 'Archived' : 'Deprecated'}
    </span>
  ) : null;
}

/** Reference gaps (integrity warnings): what is missing and the suggested fix. */
function GapsTooltip({ gaps }: { gaps: NonNullable<Component['gaps']> }) {
  return (
    <div className="gaps-tooltip">
      {gaps.map((g) => (
        <div key={g.rule}>
          <div>{g.message.replace(/^[^:]+: /, '')}</div>
          <div className="gaps-hint">{g.hint}</div>
        </div>
      ))}
    </div>
  );
}

const COMPONENT_COLS: ColDef[] = [
  { key: 'gaps', width: 14, align: 'center' },
  { key: 'status', width: 84, hide: 'lg', label: 'Lifecycle', tip: 'Deprecated or archived (empty: active)' },
  { key: 'specs', width: 64, hide: 'md', label: 'Specs', tip: 'Specs that affect this component' },
];

function ComponentListHeader() {
  return (
    <ListHeader
      list="components"
      id={{ label: 'ID', tip: 'Component id' }}
      idWidth={150}
      main={{ label: 'Component', tip: 'Title and summary' }}
      chips={{ label: 'Kind · repos', tip: 'Kind and the repositories (paths) it owns' }}
      chipsWidth={220}
      cols={COMPONENT_COLS}
    />
  );
}

function ComponentRow({ c }: { c: Component }) {
  const Icon = KIND_ICON[c.kind];
  const target = docTarget('components', c.id);
  const chips: ChipItem[] = [
    { key: '~kind', node: <span className="tag-pill">{c.kind}</span> },
    ...c.owns.map((o) => ({
      key: o.repo,
      node: (
        <Tooltip label={o.paths.join(', ')}>
          <span className="tag-pill mono">{o.repo}</span>
        </Tooltip>
      ),
      label: (
        <span>
          <span className="mono">{o.repo}</span> <span className="faint">{o.paths.join(', ')}</span>
        </span>
      ),
    })),
  ];
  return (
    <ListRow
      to={`/components/${c.id}`}
      list="components"
      className="spec-row"
      copy={target}
      lead={<Icon size={15} stroke={1.6} color="var(--app-text-muted)" />}
      id={c.id}
      idWidth={150}
      title={c.title}
      excerpt={c.summary}
      chips={chips}
      chipsWidth={220}
      cols={withNodes(COMPONENT_COLS, {
        gaps: (c.gaps?.length ?? 0) > 0 && (
          <Tooltip label={<GapsTooltip gaps={c.gaps!} />} multiline maw={360} withArrow>
            <span className="gap-dot" role="img" aria-label={`${c.gaps!.length} reference gap${c.gaps!.length === 1 ? '' : 's'}`} />
          </Tooltip>
        ),
        status: <StatusBadge c={c} />,
        specs: (
          <span className="usedby-count" data-zero={!c.affectedBy?.length || undefined}>
            {c.affectedBy?.length ?? 0} spec{c.affectedBy?.length === 1 ? '' : 's'}
          </span>
        ),
      })}
      people={<RowPeople refUri={bareRef(target.ref)} fallback={{ user: c.lastEditedBy?.user ?? c.createdBy?.user, agent: c.lastEditedBy?.agent ?? c.createdBy?.agent ?? c.updatedBy ?? undefined, at: c.updatedAt, verb: c.lastEditedBy ? 'Edited' : 'Created' }} />}
      time={<RowTime iso={c.updatedAt} label={`Updated ${absoluteTime(c.updatedAt)}`} />}
    />
  );
}

/** `/components`: the generated architecture (default) or the list. */
export function ComponentsPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'list' ? 'list' : 'diagram';
  const list = useComponents();
  return (
    <div className={view === 'diagram' ? 'arch-page' : undefined}>
      <TopBar crumbs={[{ label: 'Components' }]}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setParams(v === 'list' ? { view: 'list' } : {}, { replace: true })}
          data={[
            { value: 'diagram', label: 'Architecture' },
            { value: 'list', label: 'List' },
          ]}
        />
      </TopBar>
      {view === 'diagram' ? (
        <ArchitectureView initialFocus={params.get('focus')} />
      ) : list.isPending ? (
        <Skeleton height={200} m="md" />
      ) : (
        <div className="list">
          {(list.data ?? []).length > 0 && <ComponentListHeader />}
          {(list.data ?? []).map((c) => <ComponentRow key={c.id} c={c as unknown as Component} />)}
        </div>
      )}
    </div>
  );
}

/** A component document (shared DocPage: history, track changes, references, copy rules). */
export function ComponentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useQuery({ queryKey: ['components', id], queryFn: () => api.get("components", id) as unknown as Promise<Component> });
  const history = useHistory('components', id);
  const standards = useStandards();
  const now = useNow();
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const tracked = useTrackedChanges('components', id);
  // Breadcrumb through the containment chain: Components / billing / stripe-webhooks / <id>.
  const ancestors = [...(query.data?.ancestors ?? [])].reverse();
  const crumbs = [
    { label: 'Components', to: '/components' },
    ...ancestors.map((a) => ({ label: <span className="mono">{a.id}</span>, to: `/components/${a.id}`, kind: 'component' as const })),
    { label: <span className="mono">{id}</span>, kind: 'component' as const },
  ];
  const after = tracked.commit ? tracked.data?.diff.after : undefined;
  const c = query.data && after ? withFrontmatter(query.data, 'components', after.frontmatter as Record<string, unknown>) : query.data;

  if (query.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <Skeleton height={200} m="md" />
      </>
    );
  }
  if (!c) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        {/not found/i.test(query.error?.message ?? '') ? (
          <EmptyView icon={<IconFileOff size={22} stroke={1.5} />} title="Component not found" description={`There is no component "${id}".`} />
        ) : (
          <ErrorState error={query.error ?? new Error('Unknown error')} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }
  const Icon = KIND_ICON[c.kind];
  const header = (
    <>
      <h1 className="doc-title">
        <TrackedValue field="title" value={c.title} render={(v) => v} />
      </h1>
      <TldrCard tldr={c.tldr} />
      {c.summary && (
        <p className="doc-summary">
          <TrackedValue field="summary" value={c.summary} render={(v) => v} />
        </p>
      )}
      <div className="doc-pills">
        <span className="tag-pill">
          <Icon size={12} /> {c.kind}
        </span>
        <StatusBadge c={c} />
        {(c.gaps?.length ?? 0) > 0 && (
          <Tooltip label={<GapsTooltip gaps={c.gaps!} />} multiline maw={360} withArrow>
            <span className="gaps-notice" tabIndex={0}>
              <span className="gap-dot" aria-hidden />
              Gaps · {c.gaps!.length}
            </span>
          </Tooltip>
        )}
        {c.owns.flatMap((o) =>
          o.paths.map((p) => (
            <Tooltip key={`${o.repo}:${p}`} label={c.emptyGlobs?.includes(`${o.repo}:${p}`) ? 'Matches no referenced code (coverage lint)' : 'Owned code'} openDelay={300}>
              <span className="chip chip-scope">
                <IconFolder size={12} />
                <span className="mono">
                  {o.repo}:{p}
                </span>
                {c.emptyGlobs?.includes(`${o.repo}:${p}`) && <span className="faint"> · no code</span>}
              </span>
            </Tooltip>
          )),
        )}
        <span className="doc-updated">
          Updated <TimeAgo iso={c.updatedAt} />
        </span>
      </div>
    </>
  );
  const panels = (
    <>
      <PropGroup title={`Depends on · ${c.dependsOn?.length ?? 0}`}>
        {(c.dependsOn ?? []).map((d) => (
          <Link key={d} to={`/components/${d}`} className="linked-item">
            <KindIcon kind="component" />
            <span className="linked-title">{d}</span>
          </Link>
        ))}
        {(c.dependents ?? []).length > 0 && <div className="prop-subtitle">Used by</div>}
        {(c.dependents ?? []).map((d) => (
          <Link key={d} to={`/components/${d}`} className="linked-item">
            <KindIcon kind="component" />
            <span className="linked-title">{d}</span>
          </Link>
        ))}
        <Link to={`/components?focus=${c.id}`} className="faint small">
          Show in the architecture
        </Link>
      </PropGroup>
      {((c.children ?? []).length > 0 || c.parent) && (
        <PropGroup title={`Contains · ${c.children?.length ?? 0}`}>
          {c.parent && (
            <Link to={`/components/${c.parent}`} className="linked-item">
              <span className="linked-meta">Part of</span>
              <KindIcon kind="component" />
              <span className="linked-title">{c.ancestors?.[0]?.title ?? c.parent}</span>
            </Link>
          )}
          {(c.children ?? []).map((k) => (
            <Link key={k.id} to={`/components/${k.id}`} className="linked-item">
              <KindIcon kind="component" />
              <span className="linked-title">{k.title}</span>
              <span className="linked-meta">{k.status !== 'active' ? k.status : k.id}</span>
            </Link>
          ))}
        </PropGroup>
      )}
      <PropGroup title={`Affected by specs · ${c.affectedBy?.length ?? 0}`}>
        {(c.affectedBy ?? []).map((a) => (
          <Link key={a.spec} to={`/specs/${a.spec}`} className="linked-item">
            <KindIcon kind="spec" />
            <span className="linked-title">{a.title}</span>
            <span className="linked-meta">{a.via.join(' + ')}</span>
          </Link>
        ))}
        {(c.specStates?.drifted ?? 0) + (c.specStates?.blocked ?? 0) + (c.specStates?.failing ?? 0) > 0 && (
          <span className="faint small">
            {c.specStates!.drifted} drifted · {c.specStates!.blocked} blocked · {c.specStates!.failing} failing criteria
          </span>
        )}
      </PropGroup>
      {(c.workOrders ?? []).length > 0 && (
        <PropGroup title={`Active work orders · ${c.workOrders!.length}`}>
          {c.workOrders!.map((w) => (
            <Link key={w.id} to={`/work-orders/${w.id}`} className="linked-item">
              <WorkOrderStatusIcon status={w.status as never} />
              <KindIcon kind="work_order" />
              <span className="linked-title mono">{w.id}</span>
              <span className="linked-meta">{w.spec}</span>
              {w.claim && <ClaimAvatar claim={w.claim} now={now} size={16} workOrder={w.id} />}
            </Link>
          ))}
        </PropGroup>
      )}
      <PropGroup title={`Rules · ${c.rules?.length ?? 0}`}>
        {(c.rules ?? []).slice(0, 30).map((r) => (
          <Tooltip key={r.uri} label={r.via} disabled={!r.via} multiline maw={320} openDelay={300}>
            <Link to={`/standards/${r.standard}#section-${r.uri.split('/').pop()}`} className="linked-item">
              <LevelBadge level={r.level} />
              <KindIcon kind="section" />
              <span className="linked-title">{r.title}</span>
            </Link>
          </Tooltip>
        ))}
      </PropGroup>
      <PropGroup title="Properties">
        <Prop label="Owner">{c.owner ?? <span className="faint">None</span>}</Prop>
        <Prop label="Layer">{c.layer ?? <span className="faint">{c.parent ? 'Inherited from its parent' : 'Derived from dependencies'}</span>}</Prop>
        <Prop label="Tags">
          <span className="wrap-row">
            {c.tags.map((t) => (
              <TagPill key={t} tag={t} />
            ))}
          </span>
        </Prop>
        <Prop label="Open feedback">{c.openFeedback ?? 0}</Prop>
      </PropGroup>
    </>
  );
  return (
    <>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'components', id: c.id, title: c.title }}
        attribution={c}
        header={header}
        sections={c.sections}
        standardTitles={standardTitles}
        history={{ entries: history.data, loading: history.isPending, now }}
        tracked={tracked}
        panels={panels}
        links={c.links}
        headCommit={c.lastCommit}
      />
    </>
  );
}
