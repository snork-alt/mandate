import { copyText } from '../../lib/copy';
import type { CopyTarget } from '../../lib/refs';

/** The row / section currently hovered or focused (for the `c` / `Shift+C` shortcuts). */
let active: CopyTarget | null = null;

export function setActiveCopyTarget(t: CopyTarget | null) {
  active = t;
}

export async function copyRef(t: CopyTarget) {
  await copyText(t.ref, 'Copied reference');
}

export async function copyMarkdown(t: CopyTarget) {
  if (t.markdown) await copyText(await t.markdown(), 'Copied as markdown');
}

export async function copyLink(t: CopyTarget) {
  if (t.link) await copyText(t.link, 'Copied link');
}

/** Props that make an element the shortcut target while hovered or focused. */
export function copyTargetProps(t: CopyTarget) {
  return {
    onMouseEnter: () => setActiveCopyTarget(t),
    onMouseLeave: () => active === t && setActiveCopyTarget(null),
    onFocus: () => setActiveCopyTarget(t),
    onBlur: () => active === t && setActiveCopyTarget(null),
  };
}

/** Global `c` / `Shift+C` handler; install once. */
export function installCopyHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!active || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'c') return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (window.getSelection()?.toString()) return; // let normal copy / selection handling win
    e.preventDefault();
    void (e.shiftKey ? copyMarkdown(active) : copyRef(active));
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
