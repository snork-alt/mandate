import { useMemo } from 'react';
import { QuestionsPanel } from '../components/questions/QuestionsPanel';
import { Skeleton, Text } from '@mantine/core';
import { IconAlertTriangle, IconFileOff, IconPencil, IconTarget } from '@tabler/icons-react';
import { Alert } from '@mantine/core';
import { Link, useNavigate, useParams } from 'react-router';
import { FeedbackBadge } from '../components/FeedbackBadge';
import { VerificationMatrix } from '../components/VerificationMatrix';
import { AuditsPanel, ComplianceView, LastAuditLine } from '../components/audits/panels';
import { FeedbackList } from '../components/FeedbackParts';
import { DocPage, Pill, TagPill } from '../components/doc';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Prop, PropGroup } from '../components/PropertyList';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { DeviationsPanel, UsedByPanel } from '../components/UsedByPanel';
import { useDocFeedback, useHistory, useStandard, useStandardUsage, useStandards } from '../lib/queries';
import { deletedDoc, useNow, withFrontmatter } from '../lib/specs';
import type { Standard } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { WhereUsedPanel } from '../components/lineage/WhereUsedPanel';
import { TrackedList, TrackedValue, useTrackedChanges } from '../components/doc/tracked';

/** "repo:app" -> link to the spec list filtered by that repo / tag / category. */
function appliesToHref(rule: string): string {
  const [kind, value = ''] = rule.split(':', 2);
  return `/specs?${kind === 'repo' ? 'repo' : kind === 'tag' ? 'tag' : 'category'}=${encodeURIComponent(value)}`;
}

export function StandardDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useStandard(id);
  const usage = useStandardUsage(id);
  const history = useHistory('standards', id);
  const standards = useStandards();
  const now = useNow();
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const crumbs = [{ label: 'Standards', to: '/standards' }, { label: <span className="mono">{id}</span>, kind: 'standard' as const }];
  const tracked = useTrackedChanges('standards', id);
  const feedback = useDocFeedback('standards', id);
  const navigate = useNavigate();
  const after = tracked.commit ? tracked.data?.diff.after : undefined;
  // A deleted document can still be viewed at a past version (?version=...): build it from that version.
  const deletedView = !query.data && query.isError && after ? deletedDoc<Standard>(id, after, tracked.version?.meta.date) : undefined;
  const std = query.data && after ? withFrontmatter(query.data, 'standards', after.frontmatter as Record<string, unknown>) : (query.data ?? deletedView);

  if (query.isPending || (query.isError && tracked.commit && tracked.loading)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="doc-main" style={{ margin: '0 auto' }}>
          <Skeleton height={30} width="50%" mb="md" />
          <Skeleton height={14} width="70%" mb="xl" />
          <Skeleton height={160} />
        </div>
      </>
    );
  }
  if (!std) {
    const notFound = /not found/i.test(query.error?.message ?? '');
    return (
      <>
        <TopBar crumbs={crumbs} />
        {notFound ? (
          <EmptyView
            icon={<IconFileOff size={22} stroke={1.5} />}
            title="Standard not found"
            description={`There is no standard with id "${id}".`}
            action={
              <Text component={Link} to="/standards" size="md" c="var(--mantine-primary-color-filled)">
                Back to standards
              </Text>
            }
          />
        ) : (
          <ErrorState error={query.error ?? new Error('Unknown error')} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  // Prose sections first, then the rules grouped by level (must, should, may).
  const rank = (s: Standard['sections'][number]) => (s.type === 'rule' ? { must: 1, should: 2, may: 3 }[s.level ?? 'should'] : 0);
  const ordered = [...std.sections].sort((a, b) => rank(a) - rank(b));

  const header = (
    <>
      <h1 className="doc-title">
        <TrackedValue field="title" value={std.title} render={(v) => v} />
      </h1>
      {(std.summary || tracked.data) && (
        <p className="doc-summary">
          <TrackedValue field="summary" value={std.summary} render={(v) => v} />
        </p>
      )}
      <div className="doc-pills">
        <StandardStatusPill std={std} />
        <TrackedList
          field="appliesTo"
          items={std.appliesTo}
          render={(rule) => (
            <Link to={appliesToHref(rule)} className="tag-link">
              <Pill icon={<IconTarget size={13} />}>{rule}</Pill>
            </Link>
          )}
        />
      </div>
      {std.lastAudit !== undefined && <LastAuditLine last={std.lastAudit} />}
    </>
  );

  const panels = (
    <>
      <UsedByPanel usage={usage.data} loading={usage.isPending} />
      <PropGroup title="Where it's used">
        <WhereUsedPanel refUri={buildRef({ kind: 'standards', id: std.id })} />
      </PropGroup>
      <DeviationsPanel usage={usage.data} />
      <PropGroup title={`Feedback${feedback.data ? ` · ${feedback.data.items.filter((f) => f.status === 'open').length} open` : ''}`}>
        <FeedbackList items={feedback.data?.items ?? []} />
      </PropGroup>
      <QuestionsPanel refUri={buildRef({ kind: 'standards', id: std.id })} />
      <PropGroup title="Properties">
        <Prop label="Owner">
          <TrackedValue field="owner" value={std.owner} render={(v) => v ?? <span className="faint">None</span>} />
        </Prop>
        <Prop label="Tags">
          <span className="wrap-row">
            <TrackedList field="tags" items={std.tags} empty={<span className="faint">None</span>} render={(t) => <TagPill tag={t} />} />
          </span>
        </Prop>
        <Prop label="Applies to">
          {std.appliesTo.length ? (
            <span className="wrap-row">
              {std.appliesTo.map((r) => (
                <span key={r} className="tag-pill mono">
                  {r}
                </span>
              ))}
            </span>
          ) : (
            <span className="faint">Only where listed</span>
          )}
        </Prop>
        <Prop label="Created">
          <TimeAgo iso={std.createdAt} />
        </Prop>
        <Prop label="ID">
          <span className="mono">{std.id}</span>
        </Prop>
      </PropGroup>
    </>
  );

  return (
    <>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'standards', id: std.id, title: std.title }}
        attribution={std}
        header={header}
        banner={<LifecycleBanner std={std} />}
        sections={tracked.commit ? std.sections : ordered}
        standardTitles={standardTitles}
        history={{ entries: history.data, loading: history.isPending, now }}
        tracked={tracked}
        panels={panels}
        footer={
          <>
            <VerificationMatrix v={std.verification} />
            <AuditsPanel audits={std.audits} kind="standard" />
            <ComplianceView audits={std.audits} />
          </>
        }
        links={std.links}
        headCommit={std.lastCommit}
        sectionBadge={(section) => <FeedbackBadge data={feedback.data} sectionId={section.id} />}
        quotes={(feedback.data?.items ?? [])
          .filter((f) => f.status === 'open' && f.quote)
          .flatMap((f) => f.sections.map((sid) => ({ id: f.id, sectionId: sid, quote: f.quote! })))}
        onQuoteClick={(fid) => navigate(`/feedback/${fid}`)}
      />
    </>
  );
}

/** Lifecycle pill: Draft / Active / Deprecated (+ not in force yet). */
function StandardStatusPill({ std }: { std: Standard }) {
  const status = std.status ?? 'active';
  if (status === 'active' && std.effectiveFrom && Date.parse(std.effectiveFrom) > Date.now()) {
    return <Pill tone="warn">Effective from {std.effectiveFrom.slice(0, 10)}</Pill>;
  }
  return (
    <span className="lifecycle-badge" data-status={status}>
      {status === 'draft' ? 'Draft' : status === 'deprecated' ? 'Deprecated' : 'Active'}
    </span>
  );
}

/** Banner for deprecated (points at the successor) and draft (never applies) standards. */
function LifecycleBanner({ std }: { std: Standard }) {
  if (std.status === 'deprecated') {
    return (
      <Alert color="orange" variant="light" radius="md" mb="md" icon={<IconAlertTriangle size={16} />}>
        This standard is deprecated.{' '}
        {std.supersededBy && (
          <>
            Follow <Link to={`/standards/${std.supersededBy}`}>{std.supersededBy}</Link> instead; specs that still follow this one get a warning.
          </>
        )}
      </Alert>
    );
  }
  if (std.status === 'draft') {
    return (
      <Alert color="gray" variant="light" radius="md" mb="md" icon={<IconPencil size={16} />}>
        Draft: this standard does not apply to any spec until it is activated.
      </Alert>
    );
  }
  return null;
}
