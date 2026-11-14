import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Kbd, Loader, Modal, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDebouncedValue, useHotkeys } from '@mantine/hooks';
import {
  IconAt,
  IconMoon,
  IconPlugConnected,
  IconSettings,
  IconGitMerge,
} from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router';
import { mentionOf, parseNodeUri, parseRef, refMention, type NodeKind, type SearchKind } from '@mandate/shared';
import { KIND_ICON } from './refs/kinds';
import { KindIcon } from './refs/KindIcon';
import { SearchField } from './SearchField';
import { StatusGlyph } from './refs/StatusGlyph';
import { auditHref, sectionHref } from '../lib/links';
import { SpecMaturityDot } from './maturity/SpecMaturity';
import { copyText } from '../lib/copy';
import { goTo } from '../project';
import { openConnectAgent } from '../connect/ConnectAgentModal';
import { SECTIONS } from '../sections';
import { parsePaletteQuery } from '../mcp/queryParser';
import { McpToolError } from '../mcp/client';
import { useContributors } from '../lib/people';
import { LastEditor } from './people/People';
import { useMcpCodeSearch, useMcpIdLookup, useMcpNode, useMcpSearch, useMcpSymbolSearch, useMcpTextSearch, useMcpTool } from '../mcp/queries';
import { LevelBadge } from './rules/RuleParts';
import { useEntityList } from '../lib/queries';
import type { RuleHit } from '@mandate/shared';
import { renderSnippet } from '../mcp/snippet';
import '../mcp/palette.css';

/*
 * Cmd/Ctrl+K palette. Navigation actions are local; everything searchable goes through the MCP server.
 * Keys: Up/Down + Enter work from the input. `C` (copy the highlighted hit's reference) only fires when the
 * result list has focus (press Tab from the input); Cmd/Ctrl+C with nothing selected in the input does the same.
 */

let openPalette: (query?: string) => void = () => undefined;
/** Open the palette from anywhere (sidebar button, mobile header). */
export const openCommandPalette = (query?: string) => openPalette(query);

/** Object-type icon (KIND_ICON, the single source of truth); unknown kinds fall back to the spec icon. */
const docIcon = (kind: string) => KIND_ICON[kind as NodeKind] ?? KIND_ICON.spec;
const KIND_LABEL: Record<SearchKind, string> = { spec: 'Spec', standard: 'Standard', section: 'Section', work_order: 'Work order', feedback: 'Feedback', component: 'Component', audit: 'Audit' };
const KIND_ORDER: SearchKind[] = ['spec', 'standard', 'section', 'work_order', 'feedback'];
const MATCH_LABEL = { text: 'text', semantic: 'meaning', symbol: 'symbol' } as const;

const StatusIcon = StatusGlyph;

const lineLabel = (l?: { start: number; end: number }) => (l ? `L${l.start}${l.end > l.start ? `–${l.end}` : ''}` : '');

/** Doc route for a hit; lines only apply to sections (work-order / feedback lines are jsonl lines). */
const hitHref = (uri: string, docUri: string, sectionId?: string) => sectionHref(sectionId ? uri : docUri);

type Row =
  | { id: string; type: 'header'; node: ReactNode }
  | { id: string; type: 'label'; node: ReactNode }
  | { id: string; type: 'item'; node: ReactNode; flat?: boolean; select: () => void; copy?: string };

export function CommandPalette() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const [opened, setOpened] = useState(false);
  const [raw, setRaw] = useState('');
  const [kinds, setKinds] = useState<SearchKind[]>([]);
  const [status, setStatus] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q] = useDebouncedValue(raw, 150);

  const initial = useRef('');
  openPalette = (query) => {
    initial.current = query ?? '';
    setOpened(true);
  };
  useHotkeys([['mod+K', () => setOpened((o) => !o), { preventDefault: true }]], []);

  const parsed = useMemo(() => parsePaletteQuery(q), [q]);
  const filters = useMemo(() => ({ kinds, status }), [kinds, status]);
  const search = useMcpSearch(parsed.type === 'search' ? parsed.q : '', filters, opened && parsed.type === 'search');
  const phrase = useMcpTextSearch(parsed.type === 'phrase' ? parsed.phrase : '', filters, opened && parsed.type === 'phrase');
  const symbols = useMcpSymbolSearch(parsed.type === 'symbol' ? parsed.name : '', opened && parsed.type === 'symbol');
  const code = useMcpCodeSearch(parsed.type === 'code' ? parsed.path : '', parsed.type === 'code' ? parsed.lines : undefined, opened && parsed.type === 'code');
  const node = useMcpNode(parsed.type === 'ref' ? parsed.uri : '', opened && parsed.type === 'ref');
  const componentList = useEntityList('components');
  // `/path` also lists the rules that apply to that code (rulesForCode).
  const codeRules = useMcpTool<{ rules: RuleHit[] }>('rules_for_code', parsed.type === 'code' ? { path: parsed.path.replace(/^\/+/, ''), ...(parsed.lines ? { lines: parsed.lines } : {}) } : {}, opened && parsed.type === 'code' && parsed.path.length > 1);
  const idLookup = useMcpIdLookup(parsed.type === 'id' ? parsed.id : '', opened && parsed.type === 'id');
  const current = parsed.type === 'search' ? search : parsed.type === 'phrase' ? phrase : parsed.type === 'symbol' ? symbols : parsed.type === 'code' ? code : parsed.type === 'ref' ? node : parsed.type === 'id' ? idLookup : null;

  const close = () => setOpened(false);
  const go = (href: string) => () => {
    close();
    void navigate(href);
  };

  const currentDoc = /^\/(specs|standards|work-orders)\/([a-z0-9-]+)\/?$/.exec(location.pathname);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const navRows = (filter?: string): Row[] => {
      const lc = filter?.toLowerCase();
      const r: Row[] = SECTIONS.filter((s) => !lc || `go to ${s.label}`.toLowerCase().includes(lc)).map(({ kind, label, icon: Icon }) => ({
        id: `go-${kind}`,
        type: 'item',
        flat: true,
        node: (
          <>
            <Icon size={16} stroke={1.6} />
            <span className="cmdk-row-main">Go to {label}</span>
          </>
        ),
        select: go(`/${kind}`),
      }));
      // Beyond the sections: lineage, settings and the connect dialog (P1).
      const extra: { id: string; label: string; icon: typeof IconGitMerge; select: () => void }[] = [
        { id: 'go-lineage', label: 'Go to Lineage', icon: IconGitMerge, select: go('/lineage') },
        { id: 'go-settings', label: 'Settings', icon: IconSettings, select: () => (close(), goTo('/settings')) },
        { id: 'connect-agent', label: 'Connect agent', icon: IconPlugConnected, select: () => (close(), openConnectAgent()) },
      ];
      for (const x of extra) {
        if (lc && !x.label.toLowerCase().includes(lc)) continue;
        const Icon = x.icon;
        r.push({
          id: x.id,
          type: 'item',
          flat: true,
          node: (
            <>
              <Icon size={16} stroke={1.6} />
              <span className="cmdk-row-main">{x.label}</span>
            </>
          ),
          select: x.select,
        });
      }
      return r.length ? [{ id: 'nav-label', type: 'label', node: 'Navigate' }, ...r] : r;
    };
    const docHeader = (id: string, docKind: string, title: string, st?: string, extra?: ReactNode): Row => {
      const Icon = docIcon(docKind);
      return {
        id: `h-${id}`,
        type: 'header',
        node: (
          <>
            <Icon size={15} stroke={1.6} />
            <span>{title}</span>
            {/* Specs show maturity only (X1); other documents their own status. */}
            {docKind === 'spec' ? parseRef(id)?.kind === 'specs' && <SpecMaturityDot id={parseRef(id)!.id} /> : <StatusIcon status={st} />}
            {extra}
            <LastEditor refUri={id} />
          </>
        ),
      };
    };

    switch (parsed.type) {
      case 'empty': {
        out.push(...navRows());
        out.push({ id: 'act-label', type: 'label', node: 'Actions' });
        if (currentDoc) {
          const m = refMention({ kind: currentDoc[1] as 'specs', id: currentDoc[2]! });
          out.push({
            id: 'copy-ref',
            type: 'item',
            flat: true,
            node: (
              <>
                <IconAt size={16} stroke={1.6} />
                <span className="cmdk-row-main">Copy reference to current {currentDoc[1] === 'specs' ? 'spec' : currentDoc[1] === 'standards' ? 'standard' : 'work order'}</span>
                <span className="cmdk-faint cmdk-mono">{m.length > 46 ? `${m.slice(0, 46)}…` : m}</span>
              </>
            ),
            select: () => {
              close();
              void copyText(m);
            },
          });
        }
        out.push({
          id: 'toggle-theme',
          type: 'item',
          flat: true,
          node: (
            <>
              <IconMoon size={16} stroke={1.6} />
              <span className="cmdk-row-main">Toggle light / dark theme</span>
            </>
          ),
          select: () => {
            close();
            setColorScheme(scheme === 'dark' ? 'light' : 'dark');
          },
        });
        out.push({
          id: 'hints',
          type: 'label',
          node: (
            <>
              Search prefixes: <span className="cmdk-mono">@symbol</span> · <span className="cmdk-mono">/path[:10-20]</span> · <span className="cmdk-mono">"phrase"</span> · <span className="cmdk-mono">#id</span> · paste a reference
            </>
          ),
        });
        break;
      }
      case 'search': {
        out.push(...navRows(parsed.q));
        // Components (matched locally by id / title / summary until the index covers them).
        const ql = parsed.q.toLowerCase();
        for (const c of (componentList.data ?? []) as unknown as { id: string; title: string; summary?: string; kind: string }[]) {
          if (!`${c.id} ${c.title} ${c.summary ?? ''}`.toLowerCase().includes(ql)) continue;
          out.push({
            id: `component:${c.id}`,
            type: 'item',
            flat: true,
            copy: refMention({ kind: 'components', id: c.id }),
            select: go(`/components/${c.id}`),
            node: (
              <>
                <KindIcon kind="component" size={15} />
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">
                    {c.title} <span className="cmdk-faint">component · {c.kind}</span>
                  </div>
                  {c.summary && <div className="cmdk-snippet">{c.summary}</div>}
                </div>
              </>
            ),
          });
        }
        for (const g of search.data?.groups ?? []) {
          out.push(docHeader(g.docUri, g.docKind, g.docTitle, g.status, g.category ? <span className="cmdk-faint">{g.category}</span> : null));
          for (const h of g.hits) {
            out.push({
              id: h.uri,
              type: 'item',
              copy: mentionOf(h.uri),
              select: go(hitHref(h.uri, h.docUri, h.sectionId)),
              node: (
                <>
                  <div className="cmdk-row-main">
                    <div className="cmdk-row-title">
                      {h.sectionTitle ?? 'Document'}
                      {h.lines && h.sectionId && <span className="cmdk-faint cmdk-mono">{lineLabel(h.lines)}</span>}
                    </div>
                    <div className="cmdk-snippet">{renderSnippet(h.snippet)}</div>
                  </div>
                  <span className="cmdk-badges">
                    {h.matchedBy.map((m) => (
                      <span key={m} className="cmdk-badge">
                        {MATCH_LABEL[m]}
                      </span>
                    ))}
                  </span>
                </>
              ),
            });
          }
        }
        break;
      }
      case 'phrase': {
        for (const m of phrase.data?.matches ?? []) {
          const Icon = docIcon(m.kind);
          out.push({
            id: `${m.uri}:${m.line}`,
            type: 'item',
            flat: true,
            copy: mentionOf(m.uri),
            select: go(hitHref(m.uri, m.docUri, m.sectionId)),
            node: (
              <>
                <Icon size={15} stroke={1.6} style={{ flex: 'none', marginTop: 2 }} />
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">
                    {m.docTitle}
                    {m.sectionTitle && <span className="cmdk-faint"> › {m.sectionTitle}</span>}
                    <span className="cmdk-faint cmdk-mono">L{m.line}</span>
                  </div>
                  <div className="cmdk-snippet cmdk-mono">{renderSnippet(m.text.trim())}</div>
                </div>
              </>
            ),
          });
        }
        break;
      }
      case 'symbol': {
        for (const s of symbols.data?.symbols ?? []) {
          out.push({
            id: `h-${s.uri}`,
            type: 'header',
            node: (
              <>
                <KindIcon kind="symbol" size={15} />
                <span className="cmdk-mono">{s.name}</span>
                <span className="cmdk-faint">{s.usedIn.length} {s.usedIn.length === 1 ? 'section' : 'sections'}</span>
              </>
            ),
          });
          for (const u of s.usedIn) {
            out.push({
              id: `${s.uri}|${u.sectionUri}`,
              type: 'item',
              copy: mentionOf(u.sectionUri),
              select: go(sectionHref(u.sectionUri)),
              node: (
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">
                    {u.sectionTitle}
                    {u.lines && <span className="cmdk-faint cmdk-mono">{lineLabel(u.lines)}</span>}
                  </div>
                  <div className="cmdk-snippet">{u.docTitle}</div>
                </div>
              ),
            });
          }
        }
        break;
      }
      case 'code': {
        for (const r of codeRules.data?.rules ?? []) {
          const t = parseNodeUri(r.uri);
          const href = t && 'id' in t && 'sectionId' in t ? `/standards/${t.id}#section-${t.sectionId}` : '/standards';
          out.push({
            id: `rule|${r.uri}`,
            type: 'item',
            flat: true,
            copy: mentionOf(r.uri),
            select: go(href),
            node: (
              <>
                <LevelBadge level={r.level} />
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">{r.title}</div>
                  <div className="cmdk-snippet">
                    Rule · {r.standardTitle}
                    {r.why.includes('section') ? ' · via spec section' : ''}
                  </div>
                </div>
              </>
            ),
          });
        }
        for (const r of code.data?.refs ?? []) {
          out.push({
            id: `${r.uri}|${r.sectionUri}`,
            type: 'item',
            flat: true,
            copy: mentionOf(r.sectionUri),
            select: go(sectionHref(r.sectionUri)),
            node: (
              <>
                <KindIcon kind="code_file" size={15} />
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">
                    <span className="cmdk-mono">
                      {r.repo}:{r.path}
                      {lineLabel(r.lines) && ` ${lineLabel(r.lines)}`}
                    </span>
                    {parseRef(r.docUri)?.kind === 'specs' ? <SpecMaturityDot id={parseRef(r.docUri)!.id} /> : <StatusIcon status={r.status} />}
                  </div>
                  <div className="cmdk-snippet">
                    {r.docTitle} › {r.sectionTitle}
                  </div>
                </div>
              </>
            ),
          });
        }
        break;
      }
      case 'ref': {
        const n = node.data?.node;
        if (n) {
          const ref = parseRef(n.ref) ?? auditHref(n.ref);
          out.push({
            id: `ref-${n.ref}`,
            type: 'item',
            flat: true,
            copy: mentionOf(n.ref),
            select: ref ? go(sectionHref(n.ref)) : () => { close(); void copyText(mentionOf(n.ref)); },
            node: (
              <>
                <IconAt size={16} stroke={1.6} />
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">{n.label}</div>
                  <div className="cmdk-snippet">{ref ? `Open ${n.kind.replace('_', ' ')}` : `${n.kind.replace('_', ' ')} · Enter copies the reference`}</div>
                </div>
              </>
            ),
          });
        }
        break;
      }
      case 'id': {
        const r = idLookup.data;
        if (r) {
          out.push({
            id: `id-${r.node.ref}`,
            type: 'item',
            flat: true,
            copy: mentionOf(r.node.ref),
            select: go(sectionHref(r.node.ref)),
            node: (
              <>
                {(() => {
                  const Icon = KIND_ICON[r.node.kind as NodeKind] ?? KIND_ICON.section;
                  return <Icon size={16} stroke={1.6} />;
                })()}
                <div className="cmdk-row-main">
                  <div className="cmdk-row-title">{r.node.label}</div>
                  <div className="cmdk-snippet">Open {r.node.kind.replace('_', ' ')} {parsed.id}</div>
                </div>
              </>
            ),
          });
        }
        break;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, search.data, phrase.data, symbols.data, code.data, node.data, idLookup.data, currentDoc?.[1], currentDoc?.[2], scheme]);

  const items = useMemo(() => rows.map((r, i) => (r.type === 'item' ? i : -1)).filter((i) => i >= 0), [rows]);
  const ids = rows.map((r) => r.id).join('|');
  useEffect(() => setActive(0), [ids]);
  useEffect(() => {
    if (opened) {
      setRaw(initial.current);
      initial.current = '';
      setKinds([]);
      setStatus([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [opened]);
  const activeRow = rows[items[Math.min(active, items.length - 1)] ?? -1];
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, ids]);

  const move = (d: number) => items.length && setActive((a) => (a + d + items.length) % items.length);
  const copyActive = () => {
    if (activeRow?.type === 'item' && activeRow.copy) {
      void copyText(activeRow.copy);
      return true;
    }
    return false;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const inInput = e.target === inputRef.current;
    if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow?.type === 'item') activeRow.select();
      else {
        // A pasted reference opens right away, even before the debounced lookup finished.
        const t = parsePaletteQuery(raw);
        if (t.type === 'ref' && (parseRef(t.uri) || auditHref(t.uri))) go(sectionHref(t.uri))();
      }
    } else if (!inInput && e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (copyActive()) e.preventDefault();
    } else if (inInput && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      const el = inputRef.current!;
      if (el.selectionStart === el.selectionEnd && copyActive()) e.preventDefault();
    }
  };

  const searching = parsed.type !== 'empty' && (raw.trim() !== q.trim() || !!current?.isFetching);
  const error = current?.error as McpToolError | null | undefined;
  const canFilter = parsed.type === 'search' || parsed.type === 'phrase';
  const facets = search.data?.facets;
  // Stored-status chips only for non-spec kinds (specs are filtered by maturity, X1).
  const statusOptions = kinds.length > 0 && !kinds.includes('spec') ? Array.from(new Set([...status, ...Object.keys(facets?.status ?? {})])) : status;
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const hasResults = items.length > 0;
  const total = parsed.type === 'search' ? search.data?.total : parsed.type === 'phrase' ? phrase.data?.total : undefined;

  let state: ReactNode = null;
  if (error) {
    state = (
      <div className="cmdk-state" data-error="true" role="alert">
        {error.message}
        {error.hint && <div className="cmdk-hint">{error.hint}</div>}
      </div>
    );
  } else if (!hasResults && parsed.type !== 'empty') {
    state =
      searching && !current?.data ? (
        <div className="cmdk-state">
          <Loader size="xs" type="dots" />
        </div>
      ) : (
        <div className="cmdk-state">
          {parsed.type === 'id' ? `No spec, standard, work order or feedback with id "${parsed.id}"` : 'Nothing found'}
          {canFilter && (kinds.length > 0 || status.length > 0) && <div className="cmdk-hint">Try clearing the filters</div>}
        </div>
      );
  }

  return (
    <Modal
      opened={opened}
      onClose={close}
      withCloseButton={false}
      size={680}
      padding={0}
      yOffset="12vh"
      centered={false}
      classNames={{ root: 'cmdk-modal' }}
      transitionProps={{ duration: 120 }}
      trapFocus
      aria-label="Search"
    >
      <div onKeyDown={onKeyDown}>
        <div className="cmdk-input-row">
          <SearchField
            variant="input"
            size="lg"
            value={raw}
            onChange={setRaw}
            inputRef={inputRef as never}
            ariaLabel="Search"
            placeholder="Search specs, standards, work orders…  @symbol  /path  “phrase”  #id"
            loading={searching}
          />
        </div>
        {canFilter && (
          <div className="cmdk-chips">
            {KIND_ORDER.map((k) => (
              <button key={k} type="button" className="cmdk-chip" data-on={kinds.includes(k)} onClick={() => setKinds((v) => toggle(v, k))}>
                {KIND_LABEL[k]}
                {facets?.kinds?.[k] != null && <span className="cmdk-chip-count">{facets.kinds[k]}</span>}
              </button>
            ))}
            {statusOptions.length > 0 && <span className="cmdk-chip-sep" />}
            {statusOptions.map((s) => (
              <button key={s} type="button" className="cmdk-chip" data-on={status.includes(s)} onClick={() => setStatus((v) => toggle(v, s))}>
                {s.replace('_', ' ')}
                {facets?.status?.[s] != null && <span className="cmdk-chip-count">{facets.status[s]}</span>}
              </button>
            ))}
          </div>
        )}
        {state}
        {hasResults && (
          <div ref={listRef} className="cmdk-list" tabIndex={0} role="listbox" aria-label="Results" style={{ opacity: current?.isPlaceholderData ? 0.6 : 1 }}>
            {rows.map((r) => {
              if (r.type !== 'item') {
                return (
                  <div key={r.id} className={r.type === 'header' ? 'cmdk-header' : 'cmdk-label'}>
                    {r.node}
                  </div>
                );
              }
              const isActive = rows[items[Math.min(active, items.length - 1)]!]?.id === r.id;
              return (
                <div
                  key={r.id}
                  role="option"
                  aria-selected={isActive}
                  className="cmdk-row"
                  data-active={isActive}
                  data-flat={r.flat ? 'true' : undefined}
                  onMouseMove={() => setActive(items.indexOf(rows.indexOf(r)))}
                  onClick={r.select}
                >
                  {r.node}
                </div>
              );
            })}
          </div>
        )}
        <div className="cmdk-footer">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>Tab</Kbd> then <Kbd>C</Kbd> / <Kbd>⌘C</Kbd> copy reference</span>
          <span><Kbd>Esc</Kbd> close</span>
          {total != null && <span className="cmdk-total">{total} {total === 1 ? 'hit' : 'hits'}</span>}
        </div>
      </div>
    </Modal>
  );
}
