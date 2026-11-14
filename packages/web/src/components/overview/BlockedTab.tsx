/**
 * Actions › Blocked (U2 / U3): what waits on work that is not done, grouped by blocker (start with the one that unblocks
 * the most) or by the spec that waits. The grouping is remembered in this browser.
 */
import { useState, type ReactNode } from 'react';
import { Button, SegmentedControl, Tooltip } from '@mantine/core';
import { IconChevronRight, IconCircleDashed, IconCopy, IconCornerDownRight, IconInfoCircle, IconLock } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { OverviewBlocked, OverviewBlocker, ProjectOverview, SpecMaturity } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { copyText } from '../../lib/copy';
import { allPrompts, itemPrompt } from '../../lib/prompts';
import { groupByBlocker, groupBySpec, readGrouping, writeGrouping, type BlockedGrouping } from '../../lib/blocked';
import { CopyPromptButton, ItemMenu } from '../decisions/DecisionActions';
import { MaturityBadge } from '../maturity/MaturityBadge';
import { useSpecMaturities } from '../maturity/SpecMaturity';
import { KIND_ICON, refHref } from '../refs/kinds';
import { KindIcon } from '../refs/KindIcon';
import { RefChip } from '../refs/RefChip';
import { plural } from './parts';

/** The tabs a spec's other reasons for attention live in (footer links). */
export interface OtherTab {
  key: string;
  label: string;
  icon: typeof IconLock;
}

const woStatus = (s: string) => (s === 'pending' ? 'queued' : s.replace(/_/g, ' '));
const hrefOf = (b: OverviewBlocked) => (b.kind === 'work_order' ? `/work-orders/${b.id}` : `/specs/${b.specId}#section-${b.uri.split('/sections/')[1]}`);

/** State badges of a blocker: not implemented / missing, and its work order (or none). */
function BlockerStates({ x, itself }: { x: OverviewBlocker; itself?: OverviewBlocked }) {
  const WO = KIND_ICON.work_order;
  return (
    <div className="bk-states">
      {x.state === 'work_order' ? (
        <span className="bk-st" data-tone="wo">
          <WO size={11} />
          {x.workOrder ? `${x.workOrder.id} ${woStatus(x.workOrder.status)}${x.workOrder.agent ? ` · ${x.workOrder.agent}` : ''}` : 'Work order not done'}
        </span>
      ) : (
        <>
          <span className="bk-st" data-tone={x.state === 'broken' ? 'danger' : 'warn'}>
            <IconCircleDashed size={12} />
            {x.state === 'broken' ? 'Missing or archived' : 'Not implemented'}
          </span>
          {x.workOrder ? (
            <span className="bk-st" data-tone="wo">
              <WO size={11} />
              {x.workOrder.id} {woStatus(x.workOrder.status)}
              {x.workOrder.agent ? ` · ${x.workOrder.agent}` : ''}
            </span>
          ) : (
            <span className="bk-st" data-tone="none">
              No work order
            </span>
          )}
        </>
      )}
      {itself && (
        <span className="bk-st" data-tone="danger" data-testid="bk-itself">
          <IconLock size={11} />
          Itself blocked
        </span>
      )}
    </div>
  );
}

/** The prompt to get a blocker moving: implement the section, or continue its work order. */
const startPrompt = (x: OverviewBlocker) =>
  x.workOrder ? itemPrompt('continue_work', buildRef({ kind: 'work-orders', id: x.workOrder.id })) : x.state === 'work_order' ? itemPrompt('continue_work', x.uri) : itemPrompt('implement', x.uri);

function StartButton({ x }: { x: OverviewBlocker }) {
  return (
    <Tooltip label="Copies a prompt: paste it into your coding agent" openDelay={400}>
      <Button size="compact-xs" variant="default" leftSection={<IconCopy size={13} />} onClick={() => void copyText(startPrompt(x), 'Prompt copied: paste it into your coding agent')} data-testid="bk-start">
        Copy prompt: start work
      </Button>
    </Tooltip>
  );
}

function SpecLine({ title, specId, maturity }: { title: string; specId?: string; maturity?: Map<string, SpecMaturity> }) {
  const m = specId ? maturity?.get(specId) : undefined;
  return (
    <div className="bk-spec">
      <KindIcon kind="spec" size={12} />
      <span className="bk-spec-t">{title}</span>
      {m && <MaturityBadge m={m} size="sm" />}
    </div>
  );
}

/* ---------------------------------------------------------------- by blocker */

function ByBlocker({ items }: { items: OverviewBlocked[] }) {
  const maturity = useSpecMaturities();
  const groups = groupByBlocker(items);
  return (
    <>
      <div className="bk-head" aria-hidden>
        <span>Blocker · start here</span>
        <span />
        <span>Waiting on it</span>
      </div>
      <ul className="act-rows" data-testid="bk-by-blocker">
        {groups.map((g) => {
          const x = g.blocker;
          const direct = g.waiting.length;
          return (
            <li key={x?.uri ?? 'unknown'} className="bk-group" data-testid="bk-group">
              <div className="bk-left">
                {x ? (
                  <>
                    {x.docTitle && <SpecLine title={x.docTitle} />}
                    <Link to={refHref(x.uri) ?? '#'} className="bk-title">
                      <KindIcon kind={x.state === 'work_order' ? 'work_order' : 'section'} size={13} />
                      {x.title}
                    </Link>
                    <BlockerStates x={x} itself={g.itself} />
                    {g.itself && g.itself.blockedBy.length > 0 && (
                      <div className="bk-chain">
                        <IconCornerDownRight size={13} />
                        waits on
                        {g.itself.blockedBy.slice(0, 3).map((y) => (
                          <RefChip key={y.uri} to={y.uri} label={y.title} />
                        ))}
                        {g.itself.blockedBy.length > 3 && <span>+{g.itself.blockedBy.length - 3} more</span>}
                      </div>
                    )}
                    <div className="bk-act">
                      <StartButton x={x} />
                      <span className="bk-unb" data-testid="bk-unblocks">
                        unblocks <b>{g.unblocks}</b>
                        {g.unblocks > direct && <b> ({direct} directly)</b>}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="bk-title">Waiting on a dependency</div>
                    <div className="bk-spec">A depends_on target that is missing or archived: fix the link or restore the target.</div>
                  </>
                )}
              </div>
              <div className="bk-arrow" aria-hidden>
                <span />
              </div>
              <div className="bk-right">
                {g.waiting.map((b) => (
                  <div key={b.uri} className="bk-wait">
                    <div className="bk-wait-main">
                      <SpecLine title={b.specTitle ?? b.specId} specId={b.specId} maturity={maturity} />
                      <Link to={hrefOf(b)} className="bk-wait-t">
                        {b.kind === 'work_order' && <span className="mono act-id">{b.id}</span>} {b.title}
                      </Link>
                    </div>
                    <ItemMenu label={b.title} prompt={itemPrompt('resolve_blocker', b.uri)} />
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ---------------------------------------------------------------- by spec */

/** Sections of the spec: blocked (orange), implemented (green), the rest (grey). */
function SectionBar({ blocked, implemented, total }: { blocked: number; implemented: number; total: number }) {
  const b = Math.min(blocked, total);
  const i = Math.min(implemented, total - b);
  if (total <= 24)
    return (
      <span className="bk-bar" aria-hidden>
        {Array.from({ length: total }, (_, k) => (
          <i key={k} data-s={k < b ? 'b' : k < b + i ? 'i' : 'o'} />
        ))}
      </span>
    );
  return (
    <span className="bk-bar" data-wide aria-hidden>
      <i data-s="b" style={{ flex: b }} />
      <i data-s="i" style={{ flex: i }} />
      <i data-s="o" style={{ flex: total - b - i }} />
    </span>
  );
}

function ByBlockerCell({ b, byUri }: { b: OverviewBlocked; byUri: Map<string, OverviewBlocked> }) {
  if (!b.blockedBy.length) return <div className="bk-cell"><div className="bk-spec">Waiting on a dependency (missing or archived)</div></div>;
  return (
    <div className="bk-cell">
      {b.blockedBy.slice(0, 3).map((x) => {
        const itself = byUri.get(x.uri);
        return (
          <div key={x.uri} className="bk-cell-one">
            {x.docTitle && <div className="bk-spec">{x.docTitle}</div>}
            <Link to={refHref(x.uri) ?? '#'} className="bk-wait-t">
              {x.title}
            </Link>
            <div className="bk-states">
              <BlockerStates x={x} />
              {itself?.blockedBy[0] && (
                <span className="bk-st" data-tone="danger">
                  <IconLock size={11} />
                  waits on {itself.blockedBy[0].title}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {b.blockedBy.length > 3 && <div className="bk-spec">+{b.blockedBy.length - 3} more</div>}
    </div>
  );
}

function BySpec({ items }: { items: OverviewBlocked[] }) {
  const maturity = useSpecMaturities();
  const byUri = new Map(items.map((b) => [b.uri, b]));
  return (
    <ul className="act-rows" data-testid="bk-by-spec">
      {groupBySpec(items).map((g) => {
        const m = maturity.get(g.specId);
        return (
          <li key={g.specId} className="bk-sgroup" data-testid="bk-sgroup">
            <div className="bk-sgroup-h">
              <KindIcon kind="spec" size={15} />
              <Link to={`/specs/${g.specId}`} className="bk-sgroup-t">
                {g.specTitle}
              </Link>
              {m && <MaturityBadge m={m} size="sm" />}
              <span className="bk-sgroup-r">
                {m && m.sections.total > 0 ? (
                  <>
                    <SectionBar blocked={g.sections} implemented={m.sections.implemented} total={m.sections.total} />
                    {g.sections} of {m.sections.total} sections blocked
                  </>
                ) : (
                  plural(g.items.length, 'item') + ' blocked'
                )}
              </span>
            </div>
            {g.items.map((b) => {
              const one = b.blockedBy.length === 1 ? b.blockedBy[0]! : null;
              return (
                <div key={b.uri} className="bk-srow">
                  <Link to={hrefOf(b)} className="bk-me">
                    <KindIcon kind={b.kind === 'work_order' ? 'work_order' : 'section'} size={13} />
                    {b.kind === 'work_order' && <span className="mono act-id">{b.id}</span>}
                    <span className="bk-me-t">{b.title}</span>
                  </Link>
                  <span className="bk-waits">
                    <IconLock size={12} />
                    waits on
                    <span className="bk-dash" />
                    <IconChevronRight size={12} />
                  </span>
                  <ByBlockerCell b={b} byUri={byUri} />
                  <span className="bk-srow-act">
                    {one ? <StartButton x={one} /> : null}
                    <ItemMenu label={b.title} prompt={itemPrompt('resolve_blocker', b.uri)} />
                  </span>
                </div>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- tab */

export function BlockedTab({ o, projectId, others, onOpen }: { o: ProjectOverview; projectId: string; others: OtherTab[]; onOpen: (key: string) => void }) {
  const [grouping, setGrouping] = useState<BlockedGrouping>(readGrouping);
  const pick = (g: string) => {
    const v = g === 'spec' ? 'spec' : 'blocker';
    setGrouping(v);
    writeGrouping(v);
  };
  const items = o.blocked;
  const sections = items.filter((b) => b.kind === 'section').length;
  const wos = items.length - sections;
  const what = [sections ? plural(sections, 'section') : '', wos ? plural(wos, 'work order') : ''].filter(Boolean).join(' and ');
  const blockers = new Set(items.flatMap((b) => b.blockedBy.map((x) => x.uri))).size;
  const specs = new Set(items.map((b) => b.specId)).size;
  const note: ReactNode =
    grouping === 'blocker'
      ? `${what} ${items.length === 1 ? 'waits' : 'wait'} on ${plural(blockers, 'item')} that ${blockers === 1 ? 'is' : 'are'} not done. Start with the one that unblocks the most.`
      : `${what} in ${plural(specs, 'spec')} ${items.length === 1 ? 'waits' : 'wait'} on work that is not done.`;
  return (
    <>
      <div className="act-tool bk-tool">
        <span>{note}</span>
        <span className="act-tool-sp" />
        <CopyPromptButton prompt={allPrompts.blocked(projectId)} />
        <SegmentedControl
          size="xs"
          value={grouping}
          onChange={pick}
          data={[
            { value: 'blocker', label: 'By blocker' },
            { value: 'spec', label: 'By spec' },
          ]}
          aria-label="Group by"
          data-testid="bk-grouping"
        />
      </div>
      {grouping === 'blocker' ? <ByBlocker items={items} /> : <BySpec items={items} />}
      {o.blockedTotal > items.length && <div className="ov-foot ov-muted">+{o.blockedTotal - items.length} more not listed</div>}
      {others.length > 0 && (
        <div className="bk-foot" data-testid="bk-other-tabs">
          <IconInfoCircle size={14} />
          Other reasons a spec needs attention have their own tab:
          {others.map((t) => (
            <button key={t.key} type="button" className="bk-foot-t" onClick={() => onOpen(t.key)} data-testid={`bk-other-${t.key}`}>
              <t.icon size={12} />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
