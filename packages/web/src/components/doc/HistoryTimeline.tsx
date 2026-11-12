import { useState } from 'react';
import { Skeleton, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router';
import { CommitHash } from '../copy';
import { IconGitBranch, IconRobot, IconUser } from '@tabler/icons-react';
import type { HistoryEntry } from '@mandate/shared';
import { absoluteTime, relativeTime } from '../../lib/time';
import { shortSubject } from '../../lib/specs';
import { filterByUsers, usersOf, useShowUsers } from '../../lib/attribution';
import { ByLine, UserAvatar } from '../attribution/Attribution';
import { FilterButton } from '../FilterButton';
import { CoAuthors, UserFilterContext } from '../people/People';
import { RefChip } from '../refs/RefChip';

/** Compact git history of one file: subject, who (agent trailer or author), branch and time. */
interface Props {
  entries?: HistoryEntry[];
  loading?: boolean;
  now: number;
  /** Link for a version (e.g. `/specs/x/history/<commit>`); entries become clickable when set. */
  versionHref?: (commit: string) => string;
  /** Highlight this commit (current version view). */
  activeCommit?: string;
  /** Entries shown before "Show all". */
  limit?: number;
}

export function HistoryTimeline({ entries, loading, now, versionHref, activeCommit, limit = 8 }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [contentOnly, setContentOnly] = useState(true);
  const [users, setUsers] = useState<string[]>([]);
  const showUsers = useShowUsers();
  if (loading) return <Skeleton height={80} radius="md" />;
  if (!entries?.length) {
    return (
      <Text size="sm" c="var(--app-text-faint)">
        No history yet.
      </Text>
    );
  }
  const tagged = entries.some((e) => e.changes);
  // "Content changes only": hide metadata-only commits (heartbeats...), but keep the selected one.
  const byContent = tagged && contentOnly ? entries.filter((e) => !e.changes || e.changes.includes('text') || e.commit === activeCommit) : entries;
  // "By user".
  const userOptions = usersOf(entries, showUsers);
  const filtered = filterByUsers(byContent, users, showUsers);
  const hidden = entries.length - filtered.length;
  const shown = expanded ? filtered : filtered.slice(0, limit);
  return (
    <UserFilterContext.Provider value={showUsers ? (u: string) => setUsers([u]) : null}>
    <div className="timeline">
      {userOptions.length > 0 && (
        <div className="timeline-filters">
          <FilterButton label="User" options={userOptions.map((u) => ({ value: u, label: u, icon: <UserAvatar user={u} size={14} /> }))} selected={users} onChange={setUsers} clearable summary="colon" />
        </div>
      )}
      {shown.length === 0 && (
        <Text size="sm" c="var(--app-text-faint)">
          No matching changes.
        </Text>
      )}
      {shown.map((h) => (
        <div
          key={h.commit}
          className="timeline-item"
          data-active={h.commit === activeCommit || undefined}
          data-meta-only={(h.changes && !h.changes.includes('text')) || undefined}
        >
          <span className="timeline-dot" data-agent={h.agent ? true : undefined}>
            {h.agent ? <IconRobot size={10} /> : <IconUser size={10} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <Tooltip label={h.body || h.subject} multiline maw={320} openDelay={400}>
              {versionHref ? (
                <Text component={Link} to={versionHref(h.commit)} size="sm" fw={500} lineClamp={2} className="timeline-link">
                  {shortSubject(h.subject)}
                </Text>
              ) : (
                <Text size="sm" fw={500} lineClamp={2}>
                  {shortSubject(h.subject)}
                </Text>
              )}
            </Tooltip>
            <div className="timeline-meta">
              {h.agent || (showUsers && h.user) ? <ByLine a={{ user: h.user, agent: h.agent }} showUsers={showUsers} /> : <span>{h.author}</span>}
              <span>·</span>
              <Tooltip label={absoluteTime(h.date)}>
                <span>{relativeTime(h.date, now)}</span>
              </Tooltip>
              {h.changes && h.changes.length > 0 && <span className="timeline-tag">{h.changes.join(' · ')}</span>}
              <CommitHash sha={h.commit} className="timeline-hash" />
            </div>
            {h.trailers?.['Uploaded-Via'] && (
              <Text size="xs" c="dimmed" className="timeline-upload">
                Uploaded via {h.trailers['Uploaded-Via']} by {(showUsers && h.user) || h.agent || h.author}
              </Text>
            )}
            {h.coAuthors && h.coAuthors.length > 0 && <CoAuthors logins={h.coAuthors} />}
            {h.causes && h.causes.length > 0 && (
              <span className="timeline-cause" aria-label="Recorded cause of this change">
                {h.causes.slice(0, 2).map((c) => (
                  <RefChip key={c} to={c} />
                ))}
                {h.causes.length > 2 && <span className="rail-faint">+{h.causes.length - 2}</span>}
              </span>
            )}
            {h.branch && (
              <span className="timeline-branch">
                <IconGitBranch size={11} />
                {h.branch}
              </span>
            )}
          </div>
        </div>
      ))}
      {tagged && (
        <Switch
          size="xs"
          label={`Content changes only${hidden ? ` (${hidden} hidden)` : ''}`}
          checked={contentOnly}
          onChange={(e) => setContentOnly(e.currentTarget.checked)}
          className="timeline-filter"
        />
      )}
      {filtered.length > limit && (
        <UnstyledButton onClick={() => setExpanded((e) => !e)} className="timeline-more">
          {expanded ? 'Show less' : `Show all ${filtered.length} changes`}
        </UnstyledButton>
      )}
    </div>
    </UserFilterContext.Provider>
  );
}
