import { Alert, Group, Loader } from '@mantine/core';
import { IconAlertTriangle, IconShieldCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { redirectToLogin, useAuth } from '../auth';
import { AdvancedSetup, AgentTabs, InstallBox, originOf, ShellToggle, SignInStep, StartClaudeStep, type AgentChoice, type SignInContext } from './AgentSetup';
import { agentDef } from './agentCatalog';
import { repoLabel } from './github';
import { useProjects } from './projects';
import { devApiPort, mcpUrlFor, shellFor, type InstallShell } from './snippets';

/** `GET /ui/p/<id>/connect` (signed-in UI session only). */
export interface ConnectInfo {
  project: { id: string; name: string };
  mcpPath: string;
  key: { id: string; name: string; value: string; masked?: string; createdAt: string } | null;
  keysFile: string | null;
  cli: { create: string; list: string; revoke: string };
  /** A team (`oauth`): agents sign in with GitHub or use personal tokens; `key` is null. */
  auth?: 'oauth' | 'key';
  /** Absolute public MCP URL (team). */
  mcpUrl?: string;
  access?: 'read' | 'write';
}

export async function fetchConnect(projectId: string): Promise<ConnectInfo> {
  const res = await fetch(`/ui/p/${encodeURIComponent(projectId)}/connect`, { credentials: 'same-origin', headers: { 'X-Mandate-UI': '1' } });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('not signed in');
  }
  if (!res.ok) throw new Error(`could not load the connection details (HTTP ${res.status})`);
  return (await res.json()) as ConnectInfo;
}

/** The project's MCP URL as agents reach it: a team's public URL, the API port in development. */
export function useMcpUrl(mcpPath: string | undefined): string {
  const auth = useAuth();
  if (!mcpPath) return '';
  if (auth?.publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(auth.publicUrl)) return `${auth.publicUrl.replace(/\/+$/, '')}${mcpPath}`;
  return mcpUrlFor(window.location, mcpPath, devApiPort());
}

/** The Connect payload of a project (shared by the dialog's header and body: one request). */
export const useConnectInfo = (projectId: string) => useQuery({ queryKey: ['connect', projectId], queryFn: () => fetchConnect(projectId), staleTime: 0, gcTime: 0 });

/** Everything the per-agent blocks need: the MCP URL agents reach, the server origin and the sign-in context. */
export function useConnectSetup(projectId: string) {
  const info = useConnectInfo(projectId);
  const d = info.data;
  const computed = useMcpUrl(d?.mcpPath);
  const url = d?.mcpUrl ?? computed;
  const project = useProjects().data?.items.find((p) => p.id === projectId);
  const ctx: SignInContext = { projectId, repo: project?.github ? repoLabel(project.github) : undefined, access: d?.access ?? project?.access, oauthServer: d?.auth === 'oauth' };
  return { info, url, base: originOf(url), ctx };
}

const defaultShell = (): InstallShell => shellFor(typeof navigator === 'undefined' ? '' : navigator.userAgent);

/** "1 Install" / "2 Sign in" numbered steps. */
function Step({ n, title, right, children }: { n: number; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cg2-step">
      <span className="cg2-num">{n}</span>
      <div style={{ minWidth: 0 }}>
        <div className="cg2-step-h">
          <span className="cg2-step-t">{title}</span>
          {right}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * How to connect a coding agent to one project: per-agent tabs, each with the one-line installer for that agent and its
 * sign-in step; everything else (manual MCP entry, skills and commands, personal tokens or the project key, checksum,
 * uninstall) under "Advanced: set it up manually". Shared by the Connect-agent dialog and the step after creating a
 * project.
 */
export function ConnectAgentGuide({ projectId, compact, initialAgent = 'claude-code' }: { projectId: string; compact?: boolean; initialAgent?: AgentChoice }) {
  const [choice, setChoice] = useState<AgentChoice>(initialAgent);
  const [shell, setShell] = useState<InstallShell>(defaultShell);
  const { info, url, base, ctx } = useConnectSetup(projectId);
  const d = info.data;
  if (info.isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  if (info.isError || !d)
    return (
      <Alert color="red" icon={<IconAlertTriangle size={16} />}>
        {(info.error as Error)?.message ?? 'Cannot load the connection details'}
      </Alert>
    );
  const label = choice === 'other' ? 'every coding agent it finds' : agentDef(choice).label;
  const stepTwo = !ctx.oauthServer ? 'Check it' : choice !== 'other' && !agentDef(choice).oauth ? 'Personal token (once)' : 'Sign in (once)';
  return (
    <div className="cg cg2" data-testid="connect-guide">
      <AgentTabs value={choice} onChange={setChoice} />
      <div className="cg2-steps" data-testid={`agent-panel-${choice}`}>
        {base && (
          <Step n={1} title="Install" right={<ShellToggle value={shell} onChange={setShell} />}>
            <div className="cg2-desc">
              Run it in a terminal, inside your code repository. It installs the Mandate CLI and adds this project&apos;s MCP server, the Mandate skill and slash commands to {label}.
            </div>
            <InstallBox base={base} projectId={projectId} choice={choice} shell={shell} oauthServer={ctx.oauthServer} />
            <div className="cg2-note">
              <IconShieldCheck size={13} /> No token in the command. Needs Node.js 22. Checksum and uninstall are under Advanced.
            </div>
          </Step>
        )}
        <Step n={base ? 2 : 1} title={stepTwo}>
          <SignInStep choice={choice} ctx={ctx} />
        </Step>
        {choice === 'claude-code' && ctx.oauthServer && (
          <Step n={base ? 3 : 2} title="Start Claude Code with mandate claude">
            <StartClaudeStep />
          </Step>
        )}
      </div>
      <AdvancedSetup key={choice} choice={choice} projectId={projectId} url={url} info={d} shell={shell} compact={compact} />
    </div>
  );
}
