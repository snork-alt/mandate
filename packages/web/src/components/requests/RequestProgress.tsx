/**
 * The live part of a request page: who it is assigned to (presence dot, Queued, reassign while not started), the
 * 6-stage flow bar, "Plan ready: review" with the Approve button (plan-only requests), the work order's steps checklist,
 * the context objects and an activity feed. Everything derives from the stored request and `flow_next` (read by the UI,
 * which never takes the request), refreshed by the activity events and a short poll.
 */
import { useState } from 'react';
import { Button, Popover } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconUserCog } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Feedback } from '@mandate/shared';
import { refLabel } from '@mandate/shared/refs';
import { AgentPicker } from '../comments/CommentsPanel';
import { TimeAgo } from '../TimeAgo';
import { Ticks } from '../Ticks';
import { refHref } from '../refs/kinds';
import { useAgentsPresence, type PresenceReply } from '../../lib/comments';
import { assigneeLabel, assigneeState, deliveryProblem, isQueued, requestStages, useApprovePlan, useAssignRequest, useRequestFlow } from '../../lib/requests';
import '../comments/comments.css';
import './requests.css';

const STEP_GLYPH: Record<string, string> = { done: '✓', in_progress: '▶', skipped: '↷', pending: '○' };

/** "from the web UI by ada" / "from a comment" / the agent that filed it. */
export const sourceLabel = (f: Pick<Feedback, 'source' | 'createdByUser' | 'createdBy'>) =>
  f.source === 'ui' ? `from the web UI${f.createdByUser ? ` by ${f.createdByUser}` : ''}` : f.source === 'comment' ? 'from a comment' : f.createdBy ? `filed by ${f.createdBy}` : '';

export function Assignee({ f, presence }: { f: Pick<Feedback, 'assignee' | 'startedBy'>; presence?: PresenceReply }) {
  const who = f.startedBy ?? f.assignee;
  if (!who) return <span className="faint">Unassigned</span>;
  const st = assigneeState(who, presence);
  return (
    <span className="rq-assignee" data-testid="rq-assignee">
      {st && <span className="cmt-dot" data-state={st} aria-hidden title={st} />}
      {assigneeLabel(who, presence)}
      {isQueued(f as never) && <span className="rq-queued">Queued{st === 'offline' ? ': offline, delivered when it connects' : ''}</span>}
      {f.startedBy && <span className="rq-queued">started</span>}
    </span>
  );
}

function Reassign({ id, current, presence }: { id: string; current: string; presence?: PresenceReply }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(current);
  const assign = useAssignRequest();
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-start" width={360} withArrow shadow="md">
      <Popover.Target>
        <Button size="compact-xs" variant="default" leftSection={<IconUserCog size={13} />} onClick={() => setOpen((o) => !o)} data-testid="rq-reassign">
          Reassign
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <AgentPicker presence={presence} value={v} onChange={setV} showOffline allowAny name="rq-reassign" anyHint="the next free agent takes it" />
        <Button
          size="xs"
          mt="xs"
          loading={assign.isPending}
          disabled={!v || v === current}
          onClick={() => assign.mutate({ id, assignee: v }, { onSuccess: () => setOpen(false) })}
          data-testid="rq-reassign-apply"
        >
          Reassign
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
}

export function PlanReady({ id }: { id: string }) {
  const approve = useApprovePlan();
  return (
    <div className="rq-plan" data-testid="rq-plan-ready">
      <div className="rq-plan-text">
        <b>Plan ready — review</b>
        <div className="faint small">The specs and the work-order plan are written; no code yet. Review the work order, then let the agent implement it.</div>
      </div>
      <Button size="xs" leftSection={<IconCheck size={14} />} loading={approve.isPending} onClick={() => approve.mutate(id)} data-testid="rq-approve-plan">
        Approve plan &amp; implement
      </Button>
    </div>
  );
}

interface FeedItem {
  at: string;
  text: string;
}
export function activityOf(f: Feedback): FeedItem[] {
  const out: FeedItem[] = [{ at: f.createdAt, text: `Recorded ${sourceLabel(f)}`.trim() }];
  if (f.assignedAt && f.assignee) out.push({ at: f.assignedAt, text: `Assigned to ${f.assignee === 'any' ? 'any agent' : f.assignee}` });
  if (f.startedAt && f.startedBy) out.push({ at: f.startedAt, text: `${f.startedBy} started it` });
  if (f.specMatch) out.push({ at: f.specMatch.at, text: `Matched to ${f.specMatch.refs.length} spec section(s) by ${f.specMatch.by}` });
  for (const d of f.decisions ?? []) out.push({ at: d.at, text: `Decision (${d.by}): ${d.text}` });
  if (f.planApprovedAt) out.push({ at: f.planApprovedAt, text: `Plan approved${f.planApprovedBy ? ` by ${f.planApprovedBy}` : ''}` });
  if (f.closedAt) out.push({ at: f.closedAt, text: `Closed: ${f.resolution ?? 'closed'}` });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** "Fits spec X · component Y · follows standard Z": what the spec / component / standard matches of the request picked. */
function MatchLine({ f }: { f: Feedback }) {
  const spec = f.specMatch?.refs.find((r) => r.includes('/specs/'));
  const comp = f.componentMatch?.refs[0];
  const stds = f.standardMatch?.refs ?? [];
  const part = (label: string, ref: string, route: string) => (
    <span key={ref}>
      {label} <Link to={`/${route}/${ref.split('/')[3]}`} className="plain-link">{ref.split('/')[3]}</Link>
    </span>
  );
  const parts = [
    ...(spec ? [part('Fits spec', spec, 'specs')] : []),
    ...(comp ? [part('component', comp, 'components')] : []),
    ...stds.slice(0, 3).map((r) => part('follows standard', r, 'standards')),
  ];
  if (!parts.length) return null;
  return (
    <div className="rq-matches faint small" data-testid="rq-matches" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {p}
        </span>
      ))}
    </div>
  );
}

export function RequestProgress({ f, workOrderIds }: { f: Feedback; workOrderIds: string[] }) {
  const flow = useRequestFlow(f.id, f.status !== 'closed');
  const presence = useAgentsPresence(undefined);
  const p = presence.data;
  const state = flow.data;
  const stages = requestStages(f, state);
  const open = f.status !== 'closed';
  const planReady = open && !!f.planOnly && (state?.state === 'plan_ready' || (!state && workOrderIds.length > 0));
  const steps = state?.progress?.tasks ?? [];
  return (
    <div data-testid="request-progress">
      <div className="rq-meta faint small" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {sourceLabel(f) && <span data-testid="rq-source">{sourceLabel(f)[0]!.toUpperCase() + sourceLabel(f).slice(1)}</span>}
        {(f.assignee || f.startedBy) && <Assignee f={f} presence={p} />}
        {open && f.assignee && !f.startedBy && <Reassign id={f.id} current={f.assignee === 'any' ? 'any' : (p?.agents.find((a) => a.id === f.assignee)?.handle ?? f.assignee)} presence={p} />}
        {f.priority && f.priority !== 'normal' && <span>{f.priority} priority</span>}
        {f.planOnly && <span>plan only</span>}
      </div>
      {open && isQueued(f) && deliveryProblem(f, p) && (
        <div className="rq-warn" role="status" data-testid="rq-delivery-warning">
          <IconAlertTriangle size={14} aria-hidden /> <Ticks text={deliveryProblem(f, p)!} />
        </div>
      )}
      <MatchLine f={f} />
      {planReady && <PlanReady id={f.id} />}
      <div className="rq-flow" role="list" aria-label="Progress" data-testid="rq-flow">
        {stages.map((s) => (
          <div key={s.key} className="rq-stage" role="listitem" data-status={s.status} data-stage={s.key}>
            <span className="rq-stage-name">
              <span className="rq-stage-dot" aria-hidden />
              {s.label}
            </span>
            {s.detail && <span className="rq-stage-detail">{s.detail}</span>}
          </div>
        ))}
      </div>
      {steps.length > 0 && (
        <>
          <h2 className="fb-h2">Plan · {steps.filter((x) => x.status === 'done').length} of {steps.length} tasks</h2>
          <ul className="rq-steps" data-testid="rq-steps">
            {steps.map((s) => (
              <li key={s.id} data-status={s.status}>
                <span className="mono faint">{STEP_GLYPH[s.status] ?? '○'}</span>
                <span className="rq-step-text">{s.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(f.context?.length ?? 0) > 0 && (
        <div className="fb-related" data-testid="rq-context">
          Context:{' '}
          {f.context!.map((c) => {
            const href = refHref(c);
            return href ? (
              <Link key={c} to={href} className="mono">
                {refLabel(c)}
              </Link>
            ) : (
              <span key={c} className="mono">
                {refLabel(c)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ActivityFeed({ f }: { f: Feedback }) {
  const items = activityOf(f);
  return (
    <>
      <h2 className="fb-h2">Activity</h2>
      <ul className="w-decisions" data-testid="rq-activity">
        {items.map((i, k) => (
          <li key={`${i.at}-${k}`}>
            {i.text} <span className="faint small"><TimeAgo iso={i.at} /></span>
          </li>
        ))}
      </ul>
    </>
  );
}
