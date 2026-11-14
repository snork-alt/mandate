import { parseNodeUri } from '@mandate/shared/refs';
/**
 * Questions coding agents ask through Mandate (layout "A"): the answer card (per question a short title + badge, the
 * detail clamped to two lines with "More", evidence files with a conform / violate bar, one row of choice buttons with
 * the recommended one preselected and marked; Edit / Other reveal a text field; notes, Submit / Ctrl+Enter), the
 * read-only answered summary, and the batch "Answer all recommended". A single question shows its options as cards.
 */
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Group, Modal, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import {
  IconCheck,
  IconChecks,
  IconCircleCheck,
  IconGitBranch,
  IconHandStop,
  IconHelpCircle,
  IconMessageQuestion,
  IconNote,
  IconPencil,
  IconSend,
  IconShieldCheck,
} from '@tabler/icons-react';
import { KindIcon } from '../refs/KindIcon';
import { answerText, type Question, type QuestionItem } from '@mandate/shared';
import { ByLine } from '../attribution/Attribution';
import { RefChip } from '../refs/RefChip';
import { When } from '../overview/parts';
import { PURPOSE_LABEL, recommendedAnswers, recommendedOf, useAnswerAllRecommended, useAnswerQuestion, type AnswerArgs, type Answers } from '../../lib/questions';
import { AskAboutQuestion } from './AskAboutQuestion';
import './questions.css';

const OTHER = '__other__';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const NO_ACCESS = "Answering needs write (push) access to this project's repository.";
/** An option that asks for the change in words (standard confirmations: Approve / Edit / Skip). */
export const isEditLabel = (label: string) => /^edit\b/i.test(label.trim());

export interface ItemState {
  choice: string;
  other: string;
  multi: string[];
  /** The change for an "Edit" option. */
  edit?: string;
}

const initial = (item: QuestionItem): ItemState => {
  const rec = recommendedOf(item);
  return { choice: rec[0] ?? '', other: '', edit: '', multi: item.multiSelect ? rec : [] };
};

/** One question's answer from its state; null while incomplete (no choice, or Edit / Other without text). */
function itemAnswer(item: QuestionItem, s: ItemState): string | string[] | null {
  if (item.multiSelect) return s.multi.length ? item.options.map((o) => o.label).filter((l) => s.multi.includes(l)) : null;
  if (s.choice === OTHER) return s.other.trim() || null;
  if (!s.choice) return null;
  if (isEditLabel(s.choice)) return s.edit?.trim() ? `${s.choice}: ${s.edit.trim()}` : null;
  return s.choice;
}

/** The payload of the current choices; null while incomplete. Edit answers are free text "Edit: <the change>". */
export function buildAnswers(items: QuestionItem[], state: Record<string, ItemState>): Answers | null {
  const out: Answers = {};
  for (const item of items) {
    const a = itemAnswer(item, state[item.id]!);
    if (a === null) return null;
    out[item.id] = a;
  }
  return out;
}

/** An answer as shown: the chosen option (if any) and free text (Edit's change, or an "Other" answer). */
export function readAnswer(item: QuestionItem, a: string | string[]): { label: string | null; text: string | null } {
  if (Array.isArray(a)) return { label: a.join(', '), text: null };
  const labels = item.options.map((o) => o.label);
  if (labels.includes(a)) return { label: a, text: null };
  const edit = labels.find((l) => a.startsWith(`${l}: `));
  if (edit) return { label: edit, text: a.slice(edit.length + 2) };
  return { label: null, text: a };
}

const PAST: Record<string, string> = { approve: 'Approved', edit: 'Edited', skip: 'Skipped', reject: 'Rejected', accept: 'Accepted', yes: 'Yes', no: 'No' };
const pillText = (label: string | null) => (label === null ? 'Other' : (PAST[label.toLowerCase()] ?? label));
const pillTone = (label: string | null) => (label === null ? 'other' : /^(approve|accept|yes)$/i.test(label) ? 'ok' : /^edit\b/i.test(label) ? 'edit' : /^(skip|reject|no)$/i.test(label) ? 'muted' : 'ok');

const PURPOSE_ICON: Record<Question['purpose'], typeof IconPencil> = {
  decision: IconGitBranch,
  standard_confirmation: IconPencil,
  approval: IconShieldCheck,
  clarification: IconHelpCircle,
  other: IconMessageQuestion,
};

/** Text with `code` spans. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

/** The title / badge / header line of one question (legacy questions: the header is the title). */
function TitleRow({ item, id, end }: { item: QuestionItem; id?: string; end?: ReactNode }) {
  return (
    <div className="qa-title-row" id={id}>
      <span className="qa-title">{item.title ?? item.header}</span>
      {item.badge && <span className="qa-badge">{item.badge}</span>}
      {item.title && <span className="qa-header">{item.header}</span>}
      {end && <span className="qa-title-end">{end}</span>}
    </div>
  );
}

/** The question text, clamped to two lines with "More". */
function Detail({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    // Measured where layout exists; otherwise (no layout) long text counts as more than two lines.
    setOverflows(el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : text.length > 180);
  }, [text, open]);
  return (
    <div className="qa-detail-wrap">
      <div ref={ref} className="qa-detail" data-clamped={!open || undefined} data-testid="qa-detail">
        <Inline text={text} />
      </div>
      {(overflows || open) && (
        <button type="button" className="qa-more" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="qa-more">
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

/** A code reference (Mandate code ref or `repo:path#L..`) -> the path part. */
export const evidencePath = (ref: string) => {
  const r = parseNodeUri(ref);
  if (r?.kind === 'code') return r.path;
  return ref.replace(/^[A-Za-z0-9_.-]+:/, '');
};

function Evidence({ item }: { item: QuestionItem }) {
  const ev = item.evidence ?? [];
  if (!ev.length) return null;
  const counted = ev.some((e) => e.conforming !== undefined || e.violating !== undefined);
  const c = ev.reduce((n, e) => n + (e.conforming ?? 0), 0);
  const v = ev.reduce((n, e) => n + (e.violating ?? 0), 0);
  const pct = c + v ? (c / (c + v)) * 100 : 0;
  return (
    <div className="qa-evidence" data-testid="qa-evidence">
      {ev.map((e) => (
        <span key={e.ref} className="qa-file" title={e.ref}>
          <KindIcon kind="code_file" size={12} />
          <span>{evidencePath(e.ref)}</span>
        </span>
      ))}
      {counted && (
        <span className="qa-conform" aria-label={`${c} conform, ${v} violate`}>
          <span className="qa-bar" aria-hidden>
            <span className="qa-bar-ok" style={{ width: `${pct}%` }} />
            {v > 0 && <span className="qa-bar-bad" style={{ width: `${100 - pct}%` }} />}
          </span>
          <span>
            <b className="qa-ok">{c}</b> conform · <b className={v ? 'qa-bad' : undefined}>{v}</b> violate
          </span>
        </span>
      )}
    </div>
  );
}

interface Choice {
  value: string;
  label: string;
  description: string;
  recommended: boolean;
}

function ItemField({ item, s, set, disabled, single }: { item: QuestionItem; s: ItemState; set: (s: ItemState) => void; disabled: boolean; single: boolean }) {
  const rec = recommendedOf(item);
  const qid = useId();
  const choices: Choice[] = [
    ...item.options.map((o) => ({ value: o.label, label: o.label, description: o.description, recommended: rec.includes(o.label) })),
    ...(item.multiSelect ? [] : [{ value: OTHER, label: 'Other', description: 'Answer in your own words', recommended: false }]),
  ];
  const checked = (v: string) => (item.multiSelect ? s.multi.includes(v) : s.choice === v);
  const pick = (v: string) => {
    if (item.multiSelect) set({ ...s, multi: s.multi.includes(v) ? s.multi.filter((x) => x !== v) : [...s.multi, v] });
    else set({ ...s, choice: v });
  };
  const done = itemAnswer(item, s) !== null;
  const selected = item.multiSelect ? null : choices.find((c) => c.value === s.choice);
  const role = item.multiSelect ? 'checkbox' : 'radio';
  return (
    <fieldset className="qa-item" data-single={single || undefined} aria-labelledby={qid} data-testid={`q-item-${item.id}`}>
      {!single && (
        <span className="qa-check" data-done={done || undefined} aria-hidden>
          {done && <IconCheck size={12} stroke={3} />}
        </span>
      )}
      <div className="qa-body">
        <TitleRow item={item} id={qid} />
        <Detail text={item.question} />
        <Evidence item={item} />
        <div role={item.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={qid} className={single ? 'qa-cards' : 'qa-choices-row'}>
          <div className={single ? 'qa-card-grid' : 'qa-choices'}>
            {choices.map((c) =>
              single ? (
                <button key={c.value} type="button" role={role} aria-checked={checked(c.value)} aria-label={c.recommended ? `${c.label} (recommended)` : c.label} className="qa-opt-card" data-checked={checked(c.value) || undefined} disabled={disabled} onClick={() => pick(c.value)}>
                  <span className="qa-mark" data-kind={role} aria-hidden />
                  <span className="qa-opt-text">
                    <span className="qa-opt-label">
                      {c.label}
                      {c.recommended && <span className="q-rec">Recommended</span>}
                    </span>
                    <span className="qa-opt-desc">{c.description}</span>
                  </span>
                </button>
              ) : (
                <Tooltip key={c.value} label={c.description} openDelay={400} multiline maw={320}>
                  <button type="button" role={role} aria-checked={checked(c.value)} aria-label={c.recommended ? `${c.label} (recommended)` : c.label} className="qa-choice" data-checked={checked(c.value) || undefined} data-recommended={c.recommended || undefined} disabled={disabled} onClick={() => pick(c.value)}>
                    {checked(c.value) && <IconCheck size={13} aria-hidden />}
                    {c.label}
                    {c.recommended && <span className="qa-dot" aria-hidden />}
                  </button>
                </Tooltip>
              ),
            )}
          </div>
          {!single && (
            <span className="qa-choice-note">
              {item.multiSelect ? (
                <>
                  <span className="q-rec">Recommended</span> {rec.join(', ')} · Select all that apply.
                </>
              ) : selected ? (
                <>
                  {selected.recommended && <span className="q-rec">Recommended</span>} {selected.description}
                </>
              ) : null}
            </span>
          )}
        </div>
        {single && item.multiSelect && <span className="qa-choice-note">Select all that apply.</span>}
        {!item.multiSelect && s.choice === OTHER && (
          <TextInput mt={8} aria-label={`Your answer to ${item.header}`} placeholder="Your answer" maxLength={2000} value={s.other} onChange={(e) => set({ ...s, other: e.currentTarget.value })} disabled={disabled} autoFocus />
        )}
        {!item.multiSelect && isEditLabel(s.choice) && (
          <Textarea
            mt={8}
            rows={2}
            label="What should change? (sent to the coding agent)"
            aria-label={`What should change: ${item.title ?? item.header}`}
            maxLength={1900}
            value={s.edit ?? ''}
            onChange={(e) => set({ ...s, edit: e.currentTarget.value })}
            disabled={disabled}
            autoFocus
            className="qa-edit"
            data-testid={`q-edit-${item.id}`}
          />
        )}
      </div>
    </fieldset>
  );
}

function Asker({ q }: { q: Question }) {
  return <ByLine a={{ agent: q.asker.agent, ...(q.asker.user ? { user: q.asker.user } : {}) }} agentAvatar size={20} />;
}

/** Purpose, blocking and the elements the question is about. */
function Chips({ q, blocking }: { q: Question; blocking: boolean }) {
  const P = PURPOSE_ICON[q.purpose];
  return (
    <div className="qa-chips">
      <span className="q-purpose">
        <P size={13} aria-hidden />
        {PURPOSE_LABEL[q.purpose]}
      </span>
      {blocking && q.blocking && (
        <Tooltip label="The coding agent cannot continue without the answer" openDelay={300}>
          <span className="q-blocking">
            <IconHandStop size={13} aria-hidden />
            Blocking
          </span>
        </Tooltip>
      )}
      {q.context.length > 0 && (
        <span className="q-context" aria-label="About">
          <span className="qa-sep" aria-hidden>
            ·
          </span>
          {q.context.slice(0, 4).map((r) => (
            <RefChip key={r} to={r} />
          ))}
          {q.context.length > 4 && <span className="ov-muted">+{q.context.length - 4}</span>}
        </span>
      )}
    </div>
  );
}

/** The question as answered in this UI (shown until the list is refreshed from the server). */
export function answeredLocally(q: Question, a: Pick<AnswerArgs, 'answers' | 'notes'>, user?: string | null): Question {
  return { ...q, status: 'answered', answer: { by: { agent: 'mandate-ui', ...(user ? { user } : {}) }, at: new Date().toISOString(), answers: a.answers, ...(a.notes ? { notes: a.notes } : {}), via: 'ui' } };
}

/**
 * An open question as a decision card. `canAnswer` false: read-only with the reason. `headEnd`: extra controls in the
 * head row (e.g. copy reference, open the question page); `onAnswered`: called with the answer once it is recorded.
 */
export function QuestionCard({ q, canAnswer, reason = NO_ACCESS, headEnd, onAnswered }: { q: Question; canAnswer: boolean; reason?: string; headEnd?: ReactNode; onAnswered?: (a: AnswerArgs) => void }) {
  const [state, setState] = useState<Record<string, ItemState>>(() => Object.fromEntries(q.questions.map((i) => [i.id, initial(i)])));
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const answer = useAnswerQuestion((a) => onAnswered?.(a));
  const answers = useMemo(() => buildAnswers(q.questions, state), [q.questions, state]);
  const disabled = !canAnswer || answer.isPending;
  const single = q.questions.length === 1;
  const total = q.questions.length;
  const done = q.questions.filter((i) => itemAnswer(i, state[i.id]!) !== null).length;
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
  const first = q.questions[0];
  return (
    <li className="q-card" data-testid={`question-${q.id}`} data-blocking={q.blocking || undefined} id={`question-${q.id}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={onKeyDown}
        aria-label={`Question from ${q.asker.agent}: ${first?.title ?? first?.header ?? q.id}`}
      >
        <div className="qa-head">
          <div className="qa-head-row">
            <KindIcon kind="question" />
            <Asker q={q} />
            <span className="q-head-end">
              <When iso={q.createdAt} />
              {headEnd}
            </span>
          </div>
          <Chips q={q} blocking />
        </div>
        <div className="qa-items">
          {q.questions.map((item) => (
            <ItemField key={item.id} item={item} s={state[item.id]!} set={(s) => setState((x) => ({ ...x, [item.id]: s }))} disabled={disabled} single={single} />
          ))}
        </div>
        {showNotes && (
          <div className="qa-notes">
            <Textarea size="sm" label="Notes for the coding agent" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} disabled={disabled} autoFocus data-testid="q-notes" />
          </div>
        )}
        <div className="q-foot">
          {!single && (
            <span className="qa-progress" data-testid="q-progress">
              <span className="qa-dashes" aria-hidden>
                {q.questions.map((i) => (
                  <span key={i.id} data-done={itemAnswer(i, state[i.id]!) !== null || undefined} />
                ))}
              </span>
              <b>
                {done} of {total}
              </b>{' '}
              answered
            </span>
          )}
          {!showNotes && (
            <button type="button" className="q-link" onClick={() => setShowNotes(true)} disabled={disabled}>
              <IconNote size={14} aria-hidden />
              Add a note
            </button>
          )}
          <AskAboutQuestion q={q} />
          {!canAnswer && <span className="ov-muted q-reason">{reason}</span>}
          <span className="q-foot-end">
            {!single && <AnswerAllRecommended questions={[q]} canAnswer={canAnswer} reason={reason} testId="q-card-answer-all" />}
            <Button type="submit" leftSection={<IconSend size={14} />} disabled={!answers || disabled} loading={answer.isPending} data-testid="q-submit" className="qa-submit">
              Submit
              {canAnswer && (
                <span className="qa-kbd" aria-label={`${isMac ? 'Command' : 'Control'}+Enter`}>
                  <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd>
                  <kbd>↵</kbd>
                </span>
              )}
            </Button>
          </span>
        </div>
      </form>
    </li>
  );
}

/** "Answer all recommended": every open question takes its recommended options, after a confirmation. */
export function AnswerAllRecommended({
  questions,
  canAnswer,
  reason = NO_ACCESS,
  testId = 'q-answer-all',
  label = 'Answer all recommended',
  onAnswered,
}: {
  questions: Question[];
  canAnswer: boolean;
  reason?: string;
  testId?: string;
  label?: string;
  /** The ids recorded (the others failed). */
  onAnswered?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const all = useAnswerAllRecommended((r) => {
    setOpen(false);
    onAnswered?.(r.answered);
  });
  if (questions.length < 1) return null;
  const n = questions.length;
  const button = (
    <Button size="compact-sm" variant="subtle" color="gray" leftSection={<IconChecks size={14} />} onClick={() => setOpen(true)} disabled={!canAnswer} data-testid={testId} className="qa-all">
      {label}
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
                <span className="q-chip">{item.title ?? item.header}</span> {answerText(recommendedAnswers({ questions: [item] })[item.id])}
              </li>
            )),
          )}
        </ul>
        <Group justify="flex-end" mt="md" gap="xs">
          <Button variant="default" onClick={() => setOpen(false)} disabled={all.isPending}>
            Cancel
          </Button>
          <Button onClick={() => all.mutate(questions)} loading={all.isPending} data-testid={`${testId}-confirm`} data-autofocus>
            Answer {n === 1 ? '1 question' : `${n} questions`}
          </Button>
        </Group>
      </Modal>
    </>
  );
}

const STATUS_LABEL: Record<Question['status'], string> = { open: 'Open', answered: 'Answered', cancelled: 'Withdrawn', superseded: 'Superseded', expired: 'Expired' };

/** A question in compact read-only form (answered card, element pages, question page): one row per question with the answer. */
export function QuestionSummary({ q, footer }: { q: Question; footer?: ReactNode }) {
  const by = q.answer?.by;
  return (
    <li className="q-summary" data-status={q.status} data-testid={`question-summary-${q.id}`}>
      <div className="qa-head">
        <div className="qa-head-row">
          <KindIcon kind="question" />
          <Asker q={q} />
          <span className="q-status" data-status={q.status}>
            {q.status === 'answered' && <IconCircleCheck size={13} aria-hidden />}
            {STATUS_LABEL[q.status]}
          </span>
          <span className="q-head-end ov-muted">
            {by && (
              <>
                answered by <ByLine a={{ agent: by.agent, ...(by.user ? { user: by.user } : {}) }} size={12} />
                {q.answer?.via === 'chat' ? ' (relayed from chat)' : ''} ·{' '}
              </>
            )}
            <When iso={q.answer?.at ?? q.cancelled?.at ?? q.createdAt} />
          </span>
        </div>
        <Chips q={q} blocking={q.status === 'open'} />
      </div>
      {q.questions.map((item) => {
        const a = q.answer?.answers[item.id];
        const r = a !== undefined ? readAnswer(item, a) : null;
        return (
          <div key={item.id} className="qa-row" data-testid={`q-row-${item.id}`}>
            <span className="qa-check" data-done={r ? true : undefined} aria-hidden>
              {r && <IconCheck size={12} stroke={3} />}
            </span>
            <div className="qa-body">
              <TitleRow
                item={item}
                end={
                  r ? (
                    <span className="qa-pill" data-tone={pillTone(r.label)} data-testid="q-answer-pill">
                      {pillTone(r.label) === 'edit' ? <IconPencil size={13} aria-hidden /> : <IconCheck size={13} aria-hidden />}
                      {pillText(r.label)}
                    </span>
                  ) : undefined
                }
              />
              {!r && <Detail text={item.question} />}
              {r?.text && <blockquote className="qa-quote">{r.text}</blockquote>}
            </div>
          </div>
        );
      })}
      {q.answer?.notes && (
        <div className="qa-sum-note">
          <span className="ov-muted">Note:</span> {q.answer.notes}
        </div>
      )}
      {q.cancelled?.reason && <div className="qa-sum-note ov-muted">Withdrawn: {q.cancelled.reason}</div>}
      {q.supersededBy && <div className="qa-sum-note ov-muted">Superseded by {q.supersededBy}</div>}
      <div className="qa-sum-foot">
        {footer}
        <AskAboutQuestion q={q} />
      </div>
    </li>
  );
}
