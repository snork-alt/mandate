/** What hangs off a request: its open questions, the work orders acting on it and the spec / standard changes. */
import type { FeedbackChange, Question, WorkOrder } from '@mandate/shared';
import { parseRef } from '@mandate/shared/refs';

/** The request id a question context (a request ref, current or old form) names. */
export const requestIdOfRef = (uri: string): string | undefined => {
  const r = parseRef(uri);
  return r?.kind === 'feedback' ? r.id : undefined;
};

/** Questions per request id (superseded ones left out; open first, newest first). */
export function questionsByRequest(questions: Question[]): Map<string, Question[]> {
  const m = new Map<string, Question[]>();
  for (const q of questions) {
    if (q.status === 'superseded') continue;
    for (const id of new Set(q.context.map(requestIdOfRef).filter((x): x is string => !!x))) m.set(id, [...(m.get(id) ?? []), q]);
  }
  for (const [id, list] of m) m.set(id, list.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.createdAt.localeCompare(a.createdAt)));
  return m;
}

/** Work orders per request id (a work order lists the requests it acts on in `reason`). */
export function workOrdersByRequest(workOrders: WorkOrder[]): Map<string, WorkOrder[]> {
  const m = new Map<string, WorkOrder[]>();
  for (const w of workOrders) for (const id of new Set(w.reason ?? [])) m.set(id, [...(m.get(id) ?? []), w]);
  return m;
}

/** One entry per changed document (the sections touched are in the tooltip / on the request page). */
export function changedDocs(changes: FeedbackChange[]): { key: string; kind: FeedbackChange['kind']; id: string; title: string }[] {
  const seen = new Map<string, { key: string; kind: FeedbackChange['kind']; id: string; title: string }>();
  for (const c of changes) if (!seen.has(c.uri)) seen.set(c.uri, { key: c.uri, kind: c.kind, id: c.id, title: c.docTitle ?? c.id });
  return [...seen.values()];
}

export const questionTitle = (q: Pick<Question, 'questions' | 'id'>) => q.questions[0]?.title ?? q.questions[0]?.question ?? q.id;
