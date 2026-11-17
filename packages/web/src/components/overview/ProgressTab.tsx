/**
 * Overview tab "In progress": the agents-today timeline, work orders agents hold now grouped by spec, and the side
 * column (stuck items, recently completed, specs moving, what changed in the last 7 days grouped by day).
 */
import type { ReactNode } from 'react';
import { Skeleton, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconClipboardList,
  IconClockPause,
  IconGitBranch,
  IconHistory,
  IconLock,
  IconPlayerPlay,
  IconStairsUp,
  IconTimeline,
} from '@tabler/icons-react';
import { Link } from 'react-router';
import { WAITING_FOR_COMPLETION_HINT, MATURITY_LABELS, MATURITY_STEPS, STEP_TONE, type MaturityStep, type OverviewWorkOrder, type ProjectOverview, type SpecMaturity } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { ActorAvatar, AgentAvatar } from '../people/People';
import { SectionProgress, WorkOrderGitSummary } from '../work-orders/parts';
import { FAMILY_ICON } from '../activity/ActivityFilterBar';
import { ItemMenu, type ItemAction } from '../decisions/DecisionActions';
import { MaturityBadge, MaturityMeter } from '../maturity/MaturityBadge';
import { AgentMark } from '../../connect/AgentMark';
import { refHref } from '../refs/kinds';
import { KindIcon } from '../refs/KindIcon';
import type { ActivityEvent } from '../activity/types';
import { KIND_LABEL } from '../../lib/specs';
import { absoluteTime, compactTime } from '../../lib/time';
import { dayLabel } from '../../lib/activity';
import { itemPrompt } from '../../lib/prompts';
import { groupRecent, RECENT_DAYS, type RecentItem } from '../../lib/overview';
import { agentClient, buildTimeline, duration, groupBySpec, hourTicks, specsMoving, stepsOf, stuckItems, MOVING_HOURS, type SpecMove } from '../../lib/progress';
import { Capped, Card, Empty, When, plural } from './parts';
import './progress.css';

const kindLabel = (k: string) => KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k;

function Heartbeat({ w, now }: { w: OverviewWorkOrder; now: number }) {
  if (w.sections.total > 0 && w.sections.done >= w.sections.total && w.status !== 'done') {
    return (
      <Tooltip label={WAITING_FOR_COMPLETION_HINT} multiline maw={320} openDelay={300}>
        <span className="ov-heartbeat" data-testid="pg-waiting-completion">Waiting for completion</span>
      </Tooltip>
    );
  }
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

/** Agent avatar with its client's mark (Claude Code, Codex…) in the corner. */
function AgentFaceMark({ agent, at }: { agent: string; at?: string }) {
  return (
    <span className="pg-agent">
      <AgentAvatar agent={agent} size={24} verb="Claimed" at={at} />
      <span className="pg-agent-mark" aria-hidden>
        <AgentMark agent={agentClient(agent)} size={12} />
      </span>
    </span>
  );
}

const releaseAction = (w: OverviewWorkOrder, now: number): ItemAction[] =>
  w.claim?.stale && !(w.sections.total > 0 && w.sections.done >= w.sections.total) ? [{ id: 'release', label: 'Release claim', primary: true, dialog: { type: 'release', ref: buildRef({ kind: 'work-orders', id: w.id }), title: w.id, agent: w.claim.agent, heartbeat: compactTime(w.claim.heartbeatAt, now) } }] : [];

/** "2/5 Write the tests", "plan · 4 tasks", "plan done", "no plan yet". */
function PlanStep({ w }: { w: OverviewWorkOrder }) {
  const p = w.plan;
  if (!w.hasPlan) return <span className="ov-muted">No plan yet</span>;
  if (!p) return <span className="ov-muted">Plan written</span>;
  if (p.current) {
    const active = p.steps?.find((x) => x.id === p.current!.id)?.status === 'in_progress';
    return (
      <span className="pg-step" title={`Task ${p.current.index} of ${p.total}${active ? ' (in progress)' : ''}`} data-step-status={active ? 'in_progress' : 'pending'}>
        <b>
          {p.current.index}/{p.total}
        </b>{' '}
        {p.current.text}
      </span>
    );
  }
  if (p.done !== undefined) return <span className="pg-step">Plan done · {p.total}/{p.total}</span>;
  return <span className="ov-muted">Plan · {plural(p.total, 'task')}</span>;
}

/* ---------------------------------------------------------------- agents today */

export function AgentsToday({ o, now }: { o: ProjectOverview; now: number }) {
  const t = buildTimeline(o.sessions ?? [], now);
  const span = t.to - t.from || 1;
  const x = (ms: number) => `${(((ms - t.from) / span) * 100).toFixed(2)}%`;
  const w = (a: number, b: number) => `${Math.max(0.8, ((b - a) / span) * 100).toFixed(2)}%`;
  return (
    <section className="pg-today" aria-labelledby="pg-today-title" data-testid="ov-agents-today">
      <header className="pg-today-head">
        <IconTimeline size={15} className="pg-head-icon" aria-hidden />
        <h2 id="pg-today-title" className="ov-card-title">
          Agents today
        </h2>
        {(t.live > 0 || t.stale > 0) && (
          <span className="pg-live">
            <span className="ov-pulse" aria-hidden /> {t.live} live{t.stale ? ` · ${t.stale} stale` : ''}
          </span>
        )}
        <span className="pg-legend" aria-hidden>
          <span data-k="implement">implement</span>
          <span data-k="review">review</span>
          <span data-k="fix">fix</span>
          <span data-k="completed">completed</span>
        </span>
      </header>
      {t.lanes.length === 0 ? (
        <div className="ov-muted pg-today-empty">No agent has held a work order today.</div>
      ) : (
        <div className="pg-lanes">
          {t.lanes.map((l) => (
            <div key={l.agent} className="pg-lane" data-testid="pg-lane">
              <span className="pg-lane-who">
                <AgentMark agent={agentClient(l.agent)} size={14} />
                <span className="pg-lane-name">{l.agent}</span>
              </span>
              <div className="pg-track">
                {l.bars.map((b, i) => (
                  <Tooltip key={`${b.workOrder}-${i}`} label={`${b.workOrder} ${b.title} · ${kindLabel(b.kind)} · ${new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${b.state === 'live' ? 'now' : new Date(b.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${b.state}`} openDelay={200}>
                    <Link to={`/work-orders/${b.workOrder}`} className="pg-bar" data-kind={b.kind} data-state={b.state} style={{ left: x(b.start), width: w(b.start, b.end) }} data-testid="pg-bar">
                      <span className="pg-bar-label mono">{b.workOrder}</span>
                    </Link>
                  </Tooltip>
                ))}
                <span className="pg-now" style={{ left: x(now) }} aria-hidden />
              </div>
            </div>
          ))}
          <div className="pg-lane pg-axis" aria-hidden>
            <span />
            <div className="pg-track">
              {hourTicks(t.from, t.to).map((h) => (
                <span key={h} className="pg-tick" style={{ left: x(h) }}>
                  {new Date(h).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- in progress by spec */

/** Spec section bar: implemented, in progress, rest. */
function SpecBar({ m }: { m: SpecMaturity }) {
  const { implemented, inProgress, total } = m.sections;
  return (
    <Tooltip label={`${implemented} implemented · ${inProgress} in progress · ${total} sections`} openDelay={300}>
      <span className="pg-specbar">
        <span className="pg-seg" aria-hidden>
          {Array.from({ length: Math.min(total, 12) }, (_, i) => {
            const k = Math.round(((i + 1) * total) / Math.min(total, 12));
            return <span key={i} data-k={k <= implemented ? 'done' : k <= implemented + inProgress ? 'wip' : 'todo'} />;
          })}
        </span>
        <span className="ov-muted">
          {implemented}/{total} sections done
        </span>
      </span>
    </Tooltip>
  );
}

function StepPill({ step }: { step: MaturityStep }) {
  return (
    <span className="maturity-badge" data-tone={STEP_TONE[step]} data-size="sm" data-step={step}>
      <MaturityMeter stepIndex={MATURITY_STEPS.indexOf(step) + 1} tone={STEP_TONE[step]} audited={step === 'audited'} />
      <span className="maturity-label">{MATURITY_LABELS[step]}</span>
    </span>
  );
}

function WorkOrderRow({ w, now }: { w: OverviewWorkOrder; now: number }) {
  const uri = buildRef({ kind: 'work-orders', id: w.id });
  return (
    <li className="pg-wo" data-stale={w.claim?.stale || undefined} data-testid="pg-wo">
      {w.claim ? <AgentFaceMark agent={w.claim.agent} at={w.claim.startedAt} /> : <span className="pg-agent" />}
      <div className="pg-wo-main">
        <div className="pg-wo-top">
          <span className="kind-badge" data-kind={w.kind}>
            {kindLabel(w.kind)}
          </span>
          <Link to={`/work-orders/${w.id}`} className="ov-wo-title">
            <KindIcon kind="work_order" className="kind-prefix" />
            <span className="mono ov-id">{w.id}</span> {w.title}
          </Link>
        </div>
        <div className="ov-wo-meta pg-wo-meta">
          <Heartbeat w={w} now={now} />
          <PlanStep w={w} />
          {w.claim && <span className="ov-agent">{w.claim.agent}</span>}
          {w.claim && (
            <Tooltip label={`Claimed ${absoluteTime(w.claim.startedAt)}`} openDelay={300}>
              <span className="ov-muted">started {compactTime(w.claim.startedAt, now)}</span>
            </Tooltip>
          )}
          {w.claim?.branch && !w.git.some((g) => g.branch) && (
            <span className="ov-branch mono">
              <IconGitBranch size={12} /> {w.claim.branch}
            </span>
          )}
          <WorkOrderGitSummary item={{ git: w.git }} compact />
        </div>
      </div>
      <div className="pg-wo-side">
        <SectionProgress done={w.sections.done} total={w.sections.total} />
        <ItemMenu label={w.id} prompt={itemPrompt('continue_work', uri)} actions={releaseAction(w, now)} />
      </div>
    </li>
  );
}

export function InProgress({ o, now, moves = [] }: { o: ProjectOverview; now: number; moves?: SpecMove[] }) {
  const groups = groupBySpec(o);
  const moveOf = new Map(moves.map((m) => [m.id, m]));
  return (
    <Card id="in-progress" flat icon={<IconPlayerPlay size={15} />} title="In progress by spec" count={o.inProgressTotal} action={<Link to="/work-orders" className="ov-more">All work orders <IconArrowRight size={12} /></Link>}>
      {o.inProgress.length === 0 ? (
        <Empty icon={<IconClipboardList size={18} stroke={1.5} />} title="No agent is working right now">
          {o.queued ? `${plural(o.queued, 'work order')} ${o.queued === 1 ? 'waits' : 'wait'} for an agent to claim ${o.queued === 1 ? 'it' : 'them'}.` : 'Work orders appear here while a coding agent has them claimed.'}
        </Empty>
      ) : (
        <>
          <Capped
            items={groups}
            cap={6}
            className="ov-list pg-groups"
            render={(g) => {
              const mv = moveOf.get(g.id);
              return (
                <li key={g.id} className="pg-group" data-testid="pg-spec-group">
                  <div className="pg-group-head">
                    <KindIcon kind="spec" size={15} className="pg-head-icon" />
                    <Link to={`/specs/${g.id}`} className="pg-group-title">
                      {g.title}
                    </Link>
                    {g.maturity && <MaturityBadge m={g.maturity} size="sm" />}
                    {mv && (
                      <span className="ov-muted">
                        {MATURITY_LABELS[mv.from].toLowerCase()} → {MATURITY_LABELS[mv.to].toLowerCase()} {compactTime(mv.at, now)}
                      </span>
                    )}
                    {g.maturity && g.maturity.sections.total > 0 && <SpecBar m={g.maturity} />}
                  </div>
                  <ul className="ov-list pg-wos">
                    {g.items.map((w) => (
                      <WorkOrderRow key={w.id} w={w} now={now} />
                    ))}
                  </ul>
                </li>
              );
            }}
          />
          {o.inProgressTotal > o.inProgress.length && (
            <div className="ov-foot">
              <Link to="/work-orders?show=in_progress">{plural(o.inProgressTotal - o.inProgress.length, 'more work order')} in progress</Link>
            </div>
          )}
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

/* ---------------------------------------------------------------- side column */

export function Stuck({ o, now }: { o: ProjectOverview; now: number }) {
  const items = stuckItems(o);
  const extra = Math.max(0, o.blockedTotal - o.blocked.length);
  return (
    <Card id="stuck" flat icon={<IconAlertTriangle size={15} />} title="Stuck" count={items.length + extra}>
      {items.length === 0 ? (
        <Empty icon={<IconCircleCheck size={18} stroke={1.5} />} title="Nothing is stuck">
          Stale claims and work waiting on unfinished work show up here.
        </Empty>
      ) : (
        <>
          <Capped
            items={items}
            cap={5}
            render={(it) =>
              it.kind === 'claim' ? (
                <li key={`c-${it.w.id}`} className="pg-stuck" data-testid="pg-stuck-claim">
                  <span className="pg-stuck-icon" data-tone="warn" aria-hidden>
                    <IconClockPause size={15} />
                  </span>
                  <div className="pg-stuck-main">
                    <Link to={`/work-orders/${it.w.id}`} className="ov-wo-title">
                      <KindIcon kind="work_order" className="kind-prefix" />
                      <span className="mono ov-id">{it.w.id}</span> has a stale claim
                    </Link>
                    <span className="ov-muted">
                      {it.w.claim!.agent} · last heartbeat {compactTime(it.w.claim!.heartbeatAt, now)}
                    </span>
                  </div>
                  <ItemMenu label={it.w.id} prompt={itemPrompt('continue_work', buildRef({ kind: 'work-orders', id: it.w.id }))} actions={releaseAction(it.w, now)} />
                </li>
              ) : (
                <li key={`b-${it.b.uri}`} className="pg-stuck" data-testid="pg-stuck-blocked">
                  <span className="pg-stuck-icon" data-tone="danger" aria-hidden>
                    <IconLock size={15} />
                  </span>
                  <div className="pg-stuck-main">
                    <Link to={refHref(it.b.uri) ?? '#'} className="ov-wo-title">
                      <KindIcon kind={it.b.kind === 'work_order' ? 'work_order' : 'section'} className="kind-prefix" />
                      {it.b.kind === 'work_order' ? (
                        <>
                          <span className="mono ov-id">{it.b.id}</span> {it.b.title}
                        </>
                      ) : (
                        `${it.b.specTitle ?? it.b.specId} · ${it.b.title}`
                      )}
                    </Link>
                    <span className="ov-muted">
                      {it.b.blockedBy.length === 0
                        ? 'waits on a dependency'
                        : `waits on ${it.b.blockedBy
                            .slice(0, 2)
                            .map((x) => (x.workOrder ? `${x.workOrder.id} ${x.title}` : x.title))
                            .join(', ')}${it.b.blockedBy.length > 2 ? ` +${it.b.blockedBy.length - 2}` : ''}`}
                    </span>
                  </div>
                </li>
              )
            }
          />
          {extra > 0 && (
            <div className="ov-foot">
              <Link to="/waiting?focus=blocked">{plural(extra, 'more blocked item')}</Link>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function RecentlyCompleted({ o, now }: { o: ProjectOverview; now: number }) {
  const items = o.recentlyCompleted ?? [];
  return (
    <Card id="completed" flat icon={<IconCircleCheck size={15} />} title="Recently completed" count={items.length} action={<Link to="/work-orders?show=done" className="ov-more">All work orders <IconArrowRight size={12} /></Link>}>
      {items.length === 0 ? (
        <Empty icon={<IconCircleCheck size={18} stroke={1.5} />} title="No work order completed this week">
          Work orders agents finish show up here with how long they took.
        </Empty>
      ) : (
        <Capped
          items={items}
          cap={5}
          render={(c) => (
            <li key={c.id} className="pg-done" data-testid="pg-completed">
              <IconCircleCheck size={15} className="pg-done-icon" aria-hidden />
              <Link to={`/work-orders/${c.id}`} className="pg-done-title">
                <KindIcon kind="work_order" className="kind-prefix" />
                <span className="mono ov-id">{c.id}</span> {c.title}
              </Link>
              {c.agent && <AgentMark agent={agentClient(c.agent)} size={14} />}
              <span className="ov-time">
                {c.startedAt && (
                  <Tooltip label={`Last claim ${absoluteTime(c.startedAt)} → completed ${absoluteTime(c.completedAt)}`} openDelay={300}>
                    <span data-testid="pg-duration">{duration(Date.parse(c.completedAt) - Date.parse(c.startedAt))} · </span>
                  </Tooltip>
                )}
                {compactTime(c.completedAt, now)}
              </span>
            </li>
          )}
        />
      )}
    </Card>
  );
}

export function SpecsMoving({ moves, loading, now }: { moves: SpecMove[]; loading: boolean; now: number }) {
  return (
    <Card id="moving" flat icon={<IconStairsUp size={15} />} title="Specs moving" count={loading ? undefined : moves.length} action={<span className="ov-muted">last {MOVING_HOURS} hours</span>}>
      {loading ? (
        <div className="ov-skeleton">
          {[0, 1].map((i) => (
            <Skeleton key={i} height={14} width={`${70 - i * 15}%`} radius="sm" />
          ))}
        </div>
      ) : moves.length === 0 ? (
        <Empty icon={<IconStairsUp size={18} stroke={1.5} />} title={`No spec changed step in the last ${MOVING_HOURS} hours`}>
          Specs show up here when they move up the maturity ladder (specified, in progress, implemented, audited).
        </Empty>
      ) : (
        <Capped
          items={moves}
          cap={5}
          render={(m) => (
            <li key={m.id} className="pg-move" data-testid="pg-move">
              <div className="pg-move-head">
                <Link to={`/specs/${m.id}`} className="ov-wo-title">
                  <KindIcon kind="spec" className="kind-prefix" />
                  {m.title}
                </Link>
                <When iso={m.at} now={now} />
              </div>
              <div className="pg-move-line">
                <StepPill step={m.from} />
                <IconArrowRight size={12} className="ov-muted" aria-hidden />
                <StepPill step={m.to} />
                <ActorAvatar user={m.event.user} agent={m.event.agent} size={16} at={m.event.at} verb="Changed" />
                <span className="ov-muted pg-move-why">{m.event.summary}</span>
              </div>
            </li>
          )}
        />
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- recently changed */

const CATEGORY_ICON: Record<RecentItem['category'], ReactNode> = {
  edit: FAMILY_ICON.spec,
  work_order: FAMILY_ICON.work_order,
  feedback: FAMILY_ICON.feedback,
  audit: FAMILY_ICON.audit,
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

export function RecentlyChanged({ events, loading, error, now, flat }: { events: ActivityEvent[]; loading: boolean; error: Error | null; now: number; flat?: boolean }) {
  const days = groupRecent(events);
  const count = days.reduce((n, d) => n + d.items.length, 0);
  return (
    <Card id="recent" flat={flat} icon={<IconHistory size={15} />} title={`Recently changed · last ${RECENT_DAYS} days`} count={loading ? undefined : count}>
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

/** The whole tab: timeline on top, work by spec on the left, the side column on the right. */
export function ProgressTab({ o, now, recent, moving }: { o: ProjectOverview; now: number; recent: { events: ActivityEvent[]; loading: boolean; error: Error | null }; moving: { events: ActivityEvent[]; loading: boolean } }) {
  const moves = specsMoving(moving.events, stepsOf(o));
  return (
    <div className="pg-tab">
      <AgentsToday o={o} now={now} />
      <div className="pg-cols">
        <div className="pg-main">
          <InProgress o={o} now={now} moves={moves} />
        </div>
        <aside className="pg-side">
          <Stuck o={o} now={now} />
          <RecentlyCompleted o={o} now={now} />
          <SpecsMoving moves={moves} loading={moving.loading} now={now} />
          <RecentlyChanged events={recent.events} loading={recent.loading} error={recent.error} now={now} flat />
        </aside>
      </div>
    </div>
  );
}
