import { Tooltip } from '@mantine/core';
import { IconEye, IconPencil } from '@tabler/icons-react';
import { accessLabel, type ProjectSummary } from './projects';

/** Project access from GitHub repo permissions (server mode): read → read tools only; push → agents may write. */
export function AccessBadge({ access, compact, noTip }: { access: ProjectSummary['access']; compact?: boolean; noTip?: boolean }) {
  const label = accessLabel(access);
  if (!label) return null;
  const tip = access === 'read' ? 'You can read this repository on GitHub: you and your agents can read, not write.' : 'You can push to this repository on GitHub: your agents can write specs and work orders.';
  return (
    <Tooltip label={tip} multiline w={260} withinPortal disabled={noTip}>
      <span className="access-badge" data-access={access} data-compact={compact || undefined} data-testid={`access-${access}`}>
        {access === 'read' ? <IconEye size={11} /> : <IconPencil size={11} />}
        {!compact && label}
      </span>
    </Tooltip>
  );
}
