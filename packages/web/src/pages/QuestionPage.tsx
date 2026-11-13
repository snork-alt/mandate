/** One question a coding agent asked through Mandate: the answer card while open, else what was answered. */
import { Skeleton } from '@mantine/core';
import { useParams } from 'react-router';
import { TopBar } from '../components/TopBar';
import { CopyMenu } from '../components/copy';
import { questionTarget } from '../lib/refs';
import { NO_ACCESS, QuestionCard, QuestionSummary } from '../components/questions/QuestionCard';
import { useDecisionAccess } from '../lib/decisions';
import { useQuestion } from '../lib/questions';
import '../components/questions/questions.css';

export function QuestionPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useQuestion(id);
  const access = useDecisionAccess().data;
  const question = q.data?.question;
  return (
    <>
      <TopBar crumbs={[{ label: 'Questions', to: '/questions' }, { label: id }]}>
        <CopyMenu target={questionTarget(id)} visible />
      </TopBar>
      <div className="ov-page" style={{ maxWidth: 720 }}>
        {q.isPending ? (
          <Skeleton height={200} radius="md" />
        ) : q.error || !question ? (
          <div className="ov-muted">{(q.error as Error | null)?.message ?? 'Question not found.'}</div>
        ) : (
          <ul className="q-cards" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
            {question.status === 'open' ? <QuestionCard q={question} canAnswer={access?.canDecide ?? false} reason={access ? NO_ACCESS : 'Checking access…'} /> : <QuestionSummary q={question} />}
          </ul>
        )}
      </div>
    </>
  );
}
