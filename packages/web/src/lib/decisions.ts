/**
 * Human decisions from the web UI: the pending list (`decisions_list`, the same tool agents use), the caller's access
 * (`decision_access`), and the few `uiAllowed` write tools (accept / reject / duplicate feedback, release a stale claim,
 * snooze an integrity warning). Writes go through the same MCP tools as agents' (gates, commits, activity).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { DecisionsList, IntegrityIssue } from '@mandate/shared';
import { callTool } from '../mcp/client';

export interface DecisionAccess {
  canDecide: boolean;
  mode: 'local' | 'server';
  user: string | null;
  override: { ok: boolean; why: string };
}

export function useDecisions(limit = 50) {
  return useQuery({ queryKey: ['overview', 'decisions', limit], queryFn: ({ signal }) => callTool<DecisionsList>('decisions_list', { limit }, signal), staleTime: 10_000 });
}

export function useDecisionAccess() {
  return useQuery({ queryKey: ['overview', 'decision-access'], queryFn: ({ signal }) => callTool<DecisionAccess>('decision_access', {}, signal), staleTime: 60_000 });
}

/** The UI-allowed write tools and their inputs. */
export type DecisionAction =
  | { tool: 'feedback_accept'; args: { ref: string; override?: boolean; overrideReason?: string } }
  | { tool: 'feedback_close'; args: { ref: string; resolution: 'rejected' | 'duplicate'; resolutionNote?: string; duplicateOf?: string } }
  | { tool: 'work_order_release'; args: { ref: string } }
  | { tool: 'integrity_snooze'; args: { rule: string; uri: string; days: number; note: string } };

export const ACTION_DONE: Record<DecisionAction['tool'], string> = {
  feedback_accept: 'Feedback accepted',
  feedback_close: 'Feedback closed',
  work_order_release: 'Claim released',
  integrity_snooze: 'Warning snoozed',
};

/** Run one decision; toasts the result (and any integrity issue it introduced); the activity event refreshes the rest. */
export function useDecide(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: DecisionAction) => callTool<{ integrity?: { introduced?: IntegrityIssue[] }; commit?: string | null }>(a.tool, a.args, undefined, { retry: false }),
    onMutate: async (a) => {
      // Optimistic: drop the decided item from the pending list.
      const ref = 'ref' in a.args ? a.args.ref : a.args.uri;
      const keys = qc.getQueriesData<DecisionsList>({ queryKey: ['overview', 'decisions'] });
      for (const [k, v] of keys) if (v) qc.setQueryData<DecisionsList>(k, { ...v, items: v.items.filter((d) => !refMatches(d.ref, ref)), total: Math.max(0, v.total - 1) });
      return { keys };
    },
    onError: (e, _a, ctx) => {
      for (const [k, v] of ctx?.keys ?? []) qc.setQueryData(k, v);
      notifications.show({ color: 'red', title: 'Not recorded', message: (e as Error).message });
    },
    onSuccess: (r, a) => {
      const introduced = r?.integrity?.introduced ?? [];
      notifications.show({
        color: introduced.length ? 'yellow' : 'teal',
        title: ACTION_DONE[a.tool],
        message: introduced.length ? `Recorded. It introduced ${introduced.length} integrity issue${introduced.length === 1 ? '' : 's'}: ${introduced.map((i) => i.rule.replace(/_/g, ' ')).join(', ')}` : 'Recorded in the project history.',
      });
      onDone?.();
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['overview'] }),
  });
}

/** A bare id (`fb-1`) and its full reference name the same item. */
export const refMatches = (a: string, b: string) => a === b || (!b.includes('/') && a.split('/').pop() === b);
