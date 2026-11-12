import { useState } from 'react';
import { Loader, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconCircleCheck, IconAlertTriangle, IconProgress, IconCircleDashed, IconGitMerge } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { LineageNode, LineageResponse, LineageStatus } from '@mandate/shared';
import { KIND_ICON, refHref } from '../refs/kinds';
import { STATUS_META, bareRef, splitLineage, useLineage } from '../../lib/lineage';
import { attributionText, useShowUsers } from '../../lib/attribution';
import { relativeTime } from '../../lib/time';
import { maturityText, useSpecMaturityOf } from '../maturity/SpecMaturity';
import './lineage.css';

export function LineageStatusIcon({ status, size = 13 }: { status: LineageStatus; size?: number }) {
  const common = { size, stroke: 1.8, 'aria-label': STATUS_META[status].label, className: 'lin-status-icon', 'data-status': status } as const;
  if (status === 'done') return <IconCircleCheck {...common} />;
  if (status === 'in_progress') return <IconProgress {...common} />;
  if (status === 'attention') return <IconAlertTriangle {...common} />;
  return <IconCircleDashed {...common} />;
}

/** Path of the Lineage page for a reference. */
export const lineagePageHref = (ref: string, extra: Record<string, string> = {}) => `/lineage?${new URLSearchParams({ ref: bareRef(ref), ...extra }).toString()}`;

function Item({ n }: { n: LineageNode }) {
  const showUsers = useShowUsers();
  const Icon = KIND_ICON[n.kind] ?? IconCircleDashed;
  const href = refHref(n.uri);
  const by = n.createdBy ? attributionText(n.createdBy, showUsers) : '';
  // Specs read by maturity (the one state), not their stored status (X1).
  const maturity = useSpecMaturityOf(n.kind === 'spec' ? n.uri : undefined);
  const body = (
    <>
      <LineageStatusIcon status={n.status} />
      <Icon size={13} stroke={1.6} className="lin-kind-icon" />
      <span className="lin-item-label">{n.label}</span>
      {maturity ? <span className="lin-item-raw">{maturityText(maturity)}</span> : n.rawStatus && <span className="lin-item-raw">{n.rawStatus.replace(/_/g, ' ')}</span>}
    </>
  );
  const tip = [n.kind.replace(/_/g, ' '), STATUS_META[n.status].label, by, n.createdAt?.date ? relativeTime(n.createdAt.date) : ''].filter(Boolean).join(' · ');
  return (
    <li className="lin-item" data-status={n.status} data-testid="lineage-item">
      <Tooltip label={tip} openDelay={400} withinPortal>
        {href ? (
          <Link to={href} className="lin-item-row">
            {body}
          </Link>
        ) : (
          <span className="lin-item-row">{body}</span>
        )}
      </Tooltip>
    </li>
  );
}

/** Lineage of one element: summary line, Why / Led to tabs, items marked done / in progress / needs attention. */
export function LineageView({ data, initialTab }: { data: LineageResponse; initialTab?: 'why' | 'led' }) {
  const { why, ledTo, alsoAffected } = splitLineage(data);
  const [tab, setTab] = useState<'why' | 'led'>(initialTab ?? (why.length || !ledTo.length ? 'why' : 'led'));
  const [ring, setRing] = useState(false);
  const list = tab === 'why' ? why : ledTo;
  return (
    <div className="lin-panel" data-testid="lineage-panel">
      {data.summary.text && <div className="lin-summary" data-testid="lineage-summary">{data.summary.text}</div>}
      <div className="lin-tabs" role="tablist">
        <button type="button" role="tab" className="lin-tab" aria-selected={tab === 'why'} onClick={() => setTab('why')}>
          Why <span className="lin-count">{why.length}</span>
        </button>
        <button type="button" role="tab" className="lin-tab" aria-selected={tab === 'led'} onClick={() => setTab('led')}>
          Led to <span className="lin-count">{ledTo.length + alsoAffected.length}</span>
        </button>
      </div>
      {list.length === 0 ? (
        <div className="lin-empty">{tab === 'why' ? 'No recorded cause.' : 'Nothing downstream yet.'}</div>
      ) : (
        <ul className="lin-list">
          {list.map((n) => (
            <Item key={n.uri} n={n} />
          ))}
        </ul>
      )}
      {tab === 'led' && alsoAffected.length > 0 && (
        <div className="lin-ring">
          <UnstyledButton className="lin-ring-toggle" onClick={() => setRing((r) => !r)} aria-expanded={ring}>
            {ring ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            Also affected · {alsoAffected.length}
          </UnstyledButton>
          {ring && (
            <ul className="lin-list">
              {alsoAffected.map((n) => (
                <Item key={n.uri} n={n} />
              ))}
            </ul>
          )}
        </div>
      )}
      {data.truncated && <div className="lin-empty">More elements than shown; open the Lineage page for the full graph.</div>}
    </div>
  );
}

/** The Lineage panel of an element (documents, sections, feedback, audits...): fetches `lineage` and links to the full page. */
export function LineagePanel({ refUri, depth = 2, initialTab }: { refUri: string; depth?: number; initialTab?: 'why' | 'led' }) {
  const q = useLineage({ ref: refUri, direction: 'both', depth });
  return (
    <div className="lin-wrap">
      {q.isPending ? (
        <Loader size="xs" />
      ) : q.isError ? (
        <div className="lin-empty">Lineage unavailable ({q.error.message}).</div>
      ) : Array.isArray(q.data?.nodes) ? (
        <LineageView data={q.data} initialTab={initialTab} />
      ) : (
        <div className="lin-empty">No lineage recorded.</div>
      )}
      <Link to={lineagePageHref(refUri)} className="lin-open">
        <IconGitMerge size={12} /> Open in Lineage
      </Link>
    </div>
  );
}
