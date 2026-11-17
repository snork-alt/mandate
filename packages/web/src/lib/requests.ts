/**
 * Requests filed from the web UI (the same as `/mandate <text>` in the CLI): create (`request_create`, a uiAllowed
 * write tool: source "ui"), reassign (`request_assign`), approve a plan-only request (`request_plan_approve`), the live
 * flow state of a request (`flow_next` read by the UI never takes the request), and the 6-stage flow bar.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { Feedback } from '@mandate/shared';
import { callTool } from '../mcp/client';
import type { PresenceReply } from './comments';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Priority = 'low' | 'normal' | 'high';
export interface NewRequestInput {
  body: string;
  /** Client id / handle of the agent, or `any`. */
  assignee: string;
  priority: Priority;
  planOnly: boolean;
  /** Objects chosen with @ (also extracted from the body by the server). */
  context?: string[];
}

export interface FlowProgress {
  workOrder: string;
  kind: string;
  status: string;
  steps: { id: string; text: string; status: string }[];
  sections: { total: number; done: number };
  criteria: { total: number; proved: number };
}
export interface FlowState {
  state: string;
  next: { tool: string; why: string } | null;
  queued?: boolean;
  done: boolean;
  waitingOn?: string[];
  waitingOnWorkOrders?: { workOrder: string; why: string }[];
  progress?: FlowProgress;
}

/** Live flow state of one request (refetched on its activity events and every few seconds while it is open). */
export function useRequestFlow(id: string, enabled = true) {
  return useQuery({
    queryKey: ['feedback', id, 'flow'],
    enabled,
    queryFn: ({ signal }) => callTool<FlowState>('flow_next', { request: id }, signal),
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

const invalidate = (qc: ReturnType<typeof useQueryClient>, id?: string) => {
  void qc.invalidateQueries({ queryKey: ['feedback'] });
  if (id) void qc.invalidateQueries({ queryKey: ['agents-presence'] });
};

export function useCreateRequest(onCreated: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: NewRequestInput) =>
      callTool<{ request: { id: string }; queued?: boolean }>(
        'request_create',
        { kind: 'improvement', body: a.body, assignee: a.assignee, priority: a.priority, ...(a.planOnly ? { planOnly: true } : {}), ...(a.context?.length ? { context: a.context } : {}) },
        undefined,
        { retry: false },
      ),
    onError: (e) => notifications.show({ color: 'red', title: 'Request not sent', message: errorText(e) }),
    onSuccess: (r) => {
      invalidate(qc);
      onCreated(r.request.id);
    },
  });
}

export function useAssignRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; assignee: string }) => callTool<unknown>('request_assign', { ref: a.id, assignee: a.assignee }, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Not reassigned', message: errorText(e) }),
    onSettled: (_r, _e, a) => invalidate(qc, a.id),
  });
}

export function useApprovePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => callTool<unknown>('request_plan_approve', { ref: id }, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Plan not approved', message: errorText(e) }),
    onSettled: (_r, _e, id) => invalidate(qc, id),
  });
}

/* ------------------------------------------------------------------ assignee and state */

/** A readable name for an assignee (client id / `any`): the presence label when known. */
export function assigneeLabel(assignee: string | undefined, presence?: PresenceReply): string {
  if (!assignee) return 'Unassigned';
  if (assignee === 'any') return 'Any agent';
  return presence?.agents.find((a) => a.id === assignee || a.handle === assignee)?.label ?? assignee;
}
export function assigneeState(assignee: string | undefined, presence?: PresenceReply): 'online' | 'busy' | 'offline' | undefined {
  if (!assignee || assignee === 'any') return undefined;
  return presence?.agents.find((a) => a.id === assignee || a.handle === assignee)?.state ?? 'offline';
}

/** Queued: assigned to an agent that has not started it. Plan ready: plan-only and its work order exists. */
export const isQueued = (f: Pick<Feedback, 'status' | 'assignee' | 'startedBy'>) => f.status !== 'closed' && !!f.assignee && !f.startedBy;
export const isPlanReady = (f: Pick<Feedback, 'status' | 'planOnly'>, hasWorkOrder: boolean) => f.status !== 'closed' && !!f.planOnly && hasWorkOrder;

/* ------------------------------------------------------------------ the flow bar */

export type StageStatus = 'done' | 'active' | 'todo' | 'waiting';
export interface Stage {
  key: 'recorded' | 'matched' | 'spec' | 'plan' | 'implementing' | 'proved';
  label: string;
  status: StageStatus;
  detail?: string;
}

/** The six stages of a request, from its stored fields and the live flow state. */
export function requestStages(f: Pick<Feedback, 'status' | 'specMatch' | 'changes' | 'planOnly'>, flow: FlowState | undefined): Stage[] {
  const p = flow?.progress;
  const closed = f.status === 'closed';
  const state = flow?.state ?? '';
  const planReady = state === 'plan_ready';
  const matched = closed || !!f.specMatch || !!p;
  const specDone = closed || f.changes.length > 0 || !!p;
  const planDone = closed || !!p;
  const stepsDone = p ? p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length : 0;
  const stepsTotal = p?.steps.length ?? 0;
  const implDone = closed || (!!p && p.sections.total > 0 && p.sections.done >= p.sections.total && stepsDone >= stepsTotal);
  const provedDone = closed;
  const flags = [true, matched, specDone, planDone, implDone, provedDone];
  const firstTodo = flags.indexOf(false);
  const mk = (i: number, key: Stage['key'], label: string, detail?: string): Stage => ({
    key,
    label,
    ...(detail ? { detail } : {}),
    status: flags[i] ? 'done' : i === firstTodo ? (planReady && key === 'implementing' ? 'waiting' : 'active') : 'todo',
  });
  return [
    mk(0, 'recorded', 'Recorded'),
    mk(1, 'matched', 'Matched'),
    mk(2, 'spec', 'Spec updated', f.changes.length ? `${f.changes.length} change${f.changes.length === 1 ? '' : 's'}` : undefined),
    mk(3, 'plan', 'Work order + plan', p ? `${stepsTotal} step${stepsTotal === 1 ? '' : 's'}` : undefined),
    mk(4, 'implementing', 'Implementing', planReady ? 'waiting for plan approval' : p && stepsTotal ? `step ${Math.min(stepsDone + (implDone ? 0 : 1), stepsTotal)} of ${stepsTotal}` : undefined),
    mk(5, 'proved', 'Proved & done', p ? `${p.criteria.proved} of ${p.criteria.total} criteria` : undefined),
  ];
}
