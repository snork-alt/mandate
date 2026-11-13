/**
 * Activity events for people: a sentence per event ("Edited section Limits in API rate limiting") instead of the raw
 * type, and runs of similar events (same actor, same target, within a few minutes) coalesced into one expandable entry
 * ("3 edits to Login with SSO").
 */
import { parseNodeUri, parseRef } from '@mandate/shared/refs';
import type { ActivityEvent } from '../components/activity/types';

/** Events closer than this (same actor and target) form one group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const unquote = (s: string) => s.replace(/"([^"]+)"/g, '$1');
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The summary without its leading actor ("claude-code closed fb-1" → "closed fb-1"; "agent: msg" → "msg"). */
export function stripActor(summary: string, e: Pick<ActivityEvent, 'agent' | 'user'>): string {
  let s = summary.trim();
  for (const who of [e.agent, e.user]) {
    if (!who) continue;
    if (s.startsWith(`${who}: `)) s = s.slice(who.length + 2);
    else if (s.startsWith(`${who} `)) s = s.slice(who.length + 1);
  }
  return s;
}

/** A commit's message: `details.subject` or the summary, without the "agent:" prefix. */
export function commitMessage(e: ActivityEvent): string {
  return stripActor(str(e.details?.subject) ?? e.summary, e);
}

const SECTION_VERB: Record<string, [string, string]> = {
  inserted: ['Added section', 'to'],
  updated: ['Edited section', 'in'],
  moved: ['Moved section', 'in'],
  deleted: ['Removed section', 'from'],
};
const DOC_NOUN: Record<string, string> = { spec: 'spec', standard: 'standard', component: 'component' };

/** One human sentence for an event, without the actor (the avatar shows who). */
export function eventTitle(e: ActivityEvent): string {
  const [family, a, b] = e.type.split('.');
  const title = str(e.details?.title);
  const section = str(e.details?.sectionTitle);
  if (family && DOC_NOUN[family] && a === 'section' && b && SECTION_VERB[b] && section) {
    const [verb, prep] = SECTION_VERB[b];
    return title ? `${verb} ${section} ${prep} ${title}` : `${verb} ${section}`;
  }
  if (family && DOC_NOUN[family] && a === 'created' && title) return `Created ${DOC_NOUN[family]} ${title}`;
  if (family && DOC_NOUN[family] && a === 'deleted' && title) return `Deleted ${DOC_NOUN[family]} ${title}`;
  if (e.type === 'commit') return cap(commitMessage(e));
  if (e.type === 'feedback.closed') {
    const res = str(e.details?.resolution);
    const id = e.refs[0] ? (parseRef(e.refs[0])?.id ?? '') : '';
    if (id && res) return `Closed feedback ${id} as ${res.replace(/_/g, ' ')}`;
  }
  if (e.type === 'approval.override_confirmed') {
    const id = e.refs[0] ? (parseRef(e.refs[0])?.id ?? '') : '';
    return id ? `Confirmed the approval override of feedback ${id}` : 'Confirmed an approval override';
  }
  if (e.type === 'approval.override') {
    const id = e.refs[0] ? (parseRef(e.refs[0])?.id ?? '') : '';
    return id ? `Self-approved feedback ${id} (approval override)` : 'Approval override';
  }
  if (e.type.startsWith('question.')) {
    const what = str(e.details?.header) ?? title ?? str(e.details?.question);
    const id = e.refs.find((r) => parseNodeUri(r)?.kind === 'questions')?.split('/').pop();
    const verb = e.type === 'question.asked' ? 'Asked' : e.type === 'question.answered' ? 'Answered' : 'Withdrew';
    return what ? `${verb} question: ${what}` : `${verb} question${id ? ` ${id}` : ''}`;
  }
  if (e.type === 'work_order.heartbeat') return 'Heartbeat';
  let s = stripActor(e.summary, e);
  // "self-approved fb-1 (override): reason" and similar: keep the sentence, the reason is in the details.
  s = s.replace(/\s*\(override\):.*$/, ' (override)');
  return cap(unquote(s));
}

/** A commit node reference (`commits` kind). */
export const isCommitRef = (r: string) => parseNodeUri(r)?.kind === 'commits';

/** What an event is about: its document (section events → the document; others → refs[0] without sections). */
export function eventTarget(e: ActivityEvent): string | undefined {
  const r = e.refs[0];
  if (!r) return undefined;
  if (parseNodeUri(r)?.kind === 'comments' && e.refs[1]) return e.refs[1]!.split('/sections/')[0];
  if (!parseRef(r)) return r;
  return r.split('/sections/')[0]!.replace(/@[0-9a-f]+$/, '');
}

/** Target title (from the event details) or its id. */
export function targetLabel(e: ActivityEvent): string {
  const title = str(e.details?.title);
  if (title) return title;
  const t = eventTarget(e);
  return (t && parseRef(t)?.id) || t || 'this item';
}

const isEdit = (t: string) => /^(spec|standard|component)\.(updated|section\.(inserted|updated|moved|deleted))$/.test(t);

/** Commit messages that differ only by an item id ("audit: re-check item X n_a in A") group on their stem. */
function commitStem(e: ActivityEvent): { key: string; noun: string; where?: string } {
  const msg = commitMessage(e);
  const recheck = /^audit: re-check item \S+(?: \S+)? in (\S+)/.exec(msg);
  if (recheck) return { key: `recheck:${recheck[1]}`, noun: 're-checks', where: `in audit ${recheck[1]}` };
  const stem = msg.split(/\s+/).slice(0, 2).join(' ');
  return { key: `commit:${stem}`, noun: 'commits', where: `: ${stem}…` };
}

/** Grouping key (null: never grouped). */
export function groupKey(e: ActivityEvent): string | null {
  const who = e.user || e.agent || '';
  if (e.type === 'work_order.heartbeat' || e.heartbeat) return `${who}|hb|${e.refs[0] ?? ''}`;
  if (e.type === 'commit') return `${who}|${commitStem(e).key}`;
  const target = eventTarget(e);
  if (!target) return null;
  if (isEdit(e.type)) return `${who}|edit|${target}`;
  const family = e.type.split('.')[0];
  if (family === 'feedback' || family === 'work_order' || family === 'audit' || family === 'comment' || family === 'verification') return `${who}|${family}|${target}`;
  return `${who}|${e.type}|${target}`;
}

export interface ActivityGroup {
  /** Newest event first. */
  events: ActivityEvent[];
  key: string;
}

/**
 * Coalesce events (newest first): an event joins the most recent group with the same key when it is within
 * `GROUP_WINDOW_MS` of that group's oldest event. Groups keep the position of their newest event.
 */
export function groupEvents(events: ActivityEvent[], windowMs = GROUP_WINDOW_MS): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  const open = new Map<string, ActivityGroup>();
  for (const e of events) {
    const k = groupKey(e);
    const g = k ? open.get(k) : undefined;
    const oldest = g?.events[g.events.length - 1];
    if (g && oldest && Math.abs(Date.parse(oldest.at) - Date.parse(e.at)) <= windowMs) {
      g.events.push(e);
      continue;
    }
    const ng: ActivityGroup = { events: [e], key: k ?? `${e.id}|${e.type}` };
    groups.push(ng);
    if (k) open.set(k, ng);
  }
  return groups;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Title of a group: the event's own title for one event, else "3 edits to Login with SSO". */
export function groupTitle(g: ActivityGroup): string {
  const e = g.events[0]!;
  const n = g.events.length;
  if (n === 1) return eventTitle(e);
  if (e.type === 'work_order.heartbeat' || e.heartbeat) return `${plural(n, 'heartbeat')} on ${targetLabel(e)}`;
  if (e.type === 'commit') {
    const s = commitStem(e);
    return s.noun === 're-checks' ? `${n} re-checks ${s.where}` : `${n} commits${s.where}`;
  }
  if (isEdit(e.type)) return `${n} edits to ${targetLabel(e)}`;
  const family = e.type.split('.')[0];
  const label = targetLabel(e);
  if (family === 'feedback') return `${n} updates to feedback ${label}`;
  if (family === 'work_order') return `${n} updates to work order ${label}`;
  if (family === 'audit') return `${n} audit updates in ${label}`;
  if (family === 'comment') return `${plural(n, 'comment')} on ${label}`;
  if (family === 'verification') return `${plural(n, 'verification')} on ${label}`;
  return `${n} × ${eventTitle(e)}`;
}

/** Local calendar day of an ISO time ("2026-11-12"). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", "Monday 9 Nov". */
export function dayLabel(key: string, now = Date.now()): string {
  if (key === dayKey(new Date(now).toISOString())) return 'Today';
  if (key === dayKey(new Date(now - 86_400_000).toISOString())) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
