import { createContext, useContext, useState, type MouseEvent } from 'react';
import { Menu } from '@mantine/core';
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
import { RefHoverCard } from './RefPreview';
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

  const updated = ['updated', 'updatedAt', 'at'].map((k) => props[k]).find((v): v is string => typeof v === 'string');
  const hint = unresolved || !kind ? undefined : target || kind === 'symbol' || kind === 'code_file' || kind === 'code_range' ? 'Click to open' : 'Click to copy the reference';

  return (
    <Menu opened={menu} onChange={setMenu} position="bottom-start" withinPortal>
      <Menu.Target>
        <span onContextMenu={(e) => (e.preventDefault(), setMenu(true))} style={{ display: 'inline-flex', maxWidth: '100%' }}>
          <RefHoverCard
            disabled={menu}
            uri={uri}
            kind={kind}
            label={node.data?.label ?? title}
            status={status}
            maturity={specId ? maturity.get(specId) : undefined}
            summary={summary}
            updated={updated}
            unresolved={unresolved}
            error={chk?.error}
            hint={hint}
            extra={kind === 'code_file' || kind === 'code_range' ? <CodeRulesLines refUri={uri} /> : undefined}
          >
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
          </RefHoverCard>
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
