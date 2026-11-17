/**
 * The comments side panel (a Rail tab, a bottom sheet on narrow screens): the page's threads with the active one
 * expanded, replies as they arrive (polled), an "is replying" hint while an agent owes an answer, a reply box labelled
 * with who it goes to ("Make it a request", Resolve, Send), resolved threads collapsed to one line, and the New thread
 * box with the agent picker (online state, suggestion) when no agent is responsible.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, Checkbox, Loader, Textarea } from '@mantine/core';
import { IconCheck, IconChevronRight, IconMessage, IconRobot, IconX } from '@tabler/icons-react';
import type { CommentThread, CommentView } from '@mandate/shared';
import { normalizeMentions, REF_SCHEME } from '@mandate/shared/refs';
import { AnswerMarkdown } from '../ask/AskThread';
import { RefMentionBox } from '../mentions/RefMentionBox';
import { TimeAgo } from '../TimeAgo';
import { Ticks } from '../Ticks';
import {
  clearCommentFocus,
  setCommentFocus,
  commentBase,
  commentLines,
  useAddComment,
  useAgentsPresence,
  useCommentFocus,
  useCommentState,
  useCommentThreads,
  type AgentPresenceView,
  type PresenceReply,
} from '../../lib/comments';
import { CANT_WAKE } from '../../lib/requests';
import './comments.css';

const HUMAN = 'mandate-ui';
const isHuman = (m: CommentView) => m.author.agent === HUMAN;
const nameOf = (m: CommentView) => (isHuman(m) ? m.author.user ?? 'user' : m.author.agent);
/** Bare references in a message become links (reference chips). */
const linkRefs = (raw: string) => normalizeMentions(raw).replace(/(^|[\s(])(mandate:\/\/[^\s)\]]+)/g, (_m, a: string, r: string) => `${a}[${r.replace(REF_SCHEME, '')}](${r})`);
export const shortTarget = (t: string) => t.replace(REF_SCHEME, '').replace(/^(specs|standards|components|work-orders|requests)\//, '');
const targetLabel = (t: string, doc: string) => {
  const base = commentBase(t);
  const rest = base === doc ? 'whole page' : base.slice(doc.length + 1).replace('sections/', 'section ').replace('steps/', 'step ');
  const l = commentLines(t);
  return l ? `${rest} ${l.replace('#', '')}` : rest;
};

const STATE_LABEL: Record<AgentPresenceView['state'], string> = { online: 'online', busy: 'busy', offline: 'offline' };

/** Active agents (online or busy), wakeable first. */
export function activeAgents(presence: PresenceReply | undefined): AgentPresenceView[] {
  return (presence?.agents ?? []).filter((a) => a.state !== 'offline').sort((x, y) => Number(y.wakeable === true) - Number(x.wakeable === true));
}
/** The preselected agent: the suggestion when it is active, else the first active one ('' when none is). */
export function defaultAgent(presence: PresenceReply | undefined): string {
  const act = activeAgents(presence);
  return (act.find((a) => a.id === presence?.suggested) ?? act[0])?.handle ?? '';
}
export const NO_AGENT_ACTIVE = 'No agent active: start Claude Code with `mandate claude`.';

/** The agent picker: active agents only (online; wakeable first, busy ones with what they are doing). `showOffline` + `allowAny` (reassigning a queued request) keep the old queueing options. */
export function AgentPicker({ presence, value, onChange, showOffline, allowAny, anyHint, name = 'cmt-agent' }: { presence: PresenceReply | undefined; value: string; onChange: (v: string) => void; /** List offline agents too (their work is queued until they connect). */ showOffline?: boolean; allowAny?: boolean; anyHint?: string; name?: string }) {
  const agents = showOffline ? (presence?.agents ?? []) : activeAgents(presence);
  const sug = presence?.suggested;
  return (
    <div className="cmt-picker" role="radiogroup" aria-label="Who should handle this">
      {agents.map((a) => (
        <label key={a.id} className="cmt-pick" data-on={value === a.handle || undefined}>
          <input type="radio" name={name} checked={value === a.handle} onChange={() => onChange(a.handle)} />
          <span className="cmt-dot" data-state={a.state} aria-hidden />
          <span className="cmt-pick-name">{a.label}</span>
          <span className="cmt-pick-state">
            {a.state === 'offline' && showOffline ? 'offline: queued until it connects' : STATE_LABEL[a.state]}
            {a.busyWith[0] ? `: ${a.busyWith[0].summary}` : ''}
          </span>
          {a.state !== 'offline' && a.wakeable === false && (
            <span className="cmt-pick-warn" data-testid="cant-wake">
              <Ticks text={CANT_WAKE} />
            </span>
          )}
          {sug === a.id && <span className="cmt-suggest">suggested{a.state === 'online' ? ' (idle)' : ' (least busy)'}</span>}
        </label>
      ))}
      {allowAny && (
        <label className="cmt-pick" data-on={value === 'any' || undefined}>
          <input type="radio" name={name} checked={value === 'any'} onChange={() => onChange('any')} />
          <IconRobot size={13} aria-hidden />
          <span className="cmt-pick-name">Any agent</span>
          <span className="cmt-pick-state">{anyHint ?? 'queued: the next agent to check in picks it up'}</span>
        </label>
      )}
      {!agents.length && presence && (
        <div className="cmt-faint" data-testid="no-agent-active">
          No agent active: start Claude Code with <code>mandate claude</code>.
        </div>
      )}
    </div>
  );
}

/** The comment box: @agent / @person and @object references (specs, sections, standards, requests, work orders). */
const MentionBox = RefMentionBox;

function Message({ m }: { m: CommentView }) {
  const human = isHuman(m);
  return (
    <div className="cmt-msg" data-agent={!human || undefined}>
      <Avatar size={22} radius="xl" color={human ? 'blue' : 'grape'}>
        {human ? (m.author.user ?? 'U').slice(0, 1).toUpperCase() : <IconRobot size={13} />}
      </Avatar>
      <div className="cmt-msg-main">
        <div className="cmt-msg-head">
          <b>{nameOf(m)}</b>
          {m.blocking && <span className="cmt-chip" data-tone="red">blocking</span>}
          {m.asRequest && <span className="cmt-chip">request</span>}
          <span className="cmt-faint">
            <TimeAgo iso={m.createdAt} />
          </span>
        </div>
        <AnswerMarkdown>{linkRefs(m.body)}</AnswerMarkdown>
      </div>
    </div>
  );
}

function ThreadCard({ t, doc, active, presence, onOpen }: { t: CommentThread; doc: string; active: boolean; presence: PresenceReply | undefined; onOpen: () => void }) {
  const [body, setBody] = useState('');
  const [asRequest, setAsRequest] = useState(false);
  const state = useCommentState();
  const add = useAddComment(() => {
    setBody('');
    setAsRequest(false);
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const msgs = [t, ...t.replies];
  const last = msgs[msgs.length - 1]!;
  const agents = [...new Set(msgs.filter((m) => !isHuman(m)).map((m) => m.author.agent))];
  const to = agents.length ? agents.join(', ') : t.to === 'any' ? 'any agent' : (presence?.responsibleAgents ?? []).join(', ') || 'whoever is responsible';
  const waiting = t.status === 'open' && isHuman(last) && Date.now() - Date.parse(last.createdAt) < 15 * 60_000 && (agents.length > 0 || !!presence?.responsible?.length || !!t.to);
  // "is replying" only when an agent is online or can be woken (unknown while the presence loads).
  const reachable = !presence || presence.agents.some((a) => a.state !== 'offline' || a.wakeable);
  const lines = commentLines(t.target);
  if (t.status === 'resolved' && !active) {
    return (
      <button type="button" className="cmt-resolved" onClick={onOpen} data-testid="thread-resolved">
        <IconCheck size={13} /> <span className="cmt-resolved-body">{t.body.slice(0, 70)}</span>
        <span className="cmt-faint">{targetLabel(t.target, doc)} · resolved{t.resolvedBy ? ` by ${t.resolvedBy}` : ''}</span>
        <IconChevronRight size={13} />
      </button>
    );
  }
  return (
    <div ref={ref} className="cmt-thread" data-active={active || undefined} data-status={t.status} data-testid="thread" id={`comment-${t.id}`}>
      <button type="button" className="cmt-thread-head" onClick={onOpen} aria-expanded={active}>
        <span className="cmt-target">{targetLabel(t.target, doc)}</span>
        {lines && <span className="cmt-chip">{lines.replace('#', '')}</span>}
        {t.blocking && t.status === 'open' && <span className="cmt-chip" data-tone="red">blocking</span>}
        {t.status === 'resolved' && <span className="cmt-chip" data-tone="green">resolved</span>}
        <span className="cmt-faint">{msgs.length}</span>
      </button>
      {!active ? (
        <div className="cmt-preview" onClick={onOpen}>
          <b>{nameOf(last)}</b>: {last.body.slice(0, 120)}
        </div>
      ) : (
        <>
          {msgs.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {waiting && reachable && (
            <div className="cmt-typing" data-testid="agent-replying">
              <Loader size={11} type="dots" /> {agents[0] ?? 'The agent'} is replying…
            </div>
          )}
          {waiting && !reachable && (
            <div className="cmt-typing" data-testid="agent-unreachable">
              Waiting for an agent: none is online or can be woken. Start one with <code>mandate claude</code>; it picks this up when it connects.
            </div>
          )}
          <div className="cmt-reply">
            <MentionBox value={body} onChange={setBody} presence={presence} placeholder={`Reply to ${to}…`} onSubmit={() => body.trim() && add.mutate({ target: t.target, parent: t.id, body: body.trim(), ...(asRequest ? { asRequest: true } : {}) })} />
            <div className="cmt-actions">
              <Checkbox size="xs" label="Make it a request" checked={asRequest} onChange={(e) => setAsRequest(e.currentTarget.checked)} />
              <span className="cmt-faint cmt-to">goes to {to}</span>
              <span className="cmt-spacer" />
              {t.status === 'open' ? (
                <Button size="compact-xs" variant="default" leftSection={<IconCheck size={12} />} loading={state.isPending} onClick={() => state.mutate({ id: t.id, type: 'resolve', doc })}>
                  Resolve
                </Button>
              ) : (
                <Button size="compact-xs" variant="default" onClick={() => state.mutate({ id: t.id, type: 'reopen', doc })}>
                  Reopen
                </Button>
              )}
              <Button size="compact-xs" loading={add.isPending} disabled={!body.trim()} onClick={() => add.mutate({ target: t.target, parent: t.id, body: body.trim(), ...(asRequest ? { asRequest: true } : {}) })}>
                Send
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Start a thread on `target` (a section, step, request, work order or the page). */
function NewThread({ doc, target, quote, onDone }: { doc: string; target: string; quote?: string; onDone: (id?: string) => void }) {
  const presence = useAgentsPresence(target);
  const [body, setBody] = useState(quote ? `> ${quote.replace(/\n+/g, ' ').slice(0, 300)}\n\n` : '');
  const [asRequest, setAsRequest] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const p = presence.data;
  const needsPicker = !!p?.needsPicker && !/@[\w.-]+/.test(body);
  const chosen = pick && activeAgents(p).some((a) => a.handle === pick) ? pick : defaultAgent(p);
  const add = useAddComment((r) => onDone(r.thread?.id));
  const send = () => body.trim() && add.mutate({ target, body: body.trim(), ...(quote?.trim() ? { selectedText: quote.trim().slice(0, 2000) } : {}), ...(needsPicker ? { to: chosen } : {}), ...(asRequest ? { asRequest: true } : {}), ...(blocking ? { blocking: true } : {}) });
  return (
    <div className="cmt-new" data-testid="new-thread">
      <div className="cmt-new-head">
        <b>New thread</b> <span className="cmt-target">{targetLabel(target, doc)}</span>
        <button type="button" className="cmt-x" aria-label="Cancel" onClick={() => onDone()}>
          <IconX size={13} />
        </button>
      </div>
      <MentionBox value={body} onChange={setBody} presence={p} placeholder="Comment… @agent to address one" onSubmit={send} autoFocus />
      {needsPicker && (
        <>
          <div className="cmt-faint">No agent is responsible for this yet. Who should handle it?</div>
          <AgentPicker presence={p} value={chosen} onChange={setPick} />
        </>
      )}
      {!needsPicker && p && !p.needsPicker && <div className="cmt-faint">Goes to {(p.responsibleAgents ?? []).join(', ') || 'the responsible agent'}. Mention @someone to address another.</div>}
      <div className="cmt-actions">
        <Checkbox size="xs" label="Make it a request" checked={asRequest} onChange={(e) => setAsRequest(e.currentTarget.checked)} />
        <Checkbox size="xs" label="Blocking" checked={blocking} onChange={(e) => setBlocking(e.currentTarget.checked)} />
        <span className="cmt-spacer" />
        <Button size="compact-xs" loading={add.isPending} disabled={!body.trim() || (needsPicker && !chosen)} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

export function CommentsPanel({ doc }: { doc: string | undefined }) {
  const q = useCommentThreads(doc);
  const focus = useCommentFocus();
  const presence = useAgentsPresence(doc);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (focus.threadId) setOpen(focus.threadId);
  }, [focus.n, focus.threadId]);
  if (!doc) return <div className="cmt-faint cmt-pad">Comments are on document pages.</div>;
  const threads = q.data?.threads ?? [];
  const openOnes = threads.filter((t) => t.status === 'open');
  const resolved = threads.filter((t) => t.status === 'resolved');
  const activeId = open ?? (openOnes.length === 1 ? openOnes[0]!.id : null);
  const shown = (t: CommentThread) => (
    <ThreadCard key={t.id} t={t} doc={doc} active={activeId === t.id} presence={presence.data} onOpen={() => setOpen(activeId === t.id ? '' : t.id)} />
  );
  return (
    <div className="cmt-panel" data-testid="comments-panel">
      <div className="cmt-title">
        <IconMessage size={15} /> <b>Comments</b>
        <span className="cmt-faint">
          {openOnes.length} open{resolved.length ? ` · ${resolved.length} resolved` : ''}
        </span>
        <span className="cmt-spacer" />
        <Button size="compact-xs" variant="default" onClick={() => setCommentFocusNew(doc)}>
          New thread
        </Button>
      </div>
      {focus.newOn && (
        <NewThread
          key={`${focus.newOn}-${focus.n}`}
          doc={doc}
          target={focus.newOn}
          quote={focus.quote}
          onDone={(id) => {
            clearCommentFocus();
            if (id) setOpen(id);
          }}
        />
      )}
      {!threads.length && !focus.newOn && <div className="cmt-faint cmt-pad">No comments yet. Use the badge next to a section, select text, or start a thread on the page.</div>}
      {openOnes.map(shown)}
      {resolved.length > 0 && <div className="cmt-section-label">Resolved</div>}
      {resolved.map(shown)}
    </div>
  );
}

const setCommentFocusNew = (doc: string) => setCommentFocus({ newOn: doc });
