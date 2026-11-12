import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, UnstyledButton } from '@mantine/core';
import { IconAt, IconChevronDown, IconQuote } from '@tabler/icons-react';
import { refMention } from '@mandate/shared/refs';
import { api } from '../../api';
import { copyText } from '../../lib/copy';
import type { DocKind } from '../../lib/refs';

interface Props {
  kind: DocKind;
  id: string;
  /** Pin references to this commit (tracked-changes mode). */
  commit?: string;
  /** Source of the version on screen; when undefined the current file is fetched. */
  source?: string | null;
}

interface Picked {
  sectionId: string;
  text: string;
}

/** Selected text per section (outermost `[data-section-id]` elements intersecting the selection). */
function pickSections(root: HTMLElement, range: Range): Picked[] {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]')).filter(
    (el) => !el.parentElement?.closest('[data-section-id]') && range.intersectsNode(el),
  );
  const out: Picked[] = [];
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

const quoteBlock = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');

/**
 * Floating "Copy reference" button for text selected inside a document. Copies the reference to the
 * section(s) containing the selection (with `#L<start>-L<end>` when the quote is found in the source)
 * plus the quote. Cmd/Ctrl+Shift+C does the same while a selection is active.
 */
export function SelectionCopy({ kind, id, commit, source }: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<{ picked: Picked[]; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState(false);

  const read = useCallback(() => {
    const root = anchor.current?.closest<HTMLElement>('.doc-main');
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const picked = pickSections(root, range);
    if (!picked.length) return null;
    const rect = range.getBoundingClientRect();
    return { picked, x: Math.min(rect.right, window.innerWidth - 220), y: rect.bottom + 8 };
  }, []);

  useEffect(() => {
    const update = () => {
      if (menu) return;
      setState(read());
    };
    const hide = () => !menu && setState(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    document.addEventListener('mouseup', update);
    document.addEventListener('keyup', update);
    const onSelection = () => {
      if (window.getSelection()?.isCollapsed) hide();
    };
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', update);
      document.removeEventListener('keyup', update);
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('keydown', onKey);
    };
  }, [read, menu]);

  const build = useCallback(
    async (mode: 'quote' | 'ref' | 'markdown', picked: Picked[]) => {
      if (mode === 'markdown') return picked.map((p) => quoteBlock(p.text)).join('\n\n');
      const text = source !== undefined ? source : await api.raw(kind, id);
      const { locateQuote } = await import('@mandate/doc');
      return picked
        .map((p) => {
          const lines = text ? locateQuote(text, p.text, p.sectionId) : null;
          const ref = refMention({ kind, id, sectionId: p.sectionId, commit, lines: lines ?? undefined });
          return mode === 'ref' ? ref : `${ref}\n${quoteBlock(p.text)}`;
        })
        .join('\n\n');
    },
    [kind, id, commit, source],
  );

  const run = useCallback(
    async (mode: 'quote' | 'ref' | 'markdown', picked = state?.picked) => {
      if (!picked) return;
      await copyText(await build(mode, picked), mode === 'markdown' ? 'Copied quote' : 'Copied reference');
      setMenu(false);
      setState(null);
      window.getSelection()?.removeAllRanges();
    },
    [build, state],
  );

  // Cmd/Ctrl+Shift+C with an active selection in this document.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        const s = read();
        if (s) {
          e.preventDefault();
          void run('ref', s.picked);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [read, run]);

  return (
    <>
      <span ref={anchor} hidden />
      {state &&
        createPortal(
          <div className="selection-copy" style={{ left: state.x, top: state.y }} onMouseDown={(e) => e.preventDefault()} role="toolbar" aria-label="Copy selection">
            <UnstyledButton className="selection-copy-main" onClick={() => void run('ref')}>
              <IconAt size={14} />
              Copy reference
              {state.picked.length > 1 && <span className="faint">· {state.picked.length} sections</span>}
            </UnstyledButton>
            <Menu opened={menu} onChange={setMenu} position="bottom-end" withinPortal width={230}>
              <Menu.Target>
                <UnstyledButton className="selection-copy-more" aria-label="More copy options" onClick={() => setMenu((m) => !m)}>
                  <IconChevronDown size={13} />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown onMouseDown={(e) => e.preventDefault()}>
                <Menu.Item leftSection={<IconAt size={14} />} rightSection={<span className="kbd-hint">⌘⇧C</span>} onClick={() => void run('ref')}>
                  Copy reference
                </Menu.Item>
                <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void run('quote')}>
                  Copy reference with quote
                </Menu.Item>
                <Menu.Item leftSection={<IconQuote size={14} />} onClick={() => void run('markdown')}>
                  Copy quote as markdown
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>,
          document.body,
        )}
    </>
  );
}
