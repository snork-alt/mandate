import { useState, type MouseEvent } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconAt, IconChevronDown, IconCopy, IconLink, IconMarkdown } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import type { CopyTarget } from '../../lib/refs';
import { copyLink, copyMarkdown, copyRef } from './copyTargets';

interface Props {
  target: CopyTarget;
  /** Always visible (default: shown when the parent `.has-copy-ref` is hovered or focused). */
  visible?: boolean;
  size?: 'xs' | 'sm' | 'md';
}

const stop = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/**
 * The one copy menu (`CopyMenu`): the first option and the click default are always the Mandate
 * reference; markdown, link and raw values follow. Copy a reference to an element (an `@mandate:` mention) for pasting into Claude Code.
 * Click copies the reference; the chevron or right-click opens "as markdown" / "link".
 */
export function CopyRef({ target, visible, size = 'sm' }: Props) {
  const [menu, setMenu] = useState(false);
  return (
    <span className="copy-ref" data-visible={visible || menu || undefined} onContextMenu={(e) => (stop(e), setMenu(true))}>
      <Tooltip label={`Copy reference (c)`} openDelay={400}>
        <ActionIcon
          size={size}
          variant="subtle"
          color="gray"
          aria-label={`Copy reference to this ${target.label}`}
          onClick={(e) => {
            stop(e);
            void copyRef(target);
          }}
        >
          <IconAt size={14} />
        </ActionIcon>
      </Tooltip>
      <Menu opened={menu} onChange={setMenu} position="bottom-end" width={220} withinPortal>
        <Menu.Target>
          <ActionIcon
            size={size === 'md' ? 'sm' : 'xs'}
            variant="subtle"
            color="gray"
            aria-label="More copy options"
            onClick={(e) => (stop(e), setMenu((o) => !o))}
          >
            <IconChevronDown size={12} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
          <Menu.Label>Copy {target.label}</Menu.Label>
          <Menu.Item leftSection={<IconAt size={14} />} rightSection={<span className="kbd-hint">C</span>} onClick={() => void copyRef(target)}>
            Copy reference
          </Menu.Item>
          {target.alt && (
            <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(target.alt!.ref)}>
              {target.alt.label}
            </Menu.Item>
          )}
          {target.markdown && (
            <Menu.Item leftSection={<IconMarkdown size={14} />} rightSection={<span className="kbd-hint">⇧C</span>} onClick={() => void copyMarkdown(target)}>
              Copy as markdown
            </Menu.Item>
          )}
          {target.link && (
            <Menu.Item leftSection={<IconLink size={14} />} onClick={() => void copyLink(target)}>
              Copy link
            </Menu.Item>
          )}
          {target.extras?.map((x) => (
            <Menu.Item key={x.label} leftSection={<IconCopy size={14} />} onClick={async () => copyText(await x.value(), 'Copied')}>
              {x.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </span>
  );
}

/** Alias: every copy affordance uses this one component, so the order is enforced in one place. */
export const CopyMenu = CopyRef;
