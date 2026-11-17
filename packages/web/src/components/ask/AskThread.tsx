import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Typography } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconLoader2, IconPlayerStop } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import { markdownComponents } from '../Markdown';
import { RefChip } from '../refs';
import type { AskTurn } from './AskProvider';

const isRefHref = (h?: string) => !!h && /^(@mandate:)?mandate:\/\//.test(h);
const text = (children: ReactNode): string | undefined => (typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : undefined);

const answerComponents: Components = {
  ...markdownComponents,
  a: ({ href, children, node: _n, ...rest }) =>
    isRefHref(href) ? (
      <RefChip to={href!} label={text(children)} />
    ) : (
      <a href={href} {...rest} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

/** Markdown where reference links become reference chips (links keep their text as label). */
export function AnswerMarkdown({ children }: { children: string }) {
  return (
    <Typography className="markdown ask-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={answerComponents} urlTransform={(u) => u}>
        {children}
      </ReactMarkdown>
    </Typography>
  );
}


/** One question of the panel: the question, who answers, the answer so far (it grows while the agent sends parts). */
export function AskTurnView({ turn, onCancel }: { turn: AskTurn; onCancel?: () => void }) {
  const waiting = turn.status === 'waiting';
  const who = turn.agent ?? (turn.to === 'any' ? 'any agent' : null);
  return (
    <div className="ask-turn" data-status={turn.status} data-testid="ask-turn">
      <div className="ask-q">{turn.question}</div>
      {turn.answer && (
        <div className="ask-answer" data-streaming={turn.status === 'answering' || undefined} data-testid="ask-answer">
          <AnswerMarkdown>{turn.answer}</AnswerMarkdown>
          {turn.status === 'done' && (
            <div className="ask-answer-actions">
              <button type="button" onClick={() => void copyText(turn.answer, 'Copied answer')}>
                <IconCopy size={12} /> Copy answer
              </button>
              {who && <span className="rail-faint" data-testid="answered-by">answered by {who}</span>}
            </div>
          )}
        </div>
      )}
      {waiting && (
        <div className="rail-faint ask-thinking" role="status" data-testid="ask-waiting">
          <IconLoader2 size={13} className="ask-spin" /> {who ? `Waiting for ${who}…` : 'Waiting for an agent to connect…'}
          {onCancel && (
            <button type="button" className="ask-add" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
      {turn.status === 'answering' && (
        <div className="rail-faint ask-thinking" role="status" data-testid="ask-progress">
          <IconLoader2 size={13} className="ask-spin" /> {who ?? 'The agent'} is answering…
        </div>
      )}
      {turn.status === 'cancelled' && (
        <div className="rail-faint">
          <IconPlayerStop size={12} /> Cancelled
        </div>
      )}
      {turn.error && (
        <div className="ask-error" role="alert">
          <IconAlertTriangle size={13} /> {turn.error}
        </div>
      )}
    </div>
  );
}
