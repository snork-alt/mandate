import { Tooltip } from '@mantine/core';
import { AgentAvatar, UserAvatar } from '../people/People';
import type { Attribution } from '@mandate/shared';
import { attributionText, isServiceUser, serviceName, useShowUsers } from '../../lib/attribution';
import { TimeAgo } from '../TimeAgo';
import '../lineage/lineage.css';

export { UserAvatar } from '../people/People';

/**
 * "<avatar> user via agent" in server mode; only "via agent" in local mode (users are never shown there).
 * Renders nothing when neither is known.
 */
export function ByLine({ a, size = 14, showUsers, agentAvatar }: { a: Pick<Attribution, 'user' | 'agent'> | null | undefined; size?: number; showUsers?: boolean; /** Without a user: the agent's avatar (dashed in server mode: no user recorded), so every line has a face. */ agentAvatar?: boolean }) {
  const ctxUsers = useShowUsers();
  const withUsers = showUsers ?? ctxUsers;
  if (!a || (!a.agent && !(withUsers && a.user))) return null;
  const user = withUsers ? a.user : undefined;
  return (
    <span className="attr-by" data-testid="attr-by">
      {user && (
        <>
          <UserAvatar user={user} size={size} agent={a.agent} at={(a as Attribution).at} />{' '}
          <span className="attr-user">{isServiceUser(user) ? serviceName(user) : user}</span>
        </>
      )}
      {!user && agentAvatar && (
        <>
          <AgentAvatar agent={a.agent} size={size} legacy={withUsers} at={(a as Attribution).at} verb="Acted" />{' '}
        </>
      )}
      {a.agent && a.agent !== user && (
        <>
          {user ? ' ' : ''}
          <span className="attr-agent">via {a.agent}</span>
        </>
      )}
    </span>
  );
}

/** " by user via agent" (server mode) / " via agent" (local mode). */
function Who({ a, showUsers }: { a?: Pick<Attribution, 'user' | 'agent'>; showUsers: boolean }) {
  if (!a || !(a.agent || (showUsers && a.user))) return null;
  return (
    <>
      {showUsers && a.user ? ' by ' : ' '}
      <ByLine a={a} showUsers={showUsers} />
    </>
  );
}

export interface AttributionSource {
  createdAt?: string;
  updatedAt?: string;
  /** Legacy: agent or author of the last commit. */
  updatedBy?: string | null;
  createdBy?: Attribution;
  lastEditedBy?: Attribution;
}

/** "Created by X via Y · date" and "Last edited by X via Y · date" (object pages). */
export function DocAttribution({ item }: { item: AttributionSource }) {
  const showUsers = useShowUsers();
  const created = item.createdBy;
  const edited = item.lastEditedBy ?? (item.updatedBy ? { agent: item.updatedBy } : undefined);
  const createdAt = created?.at ?? item.createdAt;
  const editedAt = edited && 'at' in edited ? (edited.at ?? item.updatedAt) : item.updatedAt;
  const sameAsCreated = !!created?.commit && created.commit === item.lastEditedBy?.commit;
  if (!createdAt && !editedAt) return null;
  return (
    <div className="doc-attribution" data-testid="doc-attribution">
      {createdAt && (
        <span className="doc-attribution-line">
          Created
          <Who a={created} showUsers={showUsers} />
          <span className="attr-sep"> · </span>
          <TimeAgo iso={createdAt} />
        </span>
      )}
      {editedAt && !sameAsCreated && (
        <Tooltip label={edited ? attributionText(edited, showUsers) || 'unknown' : 'unknown'} disabled={!edited} openDelay={400}>
          <span className="doc-attribution-line">
            Last edited
            <Who a={edited} showUsers={showUsers} />
            <span className="attr-sep"> · </span>
            <TimeAgo iso={editedAt} />
          </span>
        </Tooltip>
      )}
    </div>
  );
}
