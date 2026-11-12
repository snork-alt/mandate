import { createContext, useContext, useState, type MouseEvent } from 'react';
import { Menu, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconAt, IconExternalLink, IconLink } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import type { ReferenceCheck } from '@mandate/shared';
import { mentionOf } from '@mandate/shared';
import { copyText } from '../../lib/copy';
import { openCommandPalette } from '../CommandPalette';
import { StatusGlyph } from './StatusGlyph';
import { KIND_ICON, fallbackLabel, refHref, refKind } from './kinds';
import { sectionHref } from '../../lib/links';
import { useRefNode } from './useRefNode';
import { CodeRulesLines } from './CodeRules';
import { parseRef } from '@mandate/shared/refs';
import { MaturityDot } from '../maturity/MaturityBadge';
import { useSpecMaturities } from '../maturity/SpecMaturity';
import './refs.css';
import { Contributors } from '../people/People';
import { appUrl, withBase } from '../../project';

/** Reference checks of an ask answer: unresolved refs render visibly as such. */
export const RefCheckContext = createContext<Map<string, ReferenceCheck> | null>(null);

const normalize = (u: string) => u.trim().replace(/^@mandate:/, '');

export interface RefChipProps {
  /** scheme reference (an `@mandate:` mention is accepted). */
  to: string;
  /** Overrides the label (e.g. the link text of a markdown answer). */
  label?: string;
  /** Overrides the click target (e.g. a commit opening the track-changes view of a document). */
  href?: string;
  /** Skip resolving through MCP (the label falls back to the reference). */
  resolve?: boolean;
  check?: ReferenceCheck;
}

const PEOPLE_LABEL: Partial<Record<string, string>> = { code_file: 'Touched by', code_range: 'Touched by', repo: 'Touched by', commit: 'Committed by', code_commit: 'Implemented by', pull_request: 'Worked on by', branch: 'Worked on by', agent: 'Used by', symbol: 'Mentioned by' };

/** Who touched / wrote the referenced element (lazy: the preview mounts only while open). */
function RefPeople({ uri, kind }: { uri: string; kind: string }) {
  return (
    <div className="ref-preview-people" data-testid="ref-people">
      <span className="faint">{PEOPLE_LABEL[kind] ?? 'Contributors'}</span>
      <Contributors refUri={uri} size="xs" max={5} form="compact" />
    </div>
  );
}

/**
 * One rich reference everywhere (Activity, Ask answers, tables, tool results): kind icon, resolved title, live status icon,
 * hover preview, click opens it, right-click copies (Mandate reference first).
 */
export function RefChip({ to, label, href, resolve = true, check }: RefChipProps) {
  const uri = normalize(to);
  const navigate = useNavigate();
  const ctx = useContext(RefCheckContext);
  const chk = check ?? ctx?.get(uri);
  const unresolved = chk?.resolved === false;
  const kind = refKind(uri);
  const node = useRefNode(uri, resolve && !unresolved && !!kind);
  const [menu, setMenu] = useState(false);
  const Icon = kind ? KIND_ICON[kind] : IconAlertTriangle;
  const props = node.data?.props ?? {};
  const status = typeof props.status === 'string' ? props.status : undefined;
  const title = label ?? node.data?.label ?? chk?.label ?? fallbackLabel(uri);
  // Comments open their work order (at the comment); PRs / code commits open the work order they belong to.
  const viaProps =
    kind === 'comment' && typeof props.target === 'string'
      ? `${sectionHref(props.target.split('/sections/')[0]!)}#comment-${typeof props.thread === 'string' ? props.thread : (props.id as string)}`
      : (kind === 'pull_request' || kind === 'code_commit') && typeof props.workOrder === 'string'
        ? sectionHref(props.workOrder)
        : null;
  const target = href ?? refHref(uri) ?? viaProps;
  const summary = typeof props.summary === 'string' ? props.summary : undefined;
  const specId = kind === 'spec' ? parseRef(uri)?.id : undefined;
  const maturity = useSpecMaturities(!!specId);

  const open = (e: MouseEvent) => {
    e.preventDefault();
    if (unresolved || !kind) return;
    if (target) void navigate(target);
    else if (kind === 'symbol') openCommandPalette(`@${fallbackLabel(uri)}`);
    else if (kind === 'code_file' || kind === 'code_range') openCommandPalette(`/${fallbackLabel(uri).split(':')[0]}`);
    else void copyText(mentionOf(uri), 'Copied reference');
  };

  const preview = unresolved ? (
    <div>
      <strong>Unresolved reference</strong>
      <div className="ref-preview-mono">{uri}</div>
      {chk?.error && <div>{chk.error}</div>}
    </div>
  ) : (
    <div>
      <strong>{node.data?.label ?? title}</strong>
      <div className="ref-preview-mono">{kind?.replace('_', ' ')}{status ? ` · ${status.replace('_', ' ')}` : ''}</div>
      {summary && <div>{summary}</div>}
      {(kind === 'code_file' || kind === 'code_range') && <CodeRulesLines refUri={uri} />}
      {kind && <RefPeople uri={uri} kind={kind} />}
    </div>
  );

  return (
    <Menu opened={menu} onChange={setMenu} position="bottom-start" withinPortal>
      <Menu.Target>
        <span onContextMenu={(e) => (e.preventDefault(), setMenu(true))} style={{ display: 'inline-flex', maxWidth: '100%' }}>
          <Tooltip label={preview} multiline w={280} openDelay={350} withinPortal disabled={menu}>
            <a
              className="ref-chip-rich"
              data-kind={kind ?? 'invalid'}
              data-unresolved={unresolved || undefined}
              href={target ? withBase(target) : '#'}
              onClick={open}
              aria-label={unresolved ? `Unresolved reference ${uri}` : undefined}
            >
              <Icon size={13} stroke={1.6} className="ref-chip-icon" />
              <span className="ref-chip-label">{title}</span>
              {unresolved ? (
                <IconAlertTriangle size={12} aria-label="unresolved" />
              ) : specId && maturity.get(specId) ? (
                <MaturityDot m={maturity.get(specId)!} details={false} />
              ) : (
                <StatusGlyph status={status} size={12} />
              )}
            </a>
          </Tooltip>
        </span>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyText(mentionOf(uri), 'Copied reference')}>
          Copy reference
        </Menu.Item>
        {target && (
          <Menu.Item leftSection={<IconLink size={14} />} onClick={() => void copyText(appUrl(target), 'Copied link')}>
            Copy link
          </Menu.Item>
        )}
        {target && !unresolved && (
          <Menu.Item leftSection={<IconExternalLink size={14} />} onClick={() => void navigate(target)}>
            Open
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
