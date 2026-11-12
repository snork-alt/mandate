import { useEffect } from 'react';

export interface QuoteMark {
  /** Feedback id (or any key) to report on click. */
  id: string;
  /** Section the quote lives in ('' = anywhere in the root). */
  sectionId: string;
  quote: string;
}

const HIGHLIGHT = 'mandate-feedback';

/** Find `quote` in `el`'s text (whitespace / case insensitive) and return a DOM Range. */
function findRange(el: Element, quote: string): Range | null {
  const needle = quote.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (needle.length < 3) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const map: { node: Text; offset: number }[] = [];
  let text = '';
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.data.length; i++) {
      const ch = n.data[i]!;
      if (/\s/.test(ch)) {
        if (text && !text.endsWith(' ')) {
          text += ' ';
          map.push({ node: n, offset: i });
        }
      } else {
        text += ch.toLowerCase();
        map.push({ node: n, offset: i });
      }
    }
  }
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = map[at]!;
  const end = map[at + needle.length - 1]!;
  const r = document.createRange();
  r.setStart(start.node, start.offset);
  r.setEnd(end.node, end.offset + 1);
  return r;
}

/**
 * Highlight quoted text inside a document with the CSS Custom Highlight API (no DOM changes),
 * and call `onClick(id)` when a highlighted quote is clicked.
 */
export function useQuoteHighlights(root: React.RefObject<HTMLElement | null> | (() => HTMLElement | null), marks: QuoteMark[], onClick?: (id: string) => void, deps: unknown[] = []) {
  useEffect(() => {
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    const el = typeof root === 'function' ? root() : root.current;
    if (!el || !css?.highlights || !HighlightCtor) return;
    let ranges: { id: string; range: Range }[] = [];
    const apply = () => {
      ranges = [];
      for (const m of marks) {
        const scope = m.sectionId ? el.querySelector(`[data-section-id="${CSS.escape(m.sectionId)}"]`) : el;
        const r = scope && findRange(scope, m.quote);
        if (r) ranges.push({ id: m.id, range: r });
      }
      css.highlights!.set(HIGHLIGHT, new HighlightCtor(...ranges.map((r) => r.range)));
    };
    // Content renders asynchronously (lazy section bodies): apply now and after it settles.
    apply();
    const t = setTimeout(apply, 800);
    const onDocClick = (e: MouseEvent) => {
      if (!onClick || !ranges.length) return;
      const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
      const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
      const range = pos ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
      const node = pos?.offsetNode ?? range?.startContainer;
      const offset = pos?.offset ?? range?.startOffset ?? 0;
      if (!node) return;
      const hit = ranges.find((r) => r.range.isPointInRange(node, offset));
      if (hit && !window.getSelection()?.toString()) onClick(hit.id);
    };
    el.addEventListener('click', onDocClick);
    return () => {
      clearTimeout(t);
      el.removeEventListener('click', onDocClick);
      css.highlights!.delete(HIGHLIGHT);
    };
  }, [JSON.stringify(marks), ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
