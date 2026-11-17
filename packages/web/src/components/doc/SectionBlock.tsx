import { Suspense, type ReactNode } from 'react';
import { Code, Skeleton, Tooltip } from '@mantine/core';
import type { CopyTarget } from '../../lib/refs';
import { CopyRef, copyTargetProps, SectionTargetContext } from '../copy';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { Section } from '@mandate/shared';
import { SectionMeta } from './SectionMeta';
import { SectionTypeIcon } from './SectionTypeIcon';
import { sectionAnchor, sectionTypeLabel } from './anchors';
import { getSectionRenderer } from './types';
import { Backlinks, LinkBadges } from './LinkParts';
import { LineageButton } from '../lineage/LineageButton';
import { Contributors } from '../people/People';
import { bareRef } from '../../lib/lineage';
import { SectionComments } from '../comments/CommentBadge';


const META_TYPES = new Set(['audit-item', 'wo-section']);

/** The rendered body of a section, via the renderer registered for its type. */
export function SectionBody({ section }: { section: Section }) {
  const renderer = getSectionRenderer(section.type);
  // Meta-driven types (audit items, work-order sections) render even without a body: status, findings, code, comments.
  if (!section.body.trim() && !META_TYPES.has(section.type)) return <p className="section-empty">No content yet.</p>;
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

/** Types whose chip adds nothing: plain prose, and items whose page already says what they are (O6, A6). */
const NO_TYPE_CHIP = new Set(['markdown', 'wo-section', 'audit-item']);

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
      <header className="doc-section-header doc-section-header-2row">
        <div className="doc-section-titlerow">
          <h2>
            <a href={`#${sectionAnchor(id)}`} className="doc-section-anchor" aria-label={`Link to ${title}`}>
              #
            </a>
            {title}
          </h2>
          {target && <SectionComments sectionId={id} />}
          {(actions || target) && (
            <span className="section-actions">
              {actions}
              {target && <LineageButton refUri={bareRef(target.ref)} />}
              {target && <CopyRef target={target} />}
            </span>
          )}
        </div>
        <div className="doc-section-subrow">
          <span className="doc-section-badges">
            {!renderer ? (
              <span className="type-badge" data-tone="warn">
                <IconAlertTriangle size={12} />
                Unknown type: {type}
              </span>
            ) : (
              !NO_TYPE_CHIP.has(type) && (
                <span className="type-badge">
                  <SectionTypeIcon type={type} size={12} />
                  {sectionTypeLabel(type)}
                </span>
              )
            )}
            {badge}
            {section.provenance === 'inferred' && (
              <Tooltip
                label={`Inferred from the code (reverse-engineered${typeof section.confidence === 'number' ? `, confidence ${Math.round(section.confidence * 100)}%` : ''}); not yet confirmed by a person. Confirm it by asking your agent to "confirm" this section.`}
                multiline
                maw={320}
                openDelay={300}
              >
                <span className="link-badge" data-tone="warn" data-testid="inferred-badge">
                  Inferred
                </span>
              </Tooltip>
            )}
            {section.archived && (
              <Tooltip label="Archived: kept for history (ids are never reused), no longer in force" multiline maw={320} openDelay={300}>
                <span className="link-badge" data-tone="muted">
                  Archived
                </span>
              </Tooltip>
            )}
            <LinkBadges sectionId={id} />
          </span>
          {target && (
            <span className="section-people">
              <Contributors refUri={bareRef(target.ref)} size="xs" max={3} form="compact" />
            </span>
          )}
        </div>
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
