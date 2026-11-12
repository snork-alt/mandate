import { Suspense, useState } from 'react';
import { Skeleton, UnstyledButton } from '@mantine/core';
import { IconArrowsMove, IconChevronRight, IconHistory } from '@tabler/icons-react';
import type { SectionDiff } from '@mandate/doc';
import type { Root } from 'mdast';
import { InlineDiff } from '../diff/InlineDiff';
import { SectionBlock } from '../SectionBlock';
import { sectionAnchor, sectionTypeLabel } from '../anchors';
import { SectionMeta } from '../SectionMeta';
import { SectionTypeIcon } from '../SectionTypeIcon';
import { getSectionRenderer } from '../types';
import { TrackedMarkdown } from './TrackedMarkdown';
import type { CopyTarget } from '../../../lib/refs';
import { CopyRef, copyTargetProps, SectionTargetContext } from '../../copy';

function MovedBadge() {
  return (
    <span className="type-badge">
      <IconArrowsMove size={12} />
      Moved
    </span>
  );
}

/** A fenced section (diagram / html) whose body changed: new rendering, toggle for the old one, source diff on demand. */
function ChangedRendering({ diff }: { diff: SectionDiff }) {
  const [showOld, setShowOld] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const shown = showOld ? diff.before! : diff.after!;
  const renderer = getSectionRenderer(shown.type);
  return (
    <div className="tc-block tc-mod tc-mark">
      <div className="tc-render-bar">
        <span className="inline-icon">
          <IconHistory size={13} />
          {sectionTypeLabel(diff.after!.type)} changed
        </span>
        <UnstyledButton className="tc-toggle" onClick={() => setShowOld((s) => !s)}>
          {showOld ? 'Show new version' : 'Show previous'}
        </UnstyledButton>
        <UnstyledButton className="tc-toggle" onClick={() => setShowSource((s) => !s)}>
          <IconChevronRight size={11} style={{ transform: showSource ? 'rotate(90deg)' : undefined }} /> Source diff
        </UnstyledButton>
      </div>
      <div data-old={showOld || undefined} className="tc-render">
        {renderer ? (
          <Suspense fallback={<Skeleton height={180} radius="md" />}>
            <renderer.Body section={shown} />
          </Suspense>
        ) : (
          <pre>{shown.body}</pre>
        )}
      </div>
      {showSource && diff.body && <InlineDiff ops={diff.body.ops} mono />}
    </div>
  );
}

/** A section in tracked-changes mode. */
export function TrackedSection({
  diff,
  tree,
  standardTitles,
  target,
  plain,
}: {
  diff: SectionDiff;
  tree?: Root;
  standardTitles?: Map<string, string>;
  target?: CopyTarget;
  /** Show the version as it is (no change marks). */
  plain?: boolean;
}) {
  if (plain) {
    return diff.status === 'removed' ? null : <SectionBlock section={diff.after!} standardTitles={standardTitles} target={target} />;
  }
  if (diff.status === 'unchanged') {
    return diff.moved ? (
      <div className="tc-section" data-change="moved">
        <SectionBlock section={diff.after!} standardTitles={standardTitles} badge={<MovedBadge />} target={target} />
      </div>
    ) : (
      <SectionBlock section={diff.after!} standardTitles={standardTitles} target={target} />
    );
  }
  if (diff.status === 'added' || diff.status === 'removed') {
    return (
      <div className="tc-section tc-mark" data-change={diff.status}>
        <SectionBlock section={(diff.after ?? diff.before)!} standardTitles={standardTitles} target={target} />
      </div>
    );
  }
  const after = diff.after!;
  const fenced = diff.body && diff.body.mode === 'lines' && !tree;
  return (
    <SectionTargetContext.Provider value={target ?? null}>
    <section
      id={sectionAnchor(after.id)}
      className="doc-section tc-section has-copy-ref"
      data-change="modified"
      data-section-id={after.id}
      {...(target ? copyTargetProps(target) : {})}
    >
      <header className="doc-section-header">
        <h2>
          {diff.title ? (
            <span className="tc-mark">
              <del className="tc-del">{diff.title.before}</del> <ins className="tc-ins">{diff.title.after}</ins>
            </span>
          ) : (
            after.title
          )}
        </h2>
        {after.type !== 'markdown' && (
          <span className="type-badge">
            <SectionTypeIcon type={after.type} size={12} />
            {sectionTypeLabel(after.type)}
          </span>
        )}
        {diff.moved && <MovedBadge />}
        {target && (
          <span className="section-actions">
            <CopyRef target={target} />
          </span>
        )}
      </header>
      <SectionMeta section={after} standardTitles={standardTitles} changes={diff.meta} />
      <div className="doc-section-body">
        {!diff.body ? (
          <SectionBlock section={after} standardTitles={standardTitles} bodyOnly />
        ) : tree ? (
          <TrackedMarkdown tree={tree} />
        ) : fenced ? (
          <ChangedRendering diff={diff} />
        ) : (
          <InlineDiff ops={diff.body.ops} />
        )}
      </div>
    </section>
    </SectionTargetContext.Provider>
  );
}
