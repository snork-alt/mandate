import type { ValueChange } from '@mandate/doc';
import { useState } from 'react';
import { Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import type { CodeRef, Section, StoredComponent } from '@mandate/shared';
import { copyText } from '../../lib/copy';
import { compactPaths, groupByOwner } from '../../lib/codeRefGroups';
import { useEntityList } from '../../lib/queries';
import { codeTarget } from '../../lib/refs';
import { ChipCopy } from '../copy';
import { KIND_ICON } from '../refs/kinds';

const ComponentIcon = KIND_ICON.component;
import { SymbolChip } from './Chips';
import { ProvedBy } from './ProvedBy';
import { LinkChip, useSectionLinks } from './LinkParts';
import { REL_META } from '../../lib/links';
import type { SectionLink } from '@mandate/doc';

type Mark = 'added' | 'removed' | undefined;

/** Items to show for one metadata list: current items (added ones marked) plus removed ones (struck). */
function withChanges<T>(items: T[], change?: ValueChange): { item: T; mark: Mark }[] {
  const key = (x: unknown) => JSON.stringify(x);
  const added = new Set((change?.addedItems ?? []).map(key));
  return [
    ...items.map((item) => ({ item, mark: added.has(key(item)) ? ('added' as const) : undefined })),
    ...((change?.removedItems ?? []) as T[]).map((item) => ({ item, mark: 'removed' as const })),
  ];
}

const wrap = (mark: Mark, key: string, node: React.ReactNode) =>
  mark ? (
    <span key={key} className={`tc-chip tc-chip-${mark} tc-mark`} data-mark={mark}>
      {node}
    </span>
  ) : (
    <span key={key} style={{ display: 'contents' }}>
      {node}
    </span>
  );

type Marked = { item: CodeRef; mark: Mark };
export const REF_LIMIT = 6;

const refText = (r: CodeRef) => `${r.path}${r.lines ? `:${r.lines}` : ''}`;

/** One code file: click copies its code reference. */
function FileLink({ r, name }: { r: CodeRef; name: string }) {
  const target = codeTarget(r);
  return (
    <ChipCopy target={target}>
      <Tooltip label={`${r.repo} · ${refText(r)}${r.commit ? ` @${r.commit.slice(0, 7)}` : ''}. Click to copy reference`} openDelay={300}>
        <button type="button" className="meta-file" onClick={() => void copyText(target.ref)}>
          {name}
          {r.lines && <span className="chip-muted">:{r.lines}</span>}
        </button>
      </Tooltip>
    </ChipCopy>
  );
}

/** The code refs of one owner (or of no owner): a label and a compact path list, at most REF_LIMIT files until expanded. */
export function RefGroupRow({ owner, items, showRepo }: { owner: StoredComponent | null; items: Marked[]; showRepo: boolean }) {
  const [open, setOpen] = useState(false);
  const { groups, hidden } = compactPaths(items, (x) => x.item.path, open ? Infinity : REF_LIMIT);
  const repos = [...new Set(items.map((x) => x.item.repo))];
  return (
    <div className="meta-group" data-testid="ref-group">
      {owner && (
        <Link to={`/components/${owner.id}`} className="chip chip-owner">
          <ComponentIcon size={11} />
          {owner.title}
        </Link>
      )}
      {showRepo && <span className="chip-muted meta-repo">{repos.join(', ')}</span>}
      <span className="meta-files">
        {groups.map((g, gi) => (
          <span key={`${g.dir}-${gi}`} className="meta-dir">
            {gi > 0 && <span className="chip-sep"> · </span>}
            {g.dir && <span className="chip-muted">{g.dir}</span>}
            {g.files.map((f, fi) => (
              <span key={`${f.name}-${fi}`}>
                {fi > 0 && ', '}
                {wrap(f.item.mark, `f-${f.item.item.path}-${fi}-${f.item.mark}`, <FileLink r={f.item.item} name={f.name} />)}
              </span>
            ))}
          </span>
        ))}
        {hidden > 0 && (
          <button type="button" className="meta-more" onClick={() => setOpen(true)}>
            +{hidden} more
          </button>
        )}
        {open && items.length > REF_LIMIT && (
          <button type="button" className="meta-more" onClick={() => setOpen(false)}>
            show less
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Standards, code refs and symbols of a section, as one wrapping row of chips. Renders nothing when empty.
 * With `changes` (tracked-changes mode), added chips are marked green and removed ones shown struck through.
 */
export function SectionMeta({
  section,
  standardTitles,
  changes,
}: {
  section: Section;
  standardTitles?: Map<string, string>;
  changes?: ValueChange[];
}) {
  const ch = (k: string) => changes?.find((c) => c.key === k);
  const refs = withChanges<CodeRef>(section.refs, ch('refs'));
  const symbols = withChanges(section.symbols, ch('symbols'));
  const links = withChanges<SectionLink>(section.links ?? [], ch('links'));
  const info = useSectionLinks(section.id);
  const comps = useEntityList('components');
  void standardTitles; // standards are links now (follows), shown as link chips
  const proved = section.provedBy ?? [];
  if (!refs.length && !symbols.length && !links.length && !proved.length) return null;
  const components = (comps.data ?? []) as unknown as StoredComponent[];
  const refItems: Marked[] = refs;
  const repoCount = new Set(refItems.map((x) => x.item.repo)).size;
  const groups = groupByOwner(refItems.map((x) => ({ ...x, repo: x.item.repo, path: x.item.path })), components);
  // Links by relation: "Affects: <component>", "Follows: <standard> · rule X".
  const byRel = new Map<string, typeof links>();
  for (const l of links) byRel.set(l.item.rel, [...(byRel.get(l.item.rel) ?? []), l]);
  return (
    <div className="section-meta">
      {groups.map((g) => (
        <RefGroupRow key={g.owner?.id ?? 'unowned'} owner={g.owner} items={g.items} showRepo={repoCount > 1} />
      ))}
      {symbols.length > 0 && (
        <div className="meta-group">
          {symbols.map(({ item, mark }) => wrap(mark, `y-${item}-${mark}`, <SymbolChip symbol={item} />))}
        </div>
      )}
      {proved.length > 0 && <ProvedBy items={proved} />}
      {[...byRel].map(([rel, list]) => (
        <div className="meta-group" key={rel} data-testid="link-group" data-rel={rel}>
          <span className="meta-label">{(REL_META[rel] ?? REL_META.relates_to!).label}:</span>
          {list.map(({ item, mark }) =>
            wrap(mark, `l-${item.to}-${item.rel}-${mark}`, <LinkChip link={item} resolved={info?.outgoing.find((o) => o.to === item.to && o.rel === item.rel)} grouped />),
          )}
        </div>
      ))}
    </div>
  );
}
