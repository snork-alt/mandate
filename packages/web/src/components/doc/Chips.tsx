import { Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import { codeTarget, symbolTarget, uriTarget } from '../../lib/refs';
import { ChipCopy } from '../copy';
import { buildRef } from '@mandate/shared/refs';
import { IconBraces, IconCode, IconRuler2 } from '@tabler/icons-react';
import type { CodeRef } from '@mandate/shared';
import { RulesHover } from '../rules/RuleParts';
import { ownerOf, type StoredComponent } from '@mandate/shared';
import { IconTopologyStar3 } from '@tabler/icons-react';
import { Link } from 'react-router';
import { useEntityList } from '../../lib/queries';

/** `repo · path:lines @commit`; click copies its code reference, right-click for the raw path. */
export function CodeRefChip({ codeRef }: { codeRef: CodeRef }) {
  const { repo, path, lines, commit } = codeRef;
  const target = codeTarget(codeRef);
  const file = path.split('/').pop() ?? path;
  const dir = path.slice(0, path.length - file.length);
  return (
    <ChipCopy target={target}>
      <RulesHover repo={repo} path={path} lines={lines}>
        <button type="button" className="chip chip-code" onClick={() => void copyText(target.ref)} title={`${repo} · ${path}${lines ? `:${lines}` : ''}${commit ? ` @${commit}` : ''} · click copies ${target.ref}`}>
          <IconCode size={12} />
          <span className="chip-muted">{repo}</span>
          <span className="chip-sep">·</span>
          <span className="chip-path">
            <span className="chip-muted">{dir}</span>
            {file}
            {lines && <span className="chip-muted">:{lines}</span>}
          </span>
          {commit && <span className="chip-commit">@{commit.slice(0, 7)}</span>}
        </button>
      </RulesHover>
      <OwnedBy repo={repo} path={path} />
    </ChipCopy>
  );
}

/** Monospace code symbol; click copies its symbol reference. */
export function SymbolChip({ symbol }: { symbol: string }) {
  const target = symbolTarget(symbol);
  return (
    <ChipCopy target={target}>
      <Tooltip label={`Copy reference ${target.ref}`}>
        <button type="button" className="chip chip-symbol" onClick={() => void copyText(target.ref)}>
          <IconBraces size={12} />
          {symbol}
        </button>
      </Tooltip>
    </ChipCopy>
  );
}

/** Link to a standard; shows its title when known. Right-click copies its reference. */
export function StandardChip({ id, title, warning }: { id: string; title?: string; warning?: string }) {
  return (
    <ChipCopy target={uriTarget(buildRef({ kind: 'standards', id }), 'standard')}>
      <Tooltip label={warning ?? (title ? `Standard: ${id}` : 'Standard (not found)')}>
        <Link to={`/standards/${id}`} className="chip chip-standard" data-missing={title ? undefined : true} data-warn={warning ? true : undefined}>
          {warning ? <IconAlertTriangle size={12} /> : <IconRuler2 size={12} />}
          {title ?? id}
        </Link>
      </Tooltip>
    </ChipCopy>
  );
}

export function TagPill({ tag }: { tag: string }) {
  return <span className="tag-pill">{tag}</span>;
}

/** "Owned by" chip next to a code ref: the component whose `owns` globs match the path (most specific wins). */
function OwnedBy({ repo, path }: { repo: string; path: string }) {
  const comps = useEntityList('components');
  const owner = ownerOf(repo, path, (comps.data ?? []) as unknown as StoredComponent[]);
  if (!owner) return null;
  return (
    <Link to={`/components/${owner.component.id}`} className="chip chip-owner" title={`Owned by ${owner.component.title} (${owner.glob})`}>
      <IconTopologyStar3 size={11} />
      {owner.component.title}
    </Link>
  );
}
