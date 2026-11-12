import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileVersion } from '@mandate/shared';
import { useSearchParams } from 'react-router';
import { api } from '../../../api';
import { McpToolError } from '../../../mcp/client';
import type { DiffableKind } from '../../../lib/docDiff';
import type { TrackedData } from './compute';

export interface TrackedState {
  /** Commit being viewed (`?version=`), if any. */
  commit: string | null;
  compare: 'prev' | 'current';
  /** `version`: show the document as it was at that commit (plain, read-only); `changes`: track changes. */
  view: 'changes' | 'version';
  setView: (v: 'changes' | 'version') => void;
  version?: FileVersion;
  data?: TrackedData;
  loading: boolean;
  error?: Error;
  /** The error is "this commit does not exist / did not touch the file" (vs. a version that cannot be read). */
  notFound: boolean;
  select: (commit: string) => void;
  setCompare: (c: 'prev' | 'current') => void;
  exit: () => void;
}

/** Tracked-changes mode, driven by `?version=<commit>&compare=prev|current` so it is linkable. */
export function useTrackedChanges(kind: DiffableKind, id: string): TrackedState {
  const [params, setParams] = useSearchParams();
  const commit = params.get('version');
  const compare = params.get('compare') === 'current' ? 'current' : 'prev';
  const view = params.get('view') === 'version' ? 'version' : 'changes';
  const against = compare === 'current' ? 'head' : 'parent';

  const version = useQuery({
    queryKey: [kind, id, 'version', commit, against],
    queryFn: () => api.version(kind, id, commit!, against),
    enabled: !!commit,
    staleTime: Infinity,
  });
  const types = useQuery({ queryKey: ['section-types'], queryFn: api.sectionTypes, staleTime: Infinity, enabled: !!commit });
  const data = useQuery({
    queryKey: [kind, id, 'tracked', commit, against],
    enabled: !!version.data && !!types.data,
    staleTime: Infinity,
    // The diff engine (doc parser, jsdiff, remark) loads on demand.
    queryFn: async () => (await import('./compute')).computeTracked(kind, version.data!, types.data!),
  });

  const update = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (p) => {
          for (const [k, v] of Object.entries(patch)) {
            if (v) p.set(k, v);
            else p.delete(k);
          }
          return p;
        },
        { replace: false },
      ),
    [setParams],
  );
  const exit = useCallback(() => update({ version: null, compare: null, view: null }), [update]);

  useEffect(() => {
    if (!commit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) exit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, exit]);

  return {
    commit,
    compare,
    view,
    setView: (v) => update({ view: v === 'version' ? 'version' : null }),
    version: version.data,
    data: data.data,
    loading: !!commit && (version.isPending || data.isPending),
    error: (version.error ?? data.error ?? undefined) as Error | undefined,
    notFound: version.error instanceof McpToolError && version.error.code === 'not_found',
    select: (c) => update({ version: c }),
    setCompare: (c) => update({ compare: c === 'current' ? 'current' : null }),
    exit,
  };
}
