/**
 * Questions an agent asks the user through Mandate (`questions.jsonl`, append-only): question records (`ask-NNNN`,
 * sequenced inside the write lock) and event records (answered / cancelled / superseded). The state is the replay
 * (`replayQuestions`); a question closes once and is then frozen: the check runs inside the write lock, so two
 * concurrent answers cannot both land.
 */
import {
  checkAnswers,
  isQuestionEvent,
  parseNodeUri,
  questionLineSchema,
  QUESTIONS_FILE,
  replayQuestions,
  type Question,
  type QuestionActor,
  type QuestionEvent,
  type QuestionInputItem,
  type QuestionLine,
  type QuestionPurpose,
  type QuestionRecord,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { NotFoundError, type CommitMeta, type IntegrityHook } from './GitBackedRepository.js';
import { newId } from './ids.js';
import { JsonlFileRepository } from './JsonlFileRepository.js';
import type { Mutex } from './Mutex.js';

export class QuestionError extends Error {
  constructor(
    readonly code: 'question_frozen' | 'validation' | 'question_not_answered' | 'question_ineligible' | 'question_purpose',
    message: string,
    readonly statusCode = code === 'validation' ? 400 : 409,
  ) {
    super(message);
  }
}

type Line = QuestionLine & { title?: string };

export class QuestionService {
  readonly repo: JsonlFileRepository<Line>;
  /** Does a context reference resolve? (wired by createStorage). */
  resolve?: (ref: string) => Promise<string>;

  constructor(git: GitStore, lock: Mutex, beforeCommit?: (message: string) => Promise<void>, integrity?: IntegrityHook<Line>) {
    this.repo = new JsonlFileRepository<Line>(QUESTIONS_FILE, {
      label: 'question',
      schema: questionLineSchema as never,
      git,
      lock,
      stamp: false,
      sequence: { prefix: 'ask' },
      idTrailer: 'Question',
      appendOnly: true,
      ...(integrity ? { integrity } : {}),
      ...(beforeCommit ? { beforeCommit } : {}),
      beforeWrite: async (next) => {
        await this.check(next as QuestionLine);
      },
    });
  }

  async lines(): Promise<QuestionLine[]> {
    return (await this.repo.list()) as QuestionLine[];
  }

  async list(now = Date.now()): Promise<Question[]> {
    return replayQuestions(await this.lines(), now);
  }

  async get(id: string): Promise<Question> {
    const q = (await this.list()).find((x) => x.id === id);
    if (!q) throw new NotFoundError(`question '${id}' not found`);
    return q;
  }

  /** Inside the write lock: events act on an OPEN question only (answered / cancelled / superseded / expired are frozen). */
  private async check(next: QuestionLine): Promise<void> {
    if (!isQuestionEvent(next)) return;
    const q = (await this.list()).find((x) => x.id === next.questionId);
    if (!q) throw new NotFoundError(`question '${next.questionId}' not found`);
    if (q.status !== 'open') throw new QuestionError('question_frozen', `question ${q.id} is ${q.status}: it cannot change any more`);
    if (next.type === 'answered') {
      const bad = checkAnswers(q, next.answers ?? {});
      if (bad) throw new QuestionError('validation', bad);
    }
  }

  async ask(
    input: { purpose: QuestionPurpose; questions: (QuestionInputItem & { multiSelect: boolean })[]; context?: string[]; blocking: boolean; expiresInHours?: number; supersedes?: string },
    asker: QuestionActor,
    meta: CommitMeta = {},
  ): Promise<Question> {
    const context: string[] = [];
    for (const r of input.context ?? []) {
      const uri = this.resolve ? await this.resolve(r).catch((e: Error) => { throw new QuestionError('validation', `context ${r}: ${e.message}`); }) : r;
      if (!context.includes(uri)) context.push(uri);
    }
    if (input.supersedes) {
      const old = await this.get(input.supersedes);
      if (old.status !== 'open') throw new QuestionError('question_frozen', `question ${old.id} is ${old.status}: only open questions can be superseded`);
    }
    const at = meta.date ?? new Date();
    const rec: Omit<QuestionRecord, 'id'> = {
      asker,
      context,
      purpose: input.purpose,
      questions: input.questions.map((q, i) => ({
        id: `q${i + 1}`,
        header: q.header,
        ...(q.title ? { title: q.title } : {}),
        ...(q.badge ? { badge: q.badge } : {}),
        question: q.question,
        ...(q.evidence?.length ? { evidence: q.evidence.map((e) => ({ ref: e.ref, ...(e.conforming !== undefined ? { conforming: e.conforming } : {}), ...(e.violating !== undefined ? { violating: e.violating } : {}) })) } : {}),
        options: q.options,
        recommended: q.recommended,
        multiSelect: q.multiSelect,
      })),
      blocking: input.blocking,
      createdAt: at.toISOString(),
      ...(input.expiresInHours ? { expiresAt: new Date(at.getTime() + input.expiresInHours * 3_600_000).toISOString() } : {}),
    };
    const created = (await this.repo.create(rec as never, { ...meta, message: meta.message ?? `question: ask {id} (${input.purpose}${input.blocking ? ', blocking' : ''}): ${rec.questions[0]!.header}` })) as QuestionRecord;
    if (input.supersedes) await this.event({ type: 'superseded', questionId: input.supersedes, by: asker, supersededBy: created.id }, meta);
    return this.get(created.id);
  }

  async answer(id: string, answers: Record<string, string | string[]>, by: QuestionActor, opts: { notes?: string; via: 'ui' | 'chat' }, meta: CommitMeta = {}): Promise<Question> {
    await this.event({ type: 'answered', questionId: id, by, answers, ...(opts.notes ? { notes: opts.notes } : {}), via: opts.via }, meta);
    return this.get(id);
  }

  async cancel(id: string, reason: string, by: QuestionActor, meta: CommitMeta = {}): Promise<Question> {
    await this.event({ type: 'cancelled', questionId: id, by, reason }, meta);
    return this.get(id);
  }

  private async event(e: Omit<QuestionEvent, 'id' | 'at'>, meta: CommitMeta): Promise<void> {
    const rec: QuestionEvent = { id: newId('qe', meta.date?.getTime()), at: (meta.date ?? new Date()).toISOString(), ...e };
    await this.repo.create(rec as never, { ...meta, message: meta.message ?? `question: ${e.type} ${e.questionId}`, trailers: { ...meta.trailers, Question: e.questionId } });
  }
}

/** Question ids among canonical cause references. */
export const questionCauses = (causes: string[] | undefined): string[] =>
  (causes ?? []).map((c) => parseNodeUri(c)).flatMap((n) => (n?.kind === 'questions' ? [n.id] : []));
