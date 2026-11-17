import { Markdown } from '../components/Markdown';
import { QuestionsPanel } from '../components/questions/QuestionsPanel';
import { useEffect, useMemo } from 'react';
import { Alert, Skeleton, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconBolt, IconCircleCheck, IconCircleCheckFilled, IconCircleDashed, IconCircleOff, IconFileText } from '@tabler/icons-react';
import { KindIcon } from '../components/refs/KindIcon';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { allSectionsFinished, WAITING_FOR_COMPLETION_HINT } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { api } from '../api';
import { ClaimAvatar, ClaimCard, CriterionStateIcon, DocPage, Pill, PriorityIcon } from '../components/doc';
import { DecisionDialogs, ItemMenu } from '../components/decisions/DecisionActions';
import { itemPrompt } from '../lib/prompts';
import { compactTime } from '../lib/time';
import { emptyScaffolding, splitTitle } from '../lib/workOrderLayout';
import '../components/work-orders/wo-page.css';
import { useTrackedChanges } from '../components/doc/tracked';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { WORK_ORDER_STATUS_META, WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { DependencyGraph } from '../components/DependencyGraph';
import { FeedbackList } from '../components/FeedbackParts';
import { useFeedback, useHistory, useSpec, useStandards } from '../lib/queries';
import { categoryLabel, isStale, KIND_LABEL, PRIORITY_META, useNow, withFrontmatter } from '../lib/specs';
import { CodeTouched, CommentCount, CommentList, GitPanel, SectionProgress, WorkOrderGitSummary, WorkOrderViewContext } from '../components/work-orders/parts';
import { PlanSteps } from '../components/work-orders/PlanSteps';
import { WoSectionBadge } from '../components/work-orders/WoSection';
import { plural } from '../lib/audits';
import { SpecMaturityDot } from '../components/maturity/SpecMaturity';

const STATUS_ICON = {
  done: <IconCircleCheckFilled size={13} color="var(--mantine-color-teal-6)" />,
  obsolete: <IconCircleOff size={13} color="var(--app-text-faint)" />,
  pending: <IconCircleDashed size={13} />,
};

/**
 * A work order as a document (plan, one section per targeted spec section, reconciliation, outcome, history) with
 * the dependency graph on top, claim + progress, comment threads, code touched and git context in the rail.
 */
export function WorkOrderPage() {
  const { id = '' } = useParams<{ id: string }>();
  const now = useNow();
  const uri = buildRef({ kind: 'work-orders', id });
  const query = useQuery({ queryKey: ['work-orders', id, 'doc'], queryFn: () => api.workOrderDoc(id) });
  const comments = useQuery({ queryKey: ['work-orders', id, 'comments'], queryFn: () => api.comments(uri, true) });
  const history = useHistory('work-orders', id);
  const tracked = useTrackedChanges('work-orders', id);
  // Viewing a version: the dependency graph as of that commit.
  const depsAt = useQuery({ queryKey: ['work-orders', id, 'deps', tracked.commit], queryFn: () => api.workOrder(id, tracked.commit!), enabled: !!tracked.commit });
  const standards = useStandards();
  const feedback = useFeedback();
  const r = query.data?.workOrder;
  const specFull = useSpec(r?.item.spec ?? '');
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const crumbs = [{ label: 'Work orders', to: '/work-orders' }, { label: <span className="mono">{id}</span>, kind: 'work_order' as const }];
  const threads = comments.data?.threads ?? r?.comments?.threads ?? [];
  const view = useMemo(() => (r ? { id, resolved: r, threads } : null), [id, r, threads]);
  const { hash } = useLocation();
  // `#comment-<id>`: scroll to the comment once the (lazy) section bodies rendered.
  useEffect(() => {
    if (!hash.startsWith('#comment-') || !r) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.getElementById(hash.slice(1));
      if (el || ++tries > 30) {
        clearInterval(t);
        el?.scrollIntoView({ block: 'center' });
      }
    }, 100);
    return () => clearInterval(t);
  }, [hash, r]);

  if (query.isPending) {
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
  if (query.isError || !query.data || !r) {
    const notFound = /not found/i.test(query.error?.message ?? '');
    return (
      <>
        <TopBar crumbs={crumbs} />
        {notFound ? (
          <EmptyView icon={<IconFileText size={22} stroke={1.5} />} title="Work order not found" description={`There is no work order "${id}".`} />
        ) : (
          <ErrorState error={query.error ?? new Error('Unknown error')} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const after = tracked.commit ? tracked.data?.diff.after : undefined;
  const doc = after ? withFrontmatter(query.data, 'work-orders', after.frontmatter as Record<string, unknown>) : query.data;
  const { item, spec } = r;
  const done = item.sections.filter((s) => s.status !== 'pending').length;
  const title = doc.title || item.title || `${KIND_LABEL[item.kind]} · ${spec?.title ?? item.spec}`;
  const counts = comments.data?.counts ?? r.comments?.counts;
  const docSections = r.doc?.sections ?? [];
  const sectionThreads = (sid: string) => threads.filter((t) => t.target === buildRef({ kind: 'work-orders', id, sectionId: sid }));

  const { main: mainTitle, origin } = splitTitle(title);
  const { hidden: hiddenSections, missing } = emptyScaffolding(doc.sections);
  // Every section done on an open work order: the agent only has to complete it; a (stale) claim is moot.
  const waiting = (item.status === 'pending' || item.status === 'in_progress') && allSectionsFinished(item.sections);
  const stale = !!item.claim && !waiting && isStale(item.claim, now);
  const deps0 = tracked.commit ? depsAt.data?.dependencies : r.dependencies;
  const header = (
    <>
      <div className="doc-kicker">
        <Link to={`/specs/${item.spec}`} className="plain-link">
          {spec?.category ? `${categoryLabel(spec.category)} / ` : ''}
          {spec?.title ?? item.spec}
        </Link>
        <SpecMaturityDot id={item.spec} details />
      </div>
      <h1 className="doc-title wo-title" title={title}>
        {mainTitle}
      </h1>
      <div className="doc-pills">
        <Pill icon={<WorkOrderStatusIcon status={item.status} />}>{WORK_ORDER_STATUS_META[item.status].label}</Pill>
        <span className="kind-badge" data-kind={item.kind}>
          {KIND_LABEL[item.kind]}
        </span>
        {item.priority && <Pill icon={<PriorityIcon priority={item.priority} />}>{PRIORITY_META[item.priority].label}</Pill>}
        {item.fastPath && (
          <Tooltip label="Fast path: a one-section fix that can be claimed without a plan">
            <span>
              <Pill tone="accent" icon={<IconBolt size={13} />}>
                Fast path
              </Pill>
            </span>
          </Tooltip>
        )}
        {counts && counts.openBlocking > 0 && (
          <Pill tone="danger" icon={<IconAlertTriangle size={13} />}>
            {plural(counts.openBlocking, 'blocking comment')}
          </Pill>
        )}
        {origin && (
          <span className="wo-origin" data-testid="wo-origin">
            From {origin}
          </span>
        )}
      </div>
      <div className="wo-status-strip" data-testid="wo-status-strip">
        <div className="wo-strip-progress">
          <SectionProgress done={done} total={item.sections.length} />
        </div>
        <div className="wo-strip-claim">
          {waiting ? (
            <Tooltip label={WAITING_FOR_COMPLETION_HINT} multiline maw={320}>
              <span data-testid="wo-waiting-completion">
                <Pill tone="accent" icon={<IconCircleCheck size={13} />}>
                  Waiting for completion
                </Pill>
              </span>
            </Tooltip>
          ) : item.claim ? (
            <>
              <ClaimAvatar claim={item.claim} now={now} size={18} workOrder={item.id} />
              <span className="wo-strip-agent">{item.claim.agent}</span>
              <span className="live" data-stale={stale || undefined}>
                <span className="live-dot" />
                {stale ? 'Stale' : 'Live'} · heartbeat {compactTime(item.claim.heartbeatAt, now)}
              </span>
              {stale && (
                <ItemMenu
                  label={item.id}
                  prompt={itemPrompt('continue_work', uri)}
                  actions={[{ id: 'release', label: 'Release claim', primary: true, dialog: { type: 'release', ref: uri, title: item.id, agent: item.claim.agent, heartbeat: compactTime(item.claim.heartbeatAt, now) } }]}
                />
              )}
            </>
          ) : (
            <span className="faint small">{item.completedAt ? <>Completed <TimeAgo iso={item.completedAt} /></> : item.status === 'pending' ? 'Waiting for an agent to claim it' : 'Not claimed'}</span>
          )}
        </div>
        <div className="wo-strip-git">
          <WorkOrderGitSummary item={item} />
          {!item.git?.length && item.claim?.branch && <span className="mono small faint">{item.claim.branch}</span>}
          <span className="doc-updated">
            updated <TimeAgo iso={item.updatedAt} />
          </span>
        </div>
      </div>
      {item.note && (
        <blockquote className="q-note">
          <Markdown>{item.note}</Markdown>
        </blockquote>
      )}
      {!!item.planSteps?.length && <PlanSteps steps={item.planSteps} spec={item.spec} />}
      {missing.includes('Plan') && !tracked.commit && (
        <div className="wo-plan-missing" data-testid="wo-plan-missing">
          <strong>Plan</strong>
          <span>
            {item.fastPath
              ? 'Fast path: no plan needed; the agent fixes the one section directly.'
              : item.status === 'pending'
                ? 'Not written yet. The agent writes the plan (work_order_plan_set) before it can claim this work order.'
                : 'No plan was recorded for this work order.'}
          </span>
        </div>
      )}
      {missing.filter((m) => m !== 'Plan').length > 0 && !tracked.commit && (
        <p className="faint small wo-not-written" data-testid="wo-not-written">
          Not yet written: {missing.filter((m) => m !== 'Plan').join(', ')} (the agent fills {missing.filter((m) => m !== 'Plan').length === 1 ? 'it' : 'them'} in when the work is done).
        </p>
      )}
      {deps0 && (
        <div className="wo-deps">
          <DependencyGraph tree={deps0} />
        </div>
      )}
    </>
  );

  const banner = r.specMovedTo ? (
    <div className="spec-moved" role="status">
      <IconAlertTriangle size={16} className="spec-moved-icon" />
      <div className="spec-moved-text">
        <div className="spec-moved-title">The spec changed after this work order was planned</div>
        <div className="spec-moved-sub">
          <span className="spec-moved-commit mono">{item.specCommit.slice(0, 7)}</span>
          <IconArrowRight size={12} />
          <span className="spec-moved-commit mono" data-now>
            {r.specMovedTo.slice(0, 7)}
          </span>
          <span className="faint">Review the changes before implementing; re-pin the work order if they matter.</span>
        </div>
      </div>
      <Link to={`/specs/${item.spec}?version=${item.specCommit}&compare=current`} className="spec-moved-action">
        Review changes
        <IconArrowRight size={13} />
      </Link>
    </div>
  ) : undefined;

  // Open / accepted feedback on the targeted sections; criteria verifying them.
  const filed = (feedback.data ?? []).filter(
    (x) => x.status !== 'closed' && x.targets.some((t) => item.sections.some((s) => t.startsWith(buildRef({ kind: 'specs', id: item.spec, sectionId: s.id })))),
  );
  const ownStates = specFull.data?.verification && 'own' in specFull.data.verification ? specFull.data.verification.own : [];
  const criterionIds = new Set(r.sections.flatMap((x) => (x.section?.type === 'acceptance' ? [x.id] : (x.section?.verifiedBy ?? []))));
  const criteria = ownStates.filter((c) => criterionIds.has(c.sectionId));

  const topPanels = (
    <>
      <PropGroup title="Progress">
        <SectionProgress done={done} total={item.sections.length} />
        {item.claim ? <ClaimCard claim={item.claim} now={now} workOrder={item.id} /> : <span className="faint small">Not claimed{item.completedAt ? <> · completed <TimeAgo iso={item.completedAt} /></> : ''}</span>}
      </PropGroup>
      <PropGroup title={`Comments${counts ? ` · ${counts.open} open${counts.resolved ? `, ${counts.resolved} resolved` : ''}` : ''}`}>
        <CommentList threads={threads} workOrderId={id} showTarget anchor={(t) => !t.target.includes('/sections/')} empty={<span className="faint small">No comments. Agents and reviewers comment with comment_add.</span>} />
      </PropGroup>
    </>
  );

  const panels = (
    <>
      <PropGroup title={`Code touched${item.touched?.length ? ` · ${item.touched.length}` : ''}`}>
        <CodeTouched touched={r.touched ?? item.touched ?? []} sections={docSections} />
      </PropGroup>
      <PropGroup title="Git">
        <GitPanel git={r.git ?? item.git ?? []} claims={r.claims ?? item.claims ?? []} />
      </PropGroup>
      {(item.kind === 'verify' || criteria.length > 0) && (
        <PropGroup title={`Criteria · ${criteria.filter((c) => c.state === 'verified').length}/${criteria.length} verified`}>
          {criteria.length ? (
            criteria.map((c) => (
              <Link key={c.uri} to={`/specs/${item.spec}#section-${c.sectionId}`} className="linked-item">
                <CriterionStateIcon state={c.state} />
                <KindIcon kind="section" />
                <span className="linked-title">{c.title}</span>
                {c.method && <span className="linked-meta">{c.method}</span>}
              </Link>
            ))
          ) : (
            <span className="faint small">The targeted sections declare no criteria (verifiedBy).</span>
          )}
        </PropGroup>
      )}
      <PropGroup title={`Requests · ${filed.length}`}>
        <FeedbackList items={filed} />
      </PropGroup>
      <QuestionsPanel refUri={uri} />
      <PropGroup title="Properties">
        <Prop label="Spec" to={`/specs/${item.spec}`}>
          <span className="inline-icon">
            <IconFileText size={14} className="prop-icon" />
            {spec?.title ?? item.spec}
          </span>
        </Prop>
        <Prop label="Version">
          <span className="mono">{item.specCommit.slice(0, 7)}</span>
        </Prop>
        {(item.dependencies?.length ?? 0) > 0 && (
          <Prop label="After">
            <span className="wrap-row">
              {item.dependencies!.map((d) => (
                <Link key={d} to={`/work-orders/${d}`} className="mono small">
                  {d}
                </Link>
              ))}
            </span>
          </Prop>
        )}
        <Prop label="Created by">{item.createdBy ?? <span className="faint">Unknown</span>}</Prop>
        <Prop label="Created">
          <TimeAgo iso={item.createdAt} />
        </Prop>
      </PropGroup>
    </>
  );

  return (
    <DecisionDialogs>
    <WorkOrderViewContext.Provider value={view}>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'work-orders', id, title }}
        header={header}
        banner={banner}
        sections={tracked.commit ? doc.sections : doc.sections.filter((x) => !hiddenSections.has(x.id))}
        standardTitles={standardTitles}
        history={{ entries: history.data, loading: history.isPending, now }}
        tracked={tracked}
        topPanels={topPanels}
        panels={panels}
        headCommit={query.data.lastCommit ?? null}
        outlineStatus={new Map(docSections.map((s) => [s.id, STATUS_ICON[s.status]]))}
        sectionBadge={(section) => (
          <>
            <WoSectionBadge section={section} />
            <CommentCount threads={sectionThreads(section.id)} />
          </>
        )}
      />
    </WorkOrderViewContext.Provider>
    </DecisionDialogs>
  );
}
