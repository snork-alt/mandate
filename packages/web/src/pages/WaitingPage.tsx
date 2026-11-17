/**
 * Waiting for you: the unanswered questions of the coding agents, grouped by the request they belong to, each with what
 * it blocks and the inline answer card. Answering releases what it blocks (the agent resumes with `/mandate resume`).
 */
import { useMemo } from 'react';
import { Skeleton, Text } from '@mantine/core';
import { IconMessageQuestion } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Question } from '@mandate/shared';
import { TopBar } from '../components/TopBar';
import { EmptyView, ErrorState } from '../components/ListStates';
import { AnswerAllRecommended, NO_ACCESS, QuestionCard } from '../components/questions/QuestionCard';
import { BlockChips } from '../components/questions/BlockChips';
import { useDecisionAccess } from '../lib/decisions';
import { useFeedback } from '../lib/queries';
import { useOpenQuestions } from '../lib/questions';
import { firstLine } from '../lib/feedback';
import '../components/questions/questions.css';
import '../components/overview/overview.css';

const NONE = '~none';

/** Open questions grouped by request (those without one last); blocking ones first, newest first inside a group. */
export function groupByRequest(questions: Question[]): { request: string; items: Question[] }[] {
  const m = new Map<string, Question[]>();
  for (const q of questions) if (q.status === 'open') m.set(q.request ?? NONE, [...(m.get(q.request ?? NONE) ?? []), q]);
  const order = (a: Question, b: Question) => Number((b.blocks?.length ?? 0) > 0) - Number((a.blocks?.length ?? 0) > 0) || b.createdAt.localeCompare(a.createdAt);
  return [...m.entries()]
    .map(([request, items]) => ({ request, items: items.sort(order) }))
    .sort((a, b) => Number(a.request === NONE) - Number(b.request === NONE) || a.request.localeCompare(b.request));
}

export function WaitingPage() {
  const open = useOpenQuestions();
  const requests = useFeedback();
  const access = useDecisionAccess();
  const canAnswer = access.data?.canDecide ?? false;
  const reason = access.isPending ? 'Checking access…' : NO_ACCESS;
  const crumbs = [{ label: 'Waiting for you' }];
  const groups = useMemo(() => groupByRequest(open.data?.items ?? []), [open.data]);
  const bodyOf = useMemo(() => new Map((requests.data ?? []).map((f) => [f.id, f.body])), [requests.data]);

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
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <TopBar crumbs={crumbs}>
        {total > 0 && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {total} question{total === 1 ? '' : 's'}
          </Text>
        )}
        <Link to="/waiting/history" className="q-link" data-testid="waiting-history">
          All questions
        </Link>
      </TopBar>
      <div className="ov-page" data-testid="waiting">
        <header className="ov-header act-header">
          <h1 className="ov-title">Waiting for you</h1>
          <span className="ov-sub">Questions from coding agents, by request. Answer here: what they block is released and the agent carries on.</span>
        </header>
        {!total && <EmptyView icon={<IconMessageQuestion size={22} />} title="Nothing is waiting for you" description="When an agent needs a decision it cannot make itself, the question appears here." />}
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
      </div>
    </>
  );
}
