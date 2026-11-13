/** "Ask about this": adds the question as a context chip in the Ask pane and opens the pane (inside the app shell only). */
import type { Question } from '@mandate/shared';
import { useAskOptional } from '../ask/AskProvider';
import { useRailOptional } from '../rail/RailProvider';
import './questions.css';

export function AskAboutQuestion({ q }: { q: Pick<Question, 'id' | 'uri'> }) {
  const ask = useAskOptional();
  const rail = useRailOptional();
  if (!ask || !rail) return null;
  return (
    <button
      type="button"
      className="q-link q-ask"
      data-testid="q-ask-about"
      onClick={() => {
        ask.addChip({ uri: q.uri, kind: 'question', label: q.id });
        rail.selectTab('ask');
      }}
    >
      Ask about this
    </button>
  );
}
