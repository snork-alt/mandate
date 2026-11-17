import { useEffect, useRef, useState } from 'react';
import { IconMessage, IconMessagePlus } from '@tabler/icons-react';
import { useInRouterContext, useLocation } from 'react-router';
import { commentBase, commentDocOf, docOfPath, setCommentFocus, threadsOn, useCommentFocus, useCommentThreads } from '../../lib/comments';
import { useRail, useRailOptional } from '../rail/railContext';
import './comments.css';

/** Comment state of one section / step / document: its threads, whether the panel has it in focus. */
export function useTargetComments(target: string) {
  const doc = commentDocOf(target);
  const q = useCommentThreads(doc);
  const focus = useCommentFocus();
  const mine = threadsOn(q.data?.threads ?? [], target);
  const base = commentBase(target);
  const active = (!!focus.threadId && mine.some((t) => t.id === focus.threadId)) || (!!focus.newOn && commentBase(focus.newOn) === base);
  return { threads: mine, active, loaded: !q.isLoading };
}

/** Opens the comments panel on a target: its first open thread, else a new thread there. */
export function useOpenComments() {
  const rail = useRail();
  return (target: string, o: { quote?: string; threadId?: string } = {}) => {
    rail.selectTab('comments');
    if (o.threadId) setCommentFocus({ threadId: o.threadId });
    else setCommentFocus({ newOn: target, ...(o.quote ? { quote: o.quote } : {}) });
  };
}

/** The margin badge: filled with the open count, outlined when only resolved, dashed "+ Comment" when none. */
export function CommentBadge({ target }: { target: string }) {
  const { threads } = useTargetComments(target);
  const rail = useRail();
  const open = threads.filter((t) => t.status === 'open');
  const kind = open.length ? 'open' : threads.length ? 'resolved' : 'none';
  const blocking = open.some((t) => t.blocking);
  const click = () => {
    rail.selectTab('comments');
    const first = open[0] ?? threads[0];
    if (first) setCommentFocus({ threadId: first.id });
    else setCommentFocus({ newOn: target });
  };
  return (
    <button type="button" className="cmt-badge" data-kind={kind} data-blocking={blocking || undefined} onClick={click} aria-label={kind === 'none' ? 'Add a comment' : `${open.length} open comment thread(s), ${threads.length - open.length} resolved`} data-testid="comment-badge">
      {kind === 'none' ? <IconMessagePlus size={12} /> : <IconMessage size={12} />}
      {kind === 'none' ? 'Comment' : open.length || threads.length}
    </button>
  );
}

/** A small "Comment" button next to selected text inside a section (starts a thread quoting it). */
export function SelectionComment() {
  const { pathname } = useLocation();
  const open = useOpenComments();
  const [sel, setSel] = useState<{ x: number; y: number; text: string; target: string } | null>(null);
  useEffect(() => {
    const doc = docOfPath(pathname);
    const check = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      if (!doc || !s || s.isCollapsed || text.length < 2) return setSel(null);
      const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
      const section = node?.closest('section[data-section-id]');
      if (!section || !node?.closest('.doc-section-body')) return setSel(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      setSel({ x: Math.min(r.right, window.innerWidth - 110), y: Math.max(8, r.top - 30), text, target: `${doc}/sections/${section.getAttribute('data-section-id')}` });
    };
    const up = () => setTimeout(check, 0);
    document.addEventListener('mouseup', up);
    document.addEventListener('keyup', up);
    return () => {
      document.removeEventListener('mouseup', up);
      document.removeEventListener('keyup', up);
    };
  }, [pathname]);
  if (!sel) return null;
  return (
    <button
      type="button"
      className="cmt-selbtn"
      style={{ left: sel.x, top: sel.y }}
      data-testid="selection-comment"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        open(sel.target, { quote: sel.text });
        setSel(null);
      }}
    >
      <IconMessagePlus size={13} /> Comment
    </button>
  );
}

/** The badge of a doc-page section; also marks its section while the panel has it in focus. Nothing outside a router / rail (tests, embeds). */
export function SectionComments({ sectionId }: { sectionId: string }) {
  const inRouter = useInRouterContext();
  const rail = useRailOptional();
  if (!inRouter || !rail) return null;
  return <SectionCommentsInner sectionId={sectionId} />;
}
function SectionCommentsInner({ sectionId }: { sectionId: string }) {
  const { pathname } = useLocation();
  const doc = docOfPath(pathname);
  const target = doc ? `${doc}/sections/${sectionId}` : '';
  const { active } = useTargetComments(target);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current?.closest('section');
    el?.toggleAttribute('data-comment-active', active);
  }, [active]);
  return (
    <span ref={ref} className="cmt-badge-wrap">
      {doc && <CommentBadge target={target} />}
    </span>
  );
}

/** The badge of a work-order step (same states as a section; marks its <li> while in focus). */
export function StepComments({ target }: { target: string }) {
  const inRouter = useInRouterContext();
  const rail = useRailOptional();
  if (!inRouter || !rail) return null;
  return <StepCommentsInner target={target} />;
}
function StepCommentsInner({ target }: { target: string }) {
  const { active } = useTargetComments(target);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.closest('li')?.toggleAttribute('data-comment-active', active);
  }, [active]);
  return (
    <span ref={ref} className="cmt-badge-wrap">
      <CommentBadge target={target} />
    </span>
  );
}
