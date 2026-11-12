/**
 * Comments: review / coordination threads by agents (reviewers, coordinators) on a work order or one of its sections
 * (the target is a generic reference so specs and audits can use them later). Stored append-only in `comments.jsonl`
 * at the data repo root, NOT inside the work order markdown: comment records `{ id, target, parent?, author, body,
 * mentions?, blocking?, createdAt }` and state records `{ id, type: resolve | reopen, commentId, by, at, note? }`.
 * Records are immutable (corrections are replies); the state of a thread is the replay of its records.
 */
import { z } from 'zod';
import { idSchema } from './base.js';
import { buildCommentRef, parseRef } from './refs.js';
import type { CommentCounts, CommentThread, CommentView } from './work-orders.js';

export const COMMENT_STATE_TYPES = ['resolve', 'reopen'] as const;

/** A target: a work order / doc or one of its sections (canonical, no version / lines). */
const targetSchema = z
  .string()
  .min(1)
  .refine((v) => {
    const r = parseRef(v);
    return !!r && !r.commit && !r.lines && r.kind !== 'feedback';
  }, 'a work order (or other document) reference, optionally a section: mandate://work-orders/<id>[/sections/<sid>]');

export const commentRecordSchema = z.object({
  id: idSchema,
  target: targetSchema,
  /** Reply to this comment (a thread is a root comment and its replies). */
  parent: idSchema.optional(),
  author: z.object({ agent: z.string().min(1), user: z.string().min(1).optional() }),
  body: z.string().min(1),
  mentions: z.array(z.string().min(1)).optional(),
  /** Must be resolved before the work order can be completed (thread roots only). */
  blocking: z.boolean().optional(),
  createdAt: z.string().min(1),
});
export type CommentRecord = z.infer<typeof commentRecordSchema>;
export const commentStateRecordSchema = z.object({
  id: idSchema,
  type: z.enum(COMMENT_STATE_TYPES),
  commentId: idSchema,
  by: z.string().min(1),
  at: z.string().min(1),
  note: z.string().optional(),
});
export type CommentStateRecord = z.infer<typeof commentStateRecordSchema>;
/** One line of `comments.jsonl`. */
export const commentLineSchema = z.union([commentStateRecordSchema, commentRecordSchema]);
export type CommentLine = CommentRecord | CommentStateRecord;
export const isStateRecord = (r: CommentLine): r is CommentStateRecord => 'type' in r && (r as CommentStateRecord).type !== undefined && 'commentId' in r;

/** `@name` mentions in a body (agents / users). */
export const mentionsOf = (body: string) => [...new Set([...body.matchAll(/(?:^|[\s(])@([A-Za-z0-9][\w.-]*[\w])/g)].map((m) => m[1]!).filter((n) => n !== 'mandate'))];

const view = (c: CommentRecord): CommentView => ({ ...c, uri: buildCommentRef(c.id) });

/** Replay the records into threads (root comments with replies and resolve / reopen state), oldest first. */
export function replayComments(lines: CommentLine[]): CommentThread[] {
  const comments = lines.filter((l): l is CommentRecord => !isStateRecord(l));
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: CommentRecord): CommentRecord => {
    let cur = c;
    for (let i = 0; i < 100 && cur.parent && byId.has(cur.parent); i++) cur = byId.get(cur.parent)!;
    return cur;
  };
  const threads = new Map<string, CommentThread>();
  for (const c of comments) if (!c.parent || !byId.has(c.parent)) threads.set(c.id, { ...view(c), status: 'open', events: [], replies: [] });
  for (const c of comments) if (c.parent && byId.has(c.parent)) threads.get(rootOf(c).id)?.replies.push(view(c));
  for (const l of lines) {
    if (!isStateRecord(l)) continue;
    const c = byId.get(l.commentId);
    const t = c && threads.get(rootOf(c).id);
    if (!t) continue;
    t.events.push({ type: l.type, by: l.by, at: l.at, ...(l.note ? { note: l.note } : {}) });
    if (l.type === 'resolve') Object.assign(t, { status: 'resolved', resolvedBy: l.by, resolvedAt: l.at, resolveNote: l.note });
    else {
      t.status = 'open';
      delete t.resolvedBy;
      delete t.resolvedAt;
      delete t.resolveNote;
    }
  }
  for (const t of threads.values()) if (t.resolveNote === undefined) delete t.resolveNote;
  return [...threads.values()];
}

/** Does `target` belong to `doc` (the doc itself or one of its sections)? */
export const targetsDoc = (target: string, doc: string) => target === doc || target.startsWith(`${doc}/sections/`);

export function commentCounts(threads: CommentThread[]): CommentCounts {
  return {
    open: threads.filter((t) => t.status === 'open').length,
    openBlocking: threads.filter((t) => t.status === 'open' && t.blocking).length,
    resolved: threads.filter((t) => t.status === 'resolved').length,
  };
}

/* ---------------------------------------------------------------- tool inputs */

const commentRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((v) => v.replace(/^@mandate:/, '').replace(/^mandate:\/\/comments\//, ''))
  .pipe(idSchema);

export const commentAddInputSchema = z
  .object({
    /** A work order or one of its sections (`mandate://work-orders/<id>[/sections/<sid>]`). */
    target: z.string().trim().min(1).max(400),
    body: z.string().trim().min(1).max(20_000),
    /** Reply to a comment (id or mandate://comments/<id>); the reply joins that thread. */
    parent: commentRef.optional(),
    /** Must be resolved before work_order_complete (root comments only). */
    blocking: z.boolean().optional(),
  })
  .strict();
export const commentResolveInputSchema = z.object({ id: commentRef, note: z.string().trim().min(1).max(5000).optional() }).strict();
export const commentReopenInputSchema = z.object({ id: commentRef }).strict();
export const commentsListInputSchema = z
  .object({
    /** A work order (all its threads, section ones included) or one section. */
    target: z.string().trim().min(1).max(400),
    includeResolved: z.boolean().default(false),
  })
  .strict();
