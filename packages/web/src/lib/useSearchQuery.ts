import { useSearchParams } from 'react-router';

/** Search text persisted in the `?q=` URL param. */
export function useSearchQuery(): [string, (q: string) => void] {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const setQ = (next: string) =>
    setParams(
      (p) => {
        if (next) p.set('q', next);
        else p.delete('q');
        return p;
      },
      { replace: true },
    );
  return [q, setQ];
}

export function matches(q: string, ...fields: (string | undefined)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f?.toLowerCase().includes(needle));
}
