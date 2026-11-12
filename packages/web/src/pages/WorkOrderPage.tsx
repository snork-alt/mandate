import { useMemo, useState } from 'react';
import { Alert, Button, Skeleton, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheckFilled, IconCircleDashed, IconCircleOff, IconFileText, IconGitCommit } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ResolvedWorkOrderSection, Section, Spec } from '@mandate/shared';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { buildRef } from '@mandate/shared/refs';
import { ClaimCard, CriterionStateIcon, DocPage, Pill, PriorityIcon, SectionBlock } from '../components/doc';
import { TrackedSection } from '../components/doc/tracked';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { WORK_ORDER_STATUS_META, WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { DependencyGraph } from '../components/DependencyGraph';
import { useFeedback, useStandards } from '../lib/queries';
import { FeedbackList } from '../components/FeedbackParts';
import { sectionTarget } from '../lib/refs';
import { categoryLabel, PRIORITY_META, useNow } from '../lib/specs';
import { KIND_LABEL } from '../lib/specs';

function SectionStatus({ status }: { status: 'pending' | 'done' | 'obsolete' }) {
  if (status === 'obsolete')
    return (
      <span className="q-section-status" data-status="obsolete">
        <IconCircleOff size={13} /> Obsolete
      </span>
    );
  return status === 'done' ? (
    <span className="q-section-status" data-status="done">
      <IconCircleCheckFilled size={13} /> Done
    </span>
  ) : (
    <span className="q-section-status">
      <IconCircleDashed size={13} /> Pending
    </span>
  );
}

/** For `update` items: Word-style changes of a section from its implementedCommit to the item's specCommit. */
function UpdateDiff({ spec, specCommit, section, badge, standardTitles }: { spec: string; specCommit: string; section: Section; badge: React.ReactNode; standardTitles: Map<string, string> }) {
  const base = section.implementedCommit;
  const types = useQuery({ queryKey: ['section-types'], queryFn: api.sectionTypes, staleTime: Infinity });
  const tracked = useQuery({
    queryKey: ['specs', spec, 'tracked-base', specCommit, base],
    enabled: !!base && !!types.data,
    staleTime: Infinity,
    queryFn: async () => {
      const version = await api.version('specs', spec, specCommit, 'parent', base);
      return (await import('../components/doc/tracked/compute')).computeTracked('specs', version, types.data!);
    },
  });
  const plain = <SectionBlock section={section} standardTitles={standardTitles} badge={badge} target={sectionTarget('specs', spec, section, specCommit)} />;
  if (!base) return plain;
  if (tracked.isPending) return <Skeleton height={160} radius="md" my="md" />;
  const diff = tracked.data?.diff.sections.find((s) => s.id === section.id);
  // Only text changes matter for an update (implementedCommit metadata always differs).
  if (!diff || diff.status === 'unchanged' || (!diff.body && !diff.title && diff.status === 'modified')) return plain;
  return (
    <div>
      <div className="q-update-note">
        <IconGitCommit size={13} /> Changes since implemented at <span className="mono">{base}</span> {badge}
      </div>
      <TrackedSection diff={diff} tree={tracked.data?.trees.get(section.id)} standardTitles={standardTitles} target={sectionTarget('specs', spec, section, specCommit)} />
    </div>
  );
}

export function WorkOrderPage() {
  const { id = '' } = useParams<{ id: string }>();
  const now = useNow();
  const [latest, setLatest] = useState(false);
  const [params, setParams] = useSearchParams();
  // `?version=<commit>`: the dependency graph as it was at that commit.
  const at = params.get('version') ?? undefined;
  const resolved = useQuery({ queryKey: ['work-orders', id, at ?? 'head'], queryFn: () => api.workOrder(id, at), placeholderData: (prev) => prev });
  const history = useQuery({ queryKey: ['work-orders', id, 'history'], queryFn: () => api.workOrderHistory(id) });
  const standards = useStandards();
  const feedback = useFeedback();
  const specFull = useQuery({ queryKey: ['specs', resolved.data?.item.spec ?? ''], queryFn: () => api.get('specs', resolved.data!.item.spec) as Promise<Spec>, enabled: !!resolved.data });
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const crumbs = [{ label: 'Work orders', to: '/work-orders' }, { label: <span className="mono">{id}</span> }];

  const r = resolved.data;
  const bySection = useMemo(() => new Map<string, ResolvedWorkOrderSection>((r?.sections ?? []).map((s) => [s.id, s])), [r]);
  const sections = useMemo(
    () =>
      (r?.sections ?? [])
        .map((s) => (latest && s.headChanged ? s.latest : s.section))
        .filter((s): s is Section => !!s),
    [r, latest],
  );

  if (resolved.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="doc-main" style={{ margin: '0 auto' }}>
          <Skeleton height={30} width="50%" mb="md" />
          <Skeleton height={160} />
        </div>
      </>
    );
  }
  if (resolved.isError || !r) {
    const notFound = /not found/i.test(resolved.error?.message ?? '');
    return (
      <>
        <TopBar crumbs={crumbs} />
        {notFound ? (
          <EmptyView icon={<IconFileText size={22} stroke={1.5} />} title="Work order not found" description={`There is no work order "${id}".`} />
        ) : (
          <ErrorState error={resolved.error ?? new Error('Unknown error')} onRetry={() => void resolved.refetch()} />
        )}
      </>
    );
  }

  const { item, spec } = r;
  const done = item.sections.filter((s) => s.status === 'done').length;
  const title = `${KIND_LABEL[item.kind]} · ${spec?.title ?? item.spec}`;

  const header = (
    <>
      <div className="doc-kicker">
        <Link to={`/specs/${item.spec}`} className="plain-link">
          {spec?.category ? `${categoryLabel(spec.category)} / ` : ''}
          {spec?.title ?? item.spec}
        </Link>
        <span className="mono faint"> @{item.specCommit}</span>
      </div>
      <h1 className="doc-title">{title}</h1>
      <div className="doc-pills">
        <Pill icon={<WorkOrderStatusIcon status={item.status} />}>{WORK_ORDER_STATUS_META[item.status].label}</Pill>
        <span className="kind-badge" data-kind={item.kind}>
          {KIND_LABEL[item.kind]}
        </span>
        <Pill icon={<PriorityIcon priority={item.priority} />}>{item.priority ? PRIORITY_META[item.priority].label : 'No priority'}</Pill>
        <span className="doc-updated">
          {done}/{item.sections.length} sections done · updated <TimeAgo iso={item.updatedAt} />
        </span>
      </div>
      {item.note && <blockquote className="q-note">{item.note}</blockquote>}
    </>
  );

  const versionBanner = at && (
    <Alert color="gray" variant="light" radius="md" mb="md" icon={<IconGitCommit size={16} />} className="q-banner">
      <span>
        Dependencies as of <span className="mono">{at.slice(0, 7)}</span>.
      </span>
      <Button size="xs" variant="subtle" onClick={() => setParams({}, { replace: true })}>
        Back to latest
      </Button>
    </Alert>
  );
  const banner = (versionBanner || r.specMovedTo) && (
    <>
    {versionBanner}
    {r.specMovedTo && (
    <Alert color="yellow" variant="light" radius="md" mb="md" icon={<IconAlertTriangle size={16} />} className="q-banner">
      <span>
        {latest ? 'Showing the latest spec content.' : 'Spec changed since this work item was created.'}
      </span>
      <Button size="xs" variant="subtle" onClick={() => setLatest((l) => !l)}>
        {latest ? `Show @${item.specCommit}` : 'Show latest'}
      </Button>
    </Alert>
    )}
    </>
  );

  // Open / accepted feedback on the sections this item works on.
  const filed = (feedback.data ?? []).filter(
    (x) => x.status !== 'closed' && x.targets.some((t) => item.sections.some((s) => t.startsWith(buildRef({ kind: 'specs', id: item.spec, sectionId: s.id })))),
  );
  // Criteria verifying the targeted sections (verifiedBy) plus targeted criteria themselves.
  const ownStates = specFull.data?.verification && 'own' in specFull.data.verification ? specFull.data.verification.own : [];
  const criterionIds = new Set(
    r.sections.flatMap((x) => (x.section?.type === 'acceptance' ? [x.id] : (x.section?.verifiedBy ?? []))),
  );
  const criteria = ownStates.filter((c) => criterionIds.has(c.sectionId));
  const panels = (
    <>
    {(item.kind === 'verify' || criteria.length > 0) && (
      <PropGroup title={`Criteria · ${criteria.filter((c) => c.state === 'verified').length}/${criteria.length} verified`}>
        {criteria.length ? (
          criteria.map((c) => (
            <Link key={c.uri} to={`/specs/${item.spec}#section-${c.sectionId}`} className="linked-item">
              <CriterionStateIcon state={c.state} />
              <span className="linked-title">{c.title}</span>
              {c.method && <span className="linked-meta">{c.method}</span>}
            </Link>
          ))
        ) : (
          <span className="faint small">The targeted sections declare no criteria (verifiedBy).</span>
        )}
      </PropGroup>
    )}
    <PropGroup title={`Feedback · ${filed.length}`}>
      <FeedbackList items={filed} />
    </PropGroup>
    <PropGroup title="Properties">
      <Prop label="Spec" to={`/specs/${item.spec}`}>
        <span className="inline-icon">
          <IconFileText size={14} className="prop-icon" />
          {spec?.title ?? item.spec}
        </span>
      </Prop>
      <Prop label="Version">
        <span className="mono">{item.specCommit}</span>
      </Prop>
      <Prop label="Status" to={`/work-orders`}>
        <span className="inline-icon">
          <WorkOrderStatusIcon status={item.status} />
          {WORK_ORDER_STATUS_META[item.status].label}
        </span>
      </Prop>
      <Prop label="Created by">{item.createdBy ?? <span className="faint">Unknown</span>}</Prop>
      <Prop label="Created">
        <TimeAgo iso={item.createdAt} />
      </Prop>
    </PropGroup>
    </>
  );

  return (
    <>
      <TopBar crumbs={crumbs} />
      {r.dependencies && (
        <div className="dep-strip-wrap">
          <DependencyGraph tree={r.dependencies} />
        </div>
      )}
      <DocPage
        doc={{ kind: 'work-orders', id: item.spec, title }}
        header={header}
        banner={banner}
        versionHref={(c) => `?version=${c}`}
        activeCommit={at}
        sections={sections}
        standardTitles={standardTitles}
        history={{ entries: history.data, loading: history.isPending, now }}
        topPanels={
          item.claim ? (
            <PropGroup title="Claim">
              <ClaimCard claim={item.claim} now={now} />
            </PropGroup>
          ) : undefined
        }
        panels={panels}
        outlineStatus={
          new Map(
            item.sections.map((s) => [
              s.id,
              s.status === 'done' ? (
                <IconCircleCheckFilled size={13} color="var(--mantine-color-teal-6)" />
              ) : s.status === 'obsolete' ? (
                <IconCircleOff size={13} color="var(--app-text-faint)" />
              ) : (
                <IconCircleDashed size={13} />
              ),
            ]),
          )
        }
        renderSection={(section) => {
          const status = bySection.get(section.id)?.status ?? 'pending';
          const badge = (
            <>
              <SectionStatus status={status} />
              {bySection.get(section.id)?.broken && (
                <span className="link-badge" data-tone="danger" title="A depends_on target is archived or missing">
                  Broken dependency
                </span>
              )}
              {bySection.get(section.id)?.archived && (
                <span className="link-badge" data-tone="muted">
                  Archived
                </span>
              )}
              {bySection.get(section.id)?.blocked && (
                <span className="link-badge" data-tone="danger">
                  Blocked
                </span>
              )}
            </>
          );
          return item.kind === 'update' && !latest ? (
            <UpdateDiff spec={item.spec} specCommit={item.specCommit} section={section} badge={badge} standardTitles={standardTitles} />
          ) : (
            <SectionBlock section={section} standardTitles={standardTitles} badge={badge} target={sectionTarget('specs', item.spec, section, latest ? undefined : item.specCommit)} />
          );
        }}
      />
      {sections.length === 0 && (
        <Text c="var(--app-text-muted)" ta="center">
          The targeted sections no longer exist in this spec version.
        </Text>
      )}
    </>
  );
}
