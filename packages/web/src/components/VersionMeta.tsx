import { Tooltip } from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

/** "v7" with a history icon; opens the document in track-changes mode for its latest commit. */
export function VersionMeta({ path, count, lastCommit, lastBy }: { path: string; count: number; lastCommit: string | null; lastBy: string | null }) {
  const navigate = useNavigate();
  return (
    <Tooltip label={`${count} version${count === 1 ? '' : 's'}${lastBy ? ` · last by ${lastBy}` : ''} · show latest changes`}>
      <button
        type="button"
        className="version-meta-btn"
        disabled={!lastCommit}
        aria-label={`${count} versions, show latest changes`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (lastCommit) navigate(`${path}?version=${lastCommit}&compare=prev`);
        }}
      >
        <IconHistory size={13} />
        <span className="mono">v{count}</span>
      </button>
    </Tooltip>
  );
}
