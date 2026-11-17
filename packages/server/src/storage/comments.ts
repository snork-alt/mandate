/**
 * Comments: append-only review / coordination threads in `comments.jsonl` (never inside the work order markdown).
 * Records are immutable: a comment, or a resolve / reopen state record; corrections are replies. The thread state is
 * the replay of its records (`replayComments`).
 *
 * Rules (inside the write lock): the target exists (a work order or one of its sections; other documents too);
 * replies join the parent's thread and target the same document; `blocking` only on thread roots; on a FROZEN work
 * order (done / failed / cancelled) only replies to existing threads and resolves are allowed (no new threads, no
 * reopen: a closed work order cannot get new must-fix issues — open a new work order instead).
 */
import {
  commentLineSchema,
  FROZEN_WORK_ORDER_STATUSES,
  isStateRecord,
  mentionsOf,
  parseCommentTarget,
  targetBase,
  replayComments,
  targetsDoc,
  type CommentLine,
  type CommentRecord,
  type CommentStateRecord,
  type CommentThread,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { NotFoundError, type CommitMeta } from './GitBackedRepository.js';
import { newId } from './ids.js';
import type { IntegrityHook } from './GitBackedRepository.js';
import { JsonlFileRepository } from './JsonlFileRepository.js';
import type { Mutex } from './Mutex.js';
import { WorkOrderError, type WorkOrderService } from './work-orders.js';

export const COMMENTS_FILE = 'comments.jsonl';

export interface CommentDeps {
  workOrders: WorkOrderService;
  /** Does a document (and section) exist? (kind, id, section) */
  docExists: (kind: string, id: string, section?: string, step?: string) => Promise<boolean>;
}

const frozen = (status: string) => (FROZEN_WORK_ORDER_STATUSES as readonly string[]).includes(status);

export class CommentService {
  readonly repo: JsonlFileRepository<CommentLine & { title?: string }>;
  private deps?: CommentDeps;

  constructor(git: GitStore, lock: Mutex, beforeCommit?: (message: string) => Promise<void>, integrity?: IntegrityHook<CommentLine & { title?: string }>) {
    this.repo = new JsonlFileRepository<CommentLine & { title?: string }>(COMMENTS_FILE, {
      label: 'comment',
      schema: commentLineSchema as never,
      git,
      lock,
      stamp: false,
      idTrailer: 'Comment',
      ...(integrity ? { integrity } : {}),
      appendOnly: true,
      ...(beforeCommit ? { beforeCommit } : {}),
      beforeWrite: async (next) => {
        await this.check(next as CommentLine);
      },
    });
  }

  wire(deps: CommentDeps) {
    this.deps = deps;
  }

  async lines(): Promise<CommentLine[]> {
    return (await this.repo.list()) as CommentLine[];
  }

  /** Threads on a document (and its sections / steps) or on one section / step (line ranges are ignored). */
  async threads(target: string): Promise<CommentThread[]> {
    const t = targetBase(this.canonical(target));
    const all = replayComments(await this.lines());
    const p = parseCommentTarget(t)!;
    return p.sectionId || p.step ? all.filter((x) => targetBase(x.target) === t) : all.filter((x) => targetsDoc(x.target, t));
  }

  /** The work order (id) a target belongs to, if any. */
  private workOrderOf(target: string): string | null {
    const r = parseCommentTarget(target);
    return r?.kind === 'work-orders' ? r.id : null;
  }

  /** Canonical target: spec / standard / component / work order / request, or a section / step of one (line ranges kept). */
  canonical(target: string): string {
    const r = parseCommentTarget(target);
    if (!r) {
      if (/^mandate:\/\/audits\//.test(target.trim())) return target.trim();
      throw new WorkOrderError('invalid_target', `comment targets are Mandate objects: mandate://<specs|standards|components|work-orders|requests>/<id>[/sections/<sid> | /tasks/tN][#Lx-Ly]; got '${target}'`, undefined, 400);
    }
    return r.canonical;
  }

  /** Inside the write lock: target / parent / frozen rules. */
  private async check(next: CommentLine): Promise<void> {
    const deps = this.deps!;
    const lines = await this.lines();
    const comments = lines.filter((l): l is CommentRecord => !isStateRecord(l));
    if (isStateRecord(next)) {
      const c = comments.find((x) => x.id === next.commentId);
      if (!c) throw new NotFoundError(`comment '${next.commentId}' not found`);
      const wo = this.workOrderOf(c.target);
      if (wo && next.type === 'reopen') {
        const w = await deps.workOrders.get(wo);
        if (frozen(w.status)) throw new WorkOrderError('work_order_frozen', `work order ${wo} is ${w.status}: threads on a closed work order cannot be reopened (open a new work order)`, { kind: 'work_order', status: w.status });
      }
      return;
    }
    if (/^mandate:\/\/audits\//.test(next.target)) throw new WorkOrderError('invalid_target', `audits cannot be commented on (they are frozen reports); comment on the fix work order or file a request from the finding (fromFinding)`, undefined, 400);
    const r = parseCommentTarget(next.target)!;
    if (!(await deps.docExists(r.kind, r.id, r.sectionId, r.step))) throw new NotFoundError(`${next.target} does not exist`);
    if (next.parent) {
      const p = comments.find((x) => x.id === next.parent);
      if (!p) throw new NotFoundError(`comment '${next.parent}' not found`);
      const pr = parseCommentTarget(p.target)!;
      if (pr.doc !== r.doc) throw new WorkOrderError('invalid_parent', `a reply targets the same document as its thread (${pr.doc})`, undefined, 400);
      if (next.blocking) throw new WorkOrderError('invalid_input', 'only thread roots can be blocking (start a new thread for a new must-fix issue)', undefined, 400);
    }
    const wo = this.workOrderOf(next.target);
    if (wo && !next.parent) {
      const w = await deps.workOrders.get(wo);
      if (frozen(w.status)) {
        throw new WorkOrderError('work_order_frozen', `work order ${wo} is ${w.status}: only replies to existing threads are allowed on a closed work order`, { kind: 'work_order', status: w.status });
      }
    }
  }

  async add(input: { target: string; body: string; parent?: string; blocking?: boolean; to?: string; asRequest?: boolean }, who: { agent: string; user?: string }, meta: CommitMeta = {}): Promise<CommentRecord> {
    let target = this.canonical(input.target);
    if (input.parent) {
      const p = (await this.lines()).find((l): l is CommentRecord => !isStateRecord(l) && l.id === input.parent);
      if (!p) throw new NotFoundError(`comment '${input.parent}' not found`);
      // A reply to a work-order comment given only the work order keeps the parent's (section) target.
      const pr = parseCommentTarget(p.target)!;
      const tr = parseCommentTarget(target)!;
      if (pr.doc === tr.doc && !tr.sectionId && !tr.step) target = p.target;
    }
    const now = (meta.date ?? new Date()).toISOString();
    const mentions = mentionsOf(input.body);
    const rec: CommentRecord = {
      id: newId('c', meta.date?.getTime()),
      target,
      ...(input.parent ? { parent: input.parent } : {}),
      author: { agent: who.agent, ...(who.user ? { user: who.user } : {}) },
      body: input.body.trim(),
      ...(mentions.length ? { mentions } : {}),
      ...(input.to ? { to: input.to.replace(/^@/, '') } : {}),
      ...(input.asRequest ? { asRequest: true } : {}),
      ...(input.blocking ? { blocking: true } : {}),
      createdAt: now,
    };
    const wo = this.workOrderOf(target);
    return (await this.repo.create(rec as never, {
      ...meta,
      message: meta.message ?? `comment: ${input.parent ? 'reply on' : input.blocking ? 'blocking comment on' : 'comment on'} ${target.replace('mandate://', '')}`,
      trailers: { ...meta.trailers, ...(wo ? { 'Work-Order': wo } : {}) },
    })) as CommentRecord;
  }

  /** The thread a comment (root or reply) belongs to. */
  async threadOf(id: string): Promise<CommentThread | null> {
    return replayComments(await this.lines()).find((t) => t.id === id || t.replies.some((r) => r.id === id)) ?? null;
  }

  /** Resolve / reopen the thread of a comment (a reply id acts on its thread). Idempotent: no record when unchanged. */
  async setState(id: string, type: 'resolve' | 'reopen', by: string, note: string | undefined, meta: CommitMeta = {}): Promise<{ thread: CommentThread; changed: boolean }> {
    const lines = await this.lines();
    const c = lines.find((l): l is CommentRecord => !isStateRecord(l) && l.id === id);
    if (!c) throw new NotFoundError(`comment '${id}' not found`);
    const threadOf = (ls: CommentLine[]) => replayComments(ls).find((t) => t.id === id || t.replies.some((r) => r.id === id))!;
    const t = threadOf(lines);
    if ((type === 'resolve') === (t.status === 'resolved')) return { thread: t, changed: false };
    const rec: CommentStateRecord = { id: newId('cs', meta.date?.getTime()), type, commentId: t.id, by, at: (meta.date ?? new Date()).toISOString(), ...(note ? { note } : {}) };
    const wo = this.workOrderOf(t.target);
    await this.repo.create(rec as never, {
      ...meta,
      message: meta.message ?? `comment: ${type} ${t.id} on ${t.target.replace('mandate://', '')}`,
      trailers: { ...meta.trailers, ...(wo ? { 'Work-Order': wo } : {}) },
    });
    return { thread: threadOf(await this.lines()), changed: true };
  }
}
