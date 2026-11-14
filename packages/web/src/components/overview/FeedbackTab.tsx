/**
 * Actions › Feedback (U1): flat rows with a select box, the feedback kind, a two-line title, its spec › section and who
 * filed it, a suggestion icon (the reason in its tooltip), age, Accept / Decline and the "…" menu. The toolbar filters by
 * kind and accepts the selected (or the suggested) items in one go.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, SegmentedControl, Tooltip } from '@mantine/core';
import { IconArrowsCross, IconArrowsSplit, IconBug, IconBulb, IconChevronDown, IconHelpCircle, IconSparkles } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Decision, DecisionsList } from '@mandate/shared';
import { copyText } from '../../lib/copy';
import { decisionPrompt } from '../../lib/prompts';
import { ItemMenu, useActionBlock, useDecisionDialogs, type ItemAction } from '../decisions/DecisionActions';
import { refHref } from '../refs/kinds';
import { LocChip, useDocIndex, type DocEntry } from './actionParts';
import { When } from './parts';

const KIND: Record<string, { label: string; plural: string; icon: typeof IconBug }> = {
  bug: { label: 'Bug', plural: 'Bugs', icon: IconBug },
  improvement: { label: 'Improvement', plural: 'Improvements', icon: IconBulb },
  question: { label: 'Question', plural: 'Questions', icon: IconHelpCircle },
  ambiguity: { label: 'Ambiguity', plural: 'Ambiguities', icon: IconArrowsSplit },
  conflict: { label: 'Conflict', plural: 'Conflicts', icon: IconArrowsCross },
};
const KIND_ORDER = ['bug', 'improvement', 'question', 'ambiguity', 'conflict'];
/** Older servers: the kind is the first word of the context line. */
export const feedbackKindOf = (d: Decision) => d.feedbackKind ?? d.context?.split(' · ')[0]?.replace(/ /g, '_') ?? 'improvement';

const CAP = 10;
const shortId = (ref: string) => ref.split('/').pop() ?? ref;

function KindBadge({ kind }: { kind: string }) {
  const k = KIND[kind] ?? { label: kind.replace(/_/g, ' '), icon: IconHelpCircle };
  return (
    <span className="fb-kind" data-kind={kind}>
      <k.icon size={13} stroke={1.8} />
      {k.label}
    </span>
  );
}

function FeedbackRow({ d, actions, docs, selected, onSelect }: { d: Decision; actions: ItemAction[]; docs: Map<string, DocEntry>; selected?: boolean; onSelect?: (on: boolean) => void }) {
  const prompt = decisionPrompt(d);
  const suggested = d.suggested ? d.options.find((x) => x.id === d.suggested) : undefined;
  const hasPrimary = actions.some((a) => a.primary);
  return (
    <li className="fb-row" data-kind={d.kind} data-selected={selected || undefined} data-testid={`act-row-${d.kind}`}>
      {onSelect ? <Checkbox size="xs" checked={!!selected} onChange={(e) => onSelect(e.currentTarget.checked)} aria-label={`Select ${shortId(d.ref)}`} className="fb-cbx" /> : <span className="fb-cbx" />}
      <KindBadge kind={feedbackKindOf(d)} />
      <div className="fb-main">
        <Link to={refHref(d.ref) ?? '#'} className="fb-title">
          {d.title}
        </Link>
        <div className="fb-ctx">
          {d.subject && <LocChip uri={d.subject} docs={docs} />}
          <span className="mono fb-id">{shortId(d.ref)}</span>
          {d.by && (
            <>
              <span aria-hidden>·</span>
              <span className="fb-by">{d.by}</span>
            </>
          )}
          {d.kind === 'feedback_accepted' && (
            <>
              <span aria-hidden>·</span>
              <span>accepted, no work order acts on it yet</span>
            </>
          )}
        </div>
      </div>
      <div className="fb-side">
        {suggested && (
          <Tooltip
            label={
              <>
                <b>Suggested: {suggested.label.split(' (')[0]!.toLowerCase()}.</b>
                {d.suggestedWhy ? ` ${d.suggestedWhy}` : ''}
              </>
            }
            multiline
            maw={320}
            openDelay={150}
            withinPortal
          >
            <span className="fb-sugg" aria-label={`Suggested: ${suggested.label}`} data-testid="fb-suggested">
              <IconSparkles size={14} stroke={1.7} />
            </span>
          </Tooltip>
        )}
        {d.since && (
          <span className="fb-age">
            <When iso={d.since} />
          </span>
        )}
        {!hasPrimary && (
          <Tooltip label="Copy a prompt that asks your coding agent to handle this" openDelay={300}>
            <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconSparkles size={13} />} onClick={() => void copyText(prompt, 'Prompt copied: paste it into your coding agent')}>
              Ask agent
            </Button>
          </Tooltip>
        )}
        <ItemMenu label={d.title} prompt={prompt} actions={actions} />
      </div>
    </li>
  );
}

/** Rows capped at CAP with a "Show N more" toggle. */
function Rows({ items, render }: { items: Decision[]; render: (d: Decision) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, CAP);
  return (
    <>
      <ul className="act-rows">{shown.map(render)}</ul>
      {items.length > CAP && (
        <button type="button" className="fb-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          <IconChevronDown size={14} style={all ? { transform: 'rotate(180deg)' } : undefined} />
          {all ? 'Show fewer' : `Show ${items.length - CAP} more`}
        </button>
      )}
    </>
  );
}

export function FeedbackTab({ items, counts, actionsOf }: { items: Decision[]; counts: DecisionsList['counts']; actionsOf: (d: Decision) => ItemAction[] }) {
  const docs = useDocIndex();
  const dialogs = useDecisionDialogs();
  const block = useActionBlock();
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const byNewest = (a: Decision, b: Decision) => (b.since ?? '').localeCompare(a.since ?? '');
  const open = useMemo(() => items.filter((d) => d.kind === 'feedback_open').sort(byNewest), [items]);
  const accepted = useMemo(() => items.filter((d) => d.kind === 'feedback_accepted').sort(byNewest), [items]);
  const kinds = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of open) n.set(feedbackKindOf(d), (n.get(feedbackKindOf(d)) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  }, [open]);
  const shown = kind === 'all' ? open : open.filter((d) => feedbackKindOf(d) === kind);
  const picked = shown.filter((d) => selected.has(d.ref));
  const suggested = shown.filter((d) => d.suggested === 'accept');
  const bulk = picked.length ? picked : suggested;
  const toggle = (ref: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(ref);
      else n.delete(ref);
      return n;
    });
  const allOn = shown.length > 0 && picked.length === shown.length;
  const openTotal = counts.feedback_open ?? open.length;
  const segs = [{ value: 'all', label: <span className="fb-seg">All <b>{openTotal}</b></span> }, ...kinds.map(([k, n]) => {
    const K = KIND[k];
    return { value: k, label: <span className="fb-seg">{K && <K.icon size={12} />}{K?.plural ?? k} <b>{n}</b></span> };
  })];

  return (
    <>
      {open.length > 0 && (
        <div className="fb-tool" data-testid="fb-tool">
          <Checkbox
            size="xs"
            className="fb-cbx"
            checked={allOn}
            indeterminate={picked.length > 0 && !allOn}
            onChange={() => setSelected(allOn ? new Set() : new Set(shown.map((d) => d.ref)))}
            aria-label="Select all"
          />
          {kinds.length > 1 && <SegmentedControl size="xs" value={kind} onChange={(v) => { setKind(v); setSelected(new Set()); }} data={segs} aria-label="Filter by kind" data-testid="fb-kinds" />}
          <span className="act-tool-sp" />
          <span className="fb-sort">Newest first</span>
          {bulk.length > 0 && (
            <Tooltip label={block ?? (picked.length ? 'Accept the selected items' : 'Accept the items marked as suggested')} openDelay={300}>
              <Button size="compact-sm" variant="default" leftSection={<IconSparkles size={13} />} disabled={!!block || !dialogs} onClick={() => dialogs?.open({ type: 'accept_many', refs: bulk.map((d) => d.ref), title: `${bulk.length} feedback items` })} data-testid="fb-accept-many">
                {picked.length ? `Accept ${picked.length} selected` : `Accept ${suggested.length} suggested`}
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      <div data-testid="decisions-feedback_open">
        <Rows items={shown} render={(d) => <FeedbackRow key={d.ref} d={d} actions={actionsOf(d)} docs={docs} selected={selected.has(d.ref)} onSelect={(on) => toggle(d.ref, on)} />} />
      </div>
      {accepted.length > 0 && (
        <div data-testid="decisions-feedback_accepted">
          <div className="act-subh">
            Accepted feedback without a work order <span className="act-subh-n">{counts.feedback_accepted ?? accepted.length}</span>
          </div>
          <Rows items={accepted} render={(d) => <FeedbackRow key={d.ref} d={d} actions={actionsOf(d)} docs={docs} />} />
        </div>
      )}
      {(counts.feedback_open ?? 0) + (counts.feedback_accepted ?? 0) > open.length + accepted.length && (
        <div className="ov-foot ov-muted">+{(counts.feedback_open ?? 0) + (counts.feedback_accepted ?? 0) - open.length - accepted.length} more not listed</div>
      )}
    </>
  );
}
