/**
 * Actions: everything the user has to act on, one tab per kind with its count (questions from coding agents, feedback,
 * waivers, standard drafts, claims, approval overrides, contradicted audits, drifted specs, integrity errors, specs
 * needing attention, must findings, blocked items). The tab lives in `?tab=`; `?focus=` (the Overview's attention chips)
 * opens the matching tab.
 */
import { Skeleton, Text } from '@mantine/core';
import { TopBar } from '../components/TopBar';
import { ErrorState } from '../components/ListStates';
import { CopyPromptButton, DecisionDialogs } from '../components/decisions/DecisionActions';
import { ActionTabs } from '../components/overview/ActionTab';
import { getCurrentProject } from '../project';
import { useDecisionAccess, useDecisions } from '../lib/decisions';
import { decisionsPrompt } from '../lib/prompts';
import { actionCount, useOverview } from '../lib/overview';
import '../components/overview/overview.css';

export function ActionsPage() {
  const q = useOverview();
  const decisions = useDecisions(50);
  const access = useDecisionAccess().data;
  const projectId = getCurrentProject() ?? '';
  const crumbs = [{ label: 'Actions' }];
  const pending = q.data && decisions.data ? actionCount(q.data, decisions.data.total) : null;

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
  return (
    <DecisionDialogs>
      <TopBar crumbs={crumbs}>
        {pending !== null && (
          <Text size="sm" c="var(--app-text-faint)" visibleFrom="xs">
            {pending} pending
          </Text>
        )}
        {!!decisions.data?.total && <CopyPromptButton prompt={decisionsPrompt(projectId)} label="Resolve with your coding agent" testId="resolve-with-agent" />}
      </TopBar>
      <div className="ov-page" data-testid="actions">
        <header className="ov-header act-header">
          <h1 className="ov-title">Actions</h1>
          <span className="ov-sub">What needs you: questions from coding agents, feedback, waivers, drafts and claims.</span>
        </header>
        <ActionTabs o={q.data} q={decisions} projectId={projectId} overrideOk={access?.override.ok ?? false} />
      </div>
    </DecisionDialogs>
  );
}
