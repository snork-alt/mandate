/**
 * Agent audits requested from the web UI: `audit_request` (a uiAllowed write tool: the audit is queued for the chosen
 * agent), the audits waiting / running for a target with their live progress, and the quick section actions of the
 * Outdated / Upstream changed badges (Accept = `section_accept` / `section_link_ack`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { AuditSummary } from '@mandate/shared';
import { callTool } from '../mcp/client';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useRequestAudit(onDone?: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { target: string; assignee: string; note?: string }) => callTool<{ audit: { id: string }; queued?: boolean }>('audit_request', a, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Audit not requested', message: errorText(e) }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      onDone?.(r.audit.id);
    },
  });
}

/** Audits of a target that are queued (requested) or running, refreshed every few seconds while any exist. */
export function useActiveAudits(target: string | undefined) {
  return useQuery({
    queryKey: ['audits', 'active', target ?? ''],
    enabled: !!target,
    queryFn: ({ signal }) => callTool<{ audits: AuditSummary[] }>('audit_list', { target, status: ['requested', 'in_progress'] }, signal).then((r) => r.audits),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 3000 : 15_000),
    staleTime: 2000,
  });
}

/** "Accept": an Outdated section is wording only, or the upstream changes of a section have no impact. */
export function useAcceptSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { ref: string; kind: 'outdated' | 'upstream'; to?: string; reason?: string }) =>
      a.kind === 'outdated'
        ? callTool('section_accept', { ref: a.ref, ...(a.reason ? { reason: a.reason } : {}) }, undefined, { retry: false })
        : callTool('section_link_ack', { ref: a.ref, ...(a.to ? { to: a.to } : {}), ...(a.reason ? { reason: a.reason } : {}) }, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Not accepted', message: errorText(e) }),
    onSuccess: () => void qc.invalidateQueries(),
  });
}
