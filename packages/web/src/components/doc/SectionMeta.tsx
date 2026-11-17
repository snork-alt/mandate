import type { ValueChange } from '@mandate/doc';
import type { CodeRef, Section } from '@mandate/shared';
import { CodeRefChip, StandardChip, SymbolChip } from './Chips';
import { ProvedBy } from './ProvedBy';
import { LinkChip, useSectionLinks } from './LinkParts';
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
  void standardTitles; // standards are links now (follows), shown as link chips
  const proved = section.provedBy ?? [];
  if (!refs.length && !symbols.length && !links.length && !proved.length) return null;
  return (
    <div className="section-meta">
      {refs.map(({ item, mark }, i) => wrap(mark, `r-${i}-${mark}`, <CodeRefChip codeRef={item} />))}
      {symbols.map(({ item, mark }) => wrap(mark, `y-${item}-${mark}`, <SymbolChip symbol={item} />))}
      {proved.length > 0 && <ProvedBy items={proved} />}
      {links.map(({ item, mark }) =>
        wrap(mark, `l-${item.to}-${item.rel}-${mark}`, <LinkChip link={item} resolved={info?.outgoing.find((o) => o.to === item.to && o.rel === item.rel)} />),
      )}
    </div>
  );
}
