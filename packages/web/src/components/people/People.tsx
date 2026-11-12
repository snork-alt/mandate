import { createContext, Fragment, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import { HoverCard } from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Contributor } from '@mandate/shared';
import { isServiceUser, serviceName, useShowUsers } from '../../lib/attribution';
import { contributorsLabel, directOf, useContributors, useDirectoryUser, viaGroups, type LabelPart } from '../../lib/people';
import { initials } from '../../lib/specs';
import { absoluteTime, relativeTime } from '../../lib/time';
import { refHref } from '../refs/kinds';
import './people.css';

/** Views with a "by user" filter provide this: clicking an avatar or a login filters by that user. */
export const UserFilterContext = createContext<((user: string) => void) | null>(null);

export type AvatarSize = 'xs' | 'sm' | 'md' | number;
const PX: Record<'xs' | 'sm' | 'md', number> = { xs: 16, sm: 20, md: 28 };
export const avatarPx = (s: AvatarSize) => (typeof s === 'number' ? s : PX[s]);

/** The face of a coding agent (no user recorded): initials in a ring and a small agent glyph; `legacy` adds a dashed ring. */
export function AgentFace({ agent, px, legacy }: { agent?: string; px: number; legacy?: boolean }) {
  return (
    <span className="pp-avatar pp-agent" data-legacy={legacy || undefined} style={{ width: px, height: px, fontSize: Math.max(7, px * 0.4) }} data-testid="agent-avatar" data-agent={agent ?? ''}>
      {agent ? initials(agent) : <IconRobot size={Math.round(px * 0.62)} stroke={1.8} />}
      {agent && px >= 16 && (
        <span className="pp-agent-glyph" aria-hidden>
          <IconRobot size={Math.max(7, Math.round(px * 0.42))} stroke={2} />
        </span>
      )}
    </span>
  );
}

/** The face of a user: directory avatar (lazy, cached by the browser), initials while loading or without one. */
function Face({ user, px, agent }: { user: string; px: number; /** `user` is an agent identity (no user recorded). */ agent?: boolean }) {
  if (agent) return <AgentFace agent={user} px={px} legacy />;
  return <UserFace user={user} px={px} />;
}

function UserFace({ user, px }: { user: string; px: number }) {
  const dir = useDirectoryUser(isServiceUser(user) ? null : user);
  const [failed, setFailed] = useState(false);
  if (isServiceUser(user)) {
    return (
      <span className="pp-service" style={{ height: px, fontSize: Math.max(9, px * 0.48) }} data-testid="service-badge">
        service
      </span>
    );
  }
  const src = dir.data?.avatarUrl;
  return src && !failed ? (
    <img className="pp-avatar" src={src} alt="" width={px} height={px} loading="lazy" decoding="async" onError={() => setFailed(true)} data-testid="avatar-img" />
  ) : (
    <span className="pp-avatar pp-initials" style={{ width: px, height: px, fontSize: Math.max(8, px * 0.42) }} data-testid="avatar-initials">
      {initials(user)}
    </span>
  );
}

/** Hover card of one user: avatar, login, name, "via <agent>", when. */
export function UserCardBody({ user, agents, at, extra }: { user: string; agents?: string[]; at?: string; extra?: ReactNode }) {
  const dir = useDirectoryUser(isServiceUser(user) ? null : user);
  return (
    <div className="pp-card" data-testid="user-card">
      <div className="pp-card-head">
        <Face user={user} px={28} />
        <div className="pp-card-who">
          <strong>{isServiceUser(user) ? serviceName(user) : user}</strong>
          {isServiceUser(user) ? <span className="faint">Service account</span> : dir.data?.name && <span className="faint">{dir.data.name}</span>}
        </div>
      </div>
      {(agents?.length || at) && (
        <div className="pp-card-meta">
          {agents?.length ? <span>via {agents.join(', ')}</span> : null}
          {at && <span>{relativeTime(at)} · {absoluteTime(at)}</span>}
        </div>
      )}
      {extra}
    </div>
  );
}

/**
 * One shared avatar (server mode only; renders nothing in local mode): round directory image or initials, a neutral
 * badge for service accounts, a styled hover card (login, name, via agent, time) and click-to-filter where the view
 * has a user filter.
 */
export function UserAvatar({ user, size = 'sm', agent, at, hover = true, ring }: { user: string; size?: AvatarSize; agent?: string; at?: string; hover?: boolean; ring?: boolean }) {
  const show = useShowUsers();
  const filter = useContext(UserFilterContext);
  if (!show) return null;
  const px = avatarPx(size);
  const onClick = filter
    ? (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        filter(user);
      }
    : undefined;
  const face = (
    <span className="pp-slot" data-ring={ring || undefined} data-clickable={filter ? true : undefined} onClick={onClick} role={filter ? 'button' : undefined} aria-label={filter ? `Filter by ${user}` : user} data-user={user}>
      <Face user={user} px={px} />
    </span>
  );
  if (!hover) return face;
  return (
    <HoverCard openDelay={350} closeDelay={80} width={240} position="bottom-start" shadow="md" withinPortal>
      <HoverCard.Target>{face}</HoverCard.Target>
      <HoverCard.Dropdown p={10}>
        <UserCardBody user={user} agents={agent ? [agent] : undefined} at={at} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** A login in a label: bold, filters the view when it can. */
function Login({ user }: { user: string }) {
  const filter = useContext(UserFilterContext);
  const name = isServiceUser(user) ? serviceName(user) : user;
  return filter ? (
    <button type="button" className="pp-login" onClick={(e) => (e.preventDefault(), e.stopPropagation(), filter(user))}>
      {name}
    </button>
  ) : (
    <strong className="pp-login">{name}</strong>
  );
}

export function LabelParts({ parts }: { parts: LabelPart[] }) {
  return (
    <span className="pp-label" data-testid="contributors-label">
      {parts.map((p, i) =>
        p.user ? (
          <Login key={i} user={p.user} />
        ) : p.cause ? (
          <Link key={i} to={refHref(p.cause) ?? '#'} className="pp-cause" onClick={(e) => e.stopPropagation()}>
            {p.text}
          </Link>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

const isAgentOnly = (c: Pick<Contributor, 'userRecorded'>) => c.userRecorded === false;

function ContributorRow({ c }: { c: Contributor }) {
  const agentOnly = isAgentOnly(c);
  const dir = useDirectoryUser(agentOnly || isServiceUser(c.user) ? null : c.user);
  return (
    <li className="pp-row" data-kind={c.kind}>
      <Face user={c.user} px={22} agent={agentOnly} />
      <div className="pp-row-main">
        <div>
          {agentOnly ? (
            <>
              <strong className="pp-login">{c.user}</strong> <span className="faint">agent · no user recorded</span>
            </>
          ) : (
            <>
              <Login user={c.user} /> {dir.data?.name && <span className="faint">{dir.data.name}</span>}
            </>
          )}
        </div>
        <div className="pp-row-meta">
          {c.roles.join(', ')}
          {c.agents.length > 0 && <> · via {c.agents.join(', ')}</>}
          {c.lastAt && <> · {relativeTime(c.lastAt)}</>}
          {c.alsoVia?.length ? <> · also via {c.alsoVia.map((v) => v.uri.split('/').pop()).join(', ')}</> : null}
        </div>
      </div>
      <span className="pp-count" aria-label={`${c.count} contributions`}>
        {c.count}
      </span>
    </li>
  );
}

/** GitHub-like contributors list: "Edited by" (direct) and "Contributed via <cause>" groups. */
export function ContributorsList({ contributors }: { contributors: Contributor[] }) {
  const direct = directOf(contributors);
  const groups = viaGroups(contributors);
  return (
    <div className="pp-list" data-testid="contributors-list">
      {direct.length > 0 && (
        <>
          <div className="pp-list-head">Edited by</div>
          <ul>
            {direct.map((c) => (
              <ContributorRow key={c.user} c={c} />
            ))}
          </ul>
        </>
      )}
      {groups.map((g) => (
        <Fragment key={g.cause?.uri ?? '-'}>
          <div className="pp-list-head">
            Contributed via{' '}
            {g.cause ? (
              <Link to={refHref(g.cause.uri) ?? '#'} className="pp-cause">
                {g.cause.label}
              </Link>
            ) : (
              'a cause'
            )}
          </div>
          <ul>
            {g.users.map((c) => (
              <ContributorRow key={c.user} c={c} />
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Overlapping round avatars (direct first, then a thin divider and the faded "via" ones), "+N" after `max`, an
 * optional label (`full` for documents, `compact` for sections) and a hover card listing everyone.
 */
export function AvatarStack({ contributors, max = 4, size = 'sm', form }: { contributors: Contributor[]; max?: number; size?: AvatarSize; form?: 'full' | 'compact' }) {
  if (!contributors.length) return null;
  const px = avatarPx(size);
  const shown = contributors.slice(0, max);
  const more = contributors.length - shown.length;
  const firstVia = shown.findIndex((c) => c.kind === 'via');
  const stack = (
    <span className="pp-stack" data-testid="avatar-stack" style={{ ['--pp-size' as string]: `${px}px` }}>
      {shown.map((c, i) => (
        <Fragment key={c.user}>
          {i === firstVia && i > 0 && <span className="pp-divider" aria-hidden />}
          <span className="pp-stack-item" data-kind={c.kind} data-user={c.user}>
            <Face user={c.user} px={px} agent={isAgentOnly(c)} />
          </span>
        </Fragment>
      ))}
      {more > 0 && (
        <span className="pp-more" data-testid="avatar-more">
          +{more}
        </span>
      )}
    </span>
  );
  return (
    <span className="pp-stack-wrap" data-form={form}>
      <HoverCard openDelay={300} closeDelay={100} width={320} position="bottom-end" shadow="md" withinPortal>
        <HoverCard.Target>{stack}</HoverCard.Target>
        <HoverCard.Dropdown p={10}>
          <ContributorsList contributors={contributors} />
        </HoverCard.Dropdown>
      </HoverCard>
      {form && <LabelParts parts={contributorsLabel(contributors, form)} />}
    </span>
  );
}

/** Fetching wrapper: the contributors of `refUri` (batched), nothing in local mode or when there are none. */
export function Contributors({ refUri, max, size, form }: { refUri: string; max?: number; size?: AvatarSize; form?: 'full' | 'compact' }) {
  const q = useContributors(refUri);
  return q.data?.length ? <AvatarStack contributors={q.data} max={max} size={size} form={form} /> : null;
}

/** "co-authored by <avatars> alice and bob" (Co-authored-by trailers), server mode only. */
export function CoAuthors({ logins }: { logins?: string[] }) {
  const show = useShowUsers();
  if (!show || !logins?.length) return null;
  return (
    <span className="pp-coauthors" data-testid="co-authors">
      <span className="faint">co-authored by</span>
      {logins.map((l) => (
        <span key={l} className="pp-coauthor">
          <UserAvatar user={l} size="xs" />
          <Login user={l} />
        </span>
      ))}
    </span>
  );
}

/** Document header: the stack, the full label and "N contributors" (server mode; nothing without contributors). */
export function DocContributors({ refUri }: { refUri: string }) {
  const q = useContributors(refUri);
  const cs = q.data ?? [];
  if (!cs.length) return null;
  return (
    <div className="doc-people" data-testid="doc-people">
      <AvatarStack contributors={cs} size="sm" form="full" />
      <span className="faint">
        · {cs.length} contributor{cs.length === 1 ? '' : 's'}
      </span>
    </div>
  );
}

/** Who to show when no contributor is known: the recorded user, else the coding agent (legacy items, local mode). */
export interface ActorFallback {
  user?: string;
  agent?: string;
  at?: string;
  /** "Created" (default), "Filed", "Edited", "Audited"… */
  verb?: string;
}

/**
 * A coding agent's avatar with a hover card. Server mode (`legacy`): dashed ring, "Created via <agent>; no user
 * recorded". Local mode: the same face without the dashed ring ("Created via <agent>").
 */
export function AgentAvatar({ agent, size = 'xs', legacy, verb = 'Created', at }: { agent?: string; size?: AvatarSize; legacy?: boolean; verb?: string; at?: string }) {
  const px = avatarPx(size);
  const what = agent ? `${verb} via ${agent}` : `${verb} by an unknown agent`;
  return (
    <HoverCard openDelay={350} closeDelay={80} width={240} position="bottom-start" shadow="md" withinPortal>
      <HoverCard.Target>
        <span className="pp-slot" aria-label={agent ? `agent ${agent}` : 'unknown agent'} data-agent={agent ?? ''}>
          <AgentFace agent={agent} px={px} legacy={legacy} />
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown p={10} onClick={(e) => (e.preventDefault(), e.stopPropagation())}>
        <div className="pp-card" data-testid="agent-card">
          <div className="pp-card-head">
            <AgentFace agent={agent} px={28} legacy={legacy} />
            <div className="pp-card-who">
              <strong>{agent ?? 'Unknown agent'}</strong>
              <span className="faint">Coding agent</span>
            </div>
          </div>
          <div className="pp-card-meta">
            <span>{legacy ? `${what}; no user recorded` : what}</span>
            {at && (
              <span>
                {relativeTime(at)} · {absoluteTime(at)}
              </span>
            )}
          </div>
        </div>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** One actor (activity feed, comments): the user's avatar in server mode, else the agent's (dashed when legacy). */
export function ActorAvatar({ user, agent, size = 'xs', at, verb }: { user?: string; agent?: string; size?: AvatarSize; at?: string; verb?: string }) {
  const show = useShowUsers();
  if (show && user) return <UserAvatar user={user} size={size} agent={agent} at={at} />;
  return <AgentAvatar agent={agent} size={size} legacy={show} at={at} verb={verb} />;
}

/** Contributors with `first` (e.g. the feedback's filer) moved to (or added at) the front. */
export function withFirst(cs: Contributor[], first?: ActorFallback): Contributor[] {
  if (!first?.user) return cs;
  const i = cs.findIndex((c) => c.user === first.user);
  if (i === 0) return cs;
  if (i > 0) return [cs[i]!, ...cs.slice(0, i), ...cs.slice(i + 1)];
  const filer: Contributor = { user: first.user, userRecorded: true, kind: 'direct', roles: [(first.verb ?? 'created').toLowerCase()], count: 1, lastAt: first.at ?? '', agents: first.agent ? [first.agent] : [] };
  return [filer, ...cs];
}

/**
 * The people column of every list row (fixed width, never empty): the contributors stack (most recent first; direct,
 * then via) with a hover card; without contributors the recorded user, else the coding agent (dashed ring in server
 * mode: legacy items without a `Mandate-User` trailer; plain in local mode). `first` (feedback: the filer) leads.
 */
export function RowPeople({ refUri, fallback, first, max = 3 }: { refUri: string; fallback?: ActorFallback; first?: boolean; max?: number }) {
  const show = useShowUsers();
  const q = useContributors(refUri);
  const cs = q.data ?? [];
  let content: ReactNode = null;
  if (cs.length) content = <AvatarStack contributors={first ? withFirst(cs, fallback) : cs} max={max} size="xs" />;
  else if (q.isLoading) content = null;
  else if (show && fallback?.user) content = <UserAvatar user={fallback.user} size="xs" agent={fallback.agent} at={fallback.at} />;
  else content = <AgentAvatar agent={fallback?.agent} size="xs" legacy={show} verb={fallback?.verb} at={fallback?.at} />;
  return (
    <span className="row-slot row-slot-people lr-people" data-testid="row-people">
      {content}
    </span>
  );
}

/** Lighter people slot (palette, pickers): the most recent direct contributor, a user or (no user recorded) the agent. */
export function LastEditor({ refUri, className = 'cmdk-last-editor' }: { refUri: string; className?: string }) {
  const show = useShowUsers();
  const q = useContributors(refUri);
  const last = (q.data ?? []).find((c) => c.kind === 'direct');
  return (
    <span className={className} data-testid="last-editor">
      {last &&
        (show && last.userRecorded !== false ? (
          <UserAvatar user={last.user} size="xs" agent={last.agents[0]} at={last.lastAt} hover={false} />
        ) : (
          <AgentAvatar agent={last.user} size="xs" legacy={show} verb="Edited" at={last.lastAt} />
        ))}
    </span>
  );
}
