import { scrollBehavior } from '../../lib/ui';
import { useEffect, useState } from 'react';
import type { Section } from '@mandate/shared';
import { sectionAnchor } from './anchors';
import { SectionTypeIcon } from './SectionTypeIcon';

/** Tracks which section is currently at the top of the viewport. */
function useActiveSection(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(sectionAnchor(id))).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set((e.target as HTMLElement).dataset.sectionId!, e.isIntersecting);
        // The first section (in document order) intersecting the band near the top wins.
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: '-64px 0px -65% 0px', threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

/** Sticky list of sections with type icons and scroll-spy highlighting. */
export function DocOutline({
  sections,
  marks,
  status,
}: {
  sections: Section[];
  marks?: Map<string, 'added' | 'removed' | 'modified'>;
  /** Per-section status element (e.g. a checkmark) shown at the right. */
  status?: Map<string, React.ReactNode>;
}) {
  const active = useActiveSection(sections.map((s) => s.id));
  if (!sections.length) return null;
  return (
    <nav className="doc-outline" aria-label="Sections">
      <div className="doc-outline-label">On this page</div>
      {sections.map((s, i) => (
        <span key={s.id} style={{ display: 'contents' }}>
        {s.type === 'acceptance' && sections[i - 1]?.type !== 'acceptance' && <div className="doc-outline-group">Acceptance criteria</div>}
        <a
          href={`#${sectionAnchor(s.id)}`}
          className="doc-outline-item"
          data-criterion={s.type === 'acceptance' || undefined}
          data-active={s.id === active || undefined}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(sectionAnchor(s.id))?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
            history.replaceState(null, '', `#${sectionAnchor(s.id)}`);
          }}
        >
          <SectionTypeIcon type={s.type} size={13} />
          <span>{s.title}</span>
          {marks?.get(s.id) && <span className="outline-mark" data-change={marks.get(s.id)} aria-label={marks.get(s.id)} />}
          {status?.get(s.id) && <span className="outline-status">{status.get(s.id)}</span>}
        </a>
        </span>
      ))}
    </nav>
  );
}
