/**
 * My effective Mandate flow on the current project ("Flow on · 2 agents", "Flow: required"); the hover card lists my
 * agent clients and the project policy; a click opens Settings → Agent flow.
 */
import { HoverCard, Text } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import { goTo } from '../project';
import { relativeTime } from '../lib/time';
import { AgentIcon, flowSummary, POLICY_TEXT, useFlowState } from '../setup/flowApi';

export function FlowBadge({ projectId }: { projectId: string }) {
  const q = useFlowState(projectId, !!projectId);
  const p = q.data?.projects.find((x) => x.id === projectId);
  if (!p) return null;
  const s = flowSummary(p);
  return (
    <HoverCard width={340} shadow="md" withinPortal openDelay={150} position="bottom-start">
      <HoverCard.Target>
        <button type="button" className="access-badge flow-badge" data-tone={s.tone} data-on={s.tone === 'on' || undefined} onClick={() => goTo('/settings#settings-flow')} data-testid="flow-badge">
          <IconRoute size={11} />
          {s.label}
        </button>
      </HoverCard.Target>
      <HoverCard.Dropdown className="flow-card" data-testid="flow-card">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>
          Project policy
        </Text>
        <Text size="sm">
          Flow {POLICY_TEXT[p.policy.flowPolicy].label.toLowerCase()}
        </Text>
        <Text size="xs" c="dimmed" mb={8}>
          {POLICY_TEXT[p.policy.flowPolicy].body}
        </Text>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>
          My agents
        </Text>
        {p.mine.length ? (
          p.mine.map((c) => (
            <div key={c.id} className="flow-card-row">
              <AgentIcon client={c.client} size={13} />
              <Text size="sm" fw={500} className="flow-card-label">
                {c.label}
              </Text>
              <Text size="xs" c="dimmed" className="flow-card-state">
                flow {c.effective.flow}
              </Text>
              <Text size="xs" c="dimmed" className="flow-card-seen">
                {relativeTime(c.lastSeenAt)}
              </Text>
            </div>
          ))
        ) : (
          <Text size="xs" c="dimmed">
            No agent has used this project yet.
          </Text>
        )}
        <Text size="xs" c="dimmed" mt={8}>
          Click to change it in Settings → Agent flow.
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
