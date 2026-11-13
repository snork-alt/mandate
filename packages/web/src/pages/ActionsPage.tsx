/**
 * Actions: everything the user has to act on (was the Overview's "Action needed" tab, moved as is): decisions (questions
 * from coding agents with "Answer all recommended", open feedback, waivers, draft standards, stale claims, approval
 * overrides, contradicted audits, drifted specs, integrity errors), specs needing attention, open must findings, blocked
 * items. `?focus=` narrows a card (from the Overview's attention chips).
 */
import { useEffect } from 'react';
import { Skeleton, Text } from '@mantine/core';
import { useSearchParams } from 'react-router';
import { TopBar } from '../components/TopBar';
import { ErrorState } from '../components/ListStates';
import { DecisionDialogs } from '../components/decisions/DecisionActions';
import { AttentionSpecs, Blocked, Decisions, MustFindings } from '../components/overview/ActionTab';
import { getCurrentProject } from '../project';
import { useDecisionAccess, useDecisions } from '../lib/decisions';
import { actionCount, CHIP_TARGET, useOverview, type AttentionFocus } from '../lib/overview';
import '../components/overview/overview.css';

export function ActionsPage() {
  const q = useOverview();
  const decisions = useDecisions(50);
  const access = useDecisionAccess().data;
  const projectId = getCurrentProject() ?? '';
  const [params] = useSearchParams();
  const focus = (params.get('focus') ?? undefined) as AttentionFocus | undefined;
  const crumbs = [{ label: 'Actions' }];
  const pending = q.data && decisions.data ? actionCount(q.data, decisions.data.total) : null;
  // A chip's card scrolls into view once rendered.
  useEffect(() => {
    if (!focus || !q.data) return;
    const card = Object.values(CHIP_TARGET).find((c) => c.focus === focus)?.card;
    const t = setTimeout(() => document.getElementById(`card-${card}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [focus, q.data]);

  if (q.isPending) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <div className="ov-page">
          <Skeleton height={180} radius="md" />
        </div>
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
  return (
    <DecisionDialogs>
      <TopBar crumbs={crumbs}>
        {pending !== null && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {pending} pending
          </Text>
        )}
      </TopBar>
      <div className="ov-page" data-testid="actions">
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
      </div>
    </DecisionDialogs>
  );
}
