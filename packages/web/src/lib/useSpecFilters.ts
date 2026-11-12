import { useSearchParams } from 'react-router';

export type GroupBy = 'category' | 'status' | 'priority' | 'none';
export const GROUP_BY: GroupBy[] = ['category', 'status', 'priority', 'none'];

const LIST_KEYS = ['status', 'priority', 'repo', 'tag', 'category'] as const;
export type FilterKey = (typeof LIST_KEYS)[number];

export interface SpecFilters {
  q: string;
  sort: 'updated' | 'created' | 'priority' | 'versions' | 'title';
  group: GroupBy;
  status: string[];
  priority: string[];
  repo: string[];
  tag: string[];
  category: string[];
}

/** Spec list filters, all kept in the URL (`?status=ready,done&group=status&q=...`). */
export function useSpecFilters() {
  const [params, setParams] = useSearchParams();
  const list = (k: string) => (params.get(k) ?? '').split(',').filter(Boolean);
  const group = params.get('group') as GroupBy | null;
  const filters: SpecFilters = {
    q: params.get('q') ?? '',
    sort: (['updated', 'created', 'versions', 'title'].includes(params.get('sort') ?? '') ? params.get('sort') : 'priority') as SpecFilters['sort'],
    group: group && GROUP_BY.includes(group) ? group : 'category',
    status: list('status'),
    priority: list('priority'),
    repo: list('repo'),
    tag: list('tag'),
    category: list('category'),
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
  const clear = () => update(Object.fromEntries(LIST_KEYS.map((k) => [k, []])));
  return { filters, update, activeCount, clear };
}
