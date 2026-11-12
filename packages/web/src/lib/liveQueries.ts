import { useEffect } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { parseRef } from '@mandate/shared/refs';
import { onNotification, onConnectionChange } from '../mcp/client';
import { ACTIVITY_METHOD, toActivityEvent, type ActivityEvent } from '../components/activity/types';

const DEBOUNCE_MS = 150;
/** Cache keys that are not scoped to a document (git state, architecture view, the Overview aggregate; section types never change). */
const GLOBAL_KEYS = new Set(['git', 'git-log', 'architecture', 'overview']);

/** Which cached queries does a batch of events make stale? `git.pulled` (or reconnect) invalidates everything. */
export function matchesEvents(key: QueryKey, events: Pick<ActivityEvent, 'type' | 'refs'>[]): boolean {
  if (events.some((e) => e.type === 'git.pulled')) return true;
  const head = key[0];
  if (typeof head !== 'string') return false;
  // Integrity changed (counts, gaps): the git status (sidebar count) and the spec / component lists and pages.
  if (events.some((e) => e.type === 'integrity.changed') && (head === 'specs' || head === 'components')) return true;
  if (GLOBAL_KEYS.has(head)) return true;
  if (head === 'section-types') return false;
  if (head === 'mcp') return true; // search, graph and node results derive from any document
  for (const e of events) {
    for (const r of e.refs) {
      const p = parseRef(r);
      if (!p || p.kind !== head) continue;
      // The kind's list (`[kind]`) and that document's detail / history / raw / version / feedback / implementation.
      if (key.length === 1 || key[1] === p.id) return true;
    }
  }
  return false;
}

export function invalidateForEvents(qc: QueryClient, events: Pick<ActivityEvent, 'type' | 'refs'>[]): void {
  void qc.invalidateQueries({ predicate: (q) => matchesEvents(q.queryKey, events) });
}

/** Subscribe (via the shared MCP client) to activity notifications and refetch the affected queries, debounced. */
export function useLiveQueries(): void {
  const qc = useQueryClient();
  useEffect(() => {
    type Ev = Pick<ActivityEvent, 'type' | 'refs'>;
    let pending: Ev[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      if (batch.length) invalidateForEvents(qc, batch);
    };
    const push = (events: Ev[]) => {
      pending.push(...events);
      timer ??= setTimeout(flush, DEBOUNCE_MS);
    };
    const offN = onNotification((n) => {
      if (n.method !== ACTIVITY_METHOD) return;
      const e = toActivityEvent(n.params);
      if (e) push([e]);
    });
    let first = true;
    const offC = onConnectionChange((connected) => {
      if (!connected) return;
      if (first) first = false;
      else push([{ type: 'git.pulled', refs: [] }]); // missed events while disconnected
    });
    return () => {
      offN();
      offC();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
}
