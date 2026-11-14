/**
 * Questions coding agents asked through Mandate (`question_ask`), as a list: Open | Answered (answered plus the other
 * closed states: withdrawn, superseded, expired, each with its status mark and a Status filter). Filters: asked by
 * (coding agent / user / client), purpose, what it is about. Open: every open question as an answer card, grouped
 * (by purpose, element or coding agent; `?group=`), answered in place. Answered: compact rows; a row opens /questions/:id.
 */
import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { Button, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { IconArrowForwardUp, IconCircleCheck, IconCircleX, IconClockX, IconMessageQuestion, IconSearch, IconX } from '@tabler/icons-react';
import { useNavigate, useSearchParams } from 'react-router';
import { answerText, type Question } from '@mandate/shared';
import { buildRef, parseRef } from '@mandate/shared/refs';
import { FilterButton, type FilterOption } from '../components/FilterButton';
import { EmptyView, ErrorState, RowsSkeleton } from '../components/ListStates';
import { SearchInput } from '../components/SearchInput';
import { TopBar } from '../components/TopBar';
import { ListHeader, ListRow, RowTime, withNodes, type ChipItem, type ColDef } from '../components/list/ListRow';
import { ActorAvatar } from '../components/people/People';
import { KIND_ICON, fallbackLabel, refHref, refKind } from '../components/refs/kinds';
import { AnswerAllRecommended, NO_ACCESS } from '../components/questions/QuestionCard';
import { OpenQuestionsGrouped, type GroupBy } from '../components/questions/OpenQuestionsGrouped';
import { useDecisionAccess } from '../lib/decisions';
import { PURPOSE_LABEL, useQuestions } from '../lib/questions';
import { useSpecs, useStandards } from '../lib/queries';
import { questionTarget } from '../lib/refs';
import { absoluteTime } from '../lib/time';
import { matches } from '../lib/useSearchQuery';
import { SECTIONS } from '../sections';
import '../components/questions/questions.css';

type Tab = 'open' | 'answered';
const KEYS = ['by', 'purpose', 'about', 'status'] as const;
/** Server cap of `questions_list` per call. */
const LIMIT = 200;

export const QUESTION_STATUS_LABEL: Record<Question['status'], string> = {
  open: 'Open',
  answered: 'Answered',
  cancelled: 'Withdrawn',
  superseded: 'Superseded',
  expired: 'Expired',
};
const CLOSED_ORDER: Question['status'][] = ['answered', 'cancelled', 'superseded', 'expired'];

function QuestionStatusIcon({ status, size = 15 }: { status: Question['status']; size?: number }) {
  const Icon = status === 'open' ? IconMessageQuestion : status === 'answered' ? IconCircleCheck : status === 'cancelled' ? IconCircleX : status === 'superseded' ? IconArrowForwardUp : IconClockX;
  const color = status === 'open' ? 'var(--mantine-color-orange-6)' : status === 'answered' ? 'var(--mantine-color-teal-6)' : 'var(--app-text-faint)';
  return (
    <Tooltip label={QUESTION_STATUS_LABEL[status]} openDelay={300}>
      <span className="inline-icon" aria-label={QUESTION_STATUS_LABEL[status]} data-status={status}>
        <Icon size={size} stroke={1.7} color={color} />
      </span>
    </Tooltip>
  );
}

/** The element a context ref belongs to (sections fold into their document). */
/** Filter values of who asked: coding agent, user and client. */
const askedBy = (x: Question) => [`agent:${x.asker.agent}`, ...(x.asker.user ? [`user:${x.asker.user}`] : []), ...(x.asker.client ? [`client:${x.asker.client}`] : [])];

const elementOf = (r: string): string => {
  const p = parseRef(r);
  return p ? buildRef({ kind: p.kind, id: p.id }) : r;
};
const kindLabel = (r: string): string => {
  const p = parseRef(r);
  return (p && SECTIONS.find((s) => s.kind === p.kind)?.label) ?? 'Other';
};

/** A context ref inside a row link: opens its page without following the row (no nested anchors). */
function ContextChip({ uri, titles }: { uri: string; titles: Map<string, string> }) {
  const navigate = useNavigate();
  const kind = refKind(uri);
  const Icon = kind ? KIND_ICON[kind] : IconMessageQuestion;
  const href = refHref(uri);
  const p = parseRef(uri);
  const title = p ? titles.get(buildRef({ kind: p.kind, id: p.id })) : undefined;
  const label = title ? `${title}${p?.sectionId ? ` › ${p.sectionId}` : ''}` : fallbackLabel(uri);
  const open = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (href) void navigate(href);
  };
  return (
    <span
      className="ref-chip-rich"
      data-kind={kind ?? 'invalid'}
      role={href ? 'link' : undefined}
      tabIndex={href ? 0 : undefined}
      title={uri}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open(e)}
      data-testid="q-context-chip"
    >
      <Icon size={13} stroke={1.6} className="ref-chip-icon" />
      <span className="ref-chip-label">{label}</span>
    </span>
  );
}

const CHIPS_W = 240;
const COLS: ColDef[] = [
  {
    key: 'purpose',
    width: 128,
    hide: 'sm',
    label: 'Purpose',
    tip: 'Why the coding agent asks; Blocking: it cannot continue without the answer',
  },
  {
    key: 'client',
    width: 120,
    hide: 'xl',
    label: 'Client',
    tip: 'The coding agent client that asked',
  },
];

function QuestionsHeader({ tab }: { tab: Tab }) {
  return (
    <ListHeader
      list="questions"
      leadWidth={18}
      id={{ label: 'ID', tip: 'Question id' }}
      idWidth={84}
      main={{
        label: 'Question',
        tip: tab === 'open' ? 'What the coding agent asks' : 'What the coding agent asked, and the answer',
      }}
      chips={{
        label: 'About',
        tip: 'The elements the question concerns (hover "+N" for the rest)',
      }}
      chipsWidth={CHIPS_W}
      cols={COLS}
      people={{
        label: 'Asked by',
        tip: 'The user and coding agent that asked',
      }}
      time={{
        label: tab === 'open' ? 'Asked' : 'Closed',
        tip: tab === 'open' ? 'When it was asked' : 'When it was answered or closed',
      }}
      timeWidth={104}
    />
  );
}

/** The answer (or why it closed without one), one line. */
function outcomeLine(q: Question): string | undefined {
  if (q.answer)
    return `Answer: ${q.questions.map((i) => (q.questions.length > 1 ? `${i.header}: ` : '') + answerText(q.answer!.answers[i.id])).join(' · ')}${q.answer.notes ? ` — ${q.answer.notes}` : ''}`;
  if (q.status === 'cancelled') return `Withdrawn${q.cancelled?.reason ? `: ${q.cancelled.reason}` : ''}`;
  if (q.status === 'superseded') return `Superseded${q.supersededBy ? ` by ${q.supersededBy}` : ''}`;
  if (q.status === 'expired') return 'Expired without an answer';
  return undefined;
}

function QuestionRow({ q, titles }: { q: Question; titles: Map<string, string> }) {
  const first = q.questions[0];
  const more = q.questions.length - 1;
  const closedAt = q.answer?.at ?? q.cancelled?.at;
  const chips: ChipItem[] = q.context.map((r) => ({
    key: r,
    node: <ContextChip uri={r} titles={titles} />,
  }));
  return (
    <ListRow
      to={`/questions/${q.id}`}
      list="questions"
      kind="question"
      copy={questionTarget(q.id)}
      lead={<QuestionStatusIcon status={q.status} />}
      leadWidth={18}
      id={q.id}
      idWidth={84}
      title={
        <span data-testid={`q-row-${q.id}`}>
          {first && <span className="q-chip">{first.header}</span>} {first?.question}
          {more > 0 && <span className="faint small"> +{more} more</span>}
        </span>
      }
      excerpt={outcomeLine(q)}
      chips={chips}
      chipsMax={2}
      chipsWidth={CHIPS_W}
      cols={withNodes(COLS, {
        purpose: (
          <span className="q-head">
            <span className="q-purpose">{PURPOSE_LABEL[q.purpose]}</span>
            {q.blocking && <span className="q-blocking">Blocking</span>}
          </span>
        ),
        client: q.asker.client ? <span className="faint small">{q.asker.client}</span> : null,
      })}
      people={
        <span className="row-slot row-slot-people lr-people">
          <ActorAvatar user={q.asker.user} agent={q.asker.agent} at={q.createdAt} verb="Asked" />
        </span>
      }
      time={
        closedAt ? (
          <RowTime iso={closedAt} prefix={q.status === 'answered' ? undefined : 'closed'} label={`${QUESTION_STATUS_LABEL[q.status]} ${absoluteTime(closedAt)} · asked ${absoluteTime(q.createdAt)}`} />
        ) : (
          <RowTime iso={q.createdAt} label={`Asked ${absoluteTime(q.createdAt)}`} />
        )
      }
      timeWidth={104}
    />
  );
}

export function QuestionsListPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'answered' ? 'answered' : 'open';
  const openQ = useQuestions(undefined, 'open', LIMIT);
  const closedQ = useQuestions(undefined, 'closed', LIMIT);
  const query = tab === 'open' ? openQ : closedQ;
  const access = useDecisionAccess();
  const specs = useSpecs();
  const standards = useStandards();
  const q = params.get('q') ?? '';
  const sel = (k: string) => (params.get(k) ?? '').split(',').filter(Boolean);
  const set = (k: string, v: string | string[]) =>
    setParams(
      (p) => {
        const value = Array.isArray(v) ? v.join(',') : v;
        if (value) p.set(k, value);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );
  const titles = useMemo(
    () =>
      new Map([
        ...(specs.data ?? []).map((s) => [buildRef({ kind: 'specs', id: s.id }), s.title] as const),
        ...(standards.data ?? []).map((s) => [buildRef({ kind: 'standards', id: s.id }), s.title] as const),
      ]),
    [specs.data, standards.data],
  );

  const all = query.data?.items ?? [];
  const f = { by: sel('by'), purpose: sel('purpose'), about: sel('about'), status: tab === 'answered' ? sel('status') : [] };
  const pass = (x: Question) =>
      matches(q, x.id, ...x.questions.flatMap((i) => [i.header, i.question]), ...x.context, outcomeLine(x)) &&
      (!f.by.length || askedBy(x).some((v) => f.by.includes(v))) &&
      (!f.purpose.length || f.purpose.includes(x.purpose)) &&
      (!f.about.length || x.context.some((r) => f.about.includes(elementOf(r))) || (f.about.includes('~none') && !x.context.length)) &&
      (!f.status.length || f.status.includes(x.status));
  const visible = all.filter(pass);
  const count = (pred: (x: Question) => boolean) => all.filter(pred).length;
  const active = KEYS.some((k) => f[k].length);

  const byOptions = useMemo(() => {
    const seen = new Map<string, FilterOption>();
    const add = (value: string, label: string, group: string) => {
      if (!seen.has(value))
        seen.set(value, {
          value,
          label,
          group,
          count: all.filter((x) => askedBy(x).includes(value)).length,
        });
    };
    for (const x of all) add(`agent:${x.asker.agent}`, x.asker.agent, 'Coding agent');
    for (const x of all) if (x.asker.user) add(`user:${x.asker.user}`, x.asker.user, 'User');
    for (const x of all) if (x.asker.client) add(`client:${x.asker.client}`, x.asker.client, 'Client');
    return [...seen.values()];
  }, [all]);
  const aboutOptions = useMemo(() => {
    const seen = new Map<string, FilterOption>();
    for (const x of all)
      for (const r of x.context) {
        const el = elementOf(r);
        if (!seen.has(el))
          seen.set(el, {
            value: el,
            label: titles.get(el) ?? fallbackLabel(el),
            group: kindLabel(el),
            count: all.filter((y) => y.context.some((c) => elementOf(c) === el)).length,
          });
      }
    const opts = [...seen.values()].sort((a, b) => a.group!.localeCompare(b.group!) || a.label.localeCompare(b.label));
    const none = all.filter((x) => !x.context.length).length;
    return none
      ? [
          ...opts,
          {
            value: '~none',
            label: 'Nothing specific',
            group: 'Other',
            count: none,
          },
        ]
      : opts;
  }, [all, titles]);

  const openCount = openQ.data?.total;
  const closedCount = closedQ.data?.total;
  const canAnswer = access.data?.canDecide ?? false;
  const openVisible = tab === 'open' ? visible.filter((x) => x.status === 'open') : [];
  const reason = access.isPending ? 'Checking access…' : NO_ACCESS;
  const groupBy: GroupBy = (['about', 'agent'] as const).find((g) => g === params.get('group')) ?? 'purpose';

  return (
    <>
      <TopBar crumbs={[{ label: 'Questions' }]}>
        {openQ.data && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {openCount} open · {(openCount ?? 0) + (closedCount ?? 0)} total
          </Text>
        )}
      </TopBar>
      <div className="toolbar">
        <SegmentedControl
          value={tab}
          onChange={(v) =>
            setParams(
              (p) => {
                if (v === 'open') p.delete('tab');
                else p.set('tab', v);
                p.delete('status');
                return p;
              },
              { replace: true },
            )
          }
          data={[
            {
              value: 'open',
              label: openCount !== undefined ? `Open ${openCount}` : 'Open',
            },
            {
              value: 'answered',
              label: closedCount !== undefined ? `Answered ${closedCount}` : 'Answered',
            },
          ]}
          aria-label="Question status"
          data-testid="q-tabs"
        />
        <FilterButton label="Asked by" selected={f.by} onChange={(v) => set('by', v)} options={byOptions} searchable />
        <FilterButton
          label="Purpose"
          selected={f.purpose}
          onChange={(v) => set('purpose', v)}
          options={(Object.keys(PURPOSE_LABEL) as Question['purpose'][]).map((p) => ({
            value: p,
            label: PURPOSE_LABEL[p],
            count: count((x) => x.purpose === p),
          }))}
        />
        <FilterButton label="About" selected={f.about} onChange={(v) => set('about', v)} options={aboutOptions} searchable width={280} />
        {tab === 'answered' && (
          <FilterButton
            label="Status"
            selected={f.status}
            onChange={(v) => set('status', v)}
            options={CLOSED_ORDER.map((s) => ({
              value: s,
              label: QUESTION_STATUS_LABEL[s],
              icon: <QuestionStatusIcon status={s} size={13} />,
              count: count((x) => x.status === s),
            }))}
          />
        )}
        {active && (
          <Button variant="subtle" color="gray" leftSection={<IconX size={12} />} onClick={() => setParams((p) => (KEYS.forEach((k) => p.delete(k)), p), { replace: true })}>
            Clear
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {tab === 'open' && <AnswerAllRecommended questions={openVisible} canAnswer={canAnswer} reason={reason} />}
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search questions…" />
      </div>

      {query.isPending && <RowsSkeleton rows={6} />}
      {query.isError && <ErrorState error={query.error as Error} onRetry={() => void query.refetch()} />}
      {query.data &&
        all.length === 0 &&
        (tab === 'open' ? (
          <EmptyView
            icon={<IconMessageQuestion size={22} stroke={1.5} />}
            title="No open questions"
            description="When a coding agent asks you something through Mandate, it waits here for your answer."
          />
        ) : (
          <EmptyView icon={<IconCircleCheck size={22} stroke={1.5} />} title="No answered questions yet" description="Questions you answer (or that a coding agent withdraws) are kept here." />
        ))}
      {query.data && all.length > 0 && visible.length === 0 && (
        <EmptyView icon={<IconSearch size={22} stroke={1.5} />} title="No matching questions" description="Try another filter or search term." />
      )}
      {tab === 'open' && visible.length > 0 && (
        <div className="q-open-page">
          <OpenQuestionsGrouped
            questions={openVisible}
            by={groupBy}
            onBy={(v) => set('group', v === 'purpose' ? '' : v)}
            titles={titles}
            canAnswer={canAnswer}
            reason={reason}
            user={access.data?.user}
            keep={pass}
          />
        </div>
      )}
      {tab === 'answered' && visible.length > 0 && <QuestionsHeader tab={tab} />}
      {tab === 'answered' &&
        visible.map((x) => (
          <QuestionRow key={x.id} q={x} titles={titles} />
        ))}
      {query.data && query.data.total > all.length && (
        <Text size="xs" c="var(--app-text-faint)" px="md" py="xs">
          Showing the newest {all.length} of {query.data.total}.
        </Text>
      )}
    </>
  );
}
