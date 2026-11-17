/** What an open question blocks (request, work order, step, section): small chips that link to the item. */
import { Link } from 'react-router';
import type { Question } from '@mandate/shared';
import { blockTarget } from '../../lib/requestLinks';
import './questions.css';

export function BlockChips({ q }: { q: Pick<Question, 'blocks'> }) {
  const blocks = q.blocks ?? [];
  return (
    <div className="q-blocks" data-testid="q-blocks">
      <span className="faint small">{blocks.length ? 'Blocks' : 'Blocks nothing (informational)'}</span>
      {blocks.map((b) => {
        const t = blockTarget(b);
        return t.href ? (
          <Link key={b} to={t.href} className="fb-target q-block-chip" data-kind={t.kind} title={b}>
            {t.kind === 'step' || t.kind === 'section' ? t.label : `${t.kind.replace('-', ' ')} ${t.label}`}
          </Link>
        ) : (
          <span key={b} className="fb-target q-block-chip" title={b}>
            {t.label}
          </span>
        );
      })}
    </div>
  );
}
