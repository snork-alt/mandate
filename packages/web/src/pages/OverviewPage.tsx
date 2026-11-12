import { useEffect } from 'react';
import { Skeleton, Tabs, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconFileText, IconHeartbeat, IconPlayerPlay } from '@tabler/icons-react';
import { Link, useSearchParams } from 'react-router';
import { MATURITY_LABELS, MATURITY_STEPS, STEP_TONE, type ProjectOverview } from '@mandate/shared';
import { TopBar } from '../components/TopBar';
import { ErrorState } from '../components/ListStates';
import { MaturityMeter } from '../components/maturity/MaturityBadge';
import { DecisionDialogs } from '../components/decisions/DecisionActions';
import { AttentionSpecs, Blocked, Decisions, MustFindings } from '../components/overview/ActionTab';
import { InProgress, RecentlyChanged } from '../components/overview/ProgressTab';
import { ByCategory, Coverage, VerificationGaps, Warnings } from '../components/overview/HealthTab';
import { Empty, pct, plural } from '../components/overview/parts';
import { getCurrentProject } from '../project';
import { useProjects } from '../connect/projects';
import { useNow } from '../lib/specs';
import { useDecisionAccess, useDecisions } from '../lib/decisions';
import { actionCount, CHIP_TARGET, loadTab, pickTab, saveTab, specsFiltered, STEP_COLOR, useOverview, useRecentActivity, type AttentionFocus, type OverviewTab } from '../lib/overview';
import '../components/overview/overview.css';

/* ---------------------------------------------------------------- header */

function MaturityBar({ m }: { m: ProjectOverview['maturity'] }) {
  const total = m.total || 1;
  return (
    <div className="ov-maturity" data-testid="ov-maturity">
      <div className="status-bar" aria-hidden="true">
        {MATURITY_STEPS.map((st) => (m.steps[st] ? <span key={st} style={{ flexGrow: m.steps[st], background: STEP_COLOR[st], minWidth: 4 }} /> : null))}
      </div>
      <div className="status-counts">
        {MATURITY_STEPS.map((st, i) => (
          <Link key={st} to={specsFiltered(st)} className="status-count" data-empty={!m.steps[st] || undefined}>
            <MaturityMeter stepIndex={i + 1} tone={STEP_TONE[st]} />
            <span>{MATURITY_LABELS[st]}</span>
            <span className="status-count-n">{m.steps[st]}</span>
            <span className="status-count-pct">{pct(m.steps[st], total)}%</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

interface ChipDef {
  key: string;
  label: string;
  n: number;
  tone: 'danger' | 'warn' | 'info';
  tip: string;
}

export function attentionChips(o: ProjectOverview): ChipDef[] {
  const a = o.attention;
  return [
    { key: 'failing', label: 'failing', n: a.failing, tone: 'danger' as const, tip: 'Specs with a failing must criterion or an open must finding' },
    { key: 'drifted', label: 'drifted', n: a.drifted, tone: 'danger' as const, tip: 'Done specs whose gate no longer holds' },
    { key: 'blocked', label: 'blocked', n: a.blocked, tone: 'warn' as const, tip: 'Specs with sections waiting on work that is not implemented' },
    { key: 'stale', label: 'stale', n: a.stale, tone: 'warn' as const, tip: 'Specs whose verifications or last audit are out of date' },
    { key: 'findings', label: 'open must findings', n: a.mustFindings, tone: 'danger' as const, tip: 'Open must findings in the latest audits' },
    { key: 'claims', label: 'stale claims', n: a.staleClaims, tone: 'warn' as const, tip: 'Claimed work orders without a heartbeat for 30 minutes' },
    { key: 'failed', label: 'failed work orders', n: a.failedWorkOrders, tone: 'danger' as const, tip: 'Work orders that ended as failed' },
    { key: 'integrity-errors', label: 'integrity errors', n: a.integrityErrors, tone: 'danger' as const, tip: 'Broken repository invariants' },
    { key: 'integrity-warnings', label: 'integrity warnings', n: a.integrityWarnings, tone: 'info' as const, tip: 'Gaps in the repository worth fixing (snoozed ones excluded)' },
  ].filter((d) => d.n > 0);
}

function Attention({ o, onPick }: { o: ProjectOverview; onPick: (key: string) => void }) {
  const live = attentionChips(o);
  if (!live.length) {
    return (
      <div className="ov-attention" data-testid="ov-chips" data-clear>
        <IconCircleCheck size={15} className="ov-ok" />
        <span>Nothing needs attention: no failing, drifted, blocked or stale specs, no stale claims and no integrity errors.</span>
      </div>
    );
  }
  return (
    <div className="ov-attention" data-testid="ov-chips">
      <span className="ov-attention-label">
        <IconAlertTriangle size={14} /> Needs attention
      </span>
      {live.map((d) => (
        <Tooltip key={d.key} label={d.tip} openDelay={300}>
          <button type="button" className="ov-chip" data-tone={d.tone} data-key={d.key} onClick={() => onPick(d.key)}>
            <span className="ov-chip-n">{d.n}</span> {d.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- page */

function OverviewSkeleton() {
  return (
    <div className="ov-page" aria-busy="true" data-testid="ov-loading">
      <Skeleton height={26} width={220} radius="sm" />
      <Skeleton height={8} mt={14} radius="sm" />
      <Skeleton height={22} width="70%" mt={10} radius="sm" />
      <Skeleton height={32} width={360} mt={20} radius="sm" />
      <div className="ov-grid" style={{ marginTop: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={180} radius="md" />
        ))}
      </div>
    </div>
  );
}

const TabCount = ({ n, tone }: { n: number | undefined; tone?: 'danger' }) => (n ? <span className="ov-tab-count" data-tone={tone}>{n}</span> : null);

/**
 * Project landing: a compact header (name, maturity bar, attention chips) and three tabs: "Action needed" (default when
 * anything is pending), "In progress" and "Health". The tab lives in `?tab=` and is remembered per project.
 */
export function OverviewPage() {
  const now = useNow();
  const q = useOverview();
  const decisions = useDecisions(50);
  const access = useDecisionAccess().data;
  const recent = useRecentActivity();
  const projectId = getCurrentProject() ?? '';
  const name = useProjects().data?.items.find((p) => p.id === projectId)?.name ?? projectId;
  const [params, setParams] = useSearchParams();
  const crumbs = [{ label: 'Overview' }];
  const pending = q.data && decisions.data ? actionCount(q.data, decisions.data.total) : null;
  const tab = pickTab(params.get('tab'), loadTab(projectId), pending);
  const focus = (params.get('focus') ?? undefined) as AttentionFocus | undefined;
  const select = (t: OverviewTab, f?: AttentionFocus) => {
    saveTab(projectId, t);
    setParams((p) => {
      p.set('tab', t);
      if (f) p.set('focus', f);
      else p.delete('focus');
      return p;
    }, { replace: true });
  };
  // A chip's card scrolls into view once its tab rendered.
  useEffect(() => {
    if (!focus) return;
    const card = Object.values(CHIP_TARGET).find((c) => c.focus === focus)?.card;
    const t = setTimeout(() => document.getElementById(`card-${card}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [focus, tab]);

  if (q.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <OverviewSkeleton />
      </>
    );
  }
  if (q.isError || !q.data) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <ErrorState error={q.error ?? new Error('Unknown error')} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const o = q.data;
  const health = o.attention.integrityWarnings + o.gaps.length;
  return (
    <DecisionDialogs>
      <TopBar crumbs={crumbs} />
      <div className="ov-page" data-testid="overview">
        <header className="ov-header">
          <div className="ov-title-row">
            <h1 className="ov-title">{name || 'Overview'}</h1>
            <span className="ov-sub">
              {plural(o.maturity.total, 'spec')}
              {o.maturity.archived ? ` · ${o.maturity.archived} archived` : ''}
            </span>
          </div>
          {o.maturity.total > 0 ? (
            <MaturityBar m={o.maturity} />
          ) : (
            <Empty icon={<IconFileText size={18} stroke={1.5} />} title="No specs yet">
              Ask your coding agent to write the first spec (Connect agent in the sidebar), or <Link to="/specs">open Specs</Link>.
            </Empty>
          )}
          <Attention
            o={o}
            onPick={(key) => {
              const t = CHIP_TARGET[key];
              if (t) select(t.tab, t.focus);
            }}
          />
        </header>
        <Tabs value={tab} onChange={(v) => v && select(v as OverviewTab)} keepMounted={false} className="ov-tabs" activateTabWithKeyboard>
          <Tabs.List>
            <Tabs.Tab value="action" leftSection={<IconAlertTriangle size={14} />} rightSection={<TabCount n={pending ?? undefined} tone="danger" />} data-testid="tab-action">
              Action needed
            </Tabs.Tab>
            <Tabs.Tab value="progress" leftSection={<IconPlayerPlay size={14} />} rightSection={<TabCount n={o.inProgressTotal} />} data-testid="tab-progress">
              In progress
            </Tabs.Tab>
            <Tabs.Tab value="health" leftSection={<IconHeartbeat size={14} />} rightSection={<TabCount n={health} />} data-testid="tab-health">
              Health
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="action" pt="md">
            <div className="ov-health">
              <Decisions q={decisions} projectId={projectId} overrideOk={access?.override.ok ?? false} />
              <div className="ov-cols">
                <div className="ov-col">
                  <AttentionSpecs o={o} projectId={projectId} focus={focus} />
                  <MustFindings o={o} />
                </div>
                <div className="ov-col">
                  <Blocked o={o} projectId={projectId} />
                </div>
              </div>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="progress" pt="md">
            <div className="ov-cols">
              <div className="ov-col">
                <InProgress o={o} now={now} />
              </div>
              <div className="ov-col">
                <RecentlyChanged events={recent.data?.events ?? []} loading={recent.isPending} error={recent.error} now={now} />
              </div>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="health" pt="md">
            <div className="ov-health">
              <Coverage o={o} projectId={projectId} />
              <VerificationGaps o={o} />
              <div className="ov-pair">
                <ByCategory o={o} />
                <Warnings o={o} projectId={projectId} />
              </div>
            </div>
          </Tabs.Panel>
        </Tabs>
      </div>
    </DecisionDialogs>
  );
}
