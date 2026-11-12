import { useState, type ReactNode } from 'react';
import { Menu } from '@mantine/core';
import { IconAt, IconCopy } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import type { CopyTarget } from '../../lib/refs';
import { useSectionTarget } from './SectionTargetContext';

/**
 * Right-click menu around a chip. The chip's own click copies its Mandate reference; the menu
 * repeats that first, then raw values, then the enclosing section's reference.
 */
export function ChipCopy({ target, children }: { target: CopyTarget; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const section = useSectionTarget();
  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal width={240}>
      <Menu.Target>
        <span
          style={{ display: 'inline-flex', maxWidth: '100%' }}
          onContextMenu={(e) => {
            e.preventDefault();
            setOpened(true);
          }}
        >
          {children}
        </span>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(target.ref)}>
          Copy reference
        </Menu.Item>
        {target.extras?.map((x) => (
          <Menu.Item key={x.label} leftSection={<IconCopy size={14} />} onClick={async () => copyText(await x.value(), 'Copied')}>
            {x.label}
          </Menu.Item>
        ))}
        {section && (
          <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(section.ref)}>
            Copy section reference
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
