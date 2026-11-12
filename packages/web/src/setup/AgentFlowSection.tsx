/**
 * Settings → Agent flow: per project, the policy (admins) and my agents' preferences (switches; locked when the
 * policy enforces them). Server-mode admins also see every client, read-only.
 */
import { Alert, Avatar, Group, Loader, SegmentedControl, Switch, Table, Text, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { relativeTime } from '../lib/time';
import { StepIntro } from './widgets';
import type { SectionProps } from './sections';
import { AgentIcon, APPROVAL_TEXT, POLICY_TEXT, useFlowMutations, useFlowState, type FlowClient, type FlowProject, type FlowState, type Policy, type QuestionsVia } from './flowApi';

function Locked({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip label="Enforced by the project policy" withinPortal>
      <span className="flow-locked">{children}</span>
    </Tooltip>
  );
}

function ClientName({ c, mode }: { c: FlowClient; mode: FlowState['mode'] }) {
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
          {mode === 'local' && c.keyName ? `key ${c.keyName} · ` : ''}last seen {relativeTime(c.lastSeenAt)}
        </Text>
      </div>
    </Group>
  );
}

function MyAgents({ p, mode }: { p: FlowProject; mode: FlowState['mode'] }) {
  const m = useFlowMutations();
  if (!p.mine.length)
    return (
      <Text size="sm" c="dimmed" data-testid={`flow-mine-empty-${p.id}`}>
        No agents have used this project yet. Run <code>mandate connect</code> in a code repository, then use your agent there.
      </Text>
    );
  const sw = (c: FlowClient, k: 'flow' | 'approval') => {
    const control = (
      <Switch
        size="sm"
        aria-label={`${k === 'flow' ? 'Flow' : 'Approval'} for ${c.label}`}
        checked={c.effective[k] === 'on'}
        disabled={c.locked[k] || !c.editable || m.client.isPending || (k === 'approval' && c.effective.flow === 'off')}
        onChange={(e) => m.client.mutate({ project: p.id, id: c.id, patch: { [k]: e.currentTarget.checked ? 'on' : 'off' } })}
        data-testid={`flow-${k}-${c.id}`}
      />
    );
    if (k === 'approval' && !c.locked.approval && c.effective.flow === 'off')
      return (
        <Tooltip label="No effect while this agent's flow is off" withinPortal>
          <span>{control}</span>
        </Tooltip>
      );
    return c.locked[k] ? (
      <Group gap={6} wrap="nowrap">
        {control}
        <Locked>
          <IconLock size={12} /> enforced by policy
        </Locked>
      </Group>
    ) : (
      control
    );
  };
  // Older servers do not report the questions preference: no column then.
  const hasQuestions = p.mine.some((c) => c.effective.questions !== undefined);
  const questions = (c: FlowClient) => (
    <SegmentedControl
      size="xs"
      aria-label={`Questions for ${c.label}`}
      value={c.effective.questions ?? 'mandate'}
      disabled={!c.editable || m.client.isPending}
      onChange={(v) => m.client.mutate({ project: p.id, id: c.id, patch: { questions: v as QuestionsVia } })}
      data={[
        { value: 'mandate', label: 'Via Mandate' },
        { value: 'chat', label: 'In chat' },
      ]}
      data-testid={`flow-questions-${c.id}`}
    />
  );
  return (
    <Table verticalSpacing={8} withRowBorders={false} className="flow-table" data-testid={`flow-mine-${p.id}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>My agents</Table.Th>
          <Table.Th w={190}>Flow</Table.Th>
          <Table.Th w={190}>Approval</Table.Th>
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
              <ClientName c={c} mode={mode} />
            </Table.Td>
            <Table.Td>{sw(c, 'flow')}</Table.Td>
            <Table.Td>{sw(c, 'approval')}</Table.Td>
            {hasQuestions && <Table.Td>{questions(c)}</Table.Td>}
          </Table.Tr>
        ))}
      </Table.Tbody>
      {m.client.error && (
        <Table.Caption>
          <Text size="xs" c="red">
            {(m.client.error as Error).message}
          </Text>
        </Table.Caption>
      )}
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
                flow {c.effective.flow} · approval {c.effective.approval}
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
      <div className="flow-policy-row">
        <Text size="sm" fw={500}>
          Approval policy
        </Text>
        <SegmentedControl
          size="xs"
          value={p.policy.approvalPolicy}
          disabled={!admin || m.policy.isPending || p.policy.flowPolicy === 'off'}
          onChange={(v) => set({ approvalPolicy: v as Policy['approvalPolicy'] })}
          data={(['required', 'optional'] as const).map((v) => ({ value: v, label: APPROVAL_TEXT[v].label }))}
        />
        <Text size="xs" c="dimmed">
          {APPROVAL_TEXT[p.policy.approvalPolicy].body}
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
        With the flow on, coding agents record requests as feedback, update specs and components, and work through work orders; with approval on they show you the plan and wait for your go.
        Each agent client has its own setting (also <code>/mandate-flow on|off</code> in the agent); the project policy can require it or turn it off for everyone. Changes to standards always need
        your confirmation.
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
          <MyAgents p={p} mode={q.data.mode} />
          <AllClients p={p} />
        </div>
      ))}
    </div>
  );
}
