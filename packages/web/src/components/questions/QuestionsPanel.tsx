/** Questions coding agents asked about an element (spec / standard / work order page): compact, open ones first. */
import { Link } from 'react-router';
import { PropGroup } from '../PropertyList';
import { useQuestions } from '../../lib/questions';
import { QuestionSummary } from './QuestionCard';
import './questions.css';

export function QuestionsPanel({ refUri }: { refUri: string }) {
  const q = useQuestions(refUri, 'all', 10);
  const items = [...(q.data?.items ?? [])].filter((x) => x.status !== 'superseded').sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
  // Nothing asked yet (or an older server without questions): no panel at all.
  if (!items.length) return null;
  const open = items.filter((x) => x.status === 'open').length;
  return (
    <PropGroup title={`Questions${open ? ` · ${open} open` : ` · ${items.length}`}`}>
      <ul className="q-list" data-testid="questions-panel">
        {items.slice(0, 5).map((x) => (
          <QuestionSummary
            key={x.id}
            q={x}
            footer={
              x.status === 'open' ? (
                <Link to={`/questions/${x.id}`} className="q-link">
                  Answer
                </Link>
              ) : undefined
            }
          />
        ))}
      </ul>
      {(q.data?.total ?? 0) > 5 && <div className="ov-muted">+{(q.data?.total ?? 0) - 5} more</div>}
    </PropGroup>
  );
}
