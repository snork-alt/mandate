import { Tooltip } from '@mantine/core';
import { absoluteTime, relativeTime } from '../lib/time';

export function TimeAgo({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  return (
    <Tooltip label={absoluteTime(iso)}>
      <time dateTime={iso}>
        {prefix}
        {relativeTime(iso)}
      </time>
    </Tooltip>
  );
}
