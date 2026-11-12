/** The "Questions from agents" group of the Overview's decisions card: one answer card per open question. */
import type { Decision, Question } from '@mandate/shared';
import { useDecisionAccess } from '../../lib/decisions';
import { Capped } from '../overview/parts';
import { AnswerAllRecommended, NO_ACCESS, QuestionCard } from './QuestionCard';
import './questions.css';

export function QuestionGroup({ items, title }: { items: Decision[]; title: string }) {
  const access = useDecisionAccess();
  const canAnswer = access.data?.canDecide ?? false;
  const reason = access.isPending ? 'Checking access…' : NO_ACCESS;
  const questions = items.map((d) => d.ask).filter((q): q is Question => !!q && q.status === 'open');
  return (
    <div className="ov-group q-group" data-testid="decisions-question">
      <div className="ov-group-title">
        {title}
        <span className="q-group-action">
          <AnswerAllRecommended questions={questions} canAnswer={canAnswer} reason={reason} />
        </span>
      </div>
      <Capped items={questions} cap={6} className="q-cards" render={(q) => <QuestionCard key={q.id} q={q} canAnswer={canAnswer} reason={reason} />} />
    </div>
  );
}
