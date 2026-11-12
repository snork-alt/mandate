import { Suspense, type ReactNode } from 'react';
import { Code, Skeleton } from '@mantine/core';
import type { CopyTarget } from '../../lib/refs';
import { CopyRef, copyTargetProps, SectionTargetContext } from '../copy';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { Section } from '@mandate/shared';
import { SectionMeta } from './SectionMeta';
import { SectionTypeIcon } from './SectionTypeIcon';
import { sectionAnchor, sectionTypeLabel } from './anchors';
import { getSectionRenderer } from './types';
import { Backlinks, LinkBadges } from './LinkParts';


/** The rendered body of a section, via the renderer registered for its type. */
export function SectionBody({ section }: { section: Section }) {
  const renderer = getSectionRenderer(section.type);
  if (!section.body.trim()) return <p className="section-empty">No content yet.</p>;
  if (!renderer) {
    return (
      <Code block className="unknown-body">
        {section.body}
      </Code>
    );
  }
  return (
    <Suspense fallback={<Skeleton height={section.type === 'markdown' ? 60 : 180} radius="md" />}>
      <renderer.Body section={section} />
    </Suspense>
  );
}

interface Props {
  section: Section;
  standardTitles?: Map<string, string>;
  /** Extra badge next to the title (e.g. "Moved"). */
  badge?: ReactNode;
  /** Extra controls shown on hover in the header (e.g. copy reference). */
  actions?: ReactNode;
  /** Render only the body (used inside tracked sections). */
  bodyOnly?: boolean;
  /** Copy reference target for this section (adds the hover copy button and `c` shortcut). */
  target?: CopyTarget;
}

/** One document section: heading with type badge, metadata chips and the rendered body. */
export function SectionBlock({ section, standardTitles, badge, actions, bodyOnly, target }: Props) {
  const { id, title, type } = section;
  if (bodyOnly) return <SectionBody section={section} />;
  const renderer = getSectionRenderer(type);
  return (
    <SectionTargetContext.Provider value={target ?? null}>
    <section id={sectionAnchor(id)} className={`doc-section has-copy-ref${section.archived ? ' section-archived' : ''}`} data-section-id={id} {...(target ? copyTargetProps(target) : {})}>
      <header className="doc-section-header">
        <h2>
          <a href={`#${sectionAnchor(id)}`} className="doc-section-anchor" aria-label={`Link to ${title}`}>
            #
          </a>
          {title}
        </h2>
        {!renderer ? (
          <span className="type-badge" data-tone="warn">
            <IconAlertTriangle size={12} />
            Unknown type: {type}
          </span>
        ) : (
          type !== 'markdown' && (
            <span className="type-badge">
              <SectionTypeIcon type={type} size={12} />
              {sectionTypeLabel(type)}
            </span>
          )
        )}
        {badge}
        {section.archived && (
          <span className="link-badge" data-tone="muted" title="Archived: kept for history (ids are never reused), no longer in force">
            Archived
          </span>
        )}
        <LinkBadges sectionId={id} />
        {(actions || target) && (
          <span className="section-actions">
            {actions}
            {target && <CopyRef target={target} />}
          </span>
        )}
      </header>
      <SectionMeta section={section} standardTitles={standardTitles} />
      <div className="doc-section-body">
        <SectionBody section={section} />
      </div>
      <Backlinks sectionId={id} />
    </section>
    </SectionTargetContext.Provider>
  );
}
