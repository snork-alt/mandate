/**
 * Questions coding agents ask the user through Mandate (`question_ask`): the per-element list (`questions_list`),
 * one question (`question_get`) and answering (`question_answer`, a uiAllowed write tool like the decisions).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { DecisionsList, Question, QuestionItem } from '@mandate/shared';
import { callTool } from '../mcp/client';
import { refMatches } from './decisions';
import { createElement } from 'react';
import { ContinueNotice } from '../components/questions/ContinueNotice';

export type Answers = Record<string, string | string[]>;
export interface AnswerArgs {
  id: string;
  answers: Answers;
  notes?: string;
}

export const PURPOSE_LABEL: Record<Question['purpose'], string> = {
  decision: 'Decision',
  standard_confirmation: 'Confirm a standard',
  approval: 'Approval',
  clarification: 'Clarification',
  other: 'Question',
};

/** Group headings of the open questions by purpose, in display order (approvals first). */
export const PURPOSE_GROUP: { purpose: Question['purpose']; label: string }[] = [
  { purpose: 'approval', label: 'Approvals' },
  { purpose: 'standard_confirmation', label: PURPOSE_LABEL.standard_confirmation },
  { purpose: 'decision', label: 'Decisions' },
  { purpose: 'clarification', label: 'Clarifications' },
  { purpose: 'other', label: 'Other' },
];

/** Recommended labels of one question as a list. */
export const recommendedOf = (item: Pick<QuestionItem, 'recommended'>): string[] => (Array.isArray(item.recommended) ? item.recommended : [item.recommended]);

/** The answer that takes every recommendation (single choice: the first recommended label). */
export function recommendedAnswers(q: Pick<Question, 'questions'>): Answers {
  const out: Answers = {};
  for (const item of q.questions) {
    const rec = recommendedOf(item);
    out[item.id] = item.multiSelect ? rec : rec[0]!;
  }
  return out;
}

export function useQuestions(context: string | undefined, status: 'open' | 'answered' | 'closed' | 'all' = 'all', limit = 20) {
  return useQuery({
    queryKey: ['questions', context ?? '*', status, limit],
    queryFn: ({ signal }) => callTool<{ items: Question[]; total: number }>('list', { of: 'questions', status, limit, ...(context ? { context } : {}) }, signal),
    staleTime: 15_000,
  });
}

export function useQuestion(id: string) {
  return useQuery({ queryKey: ['questions', 'one', id], queryFn: ({ signal }) => callTool<{ question: Question }>('get', { of: 'questions', ref: id }, signal), enabled: !!id });
}

const errorText = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  if (err.code === 'question_frozen') return 'This question was already answered or withdrawn.';
  if (err.code === 'forbidden') return 'Answering needs write (push) access to this project\'s repository.';
  return err.message ?? String(e);
};

/** Drop answered questions from the cached pending lists (optimistic); returns what to restore on failure. */
function dropPending(qc: ReturnType<typeof useQueryClient>, ids: string[]) {
  const keys = qc.getQueriesData<DecisionsList>({ queryKey: ['overview', 'decisions'] });
  for (const [k, v] of keys) {
    if (!v) continue;
    const items = v.items.filter((d) => !(d.kind === 'question' && ids.some((id) => refMatches(d.ref, id))));
    const n = v.items.length - items.length;
    qc.setQueryData<DecisionsList>(k, { ...v, items, total: Math.max(0, v.total - n), counts: { ...v.counts, question: Math.max(0, (v.counts.question ?? 0) - n) } });
  }
  return keys;
}

const settle = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['overview'] });
  void qc.invalidateQueries({ queryKey: ['questions'] });
};

/** Answer one question. */
export function useAnswerQuestion(onDone?: (a: AnswerArgs) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AnswerArgs) => callTool<unknown>('question_answer', { ...a }, undefined, { retry: false }),
    onMutate: (a) => ({ keys: dropPending(qc, [a.id]) }),
    onError: (e, _a, ctx) => {
      for (const [k, v] of ctx?.keys ?? []) qc.setQueryData(k, v);
      notifications.show({ color: 'red', title: 'Answer not recorded', message: errorText(e) });
    },
    onSuccess: (_r, a) => {
      notifications.show({ color: 'teal', title: 'Answer sent', message: createElement(ContinueNotice, { ids: [a.id] }), autoClose: 12_000 });
      onDone?.(a);
    },
    onSettled: () => settle(qc),
  });
}

/** Answer every given question with its recommended options (one call each, in order). */
export function useAnswerAllRecommended(onDone?: (r: { ok: number; failed: string[]; answered: string[] }) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (qs: Question[]) => {
      const failed: string[] = [];
      for (const q of qs) {
        try {
          await callTool<unknown>('question_answer', { id: q.id, answers: recommendedAnswers(q) }, undefined, { retry: false });
        } catch (e) {
          failed.push(`${q.id}: ${errorText(e)}`);
        }
      }
      return { ok: qs.length - failed.length, failed, answered: qs.map((q) => q.id).filter((id) => !failed.some((f) => f.startsWith(`${id}:`))) };
    },
    onMutate: (qs) => ({ keys: dropPending(qc, qs.map((q) => q.id)) }),
    onSuccess: (r) => {
      notifications.show({
        color: r.failed.length ? 'yellow' : 'teal',
        title: `Answered ${r.ok} question${r.ok === 1 ? '' : 's'}`,
        message: createElement('div', null, r.failed.length ? `Not recorded: ${r.failed.join('; ')}` : null, r.answered.length ? createElement(ContinueNotice, { ids: r.answered }) : null),
        autoClose: 12_000,
      });
      onDone?.(r);
    },
    onError: (e, _a, ctx) => {
      for (const [k, v] of ctx?.keys ?? []) qc.setQueryData(k, v);
      notifications.show({ color: 'red', title: 'Answers not recorded', message: errorText(e) });
    },
    onSettled: () => settle(qc),
  });
}

/** Every open question (one query, filtered client-side per request on the request pages). */
export const useOpenQuestions = () => useQuestions(undefined, 'open', 200);
export const useAllQuestions = () => useQuestions(undefined, 'all', 200);
