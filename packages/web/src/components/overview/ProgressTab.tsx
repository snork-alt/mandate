/** Overview tab "In progress": work orders agents hold now, and what changed in the last 7 days (grouped by day). */
import type { ReactNode } from 'react';
import { Skeleton, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconClipboardList, IconGitBranch, IconHistory, IconListCheck, IconMessageReport, IconPlayerPlay } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { OverviewWorkOrder, ProjectOverview } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { ActorAvatar, AgentAvatar } from '../people/People';
import { SectionProgress, WorkOrderGitSummary } from '../work-orders/parts';
import { FAMILY_ICON } from '../activity/ActivityFilterBar';
import { ItemMenu } from '../decisions/DecisionActions';
import type { ActivityEvent } from '../activity/types';
import { KIND_LABEL } from '../../lib/specs';
import { absoluteTime, compactTime } from '../../lib/time';
import { dayLabel } from '../../lib/activity';
import { itemPrompt } from '../../lib/prompts';
import { groupRecent, RECENT_DAYS, type RecentItem } from '../../lib/overview';
import { Capped, Card, Empty, When, plural } from './parts';

function Heartbeat({ w, now }: { w: OverviewWorkOrder; now: number }) {
  if (!w.claim) return <span className="ov-muted">Not claimed</span>;
  return (
    <Tooltip label={`Last heartbeat ${absoluteTime(w.claim.heartbeatAt)} · claimed ${absoluteTime(w.claim.startedAt)}`} openDelay={300}>
      <span className="ov-heartbeat" data-stale={w.claim.stale || undefined}>
        <span className="ov-pulse" aria-hidden />
        {w.claim.stale ? 'Stale · ' : ''}heartbeat {compactTime(w.claim.heartbeatAt, now)}
      </span>
    </Tooltip>
  );
}

export function InProgress({ o, now }: { o: ProjectOverview; now: number }) {
  return (
    <Card id="in-progress" icon={<IconPlayerPlay size={15} />} title="In progress now" count={o.inProgressTotal} action={<Link to="/work-orders" className="ov-more">All work orders <IconArrowRight size={12} /></Link>}>
      {o.inProgress.length === 0 ? (
        <Empty icon={<IconClipboardList size={18} stroke={1.5} />} title="No agent is working right now">
          {o.queued ? `${plural(o.queued, 'work order')} ${o.queued === 1 ? 'waits' : 'wait'} for an agent to claim ${o.queued === 1 ? 'it' : 'them'}.` : 'Work orders appear here while a coding agent has them claimed.'}
        </Empty>
      ) : (
        <>
          <Capped
            items={o.inProgress}
            cap={6}
            render={(w) => {
              const uri = buildRef({ kind: 'work-orders', id: w.id });
              return (
                <li key={w.id} className="ov-wo" data-stale={w.claim?.stale || undefined}>
                  <div className="ov-wo-top">
                    {w.claim ? <AgentAvatar agent={w.claim.agent} size={20} verb="Claimed" at={w.claim.startedAt} /> : <span className="ov-avatar-gap" />}
                    <Link to={`/work-orders/${w.id}`} className="ov-wo-title">
                      <span className="mono ov-id">{w.id}</span> {w.title}
                    </Link>
                    <ItemMenu
                      label={w.id}
                      prompt={itemPrompt('continue_work', uri)}
                      actions={w.claim?.stale ? [{ id: 'release', label: 'Release claim', primary: true, dialog: { type: 'release', ref: uri, title: w.id, agent: w.claim.agent, heartbeat: compactTime(w.claim.heartbeatAt, now) } }] : []}
                    />
                  </div>
                  <div className="ov-wo-meta">
                    <span className="kind-badge" data-kind={w.kind}>
                      {KIND_LABEL[w.kind as keyof typeof KIND_LABEL] ?? w.kind}
                    </span>
                    {w.claim && <span className="ov-agent">{w.claim.agent}</span>}
                    <Heartbeat w={w} now={now} />
                    {w.claim?.branch && !w.git.some((g) => g.branch) && (
                      <span className="ov-branch mono">
                        <IconGitBranch size={12} /> {w.claim.branch}
                      </span>
                    )}
                    <WorkOrderGitSummary item={{ git: w.git }} compact />
                  </div>
                  <SectionProgress done={w.sections.done} total={w.sections.total} />
                </li>
              );
            }}
          />
          {o.queued > 0 && (
            <div className="ov-foot">
              <Link to="/work-orders?show=pending">{plural(o.queued, 'more work order')} waiting for an agent</Link>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const CATEGORY_ICON: Record<RecentItem['category'], ReactNode> = {
  edit: FAMILY_ICON.spec,
  work_order: FAMILY_ICON.work_order,
  feedback: <IconMessageReport size={14} stroke={1.6} />,
  audit: <IconListCheck size={14} stroke={1.6} />,
};
const iconOf = (it: RecentItem) => (it.category === 'edit' ? (FAMILY_ICON[it.events[0]!.type.split('.')[0]!] ?? CATEGORY_ICON.edit) : CATEGORY_ICON[it.category]);

function Actors({ actors, at }: { actors: RecentItem['actors']; at: string }) {
  return (
    <span className="ov-actors">
      {actors.slice(0, 3).map((a, i) => (
        <ActorAvatar key={`${a.user ?? ''}|${a.agent ?? ''}|${i}`} user={a.user} agent={a.agent} size={18} at={at} verb="Changed" />
      ))}
      {actors.length > 3 && <span className="ov-muted">+{actors.length - 3}</span>}
    </span>
  );
}

export function RecentlyChanged({ events, loading, error, now }: { events: ActivityEvent[]; loading: boolean; error: Error | null; now: number }) {
  const days = groupRecent(events);
  const count = days.reduce((n, d) => n + d.items.length, 0);
  return (
    <Card id="recent" icon={<IconHistory size={15} />} title={`Recently changed · last ${RECENT_DAYS} days`} count={loading ? undefined : count}>
      {loading ? (
        <div className="ov-skeleton">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={14} width={`${80 - i * 10}%`} radius="sm" />
          ))}
        </div>
      ) : error ? (
        <Empty icon={<IconAlertTriangle size={18} stroke={1.5} />} title="Recent changes could not be loaded">
          {error.message}
        </Empty>
      ) : count === 0 ? (
        <Empty icon={<IconHistory size={18} stroke={1.5} />} title={`No changes in the last ${RECENT_DAYS} days`}>
          Spec and standard edits, completed work orders, closed feedback and audits show up here.
        </Empty>
      ) : (
        <div className="ov-days">
          {days.map((d) => (
            <div key={d.day} className="ov-day">
              <h3 className="ov-day-title">{dayLabel(d.day, now)}</h3>
              <Capped
                items={d.items}
                cap={6}
                render={(it) => (
                  <li key={it.key} className="ov-recent">
                    <span className="ov-recent-icon" aria-hidden>
                      {iconOf(it)}
                    </span>
                    <div className="ov-recent-main">
                      {it.href ? (
                        <Link to={it.href} className="ov-recent-title" title={it.category === 'edit' ? 'Open the tracked changes' : undefined}>
                          {it.title}
                        </Link>
                      ) : (
                        <span className="ov-recent-title">{it.title}</span>
                      )}
                      <span className="ov-recent-detail">{it.detail}</span>
                    </div>
                    <Actors actors={it.actors} at={it.at} />
                    <When iso={it.at} now={now} />
                  </li>
                )}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
