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

/**
 * A comment target: any Mandate object, as `mandate://<kind>/<id>[/sections/<sid> | /tasks/tN][#Lx-Ly]` with kind
 * specs | standards | components | work-orders | requests (`#Lx-Ly`: a line range inside a section).
 */
const TARGET_RE = /^mandate:\/\/(specs|standards|components|work-orders|requests|feedback)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(?:sections\/([a-z0-9]+(?:-[a-z0-9]+)*)|(?:steps|tasks)\/([st]\d+)))?(?:#L(\d+)(?:-L(\d+))?)?$/;
export interface CommentTarget {
  kind: 'specs' | 'standards' | 'components' | 'work-orders' | 'requests';
  id: string;
  sectionId?: string;
  step?: string;
  lines?: { start: number; end: number };
  /** Canonical text (requests, lines kept). */
  canonical: string;
  /** The same without lines. */
  base: string;
  /** The document / request / work order itself. */
  doc: string;
}
export function parseCommentTarget(input: string): CommentTarget | null {
  const m = TARGET_RE.exec(input.trim().replace(/^@mandate:/, ''));
  if (!m) return null;
  const kind = (m[1] === 'feedback' ? 'requests' : m[1]) as CommentTarget['kind'];
  const [, , id, sectionId, step, a, b] = m;
  if (a && !sectionId) return null;
  const lines = a ? { start: Number(a), end: b ? Number(b) : Number(a) } : undefined;
  if (lines && (lines.start < 1 || lines.end < lines.start)) return null;
  const doc = `mandate://${kind}/${id}`;
  const base = sectionId ? `${doc}/sections/${sectionId}` : step ? `${doc}/tasks/${step}` : doc;
  const canonical = lines ? `${base}#L${lines.start}${lines.end > lines.start ? `-L${lines.end}` : ''}` : base;
  return { kind, id: id!, ...(sectionId ? { sectionId } : {}), ...(step ? { step } : {}), ...(lines ? { lines } : {}), canonical, base, doc };
}
const targetSchema = z
  .string()
  .min(1)
  .refine((v) => !!parseCommentTarget(v) || (!!parseRef(v) && parseRef(v)!.kind !== 'feedback' && !parseRef(v)!.commit), 'a Mandate object: mandate://<specs|standards|components|work-orders|requests>/<id>[/sections/<sid> | /tasks/tN][#Lx-Ly]');

/** What each badge of the web UI means (the agent cannot see the UI: comments and the guide carry this). */
export const UI_BADGE_MEANING = {
  Outdated: 'an implemented spec section whose text changed after it was implemented: wording only -> section_update editorial; same behaviour -> section_reverify; new behaviour -> a work order task',
  'Implemented @x': 'the section was implemented at spec commit x (by its work order) and has not changed since',
  'Not implemented': 'no work order has implemented the section yet',
  'Waiting for you': 'the item needs a decision only the user can make (a question, an approval, a plan to approve, a comment addressed to the user)',
  'Plan ready': 'a plan-only request whose work-order plan awaits the user approval; the agent stops until it is approved',
  Queued: 'the request is assigned to an agent that has not started it yet',
  "Can't be woken": 'the addressed agent is online but cannot be woken by a comment (its client does not accept pushes): it sees the comment at its next flow_next / news_list',
} as const;

/** The state of the commented object as the UI displays it, stored with the comment (so agents need not guess). */
export const commentViewSchema = z
  .object({
    /** Readable name of the target: `spec "Title" > section "Title"`. */
    object: z.string().min(1).max(300),
    /** Lifecycle status of the object (spec / standard / component / work order / request). */
    status: z.string().max(60).optional(),
    /** Spec section: how the UI shows its implementation. */
    implementation: z
      .object({
        state: z.enum(['implemented', 'outdated', 'not_implemented']),
        implementedCommit: z.string().optional(),
        implementedBy: z.string().optional(),
        changedBy: z.string().optional(),
        changedAt: z.string().optional(),
        changedCommit: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Work order / task / request details shown on the page. */
    details: z.record(z.string(), z.string()).optional(),
    /** The badges the user sees on the target and what each means. */
    badges: z.array(z.object({ label: z.string(), meaning: z.string() }).strict()).max(12).optional(),
    /** The text the user selected when commenting. */
    selectedText: z.string().max(2000).optional(),
    at: z.string().optional(),
  })
  .strict();
export type CommentContext = z.infer<typeof commentViewSchema>;

export const commentRecordSchema = z.object({
  id: idSchema,
  target: targetSchema,
  /** Reply to this comment (a thread is a root comment and its replies). */
  parent: idSchema.optional(),
  author: z.object({ agent: z.string().min(1), user: z.string().min(1).optional() }),
  body: z.string().min(1),
  mentions: z.array(z.string().min(1)).optional(),
  /** Explicit addressee (`@handle` or a login / agent label; `any`: the next free agent). Set by the web UI picker or by `to`. */
  to: z.string().min(1).optional(),
  /** The author wants this handled as a change request (the "Make it a request" checkbox): the agent always runs the flow. */
  asRequest: z.boolean().optional(),
  /** Must be resolved before the work order can be completed (thread roots only). */
  blocking: z.boolean().optional(),
  /** The UI state of the target (and the selected text) when the comment was written. */
  view: commentViewSchema.optional(),
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
const noLines = (t: string) => t.replace(/#L\d+(?:-L\d+)?$/, '');
export const targetsDoc = (target: string, doc: string) => {
  const t = noLines(target);
  return t === doc || t.startsWith(`${doc}/sections/`) || t.startsWith(`${doc}/steps/`) || t.startsWith(`${doc}/tasks/`);
};
export const targetBase = noLines;

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
    /** Any object: a spec / standard / component / work order / request, or one of its sections or steps (`mandate://specs/<id>/sections/<sid>[#Lx-Ly]`, `mandate://work-orders/<id>/steps/s1`). */
    target: z.string().trim().min(1).max(400),
    body: z.string().trim().min(1).max(20_000),
    /** Reply to a comment (id or mandate://comments/<id>); the reply joins that thread. */
    parent: commentRef.optional(),
    /** Must be resolved before work_order_complete (root comments only). */
    blocking: z.boolean().optional(),
    /** Addressee: `@login`, an agent handle (see agents_presence) or `any` (queue: the next agent's flow_next picks it up). Default: the responsible agent. */
    to: z.string().trim().min(1).max(120).optional(),
    /** Treat as a change request: the agent must run the /mandate flow for it (request_create source comment). */
    asRequest: z.boolean().optional(),
    /** The text selected in the page when commenting (the server adds the target's displayed state as `view`). */
    selectedText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export const commentResolveInputSchema = z.object({ id: commentRef, note: z.string().trim().min(1).max(5000).optional() }).strict();
export const commentReopenInputSchema = z.object({ id: commentRef }).strict();
export const commentsListInputSchema = z
  .object({
    /** A work order (all its threads, section ones included) or one section. */
    target: z.string().trim().min(1).max(400).optional(),
    includeResolved: z.boolean().default(false),
    /** Without target: the open threads across the project addressed to this login (`to` or an @mention): the web "Waiting for you" inbox. */
    addressedTo: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => !!v.target || !!v.addressedTo, 'give target (an object) or addressedTo (a login)');
