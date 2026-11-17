/**
 * Settings → Agent flow: per project, the policy (admins) and my agents' state (read-only: only the agent changes it,
 * with /mandate-flow; locked when the policy enforces it). Team admins also see every client.
 */
import { Alert, Avatar, Badge, Group, Loader, SegmentedControl, Switch, Table, Text, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { relativeTime } from '../lib/time';
import { StepIntro } from './widgets';
import type { SectionProps } from './sections';
import { AgentIcon, POLICY_TEXT, useFlowMutations, useFlowState, type FlowClient, type FlowProject, type FlowState, type Policy } from './flowApi';

function Locked({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip label="Enforced by the project policy" withinPortal>
      <span className="flow-locked">{children}</span>
    </Tooltip>
  );
}

function ClientName({ c }: { c: FlowClient }) {
  return (
    <Group gap={8} wrap="nowrap">
      <span className="flow-agent-icon">
        <AgentIcon client={c.client} />
      </span>
      <div>
        <Text size="sm" fw={500}>
          {c.label}
          {c.version && (
            <Text span size="xs" c="dimmed" ml={6}>
              {c.version}
            </Text>
          )}
        </Text>
        <Text size="xs" c="dimmed">
          {c.keyName ? `key ${c.keyName} · ` : ''}last seen {relativeTime(c.lastSeenAt)}
        </Text>
      </div>
    </Group>
  );
}

/** On / off state of one client setting (read-only: only the agent changes it, with /mandate-flow). */
function State({ c, k }: { c: FlowClient; k: 'flow' }) {
  const on = c.effective[k] === 'on';
  const badge = (
    <Badge size="sm" variant="light" color={on ? 'green' : 'gray'} aria-label={`Flow for ${c.label}: ${on ? 'on' : 'off'}`} data-testid={`flow-${k}-${c.id}`}>
      {on ? 'On' : 'Off'}
    </Badge>
  );
  if (c.locked[k])
    return (
      <Group gap={6} wrap="nowrap">
        {badge}
        <Locked>
          <IconLock size={12} /> enforced by policy
        </Locked>
      </Group>
    );
  return badge;
}

function MyAgents({ p }: { p: FlowProject }) {
  if (!p.mine.length)
    return (
      <Text size="sm" c="dimmed" data-testid={`flow-mine-empty-${p.id}`}>
        No agents have used this project yet. Run <code>mandate connect</code> in a code repository, then use your agent there.
      </Text>
    );
  // Older servers do not report the questions preference: no column then.
  const hasQuestions = p.mine.some((c) => c.effective.questions !== undefined);
  return (
    <Table verticalSpacing={8} withRowBorders={false} className="flow-table" data-testid={`flow-mine-${p.id}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>My agents</Table.Th>
          <Table.Th w={190}>Flow</Table.Th>
          {hasQuestions && (
            <Table.Th w={210}>
              <Tooltip label="Where the agent asks you questions: in the Mandate web UI (answer any time) or in the chat" withinPortal>
                <span>Questions</span>
              </Tooltip>
            </Table.Th>
          )}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {p.mine.map((c) => (
          <Table.Tr key={c.id}>
            <Table.Td>
              <ClientName c={c} />
            </Table.Td>
            <Table.Td>
              <State c={c} k="flow" />
            </Table.Td>
            {hasQuestions && (
              <Table.Td>
                <Text size="sm" data-testid={`flow-questions-${c.id}`}>
                  {c.effective.questions === 'chat' ? 'In chat' : 'Via Mandate'}
                </Text>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
      <Table.Caption>
        <Text size="xs" c="dimmed" data-testid={`flow-mine-hint-${p.id}`}>
          Change it from the agent with <code>/mandate-flow on|off</code> (also <code>questions mandate|chat</code>).
        </Text>
      </Table.Caption>
    </Table>
  );
}

function AllClients({ p }: { p: FlowProject }) {
  if (!p.all?.length) return null;
  return (
    <Table verticalSpacing={6} withRowBorders={false} className="flow-table" data-testid={`flow-all-${p.id}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>All clients</Table.Th>
          <Table.Th w={190}>State</Table.Th>
          <Table.Th w={130}>Last seen</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {p.all.map((c) => (
          <Table.Tr key={c.id}>
            <Table.Td>
              <Group gap={8} wrap="nowrap">
                {c.user && <Avatar src={`https://github.com/${encodeURIComponent(c.user)}.png?size=40`} size={20} radius="xl" alt={c.user} />}
                <Text size="sm">{c.user ?? '—'}</Text>
                <Text size="sm" c="dimmed">
                  ·
                </Text>
                <span className="flow-agent-icon">
                  <AgentIcon client={c.client} size={13} />
                </span>
                <Text size="sm">{c.label}</Text>
              </Group>
            </Table.Td>
            <Table.Td>
              <Text size="sm">
                flow {c.effective.flow}
                {c.effective.questions && ` · questions ${c.effective.questions === 'chat' ? 'in chat' : 'via Mandate'}`}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="xs" c="dimmed">
                {relativeTime(c.lastSeenAt)}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function PolicyControls({ p, admin }: { p: FlowProject; admin: boolean }) {
  const m = useFlowMutations();
  const set = (patch: Partial<Policy>) => m.policy.mutate({ project: p.id, patch });
  return (
    <div className="flow-policy" data-testid={`flow-policy-${p.id}`}>
      <div className="flow-policy-row">
        <Text size="sm" fw={500}>
          Flow policy
        </Text>
        <SegmentedControl
          size="xs"
          value={p.policy.flowPolicy}
          disabled={!admin || m.policy.isPending}
          onChange={(v) => set({ flowPolicy: v as Policy['flowPolicy'] })}
          data={(['required', 'optional', 'off'] as const).map((v) => ({ value: v, label: POLICY_TEXT[v].label }))}
        />
        <Text size="xs" c="dimmed">
          {POLICY_TEXT[p.policy.flowPolicy].body}
        </Text>
      </div>
      <div className="flow-policy-row" data-testid={`flow-strict-${p.id}`}>
        <Text size="sm" fw={500}>
          Strict flow
        </Text>
        <Switch
          size="sm"
          checked={!!p.policy.strictFlow}
          disabled={!admin || m.policy.isPending}
          onChange={(e) => set({ strictFlow: e.currentTarget.checked })}
          aria-label="Strict flow"
          label={p.policy.strictFlow ? 'On' : 'Off'}
        />
        <Text size="xs" c="dimmed">
          Opt-in. Claude Code refuses code edits (the <code>mandate guard</code> hook) unless the agent holds a claimed work order with a step in progress. Installed by the project&apos;s
          installer when this is on; needs a personal token.
        </Text>
      </div>
      {!admin && (
        <Text size="xs" c="dimmed">
          Only Mandate admins change the policy.
        </Text>
      )}
      {m.policy.error && <Alert color="red">{(m.policy.error as Error).message}</Alert>}
    </div>
  );
}

export function AgentFlowSection(_p: SectionProps) {
  const q = useFlowState();
  return (
    <div className="su-section" data-testid="agent-flow">
      <StepIntro title="Agent flow">
        With the flow on, coding agents record your requests without asking for approval, update specs and components, and work through work orders; only their questions need you.
        Each agent client has its own setting, changed only from the agent with <code>/mandate-flow on|off</code>; with the flow off, Mandate refuses that agent&apos;s write requests. The
        project policy can require it or turn it off for everyone. Changes to standards always need your confirmation.
      </StepIntro>
      {q.isLoading && <Loader size="sm" />}
      {q.error && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && !q.data.projects.length && (
        <Text size="sm" c="dimmed">
          No projects yet.
        </Text>
      )}
      {q.data?.projects.map((p) => (
        <div key={p.id} className="flow-project" data-testid={`flow-${p.id}`}>
          <Group gap={8} mb={6}>
            <Text fw={600}>{p.name}</Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {p.id}
            </Text>
          </Group>
          <PolicyControls p={p} admin={q.data.admin} />
          <MyAgents p={p} />
          <AllClients p={p} />
        </div>
      ))}
    </div>
  );
}
