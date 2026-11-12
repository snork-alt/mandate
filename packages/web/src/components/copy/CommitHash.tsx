import { Tooltip } from '@mantine/core';
import { copyText } from '../../lib/copy';
import { commitTarget } from '../../lib/refs';
import { ChipCopy } from './ChipCopy';

/** A short commit hash; click copies its commit reference, right-click offers the raw hash. */
export function CommitHash({ sha, className }: { sha: string; className?: string }) {
  const target = commitTarget(sha);
  return (
    <ChipCopy target={target}>
      <Tooltip label={`Copy reference ${target.ref} (right-click for more)`} openDelay={400}>
        <button
          type="button"
          className={`commit-hash mono ${className ?? ''}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copyText(target.ref);
          }}
        >
          {sha.slice(0, 7)}
        </button>
      </Tooltip>
    </ChipCopy>
  );
}
