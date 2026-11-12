import { LastEditor } from '../people/People';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconHash, IconX } from '@tabler/icons-react';
import { parseRef } from '@mandate/shared/refs';
import type { NodeKind, SearchResponse } from '@mandate/shared';
import { SearchField } from '../SearchField';
import { KIND_ICON, fallbackLabel, refKind } from '../refs/kinds';
import { StatusGlyph } from '../refs/StatusGlyph';
import { MaturityDot } from '../maturity/MaturityBadge';
import { useSpecMaturities } from '../maturity/SpecMaturity';
import { useMcpNode, useMcpSearch } from '../../mcp/queries';
import { refFromInput } from '../../lib/lineage';
import './lineage.css';

export interface PickerItem {
  uri: string;
  kind: NodeKind | 'other';
  title: string;
  /** Muted context: the parent document for sections, repo:path for code. */
  context?: string;
  status?: string;
}

export const PICKER_KIND_LABEL: Partial<Record<string, string>> = {
  spec: 'Spec',
  standard: 'Standard',
  section: 'Section',
  component: 'Component',
  work_order: 'Work order',
  feedback: 'Feedback',
  audit: 'Audit',
  finding: 'Finding',
  verification: 'Verification',
  comment: 'Comment',
  code_file: 'Code',
  code_range: 'Code',
  commit: 'Commit',
  pull_request: 'Pull request',
  symbol: 'Symbol',
};
const KIND_ORDER = ['spec', 'standard', 'component', 'section', 'work_order', 'feedback', 'audit', 'finding', 'verification', 'comment', 'code_file', 'code_range', 'commit', 'pull_request'];

/** Results grouped by kind (fixed order), with each item's index in the flat keyboard order. */
export function groupPickerItems(items: PickerItem[]): { kind: string; label: string; items: { item: PickerItem; index: number }[] }[] {
  const rank = (k: string) => (KIND_ORDER.indexOf(k) < 0 ? KIND_ORDER.length : KIND_ORDER.indexOf(k));
  const kinds = [...new Set(items.map((i) => i.kind))].sort((a, b) => rank(a) - rank(b));
  let index = 0;
  return kinds.map((kind) => ({
    kind,
    label: kind === 'code_range' || kind === 'code_file' ? 'Code' : `${PICKER_KIND_LABEL[kind] ?? kind.replace(/_/g, ' ')}${kind === 'feedback' ? '' : 's'}`,
    items: items.filter((i) => i.kind === kind).map((item) => ({ item, index: index++ })),
  }));
}

/** Search hits -> picker items (documents and sections). */
export function searchItems(r: SearchResponse | undefined): PickerItem[] {
  const out: PickerItem[] = [];
  const seen = new Set<string>();
  for (const g of r?.groups ?? []) {
    const doc = g.docUri;
    if (!seen.has(doc)) {
      seen.add(doc);
      out.push({ uri: doc, kind: refKind(doc) ?? 'other', title: g.docTitle });
    }
    for (const h of g.hits.filter((x) => x.sectionId).slice(0, 2)) {
      const uri = h.uri.replace(/#.*$/, '');
      if (seen.has(uri)) continue;
      seen.add(uri);
      out.push({ uri, kind: 'section', title: h.sectionTitle ?? h.sectionId!, context: g.docTitle });
    }
  }
  return out.slice(0, 14);
}

const RECENT_KEY = 'mandate.lineage.recent';
export function loadRecent(): PickerItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as PickerItem[];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.uri === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}
function saveRecent(item: PickerItem) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...loadRecent().filter((x) => x.uri !== item.uri)].slice(0, 6)));
  } catch {
    /* storage unavailable */
  }
}

function contextOf(uri: string): string | undefined {
  const r = parseRef(uri);
  if (r?.sectionId) return r.id;
  const k = refKind(uri);
  return k === 'code_file' || k === 'code_range' ? fallbackLabel(uri) : undefined;
}

export function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const Icon = KIND_ICON[kind as NodeKind] ?? IconHash;
  return <Icon size={size} stroke={1.7} className="lp-icon" data-kind={kind} />;
}

/**
 * Element picker of the Lineage page: the shared search field, results grouped by kind with coloured kind icons,
 * context and status, recent picks when empty, a pasted `@mandate:` reference or link resolved first, arrow keys /
 * Enter / Esc, click outside closes. The selected element shows as a chip (icon, title, ×).
 */
export function ElementPicker({ value, valueLabel, valueKind, onPick, onClear }: { value: string; valueLabel?: string; valueKind?: string; onPick: (uri: string) => void; onClear: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(!value);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const direct = refFromInput(term);
  const resolved = useMcpNode(direct ?? '', !!direct);
  const search = useMcpSearch(direct ? '' : term, { kinds: [], status: [] }, open && !direct && term.length > 1);
  const maturity = useSpecMaturities(open);
  const recent = useMemo(() => (open && !term ? loadRecent() : []), [open, term]);
  const items: PickerItem[] = useMemo(() => {
    if (direct) {
      const n = resolved.data?.node;
      const status = typeof n?.props?.status === 'string' ? (n.props.status as string) : undefined;
      return [{ uri: direct, kind: refKind(direct) ?? 'other', title: n?.label ?? fallbackLabel(direct), context: contextOf(direct), status }];
    }
    return term ? searchItems(search.data) : recent;
  }, [direct, resolved.data, term, search.data, recent]);
  const groups = useMemo(() => (direct || !term ? null : groupPickerItems(items)), [direct, term, items]);
  const flat = groups ? groups.flatMap((g) => g.items.map((x) => x.item)) : items;
  useEffect(() => setActive(0), [term]);
  useEffect(() => setEditing(!value), [value]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);

  const pick = (item: PickerItem) => {
    saveRecent(item);
    onPick(item.uri);
    setQ('');
    setOpen(false);
    setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      if (value) setEditing(false);
      return;
    }
    if (!flat.length) return;
    if (e.key === 'ArrowDown') e.preventDefault(), setOpen(true), setActive((i) => (i + 1) % flat.length);
    else if (e.key === 'ArrowUp') e.preventDefault(), setActive((i) => (i - 1 + flat.length) % flat.length);
    else if (e.key === 'Enter' && flat[active]) e.preventDefault(), pick(flat[active]!);
  };

  const row = (item: PickerItem, i: number) => {
    const specId = item.kind === 'spec' ? parseRef(item.uri)?.id : undefined;
    const m = specId ? maturity.get(specId) : undefined;
    return (
      <button key={item.uri} type="button" role="option" className="lp-row" aria-selected={i === active} data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}>
        <KindIcon kind={item.kind} />
        <span className="lp-title">{item.title}</span>
        {item.context && <span className="lp-context">{item.context}</span>}
        <span className="lp-right">
          {m ? <MaturityDot m={m} details={false} /> : <StatusGlyph status={item.status} size={12} />}
          <span className="lp-kind">{PICKER_KIND_LABEL[item.kind] ?? ''}</span>
          <LastEditor refUri={item.uri} className="lp-people" />
        </span>
      </button>
    );
  };

  if (value && !editing) {
    return (
      <div className="lp-root" ref={root}>
        <div className="lp-chip" data-testid="picker-chip">
          <button type="button" className="lp-chip-main" onClick={() => (setEditing(true), setOpen(true))} aria-label="Pick another element">
            <KindIcon kind={valueKind ?? refKind(value) ?? 'other'} size={13} />
            <span className="lp-chip-title">{valueLabel ?? fallbackLabel(value)}</span>
          </button>
          <button type="button" className="lp-chip-x" aria-label="Clear element" onClick={onClear}>
            <IconX size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lp-root" ref={root}>
      {/* Focus opens the list (recent picks when empty). */}
      <div onFocus={() => setOpen(true)}>
        <SearchField
          variant="input"
          size="sm"
          value={q}
          onChange={(v) => (setQ(v), v && setOpen(true))}
          onKeyDown={onKey}
          placeholder="Search, paste a link or an @mandate: reference"
          ariaLabel="Pick an element"
          loading={search.isFetching || resolved.isFetching}
          autoFocus={!!value}
          style={{ width: 320 }}
        />
      </div>
      {open && (
        <div className="lp-drop" role="listbox" data-testid="picker-list">
          {!term && recent.length > 0 && <div className="lp-head">Recent</div>}
          {!term && !recent.length && <div className="lp-hint">Type to search · paste a link or @mandate: reference · ↑↓ Enter Esc</div>}
          {direct && <div className="lp-head">Reference</div>}
          {groups
            ? groups.map((g) => (
                <div key={g.kind} className="lp-group" data-testid="picker-group">
                  <div className="lp-head">{g.label}</div>
                  {g.items.map(({ item, index }) => row(item, index))}
                </div>
              ))
            : items.map((item, i) => row(item, i))}
          {term.length > 1 && !direct && !search.isFetching && !search.error && items.length === 0 && <div className="lp-hint">No matches for “{term}”</div>}
          {search.error && <div className="lp-hint">{search.error.message}</div>}
        </div>
      )}
    </div>
  );
}
