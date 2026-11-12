import { useState } from 'react';
import { ActionIcon, Popover, Tooltip } from '@mantine/core';
import { IconGitMerge, IconMapPin } from '@tabler/icons-react';
import { LineagePanel } from './LineagePanel';
import { WhereUsedPanel } from './WhereUsedPanel';

/** Small header affordance (sections, rules): opens the lineage of that element in a popover (fetched on open). */
export function LineageButton({ refUri, label = 'section' }: { refUri: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" width={340} shadow="md" withinPortal>
      <Popover.Target>
        <Tooltip label={`Lineage of this ${label}`} openDelay={400} disabled={open}>
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label={`Lineage of this ${label}`} onClick={(e) => (e.preventDefault(), e.stopPropagation(), setOpen((o) => !o))}>
            <IconGitMerge size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>{open && <LineagePanel refUri={refUri} />}</Popover.Dropdown>
    </Popover>
  );
}

/** Rule header affordance: "Where it's used" of one rule section, in a popover. */
export function WhereUsedButton({ refUri }: { refUri: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" width={380} shadow="md" withinPortal>
      <Popover.Target>
        <Tooltip label="Where this rule is used in code" openDelay={400} disabled={open}>
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Where this rule is used" onClick={(e) => (e.preventDefault(), e.stopPropagation(), setOpen((o) => !o))}>
            <IconMapPin size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>{open && <WhereUsedPanel refUri={refUri} compact />}</Popover.Dropdown>
    </Popover>
  );
}
