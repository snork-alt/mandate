/**
 * Questions coding agents ask through Mandate: the answer card (open questions: options with the recommended one
 * preselected, "Other", notes, Submit / Ctrl+Enter), the read-only answered view, and the batch "Answer all recommended".
 */
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Checkbox, Group, Modal, Radio, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { IconChecks, IconSend } from '@tabler/icons-react';
import { answerText, type Question, type QuestionItem } from '@mandate/shared';
import { ByLine } from '../attribution/Attribution';
import { RefChip } from '../refs/RefChip';
import { When } from '../overview/parts';
import { PURPOSE_LABEL, recommendedAnswers, recommendedOf, useAnswerAllRecommended, useAnswerQuestion, type Answers } from '../../lib/questions';
import './questions.css';

const OTHER = '__other__';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const NO_ACCESS = "Answering needs write (push) access to this project's repository.";

interface ItemState {
  choice: string;
  other: string;
  multi: string[];
}

const initial = (item: QuestionItem): ItemState => {
  const rec = recommendedOf(item);
  return { choice: rec[0] ?? '', other: '', multi: item.multiSelect ? rec : [] };
};

/** The payload of the current choices; null while incomplete (no choice, or "Other" without text). */
export function buildAnswers(items: QuestionItem[], state: Record<string, ItemState>): Answers | null {
  const out: Answers = {};
  for (const item of items) {
    const s = state[item.id]!;
    if (item.multiSelect) {
      if (!s.multi.length) return null;
      out[item.id] = item.options.map((o) => o.label).filter((l) => s.multi.includes(l));
    } else if (s.choice === OTHER) {
      if (!s.other.trim()) return null;
      out[item.id] = s.other.trim();
    } else {
      if (!s.choice) return null;
      out[item.id] = s.choice;
    }
  }
  return out;
}

function Header({ q }: { q: Question }) {
  return (
    <div className="q-head">
      <ByLine a={{ agent: q.asker.agent, ...(q.asker.user ? { user: q.asker.user } : {}) }} agentAvatar size={16} />
      <span className="q-purpose">{PURPOSE_LABEL[q.purpose]}</span>
      {q.blocking && (
        <Tooltip label="The coding agent cannot continue without the answer" openDelay={300}>
          <span className="q-blocking">Blocking</span>
        </Tooltip>
      )}
      <span className="q-head-end">
        <When iso={q.createdAt} />
      </span>
    </div>
  );
}

function Context({ q }: { q: Question }) {
  if (!q.context.length) return null;
  return (
    <div className="q-context" aria-label="About">
      {q.context.slice(0, 4).map((r) => (
        <RefChip key={r} to={r} />
      ))}
      {q.context.length > 4 && <span className="ov-muted">+{q.context.length - 4}</span>}
    </div>
  );
}

function OptionLabel({ label, recommended }: { label: string; recommended: boolean }) {
  return (
    <span className="q-opt-label">
      {label}
      {recommended && <span className="q-rec">Recommended</span>}
    </span>
  );
}

function ItemField({ item, s, set, disabled }: { item: QuestionItem; s: ItemState; set: (s: ItemState) => void; disabled: boolean }) {
  const rec = recommendedOf(item);
  const qid = useId();
  const legend = (
    <div className="q-item-head" id={qid}>
      <span className="q-chip">{item.header}</span>
      <span className="q-text">{item.question}</span>
    </div>
  );
  if (item.multiSelect)
    return (
      <fieldset className="q-item" aria-labelledby={qid} data-testid={`q-item-${item.id}`}>
        {legend}
        <Checkbox.Group value={s.multi} onChange={(v) => set({ ...s, multi: v })} aria-labelledby={qid}>
          <div className="q-options">
            {item.options.map((o) => (
              <Checkbox key={o.label} value={o.label} disabled={disabled} label={<OptionLabel label={o.label} recommended={rec.includes(o.label)} />} description={o.description} className="q-option" data-recommended={rec.includes(o.label) || undefined} />
            ))}
          </div>
        </Checkbox.Group>
        <Text size="xs" c="dimmed" mt={4}>
          Select all that apply.
        </Text>
      </fieldset>
    );
  return (
    <fieldset className="q-item" aria-labelledby={qid} data-testid={`q-item-${item.id}`}>
      {legend}
      <Radio.Group value={s.choice} onChange={(v) => set({ ...s, choice: v })} aria-labelledby={qid}>
        <div className="q-options">
          {item.options.map((o) => (
            <Radio key={o.label} value={o.label} disabled={disabled} label={<OptionLabel label={o.label} recommended={rec.includes(o.label)} />} description={o.description} className="q-option" data-recommended={rec.includes(o.label) || undefined} />
          ))}
          <Radio value={OTHER} disabled={disabled} label="Other" description="Answer in your own words" className="q-option" />
        </div>
      </Radio.Group>
      {s.choice === OTHER && (
        <TextInput
          mt={6}
          size="xs"
          aria-label={`Your answer to ${item.header}`}
          placeholder="Your answer"
          maxLength={2000}
          value={s.other}
          onChange={(e) => set({ ...s, other: e.currentTarget.value })}
          disabled={disabled}
          data-autofocus
          autoFocus
        />
      )}
    </fieldset>
  );
}

/** An open question as a decision card. `canAnswer` false: read-only with the reason. */
export function QuestionCard({ q, canAnswer, reason = NO_ACCESS }: { q: Question; canAnswer: boolean; reason?: string }) {
  const [state, setState] = useState<Record<string, ItemState>>(() => Object.fromEntries(q.questions.map((i) => [i.id, initial(i)])));
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const answer = useAnswerQuestion();
  const answers = useMemo(() => buildAnswers(q.questions, state), [q.questions, state]);
  const disabled = !canAnswer || answer.isPending;
  const submit = () => {
    if (!answers || disabled) return;
    answer.mutate({ id: q.id, answers, ...(notes.trim() ? { notes: notes.trim() } : {}) });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <li className="q-card" data-testid={`question-${q.id}`} data-blocking={q.blocking || undefined} id={`question-${q.id}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={onKeyDown}
        aria-label={`Question from ${q.asker.agent}: ${q.questions[0]?.header ?? q.id}`}
      >
        <Header q={q} />
        <Context q={q} />
        {q.questions.map((item) => (
          <ItemField key={item.id} item={item} s={state[item.id]!} set={(s) => setState((x) => ({ ...x, [item.id]: s }))} disabled={disabled} />
        ))}
        {showNotes ? (
          <Textarea mt={8} size="xs" label="Notes for the coding agent" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} disabled={disabled} autoFocus data-testid="q-notes" />
        ) : (
          <button type="button" className="q-link" onClick={() => setShowNotes(true)} disabled={disabled}>
            Add a note
          </button>
        )}
        <div className="q-foot">
          {!canAnswer && <span className="ov-muted q-reason">{reason}</span>}
          <span className="q-kbd ov-muted" aria-hidden>
            {canAnswer ? `${isMac ? '⌘' : 'Ctrl'}+Enter` : ''}
          </span>
          <Button type="submit" size="xs" leftSection={<IconSend size={13} />} disabled={!answers || disabled} loading={answer.isPending} data-testid="q-submit">
            Submit
          </Button>
        </div>
      </form>
    </li>
  );
}

/** "Answer all recommended": every open question takes its recommended options, after a confirmation. */
export function AnswerAllRecommended({ questions, canAnswer, reason = NO_ACCESS }: { questions: Question[]; canAnswer: boolean; reason?: string }) {
  const [open, setOpen] = useState(false);
  const all = useAnswerAllRecommended(() => setOpen(false));
  if (questions.length < 1) return null;
  const n = questions.length;
  const button = (
    <Button size="compact-xs" variant="subtle" leftSection={<IconChecks size={13} />} onClick={() => setOpen(true)} disabled={!canAnswer} data-testid="q-answer-all">
      Answer all recommended
    </Button>
  );
  return (
    <>
      {canAnswer ? button : <Tooltip label={reason}>{<span>{button}</span>}</Tooltip>}
      <Modal opened={open} onClose={() => setOpen(false)} title="Answer with the recommendations?" size="md">
        <Text size="sm">
          Answer {n === 1 ? 'the open question' : `all ${n} open questions`} with the recommended option{n === 1 && questions[0]!.questions.length === 1 ? '' : 's'}:
        </Text>
        <ul className="q-confirm-list">
          {questions.flatMap((q) =>
            q.questions.map((item) => (
              <li key={`${q.id}|${item.id}`}>
                <span className="q-chip">{item.header}</span> {answerText(recommendedAnswers({ questions: [item] })[item.id])}
              </li>
            )),
          )}
        </ul>
        <Group justify="flex-end" mt="md" gap="xs">
          <Button variant="default" onClick={() => setOpen(false)} disabled={all.isPending}>
            Cancel
          </Button>
          <Button onClick={() => all.mutate(questions)} loading={all.isPending} data-testid="q-answer-all-confirm" data-autofocus>
            Answer {n === 1 ? '1 question' : `${n} questions`}
          </Button>
        </Group>
      </Modal>
    </>
  );
}

const STATUS_LABEL: Record<Question['status'], string> = { open: 'Open', answered: 'Answered', cancelled: 'Withdrawn', superseded: 'Superseded', expired: 'Expired' };

/** A question in compact form (element pages, question page): each question with the answer (or its status). */
export function QuestionSummary({ q, footer }: { q: Question; footer?: ReactNode }) {
  return (
    <li className="q-summary" data-status={q.status} data-testid={`question-summary-${q.id}`}>
      <div className="q-head">
        <span className="q-status" data-status={q.status}>
          {STATUS_LABEL[q.status]}
        </span>
        <ByLine a={{ agent: q.asker.agent, ...(q.asker.user ? { user: q.asker.user } : {}) }} size={14} />
        <span className="q-head-end">
          <When iso={q.answer?.at ?? q.cancelled?.at ?? q.createdAt} />
        </span>
      </div>
      {q.questions.map((item) => {
        const a = q.answer?.answers[item.id];
        return (
          <div key={item.id} className="q-summary-item">
            <span className="q-chip">{item.header}</span> <span className="q-text-sm">{item.question}</span>
            {a !== undefined && (
              <div className="q-answer">
                <span className="ov-muted">Answer:</span> {answerText(a)}
              </div>
            )}
          </div>
        );
      })}
      {q.answer?.notes && <div className="q-answer ov-muted">Note: {q.answer.notes}</div>}
      {q.answer && (
        <div className="ov-muted">
          answered by <ByLine a={{ agent: q.answer.by.agent, ...(q.answer.by.user ? { user: q.answer.by.user } : {}) }} size={12} />
          {q.answer.via === 'chat' ? ' (relayed from chat)' : ''}
        </div>
      )}
      {q.cancelled?.reason && <div className="ov-muted">Withdrawn: {q.cancelled.reason}</div>}
      {footer}
    </li>
  );
}
