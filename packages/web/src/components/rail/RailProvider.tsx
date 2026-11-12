import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { callTool, onConnectionChange, onNotification } from '../../mcp/client';
import { ACTIVITY_METHOD, MAX_ACTIVITY_EVENTS, toActivityEvent, type ActivityEvent } from '../activity/types';
import {
  RAIL_STRIP,
  clampWidth,
  defaultTab,
  isMobileWidth,
  loadCollapsed,
  loadTabs,
  loadWidth,
  pageTypeOf,
  saveCollapsed,
  saveTabs,
  saveWidth,
  tabsFor,
  type PageType,
  type RailTab,
  type TabMemory,
} from './persistence';

export interface RailState {
  pageType: PageType;
  tabs: RailTab[];
  activeTab: RailTab;
  collapsed: boolean;
  width: number;
  setWidth: (w: number) => void;
  selectTab: (t: RailTab) => void;
  /** Shortcut behaviour: show the tab, or collapse the rail when it is already the visible one. */
  toggleTab: (t: RailTab) => void;
  collapse: () => void;
  /** DOM node the Details tab renders into (see RailDetails). */
  detailsSlot: HTMLElement | null;
  setDetailsSlot: (el: HTMLElement | null) => void;
  events: ActivityEvent[];
  unread: number;
  pushEvent: (e: ActivityEvent) => void;
  /** Live connection of the MCP session (the feed backfills on reconnect). */
  connected: boolean;
  /** The first `activity_list` settled (resolved or failed): before that the feed is loading, not empty. */
  loaded: boolean;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Live events held back while paused. */
  buffered: number;
  /** Ids of events that arrived live (the panel slides them in). */
  fresh: ReadonlySet<string>;
}

const Ctx = createContext<RailState | null>(null);
/** Null outside a RailProvider (tests, standalone pages). */
export const useRailOptional = () => useContext(Ctx);
export function useRail(): RailState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRail outside RailProvider');
  return v;
}

export interface ActivityDeps {
  subscribe: (handler: (e: ActivityEvent) => void) => () => void;
  /** `activity_list`: newest first; `head` is the cursor for `since` on reconnect. */
  list: (args: { since?: string; limit?: number }) => Promise<{ events: ActivityEvent[]; head?: string }>;
  watchConnection: (handler: (connected: boolean) => void) => () => void;
}

const liveDeps: ActivityDeps = {
  subscribe: (handler) =>
    onNotification((n) => {
      if (n.method !== ACTIVITY_METHOD) return;
      const e = toActivityEvent(n.params);
      if (e) handler(e);
    }),
  list: (args) => callTool('activity_list', args),
  watchConnection: onConnectionChange,
};

const byTimeDesc = (a: ActivityEvent, b: ActivityEvent) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
const keyOf = (e: ActivityEvent) => `${e.id}|${e.type}`;
/** Merge events newest first, de-duplicated by id and type. */
export function mergeEvents(list: ActivityEvent[], incoming: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set(list.map(keyOf));
  const add = incoming.filter((e) => !seen.has(keyOf(e)) && seen.add(keyOf(e)));
  return add.length ? [...add, ...list].sort(byTimeDesc).slice(0, MAX_ACTIVITY_EVENTS) : list;
}

export function RailProvider({ children, activity }: { children: ReactNode; activity?: Partial<ActivityDeps> }) {
  const deps = { ...liveDeps, ...activity };
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const { pathname } = useLocation();
  const pageType = pageTypeOf(pathname);
  const tabs = tabsFor(pageType);
  const [memory, setMemory] = useState<TabMemory>(loadTabs);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed());
  const [width, setWidthState] = useState(loadWidth);
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [buffer, setBuffer] = useState<ActivityEvent[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const head = useRef<string | undefined>(undefined);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const activeTab = memory[pageType] ?? defaultTab(pageType);

  const setWidth = useCallback((w: number) => {
    const c = clampWidth(w);
    setWidthState(c);
    saveWidth(c);
  }, []);
  // An explicit open / collapse is remembered, except on mobile (the sheet always starts collapsed there).
  const setCollapsedP = useCallback((c: boolean) => {
    setCollapsed(c);
    if (!isMobileWidth()) saveCollapsed(c);
  }, []);
  // Shrinking into the mobile layout closes the sheet so it never covers the page unasked.
  useEffect(() => {
    const onResize = () => {
      if (isMobileWidth()) setCollapsed(true);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const selectTab = useCallback(
    (t: RailTab) => {
      if (!tabsFor(pageType).includes(t)) return;
      setMemory((m) => {
        const next = { ...m, [pageType]: t };
        saveTabs(next);
        return next;
      });
      setCollapsedP(false);
    },
    [pageType, setCollapsedP],
  );
  const toggleTab = useCallback(
    (t: RailTab) => {
      if (!tabsFor(pageType).includes(t)) return;
      if (!collapsed && activeTab === t) setCollapsedP(true);
      else selectTab(t);
    },
    [pageType, collapsed, activeTab, selectTab, setCollapsedP],
  );

  // Latest visibility for the event subscription without resubscribing.
  const visible = useRef(false);
  visible.current = !collapsed && activeTab === 'activity';
  const pushEvent = useCallback((e: ActivityEvent) => {
    if (!visible.current) setUnread((n) => n + 1);
    if (pausedRef.current) {
      setBuffer((b) => [e, ...b]);
      return;
    }
    setEvents((list) => mergeEvents(list, [e]));
    setFresh((f) => new Set(f).add(keyOf(e)));
  }, []);
  const setPaused = useCallback((p: boolean) => {
    setPausedState(p);
    if (!p) {
      setBuffer((b) => {
        if (b.length) {
          setEvents((list) => mergeEvents(list, b));
          setFresh((f) => new Set([...f, ...b.map(keyOf)]));
        }
        return [];
      });
    }
  }, []);
  const backfill = useCallback(async (since?: string) => {
    try {
      const r = await depsRef.current.list({ ...(since ? { since } : {}), limit: 100 });
      if (r.head) head.current = r.head;
      setEvents((list) => mergeEvents(list, r.events));
    } catch {
      /* offline: the feed fills when the connection is back */
    } finally {
      setLoaded(true);
    }
  }, []);
  const subscribe = deps.subscribe;
  const watchConnection = deps.watchConnection;
  useEffect(() => subscribe(pushEvent), [subscribe, pushEvent]);
  useEffect(() => {
    void backfill();
    let first = true;
    return watchConnection((c) => {
      setConnected(c);
      if (c && !first) void backfill(head.current);
      if (c) first = false;
    });
  }, [watchConnection, backfill]);
  useEffect(() => {
    if (!collapsed && activeTab === 'activity') setUnread(0);
  }, [collapsed, activeTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' && !e.shiftKey) (e.preventDefault(), toggleTab('ask'));
      else if (k === 'a' && e.shiftKey) (e.preventDefault(), toggleTab('activity'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleTab]);

  // The page reserves room for the rail through this variable (see rail.css).
  useEffect(() => {
    document.documentElement.style.setProperty('--rail-offset', `${collapsed ? RAIL_STRIP : width}px`);
  }, [collapsed, width]);

  const value = useMemo<RailState>(
    () => ({ pageType, tabs, activeTab, collapsed, width, setWidth, selectTab, toggleTab, collapse: () => setCollapsedP(true), detailsSlot, setDetailsSlot, events, unread, pushEvent, connected, loaded, paused, setPaused, buffered: buffer.length, fresh }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageType, activeTab, collapsed, width, setWidth, selectTab, toggleTab, setCollapsedP, detailsSlot, events, unread, pushEvent, connected, loaded, paused, setPaused, buffer.length, fresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
