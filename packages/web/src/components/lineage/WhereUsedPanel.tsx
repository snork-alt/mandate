import { useState } from 'react';
import { Loader, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconCircleCheck, IconCircleDashed, IconCircleX } from '@tabler/icons-react';
import type { UsageLocation, UsageState, WhereUsedResponse } from '@mandate/shared';
import { useWhereUsed } from '../../lib/lineage';
import { relativeTime, absoluteTime } from '../../lib/time';
import { RefChip } from '../refs/RefChip';
import { KindIcon } from '../refs/KindIcon';
import './lineage.css';

const STATE_META: Record<UsageState, { label: string; icon: typeof IconCircleCheck }> = {
  compliant: { label: 'Compliant', icon: IconCircleCheck },
  violating: { label: 'Violating', icon: IconCircleX },
  unchecked: { label: 'Unchecked', icon: IconCircleDashed },
};

function StateIcon({ state }: { state: UsageState }) {
  const I = STATE_META[state].icon;
  return <I size={13} stroke={1.8} className="wu-state" data-state={state} aria-label={STATE_META[state].label} />;
}

/** Coverage: in scope (appliesTo) vs checked vs violating. */
export function CoverageBar({ coverage }: { coverage: WhereUsedResponse['coverage'] }) {
  const { inScope, checked, violating } = coverage;
  const pct = (n: number) => (inScope ? Math.min(100, (n / inScope) * 100) : 0);
  const ok = Math.max(0, checked - violating);
  return (
    <div className="wu-coverage" data-testid="wu-coverage">
      <div className="wu-bar" role="img" aria-label={`${checked} of ${inScope} in-scope files checked, ${violating} violating`}>
        <span className="wu-bar-ok" style={{ width: `${pct(ok)}%` }} />
        <span className="wu-bar-bad" style={{ width: `${pct(violating)}%` }} />
      </div>
      <div className="wu-coverage-text">
        {inScope ? (
          <>
            <strong>{checked}</strong>/{inScope} in-scope files checked
            {coverage.ratio != null && <> · {Math.round(coverage.ratio * 100)}%</>}
            {violating > 0 && (
              <>
                {' '}
                · <span className="wu-bad">{violating} violating</span>
              </>
            )}
          </>
        ) : (
          'No files in scope of its globs yet.'
        )}
      </div>
    </div>
  );
}

function Location({ l }: { l: UsageLocation }) {
  const lines = l.lines ? `:${l.lines.start}-${l.lines.end}` : '';
  return (
    <li className="wu-loc" data-state={l.state} data-testid="wu-location">
      <StateIcon state={l.state} />
      <Tooltip label={`${l.repo} · ${l.path}${lines}${l.ruleTitle ? ` · ${l.ruleTitle}` : ''}`} openDelay={400} withinPortal>
        <span className="wu-path mono">
          <KindIcon kind="code_file" size={11} />
          {l.path.split('/').pop()}
          <span className="faint">{lines}</span>
        </span>
      </Tooltip>
      {l.ruleTitle && <span className="wu-rule">{l.ruleTitle}</span>}
      <span className="wu-meta">
        {l.source && <RefChip to={l.source} resolve={false} />}
        {l.at && (
          <Tooltip label={absoluteTime(l.at)} withinPortal>
            <span className="faint">{relativeTime(l.at)}</span>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

/** "Where it's used": code locations grouped by component (compliant / violating / unchecked) and the coverage. */
export function WhereUsedView({ data }: { data: WhereUsedResponse }) {
  const [showUnchecked, setShowUnchecked] = useState(false);
  const groups = data.byComponent.length
    ? data.byComponent
    : [{ component: null, label: 'No component', compliant: 0, violating: 0, unchecked: 0 }];
  return (
    <div className="wu-panel" data-testid="where-used">
      <CoverageBar coverage={data.coverage} />
      {data.locations.length === 0 && <div className="lin-empty">No recorded code locations yet.</div>}
      {groups.map((g) => {
        const locs = data.locations.filter((l) => (l.component ?? null) === g.component);
        if (!locs.length) return null;
        return (
          <div key={g.component ?? '-'} className="wu-group" data-testid="wu-group">
            <div className="wu-group-head">
              <span className="wu-group-title">
                {g.component && <KindIcon kind="component" className="kind-prefix" />}
                {g.label}
              </span>
              <span className="wu-counts">
                {g.compliant > 0 && <span data-state="compliant">{g.compliant} ok</span>}
                {g.violating > 0 && <span data-state="violating">{g.violating} violating</span>}
                {g.unchecked > 0 && <span data-state="unchecked">{g.unchecked} unchecked</span>}
              </span>
            </div>
            <ul className="wu-list">
              {locs.map((l) => (
                <Location key={`${l.uri}|${l.rule}`} l={l} />
              ))}
            </ul>
          </div>
        );
      })}
      {data.coverage.unchecked.length > 0 && (
        <div className="lin-ring">
          <UnstyledButton className="lin-ring-toggle" onClick={() => setShowUnchecked((s) => !s)} aria-expanded={showUnchecked}>
            {showUnchecked ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            In scope, never checked · {data.coverage.unchecked.length}
          </UnstyledButton>
          {showUnchecked && (
            <ul className="wu-list">
              {data.coverage.unchecked.map((f) => (
                <li key={f} className="wu-loc" data-state="unchecked">
                  <StateIcon state="unchecked" />
                  <span className="wu-path mono">{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Fetching wrapper (standard pages and rule sections). */
export function WhereUsedPanel({ refUri, compact }: { refUri: string; compact?: boolean }) {
  const q = useWhereUsed(refUri);
  if (q.isPending) return <Loader size="xs" />;
  if (q.isError) return <div className="lin-empty">Where it's used: unavailable ({q.error.message}).</div>;
  if (!Array.isArray(q.data?.locations) || !q.data.coverage) return <div className="lin-empty">No recorded code locations yet.</div>;
  return <div data-compact={compact || undefined}><WhereUsedView data={q.data} /></div>;
}
