/**
 * Agent flow: project policy (admins change it) + per-client preferences (read-only here: only the agent changes them,
 * with /mandate-flow), shared by Settings → Agent flow and the badge.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandGithubCopilot, IconBrandGoogle, IconBrandOpenai, IconBrandVscode, IconRobot, IconSparkles, IconTerminal2 } from '@tabler/icons-react';
import { uiRequest } from '../lib/ui';

export type OnOff = 'on' | 'off';
export type QuestionsVia = 'mandate' | 'chat';
export interface Policy {
  flowPolicy: 'required' | 'optional' | 'off';
  approvalPolicy: 'required' | 'optional';
}
export interface FlowClient {
  id: string;
  label: string;
  client: string;
  user?: string;
  keyName?: string;
  version?: string;
  flow: OnOff | null;
  approval: OnOff | null;
  /** Where the agent asks the user (absent on older servers): through Mandate (default) or in chat. */
  questions?: QuestionsVia | null;
  updatedAt: string | null;
  updatedVia: 'command' | 'ui' | null;
  lastSeenAt: string;
  effective: { flow: OnOff; approval: OnOff; questions?: QuestionsVia };
  locked: { flow: boolean; approval: boolean };
}
export interface FlowProject {
  id: string;
  name: string;
  policy: Policy;
  mine: FlowClient[];
  all?: FlowClient[];
}
export interface FlowState {
  admin: boolean;
  user: string | null;
  projects: FlowProject[];
}

export const flowKey = (project?: string) => ['ui-flow', project ?? '*'];
export const useFlowState = (project?: string, enabled = true) =>
  useQuery({ queryKey: flowKey(project), queryFn: () => uiRequest<FlowState>('GET', `/ui/flow${project ? `?project=${encodeURIComponent(project)}` : ''}`, undefined, { noLoginRedirect: true }), enabled, staleTime: 10_000, refetchInterval: 60_000 });

export function useFlowMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['ui-flow'] });
  return {
    policy: useMutation({ mutationFn: ({ project, patch }: { project: string; patch: Partial<Policy> }) => uiRequest('PUT', `/ui/flow/${encodeURIComponent(project)}/policy`, patch), onSuccess: done }),
  };
}

/** Icon of a coding-agent client. */
export function AgentIcon({ client, size = 14 }: { client: string; size?: number }) {
  const C = client === 'claude-code' ? IconSparkles : client === 'codex' ? IconBrandOpenai : client === 'vscode' ? IconBrandVscode : client === 'gemini' ? IconBrandGoogle : client === 'cursor' ? IconBrandGithubCopilot : ['opencode', 'amp', 'goose', 'junie', 'cline'].includes(client) ? IconTerminal2 : IconRobot;
  return <C size={size} stroke={1.6} className="agent-icon" data-client={client} />;
}

export const POLICY_TEXT: Record<Policy['flowPolicy'], { label: string; body: string }> = {
  required: { label: 'Required', body: 'Every coding agent follows the Mandate flow: requests become feedback, specs and work orders. Agents cannot turn it off.' },
  optional: { label: 'Optional', body: 'Each agent client chooses (default on). People switch their own agents from the agent with /mandate-flow on|off.' },
  off: { label: 'Off', body: 'Agents use Mandate as read-only context: no feedback, spec edits or work orders.' },
};
export const APPROVAL_TEXT: Record<Policy['approvalPolicy'], { label: string; body: string }> = {
  required: { label: 'Required', body: 'Agents always show the plan (spec diff, components, work order) and wait for a go.' },
  optional: { label: 'Optional', body: 'Each agent client chooses whether to stop for approval (default off).' },
};

/** "Flow on · 2 agents" / "Flow: required" / "Flow 1/2 on" for my clients of a project. */
export function flowSummary(p: FlowProject): { label: string; tone: 'on' | 'off' | 'mixed' } {
  if (p.policy.flowPolicy === 'required') return { label: 'Flow: required', tone: 'on' };
  if (p.policy.flowPolicy === 'off') return { label: 'Flow: off', tone: 'off' };
  const n = p.mine.length;
  const on = p.mine.filter((c) => c.effective.flow === 'on').length;
  const agents = `${n} agent${n === 1 ? '' : 's'}`;
  if (!n) return { label: 'Flow on', tone: 'on' };
  if (on === n) return { label: `Flow on · ${agents}`, tone: 'on' };
  if (on === 0) return { label: `Flow off · ${agents}`, tone: 'off' };
  return { label: `Flow ${on}/${n} on`, tone: 'mixed' };
}
