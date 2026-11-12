import { scrollBehavior } from '../../lib/ui';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuoteHighlights, type QuoteMark } from '../../lib/useQuoteHighlights';
import { Button, Menu, Skeleton } from '@mantine/core';
import { IconListTree } from '@tabler/icons-react';
import type { CriterionState, DocLinks, HistoryEntry, Section } from '@mandate/shared';
import { DocLinksContext } from './LinkParts';
import { DocSourceProvider, useDocSourceValue } from './DocSourceContext';
import { onNativeCopy } from '../../lib/nativeCopy';
import { AcceptanceCard, CriterionStateIcon, VerificationCount } from './Acceptance';
import { PropGroup } from '../PropertyList';
import { DocOutline } from './DocOutline';
import { HistoryTimeline } from './HistoryTimeline';
import { SectionBlock } from './SectionBlock';
import { sectionAnchor } from './anchors';
import { SectionTypeIcon } from './SectionTypeIcon';
import { TrackedFieldsProvider, TrackedSection, VersionBanner, type TrackedState } from './tracked';
import { docTarget, sectionTarget, type DocKind } from '../../lib/refs';
import { CopyRef, copyTargetProps } from '../copy';
import { SelectionCopy } from './SelectionCopy';
import { DocInfoContext } from './DocInfoContext';
import { RailDetails } from '../rail/RailDetails';
import { DocAttribution, type AttributionSource } from '../attribution/Attribution';
import { LineagePanel } from '../lineage/LineagePanel';
import { DocContributors } from '../people/People';
import { buildRef } from '@mandate/shared/refs';
import { LevelBadge, RuleCard } from '../rules/RuleParts';

export interface DocPageProps {
  /** Which document this is (for references, links and quotes). */
  doc: { kind: DocKind | 'work-orders' | 'feedback'; id: string; title: string };
  /** Title, summary and pills above the sections (use TrackedValue inside to mark changed fields). */
  header: ReactNode;
  sections: Section[];
  /** File history shown at the top of the right column; selecting an entry shows its changes in place. */
  history: { entries?: HistoryEntry[]; loading: boolean; now: number };
  /** Tracked-changes state (from useTrackedChanges); omit for documents without versions. */
  tracked?: TrackedState;
  /** Custom rendering of each section (default: SectionBlock). */
  renderSection?: (section: Section) => ReactNode;
  /** Extra badge in each section header (e.g. implementation state). */
  sectionBadge?: (section: Section) => ReactNode;
  /** Outline status per section id (overrides change marks). */
  outlineStatus?: Map<string, ReactNode>;
  /** Banner above the header (e.g. "spec changed since"). */
  banner?: ReactNode;
  /** Title of the history panel. */
  historyTitle?: string;
  /** Latest commit of the document (for "Copy pinned reference"). */
  headCommit?: string | null;
  /** Section links, backlinks and derived states (from the doc GET). */
  links?: DocLinks;
  /** Criterion states by acceptance section id (cards and outline icons). */
  criteria?: Map<string, CriterionState>;
  /** Content after the sections (e.g. a standard's verification matrix). */
  footer?: ReactNode;
  /** Custom center content (replaces the sections list; the outline still uses `sections`). */
  content?: ReactNode;
  /** Highlight quotes (e.g. feedback) inside the document; clicking one calls `onQuoteClick`. */
  quotes?: QuoteMark[];
  onQuoteClick?: (id: string) => void;
  /** Doc-type-specific panels under the history (properties, used by, ...). */
  panels?: ReactNode;
  /** Panels shown above the history (e.g. an active claim). */
  topPanels?: ReactNode;
  standardTitles?: Map<string, string>;
  /** Links for history entries of documents without tracked changes (e.g. `?version=` on a work order). */
  versionHref?: (commit: string) => string;
  /** The history entry shown as active (with `versionHref`). */
  activeCommit?: string;
  /** Who created / last edited the document ("Created by X via Y · date"), shown under the header. */
  attribution?: AttributionSource;
  /** Lineage panel reference (default: the document itself; `null` hides the panel). */
  lineageRef?: string | null;
}

function scrollToSection(id: string) {
  document.getElementById(sectionAnchor(id))?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  history.replaceState(null, '', `${location.pathname}${location.search}#${sectionAnchor(id)}`);
}

/** Outline menu replacing the left column on narrow screens. */
function OutlineMenu({ sections }: { sections: Section[] }) {
  if (!sections.length) return null;
  return (
    <Menu position="bottom-start" width={260}>
      <Menu.Target>
        <Button variant="default" leftSection={<IconListTree size={14} />} className="doc-outline-menu">
          Sections
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {sections.map((s) => (
          <Menu.Item key={s.id} leftSection={<SectionTypeIcon type={s.type} size={14} />} onClick={() => scrollToSection(s.id)}>
            {s.title}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Shared layout for structured documents (specs, standards, ...):
 * outline | document | history + doc-specific panels. Selecting a history entry switches the
 * document into tracked-changes mode (Word-style marks, in place). One column on narrow screens.
 */
/** Text of source lines `a-b` (markdown stripped) as a quote to highlight in the rendered section. */
function useLineQuote(lines: string | null, sectionId: string, source: string | null): QuoteMark | null {
  return useMemo(() => {
    const m = lines ? /^(\d+)(?:-(\d+))?$/.exec(lines) : null;
    if (!m || !source || !sectionId) return null;
    const all = source.split('\n');
    const text = all
      .slice(Number(m[1]) - 1, Number(m[2] ?? m[1]))
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^#+\s+/, '').replace(/[`*_]/g, ''))
      .filter((l) => l.trim() && !/^(```|~~~)/.test(l.trim()))
      .join(' ');
    return text ? { id: 'lines', sectionId, quote: text } : null;
  }, [lines, sectionId, source]);
}

/** Consecutive acceptance sections form one group, consecutive rules of one level too; other sections stand alone. */
function groupCriteria(sections: Section[]): { criteria: boolean; rules?: 'must' | 'should' | 'may'; items: Section[] }[] {
  const out: { criteria: boolean; rules?: 'must' | 'should' | 'may'; items: Section[] }[] = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    const level = s.type === 'rule' ? (s.level ?? 'should') : undefined;
    if (s.type === 'acceptance' && last?.criteria) last.items.push(s);
    else if (level && last?.rules === level) last.items.push(s);
    else out.push({ criteria: s.type === 'acceptance', ...(level ? { rules: level } : {}), items: [s] });
  }
  return out;
}
const RULE_GROUP_TITLE = { must: 'Must', should: 'Should', may: 'May' } as const;

const NO_TRACKING: TrackedState = {
  commit: null,
  compare: 'prev',
  view: 'changes',
  setView: () => undefined,
  loading: false,
  notFound: false,
  select: () => undefined,
  setCompare: () => undefined,
  exit: () => undefined,
};

export function DocPage({
  doc,
  header,
  sections,
  history: h,
  tracked = NO_TRACKING,
  panels,
  topPanels,
  standardTitles,
  renderSection,
  sectionBadge,
  outlineStatus,
  banner,
  historyTitle = 'History',
  content,
  footer,
  criteria,
  links,
  headCommit,
  quotes,
  onQuoteClick,
  versionHref,
  activeCommit,
  attribution,
  lineageRef,
}: DocPageProps) {
  const mainRef = useRef<HTMLElement>(null);
  // Deep link to a section that no longer exists at HEAD (only meaningful when viewing an old version).
  const hashSection = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.replace(/^#(section-)?/, '')) : '';
  const missingAtHead = tracked.commit && hashSection && !sections.some((s) => s.id === hashSection) ? hashSection : undefined;
  // `?lines=a-b` (from a versioned #L reference): highlight those source lines.
  const lineParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lines') : null;
  const lineQuote = useLineQuote(lineParam, hashSection, tracked.commit ? (tracked.version?.after ?? null) : null);
  useQuoteHighlights(mainRef, lineQuote ? [lineQuote] : tracked.commit ? [] : (quotes ?? []), lineQuote ? undefined : onQuoteClick, [sections, tracked.data]);
  const versioned = tracked !== NO_TRACKING;
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const id = hash.startsWith('section-') ? hash : hash ? `section-${hash}` : '';
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  const diff = tracked.commit ? tracked.data?.diff : undefined;
  const outline = useMemo(() => (diff ? diff.sections.map((s) => (s.after ?? s.before)!) : sections), [diff, sections]);
  const marks = useMemo(
    () =>
      diff
        ? new Map(
            diff.sections
              .filter((s) => s.status !== 'unchanged')
              .map((s) => [s.id, s.status as 'added' | 'removed' | 'modified']),
          )
        : undefined,
    [diff],
  );

  const criteriaStatus = useMemo(() => {
    if (!criteria) return outlineStatus;
    const m = new Map(outlineStatus ?? []);
    for (const [id, c] of criteria) m.set(id, <CriterionStateIcon state={c.state} size={12} />);
    return m;
  }, [criteria, outlineStatus]);

  // In tracked mode, references are pinned to the viewed commit.
  // Viewing an older version: every reference is pinned to that commit (full sha); otherwise "latest".
  const pin = tracked.commit ? tracked.version?.commit : undefined;
  const docSource = useDocSourceValue(
    doc.kind === 'specs' || doc.kind === 'standards' ? doc.kind : null,
    doc.id,
    pin,
    tracked.commit ? (tracked.version?.after ?? null) : undefined,
  );
  const target = useMemo(() => docTarget(doc.kind, doc.id, pin, headCommit ?? undefined), [doc.kind, doc.id, pin, headCommit]);
  const sectionDocKind = doc.kind === 'feedback' ? 'specs' : doc.kind;

  let body: ReactNode;
  if (content && !tracked.commit) {
    body = content;
  } else if (!tracked.commit) {
    body =
      sections.length === 0 ? (
        <p className="section-empty">This document has no sections yet.</p>
      ) : (
        groupCriteria(sections).map((g) =>
          g.rules ? (
            <div key={`rules-${g.items[0]!.id}`} className="rules-group" data-level={g.rules}>
              <h2 className="criteria-group-title">
                <LevelBadge level={g.rules} /> {RULE_GROUP_TITLE[g.rules]} · {g.items.length}
              </h2>
              {g.items.map((s) => (
                <RuleCard key={s.id} section={s} state={criteria?.get(s.id)} target={sectionTarget(sectionDocKind, doc.id, s)} />
              ))}
            </div>
          ) : g.criteria ? (
            <div key={`group-${g.items[0]!.id}`} className="criteria-group">
              <h2 className="criteria-group-title">
                Acceptance criteria
                {criteria && (
                  <VerificationCount
                    verified={g.items.filter((s) => criteria.get(s.id)?.state === 'verified').length}
                    total={g.items.length}
                    failing={g.items.filter((s) => criteria.get(s.id)?.state === 'failing').length}
                    stale={g.items.filter((s) => criteria.get(s.id)?.state === 'stale').length}
                  />
                )}
              </h2>
              {g.items.map((s) => (
                <AcceptanceCard key={s.id} section={s} state={criteria?.get(s.id)} target={sectionTarget(sectionDocKind, doc.id, s)} />
              ))}
            </div>
          ) : renderSection ? (
            <div key={g.items[0]!.id}>{renderSection(g.items[0]!)}</div>
          ) : (
            <SectionBlock
              key={g.items[0]!.id}
              section={g.items[0]!}
              standardTitles={standardTitles}
              target={sectionTarget(sectionDocKind, doc.id, g.items[0]!, undefined, headCommit ?? undefined)}
              badge={sectionBadge?.(g.items[0]!)}
            />
          ),
        )
      );
  } else if (tracked.error) {
    body = (
      <>
        {/* The banner says what happened in plain words; the technical reason stays one click away. */}
        <details className="version-details" data-testid="version-error-details">
          <summary>Details</summary>
          <pre>{tracked.error.message}</pre>
        </details>
        {sections.map((s) => (
          <SectionBlock key={s.id} section={s} standardTitles={standardTitles} target={sectionTarget(sectionDocKind, doc.id, s)} />
        ))}
      </>
    );
  } else if (!diff) {
    body = <Skeleton height={300} radius="md" mt="lg" />;
  } else {
    const notes = tracked.data?.notes ?? [];
    body = [
      notes.length > 0 && (
        <details key="notes" className="version-details" data-testid="version-notes">
          <summary>
            This version has {notes.length} validation {notes.length === 1 ? 'note' : 'notes'}
          </summary>
          <p>It was written before some of today's document rules and is shown as it was.</p>
          <ul>
            {notes.map((n) => (
              <li key={n.message}>{n.message}</li>
            ))}
          </ul>
        </details>
      ),
      ...diff.sections.map((s) => (
      <TrackedSection
        key={`${s.status}-${s.id}`}
        diff={s}
        tree={tracked.data?.trees.get(s.id)}
        standardTitles={standardTitles}
        target={s.status === 'removed' ? undefined : sectionTarget(sectionDocKind, doc.id, (s.after ?? s.before)!, pin)}
        plain={tracked.view === 'version'}
      />
      )),
    ];
  }

  return (
    <DocInfoContext.Provider value={doc}>
    <DocLinksContext.Provider value={links}>
    <DocSourceProvider value={docSource}>
    <TrackedFieldsProvider changes={diff?.frontmatter}>
      <div className="doc-layout" data-tracking={tracked.commit ? true : undefined}>
        <aside className="doc-outline-col">
          <DocOutline sections={outline} marks={marks} status={criteriaStatus} />
        </aside>
        <article className="doc-main" ref={mainRef} onCopy={(e) => onNativeCopy(e, docSource)}>
          {tracked.commit && <VersionBanner tracked={tracked} missing={missingAtHead} />}
          {banner}
          <div className="doc-header has-copy-ref" {...copyTargetProps(target)}>
            <span className="doc-header-actions">
              <CopyRef target={target} />
            </span>
            {header}
            {attribution && !tracked.commit && <DocAttribution item={attribution} />}
            {!tracked.commit && <DocContributors refUri={buildRef({ kind: doc.kind, id: doc.id })} />}
            <OutlineMenu sections={outline} />
          </div>
          {body}
          {!tracked.commit && footer}
          {(doc.kind === 'specs' || doc.kind === 'standards') && (
            <SelectionCopy kind={doc.kind} id={doc.id} commit={pin} source={tracked.commit ? (tracked.version?.after ?? null) : undefined} />
          )}
        </article>
        <RailDetails>
          {topPanels}
          <PropGroup title={`${historyTitle}${h.entries ? ` · ${h.entries.length}` : ''}`}>
            <HistoryTimeline
              entries={h.entries}
              loading={h.loading}
              now={h.now}
              versionHref={versioned ? (c) => `?version=${c}${tracked.compare === 'current' ? '&compare=current' : ''}` : versionHref}
              activeCommit={tracked.version?.commit ?? activeCommit}
              limit={5}
            />
          </PropGroup>
          {panels}
          {lineageRef !== null && !tracked.commit && (
            <PropGroup title="Lineage">
              <LineagePanel refUri={lineageRef ?? buildRef({ kind: doc.kind, id: doc.id })} />
            </PropGroup>
          )}
        </RailDetails>
      </div>
    </TrackedFieldsProvider>
    </DocSourceProvider>
    </DocLinksContext.Provider>
    </DocInfoContext.Provider>
  );
}
