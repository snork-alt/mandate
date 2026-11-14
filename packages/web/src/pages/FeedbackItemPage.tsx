import { buildRef } from '@mandate/shared/refs';
import { DecisionDialogs, ItemMenu, feedbackActions } from '../components/decisions/DecisionActions';
import { decisionPrompt } from '../lib/prompts';
import { useMemo } from 'react';
import { Skeleton, Text } from '@mantine/core';
import { IconFileOff, IconGitCommit } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { Attribution, FeedbackChange, ResolvedFeedbackTarget, Section } from '@mandate/shared';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { parseRef, refLabel } from '@mandate/shared/refs';
import { DocPage, Pill, SectionBlock } from '../components/doc';
import { TrackedSection } from '../components/doc/tracked';
import { ActionBadge, FeedbackKindIcon, FeedbackStatus, TargetChip } from '../components/FeedbackParts';
import { CommitHash } from '../components/copy';
import { Alert } from '@mantine/core';
import { IconAlertTriangle, IconLock } from '@tabler/icons-react';
import { EmptyView, ErrorState } from '../components/ListStates';
import { Markdown } from '../components/Markdown';
import { Prop, PropGroup } from '../components/PropertyList';
import { QuestionsPanel } from '../components/questions/QuestionsPanel';
import { TimeAgo } from '../components/TimeAgo';
import { TopBar } from '../components/TopBar';
import { FEEDBACK_KIND_META, firstLine } from '../lib/feedback';
import { useStandards } from '../lib/queries';
import { sectionTarget } from '../lib/refs';
import { refHref } from '../components/refs/kinds';
import { useNow, shortSubject } from '../lib/specs';

/** A target section rendered inline (current content; the quote is highlighted by DocPage). */
function TargetBlock({ t, standardTitles }: { t: ResolvedFeedbackTarget; standardTitles: Map<string, string> }) {
  return (
    <div className="fb-target-block">
      <div className="fb-target-head">
        <TargetChip target={t.ref} />
        <span className="faint small">{t.title ?? 'missing document'}</span>
        {t.lines && <span className="mono faint small">L{t.lines.start}{t.lines.end > t.lines.start ? `–${t.lines.end}` : ''}</span>}
      </div>
      {t.kind === 'verifications' ? (
        <Text size="sm" c="var(--app-text-muted)">
          {t.verification
            ? `Verification ${t.verification.result} of ${refLabel(t.verification.criterion)} by ${t.verification.by} (${t.verification.method}, code ${t.verification.code.repo}@${String(t.verification.code.commit).slice(0, 7)})`
            : 'This verification result does not exist.'}
        </Text>
      ) : t.kind === 'audits' || t.kind === 'findings' ? (
        <Text size="sm" c="var(--app-text-muted)">
          {t.title ? `Audit ${t.kind === 'findings' ? 'finding' : 'item'}: ${t.title}` : 'This audit item or finding does not exist.'}
        </Text>
      ) : t.section ? (
        <SectionBlock section={t.section} standardTitles={standardTitles} target={sectionTarget(t.kind, t.id, t.section, t.at)} />
      ) : (
        <Text size="sm" c="var(--app-text-muted)">
          {t.sectionId ? `Section "${t.sectionId}" no longer exists.` : 'Applies to the whole document.'}
        </Text>
      )}
    </div>
  );
}

/** Documents changed by commits carrying this item's `Feedback:` trailer. */
function ResultingChanges({ changes }: { changes: FeedbackChange[] }) {
  return (
    <div className="fb-changes">
      {changes.map((c, i) => {
        const at = c.action === 'deleted' ? c.lastVersion : c.commit;
        const href = at ? `/${c.kind}/${c.id}?version=${at}&compare=prev` : `/${c.kind}/${c.id}`;
        return (
          <div key={`${c.commit}-${c.uri}-${i}`} className="fb-change">
            <div className="fb-change-head">
              <ActionBadge action={c.action} />
              <Link to={href} className="fb-change-doc">
                {c.docTitle ?? c.id}
              </Link>
              <span className="mono faint small">{refLabel(c.uri)}</span>
              {c.from && <span className="faint small">from {refLabel(c.from)}</span>}
              <span className="fb-change-commit">
                <IconGitCommit size={12} />
                <CommitHash sha={c.commit} /> · {shortSubject(c.subject)}
              </span>
            </div>
            {c.sections.length > 0 && (
              <div className="fb-change-sections">
                {c.sections.map((s) => (
                  <Link key={s.id} to={`${href}#section-${s.id}`} className="fb-change-section" data-action={s.action}>
                    {s.action === 'added' ? '+' : s.action === 'removed' ? '−' : '~'} {s.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FeedbackItemPage() {
  const { id = '' } = useParams<{ id: string }>();
  const now = useNow();
  const navigate = useNavigate();
  const resolved = useQuery({ queryKey: ['feedback', id], queryFn: () => api.feedbackItem(id) });
  const history = useQuery({ queryKey: ['feedback', id, 'history'], queryFn: () => api.feedbackHistory(id) });
  const standards = useStandards();
  const standardTitles = useMemo(() => new Map((standards.data ?? []).map((s) => [s.id, s.title])), [standards.data]);
  const crumbs = [{ label: 'Feedbacks', to: '/feedback' }, { label: <span className="mono">{id}</span>, kind: 'feedback' as const }];
  const r = resolved.data;
  const sections = useMemo(() => (r?.targets ?? []).map((t) => t.section).filter((s): s is Section => !!s), [r]);

  if (resolved.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="doc-main" style={{ margin: '0 auto' }}>
          <Skeleton height={30} width="60%" mb="md" />
          <Skeleton height={160} />
        </div>
      </>
    );
  }
  if (resolved.isError || !r) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        {/not found/i.test(resolved.error?.message ?? '') ? (
          <EmptyView icon={<IconFileOff size={22} stroke={1.5} />} title="Feedback not found" description={`There is no feedback "${id}".`} />
        ) : (
          <ErrorState error={resolved.error ?? new Error('Unknown error')} onRetry={() => void resolved.refetch()} />
        )}
      </>
    );
  }

  const { feedback: f } = r;
  const header = (
    <>
      <div className="doc-kicker inline-icon">
        <FeedbackKindIcon kind={f.kind} size={14} /> {FEEDBACK_KIND_META[f.kind].label} · <span className="mono">{f.id}</span>
      </div>
      <h1 className="doc-title">{firstLine(f.body)}</h1>
      <div className="doc-pills">
        <Pill>
          <FeedbackStatus status={f.status} resolution={f.resolution} />
        </Pill>
        {f.targets.map((t) => (
          <TargetChip key={t} target={t} />
        ))}
        <span className="doc-updated">
          Filed <TimeAgo iso={f.createdAt} />
        </span>
      </div>
      {f.status !== 'closed' && (
        <div className="fb-decide" data-testid="fb-decide">
          <span className="faint small">{f.status === 'open' ? 'Needs triage:' : 'Accepted; a coding agent acts on it.'}</span>
          <ItemMenu label={f.id} prompt={decisionPrompt({ ref: buildRef({ kind: 'feedback', id: f.id }), question: f.status === 'open' ? `Accept, reject or mark as duplicate: "${firstLine(f.body)}"?` : `Act on accepted feedback ${f.id}: create a work order, or apply it and close it as applied?`, options: [], suggested: undefined })} actions={feedbackActions(buildRef({ kind: 'feedback', id: f.id }), f.id, { status: f.status === 'open' ? 'open' : 'accepted' })} />
        </div>
      )}
    </>
  );

  const content = (
    <div className="fb-content">
      {f.validationIssues && (
        <Alert color="yellow" variant="light" radius="md" mb="sm" icon={<IconAlertTriangle size={16} />} title="This record no longer passes validation">
          {f.validationIssues.join('; ')}
        </Alert>
      )}
      {f.targets.some((t) => !parseRef(t)?.sectionId) && (
        <Alert color="gray" variant="light" radius="md" mb="sm" title="Legacy target">
          This closed item targets a whole document (before feedback had to target sections). Closed items are immutable, so it stays as is.
        </Alert>
      )}
      {f.warnings.map((w) => (
        <Alert key={w} color="yellow" variant="light" radius="md" mb="sm" icon={<IconAlertTriangle size={16} />}>
          {w}
        </Alert>
      ))}
      {f.quote && <blockquote className="fb-quote">{f.quote}</blockquote>}
      <Markdown>{f.body}</Markdown>
      {f.status === 'closed' && (
        <div className="fb-resolution" data-resolution={f.resolution}>
          <div className="prop-group-title">Resolution · {f.resolution}</div>
          {f.resolution === 'duplicate' && f.duplicateOf && (
            <div>
              Duplicate of <Link to={`/feedback/${f.duplicateOf}`} className="mono">{f.duplicateOf}</Link>
            </div>
          )}
          {f.resolutionNote && <div>{f.resolutionNote}</div>}
          {f.resolution === 'applied' && (
            <div className="faint">{f.changes.length ? `Applied in ${f.changes.length} document change${f.changes.length === 1 ? '' : 's'}, listed below.` : 'No linked commits.'}</div>
          )}
        </div>
      )}
      {f.relatedTo.length > 0 && (
        <div className="fb-related">
          Related:{' '}
          {f.relatedTo.map((x) => (
            <Link key={x} to={parseRef(x) ? (refHref(x) ?? '#') : `/feedback/${x}`} className="mono">
              {parseRef(x)?.id ?? x}
            </Link>
          ))}
        </div>
      )}
      {f.changes.length > 0 && (
        <>
          <h2 className="fb-h2">Resulting changes · {f.changes.length}</h2>
          <ResultingChanges changes={f.changes} />
        </>
      )}
      <h2 className="fb-h2">Targets</h2>
      {r.targets.map((t) => (
        <TargetBlock key={t.ref} t={t} standardTitles={standardTitles} />
      ))}
    </div>
  );

  const panels = (
    <>
      <QuestionsPanel refUri={buildRef({ kind: 'feedback', id: f.id })} />
      <PropGroup title="Properties">
        <Prop label="Status" to={`/feedback?status=${f.status}`}>
          <FeedbackStatus status={f.status} resolution={f.resolution} />
        </Prop>
        {f.status === 'closed' && (
          <Prop label="Locked">
            <span className="inline-icon faint">
              <IconLock size={13} /> Closed · immutable
            </span>
          </Prop>
        )}
        {f.closedAt && (
          <Prop label="Closed">
            <TimeAgo iso={f.closedAt} />
          </Prop>
        )}
        <Prop label="Kind" to={`/feedback?kind=${f.kind}`}>
          <span className="inline-icon">
            <FeedbackKindIcon kind={f.kind} size={14} />
            {FEEDBACK_KIND_META[f.kind].label}
          </span>
        </Prop>
        <Prop label="Created">
          <TimeAgo iso={f.createdAt} />
        </Prop>
        <Prop label="Updated">
          <TimeAgo iso={f.updatedAt} />
        </Prop>
      </PropGroup>
    </>
  );

  return (
    <DecisionDialogs>
      <TopBar crumbs={crumbs} />
      <DocPage
        doc={{ kind: 'feedback' as never, id: f.id, title: firstLine(f.body) }}
        attribution={feedbackAttribution(f, history.data)}
        header={header}
        sections={sections}
        content={content}
        quotes={f.quote ? r.targets.filter((t) => t.sectionId).map((t) => ({ id: f.id, sectionId: t.sectionId!, quote: f.quote! })) : []}
        onQuoteClick={() => navigate(`/feedback/${f.id}`)}
        history={{ entries: history.data, loading: history.isPending, now }}
        panels={panels}
      />
    </DecisionDialogs>
  );
}

/**
 * Who filed and last changed a feedback item: `createdBy` is the coding agent, `createdByUser` the user (server-set); the last edit comes from the newest history entry (its user / agent trailers).
 */
export function feedbackAttribution(
  f: { createdAt: string; createdBy?: string; createdByUser?: string },
  history?: { date: string; commit: string; agent?: string; author: string; user?: string }[],
): { createdAt: string; createdBy?: Attribution; lastEditedBy?: Attribution } {
  const last = history?.[0];
  return {
    createdAt: f.createdAt,
    ...(f.createdBy || f.createdByUser ? { createdBy: { ...(f.createdByUser ? { user: f.createdByUser } : {}), ...(f.createdBy ? { agent: f.createdBy } : {}), at: f.createdAt } } : {}),
    ...(last && (history?.length ?? 0) > 1 ? { lastEditedBy: { ...(last.user ? { user: last.user } : {}), agent: last.agent ?? last.author, at: last.date, commit: last.commit } } : {}),
  };
}
