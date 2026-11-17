import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Tooltip } from '@mantine/core';
import { IconArrowUp, IconHash, IconPlus, IconX } from '@tabler/icons-react';
import { KIND_ICON, refKind } from '../refs';
import { SearchField } from '../SearchField';
import { useRailOptional } from '../rail/railContext';
import { suggestionsFor } from './suggestions';
import { useMcpSearch } from '../../mcp/queries';
import { AgentPicker } from '../comments/CommentsPanel';
import { useAgentsPresence } from '../../lib/comments';
import { AskTurnView } from './AskThread';
import { useAsk } from './AskProvider';
import type { AskChip } from './types';
import { useQuestions } from '../../lib/questions';
import { matches } from '../../lib/useSearchQuery';

const NO_FILTERS = { kinds: [], status: [] };

const KIND_NAME: Partial<Record<string, string>> = { spec: 'Spec', standard: 'Standard', section: 'Section', component: 'Component', work_order: 'Work order', feedback: 'Feedback', question: 'Question' };

/** A picker row: a search hit, or a question (label: its id; sub: shown after the title). */
interface Hit {
  uri: string;
  docTitle: string;
  sectionTitle?: string;
  sectionId?: string;
  label?: string;
  sub?: string;
}

/** "Add context" picker: shared search box, typed results with icons, arrow keys + Enter, and Esc / × / click outside to cancel. */
function ChipPicker({ onPick, onClose }: { onPick: (c: AskChip) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const res = useMcpSearch(term, NO_FILTERS, term.length > 1);
  // Questions coding agents asked are not in the search index's documents: matched here by id and text.
  const asked = useQuestions(undefined, 'all', 200);
  const questionHits = term.length > 1 ? (asked.data?.items ?? []).filter((x) => matches(term, x.id, ...x.questions.flatMap((i) => [i.header, i.question]))).slice(0, 3) : [];
  const hits: Hit[] = [
    ...questionHits.map((x) => ({ uri: x.uri, docTitle: x.questions[0]?.question ?? x.id, sectionTitle: undefined, sectionId: undefined, label: x.id, sub: x.id })),
    ...(res.data?.groups ?? []).flatMap((g) => g.hits.slice(0, 2)).filter((h) => !questionHits.some((x) => x.uri === h.uri)),
  ].slice(0, 8);
  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    const down = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && onClose();
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [onClose]);
  const pick = (h: Hit) => {
    const uri = h.uri.replace(/#.*$/, '');
    onPick({ uri, kind: h.sectionId ? 'section' : (refKind(uri) as AskChip['kind']) ?? 'other', label: h.label ?? (h.sectionTitle ? `${h.docTitle} › ${h.sectionTitle}` : h.docTitle) });
    onClose();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') return e.stopPropagation(), onClose();
    if (!hits.length) return;
    if (e.key === 'ArrowDown') e.preventDefault(), setActive((i) => (i + 1) % hits.length);
    else if (e.key === 'ArrowUp') e.preventDefault(), setActive((i) => (i - 1 + hits.length) % hits.length);
    else if (e.key === 'Enter' && hits[active]) e.preventDefault(), pick(hits[active]);
  };
  return (
    <div className="ask-picker" ref={root}>
      <div className="ask-picker-head">
        <SearchField variant="input" size="sm" autoFocus value={q} onChange={setQ} loading={res.isFetching} placeholder="Add a spec, section, work order, question…" ariaLabel="Add context" onKeyDown={onKey} style={{ flex: 1 }} />
        <button type="button" className="ask-picker-cancel" onClick={onClose} aria-label="Cancel">
          Cancel
        </button>
      </div>
      <div className="ask-picker-list" role="listbox">
        {term.length < 2 && <div className="ask-picker-hint">Type to search · ↑↓ to move · Enter to add · Esc to cancel</div>}
        {term.length > 1 && !res.isFetching && !res.error && hits.length === 0 && <div className="ask-picker-hint">No matches for “{term}”</div>}
        {hits.map((h, i) => {
          const kind = h.sectionId ? 'section' : refKind(h.uri.replace(/#.*$/, ''));
          const Icon = (kind && KIND_ICON[kind]) || IconHash;
          return (
            <button key={h.uri} type="button" role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
              <Icon size={14} className="ask-picker-icon" data-kind={kind ?? undefined} />
              <span className="ask-picker-title">{h.sectionTitle ?? h.docTitle}</span>
              {h.sectionTitle && <span className="ask-picker-sub">{h.docTitle}</span>}
              {h.sub && <span className="ask-picker-sub">{h.sub}</span>}
              <span className="ask-picker-kind">{(kind && KIND_NAME[kind]) ?? ''}</span>
            </button>
          );
        })}
        {res.error && <div className="ask-picker-hint">{res.error.message}</div>}
      </div>
    </div>
  );
}

/**
 * "Ask" tab: answers scroll above a composer pinned to the bottom. A question is answered by one of YOUR coding agents
 * (no model on the server): with one agent online it goes there, with several you pick (or "Any agent"), with none it
 * waits and is answered when an agent connects. The context chips are sent with the question.
 */
export function AskView() {
  const { draft, setDraft, chips, removeChip, addChip, turns, send: onSend, stop: onStop, running: streaming, reset, agentChoice, setAgentChoice } = useAsk();
  const [picking, setPicking] = useState(false);
  const presence = useAgentsPresence(undefined);
  const agents = (presence.data?.agents ?? []).filter((a) => a.state !== 'offline');
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const rail = useRailOptional();
  const visible = rail ? !rail.collapsed && rail.activeTab === 'ask' : true;
  useEffect(() => {
    if (visible) field.current?.focus();
  }, [visible]);

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [turns]);
  const text = draft.trim();
  const needsPick = agents.length > 1;
  const to = needsPick ? (agentChoice && (agentChoice === 'any' || agents.some((a) => a.handle === agentChoice)) ? agentChoice : agents.find((a) => a.id === presence.data?.suggested)?.handle ?? 'any') : agents.length === 1 ? agents[0]!.handle : undefined;
  const canSend = !!text;
  const send = () => {
    if (canSend) onSend(text, to);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="ask">
      <div className="ask-scroll" ref={scroller}>
        {turns.length > 0 && (
          <>
            {turns.map((t) => (
              <AskTurnView key={t.id} turn={t} onCancel={t.running ? onStop : undefined} />
            ))}
            {!streaming && (
              <button type="button" className="ask-add" style={{ alignSelf: 'flex-start' }} onClick={reset}>
                New conversation
              </button>
            )}
          </>
        )}
        {turns.length === 0 && (
          <div className="ask-suggest">
            {suggestionsFor(chips).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  onSend(p, to);
                  field.current?.focus();
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ask-composer">
        {presence.isSuccess && agents.length === 0 && (
          <div className="ask-noagent rail-faint" role="status" data-testid="ask-no-agent">
            No agent online. Open Claude Code with <code>mandate claude</code>: your question waits and is answered when it connects.
          </div>
        )}
        {agents.length === 1 && (
          <div className="rail-faint" data-testid="ask-agent-auto">
            Answered by {agents[0]!.label}
            {agents[0]!.state === 'busy' ? ' (busy: it answers in the background)' : ''}
          </div>
        )}
        {needsPick && <AgentPicker presence={presence.data} value={to ?? 'any'} onChange={setAgentChoice} />}
        <div className="ask-chips" aria-label="Context">
          {chips.map((c) => (
            <Tooltip key={c.uri} label={c.quote ? `${c.uri}\n“${c.quote.slice(0, 200)}”` : c.uri} multiline maw={320} style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }} openDelay={300}>
              <span className="ask-chip" data-kind={c.kind} data-uri={c.uri}>
                {c.label}
                {c.quote && <span className="rail-faint"> · selection</span>}
                <button type="button" aria-label={`Remove ${c.label}`} onClick={() => removeChip(c.uri)}>
                  <IconX size={11} />
                </button>
              </span>
            </Tooltip>
          ))}
          <button type="button" className="ask-add" onClick={() => setPicking((p) => !p)} aria-label="Add context">
            <IconPlus size={12} /> Add
          </button>
        </div>
        {picking && <ChipPicker onPick={addChip} onClose={() => setPicking(false)} />}
        <SearchField
          variant="input"
          multiline
          maxRows={12}
          className="ask-input"
          value={draft}
          onChange={setDraft}
          inputRef={field}
          ariaLabel="Question"
          placeholder="Ask about specs, standards, work orders…"
          onKeyDown={onKeyDown}
          right={
            <Tooltip label="Send (Enter)" openDelay={300}>
              <button type="button" className="ask-send" data-active={canSend || undefined} disabled={!canSend} aria-label="Send" onClick={send}>
                <IconArrowUp size={13} stroke={2} />
              </button>
            </Tooltip>
          }
        />
      </div>
    </div>
  );
}
