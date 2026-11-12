export const RAIL_MIN = 320;
export const RAIL_MAX = 720;
export const RAIL_DEFAULT = 380;
/** Width of the collapsed icon strip. */
export const RAIL_STRIP = 40;

export type RailTab = 'details' | 'activity' | 'ask';
export type PageType = 'doc' | 'list';

const KEYS = { width: 'mandate.rail.width', collapsed: 'mandate.rail.collapsed', tabs: 'mandate.rail.tabs' } as const;

export const clampWidth = (n: number) => (Number.isFinite(n) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(n))) : RAIL_DEFAULT);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const loadWidth = () => {
  const v = read(KEYS.width);
  return v == null ? RAIL_DEFAULT : clampWidth(Number(v));
};
export const saveWidth = (w: number) => write(KEYS.width, String(clampWidth(w)));
export const loadCollapsed = () => read(KEYS.collapsed) === '1';
export const saveCollapsed = (c: boolean) => write(KEYS.collapsed, c ? '1' : '0');

/** Document pages (`/specs/x`, `/standards/x`, `/work-orders/x`, `/feedback/x`) vs everything else. */
export const pageTypeOf = (pathname: string): PageType => (/^\/(specs|standards|work-orders|feedback)\/[^/]+/.test(pathname) ? 'doc' : 'list');

export const tabsFor = (t: PageType): RailTab[] => (t === 'doc' ? ['details', 'activity', 'ask'] : ['activity', 'ask']);
export const defaultTab = (t: PageType): RailTab => (t === 'doc' ? 'details' : 'activity');

export type TabMemory = Partial<Record<PageType, RailTab>>;

export function loadTabs(): TabMemory {
  try {
    const o = JSON.parse(read(KEYS.tabs) ?? '{}') as TabMemory;
    const out: TabMemory = {};
    for (const t of ['doc', 'list'] as const) if (o[t] && tabsFor(t).includes(o[t]!)) out[t] = o[t];
    return out;
  } catch {
    return {};
  }
}
export const saveTabs = (m: TabMemory) => write(KEYS.tabs, JSON.stringify(m));
