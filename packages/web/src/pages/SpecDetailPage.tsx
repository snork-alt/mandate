import { useMemo } from 'react';
import { QuestionsPanel } from '../components/questions/QuestionsPanel';
import { buildRef } from '@mandate/shared/refs';
import { RailDetails } from '../components/rail/RailDetails';
import { ActionIcon, CopyButton, Skeleton, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheckFilled, IconBrandGit, IconCheck, IconCopy, IconFileOff, IconFolder, IconGitBranch, IconLock, IconRotateClockwise2, IconUnlink, IconUser } from '@tabler/icons-react';
import { KindIcon } from '../components/refs/KindIcon';
import type { WorkOrder, Spec, SectionImplementation } from '@mandate/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Link, useNavigate, useParams } from 'react-router';
import { FeedbackBadge } from '../components/FeedbackBadge';
import { VerificationPanel } from '../components/VerificationPanel';
import { DriftPanel } from '../components/DriftPanel';
import { CommitHash } from '../components/copy';
import { FeedbackList } from '../components/FeedbackParts';
import {
  ClaimAvatar,
  DocPage,
  Pill,
  PriorityIcon,
  PriorityPill,
  StandardChip,
  StatusIcon,
  StatusPill,
  TagPill,
  TldrCard,
} from '../components/doc';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { WorkOrderStatusIcon } from '../components/WorkOrderStatusIcon';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { useDocFeedback, useHistory, useWorkOrders, useSpec, useSpecs, useStandards } from '../lib/queries';
import { TrackedList, TrackedValue, useTrackedChanges } from '../components/doc/tracked';
import { deletedDoc, withFrontmatter, blockingDeps, categoryLabel, isReopened, isStale, PRIORITY_META, SPEC_STATUS_META, useNow } from '../lib/specs';
import { relativeTime } from '../lib/time';
import { KIND_LABEL } from '../lib/specs';
import { AuditsPanel, LastAuditLine } from '../components/audits/panels';
import { MaturityBadge, MaturityDot } from '../components/maturity/MaturityBadge';

function SpecLink({ id, spec }: { id: string; spec?: Spec }) {
  return (
    <Link to={`/specs/${id}`} className="linked-item" data-missing={spec ? undefined : true}>
      {spec?.maturity ? <MaturityDot m={spec.maturity} details={false} /> : spec ? <StatusIcon status={spec.status} reopened={isReopened(spec)} withTooltip /> : <IconFileOff size={14} />}
      <KindIcon kind="spec" />
      <span className="linked-title">{spec?.title ?? id}</span>
      {spec && <span className="linked-meta">{spec.maturity?.label ?? SPEC_STATUS_META[spec.status].label}</span>}
    </Link>
  );
}

/** "Implemented @abc1234" / "Outdated" / "Not implemented", plus links to open work orders for the section. */
export function ImplementationBadge({ state, openItems, by, spec }: { state?: SectionImplementation[string]; openItems: WorkOrder[]; /** Work order that delivered the implementation (`implementedBy`). */ by?: string; /** Spec id: the Outdated badge links to the diff of the change. */ spec?: string }) {
  const implBy = by ?? state?.implementedBy;
  return (
    <span className="impl-badges">
      {!state ? (
        <span className="impl-badge" data-state="none">
          Not implemented
        </span>
      ) : state.outdated ? (
        <Tooltip
          multiline
          w={300}
          label={`Changed since implemented commit ${state.implementedCommit?.slice(0, 7) ?? ''}${state.changedBy ? ` (by ${state.changedBy}${state.changedAt ? `, ${relativeTime(state.changedAt)}` : ''})` : ''}.${implBy ? ` Implemented by ${implBy}.` : ''}${spec && state.changedCommit ? ' Click for the diff.' : ''} Wording only: the agent marks the edit editorial; otherwise it re-verifies or updates the code.`}
        >
          {spec && state.changedCommit ? (
            <Link to={`/specs/${spec}/history/${state.changedCommit}`} className="impl-badge" data-state="outdated" data-testid="outdated-diff-link">
              <IconAlertTriangle size={12} /> Outdated
            </Link>
          ) : (
            <span className="impl-badge" data-state="outdated">
              <IconAlertTriangle size={12} /> Outdated
            </span>
          )}
        </Tooltip>
      ) : (
        <span className="impl-badge" data-state="done">
          <IconCircleCheckFilled size={12} /> Implemented {state.implementedCommit && <CommitHash sha={state.implementedCommit} className="impl-commit" />}
        </span>
      )}
      {implBy && (
        <Tooltip label={`Implemented by work order ${implBy}`} openDelay={300}>
          <Link to={`/work-orders/${implBy}`} className="impl-badge impl-work-order" data-testid="implemented-by">
            Implemented by <span className="mono">{implBy}</span>
          </Link>
        </Tooltip>
      )}
      {openItems.map((q) => (
        <Tooltip key={q.id} label={`${KIND_LABEL[q.kind]} · ${q.status.replace('_', ' ')}`} openDelay={300}>
          <Link to={`/work-orders/${q.id}`} className="impl-badge impl-work-order">
            <WorkOrderStatusIcon status={q.status} size={12} />
            <span className="mono">{q.id}</span>
          </Link>
        </Tooltip>
      ))}
    </span>
  );
}

function DetailSkeleton() {
  return (
    <div className="doc-layout">
      <aside className="doc-outline-col">
        {[70, 55, 80].map((w, i) => (
          <Skeleton key={i} height={10} width={`${w}%`} radius="sm" mb={14} />
        ))}
      </aside>
      <div className="doc-main">
        <Skeleton height={30} width="60%" radius="sm" mb={14} />
        <Skeleton height={14} width="80%" radius="sm" mb={28} />
        {[92, 80, 96, 60, 85, 70].map((w, i) => (
          <Skeleton key={i} height={11} width={`${w}%`} radius="sm" mb={12} />
        ))}
      </div>
      <RailDetails>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={12} radius="sm" mb={18} />
        ))}
      </RailDetails>
    </div>
  );
}

export function SpecDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useSpec(id);
  const specs = useSpecs();
  const standards = useStandards();
  const history = useHistory('specs', id);
  const workOrders = useWorkOrders();
  const now = useNow();

  const byId = useMemo(() => new Map((specs.data ?? []).map((s) => [s.id, s])), [specs.data]);
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const tracked = useTrackedChanges('specs', id);
  const implementation = useQuery({ queryKey: ['specs', id, 'implementation'], queryFn: () => api.implementation(id) });
  const feedback = useDocFeedback('specs', id);
  const navigate = useNavigate();
  // In tracked-changes mode the header and panels show the viewed version's frontmatter.
  const after = tracked.commit ? tracked.data?.diff.after : undefined;
  // A deleted document can still be viewed at a past version (?version=...): build it from that version.
  const deletedView = !query.data && query.isError && after ? deletedDoc<Spec>(id, after, tracked.version?.meta.date) : undefined;
  const spec = query.data && after ? withFrontmatter(query.data, 'specs', after.frontmatter as Record<string, unknown>) : (query.data ?? deletedView);

  const crumbs = [
    { label: 'Specs', to: '/specs' },
    ...(spec?.category ? [{ label: categoryLabel(spec.category), to: `/specs?category=${encodeURIComponent(spec.category)}` }] : []),
    { label: <span className="mono">{id}</span>, kind: 'spec' as const },
  ];

  if (query.isPending || (query.isError && tracked.commit && tracked.loading)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <DetailSkeleton />
      </>
    );
  }
  if (!spec) {
    const notFound = /not found/i.test(query.error?.message ?? '');
    return (
      <>
        <TopBar crumbs={crumbs} />
        {notFound ? (
          <EmptyView
            icon={<IconFileOff size={22} stroke={1.5} />}
            title="Spec not found"
            description={`There is no spec with id "${id}".`}
            action={
              <Text component={Link} to="/specs" size="md" c="var(--mantine-primary-color-filled)">
                Back to specs
              </Text>
            }
          />
        ) : (
          <ErrorState error={query.error ?? new Error('Unknown error')} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const verification = spec.verification && 'own' in spec.verification ? spec.verification : undefined;
  const criteria = verification ? new Map(verification.own.map((c) => [c.sectionId, c])) : undefined;
  const reopened = isReopened(spec);
  const blocking = blockingDeps(spec, byId);
  const dependents = (specs.data ?? []).filter((s) => (s.dependsOn ?? []).includes(spec.id));
  const specWorkOrders = (workOrders.data ?? []).filter((q) => q.spec === spec.id);
  const openItems = specWorkOrders.filter((q) => q.status === 'pending' || q.status === 'in_progress');

  const header = (
    <>
      <h1 className="doc-title">
        <TrackedValue field="title" value={spec.title} render={(v) => v} />
      </h1>
      <TldrCard tldr={spec.tldr} />
      {(spec.summary || tracked.data) && (
        <p className="doc-summary">
          <TrackedValue field="summary" value={spec.summary} render={(v) => v} />
        </p>
      )}
      <div className="doc-pills">
        {spec.maturity && !tracked.commit ? (
          <MaturityBadge m={spec.maturity} />
        ) : (
          <TrackedValue field="status" value={spec.status} render={(v) => <StatusPill status={v} reopened={reopened} />} />
        )}
        <TrackedValue field="priority" value={spec.priority} render={(v) => <PriorityPill priority={v} />} />
        {reopened && (
          <Tooltip label={`Was done at ${spec.implementedCommit?.slice(0, 7)}; reopened since`}>
            <span>
              <Pill tone="warn" icon={<IconRotateClockwise2 size={13} />}>
                Reopened
              </Pill>
            </span>
          </Tooltip>
        )}
        {blocking.length > 0 && spec.status !== 'done' && !(spec.maturity && !tracked.commit) && (
          <Tooltip label={`Waiting for: ${blocking.map((d) => byId.get(d)?.title ?? d).join(', ')}`}>
            <span>
              <Pill tone="danger" icon={<IconLock size={13} />}>
                Blocked by {blocking.length}
              </Pill>
            </span>
          </Tooltip>
        )}
        {(spec.drift ?? []).length > 0 && !(spec.maturity && !tracked.commit) && (
          <Tooltip label={<div>{spec.drift!.map((d) => <div key={d}>{d}</div>)}</div>} multiline maw={360}>
            <span>
              <Pill tone="warn" icon={<IconAlertTriangle size={13} />}>
                Drifted
              </Pill>
            </span>
          </Tooltip>
        )}
        {(spec.brokenSections ?? []).length > 0 && (
          <Tooltip label={`Depends on archived or missing sections: ${spec.brokenSections!.join(', ')}`}>
            <span>
              <Pill tone="danger" icon={<IconUnlink size={13} />}>
                Broken dependency
              </Pill>
            </span>
          </Tooltip>
        )}
      </div>
      {spec.lastAudit !== undefined && <LastAuditLine last={spec.lastAudit} />}
    </>
  );

  const aside = (
    <>

      <PropGroup title="Properties">
        {spec.maturity && !tracked.commit ? (
          <>
            {/* Maturity is the one state (X1); the author-set status is a secondary detail below it. */}
            <Prop label="Maturity">
              <MaturityBadge m={spec.maturity} size="sm" />
            </Prop>
            <Prop label="Set by author" to={`/specs?status=${spec.status}`}>
              <span className="faint" data-testid="prop-stored-status">
                {SPEC_STATUS_META[spec.status].label}
              </span>
            </Prop>
          </>
        ) : (
          <Prop label="Status" to={`/specs?status=${spec.status}`}>
            <TrackedValue
              field="status"
              value={spec.status}
              render={(v) => (
                <span className="inline-icon">
                  <StatusIcon status={v} reopened={reopened} />
                  {SPEC_STATUS_META[v].label}
                </span>
              )}
            />
          </Prop>
        )}
        <Prop label="Priority" to={`/specs?priority=${spec.priority ?? 'none'}`}>
          <TrackedValue
            field="priority"
            value={spec.priority}
            render={(v) => (
              <span className="inline-icon">
                <PriorityIcon priority={v} />
                {v ? PRIORITY_META[v].label : 'No priority'}
              </span>
            )}
          />
        </Prop>
        <Prop label="Category" to={spec.category ? `/specs?category=${encodeURIComponent(spec.category)}` : undefined}>
          <TrackedValue
            field="category"
            value={spec.category}
            render={(v) =>
              v ? (
                <span className="inline-icon">
                  <IconFolder size={14} className="prop-icon" />
                  {categoryLabel(v)}
                </span>
              ) : (
                <span className="faint">None</span>
              )
            }
          />
        </Prop>
        <Prop label="Repo" to={spec.repo ? `/specs?repo=${encodeURIComponent(spec.repo)}` : undefined}>
          <TrackedValue
            field="repo"
            value={spec.repo}
            render={(v) =>
              v ? (
                <span className="inline-icon">
                  <IconBrandGit size={14} className="prop-icon" />
                  {v}
                </span>
              ) : (
                <span className="faint">None</span>
              )
            }
          />
        </Prop>
        <Prop label="Owner">
          <TrackedValue
            field="owner"
            value={spec.owner}
            render={(v) =>
              v ? (
                <span className="inline-icon">
                  <IconUser size={14} className="prop-icon" />
                  {v}
                </span>
              ) : (
                <span className="faint">None</span>
              )
            }
          />
        </Prop>
        <Prop label="Tags">
          <span className="wrap-row">
            <TrackedList
              field="tags"
              items={spec.tags}
              empty={<span className="faint">None</span>}
              render={(t) => (
                <Link to={`/specs?tag=${encodeURIComponent(t)}`} className="tag-link">
                  <TagPill tag={t} />
                </Link>
              )}
            />
          </span>
        </Prop>
        <Prop label="Created">
          <TimeAgo iso={spec.createdAt} />
        </Prop>
        <Prop label="ID">
          <span className="inline-icon">
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {spec.id}
            </span>
            <CopyButton value={spec.id} timeout={1400}>
              {({ copied, copy }) => (
                <ActionIcon size="sm" onClick={copy} aria-label="Copy id">
                  {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </ActionIcon>
              )}
            </CopyButton>
          </span>
        </Prop>
      </PropGroup>

      <PropGroup title={`Depends on (from sections)${spec.dependsOn?.length ? ` · ${spec.dependsOn.length}` : ''}`}>
        {(spec.dependsOn ?? []).length ? (
          (spec.dependsOn ?? []).map((d) => <SpecLink key={d} id={d} spec={byId.get(d)} />)
        ) : (
          <span className="faint small">No section depends on another spec</span>
        )}
        {(spec.brokenSections ?? []).length > 0 && (
          <Tooltip label="A depends_on target is archived or missing" openDelay={300}>
            <span className="link-badge" data-tone="danger">
              Broken dependency: {spec.brokenSections!.join(', ')}
            </span>
          </Tooltip>
        )}
        {dependents.length > 0 && (
          <>
            <div className="prop-subtitle">Blocks</div>
            {dependents.map((d) => (
              <SpecLink key={d.id} id={d.id} spec={d} />
            ))}
          </>
        )}
      </PropGroup>

      <PropGroup title={`Standards (from sections)${spec.standards?.length ? ` · ${spec.standards.length}` : ''}`}>
        {(spec.standards ?? []).length ? (
          (spec.standards ?? []).map((s) => (
            <div key={s.id} className="usedby-row">
              <StandardChip
                id={s.id}
                title={s.title ?? standardTitles.get(s.id)}
                warning={spec.links?.supersededStandards.includes(s.id) ? 'Parts of this standard are superseded by another standard' : undefined}
              />
              <div className="usedby-sections">
                {s.sections.map((x) => (
                  <a key={`${x.id}-${x.target}`} href={`#section-${x.id}`} className="usedby-section">
                    § {spec.sections.find((y) => y.id === x.id)?.title ?? x.id}
                    {x.target.includes('/sections/') ? ` → ${x.target.split('/').pop()}` : ''}
                  </a>
                ))}
                {s.appliesBy.length > 0 && <span className="faint">applies via {s.appliesBy.join(', ')}</span>}
                {s.exempt && <span className="faint">exempt (approved)</span>}
              </div>
            </div>
          ))
        ) : (
          <span className="faint small">No section follows a standard</span>
        )}
      </PropGroup>

      {spec.implementedCommit && (
        <PropGroup title="Implementation">
          <Prop label="Commit">
            <span className="inline-icon">
              <Tooltip label="Mandate commit of the version last marked done">
                <TrackedValue field="implementedCommit" value={spec.implementedCommit} render={(v) => (v ? <CommitHash sha={v} /> : null)} />
              </Tooltip>
              <CopyButton value={spec.implementedCommit} timeout={1400}>
                {({ copied, copy }) => (
                  <ActionIcon size="sm" onClick={copy} aria-label="Copy commit">
                    {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  </ActionIcon>
                )}
              </CopyButton>
            </span>
          </Prop>
        </PropGroup>
      )}

      {spec.links && spec.links.warnings.length > 0 && (
        <PropGroup title="Warnings">
          {spec.links.warnings.map((w) => (
            <div key={w} className="panel-warning">
              <IconAlertTriangle size={13} /> {w}
            </div>
          ))}
        </PropGroup>
      )}

      <VerificationPanel v={verification} specId={spec.id} />

      <PropGroup title={`Requests${feedback.data ? ` · ${feedback.data.items.filter((f) => f.status === 'open').length} open` : ''}`}>
        <FeedbackList items={feedback.data?.items ?? []} />
      </PropGroup>
      <QuestionsPanel refUri={buildRef({ kind: 'specs', id: spec.id })} />

      {specWorkOrders.length > 0 && (
        <PropGroup title="Work orders">
          {specWorkOrders.map((q) => (
            <Link key={q.id} to={`/work-orders/${q.id}`} className="linked-item">
              <WorkOrderStatusIcon status={q.status} />
              <KindIcon kind="work_order" />
              <span className="linked-title">
                {KIND_LABEL[q.kind]} · {q.sections.length} section{q.sections.length === 1 ? '' : 's'}
              </span>
              <span className="linked-meta mono">{q.id}</span>
            </Link>
          ))}
        </PropGroup>
      )}

    </>
  );

  return (
    <>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'specs', id: spec.id, title: spec.title }}
        attribution={spec}
        header={header}
        sections={spec.sections}
        standardTitles={standardTitles}
        topPanels={
          (spec.claims ?? []).length > 0 || (spec.drift ?? []).length > 0 ? (
            <>
              {(spec.drift ?? []).length > 0 &&
                (spec.driftDetail ? (
                  <DriftPanel d={spec.driftDetail} />
                ) : (
                  <PropGroup title="Drifted since done">
                    <div className="drift-list">
                      {spec.drift!.map((d) => (
                        <div key={d} className="small">
                          {d}
                        </div>
                      ))}
                    </div>
                  </PropGroup>
                ))}
              {(spec.claims ?? []).length > 0 && (
                <PropGroup title={`In progress · ${spec.claims!.length} work order${spec.claims!.length > 1 ? 's' : ''}`}>
                  <div className="wo-active-list">
                    {spec.claims!.map((c) => {
                      const stale = isStale(c.claim, now);
                      const titles = c.sections.map((sid) => spec.sections.find((x) => x.id === sid)?.title ?? sid);
                      return (
                        <Tooltip
                          key={c.workOrder}
                          multiline
                          maw={320}
                          label={
                            <div>
                              <div>{c.claim.agent} · {stale ? 'stale' : 'live'} · heartbeat {relativeTime(c.claim.heartbeatAt, now)}</div>
                              {c.claim.worktree && <div className="mono">{c.claim.worktree}</div>}
                              <div>Sections: {titles.join(', ')}</div>
                            </div>
                          }
                        >
                          <Link to={`/work-orders/${c.workOrder}`} className="wo-active" data-stale={stale || undefined}>
                            <ClaimAvatar claim={c.claim} now={now} workOrder={c.workOrder} />
                            <span className="mono wo-active-id">{c.workOrder}</span>
                            <span className="wo-active-kind">{c.kind}</span>
                            {c.claim.branch && (
                              <span className="wo-active-branch mono">
                                <IconGitBranch size={12} />
                                {c.claim.branch}
                              </span>
                            )}
                            <span className="wo-active-sections">{titles.length === 1 ? titles[0] : `${titles.length} sections`}</span>
                          </Link>
                        </Tooltip>
                      );
                    })}
                  </div>
                </PropGroup>
              )}
            </>
          ) : undefined
        }
        history={{ entries: history.data, loading: history.isPending, now }}
        tracked={tracked}
        panels={aside}
        criteria={criteria}
        links={spec.links}
        headCommit={spec.lastCommit}
        footer={<AuditsPanel audits={spec.audits} />}
        sectionBadge={(section) => (
          <>
            <FeedbackBadge data={feedback.data} sectionId={section.id} />
            <ImplementationBadge
              state={implementation.data?.[section.id]}
              by={section.implementedBy}
              spec={id}
              openItems={openItems.filter((q) => q.sections.some((x) => x.id === section.id))}
            />
          </>
        )}
        quotes={(feedback.data?.items ?? [])
          .filter((f) => f.status === 'open' && f.quote)
          .flatMap((f) => f.sections.map((sid) => ({ id: f.id, sectionId: sid, quote: f.quote! })))}
        onQuoteClick={(fid) => navigate(`/requests/${fid}`)}
      />
    </>
  );
}
