/**
 * The open questions as answer cards, in collapsible groups (by purpose, by the element they are about, or by coding
 * agent): blocking first, then newest first; a count and "Answer all recommended" per group. Questions answered here
 * stay in place as the compact answered summary with the "tell your coding agent to continue" line until the list is
 * refreshed. Cards render a page at a time per group ("Show more") so long lists stay fast.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Button, SegmentedControl, Tooltip } from '@mantine/core';
import { IconChevronRight, IconExternalLink, IconMessageQuestion, IconRobot } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Question } from '@mandate/shared';
import { buildRef, parseRef } from '@mandate/shared/refs';
import { CopyRef } from '../copy';
import { KIND_ICON, fallbackLabel, refHref, refKind } from '../refs/kinds';
import { PURPOSE_GROUP, recommendedAnswers, type AnswerArgs } from '../../lib/questions';
import { questionTarget } from '../../lib/refs';
import { ContinueNotice } from './ContinueNotice';
import { AnswerAllRecommended, QuestionCard, QuestionSummary, answeredLocally } from './QuestionCard';
import './questions.css';

export type GroupBy = 'purpose' | 'about' | 'agent';
export const GROUP_BY_LABEL: Record<GroupBy, string> = { purpose: 'Purpose', about: "What it's about", agent: 'Agent' };
/** Cards rendered per group before "Show more". */
export const GROUP_PAGE = 20;

interface Group {
  key: string;
  label: ReactNode;
  /** Plain text of the label (aria). */
  text: string;
  items: Question[];
}

const NONE = '~none';
/** The element a question is mainly about (its first context ref; sections fold into their document). */
const elementOf = (q: Question): string => {
  const r = q.context[0];
  if (!r) return NONE;
  const p = parseRef(r);
  return p ? buildRef({ kind: p.kind, id: p.id }) : r;
};

/** Blocking first, then newest first. */
const order = (a: Question, b: Question) => Number(b.blocking) - Number(a.blocking) || b.createdAt.localeCompare(a.createdAt);

function ElementLabel({ uri, titles }: { uri: string; titles: Map<string, string> }) {
  if (uri === NONE) return <span>Nothing specific</span>;
  const kind = refKind(uri);
  const Icon = kind ? KIND_ICON[kind] : IconMessageQuestion;
  const href = refHref(uri);
  const label = titles.get(uri) ?? fallbackLabel(uri);
  return (
    <span className="q-grp-el">
      <Icon size={14} stroke={1.6} aria-hidden />
      {href ? (
        <Link to={href} className="q-grp-link" title={uri} onClick={(e) => e.stopPropagation()} data-testid="q-group-link">
          {label}
        </Link>
      ) : (
        <span title={uri}>{label}</span>
      )}
    </span>
  );
}

function groupsOf(qs: Question[], by: GroupBy, titles: Map<string, string>): Group[] {
  const sorted = [...qs].sort(order);
  if (by === 'purpose')
    return PURPOSE_GROUP.map((g) => ({ key: g.purpose, label: g.label, text: g.label, items: sorted.filter((q) => q.purpose === g.purpose) })).filter((g) => g.items.length);
  const map = new Map<string, Question[]>();
  for (const q of sorted) {
    const k = by === 'about' ? elementOf(q) : q.asker.agent;
    map.set(k, [...(map.get(k) ?? []), q]);
  }
  const out = [...map].map(([key, items]): Group => {
    if (by === 'agent')
      return {
        key,
        text: key,
        items,
        label: (
          <span className="q-grp-el">
            <IconRobot size={14} stroke={1.6} aria-hidden />
            {key}
          </span>
        ),
      };
    const text = key === NONE ? 'Nothing specific' : (titles.get(key) ?? fallbackLabel(key));
    return { key, text, items, label: <ElementLabel uri={key} titles={titles} /> };
  });
  // Most blocking / largest groups first; "Nothing specific" last.
  return out.sort((a, b) => Number(a.key === NONE) - Number(b.key === NONE) || Number(b.items.some((q) => q.blocking && q.status === 'open')) - Number(a.items.some((q) => q.blocking && q.status === 'open')) || b.items.length - a.items.length || a.text.localeCompare(b.text));
}

/** Copy the reference and open the question page. */
function CardLinks({ q }: { q: Question }) {
  return (
    <span className="q-card-links">
      <CopyRef target={questionTarget(q.id)} visible size="xs" />
      <Tooltip label="Open the question page" openDelay={400}>
        <ActionIcon component={Link} to={`/questions/${q.id}`} size="xs" variant="subtle" color="gray" aria-label={`Open question ${q.id}`} data-testid="q-open-page">
          <IconExternalLink size={13} />
        </ActionIcon>
      </Tooltip>
    </span>
  );
}

function QuestionGroupSection({
  g,
  canAnswer,
  reason,
  onAnswered,
  onAnsweredIds,
}: {
  g: Group;
  canAnswer: boolean;
  reason: string;
  onAnswered: (q: Question, a: AnswerArgs) => void;
  onAnsweredIds: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(GROUP_PAGE);
  const pending = g.items.filter((q) => q.status === 'open');
  const blocking = pending.filter((q) => q.blocking).length;
  const items = g.items.slice(0, shown);
  const rest = g.items.length - items.length;
  return (
    <section className="q-grp" data-testid={`q-group-${g.key}`} aria-label={g.text}>
      <div className="q-grp-head">
        <button type="button" className="q-grp-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="q-group-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${g.text}`}>
          <IconChevronRight size={14} className="q-grp-chevron" data-open={open || undefined} aria-hidden />
        </button>
        <span className="q-grp-title">{g.label}</span>
        <span className="q-grp-count" data-testid="q-group-count">
          {pending.length}
        </span>
        {blocking > 0 && <span className="q-blocking">{blocking} blocking</span>}
        <span className="q-group-action">
          <AnswerAllRecommended questions={pending} canAnswer={canAnswer} reason={reason} testId={`q-group-answer-all-${g.key}`} onAnswered={onAnsweredIds} />
        </span>
      </div>
      {open && (
        <>
          <ul className="q-cards">
            {items.map((q) =>
              q.status === 'open' ? (
                <QuestionCard key={q.id} q={q} canAnswer={canAnswer} reason={reason} headEnd={<CardLinks q={q} />} onAnswered={(a) => onAnswered(q, a)} />
              ) : (
                <QuestionSummary
                  key={q.id}
                  q={q}
                  footer={
                    <>
                      <ContinueNotice ids={[q.id]} />
                      <CardLinks q={q} />
                    </>
                  }
                />
              ),
            )}
          </ul>
          {rest > 0 && (
            <Button variant="subtle" color="gray" size="compact-sm" mt={8} onClick={() => setShown((n) => n + GROUP_PAGE)} data-testid="q-group-more">
              Show {Math.min(rest, GROUP_PAGE)} more of {rest}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The open questions, grouped (Questions page Open tab, Actions page "Questions from agents"). Keeps the questions
 * answered here (as answered) until the list no longer has them and the component unmounts; `keep` filters those
 * like the caller's filters. Group by: controlled (`by` / `onBy`, e.g. from the URL) or local.
 */
export function OpenQuestionsGrouped({
  questions,
  by: byProp,
  onBy,
  titles,
  canAnswer,
  reason,
  user,
  keep,
  extra,
}: {
  questions: Question[];
  by?: GroupBy;
  onBy?: (by: GroupBy) => void;
  titles: Map<string, string>;
  canAnswer: boolean;
  reason: string;
  /** The signed-in user (shown as who answered). */
  user?: string | null;
  keep?: (q: Question) => boolean;
  /** Extra controls on the Group by bar (right side). */
  extra?: ReactNode;
}) {
  const [localBy, setLocalBy] = useState<GroupBy>('purpose');
  const by = byProp ?? localBy;
  const setBy = onBy ?? setLocalBy;
  const [done, setDone] = useState<Map<string, Question>>(() => new Map());
  // Every question seen in the list, so ones answered elsewhere (answer-all) can still be shown as answered.
  const [seen] = useState(() => new Map<string, Question>());
  for (const q of questions) seen.set(q.id, q);
  const merged = useMemo(() => {
    const ids = new Set(questions.map((q) => q.id));
    return [...questions.map((q) => done.get(q.id) ?? q), ...[...done.values()].filter((q) => !ids.has(q.id) && (!keep || keep(q)))];
  }, [questions, done, keep]);
  const onAnswered = (q: Question, a: AnswerArgs) => setDone((m) => new Map(m).set(q.id, answeredLocally(q, a, user)));
  const onAnsweredIds = (ids: string[]) =>
    setDone((m) => {
      const n = new Map(m);
      for (const id of ids) {
        const q = seen.get(id);
        if (q && !n.has(id)) n.set(id, answeredLocally(q, { answers: recommendedAnswers(q) }, user));
      }
      return n;
    });
  const groups = useMemo(() => groupsOf(merged, by, titles), [merged, by, titles]);
  return (
    <div className="q-grps" data-testid="q-open-groups" data-group-by={by}>
      <div className="q-grps-bar">
        <span className="ov-muted">Group by</span>
        <SegmentedControl
          size="xs"
          value={by}
          onChange={(v) => setBy(v as GroupBy)}
          data={(Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((k) => ({ value: k, label: GROUP_BY_LABEL[k] }))}
          aria-label="Group questions by"
          data-testid="q-group-by"
        />
        {extra && <span className="q-group-action">{extra}</span>}
      </div>
      {groups.map((g) => (
        <QuestionGroupSection key={`${by}:${g.key}`} g={g} canAnswer={canAnswer} reason={reason} onAnswered={onAnswered} onAnsweredIds={onAnsweredIds} />
      ))}
    </div>
  );
}
