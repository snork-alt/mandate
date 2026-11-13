import { useSearchParams } from 'react-router';

export type GroupBy = 'category' | 'maturity' | 'priority' | 'none';
export const GROUP_BY: GroupBy[] = ['category', 'maturity', 'priority', 'none'];

const LIST_KEYS = ['status', 'priority', 'repo', 'tag', 'category', 'audit', 'maturity'] as const;
export type FilterKey = (typeof LIST_KEYS)[number];

export interface SpecFilters {
  q: string;
  sort: 'updated' | 'created' | 'priority' | 'versions' | 'title' | 'audited' | 'maturity';
  group: GroupBy;
  /** Author-set (stored) status: legacy `?status=` links only; the UI filters by maturity. */
  status: string[];
  priority: string[];
  repo: string[];
  tag: string[];
  category: string[];
  /** Audit state: never / stale / open (open findings). */
  audit: string[];
  /** Maturity steps / overlays. */
  maturity: string[];
}

/** Spec list filters, all kept in the URL (`?status=ready,done&group=status&q=...`). */
export function useSpecFilters() {
  const [params, setParams] = useSearchParams();
  const list = (k: string) => (params.get(k) ?? '').split(',').filter(Boolean);
  // `group=status` (before maturity became the one state) groups by maturity.
  const rawGroup = params.get('group');
  const group = (rawGroup === 'status' ? 'maturity' : rawGroup) as GroupBy | null;
  const filters: SpecFilters = {
    q: params.get('q') ?? '',
    sort: (['updated', 'created', 'versions', 'title', 'audited', 'maturity'].includes(params.get('sort') ?? '') ? params.get('sort') : 'priority') as SpecFilters['sort'],
    group: group && GROUP_BY.includes(group) ? group : 'category',
    status: list('status'),
    priority: list('priority'),
    repo: list('repo'),
    tag: list('tag'),
    category: list('category'),
    audit: list('audit'),
    maturity: list('maturity'),
  };
  const update = (patch: Partial<Record<string, string | string[]>>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) {
          const value = Array.isArray(v) ? v.join(',') : (v ?? '');
          if (value && !(k === 'group' && value === 'category') && !(k === 'sort' && value === 'priority')) p.set(k, value);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );
  const activeCount = LIST_KEYS.reduce((n, k) => n + (filters[k].length ? 1 : 0), 0);
  /** Clears the list filters (and the search text with `{ q: true }`) in one URL update: consecutive `update` calls each start from the same render's params and overwrite each other. */
  const clear = (opts?: { q?: boolean }) => update(Object.fromEntries([...LIST_KEYS.map((k) => [k, []]), ...(opts?.q ? [['q', '']] : [])]));
  return { filters, update, activeCount, clear };
}
