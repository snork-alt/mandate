/**
 * What only the user can do (the "Only you can do this" part of Waiting for you, and its sidebar badge): questions from
 * agents, approvals (pending waivers, standard drafts), plans to approve (plan-only requests) and comments addressed to
 * the user. Project health (drift, stale claims, integrity, audits, findings, blocked) is not counted.
 */
import { useQuery } from '@tanstack/react-query';
import type { CommentThread } from '@mandate/shared';
import { callTool } from '../mcp/client';
import { useDecisionAccess, useDecisions } from './decisions';

/** Plan-only requests whose plan is ready for the user's review. */
export function usePlansToApprove() {
  return useQuery({
    queryKey: ['feedback', 'plans-to-approve'],
    queryFn: async ({ signal }) => {
      const r = await callTool<{ requests?: { request: string; summary: string; state: string }[] }>('flow_next', {}, signal);
      return (r.requests ?? []).filter((x) => x.state === 'plan_ready').map((x) => ({ id: x.request.split('/').pop()!, summary: x.summary }));
    },
    refetchInterval: 15_000,
    staleTime: 5000,
  });
}

/** Open comment threads addressed to the signed-in user. */
export function useCommentsForMe() {
  const access = useDecisionAccess();
  const login = access.data?.user ?? null;
  return useQuery({
    queryKey: ['comments', 'addressed-to', login],
    enabled: !!login,
    queryFn: ({ signal }) => callTool<{ threads: CommentThread[] }>('comments_list', { addressedTo: login }, signal).then((r) => r.threads),
    refetchInterval: 20_000,
    staleTime: 5000,
  });
}

export interface WaitingCounts {
  questions: number;
  approvals: number;
  plans: number;
  comments: number;
  total: number;
}

/** The counts of the "Only you can do this" part (the sidebar badge shows `total`). */
export function useWaitingCounts(): WaitingCounts {
  const d = useDecisions(50).data;
  const plans = usePlansToApprove().data?.length ?? 0;
  const comments = useCommentsForMe().data?.length ?? 0;
  const questions = d?.counts.question ?? 0;
  const approvals = (d?.counts.waiver_pending ?? 0) + (d?.counts.standard_proposal ?? 0);
  return { questions, approvals, plans, comments, total: questions + approvals + plans + comments };
}
