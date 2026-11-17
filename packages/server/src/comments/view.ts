/**
 * The UI context of a comment: what the user saw on the target when writing it (implementation state incl. Outdated,
 * statuses, badges and their meaning, the selected text). Stored with the comment, delivered with the event and the
 * thread reads, so an agent answers from facts instead of guessing what the screen shows.
 */
import { parseCommentTarget, UI_BADGE_MEANING, type CommentContext, type SectionImplementation } from '@mandate/shared';
import type { Storage } from '../storage/index.js';

const badge = (label: keyof typeof UI_BADGE_MEANING | string, meaning?: string) => ({ label, meaning: meaning ?? (UI_BADGE_MEANING as Record<string, string>)[label] ?? '' });

export async function commentViewOf(storage: Storage, target: string, selectedText?: string, now = new Date()): Promise<CommentContext | undefined> {
  const t = parseCommentTarget(target);
  if (!t) return undefined;
  const at = now.toISOString();
  const sel = selectedText?.trim() ? { selectedText: selectedText.trim().slice(0, 2000) } : {};
  try {
    if (t.kind === 'specs') {
      const spec = await storage.specs.get(t.id);
      if (!t.sectionId) return { object: `spec "${spec.title}"`, status: spec.status, badges: [], at, ...sel };
      const sec = spec.sections.find((s) => s.id === t.sectionId);
      const object = `spec "${spec.title}" > section "${sec?.title ?? t.sectionId}"`;
      const impl = ((await storage.workOrderService.implementation(t.id).catch(() => ({}))) as SectionImplementation)[t.sectionId];
      const open = (await storage.workOrderService.list()).filter((w) => w.spec === t.id && ['pending', 'in_progress'].includes(w.status) && w.sections.some((x) => x.id === t.sectionId && x.status !== 'obsolete'));
      const badges: CommentContext['badges'] = [];
      let implementation: CommentContext['implementation'];
      if (!sec?.implementedCommit || !impl) {
        implementation = { state: 'not_implemented' };
        badges.push(badge('Not implemented'));
      } else if (impl.outdated) {
        implementation = { state: 'outdated', implementedCommit: impl.implementedCommit!, ...(impl.implementedBy ? { implementedBy: impl.implementedBy } : {}), ...(impl.changedBy ? { changedBy: impl.changedBy } : {}), ...(impl.changedAt ? { changedAt: impl.changedAt } : {}), ...(impl.changedCommit ? { changedCommit: impl.changedCommit } : {}) };
        badges.push(badge('Outdated', `${UI_BADGE_MEANING.Outdated}. Changed since commit ${impl.implementedCommit?.slice(0, 7)}${impl.changedBy ? ` by ${impl.changedBy}` : ''}${impl.changedAt ? ` on ${impl.changedAt.slice(0, 10)}` : ''}`));
      } else {
        implementation = { state: 'implemented', implementedCommit: impl.implementedCommit!, ...(impl.implementedBy ? { implementedBy: impl.implementedBy } : {}) };
        badges.push(badge('Implemented @x', `implemented at spec commit ${impl.implementedCommit?.slice(0, 7)}${impl.implementedBy ? ` by ${impl.implementedBy}` : ''}; unchanged since`));
      }
      return { object, status: spec.status, implementation, ...(open.length ? { details: { openWorkOrders: open.map((w) => `${w.id} (${w.status})`).join(', ') } } : {}), badges, at, ...sel };
    }
    if (t.kind === 'work-orders') {
      const w = await storage.workOrderService.get(t.id);
      const task = t.step ? (w.planSteps ?? []).find((s) => s.id === t.step) : undefined;
      const details: Record<string, string> = { kind: w.kind, spec: w.spec, ...(w.claim ? { claimedBy: w.claim.agent } : {}) };
      if (task) Object.assign(details, { task: `${task.id} ${task.status}: ${task.text.slice(0, 120)}` });
      else if (w.planSteps?.length) details.tasks = w.planSteps.map((s) => `${s.id} ${s.status}`).join(', ');
      return { object: `work order ${w.id}${task ? ` > task ${task.id}` : ''}`, status: task?.status ?? w.status, details, badges: [], at, ...sel };
    }
    if (t.kind === 'requests') {
      const f = await storage.feedbackService.get(t.id);
      const badges: CommentContext['badges'] = [];
      if (f.planOnly) badges.push(badge('Plan ready', f.planOnly ? 'plan-only request: the agent stops after the plan; the user approves it' : undefined));
      if (f.assignee && !f.startedBy && f.status !== 'closed') badges.push(badge('Queued'));
      return { object: `request ${f.id}`, status: f.status, details: { kind: f.kind, ...(f.assignee ? { assignee: f.assignee } : {}), ...(f.startedBy ? { startedBy: f.startedBy } : {}) }, badges, at, ...sel };
    }
    const doc = t.kind === 'standards' ? await storage.standards.get(t.id) : await storage.components.get(t.id);
    const sec = t.sectionId ? doc.sections.find((s) => s.id === t.sectionId) : undefined;
    return { object: `${t.kind === 'standards' ? 'standard' : 'component'} "${doc.title}"${sec ? ` > section "${sec.title}"` : ''}`, status: doc.status, badges: [], at, ...sel };
  } catch {
    return sel.selectedText ? { object: target.replace('mandate://', ''), ...sel, at } : undefined;
  }
}

/** One line of the view for the event text an agent receives. */
export function viewLine(v: CommentContext | undefined): string {
  if (!v) return '';
  const parts = [v.object, v.status ? `status ${v.status}` : '', v.implementation ? `UI shows ${v.implementation.state === 'outdated' ? `Outdated (changed since ${v.implementation.implementedCommit?.slice(0, 7)}${v.implementation.changedBy ? ` by ${v.implementation.changedBy}` : ''})` : v.implementation.state === 'implemented' ? `Implemented @${v.implementation.implementedCommit?.slice(0, 7)}` : 'Not implemented'}` : '', v.selectedText ? `selected: "${v.selectedText.replace(/\s+/g, ' ').slice(0, 120)}"` : ''].filter(Boolean);
  return parts.join('; ');
}
