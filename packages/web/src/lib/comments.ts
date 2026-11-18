/**
 * Comments on any object (spec / standard / component sections, requests, work orders and their steps): the threads of
 * a document (live: polled while the panel or a badge is on screen), agent presence for the picker (`agents_presence`),
 * posting (`comment_add`, uiAllowed), resolve / reopen, and the small shared state of the side panel (which thread or
 * target is open, a quote to start from).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { buildRef, parseNodeUri, REF_SCHEME, type RefKind } from '@mandate/shared/refs';
import type { CommentCounts, CommentThread } from '@mandate/shared';
import { callTool } from '../mcp/client';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const COMMENT_POLL_MS = 4000;

/** The document (or request / work order) a comment target belongs to: `<kind>/<id>` reference, no section, step or lines. */
export function commentDocOf(target: string): string {
  const m = /^(mandate:\/\/(?:specs|standards|components|work-orders|requests|feedback)\/[a-z0-9-]+)/.exec(target.replace(/^@mandate:/, '').replace(/@[0-9a-f]{4,40}/, ''));
  return m ? m[1]!.replace('/feedback/', '/requests/') : target;
}
/** The section / step reference of a target without a version or lines. */
export const commentBase = (target: string) => target.replace(/@[0-9a-f]{4,40}/, '').replace(/#L\d+(-L\d+)?$/, '').replace('/feedback/', '/requests/');
export const commentLines = (target: string) => /#L(\d+)(?:-L(\d+))?$/.exec(target)?.[0]?.slice(1);

export const commentsKey = (doc: string) => ['comments', doc] as const;

export function useCommentThreads(doc: string | undefined, poll = true) {
  return useQuery({
    queryKey: commentsKey(doc ?? ''),
    enabled: !!doc,
    queryFn: ({ signal }) => callTool<{ target: string; counts: CommentCounts; threads: CommentThread[] }>('list', { of: 'comments', target: doc, includeResolved: true }, signal),
    refetchInterval: poll ? COMMENT_POLL_MS : false,
    staleTime: 2000,
  });
}

export interface AgentPresenceView {
  id: string;
  handle: string;
  label: string;
  user?: string;
  state: 'online' | 'busy' | 'reconnecting' | 'offline';
  /** An event stream (channel / hook) is connected: news wakes the agent. false: connected over MCP only. */
  wakeable?: boolean;
  lastSeen?: string;
  busyWith: { ref: string; summary: string }[];
  repos: string[];
}
export interface PresenceReply {
  agents: AgentPresenceView[];
  responsible?: string[];
  responsibleAgents?: string[];
  suggested?: string | null;
  needsPicker?: boolean;
}
export function useAgentsPresence(ref: string | undefined) {
  return useQuery({
    queryKey: ['agents-presence', ref ?? ''],
    queryFn: ({ signal }) => callTool<PresenceReply>('agents_presence', ref ? { ref } : {}, signal),
    refetchInterval: 10_000,
    staleTime: 5000,
  });
}

export interface AddCommentArgs {
  target: string;
  body: string;
  parent?: string;
  to?: string;
  asRequest?: boolean;
  blocking?: boolean;
  /** The text selected in the page: delivered to the agent with the target's displayed state. */
  selectedText?: string;
}
export function useAddComment(onDone?: (r: { thread?: CommentThread; routing?: { via: string; wakes: string[] } }) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AddCommentArgs) => callTool<{ thread?: CommentThread; routing?: { via: string; wakes: string[] } }>('comment_add', { ...a }, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Comment not sent', message: errorText(e) }),
    onSuccess: (r, a) => {
      void qc.invalidateQueries({ queryKey: commentsKey(commentDocOf(a.target)) });
      onDone?.(r);
    },
  });
}
export function useCommentState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; type: 'resolve' | 'reopen'; doc: string }) => callTool<unknown>(a.type === 'resolve' ? 'comment_resolve' : 'comment_reopen', { id: a.id }, undefined, { retry: false }),
    onError: (e) => notifications.show({ color: 'red', title: 'Not changed', message: errorText(e) }),
    onSettled: (_r, _e, a) => void qc.invalidateQueries({ queryKey: commentsKey(a.doc) }),
  });
}

/* ------------------------------------------------------------------ panel state */

export interface CommentFocus {
  /** The thread to show expanded. */
  threadId?: string;
  /** Start a new thread on this target (a section / step / request / doc; may end in #Lx-Ly). */
  newOn?: string;
  /** Selected text to quote in the new thread. */
  quote?: string;
  /** Bumped on every request so the panel re-focuses. */
  n: number;
}
let focus: CommentFocus = { n: 0 };
const subs = new Set<() => void>();
export function setCommentFocus(f: Omit<CommentFocus, 'n'>) {
  focus = { ...f, n: focus.n + 1 };
  subs.forEach((s) => s());
}
export const clearCommentFocus = () => setCommentFocus({});
export function useCommentFocus(): CommentFocus {
  return useSyncExternalStore(
    useCallback((cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    }, []),
    () => focus,
  );
}

/** Threads of a section / step / the doc itself from a document's threads (line ranges ignored for sections). */
export function threadsOn(threads: CommentThread[], target: string): CommentThread[] {
  const base = commentBase(target);
  return threads.filter((t) => commentBase(t.target) === base);
}

export const docRefFor = (kind: RefKind | 'requests', id: string) => buildRef({ kind: (kind === 'requests' ? 'feedback' : kind) as RefKind, id });
export const isMandateRef = (s: string) => !!parseNodeUri(s);

/** The `<kind>/<id>` reference of the document page a path shows (`/specs/x`, `/requests/x`, ...), else undefined. */
export function docOfPath(pathname: string): string | undefined {
  const m = /^\/(specs|standards|components|work-orders|requests|feedback)\/([^/@]+)/.exec(pathname);
  return m ? `${REF_SCHEME}${m[1] === 'feedback' ? 'requests' : m[1]}/${decodeURIComponent(m[2]!)}` : undefined;
}
