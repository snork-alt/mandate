/** After answering: the line to tell the coding agent to continue (it also gets the answer as news on its next reply). */
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import './questions.css';

/** The ready-made line for the coding agent, for the question ids answered in one action. */
export function continueLine(ids: string[]): string {
  return ids.length === 1
    ? `Your Mandate question ${ids[0]} was answered — read it with question_get and continue.`
    : `Your Mandate questions ${ids.join(', ')} were answered — read them with question_get and continue.`;
}

export function ContinueNotice({ ids }: { ids: string[] }) {
  const line = continueLine(ids);
  return (
    <div className="q-continue" data-testid="q-continue">
      <span className="ov-muted">Tell your coding agent to continue:</span>
      <span className="q-continue-line">
        <code>{line}</code>
        <Tooltip label="Copy" openDelay={300}>
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Copy the line for the coding agent" onClick={() => void copyText(line, 'Copied')} data-testid="q-continue-copy">
            <IconCopy size={13} />
          </ActionIcon>
        </Tooltip>
      </span>
    </div>
  );
}
