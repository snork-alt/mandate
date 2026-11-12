import { Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** Warning badge for stored records that no longer pass validation (reads are lenient). */
export function IssuesBadge({ issues }: { issues: string[] }) {
  return (
    <Tooltip label={issues.join('\n')} multiline maw={360} style={{ whiteSpace: 'pre-wrap' }}>
      <span className="issues-badge" aria-label="Validation issues">
        <IconAlertTriangle size={12} /> {issues.length} issue{issues.length === 1 ? '' : 's'}
      </span>
    </Tooltip>
  );
}
