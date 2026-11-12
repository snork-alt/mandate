/** Settings → Recent writers: who wrote to a project lately (user / coding agent / credential), from `writers_recent`. */
import { useAuthStatus } from '../auth';
import { useState } from 'react';
import { Alert, Loader, Select, Text, Tooltip } from '@mantine/core';
import type { WritersResponse } from '@mandate/shared';
import { callProjectTool } from '../mcp/client';
import { useProjects } from '../connect/projects';
import { lastProject } from '../project';
import { useWriters } from '../lib/lineage';
import { isServiceUser, serviceName } from '../lib/attribution';
import { UserAvatar } from '../components/attribution/Attribution';
import { relativeTime, absoluteTime } from '../lib/time';
import { StepIntro } from './widgets';
import type { SectionProps } from './sections';
import '../components/lineage/lineage.css';

/** The writers table (pure): user, coding agent and credential. */
export function WritersTable({ data }: { data: WritersResponse }) {
  return (
    <>
      <div className="writers-stats" data-testid="writers-stats">
        <span>{data.scanned} recent commits</span>
        <span data-warn={data.unattributed > 0 || undefined}>{data.unattributed} without a user</span>
        <span>{data.service} by service accounts</span>
      </div>
      {data.writers.length === 0 ? (
        <Text size="sm" c="dimmed">
          No writes yet.
        </Text>
      ) : (
        <table className="writers-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Coding agent</th>
              <th>Credential</th>
              <th style={{ textAlign: 'right' }}>Commits</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {data.writers.map((w, i) => {
              const flag = !w.user ? 'unattributed' : isServiceUser(w.user) ? 'service' : undefined;
              return (
                <tr key={`${w.user}|${w.agent}|${w.source}|${i}`} data-flag={flag}>
                  <td>
                    {w.user ? (
                      <span className="attr-by">
                        <UserAvatar user={w.user} size={16} />
                        {!isServiceUser(w.user) && <span className="attr-user">{w.user}</span>}
                        {isServiceUser(w.user) && <span className="attr-user">{serviceName(w.user)}</span>}
                      </span>
                    ) : (
                      <span className="faint">unattributed</span>
                    )}
                  </td>
                  <td>{w.agent ?? <span className="faint">unknown</span>}</td>
                  <td className="mono">{w.source ?? <span className="faint">-</span>}</td>
                  <td style={{ textAlign: 'right' }}>{w.commits}</td>
                  <td>
                    <Tooltip label={absoluteTime(w.last)} withinPortal>
                      <span>{relativeTime(w.last)}</span>
                    </Tooltip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

export function WritersSection(_p: SectionProps) {
  const projects = useProjects();
  const auth = useAuthStatus();
  const items = projects.data?.items ?? [];
  const fallback = (() => {
    const last = lastProject();
    return last && items.some((p) => p.id === last) ? last : (projects.data?.defaultProject ?? null);
  })();
  const [picked, setPicked] = useState<string | null>(null);
  const project = picked ?? fallback;
  const q = useWriters(project ? (name, args) => callProjectTool<WritersResponse>(project, name, args) : null, project);
  return (
    <div className="su-section" data-testid="recent-writers">
      <StepIntro title="Recent writers">
        Who wrote to a project recently: the user, the coding agent and the credential it used. Writes without a user and service-account writes are highlighted.
      </StepIntro>
      {auth.data?.legacy && (
        <Alert color="yellow" variant="light" mb={8} data-testid="legacy-notice">
          This install signs in with an OAuth App and keeps its sign-in allow-list. Shared project keys are refused, so coding agents connect with MCP sign-in or a personal token (Connect dialog), and CI uses a service account (<code>mandate key create &lt;project&gt; --service &lt;name&gt;</code>). Create a GitHub App in Settings → GitHub to switch to per-repository access.
        </Alert>
      )}
      {items.length > 1 && (
        <Select size="xs" w={240} mb={8} data={items.map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setPicked} allowDeselect={false} aria-label="Project" comboboxProps={{ withinPortal: true }} />
      )}
      {(projects.isLoading || q.isLoading) && <Loader size="sm" />}
      {q.isError && (
        <Alert color="gray" variant="light">
          Recent writers are unavailable: {q.error.message}
        </Alert>
      )}
      {q.data && <WritersTable data={q.data} />}
    </div>
  );
}
