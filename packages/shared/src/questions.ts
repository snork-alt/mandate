/**
 * Questions: an agent asks the USER through Mandate (`question_ask`) instead of its harness's question tool, keeps
 * working on what does not depend on the answer, and picks the answer up later (MCP notification or
 * `questions_list { mine, status: answered }`). The user answers in the web UI (`question_answer`, uiAllowed).
 * Stored append-only in `questions.jsonl`: question records `{ id: ask-NNNN, asker, context, purpose, questions,
 * blocking, createdAt, expiresAt? }` and event records `{ id, type: answered | cancelled | superseded, questionId, by,
 * at, ... }`. Answered / cancelled / superseded questions are frozen; the state is the replay of the records.
 * The shape mirrors Claude Code's AskUserQuestion (1-4 questions, 2-4 options each) plus an explicit `recommended`.
 */
import { z } from 'zod';
import { buildQuestionRef, parseNodeUri } from './refs.js';

export const QUESTIONS_FILE = 'questions.jsonl';
export const QUESTION_PURPOSES = ['decision', 'standard_confirmation', 'approval', 'clarification', 'other'] as const;
export type QuestionPurpose = (typeof QUESTION_PURPOSES)[number];
export const QUESTION_STATUSES = ['open', 'answered', 'cancelled', 'superseded', 'expired'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const QUESTION_EVENT_TYPES = ['answered', 'cancelled', 'superseded'] as const;
/** Where an agent asks the user (per-client flow setting): through Mandate (default) or in chat. */
export const QUESTIONS_VIA = ['mandate', 'chat'] as const;
export type QuestionsVia = (typeof QUESTIONS_VIA)[number];

export const QUESTION_ID_RE = /^ask-[0-9]{4,}$/;
const label = z.string().trim().min(1).max(60);

export const questionOptionSchema = z.object({ label, description: z.string().trim().min(1).max(300) }).strict();
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** One question as the agent sends it (AskUserQuestion shape + recommended). */
export const questionInputItemSchema = z
  .object({
    /** Short chip label, at most 12 characters (e.g. "Auth method"). */
    header: z.string().trim().min(1).max(12),
    question: z.string().trim().min(3).max(500),
    options: z.array(questionOptionSchema).min(2).max(4),
    /** The option label you recommend (multiSelect: one or more labels). */
    recommended: z.union([label, z.array(label).min(1).max(4)]),
    multiSelect: z.boolean().default(false),
  })
  .strict()
  .superRefine((q, ctx) => {
    const labels = q.options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'option labels must be unique' });
    const rec = Array.isArray(q.recommended) ? q.recommended : [q.recommended];
    if (Array.isArray(q.recommended) && !q.multiSelect) ctx.addIssue({ code: 'custom', path: ['recommended'], message: 'one recommended label (a list only with multiSelect: true)' });
    for (const r of rec) if (!q.options.some((o) => o.label === r)) ctx.addIssue({ code: 'custom', path: ['recommended'], message: `recommended '${r}' is not one of the option labels (${q.options.map((o) => o.label).join(', ')})` });
  });
export type QuestionInputItem = z.input<typeof questionInputItemSchema>;

const contextRef = z
  .string()
  .trim()
  .min(3)
  .max(600)
  .refine((v) => !!parseNodeUri(v), 'a mandate:// reference (spec, section, standard, work order, feedback, ...)');

export const questionAskInputSchema = z
  .object({
    purpose: z.enum(QUESTION_PURPOSES),
    questions: z.array(questionInputItemSchema).min(1).max(4),
    /** The elements the question concerns (shown as chips; graph edges). */
    context: z.array(contextRef).max(10).optional(),
    /** true: you cannot make progress without the answer. */
    blocking: z.boolean().default(false),
    /** Stop asking after this many hours (the question expires unanswered). */
    expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
    /** An earlier open question this one replaces (it becomes superseded). */
    supersedes: z.string().regex(QUESTION_ID_RE).optional(),
  })
  .strict();
export type QuestionAskInput = z.input<typeof questionAskInputSchema>;

/** Answers by question id: one label (single choice), labels (multiSelect) or free text ("Other"). */
export const questionAnswersSchema = z.record(z.string().min(1).max(32), z.union([z.string().trim().min(1).max(2000), z.array(label).min(1).max(4)]));

const questionIdInput = z.string().trim().transform((v) => v.replace(/^@mandate:/, '').replace(/^mandate:\/\/questions\//, '')).pipe(z.string().regex(QUESTION_ID_RE, 'a question id (ask-NNNN) or mandate://questions/<id>'));

export const questionAnswerInputSchema = z.object({ id: questionIdInput, answers: questionAnswersSchema, notes: z.string().trim().max(2000).optional() }).strict();
export const questionCancelInputSchema = z.object({ id: questionIdInput, reason: z.string().trim().min(1).max(500) }).strict();
export const questionGetInputSchema = z.object({ id: questionIdInput }).strict();
export const questionsListInputSchema = z
  .object({
    status: z.enum(['open', 'answered', 'closed', 'all']).default('open'),
    /** Only questions asked by this client (your session's agent client). */
    mine: z.boolean().default(false),
    /** Only questions about this element (or its sections). */
    context: contextRef.optional(),
    /** Only questions answered / created after this ISO time (poll without re-reading old answers). */
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type QuestionsListInput = z.input<typeof questionsListInputSchema>;

/* ---------------------------------------------------------------- stored records */

const who = z.object({ agent: z.string().min(1), user: z.string().min(1).optional(), client: z.string().min(1).optional() });
export type QuestionActor = z.infer<typeof who>;

export const questionItemSchema = z.object({
  id: z.string().min(1).max(32),
  header: z.string().min(1).max(12),
  question: z.string().min(1),
  options: z.array(questionOptionSchema).min(2).max(4),
  recommended: z.union([z.string(), z.array(z.string())]),
  multiSelect: z.boolean(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

export const questionRecordSchema = z.object({
  id: z.string().regex(QUESTION_ID_RE),
  asker: who,
  context: z.array(z.string()),
  purpose: z.enum(QUESTION_PURPOSES),
  questions: z.array(questionItemSchema).min(1).max(4),
  blocking: z.boolean(),
  createdAt: z.string().min(1),
  expiresAt: z.string().optional(),
});
export type QuestionRecord = z.infer<typeof questionRecordSchema>;

export const questionEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(QUESTION_EVENT_TYPES),
  questionId: z.string().regex(QUESTION_ID_RE),
  by: who,
  at: z.string().min(1),
  /** answered: per question id. */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  notes: z.string().optional(),
  /** answered: through the web UI or relayed by the agent from chat (local mode). */
  via: z.enum(['ui', 'chat']).optional(),
  reason: z.string().optional(),
  supersededBy: z.string().optional(),
});
export type QuestionEvent = z.infer<typeof questionEventSchema>;
export const questionLineSchema = z.union([questionEventSchema, questionRecordSchema]);
export type QuestionLine = QuestionRecord | QuestionEvent;
export const isQuestionEvent = (l: QuestionLine): l is QuestionEvent => 'questionId' in l && 'type' in l;

/** A question with its replayed state. */
export interface Question extends QuestionRecord {
  uri: string;
  status: QuestionStatus;
  answer?: { by: QuestionActor; at: string; answers: Record<string, string | string[]>; notes?: string; via?: 'ui' | 'chat' };
  cancelled?: { by: QuestionActor; at: string; reason?: string };
  supersededBy?: string;
}

/** Replay the records into questions (oldest first); `now` decides expiry. */
export function replayQuestions(lines: QuestionLine[], now = Date.now()): Question[] {
  const out = new Map<string, Question>();
  for (const l of lines) {
    if (isQuestionEvent(l)) continue;
    out.set(l.id, { ...l, uri: buildQuestionRef(l.id), status: 'open' });
  }
  for (const e of lines) {
    if (!isQuestionEvent(e)) continue;
    const q = out.get(e.questionId);
    if (!q || q.status !== 'open') continue; // frozen after the first closing event
    if (e.type === 'answered') {
      q.status = 'answered';
      q.answer = { by: e.by, at: e.at, answers: e.answers ?? {}, ...(e.notes ? { notes: e.notes } : {}), ...(e.via ? { via: e.via } : {}) };
    } else if (e.type === 'cancelled') {
      q.status = 'cancelled';
      q.cancelled = { by: e.by, at: e.at, ...(e.reason ? { reason: e.reason } : {}) };
    } else {
      q.status = 'superseded';
      if (e.supersededBy) q.supersededBy = e.supersededBy;
    }
  }
  for (const q of out.values()) if (q.status === 'open' && q.expiresAt && Date.parse(q.expiresAt) <= now) q.status = 'expired';
  return [...out.values()];
}

/** The answer of one question as text ("A", "A, B" or the free text). */
export const answerText = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

/** Validate answers against the questions: every question answered; labels exist (free text allowed for single choice). */
export function checkAnswers(q: Pick<QuestionRecord, 'questions'>, answers: Record<string, string | string[]>): string | null {
  for (const k of Object.keys(answers)) if (!q.questions.some((x) => x.id === k)) return `unknown question id '${k}' (ids: ${q.questions.map((x) => x.id).join(', ')})`;
  for (const item of q.questions) {
    const a = answers[item.id];
    if (a === undefined) return `question '${item.id}' (${item.header}) has no answer`;
    const labels = item.options.map((o) => o.label);
    if (Array.isArray(a)) {
      if (!item.multiSelect) return `question '${item.id}' takes one answer (not a list)`;
      const bad = a.find((x) => !labels.includes(x));
      if (bad) return `'${bad}' is not an option of question '${item.id}' (${labels.join(', ')})`;
      if (new Set(a).size !== a.length) return `question '${item.id}': duplicate labels`;
    }
  }
  return null;
}
