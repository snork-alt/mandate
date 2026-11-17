/** What hangs off a request: its open questions, the work orders acting on it and the spec / standard changes. */
import type { FeedbackChange, Question, WorkOrder } from '@mandate/shared';
import { parseBlockRef } from '@mandate/shared';
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
    for (const id of new Set([...q.context.map(requestIdOfRef), q.request].filter((x): x is string => !!x))) m.set(id, [...(m.get(id) ?? []), q]);
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

/** What a question blocks, as a link: a request, work order, task (a `/tasks/tN` reference) or a section. */
export function blockTarget(ref: string): { label: string; href: string | null; kind: 'request' | 'work-order' | 'step' | 'section' } {
  const b = parseBlockRef(ref);
  if (b?.kind === 'step') return { label: `task ${b.step} of ${b.workOrder}`, href: `/work-orders/${b.workOrder}`, kind: 'step' };
  if (b?.kind === 'request') return { label: b.id, href: `/requests/${b.id}`, kind: 'request' };
  if (b?.kind === 'work-order') return { label: b.id, href: `/work-orders/${b.id}`, kind: 'work-order' };
  if (b?.kind === 'section') return { label: `${b.id} · ${b.sectionId}`, href: `/${b.doc}/${b.id}`, kind: 'section' };
  return { label: ref, href: null, kind: 'section' };
}

/** Open questions bound to a request (a question with `request`, or naming it as context): the user is asked to answer. */
export const waitingRequestIds = (open: Question[]): Set<string> => new Set([...questionsByRequest(open.filter((q) => q.status === 'open')).keys()]);

const wosOf = (q: Question): string[] =>
  (q.blocks ?? []).flatMap((b) => {
    const p = parseBlockRef(b);
    return p?.kind === 'work-order' || p?.kind === 'section' && p.doc === 'work-orders' ? [p.id] : p?.kind === 'step' ? [p.workOrder] : [];
  });

/** Open questions that block a work order, one of its tasks or sections (`blocks`). */
export const questionsBlockingWorkOrder = (questions: Question[], woId: string): Question[] => questions.filter((q) => q.status === 'open' && wosOf(q).includes(woId));

/** Work order ids with at least one open blocking question. */
export const blockedWorkOrderIds = (questions: Question[]): Set<string> => new Set(questions.filter((q) => q.status === 'open').flatMap(wosOf));
