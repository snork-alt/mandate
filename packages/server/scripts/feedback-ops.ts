import { createStandardSchema, parseRef } from '@mandate/shared';
import type { Storage } from '../src/storage/index.js';
import type { FEEDBACK, FeedbackApply } from './seed-data.js';

const person = (handle: string) => ({ name: handle.charAt(0).toUpperCase() + handle.slice(1), email: `${handle}@example.com` });

/** One commit applying (part of) a feedback item, with a `Feedback: <id>` trailer. */
export async function applyFeedback(storage: Storage, feedbackId: string, op: FeedbackApply, date: Date): Promise<void> {
  const meta = { date, author: person('matteo'), message: op.message, trailers: { Feedback: feedbackId } };
  if (op.type === 'replace') {
    const ref = parseRef(op.target)!;
    const repo = ref.kind === 'standards' ? storage.standards : storage.specs;
    const doc = await repo.get(ref.id);
    const sections = doc.sections.map((x) => (x.id === ref.sectionId ? { ...x, body: x.body.replace(op.find, op.replace) } : x));
    await repo.update(ref.id, { sections } as never, meta);
  } else if (op.type === 'createStandard') {
    const { type: _t, message: _m, hoursAgo: _h, ...std } = op;
    await storage.standards.create(createStandardSchema.parse(std), meta);
  } else {
    // Documents are never deleted: archive the section instead.
    const ref = parseRef(op.target)!;
    const repo = ref.kind === 'standards' ? storage.standards : storage.specs;
    const doc = await repo.get(ref.id);
    await repo.update(ref.id, { sections: doc.sections.map((x) => (x.id === ref.sectionId ? { ...x, archived: true } : x)) } as never, meta);
  }
}

/** Set the final status (closing freezes the item). */
export async function finishFeedback(storage: Storage, item: (typeof FEEDBACK)[number], date: Date): Promise<void> {
  // Requests need no approval: `accepted` is only legacy data (not written any more).
  if (!item.final || item.final.status === 'accepted') return;
  const { hoursAgo: _h, ...patch } = item.final as typeof item.final & { hoursAgo?: number };
  await storage.feedbackService.update(item.id, patch, { date, author: person('matteo'), message: `request: close ${item.id} (${item.final.resolution})` });
}
