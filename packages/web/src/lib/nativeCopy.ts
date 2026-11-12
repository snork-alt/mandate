import type { ClipboardEvent } from 'react';
import { notifications } from '@mantine/notifications';
import { createElement } from 'react';
import { buildRef, mentionOf } from '@mandate/shared/refs';
import { copyText } from './copy';
import type { DocSource } from '../components/doc/DocSourceContext';

/** Selected text per section (outermost `[data-section-id]` elements intersecting the selection). */
export function pickSections(root: HTMLElement, range: Range): { sectionId: string; text: string }[] {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]')).filter(
    (el) => !el.parentElement?.closest('[data-section-id]') && range.intersectsNode(el),
  );
  const out: { sectionId: string; text: string }[] = [];
  for (const el of els) {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const text = r.toString().replace(/ /g, ' ').trim();
    if (text) out.push({ sectionId: el.dataset.sectionId!, text });
  }
  return out;
}

/** Section references (with `#Lx-Ly` when the text is found in the source) for a selection. */
export function selectionReferences(doc: DocSource, picks: { sectionId: string; text: string }[]): string[] {
  const src = doc.source();
  const lib = doc.lib();
  return picks.map((p) => {
    const lines = src && lib ? lib.locateQuote(src, p.text, p.sectionId) : null;
    return buildRef({ kind: doc.kind, id: doc.id, sectionId: p.sectionId, commit: doc.commit, lines: lines ?? undefined });
  });
}

/**
 * Native copy (Cmd/Ctrl+C) inside document content copies the Mandate reference(s) for the
 * selection; a toast offers the raw text instead. Inputs and non-document content are untouched.
 */
export function onNativeCopy(e: ClipboardEvent<HTMLElement>, doc: DocSource | null): void {
  if (!doc) return;
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, [contenteditable="true"], .mantine-Spotlight-root, .selection-copy')) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const picks = pickSections(e.currentTarget, range);
  if (!picks.length) return;
  const raw = sel.toString();
  const uris = selectionReferences(doc, picks);
  const text = uris.map(mentionOf).join('\n');
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', uris.map((u) => `<a href="${u}">${mentionOf(u)}</a>`).join('<br>'));
  const id = `copy-${Date.now()}`;
  notifications.show({
    id,
    title: 'Copied reference',
    autoClose: 4000,
    withBorder: true,
    message: createElement(
      'div',
      null,
      createElement('code', { className: 'toast-code' }, text),
      createElement(
        'button',
        {
          type: 'button',
          className: 'toast-action',
          onClick: () => {
            notifications.hide(id);
            void copyText(raw, 'Copied text');
          },
        },
        'Copy text instead',
      ),
    ),
  });
}
