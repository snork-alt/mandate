import { useMemo } from 'react';
import { SegmentedControl, Skeleton, Tooltip } from '@mantine/core';
import { IconFileOff, IconFolder } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { Component } from '@mandate/shared';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ArchitectureView, KIND_ICON } from '../components/architecture/ArchitectureView';
import { ClaimAvatar, DocPage, TagPill } from '../components/doc';
import { TrackedValue, useTrackedChanges } from '../components/doc/tracked';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { CopyRef, copyTargetProps } from '../components/copy';
import { LevelBadge } from '../components/rules/RuleParts';
import { WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { useEntityList, useHistory, useStandards } from '../lib/queries';
import { docTarget } from '../lib/refs';
import { useNow, withFrontmatter } from '../lib/specs';

export const useComponents = () => useEntityList('components') as ReturnType<typeof useEntityList> & { data?: Component[] };

function StatusBadge({ c }: { c: Pick<Component, 'status'> }) {
  return c.status === 'deprecated' || c.status === 'archived' ? (
    <span className="lifecycle-badge" data-status={c.status}>
      {c.status === 'archived' ? 'Archived' : 'Deprecated'}
    </span>
  ) : null;
}

function ComponentRow({ c }: { c: Component }) {
  const Icon = KIND_ICON[c.kind];
  const target = docTarget('components', c.id);
  return (
    <Link to={`/components/${c.id}`} className="row spec-row has-copy-ref" {...copyTargetProps(target)}>
      <Icon size={15} stroke={1.6} color="var(--app-text-muted)" style={{ flexShrink: 0 }} />
      <span className="row-id spec-row-id">{c.id}</span>
      <span className="spec-row-text">
        <span className="row-title">{c.title}</span>
        {c.summary && <span className="row-excerpt">{c.summary}</span>}
      </span>
      <span className="row-meta">
        <span className="row-copy">
          <CopyRef target={target} size="xs" />
        </span>
        <StatusBadge c={c} />
        <span className="tag-pill">{c.kind}</span>
        {c.owns.map((o) => (
          <Tooltip key={o.repo} label={o.paths.join(', ')}>
            <span className="tag-pill mono">{o.repo}</span>
          </Tooltip>
        ))}
        <span className="usedby-count" data-zero={!c.affectedBy?.length || undefined}>
          {c.affectedBy?.length ?? 0} spec{c.affectedBy?.length === 1 ? '' : 's'}
        </span>
        <span className="row-time">
          <TimeAgo iso={c.updatedAt} />
        </span>
      </span>
    </Link>
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
        <div className="list">{(list.data ?? []).map((c) => <ComponentRow key={c.id} c={c as unknown as Component} />)}</div>
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
    ...ancestors.map((a) => ({ label: <span className="mono">{a.id}</span>, to: `/components/${a.id}` })),
    { label: <span className="mono">{id}</span> },
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
        {c.owns.flatMap((o) =>
          o.paths.map((p) => (
            <span key={`${o.repo}:${p}`} className="chip chip-scope" title={c.emptyGlobs?.includes(`${o.repo}:${p}`) ? 'Matches no referenced code (coverage lint)' : 'Owned code'}>
              <IconFolder size={12} />
              <span className="mono">
                {o.repo}:{p}
              </span>
              {c.emptyGlobs?.includes(`${o.repo}:${p}`) && <span className="faint"> · no code</span>}
            </span>
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
            <span className="linked-title">{d}</span>
          </Link>
        ))}
        {(c.dependents ?? []).length > 0 && <div className="prop-subtitle">Used by</div>}
        {(c.dependents ?? []).map((d) => (
          <Link key={d} to={`/components/${d}`} className="linked-item">
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
              <span className="linked-title">{c.ancestors?.[0]?.title ?? c.parent}</span>
            </Link>
          )}
          {(c.children ?? []).map((k) => (
            <Link key={k.id} to={`/components/${k.id}`} className="linked-item">
              <span className="linked-title">{k.title}</span>
              <span className="linked-meta">{k.status !== 'active' ? k.status : k.id}</span>
            </Link>
          ))}
        </PropGroup>
      )}
      <PropGroup title={`Affected by specs · ${c.affectedBy?.length ?? 0}`}>
        {(c.affectedBy ?? []).map((a) => (
          <Link key={a.spec} to={`/specs/${a.spec}`} className="linked-item">
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
              <span className="linked-title mono">{w.id}</span>
              <span className="linked-meta">{w.spec}</span>
              {w.claim && <ClaimAvatar claim={w.claim} now={now} size={16} />}
            </Link>
          ))}
        </PropGroup>
      )}
      <PropGroup title={`Rules · ${c.rules?.length ?? 0}`}>
        {(c.rules ?? []).slice(0, 30).map((r) => (
          <Link key={r.uri} to={`/standards/${r.standard}#section-${r.uri.split('/').pop()}`} className="linked-item" title={r.via}>
            <LevelBadge level={r.level} />
            <span className="linked-title">{r.title}</span>
          </Link>
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
