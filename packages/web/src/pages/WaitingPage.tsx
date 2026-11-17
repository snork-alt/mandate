/**
 * Waiting for you, one page, two parts.
 * 1. "Only you can do this" (the sidebar badge counts exactly this): questions from agents grouped by request with what
 *    each blocks and the inline answer card, approvals (pending waivers, standard drafts), plans to approve (plan-only
 *    requests) and comments addressed to you. Answering releases what it blocks (the agent resumes with `/mandate resume`).
 * 2. "Project health" (collapsed, not counted): drifted specs, stale claims, integrity errors, contradicted audits, open
 *    must findings, blocked items and specs needing attention (the former Actions page tabs; `?tab=` / `?focus=` open it).
 */
import { useMemo, useState } from 'react';
import { Skeleton, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconMessageQuestion } from '@tabler/icons-react';
import { Link, useSearchParams } from 'react-router';
import type { CommentThread, Question } from '@mandate/shared';
import { refLabel } from '@mandate/shared/refs';
import { TopBar } from '../components/TopBar';
import { EmptyView, ErrorState } from '../components/ListStates';
import { AnswerAllRecommended, NO_ACCESS, QuestionCard } from '../components/questions/QuestionCard';
import { BlockChips } from '../components/questions/BlockChips';
import { CopyPromptButton, DecisionDialogs } from '../components/decisions/DecisionActions';
import { ACTION_TABS, ActionTabs, DecisionTab, type ActionTabKey } from '../components/overview/ActionTab';
import { PlanReady } from '../components/requests/RequestProgress';
import { refHref } from '../components/refs/kinds';
import { TimeAgo } from '../components/TimeAgo';
import { getCurrentProject } from '../project';
import { decisionsPrompt } from '../lib/prompts';
import { attentionCount, findingsCount, useOverview } from '../lib/overview';
import { useCommentsForMe, usePlansToApprove, useWaitingCounts } from '../lib/waiting';
import { useDecisionAccess, useDecisions } from '../lib/decisions';
import { useFeedback } from '../lib/queries';
import { useOpenQuestions } from '../lib/questions';
import { firstLine } from '../lib/feedback';
import '../components/questions/questions.css';
import '../components/overview/overview.css';

const NONE = '~none';

/** The Actions tabs that are project health (not counted, collapsed by default). */
export const HEALTH_TABS: ActionTabKey[] = ['blocked', 'findings', 'drift', 'outdated', 'claims', 'audits', 'integrity', 'attention'];

/** Open questions grouped by request (those without one last); blocking ones first, newest first inside a group. */
export function groupByRequest(questions: Question[]): { request: string; items: Question[] }[] {
  const m = new Map<string, Question[]>();
  for (const q of questions) if (q.status === 'open') m.set(q.request ?? NONE, [...(m.get(q.request ?? NONE) ?? []), q]);
  const order = (a: Question, b: Question) => Number((b.blocks?.length ?? 0) > 0) - Number((a.blocks?.length ?? 0) > 0) || b.createdAt.localeCompare(a.createdAt);
  return [...m.entries()]
    .map(([request, items]) => ({ request, items: items.sort(order) }))
    .sort((a, b) => Number(a.request === NONE) - Number(b.request === NONE) || a.request.localeCompare(b.request));
}

/** Comment threads addressed to the user, each linking to the object it is on. */
function CommentsForMe({ threads }: { threads: CommentThread[] }) {
  return (
    <section className="w-group" data-testid="waiting-comments">
      <div className="w-group-head">
        <span className="w-group-title">Comments addressed to you</span>
        <span className="w-group-count">{threads.length} open</span>
      </div>
      <ul className="q-cards">
        {threads.map((t) => (
          <li key={t.id} data-testid="waiting-comment">
            <div className="small faint">
              {t.author.user ?? t.author.agent} on {refHref(t.target) ? <Link to={refHref(t.target)!} className="plain-link">{refLabel(t.target)}</Link> : t.target} · <TimeAgo iso={t.createdAt} />
              {t.blocking ? ' · blocking' : ''}
            </div>
            <div>{firstLine(t.body)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WaitingPage() {
  const open = useOpenQuestions();
  const requests = useFeedback();
  const access = useDecisionAccess();
  const decisions = useDecisions(50);
  const overview = useOverview();
  const plans = usePlansToApprove();
  const comments = useCommentsForMe();
  const counts = useWaitingCounts();
  const [params] = useSearchParams();
  const canAnswer = access.data?.canDecide ?? false;
  const reason = access.isPending ? 'Checking access…' : NO_ACCESS;
  const crumbs = [{ label: 'Waiting for you' }];
  const groups = useMemo(() => groupByRequest(open.data?.items ?? []), [open.data]);
  const bodyOf = useMemo(() => new Map((requests.data ?? []).map((f) => [f.id, f.body])), [requests.data]);
  // Project health opens for a deep link (?tab= / ?focus= of the former Actions page) and stays collapsed otherwise.
  const urlTab = params.get('tab');
  const deepHealth = (!!urlTab && HEALTH_TABS.includes(urlTab as ActionTabKey)) || !!params.get('focus');
  const [healthOpen, setHealthOpen] = useState(deepHealth);
  const projectId = getCurrentProject() ?? '';
  const health = overview.data ? attentionCount(overview.data) + findingsCount(overview.data) + overview.data.blockedTotal + (['drift', 'outdated', 'claims', 'audits', 'integrity'] as const).reduce((n, k) => n + ((decisions.data?.counts as Record<string, number> | undefined)?.[{ drift: 'spec_drifted', outdated: 'section_outdated', claims: 'stale_claim', audits: 'audit_contradicted', integrity: 'integrity_error' }[k]] ?? 0), 0) : null;
  const approvalTabs = ACTION_TABS.filter((t) => t.key === 'waivers' || t.key === 'drafts');

  if (open.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="ov-page">
          <Skeleton height={180} radius="md" />
        </div>
      </>
    );
  }
  if (open.isError) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <ErrorState error={open.error} onRetry={() => void open.refetch()} />
      </>
    );
  }
  const onlyYou = counts.total;
  return (
    <DecisionDialogs>
      <TopBar crumbs={crumbs}>
        {onlyYou > 0 && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {onlyYou} for you
          </Text>
        )}
        {!!decisions.data?.total && <CopyPromptButton prompt={decisionsPrompt(projectId)} label="Resolve with your coding agent" testId="resolve-with-agent" />}
        <Link to="/waiting/history" className="q-link" data-testid="waiting-history">
          All questions
        </Link>
      </TopBar>
      <div className="ov-page" data-testid="waiting">
        <header className="ov-header act-header">
          <h1 className="ov-title">Waiting for you</h1>
          <span className="ov-sub">What only you can do: answer agents, approve, review plans. Answer here: what it blocks is released and the agent carries on.</span>
        </header>
        <h2 className="fb-h2" data-testid="only-you">Only you can do this{onlyYou ? ` · ${onlyYou}` : ''}</h2>
        {!onlyYou && <EmptyView icon={<IconMessageQuestion size={22} />} title="Nothing is waiting for you" description="When an agent needs a decision it cannot make itself, the question appears here."
        />}
        {!!plans.data?.length && (
          <section className="w-group" data-testid="waiting-plans">
            <div className="w-group-head">
              <span className="w-group-title">Plans to approve</span>
              <span className="w-group-count">{plans.data.length}</span>
            </div>
            {plans.data.map((p) => (
              <div key={p.id} data-testid="waiting-plan">
                <Link to={`/requests/${p.id}`} className="q-link"><span className="mono">{p.id}</span> · {p.summary}</Link>
                <PlanReady id={p.id} />
              </div>
            ))}
          </section>
        )}
        {groups.map((g) => (
          <section key={g.request} className="w-group" data-testid="waiting-group" data-request={g.request}>
            <div className="w-group-head">
              {g.request === NONE ? (
                <span className="w-group-title">Not tied to a request</span>
              ) : (
                <Link to={`/requests/${g.request}`} className="w-group-title" data-testid="waiting-request-link">
                  <span className="mono">{g.request}</span>
                  {bodyOf.get(g.request) ? ` · ${firstLine(bodyOf.get(g.request)!)}` : ''}
                </Link>
              )}
              <span className="w-group-count">
                {g.items.length} open
              </span>
              <span className="q-group-action">
                <AnswerAllRecommended questions={g.items} canAnswer={canAnswer} reason={reason} />
              </span>
            </div>
            <ul className="q-cards">
              {g.items.map((q) => (
                <li key={q.id} data-testid="waiting-question">
                  <BlockChips q={q} />
                  <QuestionCard q={q} canAnswer={canAnswer} reason={reason} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {approvalTabs.map((t) => (decisions.data && (decisions.data.counts[t.kinds![0]!] ?? 0) > 0 ? (
          <div key={t.key} data-testid={`apanel-${t.key}`}>
            <DecisionTab t={t} items={decisions.data.items} counts={decisions.data.counts} />
          </div>
        ) : null))}
        {!!comments.data?.length && <CommentsForMe threads={comments.data} />}
        <button type="button" className="w-health-toggle" onClick={() => setHealthOpen((v) => !v)} aria-expanded={healthOpen} data-testid="health-toggle">
          {healthOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />} Project health{health ? ` · ${health}` : ''} <span className="faint small">(not counted)</span>
        </button>
        {healthOpen && (
          <div data-testid="project-health">
            {overview.data && <ActionTabs o={overview.data} q={decisions} projectId={projectId} only={HEALTH_TABS} />}
            {overview.isPending && <Skeleton height={120} radius="md" />}
          </div>
        )}
      </div>
    </DecisionDialogs>
  );
}
