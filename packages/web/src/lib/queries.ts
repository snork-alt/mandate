import { useQuery } from '@tanstack/react-query';
import type { EntityKind, Feedback, WorkOrder, Spec, Standard } from '@mandate/shared';
import { api } from '../api';

/** Shared list query so the sidebar counts, lists and pickers reuse one cache entry per kind. */
export function useEntityList(kind: EntityKind) {
  return useQuery({ queryKey: [kind], queryFn: () => api.list(kind) });
}

export function useSpecs(enabled = true) {
  return useQuery({ queryKey: ['specs'], queryFn: () => api.list('specs') as Promise<Spec[]>, enabled });
}

export function useWorkOrders() {
  return useQuery({ queryKey: ['work-orders'], queryFn: () => api.list('work-orders') as Promise<WorkOrder[]> });
}

export function useStandards() {
  return useQuery({ queryKey: ['standards'], queryFn: () => api.list('standards') as Promise<Standard[]> });
}

export function useSpec(id: string) {
  return useQuery({ queryKey: ['specs', id], queryFn: () => api.get('specs', id) as Promise<Spec> });
}

export function useHistory(kind: 'specs' | 'standards' | 'components' | 'audits' | 'work-orders', id: string) {
  return useQuery({ queryKey: [kind, id, 'history'], queryFn: () => api.history(kind, id) });
}

export function useStandard(id: string) {
  return useQuery({ queryKey: ['standards', id], queryFn: () => api.get('standards', id) as Promise<Standard> });
}

export function useStandardUsage(id: string) {
  return useQuery({ queryKey: ['standards', id, 'usage'], queryFn: () => api.standardUsage(id) });
}

export function useFeedback() {
  return useQuery({ queryKey: ['feedback'], queryFn: () => api.list('feedback') as Promise<Feedback[]> });
}

export function useDocFeedback(kind: 'specs' | 'standards', id: string) {
  return useQuery({ queryKey: [kind, id, 'feedback'], queryFn: () => api.docFeedback(kind, id) });
}
