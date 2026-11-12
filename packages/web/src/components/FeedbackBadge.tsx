import { HoverCard } from '@mantine/core';
import { IconMessageReport } from '@tabler/icons-react';
import type { DocFeedback } from '@mandate/shared';
import { FeedbackList } from './FeedbackParts';

/** Section header badge: number of open feedback items, with a hover list. */
export function FeedbackBadge({ data, sectionId }: { data?: DocFeedback; sectionId: string }) {
  const open = data?.openBySection[sectionId] ?? 0;
  if (!open || !data) return null;
  const items = data.items.filter((f) => f.status === 'open' && f.sections.includes(sectionId));
  return (
    <HoverCard width={320} position="bottom-start" shadow="md" openDelay={150} withinPortal>
      <HoverCard.Target>
        <span className="fb-badge" tabIndex={0} aria-label={`${open} open feedback`}>
          <IconMessageReport size={12} />
          {open}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown p={6}>
        <FeedbackList items={items} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
