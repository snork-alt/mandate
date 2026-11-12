import { useCallback, type ReactNode } from 'react';
import { Button, Menu } from '@mantine/core';
import { IconAt, IconExternalLink, IconFocus2, IconLink, IconWindowMaximize } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import { mentionOf, type Attribution, type LineageStatus } from '@mandate/shared';
import { copyText } from '../../lib/copy';
import { STATUS_META } from '../../lib/lineage';
import { appUrl } from '../../project';
import { fallbackLabel, refHref, refKind } from '../refs/kinds';
import { openCommandPalette } from '../CommandPalette';
import { ByLine } from '../attribution/Attribution';
import { RefChip } from '../refs/RefChip';
import { LineageStatusIcon } from './LineagePanel';
import { KindIcon } from './ElementPicker';
import { absoluteTime, relativeTime } from '../../lib/time';
import './lineage.css';

/** Open an element: its page (sections open at their anchor), code in the palette; new tab when asked (or Cmd/Ctrl). */
export function useOpenElement() {
  const navigate = useNavigate();
  return useCallback(
    (uri: string, newTab = false) => {
      const href = refHref(uri);
      if (href) {
        if (newTab) window.open(appUrl(href), '_blank', 'noopener');
        else void navigate(href);
        return;
      }
      const kind = refKind(uri);
      if (kind === 'code_file' || kind === 'code_range') openCommandPalette(`/${fallbackLabel(uri).split(':')[0]}`);
      else if (kind === 'symbol') openCommandPalette(`@${fallbackLabel(uri)}`);
      else void copyText(mentionOf(uri), 'Copied reference');
    },
    [navigate],
  );
}

export interface MenuAt {
  uri: string;
  x: number;
  y: number;
}

/** Right-click menu of an element: Open, Open in new tab, Center here, Copy reference, Copy link. */
export function ElementMenu({ at, onClose, onCenter }: { at: MenuAt | null; onClose: () => void; onCenter?: (uri: string) => void }) {
  const open = useOpenElement();
  const href = at ? refHref(at.uri) : null;
  return (
    <Menu opened={!!at} onChange={(o) => !o && onClose()} position="bottom-start" withinPortal shadow="md" width={210}>
      <Menu.Target>
        <span style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, width: 1, height: 1, pointerEvents: 'none' }} />
      </Menu.Target>
      <Menu.Dropdown data-testid="element-menu">
        {at && (
          <>
            <Menu.Item leftSection={<IconExternalLink size={14} />} onClick={() => open(at.uri)}>
              Open
            </Menu.Item>
            {href && (
              <Menu.Item leftSection={<IconWindowMaximize size={14} />} onClick={() => open(at.uri, true)}>
                Open in new tab
              </Menu.Item>
            )}
            {onCenter && (
              <Menu.Item leftSection={<IconFocus2 size={14} />} onClick={() => onCenter(at.uri)}>
                Center lineage here
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(mentionOf(at.uri), 'Copied reference')}>
              Copy reference
            </Menu.Item>
            {href && (
              <Menu.Item leftSection={<IconLink size={14} />} onClick={() => void copyText(appUrl(href), 'Copied link')}>
                Copy link
              </Menu.Item>
            )}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

export interface ElementInfo {
  uri: string;
  kind: string;
  label: string;
  status?: LineageStatus;
  rawStatus?: string;
  by?: Attribution;
  at?: string;
  /** Recorded causes (references). */
  causes?: string[];
  extra?: ReactNode;
}

/** Compact preview (hover cards) and selection card (with actions) of a lineage element. */
export function ElementCard({ info, onCenter, onClose, actions = true }: { info: ElementInfo; onCenter?: (uri: string) => void; onClose?: () => void; actions?: boolean }) {
  const open = useOpenElement();
  return (
    <div className="el-card" data-testid={actions ? 'element-card' : 'element-preview'}>
      <div className="el-card-head">
        <KindIcon kind={info.kind} size={14} />
        <span className="el-card-kind">{info.kind.replace(/_/g, ' ')}</span>
        {info.status && (
          <span className="el-card-status">
            <LineageStatusIcon status={info.status} size={12} /> {info.rawStatus ? info.rawStatus.replace(/_/g, ' ') : STATUS_META[info.status].label}
          </span>
        )}
      </div>
      <div className="el-card-title">{info.label}</div>
      {(info.by || info.at) && (
        <div className="el-card-meta">
          {info.by && <ByLine a={info.by} size={13} />}
          {info.at && <span>{relativeTime(info.at)} · {absoluteTime(info.at)}</span>}
        </div>
      )}
      {info.causes && info.causes.length > 0 && (
        <div className="el-card-causes">
          <span className="el-card-label">Caused by</span>
          {info.causes.slice(0, 4).map((c) => (
            <RefChip key={c} to={c} />
          ))}
        </div>
      )}
      {info.extra}
      {actions && (
        <div className="el-card-actions">
          <Button size="compact-xs" variant="light" leftSection={<IconExternalLink size={12} />} onClick={() => open(info.uri)}>
            Open
          </Button>
          {onCenter && (
            <Button size="compact-xs" variant="default" leftSection={<IconFocus2 size={12} />} onClick={() => onCenter(info.uri)}>
              Center lineage here
            </Button>
          )}
          <Button size="compact-xs" variant="default" leftSection={<IconAt size={12} />} onClick={() => void copyText(mentionOf(info.uri), 'Copied reference')}>
            Copy @mandate ref
          </Button>
          {onClose && (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={onClose} aria-label="Close">
              ×
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
